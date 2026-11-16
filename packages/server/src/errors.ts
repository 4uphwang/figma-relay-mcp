import type { ErrorCode } from '@figma-relay-mcp/protocol';

export const NOT_CONNECTED_HINT =
  'Figma 데스크톱 앱에서 메뉴 → Plugins → Development → figma-relay-mcp를 실행하세요. 처음 연결이면 ~/.figma-relay-mcp/token 내용을 플러그인 창에 붙여 넣으세요.';

export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}
