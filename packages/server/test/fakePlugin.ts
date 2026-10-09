import { decodeFrame, encodeFrame, type WireError } from '@figma-mcp/protocol';
import WebSocket from 'ws';

export interface FakeReply {
  result?: unknown;
  error?: WireError;
  binaries?: Uint8Array[];
  silent?: boolean; // 응답하지 않음
}

export interface FakePlugin {
  ws: WebSocket;
  received: { method: string; params: unknown; binaries: Uint8Array[]; client?: string }[];
  closed: Promise<number>; // close code
  welcomed: Promise<void>;
}

export function fakePlugin(
  port: number,
  opts: {
    token: string;
    sessionId?: string;
    fileName?: string;
    sendHello?: boolean;
    onRequest?: (method: string, params: unknown, binaries: Uint8Array[]) => FakeReply;
  },
): FakePlugin {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const received: FakePlugin['received'] = [];
  const inbound = new Map<string, Uint8Array[]>();
  let welcome!: () => void;
  const welcomed = new Promise<void>((r) => (welcome = r));
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));

  ws.on('open', () => {
    if (opts.sendHello === false) return;
    ws.send(
      JSON.stringify({
        type: 'hello',
        token: opts.token,
        sessionId: opts.sessionId ?? 's1',
        fileName: opts.fileName ?? 'File',
      }),
    );
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const { header, payload } = decodeFrame(new Uint8Array(data as Buffer));
      const parts = inbound.get(header.id) ?? [];
      parts[header.part] = new Uint8Array(payload);
      inbound.set(header.id, parts);
      return;
    }
    const msg = JSON.parse(data.toString());
    if (msg.type === 'welcome') return welcome();
    const binaries = inbound.get(msg.id) ?? [];
    received.push({ method: msg.method, params: msg.params, binaries, client: msg.client });
    const reply = opts.onRequest?.(msg.method, msg.params, binaries) ?? { result: null };
    if (reply.silent) return;
    (reply.binaries ?? []).forEach((b, part) => ws.send(encodeFrame({ id: msg.id, part }, b)));
    ws.send(
      JSON.stringify(
        reply.error
          ? { type: 'response', id: msg.id, ok: false, error: reply.error }
          : { type: 'response', id: msg.id, ok: true, result: reply.result },
      ),
    );
  });

  return { ws, received, closed, welcomed };
}
