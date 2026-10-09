import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/errors';
import { fakeBridge, toolsWith } from './helpers';

describe('read tools', () => {
  it('list_files asks each session for its status', async () => {
    const { bridge, calls } = fakeBridge({
      getStatus: (_p, o) => ({ result: { fileName: `F-${o.sessionId}`, currentPage: { id: '0:1', name: 'P' } } }),
    }, [{ sessionId: 'a', fileName: 'A', connectedAt: 1 }, { sessionId: 'b', fileName: 'B', connectedAt: 2 }]);
    const out = await toolsWith(bridge)('list_files', {});
    expect(out).toEqual({ kind: 'json', value: { files: [
      { sessionId: 'a', fileName: 'F-a', currentPage: { id: '0:1', name: 'P' } },
      { sessionId: 'b', fileName: 'F-b', currentPage: { id: '0:1', name: 'P' } },
    ] } });
    expect(calls.every((c) => c.opts.timeoutMs === 5000)).toBe(true);
  });

  it('list_files with no sessions returns a hint', async () => {
    const { bridge } = fakeBridge({}, []);
    const out = await toolsWith(bridge)('list_files', {});
    expect(out.kind === 'json' && (out.value as { files: unknown[]; hint: string }).hint).toContain('Plugins');
  });

  it('get_node defaults depth to 2 and passes sessionId', async () => {
    const { bridge, calls } = fakeBridge({ getNode: () => ({ result: { node: { id: '1:1' }, truncated: false } }) });
    await toolsWith(bridge)('get_node', { id: '1:1', sessionId: 's1' });
    expect(calls[0]).toMatchObject({ method: 'getNode', params: { id: '1:1', depth: 2 }, opts: { sessionId: 's1' } });
  });

  it('get_node rejects depth over 10', () => {
    const { bridge } = fakeBridge({});
    expect(() => toolsWith(bridge)('get_node', { id: '1:1', depth: 11 })).toThrow();
  });

  it('find_nodes and get_selection forward params', async () => {
    const { bridge, calls } = fakeBridge({
      findNodes: () => ({ result: { nodes: [], truncated: false } }),
      getSelection: () => ({ result: [] }),
    });
    const run = toolsWith(bridge);
    await run('find_nodes', { query: '^Card', type: 'FRAME' });
    await run('get_selection', {});
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ['findNodes', { query: '^Card', type: 'FRAME' }],
      ['getSelection', {}],
    ]);
  });

  it('screenshot returns the PNG part as an image', async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const { bridge, calls } = fakeBridge({ screenshot: () => ({ result: { width: 10, height: 5, scale: 1 }, binaries: [png] }) });
    const out = await toolsWith(bridge)('screenshot', { id: '1:1' });
    expect(calls[0]?.params).toEqual({ id: '1:1', scale: 1 });
    expect(out).toEqual({ kind: 'image', png, meta: { width: 10, height: 5, scale: 1 } });
  });

  it('execute forwards code and returns the value', async () => {
    const { bridge } = fakeBridge({ execute: (p) => ({ result: { echoed: p.code } }) });
    const out = await toolsWith(bridge)('execute', { code: 'return 1' });
    expect(out).toEqual({ kind: 'json', value: { echoed: 'return 1' } });
  });
});

describe('list_files', () => {
  it('rejects PORT_IN_USE when the bridge failed to start', async () => {
    const err = new ToolError('PORT_IN_USE', '포트 사용 중');
    const { bridge } = fakeBridge({}, undefined, err);
    await expect(toolsWith(bridge)('list_files', {})).rejects.toMatchObject({ code: 'PORT_IN_USE' });
  });
});

describe('screenshot', () => {
  it('throws IO_ERROR when no PNG arrives', async () => {
    const { bridge } = fakeBridge({ screenshot: () => ({ result: {} }) });
    await expect(toolsWith(bridge)('screenshot', { id: '1:1' })).rejects.toMatchObject({ code: 'IO_ERROR' });
  });
});
