import { describe, expect, it } from 'vitest';
import { PluginToServerSchema, ServerToPluginSchema } from '../src';

describe('messages', () => {
  it('parses hello', () => {
    const m = PluginToServerSchema.parse({ type: 'hello', token: 't', sessionId: 's', fileName: 'f' });
    expect(m.type).toBe('hello');
  });

  it('parses ok and error responses', () => {
    const ok = PluginToServerSchema.parse({ type: 'response', id: '1', ok: true, result: { a: 1 } });
    expect(ok).toMatchObject({ ok: true, result: { a: 1 } });
    const err = PluginToServerSchema.parse({
      type: 'response', id: '1', ok: false, error: { code: 'NODE_NOT_FOUND', message: 'x' },
    });
    expect(err).toMatchObject({ ok: false, error: { code: 'NODE_NOT_FOUND' } });
  });

  it('rejects unknown error codes', () => {
    expect(() =>
      PluginToServerSchema.parse({ type: 'response', id: '1', ok: false, error: { code: 'NOPE', message: 'x' } }),
    ).toThrow();
  });

  it('parses welcome and request', () => {
    expect(ServerToPluginSchema.parse({ type: 'welcome' }).type).toBe('welcome');
    const r = ServerToPluginSchema.parse({ type: 'request', id: '1', method: 'getStatus', params: {} });
    expect(r).toMatchObject({ method: 'getStatus' });
  });
});
