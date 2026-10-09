import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function loadOrCreateToken(dir: string): Promise<string> {
  const file = join(dir, 'token');
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (existing) return existing;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const token = randomBytes(24).toString('base64url');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await writeFile(file, token + '\n', { mode: 0o600 });
  return token;
}
