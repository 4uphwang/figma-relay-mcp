import { mkdtemp, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOrCreateToken } from '../src/token';

describe('loadOrCreateToken', () => {
  it('creates a token file readable only by the owner', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'fmcp-')), '.figma-relay-mcp');
    const token = await loadOrCreateToken(dir);
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect((await readFile(join(dir, 'token'), 'utf8')).trim()).toBe(token);
    expect((await stat(join(dir, 'token'))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('reuses an existing token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fmcp-'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'token'), 'existing-token\n');
    expect(await loadOrCreateToken(dir)).toBe('existing-token');
  });

  it('returns the same token on the second call', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'fmcp-')), 'x');
    expect(await loadOrCreateToken(dir)).toBe(await loadOrCreateToken(dir));
  });
});
