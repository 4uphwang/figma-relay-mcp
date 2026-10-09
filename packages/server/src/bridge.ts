import { randomUUID } from 'node:crypto';
import {
  PluginToServerSchema,
  decodeFrame,
  encodeFrame,
  type MethodMap,
  type MethodName,
} from '@figma-mcp/protocol';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { NOT_CONNECTED_HINT, ToolError } from './errors';

export interface SessionInfo {
  sessionId: string;
  fileName: string;
  connectedAt: number;
}

export interface CallOptions {
  sessionId?: string;
  timeoutMs?: number;
  binaries?: Uint8Array[];
  client?: string; // 플러그인 활동 기록에 보이는 요청자
}

export interface CallResult<T> {
  result: T;
  binaries: Uint8Array[];
  session: SessionInfo;
}

interface Session extends SessionInfo {
  ws: WebSocket;
}

interface Pending {
  ws: WebSocket;
  parts: Uint8Array[];
  timer: NodeJS.Timeout;
  resolve: (r: { result: unknown; binaries: Uint8Array[] }) => void;
  reject: (e: Error) => void;
}

const portInUseError = (port: number | string) =>
  new ToolError(
    'PORT_IN_USE',
    `포트 ${port}를 다른 프로세스가 쓰고 있어 Figma와 연결할 수 없습니다`,
    '다른 Claude 세션의 figma-mcp를 닫고 이 세션을 다시 시작하세요',
  );

export class Bridge {
  portInUse = false;
  startError?: ToolError;
  private wss?: WebSocketServer;
  private port: number | string = '?';
  private live = new Map<string, Session>();
  private pending = new Map<string, Pending>();

  constructor(
    private readonly opts: {
      token: string;
      helloTimeoutMs?: number;
      // 플러그인이 아닌 연결(허브 클라이언트)의 첫 메시지. 넘긴 뒤 이 연결은 Bridge가 다루지 않는다.
      onPeer?: (ws: WebSocket, first: unknown) => void;
      onSessionsChange?: (sessions: SessionInfo[]) => void;
    },
  ) {}

