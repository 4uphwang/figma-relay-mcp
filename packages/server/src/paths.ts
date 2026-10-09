import { access } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import { ToolError } from './errors';

export function expandPath(p: string, home: string): string {
  const expanded = p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p;
  if (!isAbsolute(expanded)) {
    throw new ToolError('INVALID_ARGS', `절대 경로가 아닙니다: ${p}`, '~/ 또는 / 로 시작하는 경로를 쓰세요');
  }
  return expanded;
}

export function defaultPdfPath(fileName: string, now: Date, home: string): string {
  const safe = fileName.replace(/[/\\:*?"<>|]/g, '_').trim() || 'figma';
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return join(home, 'Downloads', `${safe}-${stamp}.pdf`);
}

export async function uniquePath(path: string): Promise<string> {
  const ext = extname(path);
  const base = path.slice(0, path.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? path : `${base}-${i}${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
