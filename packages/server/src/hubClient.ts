import { randomUUID } from 'node:crypto';
import {
  HubToClientSchema,
  decodeFrame,
  encodeFrame,
  type MethodMap,
  type MethodName,
} from '@figma-relay-mcp/protocol';
import WebSocket, { type RawData } from 'ws';
import type { CallOptions, CallResult, SessionInfo } from './bridge';
import { ToolError } from './errors';
import { CLOSE_BAD_TOKEN } from './hub';

// Claude 세션 하나의 stdio 서버가 허브에 붙는 쪽. 허브가 없으면 spawnHub로 띄운다.
// 연결은 첫 도구 호출 때 맺고, 끊기면 다음 호출 때 다시 맺는다(허브가 죽었으면 다시 띄운다).

export interface HubClientOptions {
  token: string;
  label: string;
  build: number;
  port: number;
  spawnHub: () => void;
  connectTimeoutMs?: number; // 허브를 띄우고 붙기까지 기다리는 시간
  welcomeTimeoutMs?: number;
}

interface Pending {
  parts: Uint8Array[];
  timer: NodeJS.Timeout;
  resolve: (r: { result: unknown; binaries: Uint8Array[]; session: SessionInfo }) => void;
  reject: (e: Error) => void;
}

type Attempt =
  | { kind: 'ok'; ws: WebSocket; build: number; sessions: SessionInfo[] }
  | { kind: 'refused' }
  | { kind: 'badToken' }
  | { kind: 'foreign' }; // 포트는 열려 있는데 허브가 아니다(옛 버전 figma-relay-mcp 등)

