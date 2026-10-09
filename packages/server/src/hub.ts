import {
  ClientHelloSchema,
  ClientToHubSchema,
  decodeFrame,
  encodeFrame,
  type HubToClient,
  type MethodName,
} from '@figma-mcp/protocol';
import type { RawData, WebSocket } from 'ws';
import { Bridge } from './bridge';
import { ToolError } from './errors';

// 허브: 포트를 잡고 Figma 플러그인들과 붙는 백그라운드 프로세스.
// Claude 세션마다 뜨는 stdio 서버는 HubClient로 같은 포트에 붙어 요청을 넘긴다.
// 아무 클라이언트도 없이 idleMs가 지나면 스스로 끝난다(onExit).

export const CLOSE_BAD_TOKEN = 4001;

export interface HubOptions {
  token: string;
  build: number;
  idleMs: number;
  helloTimeoutMs?: number;
  onExit: (reason: 'idle' | 'restart') => void;
  log?: (line: string) => void;
}

export class Hub {
  readonly bridge: Bridge;
  private clients = new Set<WebSocket>();
  private idleTimer?: NodeJS.Timeout;

  constructor(private readonly opts: HubOptions) {
    this.bridge = new Bridge({
      token: opts.token,
      helloTimeoutMs: opts.helloTimeoutMs,
      onPeer: (ws, first) => this.acceptClient(ws, first),
      onSessionsChange: (sessions) => this.broadcast({ type: 'sessions', sessions }),
    });
  }

  async start(port: number, host = '127.0.0.1'): Promise<number> {
    const bound = await this.bridge.start(port, host);
    this.armIdle();
    return bound;
  }

  stop(): Promise<void> {
    clearTimeout(this.idleTimer);
    for (const c of this.clients) c.terminate();
    return this.bridge.stop();
  }

  clientCount(): number {
    return this.clients.size;
  }

  private armIdle() {
    clearTimeout(this.idleTimer);
    if (this.clients.size > 0) return;
    this.idleTimer = setTimeout(() => this.exit('idle'), this.opts.idleMs);
    this.idleTimer.unref?.();
  }

  private exit(reason: 'idle' | 'restart') {
    this.opts.log?.(`허브 종료: ${reason}`);
    void this.stop().finally(() => this.opts.onExit(reason));
  }

  private broadcast(msg: HubToClient) {
    const text = JSON.stringify(msg);
    for (const c of this.clients) c.send(text);
  }

  private acceptClient(ws: WebSocket, first: unknown) {
    const hello = ClientHelloSchema.safeParse(first);
    if (!hello.success) {
      ws.close(4000, 'unknown peer');
      return;
    }
    if (hello.data.token !== this.opts.token) {
      ws.close(CLOSE_BAD_TOKEN, 'bad token');
      return;
    }
    const { label } = hello.data;
    this.clients.add(ws);
    this.armIdle();
    this.opts.log?.(`클라이언트 연결: ${label} (빌드 ${hello.data.build}, 모두 ${this.clients.size})`);
    ws.send(JSON.stringify({ type: 'hubWelcome', build: this.opts.build, sessions: this.bridge.sessions() } satisfies HubToClient));

    const inbound = new Map<string, Uint8Array[]>();
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        try {
          const { header, payload } = decodeFrame(toBytes(data));
          const parts = inbound.get(header.id) ?? [];
          parts[header.part] = new Uint8Array(payload); // 다음 메시지가 버퍼를 재사용해도 안전하게 복사
          inbound.set(header.id, parts);
        } catch {
          // 잘못된 프레임은 버린다
        }
        return;
      }
      let parsed;
      try {
        parsed = ClientToHubSchema.safeParse(JSON.parse(data.toString()));
      } catch {
        return;
      }
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.type === 'restart') {
        this.exit('restart');
        return;
      }
      const binaries = inbound.get(msg.id) ?? [];
      inbound.delete(msg.id);
      void this.relay(ws, label, msg, binaries);
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      this.opts.log?.(`클라이언트 끊김: ${label} (남은 ${this.clients.size})`);
      this.armIdle();
    });
  }

  private async relay(
    ws: WebSocket,
    client: string,
    msg: { id: string; method: string; params: unknown; sessionId?: string; timeoutMs?: number },
    binaries: Uint8Array[],
  ) {
    let reply: HubToClient;
    let out: Uint8Array[] = [];
    try {
      const r = await this.bridge.call(msg.method as MethodName, msg.params as never, {
        sessionId: msg.sessionId,
        timeoutMs: msg.timeoutMs,
        binaries,
        client,
      });
      out = r.binaries;
      reply = { type: 'callResult', id: msg.id, ok: true, result: r.result, session: r.session, parts: out.length };
    } catch (e) {
      const err =
        e instanceof ToolError
          ? { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) }
          : { code: 'IO_ERROR' as const, message: e instanceof Error ? e.message : String(e) };
      reply = { type: 'callResult', id: msg.id, ok: false, error: err };
    }
    if (ws.readyState !== ws.OPEN) return;
    out.forEach((b, part) => {
      if (b) ws.send(encodeFrame({ id: msg.id, part }, b));
    });
    ws.send(JSON.stringify(reply));
  }
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
