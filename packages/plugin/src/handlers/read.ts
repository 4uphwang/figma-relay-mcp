import type { Handler } from '../bridgeTypes';
import { PluginError } from '../lib/errors';
import { summarize, type SummarizableNode } from '../lib/summarize';

const MAX_FIND = 200;
const MAX_SCREENSHOT_SIDE = 2048;
const asSummarizable = (n: BaseNode) => n as unknown as SummarizableNode;

export async function requireNode(id: string): Promise<SceneNode> {
  const n = await figma.getNodeByIdAsync(id);
  if (!n || n.type === 'DOCUMENT' || n.type === 'PAGE') {
    throw new PluginError('NODE_NOT_FOUND', `노드가 없습니다: ${id}`, 'find_nodes나 get_selection으로 ID를 다시 확인하세요');
  }
  return n as SceneNode;
}

export const getStatus: Handler<'getStatus'> = async () => ({
  fileName: figma.root.name,
  currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
});

export const getSelection: Handler<'getSelection'> = async () =>
  figma.currentPage.selection.map((n) => summarize(asSummarizable(n), 0).node);

export const getNode: Handler<'getNode'> = async ({ id, depth }) => {
  const n = await figma.getNodeByIdAsync(id);
  if (!n) throw new PluginError('NODE_NOT_FOUND', `노드가 없습니다: ${id}`, 'find_nodes나 get_selection으로 ID를 다시 확인하세요');
  if (n.type === 'PAGE') await n.loadAsync();
  return summarize(asSummarizable(n), depth);
};

export const findNodes: Handler<'findNodes'> = async ({ query, type, pageId }) => {
  let re: RegExp;
  try {
    re = new RegExp(query, 'i');
  } catch {
    throw new PluginError('INVALID_ARGS', `정규식이 잘못됐습니다: ${query}`);
  }
  const page = pageId ? await figma.getNodeByIdAsync(pageId) : figma.currentPage;
  if (!page || page.type !== 'PAGE') throw new PluginError('NODE_NOT_FOUND', `페이지가 없습니다: ${pageId}`);
  await page.loadAsync();
  const found = page.findAll((n) => re.test(n.name) && (!type || n.type === type));
  return {
    nodes: found.slice(0, MAX_FIND).map((n) => summarize(asSummarizable(n), 0).node),
    truncated: found.length > MAX_FIND,
  };
};

export const screenshot: Handler<'screenshot'> = async ({ id, scale }, ctx) => {
  const n = await requireNode(id);
  const longest = Math.max(n.width, n.height, 1);
  const s = Math.min(scale, MAX_SCREENSHOT_SIDE / longest);
  const bytes = await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: s } });
  ctx.sendBinary(0, bytes);
  return { width: Math.round(n.width * s), height: Math.round(n.height * s), scale: s };
};
