import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DEFAULT_PORT } from '@figma-relay-mcp/protocol';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { Hub } from './hub';
import { HubClient } from './hubClient';
import { loadImage } from './images';
import { errorResult, toCallToolResult } from './result';
import { loadOrCreateToken } from './token';
import { buildTools } from './tools';

declare const __BUILD__: number;
const BUILD = typeof __BUILD__ === 'number' ? __BUILD__ : 0;
const BIND_RETRY_MS = 3000;

// 허브: 포트를 잡고 Figma 플러그인과 붙는 백그라운드 프로세스. 스스로 꺼지지 않는다.
// --stay는 launchd(scripts/hub-agent.sh)가 띄운 허브다. 포트가 잡혀 있으면 비워질 때까지 기다렸다가 잡고,
// 재시작 요청에는 그냥 끝내서 launchd가 새 빌드로 다시 띄우게 한다.
// --stay가 없으면(Claude 세션이 띄운 허브) 재시작 요청에 새 허브를 직접 띄우고 끝낸다.
async function runHub(token: string, dir: string, stay: boolean) {
  const log = (line: string) => console.error(`[${new Date().toISOString()}] ${line}`);
  const hub = new Hub({
    token,
    build: BUILD,
    log,
    onExit: (reason) => {
      if (reason === 'restart' && !stay) spawnHub(dir);
      process.exit(0);
    },
  });
  let waiting = false;
  for (;;) {
    try {
      const port = await hub.start(DEFAULT_PORT);
      log(`허브 시작: ws://127.0.0.1:${port} (빌드 ${BUILD}, pid ${process.pid}${stay ? ', launchd' : ''})`);
      return;
    } catch (e) {
      if (!stay) {
        log(`허브 시작 실패: ${(e as Error).message}`); // 다른 허브가 먼저 떴다
        process.exit(0);
      }
      if (!waiting) log(`포트가 사용 중이라 비워질 때까지 기다립니다 (pid ${process.pid}, launchd)`);
      waiting = true;
      await new Promise((r) => setTimeout(r, BIND_RETRY_MS));
    }
  }
}

function spawnHub(dir: string) {
  const out = openSync(join(dir, 'hub.log'), 'a');
  const script = process.argv[1];
  if (!script) throw new Error('스크립트 경로를 알 수 없습니다');
  spawn(process.execPath, [script, '--hub'], { detached: true, stdio: ['ignore', out, out] }).unref();
}

async function runStdio(token: string, home: string, dir: string) {
  const bridge = new HubClient({
    token,
    label: basename(process.cwd()) || 'claude',
    build: BUILD,
    port: DEFAULT_PORT,
    spawnHub: () => spawnHub(dir),
  });

  const server = new McpServer({ name: 'figma-relay-mcp', version: '0.2.0' });
  const tools = buildTools({
    bridge,
    home,
    now: () => new Date(),
    loadImage,
  });
  for (const t of tools) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.inputSchema }, async (args: unknown) => {
      try {
        return toCallToolResult(await t.handler(args));
      } catch (e) {
        return errorResult(e);
      }
    });
  }
  await server.connect(new StdioServerTransport());
  // Figma 플러그인이 바로 붙을 수 있게 허브를 미리 띄워 둔다. 실패는 첫 도구 호출이 알린다.
  bridge.ready().catch((e: Error) => console.error(`[figma-relay-mcp] 허브 연결 실패: ${e.message}`));
}

async function main() {
  const home = homedir();
  const dir = join(home, '.figma-relay-mcp');
  const token = await loadOrCreateToken(dir);
  if (process.argv.includes('--hub')) await runHub(token, dir, process.argv.includes('--stay'));
  else await runStdio(token, home, dir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
