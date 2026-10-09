import type { MainToUi, UiToMain } from './bridgeTypes';
import { handlers } from './handlers';
import { PluginError, toWireError } from './lib/errors';

const TOKEN_KEY = 'figma-mcp-token';
const post = (m: MainToUi) => figma.ui.postMessage(m);

figma.showUI(__html__, { width: 300, height: 150, themeColors: true });

void (async () => {
  const token = ((await figma.clientStorage.getAsync(TOKEN_KEY)) as string | undefined) ?? '';
  post({ type: 'init', token, fileName: figma.root.name });
})();

figma.ui.onmessage = async (msg: UiToMain) => {
  if (msg.type === 'saveToken') {
    await figma.clientStorage.setAsync(TOKEN_KEY, msg.token);
    return;
  }
  if (msg.type !== 'request') return;
  try {
    const handler = handlers[msg.method as keyof typeof handlers] as
      | ((params: unknown, ctx: { binaries: Uint8Array[]; sendBinary(part: number, bytes: Uint8Array): void }) => Promise<unknown>)
      | undefined;
    if (!handler) throw new PluginError('INVALID_ARGS', `알 수 없는 요청: ${msg.method}`);
    const result = await handler(msg.params, {
      binaries: msg.binaries,
      sendBinary: (part, bytes) => post({ type: 'binary', id: msg.id, part, bytes }),
    });
    post({ type: 'response', id: msg.id, ok: true, result });
  } catch (e) {
    post({ type: 'response', id: msg.id, ok: false, error: toWireError(e) });
  }
};
