import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES, loadImage, looksLikeImage, resolveImages } from '../src/images';

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

describe('loadImage limits', () => {
  async function withServer(handler: Parameters<typeof createServer>[1], fn: (base: string) => Promise<void>) {
    const server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }

  it('rejects non-image content types', async () => {
    await withServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>'); }, async (base) => {
      await expect(loadImage(`${base}/x`)).rejects.toThrow('이미지가 아닙니다 (text/html)');
    });
  });

  it('rejects a too-large content-length early', async () => {
    await withServer((_, res) => { res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(MAX_IMAGE_BYTES + 1) }); res.write('x'); }, async (base) => {
      await expect(loadImage(`${base}/x`)).rejects.toThrow('보다 큽니다');
    });
  });

  it('aborts a chunked body that exceeds the limit', async () => {
    await withServer((_, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      const chunk = Buffer.alloc(1024 * 1024);
      let n = 0;
      const pump = () => { while (n++ < 30) if (!res.write(chunk)) return void res.once('drain', pump); res.end(); };
      pump();
    }, async (base) => {
      await expect(loadImage(`${base}/x`)).rejects.toThrow('보다 큽니다');
    });
  });
});

describe('resolveImages limits', () => {
  it('turns sources over the total cap into imageError with dense numbering', async () => {
    const load = async (src: string) => new Uint8Array(src.endsWith('big.png') ? 8 : 4);
    const { rows, binaries } = await resolveImages(
      [{ a: 'https://x/a.png', b: 'https://x/big.png', c: 'https://x/c.png' }],
      load,
      { maxTotalBytes: 10 },
    );
    expect(binaries).toHaveLength(2);
    expect(rows[0]).toEqual({
      a: { asset: 0, src: 'https://x/a.png' },
      b: { imageError: '이미지 전체 크기가 200MB를 넘었습니다', src: 'https://x/big.png' },
      c: { asset: 1, src: 'https://x/c.png' },
    });
  });

  it('downloads at most 4 at a time and numbers assets by first appearance', async () => {
    let inFlight = 0;
    let max = 0;
    const load = async (src: string) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, src.endsWith('0.png') ? 30 : 5));
      inFlight--;
      return new Uint8Array([Number(src.match(/(\d+)\.png/)![1])]);
    };
    const row = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, `https://x/${i}.png`]));
    const { rows, binaries } = await resolveImages([row], load);
    expect(max).toBe(4);
    expect(binaries.map((b) => b[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(rows[0]!.k7).toEqual({ asset: 7, src: 'https://x/7.png' });
  });
});
