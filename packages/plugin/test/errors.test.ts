import { describe, expect, it } from 'vitest';
import { PluginError, toWireError } from '../src/lib/errors';

describe('toWireError', () => {
  it('keeps PluginError fields', () => {
    expect(toWireError(new PluginError('NODE_NOT_FOUND', '없음', '힌트'))).toEqual({
      code: 'NODE_NOT_FOUND', message: '없음', hint: '힌트',
    });
  });
  it('wraps other errors as EXEC_ERROR with the stack', () => {
    const w = toWireError(new TypeError('boom'));
    expect(w.code).toBe('EXEC_ERROR');
    expect(w.message).toContain('boom');
    expect(w.message).toContain('TypeError');
  });
  it('wraps non-errors', () => {
    expect(toWireError('nope')).toEqual({ code: 'EXEC_ERROR', message: 'nope' });
  });
});
