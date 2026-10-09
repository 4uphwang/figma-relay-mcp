import { describe, expect, it } from 'vitest';
import { collectNodeIds, finishEntry, loadHistory, startEntry, summarize, toolName } from '../src/lib/history';

describe('toolName', () => {
  it('shows MCP tool names', () => {
    expect(toolName('getNode')).toBe('get_node');
    expect(toolName('execute')).toBe('execute');
  });
});

describe('summarize', () => {
  it('uses the first code line that is not a comment', () => {
    expect(summarize('execute', { code: '\n// 보드 만들기\n  const a = 1;\nreturn a;' })).toBe('const a = 1;');
  });
  it('falls back to id, query, counts', () => {
    expect(summarize('screenshot', { id: '1:2', scale: 1 })).toBe('1:2');
    expect(summarize('findNodes', { query: 'card' })).toBe('card');
    expect(summarize('exportPdf', { ids: ['1:2', '1:3'] })).toBe('노드 2개');
    expect(summarize('fillTemplate', { templateId: '1:2', rows: [{}, {}, {}] })).toBe('3행');
    expect(summarize('getStatus', {})).toBe('');
  });
});

describe('collectNodeIds', () => {
  it('takes target ids from params, not the template', () => {
    expect(collectNodeIds({ id: '1:2' }, undefined)).toEqual(['1:2']);
    expect(collectNodeIds({ templateId: '9:9', rows: [] }, { nodeIds: ['3:4', '3:5'], warnings: [] })).toEqual(['3:4', '3:5']);
  });
  it('finds serialized nodes in execute results, skipping pages and children', () => {
    const result = {
      board: { id: '1006:61', name: '보드', type: 'FRAME', children: [{ id: '1006:62', name: 'c', type: 'TEXT' }] },
      page: { id: '0:1', name: 'Page 1', type: 'PAGE' },
      list: [{ id: 'I5:6;7:8', name: 'inst', type: 'INSTANCE' }],
      note: 'not 1:2 an id',
    };
    expect(collectNodeIds({ code: '' }, result)).toEqual(['1006:61', 'I5:6;7:8']);
  });
  it('ignores a bare string result', () => {
    expect(collectNodeIds({ code: '' }, '1:2')).toEqual([]);
  });
});

describe('entries', () => {
  it('records duration, outcome and result nodes', () => {
    const e = startEntry('r1', 'execute', { code: 'return figma.createFrame()' }, 1000);
    expect(e.code).toBe('return figma.createFrame()');
    const ok = finishEntry(e, { code: '' }, { ok: true, result: { id: '2:3', name: 'Frame', type: 'FRAME' } }, 1400);
    expect(ok).toMatchObject({ ms: 400, ok: true, nodeIds: ['2:3'] });
    const bad = finishEntry(e, {}, { ok: false, error: { code: 'EXEC_ERROR', message: 'boom', hint: 'h' } }, 1100);
    expect(bad).toMatchObject({ ok: false, error: { code: 'EXEC_ERROR', message: 'boom' } });
  });
  it('truncates long code', () => {
    expect(startEntry('r', 'execute', { code: 'x'.repeat(3000) }, 0).code).toHaveLength(2002);
  });
});

describe('loadHistory', () => {
  it('drops malformed entries and marks unfinished ones as interrupted', () => {
    const good = { id: 'a', method: 'execute', at: 1, ok: true, summary: '', nodeIds: [] };
    const pending = { id: 'b', method: 'execute', at: 2, summary: '', nodeIds: [] };
    const loaded = loadHistory([good, { id: 3 }, null, pending]);
    expect(loaded.map((e) => e.id)).toEqual(['a', 'b']);
    expect(loaded[1]).toMatchObject({ ok: false, error: { code: 'INTERRUPTED' } });
    expect(loadHistory('nope')).toEqual([]);
  });
});
