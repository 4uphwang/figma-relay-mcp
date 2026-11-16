import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TemplateRow } from '@figma-relay-mcp/protocol';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 200 * 1024 * 1024;
const URL_RE = /^https?:\/\//i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif)$/i; // figma.createImage가 받는 형식

export function looksLikeImage(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  if (URL_RE.test(v)) return true;
  return (v.startsWith('/') || v.startsWith('~/')) && IMAGE_EXT_RE.test(v);
}

const tooBig = () => new Error(`이미지가 ${MAX_IMAGE_BYTES / 1024 / 1024}MB보다 큽니다`);

export async function loadImage(src: string): Promise<Uint8Array> {
  if (URL_RE.test(src)) {
    const res = await fetch(src, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    const type = res.headers.get('content-type');
    if (type && !type.toLowerCase().startsWith('image/')) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`이미지가 아닙니다 (${type})`);
    }
    const length = Number(res.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) {
      await res.body?.cancel().catch(() => {});
      throw tooBig();
    }
    if (!res.body) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => {});
        throw tooBig();
      }
      chunks.push(value);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
  const path = src.startsWith('~/') ? join(homedir(), src.slice(2)) : src;
  if ((await stat(path)).size > MAX_IMAGE_BYTES) throw tooBig();
  return new Uint8Array(await readFile(path));
}

const CONCURRENCY = 4;

export async function resolveImages(
  rows: Record<string, string | number | boolean | null>[],
  load: (src: string) => Promise<Uint8Array>,
  opts: { maxTotalBytes?: number } = {},
): Promise<{ rows: TemplateRow[]; binaries: Uint8Array[] }> {
  const maxTotal = opts.maxTotalBytes ?? MAX_TOTAL_IMAGE_BYTES;
  const sources: string[] = [];
  for (const row of rows) {
    for (const v of Object.values(row)) if (looksLikeImage(v) && !sources.includes(v)) sources.push(v);
  }

  const loaded = new Map<string, Uint8Array | Error>();
  let next = 0;
  const worker = async () => {
    while (next < sources.length) {
      const src = sources[next++]!;
      try {
        loaded.set(src, await load(src));
      } catch (e) {
        loaded.set(src, e instanceof Error ? e : new Error(String(e)));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sources.length) }, worker));

  // 번호와 전체 용량 계산은 처음 나온 순서대로 결정한다
  const outcome = new Map<string, number | Error>();
  const binaries: Uint8Array[] = [];
  let total = 0;
  for (const src of sources) {
    const r = loaded.get(src)!;
    if (r instanceof Error) {
      outcome.set(src, r);
    } else if (total + r.length > maxTotal) {
      outcome.set(src, new Error('이미지 전체 크기가 200MB를 넘었습니다'));
    } else {
      total += r.length;
      outcome.set(src, binaries.push(r) - 1);
    }
  }

  const out: TemplateRow[] = rows.map((row) => {
    const resolved: TemplateRow = {};
    for (const [key, value] of Object.entries(row)) {
      if (!looksLikeImage(value)) {
        resolved[key] = value;
        continue;
      }
      const r = outcome.get(value)!;
      resolved[key] = typeof r === 'number' ? { asset: r, src: value } : { imageError: r.message, src: value };
    }
    return resolved;
  });
  return { rows: out, binaries };
}
