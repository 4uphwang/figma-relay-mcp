import type { ErrorCode, WireError } from '@figma-relay-mcp/protocol/types';

export class PluginError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'PluginError';
  }
}

export function toWireError(e: unknown): WireError {
  if (e instanceof PluginError) {
    return e.hint === undefined ? { code: e.code, message: e.message } : { code: e.code, message: e.message, hint: e.hint };
  }
  if (e instanceof Error) return { code: 'EXEC_ERROR', message: (e.stack ?? `${e.name}: ${e.message}`).trim() };
  return { code: 'EXEC_ERROR', message: String(e) };
}
