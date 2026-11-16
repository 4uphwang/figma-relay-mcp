# figma-relay-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code가 로컬 MCP 서버 → WebSocket → Figma 개발 플러그인을 통해 Figma를 읽고·쓰고, 프레임을 한 PDF로 내보내고, 템플릿을 JSON 행으로 일괄 생성한다. 무료 계정만으로.

**Architecture:** pnpm 워크스페이스 세 패키지. `protocol`(zod 메시지 스키마, 바이너리 프레임 코덱, 메서드 타입)을 `server`(MCP stdio + WebSocket 서버 + PDF 합치기·파일 저장·이미지 로드)와 `plugin`(UI iframe = WebSocket 클라이언트, main = figma API 실행)이 공유한다. 서버의 도구 함수는 `Bridge`에만 의존해 가짜 Bridge로 테스트하고, 플러그인은 figma에 의존하지 않는 `lib/`만 단위 테스트한다.

**Tech Stack:** Node 24, pnpm 10.25, TypeScript 6.0.3, zod 4.6.5, @modelcontextprotocol/server 2.3.1, ws 8.22.0, pdf-lib 1.17.1, esbuild 0.28.2, vitest 5.0.3, @figma/plugin-typings 1.141.0

**Spec:** `docs/superpowers/specs/2026-10-10-figma-relay-mcp-design.md`

## Global Constraints

- 무료(Starter) 계정만으로 동작. Dev Mode, Figma REST API, 개인 액세스 토큰을 쓰지 않는다.
- 플러그인 manifest: `editorType: ["figma"]`, `documentAccess: "dynamic-page"`. 노드 조회는 `figma.getNodeByIdAsync`만 쓴다(동기 `getNodeById` 금지).
- WebSocket: 서버는 `127.0.0.1`에만 바인딩, 포트 `38451`(`DEFAULT_PORT`). 연결 첫 메시지 `hello`의 토큰이 다르면 close code `4001`, 5초 안에 hello가 없으면 `4002`.
- 토큰 파일: `~/.figma-relay-mcp/token`(폴더 700, 파일 600). 없을 때만 만든다.
- 제한 시간: 기본 30초, `exportPdf`·`fillTemplate` 300초, `getStatus` 5초.
- 오류 코드(이것만): `NOT_CONNECTED`, `PORT_IN_USE`, `NODE_NOT_FOUND`, `FONT_MISSING`, `IMAGE_FAILED`, `TIMEOUT`, `EXEC_ERROR`, `INVALID_ARGS`, `IO_ERROR`. 도구 실패 응답은 `{code, message, hint?}` JSON, `isError: true`.
- PDF 기본 경로 `~/Downloads/<파일이름>-<YYYYMMDD-HHmmss>.pdf`(로컬 시각). 기존 파일은 덮어쓰지 않고 `-2`, `-3`…
- 템플릿 키: 레이어 이름이 정확히 `{{키}}`. 배치 간격 40px, 한 줄 5개. 복제본 이름 `<템플릿 이름> / <행 번호(1부터)>`. `page` 배치는 새 페이지 `<템플릿 이름> 생성`.
- 사용자에게 보이는 문구(오류 message·hint, 플러그인 UI)는 한국어.
- 실제 Figma 확인은 사용자의 무료 계정 데스크톱 앱에서 한다. `claude mcp add`처럼 사용자 설정을 바꾸는 명령은 실행 전에 사용자에게 묻는다.

---

## File Structure

```
figma-relay-mcp/
  package.json                 루트 스크립트(build/test/typecheck/check), 공용 devDeps
  pnpm-workspace.yaml
  tsconfig.base.json
  .gitignore
  README.md                    (Task 13)
  spike/                       Task 1 실험용(버리는 코드, 결과는 docs/spike-results.md)
    manifest.json  code.js  ui.html  server.mjs
  docs/spike-results.md
  packages/protocol/
    package.json  tsconfig.json
    src/index.ts               재수출
    src/constants.ts           DEFAULT_PORT
    src/errors.ts              ERROR_CODES, ErrorCode, WireError
    src/messages.ts            hello/welcome/request/response zod 스키마
    src/frame.ts               바이너리 프레임 encode/decode
    src/methods.ts             MethodMap(메서드별 params/result 타입), NodeSummary, CellValue, TemplateWarning
    test/messages.test.ts  test/frame.test.ts
  packages/server/
    package.json  tsconfig.json  build.mjs
    src/index.ts               MCP 서버 조립(main)
    src/errors.ts              ToolError, NOT_CONNECTED_HINT
    src/token.ts               loadOrCreateToken
    src/paths.ts               expandPath, defaultPdfPath, uniquePath
    src/bridge.ts              Bridge(WebSocket 서버, 세션, 요청/응답 짝짓기)
    src/result.ts              toCallToolResult, errorResult
    src/tools.ts               buildTools(도구 정의 전부), exportPdfToFile
    src/pdf.ts                 mergePdfs
    src/images.ts              looksLikeImage, loadImage, resolveImages
    test/fakePlugin.ts         테스트용 가짜 플러그인(ws 클라이언트)
    test/*.test.ts
  packages/plugin/
    package.json  tsconfig.json  tsconfig.ui.json  build.mjs  manifest.json
    src/code.ts                main 진입점: UI 메시지 → handler 디스패치
    src/bridgeTypes.ts         UI↔main 메시지, Handler 타입
    src/handlers/index.ts      handlers 표
    src/handlers/read.ts       getStatus, getSelection, getNode, findNodes, screenshot, requireNode
    src/handlers/execute.ts
    src/handlers/exportPdf.ts
    src/handlers/template.ts   fillTemplate
    src/lib/errors.ts          PluginError, toWireError
    src/lib/summarize.ts       노드 요약(깊이·개수 상한)
    src/lib/serialize.ts       toJsonSafe(execute 반환값)
    src/lib/backoff.ts         nextDelay
    src/lib/layout.ts          gridPosition, GAP, COLUMNS
    src/lib/template.ts        keyOf, planCell, unknownKeys
    src/ui/ui.html  src/ui/main.ts
    test/*.test.ts
```

---

## 1단계: 토대

### Task 1: 워크스페이스 뼈대 + 위험 확인 실험

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`
- Create: `spike/manifest.json`, `spike/code.js`, `spike/ui.html`, `spike/server.mjs`
- Create: `docs/spike-results.md`

**Interfaces:**
- Consumes: 없음
- Produces: 루트 스크립트 `pnpm build|test|typecheck|check`, 공용 devDeps(typescript, vitest, esbuild, @types/node, ws). `docs/spike-results.md`의 결론: execute가 쓸 방식(`new Function` / `eval` / 둘 다 불가), WebSocket 주소(`ws://127.0.0.1:38451` / `ws://localhost:38451`).

- [ ] **Step 1: 루트 파일 작성**

`package.json`:
```json
{
  "name": "figma-relay-mcp",
  "private": true,
  "packageManager": "pnpm@10.25.0",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "check": "pnpm typecheck && pnpm test && pnpm build"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "esbuild": "0.28.2",
    "typescript": "6.0.3",
    "vitest": "5.0.3",
    "ws": "8.22.0"
  },
  "pnpm": { "onlyBuiltDependencies": ["esbuild"] }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  }
}
```

`.gitignore`:
```
node_modules/
dist/
*.log
```

- [ ] **Step 2: 실험 플러그인 작성**

`spike/manifest.json`:
```json
{
  "name": "figma-relay-mcp spike",
  "id": "figma-relay-mcp-spike",
  "api": "1.0.0",
  "main": "code.js",
  "ui": "ui.html",
  "editorType": ["figma"],
  "documentAccess": "dynamic-page",
  "networkAccess": {
    "allowedDomains": ["none"],
    "devAllowedDomains": ["ws://127.0.0.1:38451", "ws://localhost:38451"]
  }
}
```

`spike/code.js`:
```js
figma.showUI(__html__, { width: 360, height: 260 });
(async () => {
  const r = {};
  try {
    r.newFunction = await new Function('figma', 'return (async () => figma.root.name)()')(figma);
  } catch (e) { r.newFunction = 'ERR ' + e; }
  try { r.eval = (0, eval)('1 + 1'); } catch (e) { r.eval = 'ERR ' + e; }
  try {
    const f = figma.createFrame();
    f.resize(200, 100);
    f.name = 'spike';
    const bytes = await f.exportAsync({ format: 'PDF' });
    r.pdfBytes = bytes.length;
    r.pdfHead = String.fromCharCode(...bytes.slice(0, 5));
    f.remove();
  } catch (e) { r.pdf = 'ERR ' + e; }
  figma.ui.postMessage({ type: 'results', r });
})();
```

`spike/ui.html`:
```html
<!doctype html>
<html><body style="font:12px monospace">
<script>
const out = (s) => document.body.insertAdjacentHTML('beforeend', '<pre>' + s + '</pre>');
onmessage = (e) => {
  const m = e.data.pluginMessage;
  if (!m || m.type !== 'results') return;
  out(JSON.stringify(m.r, null, 1));
  for (const url of ['ws://127.0.0.1:38451', 'ws://localhost:38451']) {
    try {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        ws.send(JSON.stringify({ url, ...m.r }));
        ws.send(new Uint8Array([1, 2, 3]));
        out('open ' + url);
      };
      ws.onerror = () => out('error ' + url);
    } catch (err) { out('throw ' + url + ' ' + err); }
  }
};
</script>
</body></html>
```

`spike/server.mjs`:
```js
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ host: '127.0.0.1', port: 38451 });
wss.on('listening', () => console.log('listening ws://127.0.0.1:38451'));
wss.on('connection', (ws) => {
  ws.on('message', (data, isBinary) => {
    console.log(isBinary ? `binary ${data.length} bytes` : `text ${data.toString()}`);
  });
});
```

- [ ] **Step 3: 의존성 설치**

Run: `pnpm install`
Expected: 오류 없이 끝나고 `node_modules/ws`가 생긴다.

- [ ] **Step 4: 실험 실행 (사용자와 함께)**

1. Run (백그라운드): `node spike/server.mjs` → `listening ws://127.0.0.1:38451`
2. 사용자에게 요청: Figma 데스크톱 앱(무료 계정)에서 아무 디자인 파일을 열고 메뉴 → Plugins → Development → Import plugin from manifest… → `spike/manifest.json` 선택 → 플러그인 실행.
3. 플러그인 창의 JSON과 서버 로그를 받아 적는다.

성공 기준:
- `newFunction`이 파일 이름이거나 `eval`이 `2`
- `pdfBytes` > 0, `pdfHead` = `%PDF-`
- 서버 로그에 `text {...}`와 `binary 3 bytes`가 두 주소 중 하나 이상에서 찍힘

- [ ] **Step 5: 결과 기록**

`docs/spike-results.md`에 날짜, Figma 앱 버전, 계정 종류(무료), 위 항목별 결과 원문, 결론 세 줄을 쓴다:
```markdown
- execute 방식: new Function | eval | 불가
- WebSocket 주소: ws://127.0.0.1:38451 | ws://localhost:38451 | 불가
- PDF 내보내기: 가능 | 불가
```

**멈춤 규칙:** execute 방식이 "불가"이거나 WebSocket·PDF가 "불가"면 다음 Task로 가지 않고 사용자에게 결과를 보고한다(설계 재검토). `eval`만 되면 Task 6 Step 5의 대체 코드를 쓴다. `localhost`만 되면 Task 6의 `WS_URL`과 manifest를 `localhost`로 바꾼다.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json .gitignore spike docs/spike-results.md
git commit -m "chore: workspace scaffold and Figma feasibility spike"
```

---

### Task 2: protocol 패키지

**Files:**
- Create: `packages/protocol/package.json`, `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/{index,constants,errors,messages,frame,methods}.ts`
- Test: `packages/protocol/test/messages.test.ts`, `packages/protocol/test/frame.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces (`@figma-relay-mcp/protocol`에서 import):
  - `DEFAULT_PORT = 38451`
  - `ERROR_CODES`, `type ErrorCode`, `interface WireError { code: ErrorCode; message: string; hint?: string }`
  - `HelloSchema`, `WelcomeSchema`, `RequestSchema`, `ResponseSchema`, `PluginToServerSchema`, `ServerToPluginSchema`와 타입 `Hello`, `Request`, `Response`, `PluginToServer`, `ServerToPlugin`
  - `encodeFrame(header: BinaryHeader, payload: Uint8Array): Uint8Array`, `decodeFrame(data: Uint8Array): { header: BinaryHeader; payload: Uint8Array }`, `interface BinaryHeader { id: string; part: number }`
  - `MethodMap`, `type MethodName`, `NodeSummary`, `CellValue`, `TemplateRow`, `TemplateWarning`, `WarningCode`

- [ ] **Step 1: 패키지 파일**

`packages/protocol/package.json`:
```json
{
  "name": "@figma-relay-mcp/protocol",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json",
    "build": "echo 'protocol: source-only package'"
  },
  "dependencies": { "zod": "4.6.5" }
}
```

`packages/protocol/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022", "DOM"] },
  "include": ["src", "test"]
}
```
(DOM lib는 `TextEncoder`/`TextDecoder` 타입용. Node와 브라우저 모두 전역으로 있다.)

Run: `pnpm install`

- [ ] **Step 2: 실패하는 테스트 작성**

`packages/protocol/test/frame.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame } from '../src';

describe('binary frame', () => {
  it('round-trips header and payload', () => {
    const payload = new Uint8Array([0, 1, 2, 255]);
    const frame = encodeFrame({ id: 'req-1', part: 3 }, payload);
    const { header, payload: out } = decodeFrame(frame);
    expect(header).toEqual({ id: 'req-1', part: 3 });
    expect([...out]).toEqual([0, 1, 2, 255]);
  });

  it('decodes a frame that is a view into a larger buffer', () => {
    const frame = encodeFrame({ id: 'x', part: 0 }, new Uint8Array([9, 9]));
    const big = new Uint8Array(frame.length + 10);
    big.set(frame, 10);
    const { header, payload } = decodeFrame(big.subarray(10));
    expect(header.id).toBe('x');
    expect([...payload]).toEqual([9, 9]);
  });

  it('handles an empty payload', () => {
    const { payload } = decodeFrame(encodeFrame({ id: 'e', part: 0 }, new Uint8Array()));
    expect(payload.length).toBe(0);
  });

  it('rejects a malformed header', () => {
    const head = new TextEncoder().encode('{"id":1}');
    const bad = new Uint8Array(4 + head.length);
    new DataView(bad.buffer).setUint32(0, head.length);
    bad.set(head, 4);
    expect(() => decodeFrame(bad)).toThrow();
  });
});
```

