import type { Handler } from '../bridgeTypes';
import { PluginError } from '../lib/errors';
import { toJsonSafe } from '../lib/serialize';

type UserFn = (f: PluginAPI) => Promise<unknown>;

function compile(code: string): UserFn {
  try {
    return new Function('figma', `return (async () => {\n${code}\n})();`) as UserFn;
  } catch (e) {
    throw new PluginError('EXEC_ERROR', `코드 문법 오류: ${(e as Error).message}`);
  }
}

export const execute: Handler<'execute'> = async ({ code }) => {
  const fn = compile(code);
  figma.commitUndo();
  try {
    return toJsonSafe(await fn(figma));
  } catch (e) {
    const err = e as Error;
    throw new PluginError('EXEC_ERROR', `${err?.message ?? String(e)}\n${err?.stack ?? ''}`.trim());
  } finally {
    figma.commitUndo();
  }
};
