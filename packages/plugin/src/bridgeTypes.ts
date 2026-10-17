import type { MethodMap, MethodName, WireError } from '@figma-mcp/protocol/types';
import type { HistoryEntry } from './lib/history';

export type MainToUi =
  | { type: 'init'; token: string; fileName: string; fileId: string; history: unknown; collapsed: boolean }
  | { type: 'pages'; pages: { id: string; name: string }[]; current: string }
  | { type: 'binary'; id: string; part: number; bytes: Uint8Array }
  | { type: 'response'; id: string; ok: true; result: unknown }
  | { type: 'response'; id: string; ok: false; error: WireError };

export type UiToMain =
  | { type: 'saveToken'; token: string }
  | { type: 'resize'; width: number; height: number }
  | { type: 'setCollapsed'; collapsed: boolean }
  | { type: 'listPages' }
  | { type: 'goToPage'; id: string }
  | { type: 'saveHistory'; entries: HistoryEntry[] }
  | { type: 'focusNodes'; ids: string[] }
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