`packages/protocol/test/messages.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { PluginToServerSchema, ServerToPluginSchema } from '../src';

describe('messages', () => {
  it('parses hello', () => {
    const m = PluginToServerSchema.parse({ type: 'hello', token: 't', sessionId: 's', fileName: 'f' });
    expect(m.type).toBe('hello');
  });

  it('parses ok and error responses', () => {
    const ok = PluginToServerSchema.parse({ type: 'response', id: '1', ok: true, result: { a: 1 } });
    expect(ok).toMatchObject({ ok: true, result: { a: 1 } });
    const err = PluginToServerSchema.parse({
      type: 'response', id: '1', ok: false, error: { code: 'NODE_NOT_FOUND', message: 'x' },
    });
    expect(err).toMatchObject({ ok: false, error: { code: 'NODE_NOT_FOUND' } });
  });

  it('rejects unknown error codes', () => {
    expect(() =>
      PluginToServerSchema.parse({ type: 'response', id: '1', ok: false, error: { code: 'NOPE', message: 'x' } }),
    ).toThrow();
  });

  it('parses welcome and request', () => {
    expect(ServerToPluginSchema.parse({ type: 'welcome' }).type).toBe('welcome');
    const r = ServerToPluginSchema.parse({ type: 'request', id: '1', method: 'getStatus', params: {} });
    expect(r).toMatchObject({ method: 'getStatus' });
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `pnpm --filter @figma-relay-mcp/protocol test`
Expected: FAIL — `../src`를 찾을 수 없음

- [ ] **Step 4: 구현**

`packages/protocol/src/constants.ts`:
```ts
export const DEFAULT_PORT = 38451;
```

`packages/protocol/src/errors.ts`:
```ts
export const ERROR_CODES = [
  'NOT_CONNECTED',
  'PORT_IN_USE',
  'NODE_NOT_FOUND',
  'FONT_MISSING',
  'IMAGE_FAILED',
  'TIMEOUT',
  'EXEC_ERROR',
  'INVALID_ARGS',
  'IO_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface WireError {
  code: ErrorCode;
  message: string;
  hint?: string;
}
```

`packages/protocol/src/messages.ts`:
```ts
import { z } from 'zod';
import { ERROR_CODES } from './errors';

export const WireErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  hint: z.string().optional(),
});

export const HelloSchema = z.object({
  type: z.literal('hello'),
  token: z.string(),
  sessionId: z.string(),
  fileName: z.string(),
});

export const WelcomeSchema = z.object({ type: z.literal('welcome') });

export const RequestSchema = z.object({
  type: z.literal('request'),
  id: z.string(),
  method: z.string(),
  params: z.unknown(),
});

export const ResponseSchema = z.union([
  z.object({ type: z.literal('response'), id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ type: z.literal('response'), id: z.string(), ok: z.literal(false), error: WireErrorSchema }),
]);

export const PluginToServerSchema = z.union([HelloSchema, ResponseSchema]);
export const ServerToPluginSchema = z.union([WelcomeSchema, RequestSchema]);

export type Hello = z.infer<typeof HelloSchema>;
export type Request = z.infer<typeof RequestSchema>;
export type Response = z.infer<typeof ResponseSchema>;
export type PluginToServer = z.infer<typeof PluginToServerSchema>;
export type ServerToPlugin = z.infer<typeof ServerToPluginSchema>;
```

`packages/protocol/src/frame.ts`:
```ts
import { z } from 'zod';

const BinaryHeaderSchema = z.object({ id: z.string(), part: z.number().int().nonnegative() });
export type BinaryHeader = z.infer<typeof BinaryHeaderSchema>;

// 프레임 = [u32 BE 헤더 길이][헤더 JSON UTF-8][payload]
export function encodeFrame(header: BinaryHeader, payload: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + head.length + payload.length);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  out.set(payload, 4 + head.length);
  return out;
}

export function decodeFrame(data: Uint8Array): { header: BinaryHeader; payload: Uint8Array } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = view.getUint32(0);
  const header = BinaryHeaderSchema.parse(JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + len))));
  return { header, payload: data.subarray(4 + len) };
}
```

`packages/protocol/src/methods.ts`:
```ts
export interface NodeSummary {
  id: string;
  name: string;
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  characters?: string;
  layout?: { mode: string; itemSpacing: number; padding: [number, number, number, number] };
  childCount?: number;
  children?: NodeSummary[];
}

// 템플릿 셀: 서버가 이미지로 보이는 값을 asset(바이너리 순번)이나 imageError로 바꿔 보낸다.
export type CellValue =
  | string
  | number
  | boolean
  | null
  | { asset: number; src: string }
  | { imageError: string; src: string };

export type TemplateRow = Record<string, CellValue>;

export type WarningCode = 'MISSING_VALUE' | 'UNKNOWN_KEY' | 'FONT_MISSING' | 'IMAGE_FAILED' | 'NOT_FILLABLE';

export interface TemplateWarning {
  row: number; // 1부터
  key: string;
  code: WarningCode;
  detail?: string;
}

// 바이너리: screenshot 결과 PNG 1개(part 0), exportPdf 결과 노드별 PDF(part = ids 순번),
// fillTemplate 요청의 이미지(part = asset 번호).
export interface MethodMap {
  getStatus: { params: Record<string, never>; result: { fileName: string; currentPage: { id: string; name: string } } };
  getSelection: { params: Record<string, never>; result: NodeSummary[] };
  getNode: { params: { id: string; depth: number }; result: { node: NodeSummary; truncated: boolean } };
  findNodes: {
    params: { query: string; type?: string; pageId?: string };
    result: { nodes: NodeSummary[]; truncated: boolean };
  };
  screenshot: { params: { id: string; scale: number }; result: { width: number; height: number; scale: number } };
  execute: { params: { code: string }; result: unknown };
  exportPdf: { params: { ids: string[] }; result: { pages: number } };
  fillTemplate: {
    params: { templateId: string; rows: TemplateRow[]; layout: 'grid' | 'page' };
    result: { nodeIds: string[]; warnings: TemplateWarning[] };
  };
}

export type MethodName = keyof MethodMap;
```

`packages/protocol/src/index.ts`:
```ts
export * from './constants';
export * from './errors';
export * from './messages';
export * from './frame';
export * from './methods';
```

- [ ] **Step 5: 테스트·타입 검사 통과 확인**

Run: `pnpm --filter @figma-relay-mcp/protocol test && pnpm --filter @figma-relay-mcp/protocol typecheck`
Expected: 8 tests PASS, tsc 오류 없음

- [ ] **Step 6: Commit**

```bash
git add packages/protocol pnpm-lock.yaml
git commit -m "feat(protocol): message schemas, binary frames, method types"
```

---

### Task 3: server 기초 — 오류·토큰·경로

**Files:**
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`
- Create: `packages/server/src/errors.ts`, `packages/server/src/token.ts`, `packages/server/src/paths.ts`
- Test: `packages/server/test/token.test.ts`, `packages/server/test/paths.test.ts`

**Interfaces:**
- Consumes: `ErrorCode` (protocol)
- Produces:
  - `class ToolError extends Error { readonly code: ErrorCode; readonly hint?: string; constructor(code, message, hint?) }`
  - `NOT_CONNECTED_HINT: string`
  - `loadOrCreateToken(dir: string): Promise<string>`
  - `expandPath(p: string, home: string): string` (절대 경로가 아니면 `ToolError('INVALID_ARGS')`)
  - `defaultPdfPath(fileName: string, now: Date, home: string): string`
  - `uniquePath(path: string): Promise<string>`

- [ ] **Step 1: 패키지 파일**

`packages/server/package.json`:
```json
{
  "name": "@figma-relay-mcp/server",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json",
    "build": "node build.mjs"
  },
  "dependencies": {
    "@figma-relay-mcp/protocol": "workspace:*",
    "@modelcontextprotocol/server": "2.3.1",
    "pdf-lib": "1.17.1",
    "ws": "8.22.0",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@types/ws": "8.18.2"
  }
}
```

`packages/server/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022", "DOM"], "types": ["node"] },
  "include": ["src", "test"]
}
```

Run: `pnpm install`

- [ ] **Step 2: 실패하는 테스트 작성**

`packages/server/test/token.test.ts`:
```ts
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
```

`packages/server/test/paths.test.ts`:
```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/errors';
import { defaultPdfPath, expandPath, uniquePath } from '../src/paths';

describe('expandPath', () => {
  it('expands ~', () => {
    expect(expandPath('~/a/b.pdf', '/Users/me')).toBe('/Users/me/a/b.pdf');
    expect(expandPath('~', '/Users/me')).toBe('/Users/me');
  });
  it('keeps absolute paths', () => {
    expect(expandPath('/tmp/x.pdf', '/Users/me')).toBe('/tmp/x.pdf');
  });
  it('rejects relative paths', () => {
    expect(() => expandPath('x.pdf', '/Users/me')).toThrow(ToolError);
    try { expandPath('x.pdf', '/Users/me'); } catch (e) { expect((e as ToolError).code).toBe('INVALID_ARGS'); }
  });
});

describe('defaultPdfPath', () => {
  it('uses Downloads, the file name and a local timestamp', () => {
    const now = new Date(2026, 9, 10, 9, 5, 7);
    expect(defaultPdfPath('제안서', now, '/Users/me')).toBe('/Users/me/Downloads/제안서-20261010-090507.pdf');
  });
  it('replaces characters that are unsafe in file names', () => {
    const now = new Date(2026, 0, 1, 0, 0, 0);
    expect(defaultPdfPath('a/b:c', now, '/h')).toBe('/h/Downloads/a_b_c-20260101-000000.pdf');
    expect(defaultPdfPath('  ', now, '/h')).toBe('/h/Downloads/figma-20260101-000000.pdf');
  });
});

describe('uniquePath', () => {
  it('returns the path when free, otherwise appends -2, -3', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fmcp-'));
    const p = join(dir, 'out.pdf');
    expect(await uniquePath(p)).toBe(p);
    await writeFile(p, '');
    expect(await uniquePath(p)).toBe(join(dir, 'out-2.pdf'));
    await writeFile(join(dir, 'out-2.pdf'), '');
    expect(await uniquePath(p)).toBe(join(dir, 'out-3.pdf'));
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `pnpm --filter @figma-relay-mcp/server test`
Expected: FAIL — 모듈 없음

- [ ] **Step 4: 구현**

`packages/server/src/errors.ts`:
```ts
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
```

`packages/server/src/token.ts`:
```ts
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
```

`packages/server/src/paths.ts`:
```ts
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
```

- [ ] **Step 5: 통과 확인**

Run: `pnpm --filter @figma-relay-mcp/server test && pnpm --filter @figma-relay-mcp/server typecheck`
Expected: 9 tests PASS, tsc 오류 없음

- [ ] **Step 6: Commit**

```bash
git add packages/server pnpm-lock.yaml
git commit -m "feat(server): tool errors, token file, pdf path helpers"
```

---

### Task 4: server Bridge (WebSocket 세션, 요청·응답)

**Files:**
- Create: `packages/server/src/bridge.ts`
- Create: `packages/server/test/fakePlugin.ts`
- Test: `packages/server/test/bridge.test.ts`

**Interfaces:**
- Consumes: protocol의 `PluginToServerSchema`, `encodeFrame`, `decodeFrame`, `MethodMap`, `MethodName`; `ToolError`, `NOT_CONNECTED_HINT`
- Produces:
  ```ts
  interface SessionInfo { sessionId: string; fileName: string; connectedAt: number }
  interface CallOptions { sessionId?: string; timeoutMs?: number; binaries?: Uint8Array[] }
  interface CallResult<T> { result: T; binaries: Uint8Array[]; session: SessionInfo }
  class Bridge {
    constructor(opts: { token: string; helloTimeoutMs?: number })
    portInUse: boolean
    start(port: number, host?: string): Promise<number>   // 실제 포트
    stop(): Promise<void>
    sessions(): SessionInfo[]                             // 오래된 것부터
    call<M extends MethodName>(method: M, params: MethodMap[M]['params'], opts?: CallOptions): Promise<CallResult<MethodMap[M]['result']>>
  }
  ```
  `fakePlugin(port, opts)` 테스트 도우미(아래).

- [ ] **Step 1: 가짜 플러그인 도우미 작성**

`packages/server/test/fakePlugin.ts`:
```ts
import { decodeFrame, encodeFrame, type WireError } from '@figma-relay-mcp/protocol';
import WebSocket from 'ws';

export interface FakeReply {
  result?: unknown;
  error?: WireError;
  binaries?: Uint8Array[];
  silent?: boolean; // 응답하지 않음
}

export interface FakePlugin {
  ws: WebSocket;
  received: { method: string; params: unknown; binaries: Uint8Array[] }[];
  closed: Promise<number>; // close code
  welcomed: Promise<void>;
}

export function fakePlugin(
  port: number,
  opts: {
    token: string;
    sessionId?: string;
    fileName?: string;
    sendHello?: boolean;
    onRequest?: (method: string, params: unknown, binaries: Uint8Array[]) => FakeReply;
  },
): FakePlugin {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const received: FakePlugin['received'] = [];
  const inbound = new Map<string, Uint8Array[]>();
  let welcome!: () => void;
  const welcomed = new Promise<void>((r) => (welcome = r));
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));

  ws.on('open', () => {
    if (opts.sendHello === false) return;
    ws.send(
      JSON.stringify({
        type: 'hello',
        token: opts.token,
        sessionId: opts.sessionId ?? 's1',
        fileName: opts.fileName ?? 'File',
      }),
    );
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const { header, payload } = decodeFrame(new Uint8Array(data as Buffer));
      const parts = inbound.get(header.id) ?? [];
      parts[header.part] = new Uint8Array(payload);
      inbound.set(header.id, parts);
      return;
    }
    const msg = JSON.parse(data.toString());
    if (msg.type === 'welcome') return welcome();
    const binaries = inbound.get(msg.id) ?? [];
    received.push({ method: msg.method, params: msg.params, binaries });
    const reply = opts.onRequest?.(msg.method, msg.params, binaries) ?? { result: null };
    if (reply.silent) return;
    (reply.binaries ?? []).forEach((b, part) => ws.send(encodeFrame({ id: msg.id, part }, b)));
    ws.send(
      JSON.stringify(
        reply.error
          ? { type: 'response', id: msg.id, ok: false, error: reply.error }
          : { type: 'response', id: msg.id, ok: true, result: reply.result },
      ),
    );
  });

  return { ws, received, closed, welcomed };
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`packages/server/test/bridge.test.ts`:
```ts
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
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm --filter @figma-relay-mcp/server test -- bridge`
Expected: FAIL — `../src/bridge` 없음

