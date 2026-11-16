import type { NodeSummary } from '@figma-relay-mcp/protocol/types';

export interface SummarizableNode {
  id: string;
  name: string;
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  characters?: string;
  layoutMode?: string;
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  children?: readonly SummarizableNode[];
}

const TEXT_LIMIT = 200;

export function summarize(
  root: SummarizableNode,
  depth: number,
  limit = 500,
): { node: NodeSummary; truncated: boolean } {
  let count = 0;
  let truncated = false;

  const visit = (n: SummarizableNode, d: number): NodeSummary => {
    count++;
    const s: NodeSummary = { id: n.id, name: n.name, type: n.type };
    if (typeof n.x === 'number' && typeof n.y === 'number') {
      s.x = n.x;
      s.y = n.y;
      s.width = n.width;
      s.height = n.height;
    }
    if (typeof n.characters === 'string') {
      s.characters = n.characters.length > TEXT_LIMIT ? n.characters.slice(0, TEXT_LIMIT) + '…' : n.characters;
    }
    if (n.layoutMode && n.layoutMode !== 'NONE') {
      s.layout = {
        mode: n.layoutMode,
        itemSpacing: n.itemSpacing ?? 0,
        padding: [n.paddingTop ?? 0, n.paddingRight ?? 0, n.paddingBottom ?? 0, n.paddingLeft ?? 0],
      };
    }
    const kids = n.children;
    if (kids && kids.length > 0) {
      if (d >= depth) {
        s.childCount = kids.length;
      } else {
        s.children = [];
        for (const k of kids) {
          if (count >= limit) {
            truncated = true;
            s.childCount = kids.length;
            break;
          }
          s.children.push(visit(k, d + 1));
        }
      }
    }
    return s;
  };

  return { node: visit(root, 0), truncated };
}
