import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TemplateRow } from '@figma-mcp/protocol';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) throw tooBig();
    return bytes;
  }
  const path = src.startsWith('~/') ? join(homedir(), src.slice(2)) : src;
  if ((await stat(path)).size > MAX_IMAGE_BYTES) throw tooBig();
  return new Uint8Array(await readFile(path));
}

export async function resolveImages(
  rows: Record<string, string | number | boolean | null>[],
  load: (src: string) => Promise<Uint8Array>,
): Promise<{ rows: TemplateRow[]; binaries: Uint8Array[] }> {
  const seen = new Map<string, number | Error>();
  const binaries: Uint8Array[] = [];
  const out: TemplateRow[] = [];
  for (const row of rows) {
    const resolved: TemplateRow = {};
    for (const [key, value] of Object.entries(row)) {
      if (!looksLikeImage(value)) {
        resolved[key] = value;
        continue;
      }
      if (!seen.has(value)) {
        try {
          seen.set(value, binaries.push(await load(value)) - 1);
        } catch (e) {
          seen.set(value, e instanceof Error ? e : new Error(String(e)));
        }
      }
      const r = seen.get(value)!;
      resolved[key] = typeof r === 'number' ? { asset: r, src: value } : { imageError: r.message, src: value };
    }
    out.push(resolved);
  }
  return { rows: out, binaries };
}
