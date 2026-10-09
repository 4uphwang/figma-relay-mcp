import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PORT } from '@figma-mcp/protocol';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { Bridge } from './bridge';
import { errorResult, toCallToolResult } from './result';
import { loadOrCreateToken } from './token';
import { buildTools } from './tools';

async function main() {
  const home = homedir();
  const token = await loadOrCreateToken(join(home, '.figma-mcp'));
  const bridge = new Bridge({ token });
  bridge
    .start(DEFAULT_PORT)
    .then((port) => console.error(`[figma-mcp] ws://127.0.0.1:${port} 대기 중`))
    .catch((e: Error) => console.error(`[figma-mcp] WebSocket 시작 실패: ${e.message}`));

  const server = new McpServer({ name: 'figma-mcp', version: '0.1.0' });
  const tools = buildTools({
    bridge,
    home,
    now: () => new Date(),
    loadImage: async () => {
      throw new Error('이미지 로드는 3단계에서 연결됩니다');
    },
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