- [ ] **Step 4: 구현**

`packages/server/src/bridge.ts`:
```ts
import { randomUUID } from 'node:crypto';
import {
  PluginToServerSchema,
  decodeFrame,
  encodeFrame,
  type MethodMap,
  type MethodName,
} from '@figma-relay-mcp/protocol';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { NOT_CONNECTED_HINT, ToolError } from './errors';

export interface SessionInfo {
  sessionId: string;
  fileName: string;
  connectedAt: number;
}

export interface CallOptions {
  sessionId?: string;
  timeoutMs?: number;
  binaries?: Uint8Array[];
}

export interface CallResult<T> {
  result: T;
  binaries: Uint8Array[];
  session: SessionInfo;
}

interface Session extends SessionInfo {
  ws: WebSocket;
}

interface Pending {
  ws: WebSocket;
  parts: Uint8Array[];
  timer: NodeJS.Timeout;
  resolve: (r: { result: unknown; binaries: Uint8Array[] }) => void;
  reject: (e: Error) => void;
}

const portInUseError = (port: number | string) =>
  new ToolError(
    'PORT_IN_USE',
    `포트 ${port}를 다른 프로세스가 쓰고 있어 Figma와 연결할 수 없습니다`,
    '다른 Claude 세션의 figma-relay-mcp를 닫고 이 세션을 다시 시작하세요',
  );

export class Bridge {
  portInUse = false;
  private wss?: WebSocketServer;
  private port: number | string = '?';
  private live = new Map<string, Session>();
  private pending = new Map<string, Pending>();

  constructor(private readonly opts: { token: string; helloTimeoutMs?: number }) {}

  start(port: number, host = '127.0.0.1'): Promise<number> {
    this.port = port;
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port, host, maxPayload: 256 * 1024 * 1024 });
      wss.once('listening', () => {
        this.wss = wss;
        const addr = wss.address();
        this.port = typeof addr === 'object' && addr ? addr.port : port;
        resolve(this.port as number);
      });
      wss.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE') {
          this.portInUse = true;
          reject(portInUseError(port));
        } else {
          reject(e);
        }
      });
      wss.on('connection', (ws) => this.accept(ws));
    });
  }

  async stop(): Promise<void> {
    for (const s of this.live.values()) s.ws.terminate();
    const wss = this.wss;
    if (wss) await new Promise<void>((r) => wss.close(() => r()));
  }

  sessions(): SessionInfo[] {
    return [...this.live.values()]
      .sort((a, b) => a.connectedAt - b.connectedAt)
      .map(({ sessionId, fileName, connectedAt }) => ({ sessionId, fileName, connectedAt }));
  }

  async call<M extends MethodName>(
    method: M,
    params: MethodMap[M]['params'],
    opts: CallOptions = {},
  ): Promise<CallResult<MethodMap[M]['result']>> {
    if (this.portInUse) throw portInUseError(this.port);
    const session = this.pick(opts.sessionId);
    const id = randomUUID();
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const done = new Promise<{ result: unknown; binaries: Uint8Array[] }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ToolError(
            'TIMEOUT',
            `${method} 응답이 ${Math.round(timeoutMs / 1000)}초 안에 오지 않았습니다`,
            'Figma가 바쁘거나 멈췄을 수 있습니다. 작업 크기를 줄여 다시 시도하세요',
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { ws: session.ws, parts: [], timer, resolve, reject });
    });
    (opts.binaries ?? []).forEach((b, part) => session.ws.send(encodeFrame({ id, part }, b)));
    session.ws.send(JSON.stringify({ type: 'request', id, method, params }));
    const { result, binaries } = await done;
    return {
      result: result as MethodMap[M]['result'],
      binaries,
      session: { sessionId: session.sessionId, fileName: session.fileName, connectedAt: session.connectedAt },
    };
  }

  private pick(sessionId?: string): Session {
    if (sessionId) {
      const s = this.live.get(sessionId);
      if (!s) throw new ToolError('NOT_CONNECTED', `연결된 세션이 아닙니다: ${sessionId}`, 'list_files로 세션을 확인하세요');
      return s;
    }
    const all = [...this.live.values()].sort((a, b) => b.connectedAt - a.connectedAt);
    const latest = all[0];
    if (!latest) throw new ToolError('NOT_CONNECTED', '연결된 Figma 플러그인이 없습니다', NOT_CONNECTED_HINT);
    return latest;
  }

  private accept(ws: WebSocket) {
    let sessionId: string | undefined;
    const helloTimer = setTimeout(() => ws.close(4002, 'hello timeout'), this.opts.helloTimeoutMs ?? 5000);

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        if (!sessionId) return;
        const { header, payload } = decodeFrame(toBytes(data));
        const p = this.pending.get(header.id);
        if (p && p.ws === ws) p.parts[header.part] = payload;
        return;
      }
      let parsed;
      try {
        parsed = PluginToServerSchema.safeParse(JSON.parse(data.toString()));
      } catch {
        return;
      }
      if (!parsed.success) return;
      const msg = parsed.data;

      if (msg.type === 'hello') {
        clearTimeout(helloTimer);
        if (msg.token !== this.opts.token) {
          ws.close(4001, 'bad token');
          return;
        }
        sessionId = msg.sessionId;
        const previous = this.live.get(sessionId);
        this.live.set(sessionId, { sessionId, fileName: msg.fileName, connectedAt: Date.now(), ws });
        previous?.ws.close(4003, 'replaced');
        ws.send(JSON.stringify({ type: 'welcome' }));
        return;
      }

      if (!sessionId) return;
      const p = this.pending.get(msg.id);
      if (!p || p.ws !== ws) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve({ result: msg.result, binaries: p.parts });
      else p.reject(new ToolError(msg.error.code, msg.error.message, msg.error.hint));
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (sessionId && this.live.get(sessionId)?.ws === ws) this.live.delete(sessionId);
      for (const [id, p] of this.pending) {
        if (p.ws !== ws) continue;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new ToolError('NOT_CONNECTED', 'Figma 플러그인 연결이 끊겼습니다', NOT_CONNECTED_HINT));
      }
    });
  }
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
```

- [ ] **Step 5: 통과 확인**

Run: `pnpm --filter @figma-relay-mcp/server test && pnpm --filter @figma-relay-mcp/server typecheck`
Expected: 모든 테스트 PASS(bridge 12개 포함), tsc 오류 없음

- [ ] **Step 6: Commit**

```bash
git add packages/server
git commit -m "feat(server): WebSocket bridge with sessions, binaries, timeouts"
```

---

### Task 5: plugin 순수 모듈 — 오류·요약·직렬화·재연결 간격

**Files:**
- Create: `packages/plugin/package.json`, `packages/plugin/tsconfig.json`, `packages/plugin/tsconfig.ui.json`
- Create: `packages/plugin/src/lib/errors.ts`, `src/lib/summarize.ts`, `src/lib/serialize.ts`, `src/lib/backoff.ts`
- Test: `packages/plugin/test/errors.test.ts`, `test/summarize.test.ts`, `test/serialize.test.ts`, `test/backoff.test.ts`

**Interfaces:**
- Consumes: protocol의 `ErrorCode`, `WireError`, `NodeSummary`
- Produces:
  - `class PluginError extends Error { code: ErrorCode; hint?: string; constructor(code, message, hint?) }`
  - `toWireError(e: unknown): WireError` (PluginError면 그대로, 아니면 `EXEC_ERROR` + 메시지·스택)
  - `interface SummarizableNode`, `summarize(root: SummarizableNode, depth: number, limit?: number): { node: NodeSummary; truncated: boolean }` (limit 기본 500)
  - `toJsonSafe(value: unknown): unknown`
  - `nextDelay(attempt: number): number` (ms)

`src/lib/`는 `figma` 전역을 쓰지 않는다(테스트 가능해야 함).

- [ ] **Step 1: 패키지 파일**

`packages/plugin/package.json`:
```json
{
  "name": "@figma-relay-mcp/plugin",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json && tsc -p tsconfig.ui.json",
    "build": "node build.mjs"
  },
  "dependencies": {
    "@figma-relay-mcp/protocol": "workspace:*",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@figma/plugin-typings": "1.141.0"
  }
}
```

`packages/plugin/tsconfig.json` (main 쪽 — figma 전역 있음, DOM 없음):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "types": ["@figma/plugin-typings"]
  },
  "include": ["src/code.ts", "src/bridgeTypes.ts", "src/handlers", "src/lib"]
}
```

`packages/plugin/tsconfig.ui.json` (UI·테스트 쪽 — DOM 있음, figma 없음):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022", "DOM"], "types": [] },
  "include": ["src/ui", "src/lib", "test"]
}
```

Run: `pnpm install`

- [ ] **Step 2: 실패하는 테스트 작성**

`packages/plugin/test/errors.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { PluginError, toWireError } from '../src/lib/errors';

describe('toWireError', () => {
  it('keeps PluginError fields', () => {
    expect(toWireError(new PluginError('NODE_NOT_FOUND', '없음', '힌트'))).toEqual({
      code: 'NODE_NOT_FOUND', message: '없음', hint: '힌트',
    });
  });
  it('wraps other errors as EXEC_ERROR with the stack', () => {
    const w = toWireError(new TypeError('boom'));
    expect(w.code).toBe('EXEC_ERROR');
    expect(w.message).toContain('boom');
    expect(w.message).toContain('TypeError');
  });
  it('wraps non-errors', () => {
    expect(toWireError('nope')).toEqual({ code: 'EXEC_ERROR', message: 'nope' });
  });
});
```

`packages/plugin/test/summarize.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { summarize, type SummarizableNode } from '../src/lib/summarize';

const leaf = (id: string, extra: Partial<SummarizableNode> = {}): SummarizableNode => ({
  id, name: `n${id}`, type: 'RECTANGLE', x: 1, y: 2, width: 3, height: 4, ...extra,
});

describe('summarize', () => {
  it('copies geometry, text and auto layout', () => {
    const root: SummarizableNode = {
      ...leaf('1', { type: 'FRAME' }),
      layoutMode: 'VERTICAL', itemSpacing: 8, paddingTop: 1, paddingRight: 2, paddingBottom: 3, paddingLeft: 4,
      children: [leaf('2', { type: 'TEXT', characters: '안녕' })],
    };
    const { node, truncated } = summarize(root, 2);
    expect(truncated).toBe(false);
    expect(node).toEqual({
      id: '1', name: 'n1', type: 'FRAME', x: 1, y: 2, width: 3, height: 4,
      layout: { mode: 'VERTICAL', itemSpacing: 8, padding: [1, 2, 3, 4] },
      children: [{ id: '2', name: 'n2', type: 'TEXT', x: 1, y: 2, width: 3, height: 4, characters: '안녕' }],
    });
  });

  it('omits layout when layoutMode is NONE', () => {
    expect(summarize(leaf('1', { layoutMode: 'NONE' }), 1).node.layout).toBeUndefined();
  });

  it('stops at depth and reports childCount', () => {
    const root = { ...leaf('1'), children: [{ ...leaf('2'), children: [leaf('3')] }] };
    const { node } = summarize(root, 1);
    expect(node.children?.[0]?.children).toBeUndefined();
    expect(node.children?.[0]?.childCount).toBe(1);
    expect(summarize(root, 0).node).toMatchObject({ childCount: 1 });
  });

  it('truncates long text to 200 chars', () => {
    const { node } = summarize(leaf('1', { characters: 'a'.repeat(250) }), 0);
    expect(node.characters).toHaveLength(201);
    expect(node.characters?.endsWith('…')).toBe(true);
  });

  it('caps the total node count', () => {
    const root = { ...leaf('r'), children: Array.from({ length: 10 }, (_, i) => leaf(String(i))) };
    const { node, truncated } = summarize(root, 5, 4);
    expect(truncated).toBe(true);
    expect(node.children).toHaveLength(3);
    expect(node.childCount).toBe(10);
  });

  it('handles nodes without geometry (pages)', () => {
    const { node } = summarize({ id: '0:1', name: 'Page', type: 'PAGE', children: [] }, 1);
    expect(node).toEqual({ id: '0:1', name: 'Page', type: 'PAGE' });
  });
});
```

`packages/plugin/test/serialize.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { toJsonSafe } from '../src/lib/serialize';

const fakeNode = (id: string) => ({ id, name: `n${id}`, type: 'FRAME', remove() {}, secret: 'x' });

describe('toJsonSafe', () => {
  it('passes plain JSON through', () => {
    expect(toJsonSafe({ a: [1, 'b', null, true] })).toEqual({ a: [1, 'b', null, true] });
  });
  it('turns nodes into {id, name, type}, also nested', () => {
    expect(toJsonSafe(fakeNode('1'))).toEqual({ id: '1', name: 'n1', type: 'FRAME' });
    expect(toJsonSafe({ list: [fakeNode('2')] })).toEqual({ list: [{ id: '2', name: 'n2', type: 'FRAME' }] });
  });
  it('maps undefined to null', () => {
    expect(toJsonSafe(undefined)).toBeNull();
  });
});
```

`packages/plugin/test/backoff.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { nextDelay } from '../src/lib/backoff';

describe('nextDelay', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(nextDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm --filter @figma-relay-mcp/plugin test`
Expected: FAIL — 모듈 없음

- [ ] **Step 4: 구현**

`packages/plugin/src/lib/errors.ts`:
```ts
import type { ErrorCode, WireError } from '@figma-relay-mcp/protocol';

export class PluginError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'PluginError';
  }
}

export function toWireError(e: unknown): WireError {
  if (e instanceof PluginError) {
    return e.hint === undefined ? { code: e.code, message: e.message } : { code: e.code, message: e.message, hint: e.hint };
  }
  if (e instanceof Error) return { code: 'EXEC_ERROR', message: (e.stack ?? `${e.name}: ${e.message}`).trim() };
  return { code: 'EXEC_ERROR', message: String(e) };
}
```