const HUB_HINT = 'Claude 세션을 다시 시작해 보고, 계속되면 ~/.figma-relay-mcp/hub.log를 확인하세요';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HubClient {
  private ws?: WebSocket;
  private connecting?: Promise<WebSocket>;
  private cached: SessionInfo[] = [];
  private pending = new Map<string, Pending>();

  constructor(private readonly opts: HubClientOptions) {}

  sessions(): SessionInfo[] {
    return [...this.cached].sort((a, b) => a.connectedAt - b.connectedAt);
  }

  async ready(): Promise<void> {
    await this.connection();
  }

  close(): void {
    this.ws?.close();
  }

  async call<M extends MethodName>(
    method: M,
    params: MethodMap[M]['params'],
    opts: CallOptions = {},
  ): Promise<CallResult<MethodMap[M]['result']>> {
    const ws = await this.connection();
    const id = randomUUID();
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const done = new Promise<{ result: unknown; binaries: Uint8Array[]; session: SessionInfo }>((resolve, reject) => {
      // 시간 제한은 허브가 지키고 결과를 보낸다. 이쪽은 허브가 답 없이 멈춘 경우만 대비한다.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ToolError('TIMEOUT', `${method} 응답이 허브에서 오지 않았습니다`, HUB_HINT));
      }, timeoutMs + 5_000);
      this.pending.set(id, { parts: [], timer, resolve, reject });
    });
    done.catch(() => {});
    try {
      (opts.binaries ?? []).forEach((b, part) => ws.send(encodeFrame({ id, part }, b)));
      ws.send(
        JSON.stringify({
          type: 'call',
          id,
          method,
          params,
          ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
          timeoutMs,
        }),
      );
    } catch {
      const p = this.pending.get(id);
      if (p) clearTimeout(p.timer);
      this.pending.delete(id);
      throw new ToolError('NOT_CONNECTED', '허브 연결이 끊겼습니다', '다시 시도하세요');
    }
    const r = await done;
    return { result: r.result as MethodMap[M]['result'], binaries: r.binaries, session: r.session };
  }

  private connection(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    this.connecting ??= this.establish().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async establish(): Promise<WebSocket> {
    const deadline = Date.now() + (this.opts.connectTimeoutMs ?? 8_000);
    let spawned = false;
    let restarted = false;
    for (let delay = 100; ; delay = Math.min(delay * 2, 1_000)) {
      const a = await this.attempt();
      if (a.kind === 'ok') {
        if (a.build < this.opts.build && !restarted) {
          // 허브가 옛 빌드다. 내리고 이 빌드로 다시 띄운다.
          restarted = true;
          a.ws.send(JSON.stringify({ type: 'restart' }));
          await new Promise<void>((r) => a.ws.once('close', () => r()));
          continue;
        }
        this.adopt(a.ws, a.sessions);
        return a.ws;
      }
      if (a.kind === 'badToken') {
        throw new ToolError('NOT_CONNECTED', '허브가 토큰을 거절했습니다', '~/.figma-relay-mcp/token을 바꿨다면 허브를 다시 시작하세요(모든 Claude 세션 재시작)');
      }
      if (a.kind === 'foreign') {
        throw new ToolError(
          'PORT_IN_USE',
          `포트 ${this.opts.port}를 허브가 아닌 프로세스가 쓰고 있습니다`,
          '옛 버전 figma-relay-mcp를 쓰는 Claude 세션을 닫거나 다시 시작하세요',
        );
      }
      if (!spawned) {
        spawned = true;
        this.opts.spawnHub();
      }
      if (Date.now() + delay > deadline) {
        throw new ToolError('NOT_CONNECTED', 'figma-relay-mcp 허브를 시작하지 못했습니다', HUB_HINT);
      }
      await sleep(delay);
    }
  }

  private attempt(): Promise<Attempt> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.opts.port}`, { maxPayload: 256 * 1024 * 1024 });
      let settled = false;
      const settle = (a: Attempt) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeAllListeners('message');
        if (a.kind !== 'ok') ws.terminate();
        resolve(a);
      };
      const timer = setTimeout(() => settle({ kind: 'foreign' }), this.opts.welcomeTimeoutMs ?? 2_000);
      ws.on('error', (e: NodeJS.ErrnoException) => settle(e.code === 'ECONNREFUSED' ? { kind: 'refused' } : { kind: 'foreign' }));
      ws.on('close', (code) => settle(code === CLOSE_BAD_TOKEN ? { kind: 'badToken' } : code === 1006 ? { kind: 'refused' } : { kind: 'foreign' }));
      ws.on('open', () =>
        ws.send(JSON.stringify({ type: 'client', token: this.opts.token, label: this.opts.label, build: this.opts.build })),
      );
      ws.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary) return;
        const parsed = HubToClientSchema.safeParse(safeJson(data.toString()));
        if (parsed.success && parsed.data.type === 'hubWelcome') {
          settle({ kind: 'ok', ws, build: parsed.data.build, sessions: parsed.data.sessions });
        }
      });
    });
  }

  private adopt(ws: WebSocket, sessions: SessionInfo[]) {
    ws.removeAllListeners('close');
    ws.removeAllListeners('error');
    this.ws = ws;
    this.cached = sessions;
    ws.on('error', () => {});
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        try {
          const { header, payload } = decodeFrame(toBytes(data));
          const p = this.pending.get(header.id);
          if (p) p.parts[header.part] = new Uint8Array(payload);
        } catch {
          // 잘못된 프레임은 버린다
        }
        return;
      }
      const parsed = HubToClientSchema.safeParse(safeJson(data.toString()));
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.type === 'sessions') {
        this.cached = msg.sessions;
        return;
      }
      if (msg.type !== 'callResult') return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) {
        p.parts.length = Math.max(p.parts.length, msg.parts);
        p.resolve({ result: msg.result, binaries: p.parts, session: msg.session });
      } else p.reject(new ToolError(msg.error.code, msg.error.message, msg.error.hint));
    });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = undefined;
      this.cached = [];
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new ToolError('NOT_CONNECTED', '허브 연결이 끊겼습니다', '다시 시도하면 허브에 다시 연결합니다'));
      }
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
