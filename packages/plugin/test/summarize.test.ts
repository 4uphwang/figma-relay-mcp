import { describe, expect, it } from 'vitest';
import { summarize, type SummarizableNode } from '../src/lib/summarize';

const leaf = (id: string, extra: Partial<SummarizableNode> = {}): SummarizableNode => ({
  id, name: `n${id}`, type: 'RECTANGLE', x: 1, y: 2, width: 3, height: 4, ...extra,
});

describe('summarize', () => {
  it('copies geometry, text and auto layout', () => {
    const root: SummarizableNode = {
      ...leaf('1', { type: 'FRAME' }),
      layoutMode: 'VERTICAL', itemSpacing: 8, paddingTop: 1, paddingRight: 2, paddingBottom: 3, paddingLeft: 4,
      children: [leaf('2', { type: 'TEXT', characters: '안녕' })],
    };
    const { node, truncated } = summarize(root, 2);
    expect(truncated).toBe(false);
    expect(node).toEqual({
      id: '1', name: 'n1', type: 'FRAME', x: 1, y: 2, width: 3, height: 4,
      layout: { mode: 'VERTICAL', itemSpacing: 8, padding: [1, 2, 3, 4] },
      children: [{ id: '2', name: 'n2', type: 'TEXT', x: 1, y: 2, width: 3, height: 4, characters: '안녕' }],
    });
  });

  it('omits layout when layoutMode is NONE', () => {
    expect(summarize(leaf('1', { layoutMode: 'NONE' }), 1).node.layout).toBeUndefined();
  });

  it('stops at depth and reports childCount', () => {
    const root = { ...leaf('1'), children: [{ ...leaf('2'), children: [leaf('3')] }] };
    const { node } = summarize(root, 1);
    expect(node.children?.[0]?.children).toBeUndefined();
    expect(node.children?.[0]?.childCount).toBe(1);
    expect(summarize(root, 0).node).toMatchObject({ childCount: 1 });
  });

  it('truncates long text to 200 chars', () => {
    const { node } = summarize(leaf('1', { characters: 'a'.repeat(250) }), 0);
    expect(node.characters).toHaveLength(201);
    expect(node.characters?.endsWith('…')).toBe(true);
  });

  it('caps the total node count', () => {
    const root = { ...leaf('r'), children: Array.from({ length: 10 }, (_, i) => leaf(String(i))) };
    const { node, truncated } = summarize(root, 5, 4);
    expect(truncated).toBe(true);
    expect(node.children).toHaveLength(3);
    expect(node.childCount).toBe(10);
  });

  it('handles nodes without geometry (pages)', () => {
    const { node } = summarize({ id: '0:1', name: 'Page', type: 'PAGE', children: [] }, 1);
    expect(node).toEqual({ id: '0:1', name: 'Page', type: 'PAGE' });
  });
});