`packages/plugin/src/lib/summarize.ts`:
```ts
import type { NodeSummary } from '@figma-relay-mcp/protocol';

export interface SummarizableNode {
  id: string;
  name: string;
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  characters?: string;
  layoutMode?: string;
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  children?: readonly SummarizableNode[];
}

const TEXT_LIMIT = 200;

export function summarize(
  root: SummarizableNode,
  depth: number,
  limit = 500,
): { node: NodeSummary; truncated: boolean } {
  let count = 0;
  let truncated = false;

  const visit = (n: SummarizableNode, d: number): NodeSummary => {
    count++;
    const s: NodeSummary = { id: n.id, name: n.name, type: n.type };
    if (typeof n.x === 'number' && typeof n.y === 'number') {
      s.x = n.x;
      s.y = n.y;
      s.width = n.width;
      s.height = n.height;
    }
    if (typeof n.characters === 'string') {
      s.characters = n.characters.length > TEXT_LIMIT ? n.characters.slice(0, TEXT_LIMIT) + '…' : n.characters;
    }
    if (n.layoutMode && n.layoutMode !== 'NONE') {
      s.layout = {
        mode: n.layoutMode,
        itemSpacing: n.itemSpacing ?? 0,
        padding: [n.paddingTop ?? 0, n.paddingRight ?? 0, n.paddingBottom ?? 0, n.paddingLeft ?? 0],
      };
    }
    const kids = n.children;
    if (kids && kids.length > 0) {
      if (d >= depth) {
        s.childCount = kids.length;
      } else {
        s.children = [];
        for (const k of kids) {
          if (count >= limit) {
            truncated = true;
            s.childCount = kids.length;
            break;
          }
          s.children.push(visit(k, d + 1));
        }
      }
    }
    return s;
  };

  return { node: visit(root, 0), truncated };
}
```

`packages/plugin/src/lib/serialize.ts`:
```ts
function isNodeLike(v: unknown): v is { id: string; name: string; type: string } {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.name === 'string' && typeof o.type === 'string' && typeof o.remove === 'function';
}

// execute 반환값을 JSON으로 보낼 수 있게 만든다. 노드는 {id, name, type}으로 줄인다.
export function toJsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  const text = JSON.stringify(value, (_key, v) => (isNodeLike(v) ? { id: v.id, name: v.name, type: v.type } : v));
  return text === undefined ? null : JSON.parse(text);
}
```

`packages/plugin/src/lib/backoff.ts`:
```ts
export function nextDelay(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt);
}
```

- [ ] **Step 5: 통과 확인**

Run: `pnpm --filter @figma-relay-mcp/plugin test && pnpm --filter @figma-relay-mcp/plugin exec tsc -p tsconfig.ui.json`
Expected: 13 tests PASS, tsc 오류 없음 (main 쪽 tsconfig는 Task 6에서 파일이 생긴 뒤 검사)

- [ ] **Step 6: Commit**

```bash
git add packages/plugin pnpm-lock.yaml
git commit -m "feat(plugin): pure helpers for errors, node summaries, serialization, backoff"
```

---

### Task 6: plugin 본체 — manifest, 빌드, UI 연결, 조회·execute handler

**Files:**
- Create: `packages/plugin/manifest.json`, `packages/plugin/build.mjs`
- Create: `packages/plugin/src/bridgeTypes.ts`, `src/code.ts`, `src/handlers/index.ts`, `src/handlers/read.ts`, `src/handlers/execute.ts`
- Create: `packages/plugin/src/ui/ui.html`, `packages/plugin/src/ui/main.ts`

**Interfaces:**
- Consumes: Task 2 protocol 전부, Task 5 `PluginError`, `toWireError`, `summarize`, `toJsonSafe`, `nextDelay`
- Produces:
  ```ts
  // bridgeTypes.ts
  interface HandlerContext { binaries: Uint8Array[]; sendBinary(part: number, bytes: Uint8Array): void }
  type Handler<M extends MethodName> = (params: MethodMap[M]['params'], ctx: HandlerContext) => Promise<MethodMap[M]['result']>
  type Handlers = { [M in MethodName]: Handler<M> }
  type MainToUi, UiToMain
  // handlers/read.ts
  requireNode(id: string): Promise<SceneNode>   // 없거나 PAGE/DOCUMENT면 PluginError('NODE_NOT_FOUND')
  ```
  `handlers/index.ts`의 `handlers: Partial<Handlers>` — 이후 Task가 항목을 추가한다.
  빌드 결과 `packages/plugin/dist/code.js`, `packages/plugin/dist/ui.html`.

- [ ] **Step 1: manifest와 빌드 스크립트**

`packages/plugin/manifest.json` (Task 1 결과가 `localhost`면 주소를 바꾼다):
```json
{
  "name": "figma-relay-mcp",
  "id": "figma-relay-mcp-local",
  "api": "1.0.0",
  "main": "dist/code.js",
  "ui": "dist/ui.html",
  "editorType": ["figma"],
  "documentAccess": "dynamic-page",
  "networkAccess": {
    "allowedDomains": ["none"],
    "devAllowedDomains": ["ws://127.0.0.1:38451"],
    "reasoning": "Claude Code에서 실행 중인 로컬 figma-relay-mcp 서버와만 통신합니다."
  }
}
```

`packages/plugin/build.mjs`:
```js
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });

await build({
  entryPoints: ['src/code.ts'],
  bundle: true,
  outfile: 'dist/code.js',
  format: 'iife',
  target: 'es2017',
  logLevel: 'warning',
});

const ui = await build({
  entryPoints: ['src/ui/main.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2020',
  logLevel: 'warning',
});
const script = ui.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = (await readFile('src/ui/ui.html', 'utf8')).replace('<!-- SCRIPT -->', () => `<script>${script}</script>`);
await writeFile('dist/ui.html', html);
console.log('plugin built → dist/code.js, dist/ui.html');
```

- [ ] **Step 2: UI↔main 타입과 handler**

`packages/plugin/src/bridgeTypes.ts`:
```ts
import type { MethodMap, MethodName, WireError } from '@figma-relay-mcp/protocol';

export type MainToUi =
  | { type: 'init'; token: string; fileName: string }
  | { type: 'binary'; id: string; part: number; bytes: Uint8Array }
  | { type: 'response'; id: string; ok: true; result: unknown }
  | { type: 'response'; id: string; ok: false; error: WireError };

export type UiToMain =
  | { type: 'saveToken'; token: string }
  | { type: 'request'; id: string; method: string; params: unknown; binaries: Uint8Array[] };

export interface HandlerContext {
  binaries: Uint8Array[];
  sendBinary(part: number, bytes: Uint8Array): void;
}

export type Handler<M extends MethodName> = (
  params: MethodMap[M]['params'],
  ctx: HandlerContext,
) => Promise<MethodMap[M]['result']>;

export type Handlers = { [M in MethodName]: Handler<M> };
```

`packages/plugin/src/handlers/read.ts`:
```ts
import type { Handler } from '../bridgeTypes';
import { PluginError } from '../lib/errors';
import { summarize, type SummarizableNode } from '../lib/summarize';

const MAX_FIND = 200;
const MAX_SCREENSHOT_SIDE = 2048;
const asSummarizable = (n: BaseNode) => n as unknown as SummarizableNode;

export async function requireNode(id: string): Promise<SceneNode> {
  const n = await figma.getNodeByIdAsync(id);
  if (!n || n.type === 'DOCUMENT' || n.type === 'PAGE') {
    throw new PluginError('NODE_NOT_FOUND', `노드가 없습니다: ${id}`, 'find_nodes나 get_selection으로 ID를 다시 확인하세요');
  }
  return n as SceneNode;
}

export const getStatus: Handler<'getStatus'> = async () => ({
  fileName: figma.root.name,
  currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
});

export const getSelection: Handler<'getSelection'> = async () =>
  figma.currentPage.selection.map((n) => summarize(asSummarizable(n), 0).node);

export const getNode: Handler<'getNode'> = async ({ id, depth }) => {
  const n = await figma.getNodeByIdAsync(id);
  if (!n) throw new PluginError('NODE_NOT_FOUND', `노드가 없습니다: ${id}`, 'find_nodes나 get_selection으로 ID를 다시 확인하세요');
  if (n.type === 'PAGE') await n.loadAsync();
  return summarize(asSummarizable(n), depth);
};

export const findNodes: Handler<'findNodes'> = async ({ query, type, pageId }) => {
  let re: RegExp;
  try {
    re = new RegExp(query, 'i');
  } catch {
    throw new PluginError('INVALID_ARGS', `정규식이 잘못됐습니다: ${query}`);
  }
  const page = pageId ? await figma.getNodeByIdAsync(pageId) : figma.currentPage;
  if (!page || page.type !== 'PAGE') throw new PluginError('NODE_NOT_FOUND', `페이지가 없습니다: ${pageId}`);
  await page.loadAsync();
  const found = page.findAll((n) => re.test(n.name) && (!type || n.type === type));
  return {
    nodes: found.slice(0, MAX_FIND).map((n) => summarize(asSummarizable(n), 0).node),
    truncated: found.length > MAX_FIND,
  };
};

export const screenshot: Handler<'screenshot'> = async ({ id, scale }, ctx) => {
  const n = await requireNode(id);
  const longest = Math.max(n.width, n.height, 1);
  const s = Math.min(scale, MAX_SCREENSHOT_SIDE / longest);
  const bytes = await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: s } });
  ctx.sendBinary(0, bytes);
  return { width: Math.round(n.width * s), height: Math.round(n.height * s), scale: s };
};
```

`packages/plugin/src/handlers/execute.ts`:
```ts
import type { Handler } from '../bridgeTypes';
import { PluginError } from '../lib/errors';
import { toJsonSafe } from '../lib/serialize';

type UserFn = (f: PluginAPI) => Promise<unknown>;

function compile(code: string): UserFn {
  try {
    return new Function('figma', `return (async () => {\n${code}\n})();`) as UserFn;
  } catch (e) {
    throw new PluginError('EXEC_ERROR', `코드 문법 오류: ${(e as Error).message}`);
  }
}

export const execute: Handler<'execute'> = async ({ code }) => {
  const fn = compile(code);
  figma.commitUndo();
  try {
    return toJsonSafe(await fn(figma));
  } catch (e) {
    const err = e as Error;
    throw new PluginError('EXEC_ERROR', `${err?.message ?? String(e)}\n${err?.stack ?? ''}`.trim());
  } finally {
    figma.commitUndo();
  }
};
```

`packages/plugin/src/handlers/index.ts`:
```ts
import type { Handlers } from '../bridgeTypes';
import { execute } from './execute';
import { findNodes, getNode, getSelection, getStatus, screenshot } from './read';

export const handlers: Partial<Handlers> = {
  getStatus,
  getSelection,
  getNode,
  findNodes,
  screenshot,
  execute,
};
```

`packages/plugin/src/code.ts`:
```ts
import type { MainToUi, UiToMain } from './bridgeTypes';
import { handlers } from './handlers';
import { PluginError, toWireError } from './lib/errors';

const TOKEN_KEY = 'figma-relay-mcp-token';
const post = (m: MainToUi) => figma.ui.postMessage(m);

figma.showUI(__html__, { width: 300, height: 150, themeColors: true });

void (async () => {
  const token = ((await figma.clientStorage.getAsync(TOKEN_KEY)) as string | undefined) ?? '';
  post({ type: 'init', token, fileName: figma.root.name });
})();

figma.ui.onmessage = async (msg: UiToMain) => {
  if (msg.type === 'saveToken') {
    await figma.clientStorage.setAsync(TOKEN_KEY, msg.token);
    return;
  }
  if (msg.type !== 'request') return;
  try {
    const handler = handlers[msg.method as keyof typeof handlers] as
      | ((params: unknown, ctx: { binaries: Uint8Array[]; sendBinary(part: number, bytes: Uint8Array): void }) => Promise<unknown>)
      | undefined;
    if (!handler) throw new PluginError('INVALID_ARGS', `알 수 없는 요청: ${msg.method}`);
    const result = await handler(msg.params, {
      binaries: msg.binaries,
      sendBinary: (part, bytes) => post({ type: 'binary', id: msg.id, part, bytes }),
    });
    post({ type: 'response', id: msg.id, ok: true, result });
  } catch (e) {
    post({ type: 'response', id: msg.id, ok: false, error: toWireError(e) });
  }
};
```

- [ ] **Step 3: UI**

`packages/plugin/src/ui/ui.html`:
```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font: 12px system-ui, sans-serif; margin: 12px; color: var(--figma-color-text); background: var(--figma-color-bg); }
      #status { margin-bottom: 10px; }
      #status[data-tone='ok'] { color: var(--figma-color-text-success); }
      #status[data-tone='bad'] { color: var(--figma-color-text-danger); }
      input { width: 100%; box-sizing: border-box; margin-bottom: 6px; padding: 4px; }
    </style>
  </head>
  <body>
    <div id="status" data-tone="wait">시작 중…</div>
    <input id="token" type="password" placeholder="~/.figma-relay-mcp/token 내용" />
    <button id="save">토큰 저장 후 연결</button>
    <!-- SCRIPT -->
  </body>
</html>
```

`packages/plugin/src/ui/main.ts` (Task 1 결과가 `localhost`면 `WS_URL`을 바꾼다):
```ts
import { DEFAULT_PORT, ServerToPluginSchema, decodeFrame, encodeFrame } from '@figma-relay-mcp/protocol';
import type { MainToUi, UiToMain } from '../bridgeTypes';
import { nextDelay } from '../lib/backoff';

const WS_URL = `ws://127.0.0.1:${DEFAULT_PORT}`;
const CLOSE_BAD_TOKEN = 4001;

const statusEl = document.getElementById('status') as HTMLDivElement;
const tokenEl = document.getElementById('token') as HTMLInputElement;
const saveEl = document.getElementById('save') as HTMLButtonElement;

const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
let token = '';
let fileName = '';
let ws: WebSocket | undefined;
let attempt = 0;
let retryTimer: number | undefined;
const inbound = new Map<string, Uint8Array[]>();

const toMain = (m: UiToMain) => parent.postMessage({ pluginMessage: m }, '*');

