import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Bridge } from '../src/bridge';
import { Hub } from '../src/hub';
import { HubClient } from '../src/hubClient';
import { fakePlugin } from './fakePlugin';

const TOKEN = 'secret';
const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function makeHub(port: number, opts: { build?: number; idleMs?: number } = {}) {
  const exits: string[] = [];
  const hub = new Hub({ token: TOKEN, build: opts.build ?? 1, idleMs: 'idleMs' in opts ? opts.idleMs : 60_000, onExit: (r) => exits.push(r) });
  cleanups.push(() => hub.stop());
  const started = hub.start(port);
  return { hub, exits, started };
}

// 실제로는 프로세스를 띄우지만, 테스트에서는 같은 프로세스 안에 허브를 만든다
function makeClient(port: number, opts: { label?: string; build?: number; token?: string; spawn?: () => void } = {}) {
  const hubs: ReturnType<typeof makeHub>[] = [];
  const client = new HubClient({
    token: opts.token ?? TOKEN,
    label: opts.label ?? 'proj',
    build: opts.build ?? 1,
    port,
    connectTimeoutMs: 3_000,
    welcomeTimeoutMs: 300,
    spawnHub: opts.spawn ?? (() => hubs.push(makeHub(port, { build: opts.build ?? 1 }))),
  });
  cleanups.push(() => client.close());
  return { client, hubs };
}

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return (e as { code: string }).code;
  }
  return 'NO_ERROR';
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

describe('Hub + HubClient', () => {
  it('spawns a hub when none is running and relays calls with binaries both ways', async () => {
    const port = await freePort();
    const { client, hubs } = makeClient(port, { label: 'marc-finance' });
    await client.ready();
    expect(hubs).toHaveLength(1);

    const plugin = fakePlugin(port, {
      token: TOKEN,
      fileName: '제안서',
      onRequest: (_m, _p, bins) => ({ result: { got: bins.map((b) => b.length) }, binaries: [new Uint8Array([7]), new Uint8Array([8, 8])] }),
    });
    await plugin.welcomed;
    await until(() => client.sessions().length === 1);

    const r = await client.call('exportPdf', { ids: ['1:1', '1:2'] }, { binaries: [new Uint8Array([1, 2, 3])] });
    expect(r.result).toEqual({ got: [3] });
    expect(r.binaries.map((b) => [...b])).toEqual([[7], [8, 8]]);
    expect(r.session.fileName).toBe('제안서');
    expect(plugin.received[0]?.client).toBe('marc-finance');
  });

  it('lets two sessions share one hub at the same time', async () => {
    const port = await freePort();
    const a = makeClient(port, { label: 'a' });
    await a.client.ready();
    const b = makeClient(port, { label: 'b', spawn: () => expect.fail('second session must not spawn') });
    await b.client.ready();

    const plugin = fakePlugin(port, {
      token: TOKEN,
      onRequest: (_m, params) => ({ result: (params as { code: string }).code }),
    });
    await plugin.welcomed;
    await until(() => a.client.sessions().length === 1 && b.client.sessions().length === 1);

    const [ra, rb] = await Promise.all([
      a.client.call('execute', { code: 'from a' }),
      b.client.call('execute', { code: 'from b' }),
    ]);
    expect([ra.result, rb.result]).toEqual(['from a', 'from b']);
    expect(plugin.received.map((r) => r.client).sort()).toEqual(['a', 'b']);

    plugin.ws.close();
    await until(() => a.client.sessions().length === 0);
  });

  it('passes plugin errors and the session ambiguity error through', async () => {
    const port = await freePort();
    const { client } = makeClient(port);
    await client.ready();
    const one = fakePlugin(port, { token: TOKEN, sessionId: 'one', onRequest: () => ({ error: { code: 'EXEC_ERROR', message: 'boom' } }) });
    await one.welcomed;
    expect(await codeOf(client.call('execute', { code: '' }))).toBe('EXEC_ERROR');
    const two = fakePlugin(port, { token: TOKEN, sessionId: 'two' });
    await two.welcomed;
    expect(await codeOf(client.call('execute', { code: '' }))).toBe('INVALID_ARGS');
  });

  it('restarts an older hub with the newer build', async () => {
    const port = await freePort();
    const old = makeHub(port, { build: 1 });
    await old.started;
    const { client, hubs } = makeClient(port, { build: 2 });
    await client.ready();
    expect(old.exits).toEqual(['restart']);
    expect(hubs).toHaveLength(1);
  });

  it('keeps a newer hub for an older client', async () => {
    const port = await freePort();
    const hub = makeHub(port, { build: 5 });
    await hub.started;
    const { client, hubs } = makeClient(port, { build: 2 });
    await client.ready();
    expect(hub.exits).toEqual([]);
    expect(hubs).toHaveLength(0);
  });

  it('reports PORT_IN_USE when an old non-hub server holds the port', async () => {
    const port = await freePort();
    const legacy = new Bridge({ token: TOKEN });
    cleanups.push(() => legacy.stop());
    await legacy.start(port);
    const { client } = makeClient(port);
    expect(await codeOf(client.ready())).toBe('PORT_IN_USE');
  });

  it('reports a token the hub rejects', async () => {
    const port = await freePort();
    await makeHub(port).started;
    const { client } = makeClient(port, { token: 'wrong' });
    expect(await codeOf(client.ready())).toBe('NOT_CONNECTED');
  });

  it('stays up with no sessions when no idleMs is given', async () => {
    const port = await freePort();
    const h = makeHub(port, { idleMs: undefined });
    await h.started;
    const { client } = makeClient(port);
    await client.ready();
    client.close();
    await new Promise((r) => setTimeout(r, 120));
    expect(h.exits).toEqual([]);
  });

  it('exits with restart when the plugin asks for a restart', async () => {
    const port = await freePort();
    const h = makeHub(port);
    await h.started;
    const plugin = fakePlugin(port, { token: TOKEN });
    await plugin.welcomed;
    plugin.ws.send(JSON.stringify({ type: 'restartHub' }));
    await until(() => h.exits.length === 1);
    expect(h.exits).toEqual(['restart']);
  });

  it('exits when idle with no sessions, but not while one is attached', async () => {
    const port = await freePort();
    const h = makeHub(port, { idleMs: 50 });
    await h.started;
    const { client } = makeClient(port);
    await client.ready();
    await new Promise((r) => setTimeout(r, 120));
    expect(h.exits).toEqual([]);
    client.close();
    await until(() => h.exits.length === 1);
    expect(h.exits).toEqual(['idle']);
  });

  it('fails pending calls when the hub dies and respawns it on the next call', async () => {
    const port = await freePort();
    const { client, hubs } = makeClient(port);
    await client.ready();
    const plugin = fakePlugin(port, { token: TOKEN, onRequest: () => ({ silent: true }) });
    await plugin.welcomed;
    await until(() => client.sessions().length === 1);
    const pending = client.call('execute', { code: '' });
    await new Promise((r) => setTimeout(r, 20));
    await hubs[0]!.hub.stop();
    expect(await codeOf(pending)).toBe('NOT_CONNECTED');
    await client.ready();
    expect(hubs).toHaveLength(2);
  });
});
