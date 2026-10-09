import { afterEach, describe, expect, it } from 'vitest';
import { Bridge } from '../src/bridge';
import { ToolError } from '../src/errors';
import { fakePlugin } from './fakePlugin';

const TOKEN = 'secret';
const bridges: Bridge[] = [];

async function startBridge(helloTimeoutMs?: number) {
  const bridge = new Bridge({ token: TOKEN, helloTimeoutMs });
  bridges.push(bridge);
  const port = await bridge.start(0);
  return { bridge, port };
}

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return (e as ToolError).code;
  }
  return 'NO_ERROR';
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((b) => b.stop()));
});

describe('Bridge', () => {
  it('closes with 4001 on a wrong token and registers nothing', async () => {
    const { bridge, port } = await startBridge();
    const p = fakePlugin(port, { token: 'wrong' });
    expect(await p.closed).toBe(4001);
    expect(bridge.sessions()).toEqual([]);
  });

  it('closes with 4002 when hello never comes', async () => {
    const { port } = await startBridge(50);
    const p = fakePlugin(port, { token: TOKEN, sendHello: false });
    expect(await p.closed).toBe(4002);
  });

  it('round-trips a request', async () => {
    const { bridge, port } = await startBridge();
    const p = fakePlugin(port, {
      token: TOKEN,
      fileName: '제안서',
      onRequest: () => ({ result: { fileName: '제안서', currentPage: { id: '0:1', name: 'Page 1' } } }),
    });
    await p.welcomed;
    const r = await bridge.call('getStatus', {});
    expect(r.result.currentPage.name).toBe('Page 1');
    expect(r.session.fileName).toBe('제안서');
    expect(p.received[0]?.method).toBe('getStatus');
  });

  it('collects binaries from the plugin in part order', async () => {
    const { bridge, port } = await startBridge();
    const p = fakePlugin(port, {
      token: TOKEN,
      onRequest: () => ({ result: { pages: 2 }, binaries: [new Uint8Array([1]), new Uint8Array([2, 2])] }),
    });
    await p.welcomed;
    const r = await bridge.call('exportPdf', { ids: ['1:1', '1:2'] });
    expect(r.binaries.map((b) => [...b])).toEqual([[1], [2, 2]]);
  });

  it('sends binaries to the plugin before the request', async () => {
    const { bridge, port } = await startBridge();
    const p = fakePlugin(port, { token: TOKEN, onRequest: () => ({ result: { nodeIds: [], warnings: [] } }) });
    await p.welcomed;
    await bridge.call(
      'fillTemplate',
      { templateId: '1:1', rows: [], layout: 'grid' },
      { binaries: [new Uint8Array([7]), new Uint8Array([8])] },
    );
    expect(p.received[0]?.binaries.map((b) => [...b])).toEqual([[7], [8]]);
  });

  it('turns an error response into a ToolError', async () => {
    const { bridge, port } = await startBridge();
    const p = fakePlugin(port, {
      token: TOKEN,
      onRequest: () => ({ error: { code: 'NODE_NOT_FOUND', message: '없음', hint: 'h' } }),
    });
    await p.welcomed;
    const err = await bridge.call('getNode', { id: '9:9', depth: 1 }).catch((e) => e as ToolError);
    expect(err).toBeInstanceOf(ToolError);
    expect(err).toMatchObject({ code: 'NODE_NOT_FOUND', message: '없음', hint: 'h' });
  });

  it('times out', async () => {
    const { bridge, port } = await startBridge();
    const p = fakePlugin(port, { token: TOKEN, onRequest: () => ({ silent: true }) });
    await p.welcomed;
    expect(await codeOf(bridge.call('getStatus', {}, { timeoutMs: 50 }))).toBe('TIMEOUT');
  });

  it('rejects pending calls when the plugin disconnects', async () => {
    const { bridge, port } = await startBridge();
    const p = fakePlugin(port, {
      token: TOKEN,
      onRequest: () => {
        setTimeout(() => p.ws.close(), 10);
        return { silent: true };
      },
    });
    await p.welcomed;
    expect(await codeOf(bridge.call('getStatus', {}))).toBe('NOT_CONNECTED');
    expect(bridge.sessions()).toEqual([]);
  });

  it('fails with NOT_CONNECTED when no plugin is connected or the session is unknown', async () => {
    const { bridge, port } = await startBridge();
    expect(await codeOf(bridge.call('getStatus', {}))).toBe('NOT_CONNECTED');
    const p = fakePlugin(port, { token: TOKEN });
    await p.welcomed;
    expect(await codeOf(bridge.call('getStatus', {}, { sessionId: 'nope' }))).toBe('NOT_CONNECTED');
  });

  it('defaults to the most recent session and honours sessionId', async () => {
    const { bridge, port } = await startBridge();
    const a = fakePlugin(port, { token: TOKEN, sessionId: 'a', fileName: 'A', onRequest: () => ({ result: 'A' }) });
    await a.welcomed;
    await new Promise((r) => setTimeout(r, 5));
    const b = fakePlugin(port, { token: TOKEN, sessionId: 'b', fileName: 'B', onRequest: () => ({ result: 'B' }) });
    await b.welcomed;
    expect(bridge.sessions().map((s) => s.sessionId)).toEqual(['a', 'b']);
    expect((await bridge.call('execute', { code: '' })).result).toBe('B');
    expect((await bridge.call('execute', { code: '' }, { sessionId: 'a' })).result).toBe('A');
  });

  it('replaces a session that reconnects with the same id', async () => {
    const { bridge, port } = await startBridge();
    const first = fakePlugin(port, { token: TOKEN, sessionId: 'same' });
    await first.welcomed;
    const second = fakePlugin(port, { token: TOKEN, sessionId: 'same', onRequest: () => ({ result: 2 }) });
    await second.welcomed;
    await first.closed;
    expect(bridge.sessions().map((s) => s.sessionId)).toEqual(['same']);
    expect((await bridge.call('execute', { code: '' })).result).toBe(2);
  });

  it('reports PORT_IN_USE when the port is taken', async () => {
    const { port } = await startBridge();
    const second = new Bridge({ token: TOKEN });
    bridges.push(second);
    expect(await codeOf(second.start(port))).toBe('PORT_IN_USE');
    expect(second.portInUse).toBe(true);
    expect(await codeOf(second.call('getStatus', {}))).toBe('PORT_IN_USE');
  });
});
