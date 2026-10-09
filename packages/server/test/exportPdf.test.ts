import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { fakeBridge, samplePdf, toolsWith } from './helpers';

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'fmcp-home-'));
  const parts = [await samplePdf([[100, 100]]), await samplePdf([[200, 200]])];
  const { bridge, calls } = fakeBridge(
    { exportPdf: (p: { ids: string[] }) => ({ result: { pages: p.ids.length }, binaries: parts.slice(0, p.ids.length) }) },
    [{ sessionId: 's1', fileName: '제안서', connectedAt: 1 }],
  );
  return { home, calls, run: toolsWith(bridge, { home }) };
}

describe('export_pdf', () => {
  it('merges in order and saves to Downloads by default', async () => {
    const { home, calls, run } = await setup();
    const out = await run('export_pdf', { ids: ['1:1', '1:2'] });
    const path = join(home, 'Downloads', '제안서-20261010-090000.pdf');
    expect(out).toEqual({ kind: 'json', value: { path, pages: 2, bytes: expect.any(Number) } });
    expect(calls[0]?.opts.timeoutMs).toBe(300_000);
    const doc = await PDFDocument.load(await readFile(path));
    expect(doc.getPages().map((p) => p.getWidth())).toEqual([100, 200]);
  });

  it('never overwrites: appends -2', async () => {
    const { home, run } = await setup();
    const target = join(home, 'out.pdf');
    await writeFile(target, 'old');
    const out = await run('export_pdf', { ids: ['1:1'], outPath: '~/out.pdf' });
    expect(out.kind === 'json' && (out.value as { path: string }).path).toBe(join(home, 'out-2.pdf'));
    expect(await readFile(target, 'utf8')).toBe('old');
  });

  it('fails with IO_ERROR when a part is missing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fmcp-home-'));
    const { bridge } = fakeBridge({ exportPdf: () => ({ result: { pages: 2 }, binaries: [new Uint8Array([1])] }) });
    await expect(toolsWith(bridge, { home })('export_pdf', { ids: ['1:1', '1:2'] })).rejects.toMatchObject({ code: 'IO_ERROR' });
  });

  it('rejects an empty id list', () => {
    const { bridge } = fakeBridge({});
    expect(() => toolsWith(bridge)('export_pdf', { ids: [] })).toThrow();
  });
});
