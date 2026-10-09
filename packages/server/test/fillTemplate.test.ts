import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/errors';
import { fakeBridge, samplePdf, toolsWith } from './helpers';

describe('fill_template', () => {
  it('resolves images, sends them as binaries and returns the plugin result', async () => {
    const { bridge, calls } = fakeBridge({
      fillTemplate: () => ({ result: { nodeIds: ['9:1', '9:2'], warnings: [{ row: 2, key: 'x', code: 'UNKNOWN_KEY' }] } }),
    });
    const run = toolsWith(bridge, { loadImage: async () => new Uint8Array([42]) });
    const out = await run('fill_template', {
      templateId: '1:1',
      rows: [{ name: 'A', photo: 'https://x/a.png' }, { name: 'B', x: 1 }],
    });
    expect(calls[0]).toMatchObject({
      method: 'fillTemplate',
      params: {
        templateId: '1:1',
        layout: 'grid',
        rows: [{ name: 'A', photo: { asset: 0, src: 'https://x/a.png' } }, { name: 'B', x: 1 }],
      },
      opts: { timeoutMs: 300_000 },
    });
    expect(calls[0]?.opts.binaries?.map((b) => [...b])).toEqual([[42]]);
    expect(out).toEqual({
      kind: 'json',
      value: { nodeIds: ['9:1', '9:2'], warnings: [{ row: 2, key: 'x', code: 'UNKNOWN_KEY' }] },
    });
  });

  it('exports the created nodes to PDF on the same session when asked', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fmcp-home-'));
    const part = await samplePdf([[50, 50]]);
    const { bridge, calls } = fakeBridge(
      {
        fillTemplate: () => ({ result: { nodeIds: ['9:1', '9:2'], warnings: [] } }),
        exportPdf: (p: { ids: string[] }) => ({ result: { pages: p.ids.length }, binaries: p.ids.map(() => part) }),
      },
      [{ sessionId: 'a', fileName: '명함', connectedAt: 1 }, { sessionId: 'b', fileName: 'B', connectedAt: 2 }],
    );
    const out = await toolsWith(bridge, { home })('fill_template', {
      templateId: '1:1', rows: [{ name: 'A' }, { name: 'B' }], sessionId: 'a', exportPdf: {},
    });
    expect(calls[1]).toMatchObject({ method: 'exportPdf', params: { ids: ['9:1', '9:2'] }, opts: { sessionId: 'a' } });
    expect(out.kind === 'json' && (out.value as { pdf: { pages: number; path: string } }).pdf).toMatchObject({
      pages: 2,
      path: join(home, 'Downloads', '명함-20261010-090000.pdf'),
    });
  });

  it('keeps the created node ids and reports pdfError when the PDF export fails', async () => {
    const { bridge } = fakeBridge({
      fillTemplate: () => ({ result: { nodeIds: ['9:1'], warnings: [] } }),
      exportPdf: () => {
        throw new ToolError('NODE_NOT_FOUND', '없음');
      },
    });
    const out = await toolsWith(bridge)('fill_template', { templateId: '1:1', rows: [{ a: 'x' }], exportPdf: {} });
    expect(out).toEqual({
      kind: 'json',
      value: { nodeIds: ['9:1'], warnings: [], pdfError: { code: 'NODE_NOT_FOUND', message: '없음' } },
    });
  });

  it('validates rows', () => {
    const { bridge } = fakeBridge({});
    const run = toolsWith(bridge);
    expect(() => run('fill_template', { templateId: '1:1', rows: [] })).toThrow();
    expect(() => run('fill_template', { templateId: '1:1', rows: [{ a: { nested: 1 } }] })).toThrow();
  });
});
