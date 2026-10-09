import type { Handler } from '../bridgeTypes';
import { requireNode } from './read';

export const exportPdf: Handler<'exportPdf'> = async ({ ids }, ctx) => {
  // 하나라도 없으면 아무것도 보내기 전에 실패한다.
  const nodes = [];
  for (const id of ids) nodes.push(await requireNode(id));
  for (const [part, node] of nodes.entries()) {
    const bytes = await node.exportAsync({ format: 'PDF' });
    ctx.sendBinary(part, bytes);
  }
  return { pages: ids.length };
};