function setStatus(text: string, tone: 'ok' | 'wait' | 'bad') {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

function connect() {
  window.clearTimeout(retryTimer);
  if (!token) {
    setStatus('토큰을 붙여 넣으세요 (~/.figma-relay-mcp/token)', 'bad');
    return;
  }
  setStatus('연결 중…', 'wait');
  const sock = new WebSocket(WS_URL);
  sock.binaryType = 'arraybuffer';
  ws = sock;

  sock.onopen = () => sock.send(JSON.stringify({ type: 'hello', token, sessionId, fileName }));

  sock.onmessage = (ev: MessageEvent) => {
    if (ev.data instanceof ArrayBuffer) {
      const { header, payload } = decodeFrame(new Uint8Array(ev.data));
      const parts = inbound.get(header.id) ?? [];
      parts[header.part] = payload;
      inbound.set(header.id, parts);
      return;
    }
    const parsed = ServerToPluginSchema.safeParse(JSON.parse(String(ev.data)));
    if (!parsed.success) return;
    const msg = parsed.data;
    if (msg.type === 'welcome') {
      attempt = 0;
      setStatus(`연결됨 · ${fileName}`, 'ok');
      return;
    }
    const binaries = inbound.get(msg.id) ?? [];
    inbound.delete(msg.id);
    toMain({ type: 'request', id: msg.id, method: msg.method, params: msg.params, binaries });
  };

  sock.onclose = (ev: CloseEvent) => {
    if (ws !== sock) return;
    ws = undefined;
    if (ev.code === CLOSE_BAD_TOKEN) {
      setStatus('토큰이 틀립니다. ~/.figma-relay-mcp/token 내용을 붙여 넣으세요', 'bad');
      return;
    }
    const delay = nextDelay(attempt++);
    setStatus(`서버를 기다리는 중… ${Math.round(delay / 1000)}초 뒤 다시 연결`, 'wait');
    retryTimer = window.setTimeout(connect, delay);
  };
}

window.onmessage = (ev: MessageEvent) => {
  const msg = (ev.data as { pluginMessage?: MainToUi } | undefined)?.pluginMessage;
  if (!msg) return;
  if (msg.type === 'init') {
    token = msg.token;
    fileName = msg.fileName;
    tokenEl.value = token;
    connect();
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (msg.type === 'binary') ws.send(encodeFrame({ id: msg.id, part: msg.part }, msg.bytes));
  else ws.send(JSON.stringify(msg));
};

saveEl.onclick = () => {
  token = tokenEl.value.trim();
  toMain({ type: 'saveToken', token });
  const old = ws;
  ws = undefined;
  old?.close();
  attempt = 0;
  connect();
};
```

- [ ] **Step 4: 타입 검사와 빌드**

Run: `pnpm --filter @figma-relay-mcp/plugin typecheck && pnpm --filter @figma-relay-mcp/plugin build`
Expected: tsc 오류 없음, `plugin built → dist/code.js, dist/ui.html`. `grep -c "<!-- SCRIPT -->" packages/plugin/dist/ui.html`가 `0`.

- [ ] **Step 5: (Task 1 결과가 "eval만 가능"일 때만) compile 교체**

`packages/plugin/src/handlers/execute.ts`의 `compile` 본문을 다음으로 바꾸고 Step 4를 다시 실행한다:
```ts
function compile(code: string): UserFn {
  try {
    return (0, eval)(`(async (figma) => {\n${code}\n})`) as UserFn;
  } catch (e) {
    throw new PluginError('EXEC_ERROR', `코드 문법 오류: ${(e as Error).message}`);
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add packages/plugin
git commit -m "feat(plugin): manifest, build, WebSocket UI, read and execute handlers"
```

---

### Task 7: server 도구(조회·execute)와 MCP 조립 + 1단계 실제 확인

**Files:**
- Create: `packages/server/src/result.ts`, `packages/server/src/tools.ts`, `packages/server/src/index.ts`, `packages/server/build.mjs`
- Create: `packages/server/test/helpers.ts` (테스트 도우미 `fakeBridge`, `toolsWith`)
- Test: `packages/server/test/result.test.ts`, `packages/server/test/tools.test.ts`

**Interfaces:**
- Consumes: `Bridge`(call, sessions), `ToolError`, `NOT_CONNECTED_HINT`, `loadOrCreateToken`, `DEFAULT_PORT`
- Produces:
  ```ts
  type ToolOutput = { kind: 'json'; value: unknown } | { kind: 'image'; png: Uint8Array; meta: unknown }
  interface ToolDeps { bridge: Pick<Bridge, 'call' | 'sessions'>; home: string; now: () => Date; loadImage: (src: string) => Promise<Uint8Array> }
  interface ToolDef { name: string; description: string; inputSchema: z.ZodObject; handler: (args: any) => Promise<ToolOutput> }
  buildTools(deps: ToolDeps): ToolDef[]
  LONG_TIMEOUT_MS = 300_000
  toCallToolResult(out: ToolOutput): CallToolResult
  errorResult(e: unknown): CallToolResult
  ```
  빌드 결과 `packages/server/dist/index.cjs`(의존성 포함 단일 파일).

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/server/test/result.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/errors';
import { errorResult, toCallToolResult } from '../src/result';

describe('result', () => {
  it('formats JSON output as text', () => {
    const r = toCallToolResult({ kind: 'json', value: { a: 1 } });
    expect(r.content).toEqual([{ type: 'text', text: JSON.stringify({ a: 1 }, null, 2) }]);
    expect(r.isError).toBeUndefined();
  });
  it('formats image output as base64 PNG plus meta', () => {
    const r = toCallToolResult({ kind: 'image', png: new Uint8Array([1, 2, 3]), meta: { width: 1 } });
    expect(r.content[0]).toEqual({ type: 'image', data: 'AQID', mimeType: 'image/png' });
    expect(r.content[1]).toEqual({ type: 'text', text: '{"width":1}' });
  });
  it('formats ToolError and other errors', () => {
    const t = errorResult(new ToolError('TIMEOUT', '늦음', '줄이세요'));
    expect(t.isError).toBe(true);
    expect(JSON.parse((t.content[0] as { text: string }).text)).toEqual({ code: 'TIMEOUT', message: '늦음', hint: '줄이세요' });
    const o = errorResult(new Error('x'));
    expect(JSON.parse((o.content[0] as { text: string }).text)).toEqual({ code: 'IO_ERROR', message: 'x' });
  });
});
```

`packages/server/test/helpers.ts`:
```ts
import type { CallOptions, SessionInfo } from '../src/bridge';
import { ToolError } from '../src/errors';
import { buildTools, type ToolDeps } from '../src/tools';

export interface Recorded { method: string; params: unknown; opts: CallOptions }

export function fakeBridge(replies: Record<string, (params: any, opts: CallOptions) => { result: unknown; binaries?: Uint8Array[] }>, sessions: SessionInfo[] = [{ sessionId: 's1', fileName: 'File', connectedAt: 1 }]) {
  const calls: Recorded[] = [];
  const bridge: ToolDeps['bridge'] = {
    sessions: () => sessions,
    call: (async (method: string, params: unknown, opts: CallOptions = {}) => {
      calls.push({ method, params, opts });
      const reply = replies[method];
      if (!reply) throw new ToolError('INVALID_ARGS', `no fake for ${method}`);
      const r = reply(params, opts);
      const session = sessions.find((s) => s.sessionId === opts.sessionId) ?? sessions[sessions.length - 1]!;
      return { result: r.result, binaries: r.binaries ?? [], session };
    }) as ToolDeps['bridge']['call'],
  };
  return { bridge, calls };
}

export function toolsWith(bridge: ToolDeps['bridge'], extra: Partial<ToolDeps> = {}) {
  const tools = buildTools({ bridge, home: '/home/me', now: () => new Date(2026, 9, 10, 9, 0, 0), loadImage: async () => new Uint8Array(), ...extra });
  return (name: string, args: unknown) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t.handler(t.inputSchema.parse(args));
  };
}
```

`packages/server/test/tools.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { fakeBridge, toolsWith } from './helpers';

describe('read tools', () => {
  it('list_files asks each session for its status', async () => {
    const { bridge, calls } = fakeBridge({
      getStatus: (_p, o) => ({ result: { fileName: `F-${o.sessionId}`, currentPage: { id: '0:1', name: 'P' } } }),
    }, [{ sessionId: 'a', fileName: 'A', connectedAt: 1 }, { sessionId: 'b', fileName: 'B', connectedAt: 2 }]);
    const out = await toolsWith(bridge)('list_files', {});
    expect(out).toEqual({ kind: 'json', value: { files: [
      { sessionId: 'a', fileName: 'F-a', currentPage: { id: '0:1', name: 'P' } },
      { sessionId: 'b', fileName: 'F-b', currentPage: { id: '0:1', name: 'P' } },
    ] } });
    expect(calls.every((c) => c.opts.timeoutMs === 5000)).toBe(true);
  });

  it('list_files with no sessions returns a hint', async () => {
    const { bridge } = fakeBridge({}, []);
    const out = await toolsWith(bridge)('list_files', {});
    expect(out.kind === 'json' && (out.value as { files: unknown[]; hint: string }).hint).toContain('Plugins');
  });

  it('get_node defaults depth to 2 and passes sessionId', async () => {
    const { bridge, calls } = fakeBridge({ getNode: () => ({ result: { node: { id: '1:1' }, truncated: false } }) });
    await toolsWith(bridge)('get_node', { id: '1:1', sessionId: 's1' });
    expect(calls[0]).toMatchObject({ method: 'getNode', params: { id: '1:1', depth: 2 }, opts: { sessionId: 's1' } });
  });

  it('get_node rejects depth over 10', () => {
    const { bridge } = fakeBridge({});
    expect(() => toolsWith(bridge)('get_node', { id: '1:1', depth: 11 })).toThrow();
  });

  it('find_nodes and get_selection forward params', async () => {
    const { bridge, calls } = fakeBridge({
      findNodes: () => ({ result: { nodes: [], truncated: false } }),
      getSelection: () => ({ result: [] }),
    });
    const run = toolsWith(bridge);
    await run('find_nodes', { query: '^Card', type: 'FRAME' });
    await run('get_selection', {});
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ['findNodes', { query: '^Card', type: 'FRAME' }],
      ['getSelection', {}],
    ]);
  });

  it('screenshot returns the PNG part as an image', async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const { bridge, calls } = fakeBridge({ screenshot: () => ({ result: { width: 10, height: 5, scale: 1 }, binaries: [png] }) });
    const out = await toolsWith(bridge)('screenshot', { id: '1:1' });
    expect(calls[0]?.params).toEqual({ id: '1:1', scale: 1 });
    expect(out).toEqual({ kind: 'image', png, meta: { width: 10, height: 5, scale: 1 } });
  });

  it('execute forwards code and returns the value', async () => {
    const { bridge } = fakeBridge({ execute: (p) => ({ result: { echoed: p.code } }) });
    const out = await toolsWith(bridge)('execute', { code: 'return 1' });
    expect(out).toEqual({ kind: 'json', value: { echoed: 'return 1' } });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @figma-relay-mcp/server test -- result tools`
Expected: FAIL — `../src/result`, `../src/tools` 없음

- [ ] **Step 3: 구현**

`packages/server/src/result.ts`:
```ts
import type { CallToolResult } from '@modelcontextprotocol/server';
import { ToolError } from './errors';
import type { ToolOutput } from './tools';

export function toCallToolResult(out: ToolOutput): CallToolResult {
  if (out.kind === 'image') {
    return {
      content: [
        { type: 'image', data: Buffer.from(out.png).toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: JSON.stringify(out.meta) },
      ],
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(out.value, null, 2) }] };
}

export function errorResult(e: unknown): CallToolResult {
  const body =
    e instanceof ToolError
      ? { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) }
      : { code: 'IO_ERROR', message: e instanceof Error ? e.message : String(e) };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
}
```

`packages/server/src/tools.ts`:
```ts
import { z } from 'zod';
import type { Bridge } from './bridge';
import { NOT_CONNECTED_HINT } from './errors';

export type ToolOutput = { kind: 'json'; value: unknown } | { kind: 'image'; png: Uint8Array; meta: unknown };

export interface ToolDeps {
  bridge: Pick<Bridge, 'call' | 'sessions'>;
  home: string;
  now: () => Date;
  loadImage: (src: string) => Promise<Uint8Array>;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  // 인자는 inputSchema.parse 결과
  handler: (args: any) => Promise<ToolOutput>;
}

export const LONG_TIMEOUT_MS = 300_000;
const STATUS_TIMEOUT_MS = 5_000;

const sessionId = z.string().optional().describe('대상 세션 ID(list_files). 생략하면 가장 최근에 연결된 파일');
const json = (value: unknown): ToolOutput => ({ kind: 'json', value });

export function buildTools(deps: ToolDeps): ToolDef[] {
  const { bridge } = deps;
  return [
    {
      name: 'list_files',
      description: '플러그인이 연결된 Figma 파일 목록(세션 ID, 파일 이름, 현재 페이지)을 돌려준다.',
      inputSchema: z.object({}),
      handler: async () => {
        const files = await Promise.all(
          bridge.sessions().map(async (s) => {
            try {
              const { result } = await bridge.call('getStatus', {}, { sessionId: s.sessionId, timeoutMs: STATUS_TIMEOUT_MS });
              return { sessionId: s.sessionId, ...result };
            } catch {
              return { sessionId: s.sessionId, fileName: s.fileName, currentPage: null };
            }
          }),
        );
        return json(files.length > 0 ? { files } : { files, hint: NOT_CONNECTED_HINT });
      },
    },
    {
      name: 'get_selection',
      description: '현재 페이지에서 선택한 노드들의 요약(id, 이름, 타입, 위치·크기, 텍스트, 오토레이아웃).',
      inputSchema: z.object({ sessionId }),
      handler: async (a: { sessionId?: string }) =>
        json((await bridge.call('getSelection', {}, { sessionId: a.sessionId })).result),
    },
    {
      name: 'get_node',
      description: '노드(페이지 포함) 트리를 depth 단계까지 요약한다. 전체 노드 500개 상한, 넘으면 truncated: true.',
      inputSchema: z.object({ id: z.string(), depth: z.number().int().min(0).max(10).default(2), sessionId }),
      handler: async (a: { id: string; depth: number; sessionId?: string }) =>
        json((await bridge.call('getNode', { id: a.id, depth: a.depth }, { sessionId: a.sessionId })).result),
    },
    {
      name: 'find_nodes',
      description: '페이지에서 이름이 정규식(대소문자 무시)에 맞는 노드를 찾는다. 최대 200개. pageId 생략 시 현재 페이지.',
      inputSchema: z.object({ query: z.string(), type: z.string().optional(), pageId: z.string().optional(), sessionId }),
      handler: async (a: { query: string; type?: string; pageId?: string; sessionId?: string }) => {
        const params: { query: string; type?: string; pageId?: string } = { query: a.query };
        if (a.type) params.type = a.type;
        if (a.pageId) params.pageId = a.pageId;
        return json((await bridge.call('findNodes', params, { sessionId: a.sessionId })).result);
      },
    },
    {
      name: 'screenshot',
      description: '노드를 PNG로 렌더링해 보여 준다. 긴 변은 최대 2048px로 자동 축소.',
      inputSchema: z.object({ id: z.string(), scale: z.number().positive().max(4).default(1), sessionId }),
      handler: async (a: { id: string; scale: number; sessionId?: string }) => {
        const { result, binaries } = await bridge.call('screenshot', { id: a.id, scale: a.scale }, { sessionId: a.sessionId });
        const png = binaries[0];
        if (!png) throw new Error('플러그인이 PNG를 보내지 않았습니다');
        return { kind: 'image', png, meta: result };
      },
    },
    {
      name: 'execute',
      description:
        'Figma Plugin API 코드를 async 함수 본문으로 실행하고 return 값을 JSON으로 돌려준다. `figma` 전역 사용. ' +
        'dynamic-page 모드라 getNodeByIdAsync 등 Async API를 써야 하고, 텍스트를 바꾸기 전에 figma.loadFontAsync가 필요하다. ' +
        '노드는 {id, name, type}으로 반환된다. 실행 전후로 undo 지점이 생긴다.',
      inputSchema: z.object({ code: z.string().min(1), sessionId }),
      handler: async (a: { code: string; sessionId?: string }) =>
        json((await bridge.call('execute', { code: a.code }, { sessionId: a.sessionId })).result),
    },
  ];
}
```

`packages/server/src/index.ts`:
```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PORT } from '@figma-relay-mcp/protocol';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { Bridge } from './bridge';
import { errorResult, toCallToolResult } from './result';
import { loadOrCreateToken } from './token';
import { buildTools } from './tools';

async function main() {
  const home = homedir();
  const token = await loadOrCreateToken(join(home, '.figma-relay-mcp'));
  const bridge = new Bridge({ token });
  bridge
    .start(DEFAULT_PORT)
    .then((port) => console.error(`[figma-relay-mcp] ws://127.0.0.1:${port} 대기 중`))
    .catch((e: Error) => console.error(`[figma-relay-mcp] WebSocket 시작 실패: ${e.message}`));

  const server = new McpServer({ name: 'figma-relay-mcp', version: '0.1.0' });
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
```
(stdout은 MCP 전용이므로 로그는 반드시 `console.error`.) macOS에는 `timeout` 명령이 없어 아래 스모크 테스트는 `perl -e 'alarm 3; exec @ARGV'`로 3초 뒤 끝낸다.

`packages/server/build.mjs`:
```js
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/index.cjs',
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
});
console.log('server built → dist/index.cjs');
```

- [ ] **Step 4: 통과·빌드 확인**

Run: `pnpm --filter @figma-relay-mcp/server test && pnpm --filter @figma-relay-mcp/server typecheck && pnpm --filter @figma-relay-mcp/server build`
Expected: 모든 테스트 PASS, tsc 오류 없음, `server built → dist/index.cjs`.
`registerTool` 타입이 `inputSchema: z.ZodObject`를 받지 않으면 `t.inputSchema as z.ZodObject<z.ZodRawShape>`로 맞춘다(동작은 같다).

- [ ] **Step 5: MCP 핸드셰이크 스모크 테스트**

Run (임시 HOME으로 실제 토큰 파일을 건드리지 않음):
```bash
cd packages/server && TMPH=$(mktemp -d) && printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | HOME=$TMPH perl -e 'alarm 3; exec @ARGV' node dist/index.cjs; echo
```
Expected: stdout에 `"id":2` 응답과 도구 6개(`list_files` … `execute`) 이름. (포트 38451을 다른 프로세스가 쓰고 있으면 stderr에 시작 실패가 찍히지만 tools/list는 나온다.)

- [ ] **Step 6: 1단계 실제 확인 (사용자와 함께)**

1. 사용자에게 묻고 승인받은 뒤 등록:
   ```bash
   claude mcp add figma-relay-mcp -s user -- node ~/dev/figma-relay-mcp/packages/server/dist/index.cjs
   ```
2. 사용자: Claude Code 세션을 새로 시작(MCP 서버가 뜨고 `~/.figma-relay-mcp/token` 생성).
3. 사용자: Figma에서 Import plugin from manifest → `packages/plugin/manifest.json` → 실행 → `~/.figma-relay-mcp/token` 내용 붙여 넣기 → "연결됨 · <파일 이름>" 확인.
4. Claude Code에서 차례로 확인:
   - `list_files` → 파일 1개
   - `execute`로 `const f = figma.createFrame(); f.name = 'mcp-test'; f.resize(320, 200); return f;` → `{id, name, type}`
   - `find_nodes` `{query: '^mcp-test$'}` → 1개
   - `get_node` 그 id → 요약
   - `screenshot` 그 id → 이미지가 보임
   - Figma에서 Cmd+Z 한 번 → 프레임이 사라짐
   - 플러그인 창 닫기 → `list_files` 빈 목록 + hint, 다시 실행 → 자동 연결
   - 서버가 없는 상태(Claude Code 종료)에서 플러그인 상태가 "서버를 기다리는 중…"으로 바뀌는지
5. 결과를 `docs/spike-results.md` 끝에 "1단계 확인" 절로 추가한다.

- [ ] **Step 7: Commit**

```bash
git add packages/server docs/spike-results.md
git commit -m "feat(server): read/execute MCP tools and stdio entry point"
```

---

## 2단계: PDF

### Task 8: server — PDF 합치기와 export_pdf 도구

**Files:**
- Create: `packages/server/src/pdf.ts`
- Modify: `packages/server/src/tools.ts` (`exportPdfToFile` 추가, `buildTools` 배열 끝에 `export_pdf` 추가)
- Modify: `packages/server/test/helpers.ts` (`samplePdf` 추가)
- Test: `packages/server/test/pdf.test.ts`, `packages/server/test/exportPdf.test.ts`

**Interfaces:**
- Consumes: `ToolError`, `expandPath`, `defaultPdfPath`, `uniquePath`, `ToolDeps`, `LONG_TIMEOUT_MS`, 테스트 도우미 `fakeBridge`, `toolsWith`(`test/helpers.ts`)
- Produces:
  - `mergePdfs(parts: Uint8Array[]): Promise<{ bytes: Uint8Array; pages: number }>` (빈 배열이면 `ToolError('INVALID_ARGS')`)
  - `exportPdfToFile(deps: ToolDeps, ids: string[], outPath: string | undefined, sessionId?: string): Promise<{ path: string; pages: number; bytes: number }>`

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/server/test/pdf.test.ts`:
```ts
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/errors';
import { mergePdfs } from '../src/pdf';
import { samplePdf } from './helpers';

describe('mergePdfs', () => {
  it('keeps part order and page sizes', async () => {
    const parts = [await samplePdf([[100, 100]]), await samplePdf([[200, 50]]), await samplePdf([[300, 300], [10, 10]])];
    const { bytes, pages } = await mergePdfs(parts);
    expect(pages).toBe(4);
    const merged = await PDFDocument.load(bytes);
    expect(merged.getPages().map((p) => [p.getWidth(), p.getHeight()])).toEqual([[100, 100], [200, 50], [300, 300], [10, 10]]);
  });

  it('rejects an empty list', async () => {
    await expect(mergePdfs([])).rejects.toBeInstanceOf(ToolError);
  });
});
```

`packages/server/test/exportPdf.test.ts`:
```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { fakeBridge, samplePdf, toolsWith } from './helpers';

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'fmcp-home-'));
  const parts = [await samplePdf([[100, 100]]), await samplePdf([[200, 200]])];
  const { bridge, calls } = fakeBridge(
    { exportPdf: (p: { ids: string[] }) => ({ result: { pages: p.ids.length }, binaries: parts.slice(0, p.ids.length) }) },
    [{ sessionId: 's1', fileName: '제안서', connectedAt: 1 }],
  );
  return { home, calls, run: toolsWith(bridge, { home }) };
}

describe('export_pdf', () => {
  it('merges in order and saves to Downloads by default', async () => {
    const { home, calls, run } = await setup();
    const out = await run('export_pdf', { ids: ['1:1', '1:2'] });
    const path = join(home, 'Downloads', '제안서-20261010-090000.pdf');
    expect(out).toEqual({ kind: 'json', value: { path, pages: 2, bytes: expect.any(Number) } });
    expect(calls[0]?.opts.timeoutMs).toBe(300_000);
    const doc = await PDFDocument.load(await readFile(path));
    expect(doc.getPages().map((p) => p.getWidth())).toEqual([100, 200]);
  });

  it('never overwrites: appends -2', async () => {
    const { home, run } = await setup();
    const target = join(home, 'out.pdf');
    await writeFile(target, 'old');
    const out = await run('export_pdf', { ids: ['1:1'], outPath: '~/out.pdf' });
    expect(out.kind === 'json' && (out.value as { path: string }).path).toBe(join(home, 'out-2.pdf'));
    expect(await readFile(target, 'utf8')).toBe('old');
  });

  it('fails with IO_ERROR when a part is missing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fmcp-home-'));
    const { bridge } = fakeBridge({ exportPdf: () => ({ result: { pages: 2 }, binaries: [new Uint8Array([1])] }) });
    await expect(toolsWith(bridge, { home })('export_pdf', { ids: ['1:1', '1:2'] })).rejects.toMatchObject({ code: 'IO_ERROR' });
  });

  it('rejects an empty id list', () => {
    const { bridge } = fakeBridge({});
    expect(() => toolsWith(bridge)('export_pdf', { ids: [] })).toThrow();
  });
});
```

`packages/server/test/helpers.ts` 끝에 추가(위 `pdf.test.ts`의 `samplePdf` 정의는 지우고 여기서 import한다):
```ts
import { PDFDocument } from 'pdf-lib';

export async function samplePdf(sizes: [number, number][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const s of sizes) doc.addPage(s);
  return doc.save();
}
```
(import 문은 파일 맨 위로 올린다.)

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @figma-relay-mcp/server test`
Expected: FAIL — `../src/pdf` 없음, `export_pdf` 도구 없음

- [ ] **Step 3: 구현**

`packages/server/src/pdf.ts`:
```ts
import { PDFDocument } from 'pdf-lib';
import { ToolError } from './errors';

export async function mergePdfs(parts: Uint8Array[]): Promise<{ bytes: Uint8Array; pages: number }> {
  if (parts.length === 0) throw new ToolError('INVALID_ARGS', '합칠 PDF가 없습니다');
  const out = await PDFDocument.create();
  for (const part of parts) {
    const src = await PDFDocument.load(part);
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  return { bytes: await out.save(), pages: out.getPageCount() };
}
```

`packages/server/src/tools.ts` — 파일 위쪽 import에 추가:
```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ToolError } from './errors';
import { defaultPdfPath, expandPath, uniquePath } from './paths';
import { mergePdfs } from './pdf';
```
(`NOT_CONNECTED_HINT` import는 `import { NOT_CONNECTED_HINT, ToolError } from './errors';`로 합친다.)

`buildTools` 위에 추가:
```ts
export async function exportPdfToFile(
  deps: ToolDeps,
  ids: string[],
  outPath: string | undefined,
  sessionId?: string,
): Promise<{ path: string; pages: number; bytes: number }> {
  const { binaries, session } = await deps.bridge.call('exportPdf', { ids }, { sessionId, timeoutMs: LONG_TIMEOUT_MS });
  const received = binaries.filter(Boolean).length;
  if (binaries.length !== ids.length || received !== ids.length) {
    throw new ToolError('IO_ERROR', `PDF ${ids.length}개 중 ${received}개만 받았습니다`, '다시 시도하세요');
  }
  const { bytes, pages } = await mergePdfs(binaries);
  const target = await uniquePath(
    outPath ? expandPath(outPath, deps.home) : defaultPdfPath(session.fileName, deps.now(), deps.home),
  );
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
  } catch (e) {
    throw new ToolError('IO_ERROR', `PDF 저장 실패: ${(e as Error).message}`, '저장 경로의 권한과 남은 공간을 확인하세요');
  }
  return { path: target, pages, bytes: bytes.length };
}
```

`buildTools`가 돌려주는 배열의 `execute` 항목 뒤에 추가:
```ts
    {
      name: 'export_pdf',
      description:
        '노드들을 주어진 순서대로 한 PDF로 합쳐 저장한다(Figma 기본 PDF: RGB, 벡터, 텍스트 선택 가능). ' +
        'outPath 생략 시 ~/Downloads/<파일이름>-<시각>.pdf. 같은 이름이 있으면 -2, -3을 붙이고 덮어쓰지 않는다.',
      inputSchema: z.object({ ids: z.array(z.string()).min(1), outPath: z.string().optional(), sessionId }),
      handler: async (a: { ids: string[]; outPath?: string; sessionId?: string }) =>
        json(await exportPdfToFile(deps, a.ids, a.outPath, a.sessionId)),
    },
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter @figma-relay-mcp/server test && pnpm --filter @figma-relay-mcp/server typecheck`
Expected: 모든 테스트 PASS, tsc 오류 없음

- [ ] **Step 5: Commit**

```bash
git add packages/server
git commit -m "feat(server): export_pdf merges node PDFs in order and saves without overwriting"
```

---

### Task 9: plugin — exportPdf handler + 2단계 실제 확인

**Files:**
- Create: `packages/plugin/src/handlers/exportPdf.ts`
- Modify: `packages/plugin/src/handlers/index.ts`

**Interfaces:**
- Consumes: `Handler`, `requireNode`, `PluginError`
- Produces: `handlers.exportPdf` — 모든 id를 먼저 확인한 뒤 순서대로 `exportAsync({format:'PDF'})`, part = id 순번으로 `sendBinary`, 결과 `{ pages: ids.length }`

- [ ] **Step 1: 구현**

`packages/plugin/src/handlers/exportPdf.ts`:
```ts
import type { Handler } from '../bridgeTypes';
import { requireNode } from './read';

export const exportPdf: Handler<'exportPdf'> = async ({ ids }, ctx) => {
  // 하나라도 없으면 아무것도 보내기 전에 실패한다.
  const nodes = [];
  for (const id of ids) nodes.push(await requireNode(id));
  for (const [part, node] of nodes.entries()) {
    const bytes = await node.exportAsync({ format: 'PDF' });
    ctx.sendBinary(part, bytes);
  }
  return { pages: ids.length };
};
```

`packages/plugin/src/handlers/index.ts` — import와 표에 추가:
```ts
import { exportPdf } from './exportPdf';
```
```ts
  execute,
  exportPdf,
};
```

- [ ] **Step 2: 타입 검사·빌드**

Run: `pnpm --filter @figma-relay-mcp/plugin typecheck && pnpm --filter @figma-relay-mcp/plugin build && pnpm --filter @figma-relay-mcp/server build`
Expected: 오류 없음

- [ ] **Step 3: 2단계 실제 확인 (사용자와 함께)**

1. 사용자: Claude Code 세션 재시작(서버 새 빌드), Figma에서 플러그인 다시 실행.
2. `execute`로 크기가 다른 프레임 3개(각각 안에 한글 텍스트, 폰트 로드 후)를 만든다.
3. `export_pdf` `{ids: [3번, 1번, 2번]}` → `~/Downloads/<파일>-<시각>.pdf`
4. 확인: `open <경로>` → 3쪽, 순서 3→1→2, 쪽마다 크기 다름, 미리보기에서 텍스트 선택·검색 가능.
5. 같은 `outPath`로 두 번 → 두 번째는 `-2`.
6. 없는 id 섞어 호출 → `NODE_NOT_FOUND`, 파일 생성 안 됨.
7. 결과를 `docs/spike-results.md`에 "2단계 확인"으로 추가.

- [ ] **Step 4: Commit**

```bash
git add packages/plugin docs/spike-results.md
git commit -m "feat(plugin): export nodes as PDF parts in order"
```

---

## 3단계: 템플릿

### Task 10: plugin 순수 모듈 — 배치와 셀 채우기 계획

**Files:**
- Create: `packages/plugin/src/lib/layout.ts`, `packages/plugin/src/lib/template.ts`
- Test: `packages/plugin/test/layout.test.ts`, `packages/plugin/test/template.test.ts`

**Interfaces:**
- Consumes: protocol의 `CellValue`, `TemplateRow`, `WarningCode`
- Produces:
  ```ts
  // layout.ts
  GAP = 40; COLUMNS = 5
  gridPosition(index: number, origin: { x: number; y: number }, size: { width: number; height: number }): { x: number; y: number }
  // template.ts
  type LayerKind = 'text' | 'shape' | 'other'
  type CellPlan = { kind: 'text'; text: string } | { kind: 'image'; asset: number } | { kind: 'skip' } | { kind: 'warn'; code: WarningCode; detail?: string }
  keyOf(layerName: string): string | null
  planCell(layer: LayerKind, value: CellValue | undefined): CellPlan
  unknownKeys(row: TemplateRow, templateKeys: ReadonlySet<string>): string[]
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/plugin/test/layout.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { COLUMNS, GAP, gridPosition } from '../src/lib/layout';

