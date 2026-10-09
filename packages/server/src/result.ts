import type { CallToolResult } from '@modelcontextprotocol/server';
import { ToolError } from './errors';
import type { ToolOutput } from './tools';

export function toCallToolResult(out: ToolOutput): CallToolResult {
  if (out.kind === 'image') {
    return {
      content: [
        { type: 'image', data: Buffer.from(out.png).toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: JSON.stringify(out.meta) },
      ],
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(out.value, null, 2) }] };
}

export function errorResult(e: unknown): CallToolResult {
  const body =
    e instanceof ToolError
      ? { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) }
      : { code: 'IO_ERROR', message: e instanceof Error ? e.message : String(e) };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
}
