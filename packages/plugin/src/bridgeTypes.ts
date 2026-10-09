import type { MethodMap, MethodName, WireError } from '@figma-mcp/protocol/types';

export type MainToUi =
  | { type: 'init'; token: string; fileName: string }
  | { type: 'binary'; id: string; part: number; bytes: Uint8Array }
  | { type: 'response'; id: string; ok: true; result: unknown }
  | { type: 'response'; id: string; ok: false; error: WireError };

export type UiToMain =
  | { type: 'saveToken'; token: string }
  | { type: 'request'; id: string; method: string; params: unknown; binaries: Uint8Array[] };

export interface HandlerContext {
  binaries: Uint8Array[];
  sendBinary(part: number, bytes: Uint8Array): void;
}

export type Handler<M extends MethodName> = (
  params: MethodMap[M]['params'],
  ctx: HandlerContext,
) => Promise<MethodMap[M]['result']>;

export type Handlers = { [M in MethodName]: Handler<M> };
