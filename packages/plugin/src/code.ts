import type { MainToUi, UiToMain } from './bridgeTypes';
import { handlers } from './handlers';
import { PluginError, toWireError } from './lib/errors';

const TOKEN_KEY = 'figma-mcp-token';
const FILE_ID_KEY = 'figma-mcp-file-id';
const HISTORY_KEY = 'figma-mcp-history:';
const post = (m: MainToUi) => figma.ui.postMessage(m);

const UI_WIDTH = 300;
figma.showUI(__html__, { width: UI_WIDTH, height: 180, themeColors: true });

// figma.fileKey는 비공개 플러그인에서만 읽을 수 있어서, 파일마다 id를 한 번 만들어 문서에 적어 둔다.
// 기록 자체는 문서가 아니라 이 컴퓨터의 clientStorage에 둔다(실행한 코드를 공동 작업자와 나누지 않도록).
function fileId(): string {
  const saved = figma.root.getPluginData(FILE_ID_KEY);
  if (saved) return saved;
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    figma.root.setPluginData(FILE_ID_KEY, id);
    return id;
  } catch {
    return `name:${figma.root.name}`; // 보기 전용 파일
  }
}
const historyKey = HISTORY_KEY + fileId();

void (async () => {
  const token = ((await figma.clientStorage.getAsync(TOKEN_KEY)) as string | undefined) ?? '';
  const history: unknown = await figma.clientStorage.getAsync(historyKey);
  post({ type: 'init', token, fileName: figma.root.name, history });
})();

function pageOf(node: BaseNode): PageNode | undefined {
  for (let n: BaseNode | null = node; n; n = n.parent) if (n.type === 'PAGE') return n;
  return undefined;
}

async function focusNodes(ids: string[]) {
  const found = (await Promise.all(ids.map((id) => figma.getNodeByIdAsync(id)))).filter(
    (n): n is SceneNode => n !== null && n.type !== 'PAGE' && n.type !== 'DOCUMENT',
  );
  const page = found[0] && pageOf(found[0]);
  if (!page) {
    figma.notify('노드를 찾을 수 없습니다. 지워졌을 수 있습니다.');
    return;
  }
  if (figma.currentPage !== page) await figma.setCurrentPageAsync(page);
  const onPage = found.filter((n) => pageOf(n) === page);
  figma.currentPage.selection = onPage;
  figma.viewport.scrollAndZoomIntoView(onPage);
  if (onPage.length < ids.length) figma.notify(`${ids.length}개 중 ${onPage.length}개를 선택했습니다.`);
}

async function runRequest(msg: Extract<UiToMain, { type: 'request' }>) {
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
}

// 요청은 한 번에 하나씩 처리한다(fill_template의 undo 단위 안에 다른 요청이 끼지 않도록)
let queue: Promise<void> = Promise.resolve();

figma.ui.onmessage = (msg: UiToMain) => {
  if (msg.type === 'saveToken') {
    void figma.clientStorage.setAsync(TOKEN_KEY, msg.token);
    return;
  }
  if (msg.type === 'saveHistory') {
    void figma.clientStorage.setAsync(historyKey, msg.entries);
    return;
  }
  if (msg.type === 'focusNodes') {
    void focusNodes(msg.ids).catch((e) => figma.notify(`이동하지 못했습니다: ${String(e)}`, { error: true }));
    return;
  }
  if (msg.type === 'resize') {
    figma.ui.resize(UI_WIDTH, Math.max(80, Math.min(600, msg.height)));
    return;
  }
  if (msg.type !== 'request') return;
  queue = queue.then(() => runRequest(msg)).catch(() => {});
};
