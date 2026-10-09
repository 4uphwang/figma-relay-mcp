import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadImage, looksLikeImage, resolveImages } from '../src/images';

describe('looksLikeImage', () => {
  it('accepts URLs and absolute image paths', () => {
    expect(looksLikeImage('https://x.com/a')).toBe(true);
    expect(looksLikeImage('http://x.com/a.png')).toBe(true);
    expect(looksLikeImage('/Users/me/a.PNG')).toBe(true);
    expect(looksLikeImage('~/pics/b.jpeg')).toBe(true);
  });
  it('rejects everything else', () => {
    expect(looksLikeImage('홍길동')).toBe(false);
    expect(looksLikeImage('/Users/me/a.webp')).toBe(false);
    expect(looksLikeImage('a.png')).toBe(false);
    expect(looksLikeImage(3)).toBe(false);
    expect(looksLikeImage(null)).toBe(false);
  });
});

describe('resolveImages', () => {
  it('replaces image values with asset refs and loads each source once', async () => {
    const loaded: string[] = [];
    const load = async (src: string) => {
      loaded.push(src);
      if (src.includes('bad')) throw new Error('HTTP 404');
      return new Uint8Array([src.length]);
    };
    const { rows, binaries } = await resolveImages(
      [
        { name: 'A', photo: 'https://x/a.png', n: 1 },
        { name: 'B', photo: 'https://x/a.png', n: null },
        { name: 'C', photo: 'https://x/bad.png', n: true },
      ],
      load,
    );
    expect(loaded).toEqual(['https://x/a.png', 'https://x/bad.png']);
    expect(binaries).toHaveLength(1);
    expect(rows).toEqual([
      { name: 'A', photo: { asset: 0, src: 'https://x/a.png' }, n: 1 },
      { name: 'B', photo: { asset: 0, src: 'https://x/a.png' }, n: null },
      { name: 'C', photo: { imageError: 'HTTP 404', src: 'https://x/bad.png' }, n: true },
    ]);
  });
});

describe('loadImage', () => {
  it('reads a local file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fmcp-img-'));
    const p = join(dir, 'a.png');
    await writeFile(p, Buffer.from([1, 2, 3]));
    expect([...(await loadImage(p))]).toEqual([1, 2, 3]);
  });

  it('downloads over http and fails on non-2xx', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/ok.png') {
        res.writeHead(200);
        res.end(Buffer.from([9, 8]));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      expect([...(await loadImage(`http://127.0.0.1:${port}/ok.png`))]).toEqual([9, 8]);
      await expect(loadImage(`http://127.0.0.1:${port}/missing.png`)).rejects.toThrow('HTTP 404');
    } finally {
      server.close();
    }
  });
});
