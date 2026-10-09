import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/errors';
import { defaultPdfPath, expandPath, uniquePath } from '../src/paths';

describe('expandPath', () => {
  it('expands ~', () => {
    expect(expandPath('~/a/b.pdf', '/Users/me')).toBe('/Users/me/a/b.pdf');
    expect(expandPath('~', '/Users/me')).toBe('/Users/me');
  });
  it('keeps absolute paths', () => {
    expect(expandPath('/tmp/x.pdf', '/Users/me')).toBe('/tmp/x.pdf');
  });
  it('rejects relative paths', () => {
    expect(() => expandPath('x.pdf', '/Users/me')).toThrow(ToolError);
    try { expandPath('x.pdf', '/Users/me'); } catch (e) { expect((e as ToolError).code).toBe('INVALID_ARGS'); }
  });
});

describe('defaultPdfPath', () => {
  it('uses Downloads, the file name and a local timestamp', () => {
    const now = new Date(2026, 9, 10, 9, 5, 7);
    expect(defaultPdfPath('제안서', now, '/Users/me')).toBe('/Users/me/Downloads/제안서-20261010-090507.pdf');
  });
  it('replaces characters that are unsafe in file names', () => {
    const now = new Date(2026, 0, 1, 0, 0, 0);
    expect(defaultPdfPath('a/b:c', now, '/h')).toBe('/h/Downloads/a_b_c-20260101-000000.pdf');
    expect(defaultPdfPath('  ', now, '/h')).toBe('/h/Downloads/figma-20260101-000000.pdf');
  });
});

describe('uniquePath', () => {
  it('returns the path when free, otherwise appends -2, -3', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fmcp-'));
    const p = join(dir, 'out.pdf');
    expect(await uniquePath(p)).toBe(p);
    await writeFile(p, '');
    expect(await uniquePath(p)).toBe(join(dir, 'out-2.pdf'));
    await writeFile(join(dir, 'out-2.pdf'), '');
    expect(await uniquePath(p)).toBe(join(dir, 'out-3.pdf'));
  });
});
