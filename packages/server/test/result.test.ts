import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/errors';
import { errorResult, toCallToolResult } from '../src/result';

describe('result', () => {
  it('formats JSON output as text', () => {
    const r = toCallToolResult({ kind: 'json', value: { a: 1 } });
    expect(r.content).toEqual([{ type: 'text', text: JSON.stringify({ a: 1 }, null, 2) }]);
    expect(r.isError).toBeUndefined();
  });
  it('formats image output as base64 PNG plus meta', () => {
    const r = toCallToolResult({ kind: 'image', png: new Uint8Array([1, 2, 3]), meta: { width: 1 } });
    expect(r.content[0]).toEqual({ type: 'image', data: 'AQID', mimeType: 'image/png' });
    expect(r.content[1]).toEqual({ type: 'text', text: '{"width":1}' });
  });
  it('formats ToolError and other errors', () => {
    const t = errorResult(new ToolError('TIMEOUT', '늦음', '줄이세요'));
    expect(t.isError).toBe(true);
    expect(JSON.parse((t.content[0] as { text: string }).text)).toEqual({ code: 'TIMEOUT', message: '늦음', hint: '줄이세요' });
    const o = errorResult(new Error('x'));
    expect(JSON.parse((o.content[0] as { text: string }).text)).toEqual({ code: 'IO_ERROR', message: 'x' });
  });
});
