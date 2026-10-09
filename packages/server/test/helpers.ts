import { PDFDocument } from 'pdf-lib';
import type { CallOptions, SessionInfo } from '../src/bridge';
import { ToolError } from '../src/errors';
import { buildTools, type ToolDeps } from '../src/tools';

export interface Recorded { method: string; params: unknown; opts: CallOptions }

export function fakeBridge(replies: Record<string, (params: any, opts: CallOptions) => { result: unknown; binaries?: Uint8Array[] }>, sessions: SessionInfo[] = [{ sessionId: 's1', fileName: 'File', connectedAt: 1 }], startError?: ToolError) {
  const calls: Recorded[] = [];
  const bridge: ToolDeps['bridge'] = {
    sessions: () => sessions,
    ready: async () => {
      if (startError) throw startError;
    },
    call: (async (method: string, params: unknown, opts: CallOptions = {}) => {
      calls.push({ method, params, opts });
      const reply = replies[method];
      if (!reply) throw new ToolError('INVALID_ARGS', `no fake for ${method}`);
      const r = reply(params, opts);
      const session = sessions.find((s) => s.sessionId === opts.sessionId) ?? sessions[sessions.length - 1]!;
      return { result: r.result, binaries: r.binaries ?? [], session };
    }) as ToolDeps['bridge']['call'],
  };
  return { bridge, calls };
}

export function toolsWith(bridge: ToolDeps['bridge'], extra: Partial<ToolDeps> = {}) {
  const tools = buildTools({ bridge, home: '/home/me', now: () => new Date(2026, 9, 10, 9, 0, 0), loadImage: async () => new Uint8Array(), ...extra });
  return (name: string, args: unknown) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t.handler(t.inputSchema.parse(args));
  };
}

export async function samplePdf(sizes: [number, number][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const s of sizes) doc.addPage(s);
  return doc.save();
}