describe('gridPosition', () => {
  const size = { width: 100, height: 50 };
  const origin = { x: 1000, y: 0 };
  it('fills a row of 5 then wraps', () => {
    expect(COLUMNS).toBe(5);
    expect(GAP).toBe(40);
    expect(gridPosition(0, origin, size)).toEqual({ x: 1000, y: 0 });
    expect(gridPosition(4, origin, size)).toEqual({ x: 1000 + 4 * 140, y: 0 });
    expect(gridPosition(5, origin, size)).toEqual({ x: 1000, y: 90 });
    expect(gridPosition(7, origin, size)).toEqual({ x: 1280, y: 90 });
  });
});
```

`packages/plugin/test/template.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { keyOf, planCell, unknownKeys } from '../src/lib/template';

describe('keyOf', () => {
  it('reads {{key}} names, tolerating inner spaces', () => {
    expect(keyOf('{{name}}')).toBe('name');
    expect(keyOf('{{ 회사 }}')).toBe('회사');
  });
  it('ignores other names', () => {
    expect(keyOf('name')).toBeNull();
    expect(keyOf('Title {{name}}')).toBeNull();
    expect(keyOf('{{}}')).toBeNull();
  });
});

describe('planCell', () => {
  it('text layers take strings, numbers, booleans; null clears', () => {
    expect(planCell('text', '홍길동')).toEqual({ kind: 'text', text: '홍길동' });
    expect(planCell('text', 3)).toEqual({ kind: 'text', text: '3' });
    expect(planCell('text', false)).toEqual({ kind: 'text', text: 'false' });
    expect(planCell('text', null)).toEqual({ kind: 'text', text: '' });
  });
  it('text layers show the source of image-like values', () => {
    expect(planCell('text', { asset: 0, src: 'https://x/a.png' })).toEqual({ kind: 'text', text: 'https://x/a.png' });
    expect(planCell('text', { imageError: 'HTTP 404', src: '/a.png' })).toEqual({ kind: 'text', text: '/a.png' });
  });
  it('shape layers take assets', () => {
    expect(planCell('shape', { asset: 2, src: 's' })).toEqual({ kind: 'image', asset: 2 });
    expect(planCell('shape', { imageError: 'HTTP 404', src: 's' })).toEqual({ kind: 'warn', code: 'IMAGE_FAILED', detail: 'HTTP 404' });
    expect(planCell('shape', null)).toEqual({ kind: 'skip' });
    expect(planCell('shape', 'plain')).toMatchObject({ kind: 'warn', code: 'NOT_FILLABLE' });
  });
  it('missing values and unsupported layers warn', () => {
    expect(planCell('text', undefined)).toEqual({ kind: 'warn', code: 'MISSING_VALUE' });
    expect(planCell('other', 'x')).toMatchObject({ kind: 'warn', code: 'NOT_FILLABLE' });
  });
});