  start(port: number, host = '127.0.0.1'): Promise<number> {
    this.port = port;
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port, host, maxPayload: 256 * 1024 * 1024 });
      wss.once('listening', () => {
        this.wss = wss;
        const addr = wss.address();
        this.port = typeof addr === 'object' && addr ? addr.port : port;
        resolve(this.port as number);
      });
      wss.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE') {
          this.portInUse = true;
          this.startError = portInUseError(port);
        } else {
          this.startError = new ToolError('IO_ERROR', `Figma 연결 서버를 시작하지 못했습니다: ${e.message}`);
        }
        reject(this.startError);
      });
      wss.on('connection', (ws) => this.accept(ws));
    });
  }

  async stop(): Promise<void> {
    for (const s of this.live.values()) s.ws.terminate();
    const wss = this.wss;
    if (wss) await new Promise<void>((r) => wss.close(() => r()));
  }

  sessions(): SessionInfo[] {
    return [...this.live.values()]
      .sort((a, b) => a.connectedAt - b.connectedAt)
      .map(({ sessionId, fileName, connectedAt }) => ({ sessionId, fileName, connectedAt }));
  }

  ensureStarted(): void {
    if (this.startError) throw this.startError;
  }

  async ready(): Promise<void> {
    this.ensureStarted();
  }

  async call<M extends MethodName>(
    method: M,
    params: MethodMap[M]['params'],
    opts: CallOptions = {},
  ): Promise<CallResult<MethodMap[M]['result']>> {
    this.ensureStarted();
    const session = this.pick(opts.sessionId);
    const id = randomUUID();
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const done = new Promise<{ result: unknown; binaries: Uint8Array[] }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ToolError(
            'TIMEOUT',
            `${method} 응답이 ${Math.round(timeoutMs / 1000)}초 안에 오지 않았습니다`,
            'Figma가 바쁘거나 멈췄을 수 있습니다. 작업 크기를 줄여 다시 시도하세요',
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { ws: session.ws, parts: [], timer, resolve, reject });
    });
    done.catch(() => {}); // rejection is observed via `await done` below, or discarded if a send fails
    try {
      (opts.binaries ?? []).forEach((b, part) => session.ws.send(encodeFrame({ id, part }, b)));
      session.ws.send(JSON.stringify({ type: 'request', id, method, params, ...(opts.client ? { client: opts.client } : {}) }));
    } catch {
      const p = this.pending.get(id);
      if (p) clearTimeout(p.timer);
      this.pending.delete(id);
      throw new ToolError('NOT_CONNECTED', 'Figma 플러그인 연결이 끊겼습니다', NOT_CONNECTED_HINT);
    }
    const { result, binaries } = await done;
    return {
      result: result as MethodMap[M]['result'],
      binaries,
      session: { sessionId: session.sessionId, fileName: session.fileName, connectedAt: session.connectedAt },
    };
  }

  private pick(sessionId?: string): Session {
    if (sessionId) {
      const s = this.live.get(sessionId);
      if (!s) throw new ToolError('NOT_CONNECTED', `연결된 세션이 아닙니다: ${sessionId}`, 'list_files로 세션을 확인하세요');
      return s;
    }
    const all = [...this.live.values()];
    const only = all[0];
    if (!only) throw new ToolError('NOT_CONNECTED', '연결된 Figma 플러그인이 없습니다', NOT_CONNECTED_HINT);
    // 여러 세션이 허브를 같이 쓰므로 "가장 최근 파일"로 짐작하지 않는다
    if (all.length > 1) {
      throw new ToolError(
        'INVALID_ARGS',
        `Figma 파일 ${all.length}개가 연결돼 있어 대상을 정할 수 없습니다`,
        'list_files로 세션 ID를 확인하고 sessionId를 넘기세요',
      );
    }
    return only;
  }

  private changed() {
    this.opts.onSessionsChange?.(this.sessions());
  }

  private accept(ws: WebSocket) {
    let sessionId: string | undefined;
    let peer = false;
    const helloTimer = setTimeout(() => ws.close(4002, 'hello timeout'), this.opts.helloTimeoutMs ?? 5000);

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (peer) return;
      if (isBinary) {
        if (!sessionId) return;
        try {
          const { header, payload } = decodeFrame(toBytes(data));
          const p = this.pending.get(header.id);
          if (p && p.ws === ws) p.parts[header.part] = payload;
        } catch {
          // malformed frame: drop silently
        }
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!sessionId && this.opts.onPeer && (raw as { type?: unknown } | null)?.type !== 'hello') {
        peer = true;
        clearTimeout(helloTimer);
        this.opts.onPeer(ws, raw);
        return;
      }
      const parsed = PluginToServerSchema.safeParse(raw);
      if (!parsed.success) return;
      const msg = parsed.data;

      if (msg.type === 'hello') {
        clearTimeout(helloTimer);
        if (msg.token !== this.opts.token) {
          ws.close(4001, 'bad token');
          return;
        }
        sessionId = msg.sessionId;
        const previous = this.live.get(sessionId);
        this.live.set(sessionId, { sessionId, fileName: msg.fileName, connectedAt: Date.now(), ws });
        previous?.ws.close(4003, 'replaced');
        ws.send(JSON.stringify({ type: 'welcome' }));
        this.changed();
        return;
      }

      if (!sessionId) return;
      const p = this.pending.get(msg.id);
      if (!p || p.ws !== ws) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve({ result: msg.result, binaries: p.parts });
      else p.reject(new ToolError(msg.error.code, msg.error.message, msg.error.hint));
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (peer) return;
      if (sessionId && this.live.get(sessionId)?.ws === ws) {
        this.live.delete(sessionId);
        this.changed();
      }
      for (const [id, p] of this.pending) {
        if (p.ws !== ws) continue;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new ToolError('NOT_CONNECTED', 'Figma 플러그인 연결이 끊겼습니다', NOT_CONNECTED_HINT));
      }
    });
  }
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