describe('unknownKeys', () => {
  it('lists row keys with no matching layer', () => {
    expect(unknownKeys({ name: 'a', extra: 1 }, new Set(['name']))).toEqual(['extra']);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @figma-relay-mcp/plugin test -- layout template`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`packages/plugin/src/lib/layout.ts`:
```ts
export const GAP = 40;
export const COLUMNS = 5;

export function gridPosition(
  index: number,
  origin: { x: number; y: number },
  size: { width: number; height: number },
): { x: number; y: number } {
  const col = index % COLUMNS;
  const row = Math.floor(index / COLUMNS);
  return { x: origin.x + col * (size.width + GAP), y: origin.y + row * (size.height + GAP) };
}
```

`packages/plugin/src/lib/template.ts`:
```ts
import type { CellValue, TemplateRow, WarningCode } from '@figma-relay-mcp/protocol';

export type LayerKind = 'text' | 'shape' | 'other';

export type CellPlan =
  | { kind: 'text'; text: string }
  | { kind: 'image'; asset: number }
  | { kind: 'skip' }
  | { kind: 'warn'; code: WarningCode; detail?: string };

const KEY_RE = /^\{\{\s*([^{}]+?)\s*\}\}$/;

export function keyOf(layerName: string): string | null {
  return KEY_RE.exec(layerName)?.[1] ?? null;
}

export function planCell(layer: LayerKind, value: CellValue | undefined): CellPlan {
  if (value === undefined) return { kind: 'warn', code: 'MISSING_VALUE' };
  if (layer === 'other') return { kind: 'warn', code: 'NOT_FILLABLE', detail: '텍스트나 채우기가 있는 레이어가 아닙니다' };

  if (layer === 'text') {
    if (value === null) return { kind: 'text', text: '' };
    if (typeof value === 'object') return { kind: 'text', text: value.src };
    return { kind: 'text', text: String(value) };
  }

  if (value === null) return { kind: 'skip' };
  if (typeof value === 'object') {
    return 'asset' in value
      ? { kind: 'image', asset: value.asset }
      : { kind: 'warn', code: 'IMAGE_FAILED', detail: value.imageError };
  }
  return { kind: 'warn', code: 'NOT_FILLABLE', detail: '이미지 레이어에는 http(s) URL이나 png/jpg/gif 절대 경로를 넣으세요' };
}

export function unknownKeys(row: TemplateRow, templateKeys: ReadonlySet<string>): string[] {
  return Object.keys(row).filter((k) => !templateKeys.has(k));
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter @figma-relay-mcp/plugin test && pnpm --filter @figma-relay-mcp/plugin typecheck`
Expected: 모든 테스트 PASS, tsc 오류 없음

- [ ] **Step 5: Commit**

```bash
git add packages/plugin
git commit -m "feat(plugin): grid layout and template cell planning"
```

---

### Task 11: server — 템플릿 이미지 해석

**Files:**
- Create: `packages/server/src/images.ts`
- Modify: `packages/server/src/index.ts` (`loadImage` 연결)
- Test: `packages/server/test/images.test.ts`

**Interfaces:**
- Consumes: protocol의 `CellValue`, `TemplateRow`
- Produces:
  ```ts
  MAX_IMAGE_BYTES = 20 * 1024 * 1024
  looksLikeImage(v: unknown): v is string     // http(s) URL, 또는 / · ~/ 로 시작하고 .png/.jpg/.jpeg/.gif로 끝남
  loadImage(src: string): Promise<Uint8Array> // URL은 fetch(30초), 경로는 readFile. 20MB 초과 시 throw
  resolveImages(rows: Record<string, string | number | boolean | null>[], load: (src: string) => Promise<Uint8Array>):
    Promise<{ rows: TemplateRow[]; binaries: Uint8Array[] }>   // 같은 src는 한 번만 로드
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/server/test/images.test.ts`:
```ts
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadImage, looksLikeImage, resolveImages } from '../src/images';

describe('looksLikeImage', () => {
  it('accepts URLs and absolute image paths', () => {
    expect(looksLikeImage('https://x.com/a')).toBe(true);
    expect(looksLikeImage('http://x.com/a.png')).toBe(true);
    expect(looksLikeImage('/Users/me/a.PNG')).toBe(true);
    expect(looksLikeImage('~/pics/b.jpeg')).toBe(true);
  });
  it('rejects everything else', () => {
    expect(looksLikeImage('홍길동')).toBe(false);
    expect(looksLikeImage('/Users/me/a.webp')).toBe(false);
    expect(looksLikeImage('a.png')).toBe(false);
    expect(looksLikeImage(3)).toBe(false);
    expect(looksLikeImage(null)).toBe(false);
  });
});

describe('resolveImages', () => {
  it('replaces image values with asset refs and loads each source once', async () => {
    const loaded: string[] = [];
    const load = async (src: string) => {
      loaded.push(src);
      if (src.includes('bad')) throw new Error('HTTP 404');
      return new Uint8Array([src.length]);
    };
    const { rows, binaries } = await resolveImages(
      [
        { name: 'A', photo: 'https://x/a.png', n: 1 },
        { name: 'B', photo: 'https://x/a.png', n: null },
        { name: 'C', photo: 'https://x/bad.png', n: true },
      ],
      load,
    );
    expect(loaded).toEqual(['https://x/a.png', 'https://x/bad.png']);
    expect(binaries).toHaveLength(1);
    expect(rows).toEqual([
      { name: 'A', photo: { asset: 0, src: 'https://x/a.png' }, n: 1 },
      { name: 'B', photo: { asset: 0, src: 'https://x/a.png' }, n: null },
      { name: 'C', photo: { imageError: 'HTTP 404', src: 'https://x/bad.png' }, n: true },
    ]);
  });
});

describe('loadImage', () => {
  it('reads a local file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fmcp-img-'));
    const p = join(dir, 'a.png');
    await writeFile(p, Buffer.from([1, 2, 3]));
    expect([...(await loadImage(p))]).toEqual([1, 2, 3]);
  });

  it('downloads over http and fails on non-2xx', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/ok.png') {
        res.writeHead(200);
        res.end(Buffer.from([9, 8]));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      expect([...(await loadImage(`http://127.0.0.1:${port}/ok.png`))]).toEqual([9, 8]);
      await expect(loadImage(`http://127.0.0.1:${port}/missing.png`)).rejects.toThrow('HTTP 404');
    } finally {
      server.close();
    }
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @figma-relay-mcp/server test -- images`
Expected: FAIL — `../src/images` 없음

- [ ] **Step 3: 구현**

`packages/server/src/images.ts`:
```ts
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TemplateRow } from '@figma-relay-mcp/protocol';

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
```

`packages/server/src/index.ts` — 임시 `loadImage`를 실제 함수로 바꾼다:
```ts
import { loadImage } from './images';
```
```ts
  const tools = buildTools({ bridge, home, now: () => new Date(), loadImage });
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter @figma-relay-mcp/server test && pnpm --filter @figma-relay-mcp/server typecheck`
Expected: 모든 테스트 PASS, tsc 오류 없음

- [ ] **Step 5: Commit**

```bash
git add packages/server
git commit -m "feat(server): resolve template image values to binary assets"
```

---

### Task 12: fill_template — plugin handler + server 도구 + 3단계 실제 확인

**Files:**
- Create: `packages/plugin/src/handlers/template.ts`
- Modify: `packages/plugin/src/handlers/index.ts`
- Modify: `packages/server/src/tools.ts` (`fill_template` 추가)
- Test: `packages/server/test/fillTemplate.test.ts`

**Interfaces:**
- Consumes: plugin — `Handler`, `PluginError`, `requireNode`, `gridPosition`, `GAP`, `keyOf`, `planCell`, `unknownKeys`, `LayerKind`; server — `resolveImages`, `exportPdfToFile`, `LONG_TIMEOUT_MS`, `ToolDeps`, 테스트 도우미 `fakeBridge`, `toolsWith`, `samplePdf`(`test/helpers.ts`)
- Produces: `handlers.fillTemplate`, MCP 도구 `fill_template` → `{ nodeIds, warnings, pdf? }`

- [ ] **Step 1: 실패하는 server 테스트 작성**

`packages/server/test/fillTemplate.test.ts`:
```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeBridge, samplePdf, toolsWith } from './helpers';

describe('fill_template', () => {
  it('resolves images, sends them as binaries and returns the plugin result', async () => {
    const { bridge, calls } = fakeBridge({
      fillTemplate: () => ({ result: { nodeIds: ['9:1', '9:2'], warnings: [{ row: 2, key: 'x', code: 'UNKNOWN_KEY' }] } }),
    });
    const run = toolsWith(bridge, { loadImage: async () => new Uint8Array([42]) });
    const out = await run('fill_template', {
      templateId: '1:1',
      rows: [{ name: 'A', photo: 'https://x/a.png' }, { name: 'B', x: 1 }],
    });
    expect(calls[0]).toMatchObject({
      method: 'fillTemplate',
      params: {
        templateId: '1:1',
        layout: 'grid',
        rows: [{ name: 'A', photo: { asset: 0, src: 'https://x/a.png' } }, { name: 'B', x: 1 }],
      },
      opts: { timeoutMs: 300_000 },
    });
    expect(calls[0]?.opts.binaries?.map((b) => [...b])).toEqual([[42]]);
    expect(out).toEqual({
      kind: 'json',
      value: { nodeIds: ['9:1', '9:2'], warnings: [{ row: 2, key: 'x', code: 'UNKNOWN_KEY' }] },
    });
  });

  it('exports the created nodes to PDF on the same session when asked', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fmcp-home-'));
    const part = await samplePdf([[50, 50]]);
    const { bridge, calls } = fakeBridge(
      {
        fillTemplate: () => ({ result: { nodeIds: ['9:1', '9:2'], warnings: [] } }),
        exportPdf: (p: { ids: string[] }) => ({ result: { pages: p.ids.length }, binaries: p.ids.map(() => part) }),
      },
      [{ sessionId: 'a', fileName: '명함', connectedAt: 1 }, { sessionId: 'b', fileName: 'B', connectedAt: 2 }],
    );
    const out = await toolsWith(bridge, { home })('fill_template', {
      templateId: '1:1', rows: [{ name: 'A' }, { name: 'B' }], sessionId: 'a', exportPdf: {},
    });
    expect(calls[1]).toMatchObject({ method: 'exportPdf', params: { ids: ['9:1', '9:2'] }, opts: { sessionId: 'a' } });
    expect(out.kind === 'json' && (out.value as { pdf: { pages: number; path: string } }).pdf).toMatchObject({
      pages: 2,
      path: join(home, 'Downloads', '명함-20261010-090000.pdf'),
    });
  });

  it('validates rows', () => {
    const { bridge } = fakeBridge({});
    const run = toolsWith(bridge);
    expect(() => run('fill_template', { templateId: '1:1', rows: [] })).toThrow();
    expect(() => run('fill_template', { templateId: '1:1', rows: [{ a: { nested: 1 } }] })).toThrow();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @figma-relay-mcp/server test -- fillTemplate`
Expected: FAIL — `no tool fill_template`

- [ ] **Step 3: server 도구 구현**

`packages/server/src/tools.ts` — import 추가:
```ts
import { resolveImages } from './images';
```

`export_pdf` 항목 뒤에 추가:
```ts
    {
      name: 'fill_template',
      description:
        '템플릿 노드(페이지 바로 아래 있어야 함)를 행마다 복제하고, 이름이 {{키}}인 레이어를 채운다. ' +
        '텍스트 레이어엔 값을 글자로, 도형·프레임 레이어엔 http(s) URL이나 png/jpg/gif 절대 경로를 이미지로 채운다. ' +
        'layout: grid = 템플릿 오른쪽에 한 줄 5개, page = 새 페이지. 문제가 있는 칸은 건너뛰지 않고 warnings에 남긴다. ' +
        'exportPdf를 주면 만든 노드를 순서대로 한 PDF로 저장한다.',
      inputSchema: z.object({
        templateId: z.string(),
        rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))).min(1).max(500),
        layout: z.enum(['grid', 'page']).default('grid'),
        exportPdf: z.object({ outPath: z.string().optional() }).optional(),
        sessionId,
      }),
      handler: async (a: {
        templateId: string;
        rows: Record<string, string | number | boolean | null>[];
        layout: 'grid' | 'page';
        exportPdf?: { outPath?: string };
        sessionId?: string;
      }) => {
        const { rows, binaries } = await resolveImages(a.rows, deps.loadImage);
        const { result, session } = await bridge.call(
          'fillTemplate',
          { templateId: a.templateId, rows, layout: a.layout },
          { sessionId: a.sessionId, timeoutMs: LONG_TIMEOUT_MS, binaries },
        );
        if (!a.exportPdf) return json(result);
        const pdf = await exportPdfToFile(deps, result.nodeIds, a.exportPdf.outPath, session.sessionId);
        return json({ ...result, pdf });
      },
    },
```

Run: `pnpm --filter @figma-relay-mcp/server test && pnpm --filter @figma-relay-mcp/server typecheck`
Expected: 모든 테스트 PASS

- [ ] **Step 4: plugin handler 구현**

`packages/plugin/src/handlers/template.ts`:
```ts
import type { TemplateWarning } from '@figma-relay-mcp/protocol';
import type { Handler } from '../bridgeTypes';
import { PluginError } from '../lib/errors';
import { GAP, gridPosition } from '../lib/layout';
import { keyOf, planCell, unknownKeys, type LayerKind } from '../lib/template';
import { requireNode } from './read';

function kindOf(n: SceneNode): LayerKind {
  if (n.type === 'TEXT') return 'text';
  if ('fills' in n) return 'shape';
  return 'other';
}

async function loadFonts(t: TextNode): Promise<void> {
  const fonts =
    t.characters.length > 0
      ? t.getRangeAllFontNames(0, t.characters.length)
      : t.fontName === figma.mixed
        ? []
        : [t.fontName];
  await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
}

function keyLayers(root: SceneNode): SceneNode[] {
  return 'findAll' in root ? root.findAll((n) => keyOf(n.name) !== null) : [];
}

export const fillTemplate: Handler<'fillTemplate'> = async ({ templateId, rows, layout }, ctx) => {
  const template = await requireNode(templateId);
  if (template.parent?.type !== 'PAGE') {
    throw new PluginError('INVALID_ARGS', '템플릿은 페이지 바로 아래 있어야 합니다', '템플릿을 프레임·섹션 밖으로 꺼내세요');
  }
  const templateKeys = new Set(keyLayers(template).map((n) => keyOf(n.name)!));

  // 이미지 바이트 → Figma 이미지 해시. 실패는 칸마다 경고로 남긴다.
  const images = ctx.binaries.map((bytes) => {
    try {
      return figma.createImage(bytes).hash;
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  });

  figma.commitUndo();
  const target: BaseNode & ChildrenMixin =
    layout === 'page' ? figma.createPage() : (template.parent as PageNode);
  if (layout === 'page') (target as PageNode).name = `${template.name} 생성`;
  const origin = layout === 'page' ? { x: 0, y: 0 } : { x: template.x + template.width + GAP, y: template.y };

  const nodeIds: string[] = [];
  const warnings: TemplateWarning[] = [];

  for (const [i, row] of rows.entries()) {
    const rowNo = i + 1;
    const copy = template.type === 'COMPONENT' ? template.createInstance() : template.clone();
    target.appendChild(copy);
    const pos = gridPosition(i, origin, template);
    copy.x = pos.x;
    copy.y = pos.y;
    copy.name = `${template.name} / ${rowNo}`;
    nodeIds.push(copy.id);

    for (const key of unknownKeys(row, templateKeys)) warnings.push({ row: rowNo, key, code: 'UNKNOWN_KEY' });

    for (const layer of keyLayers(copy)) {
      const key = keyOf(layer.name)!;
      const plan = planCell(kindOf(layer), row[key]);
      if (plan.kind === 'skip') continue;
      if (plan.kind === 'warn') {
        warnings.push({ row: rowNo, key, code: plan.code, ...(plan.detail ? { detail: plan.detail } : {}) });
        continue;
      }
      if (plan.kind === 'text') {
        const text = layer as TextNode;
        try {
          await loadFonts(text);
        } catch (e) {
          warnings.push({ row: rowNo, key, code: 'FONT_MISSING', detail: (e as Error).message });
          continue;
        }
        text.characters = plan.text;
        continue;
      }
      const hash = images[plan.asset];
      if (typeof hash !== 'string') {
        warnings.push({ row: rowNo, key, code: 'IMAGE_FAILED', detail: hash?.message ?? `이미지 ${plan.asset} 없음` });
        continue;
      }
      (layer as GeometryMixin).fills = [{ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL' }];
    }
  }
  figma.commitUndo();
  return { nodeIds, warnings };
};
```

`packages/plugin/src/handlers/index.ts` — import와 표에 추가:
```ts
import { fillTemplate } from './template';
```
```ts
  exportPdf,
  fillTemplate,
};
```
이제 표가 `MethodName` 전부를 가지므로 `handlers`의 타입을 `Partial<Handlers>`에서 `Handlers`로 바꾼다.

- [ ] **Step 5: 타입 검사·빌드**

Run: `pnpm check`
Expected: 전체 typecheck·test·build 통과

- [ ] **Step 6: 3단계 실제 확인 (사용자와 함께)**

1. 사용자: Claude Code 세션 재시작, 플러그인 재실행.
2. `execute`로 명함 템플릿을 만든다: 페이지 바로 아래 프레임 `명함`(400×240), 안에 텍스트 `{{name}}`, `{{title}}`, 사각형 `{{photo}}`.
3. `fill_template` 3행: 1행은 photo에 https 이미지 URL, 2행은 로컬 png 절대 경로, 3행은 없는 URL과 템플릿에 없는 키 `extra`.
   - 기대: 복제본 3개(`명함 / 1..3`), 오른쪽 한 줄 배치, 1·2행 사진 채워짐, warnings에 3행 `IMAGE_FAILED`, `UNKNOWN_KEY`(extra).
4. `screenshot`으로 결과 확인.
5. Figma에서 Cmd+Z 한 번 → 복제본 전부 사라짐.
6. `layout: 'page'`, `exportPdf: {}`로 7행 → 새 페이지 `명함 생성`에 5+2 배치, PDF 7쪽.
7. 컴포넌트로 바꾼 템플릿으로 한 번 더 → 인스턴스가 생기고 텍스트가 채워지는지.
8. 결과를 `docs/spike-results.md`에 "3단계 확인"으로 추가.

- [ ] **Step 7: Commit**

```bash
git add packages docs/spike-results.md
git commit -m "feat: fill_template clones a template per row, fills text and images, optional PDF"
```

---

## 4단계: 마무리

### Task 13: README와 최종 점검

**Files:**
- Create: `README.md`
- Delete: 없음 (`spike/`는 기록용으로 남긴다)

**Interfaces:**
- Consumes: 모든 도구 이름과 오류 코드
- Produces: 설치·연결·사용 안내

- [ ] **Step 1: README 작성**

`README.md`:
````markdown
# figma-relay-mcp

Claude Code에서 로컬 MCP로 Figma를 다룬다. 무료 계정으로 동작한다(Dev Mode·REST API 불필요).

- 디자인 읽기·만들기·고치기 (`execute`로 Figma Plugin API 실행)
- 프레임 여러 개를 한 PDF로 저장 (`export_pdf`)
- 템플릿을 JSON 행으로 일괄 생성하고 PDF까지 (`fill_template`)

## 설치

```bash
pnpm install
pnpm build
claude mcp add figma-relay-mcp -s user -- node "$(pwd)/packages/server/dist/index.cjs"
```

Claude Code를 새로 시작하면 서버가 뜨고 `~/.figma-relay-mcp/token`이 생긴다.

## Figma 연결

1. Figma 데스크톱 앱 → 메뉴 → Plugins → Development → Import plugin from manifest… → `packages/plugin/manifest.json`
2. 같은 메뉴에서 figma-relay-mcp 실행
3. 처음 한 번 `~/.figma-relay-mcp/token` 내용을 플러그인 창에 붙여 넣고 "토큰 저장 후 연결"
4. 상태가 "연결됨 · <파일 이름>"이면 끝. 조작하는 동안 플러그인 창을 열어 둔다.

## 도구

| 도구 | 하는 일 |
|---|---|
| `list_files` | 연결된 파일과 세션 ID |
| `get_selection` | 선택한 노드 요약 |
| `get_node` | 노드 트리 요약(depth, 500개 상한) |
| `find_nodes` | 이름 정규식으로 찾기(200개 상한) |
| `screenshot` | 노드를 PNG로 보기 |
| `execute` | Plugin API 코드 실행(Cmd+Z 한 번으로 되돌림) |
| `export_pdf` | 노드들을 순서대로 한 PDF로 저장(기본 ~/Downloads, 덮어쓰지 않음) |
| `fill_template` | 레이어 이름 `{{키}}`를 행마다 채운 복제본 생성, 선택적으로 PDF |

모든 도구는 `sessionId`를 받는다. 생략하면 가장 최근에 연결된 파일.

## 오류

| 코드 | 뜻 |
|---|---|
| `NOT_CONNECTED` | 플러그인이 실행 중이 아님 |
| `PORT_IN_USE` | 다른 Claude 세션이 포트 38451을 쓰는 중 |
| `NODE_NOT_FOUND` | 노드 ID가 없음 |
| `FONT_MISSING` | 텍스트의 폰트를 불러올 수 없음 |
| `IMAGE_FAILED` | 이미지를 읽거나 넣지 못함 |
| `TIMEOUT` | 응답이 제한 시간(기본 30초, PDF·템플릿 5분) 안에 오지 않음 |
| `EXEC_ERROR` | `execute` 코드 오류 |
| `INVALID_ARGS` | 인자가 잘못됨 |
| `IO_ERROR` | 파일 저장 등 입출력 실패 |

## 제약

- 플러그인 창이 열려 있어야 제어할 수 있다.
- Claude 세션 하나만 연결할 수 있다(고정 포트).
- PDF는 Figma 기본 출력(RGB). 인쇄용 CMYK·재단 여백은 지원하지 않는다.

## 개발

```bash
pnpm check   # typecheck → test → build
```
````

- [ ] **Step 2: 최종 점검**

Run: `pnpm check`
Expected: 통과

스펙과 대조해 빠진 항목이 없는지 확인한다(도구 8개, 오류 코드 9개, 토큰·포트·제한 시간·PDF 경로 규칙·템플릿 배치 규칙).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README with setup, tools and errors"
```
