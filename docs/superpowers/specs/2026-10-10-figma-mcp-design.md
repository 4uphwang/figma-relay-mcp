# figma-mcp 설계

날짜: 2026-10-10

## 목표

Claude Code가 로컬 MCP 서버를 통해 Figma를 제어한다. 세 가지 용도를 모두 다룬다.

1. 디자인 생성·수정 (프레임, 텍스트, 오토레이아웃 등)
2. 프레임 여러 개를 한 PDF로 내보내기 (공유용)
3. 템플릿 일괄 생성: Claude가 넘긴 JSON 행으로 템플릿을 복제·채우고 PDF로 출력

## 제약

- **무료(Starter) 계정만으로 전부 동작해야 한다.** Dev Mode, Figma 공식 Dev Mode MCP, REST API, 개인 액세스 토큰을 쓰지 않는다.
- 플러그인은 디자인 모드 전용(`editorType: ["figma"]`)이다. 커뮤니티에 게시하지 않고, 데스크톱 앱의 "Import plugin from manifest"로 개발 플러그인으로 불러온다.
- MCP로 제어하려면 대상 파일에서 플러그인 창이 열려 있어야 한다(Figma 플러그인 구조상 피할 수 없음).
- 플러그인 main 스레드는 네트워크와 파일 시스템을 쓸 수 없다. 네트워크는 UI iframe이, 파일 읽기·쓰기는 서버가 맡는다.

## 범위에서 뺀 것

인쇄용 PDF(CMYK, bleed, 재단선), 여러 Claude 세션 동시 연결, 커뮤니티 게시, Dev Mode 기능, Figma REST API, 로컬 데이터 파일(CSV·엑셀) 직접 읽기(데이터는 Claude가 JSON으로 넘긴다).

## 구조

pnpm 워크스페이스, TypeScript. 패키지 세 개:

| 패키지 | 역할 | 실행 위치 |
|---|---|---|
| `packages/protocol` | 서버↔플러그인 메시지 타입(zod 스키마). 양쪽이 공유 | 둘 다 |
| `packages/server` | MCP 서버(stdio) + WebSocket 서버(`127.0.0.1` 고정 포트). PDF 합치기(`pdf-lib`), 파일 저장, 이미지 읽기·다운로드 | Claude Code가 띄우는 Node 프로세스 |
| `packages/plugin` | `ui.html`(WebSocket 클라이언트, 연결 상태·토큰 입력) + `code.ts`(figma API 실행) | Figma 데스크톱 앱 |

### 요청 흐름

```
Claude Code ─stdio─▶ server ─WebSocket─▶ plugin UI ─postMessage─▶ plugin main (figma API)
```

1. MCP 도구 호출 → 서버가 요청 ID를 붙여 WebSocket으로 보낸다.
2. UI가 받아 `postMessage`로 main에 넘기고, main이 실행한다.
3. 결과(JSON 또는 바이너리)가 같은 길로 돌아오고, 서버가 ID로 짝지어 응답한다.
4. 제한 시간: 기본 30초, `export_pdf`·`fill_template`은 5분.
5. 한 플러그인에 가는 요청은 한 번에 하나씩 처리한다(앞 요청이 끝나야 다음이 시작).

### 연결

- 플러그인은 연결 직후 `{sessionId, fileName, currentPage}`를 등록한다. 대상 파일은 도구의 `sessionId` 인자로 고르고, 없으면 가장 최근에 연결된 세션을 쓴다.
- 끊기면 UI가 1·2·4·…초(최대 30초) 간격으로 다시 연결한다.
- 연결된 플러그인이 없으면 도구는 `NOT_CONNECTED`("Figma에서 플러그인을 실행하세요")를 돌려준다.
- 포트가 이미 쓰이면 서버는 MCP만 살아 있고, 모든 도구가 그 사실을 오류로 알린다.

### 보안

- `127.0.0.1`에만 바인딩한다.
- 서버는 `~/.figma-mcp/token`에 토큰을 만들어 두고(없을 때만 생성, 권한 600), 연결 첫 메시지의 토큰이 다르면 끊는다. 사용자는 토큰을 플러그인 UI에 한 번 붙여 넣고, 플러그인은 `figma.clientStorage`에 저장한다.

## 도구

모든 도구는 선택 인자 `sessionId`를 받는다.

| 도구 | 입력 | 출력 |
|---|---|---|
| `list_files` | 없음 | 연결된 세션 목록(sessionId, 파일 이름, 현재 페이지) |
| `get_selection` | 없음 | 선택 노드 요약 |
| `get_node` | `id`, `depth`(기본 2) | 노드 트리(id, name, type, x/y/width/height, 텍스트, 오토레이아웃, children). 응답 노드 수 상한 500 |
| `find_nodes` | `query`(이름 정규식), `type?`, `pageId?` | 일치 노드 목록(최대 200) |
| `screenshot` | `id`, `scale`(기본 1) | MCP 이미지(PNG, 긴 변 최대 2048px로 scale 자동 조정) |
| `execute` | `code`(async 함수 본문) | `return` 값(JSON) |
| `export_pdf` | `ids`(순서대로), `outPath?` | `{path, pages, bytes}` |
| `fill_template` | `templateId`, `rows`(객체 배열), `layout`(`grid`\|`page`, 기본 `grid`), `exportPdf?`(`{outPath?}`) | `{nodeIds, warnings, pdf?}` |

### `execute`

- 코드를 `figma`를 쓸 수 있는 async 함수로 감싸 실행한다.
- 실행 전에 `figma.commitUndo()`를 불러 Cmd+Z 한 번으로 되돌릴 수 있게 한다.
- 반환값은 JSON 가능한 값만 받는다. 노드는 `{id, name, type}`으로 바꾼다.
- 예외는 `EXEC_ERROR`로 메시지와 스택을 돌려준다.

### `export_pdf`

- 플러그인이 노드마다 `exportAsync({format: 'PDF'})`를 차례로 실행하고, 결과를 바로 바이너리 프레임으로 서버에 보낸다(메모리 상한).
- 서버는 `pdf-lib`으로 받은 순서대로 페이지를 합쳐 저장한다.
- `outPath`가 없으면 `~/Downloads/<파일이름>-<YYYYMMDD-HHmmss>.pdf`. 경로에 파일이 이미 있으면 `-2`, `-3`…을 붙인다(덮어쓰지 않음).
- 화질: Figma 기본 PDF(RGB, 벡터, 텍스트 선택 가능) 그대로.

### `fill_template`

- 키 규칙: 템플릿 안에서 이름이 정확히 `{{키}}`인 레이어가 그 키의 자리다.
  - TEXT 노드 → 문자열로 바꾼다. 먼저 그 노드에 쓰인 폰트를 모두 `loadFontAsync`한다.
  - fills를 가진 도형 노드 → 값(URL 또는 로컬 절대 경로)을 이미지로 채운다(`scaleMode: FILL`). 바이트는 **서버**가 읽거나 내려받아 보낸다(iframe fetch는 CORS에 막힐 수 있음). 플러그인은 `figma.createImage`로 채운다.
- 배치: `grid`는 템플릿 오른쪽에 간격 40px로 한 줄 최대 5개, `page`는 새 페이지 `<템플릿 이름> 생성`에 같은 격자로 놓는다.
- 복제본 이름은 `<템플릿 이름> / <행 번호>`.
- 행에 없는 키, 템플릿에 없는 키, 폰트 없음, 이미지 실패는 그 행을 만들되 `warnings`에 `{row, key, code}`로 남긴다.
- 전체를 한 undo 단위로 묶는다.
- `exportPdf`가 있으면 만든 노드로 `export_pdf`를 이어서 실행한다. 노드를 만든 뒤 PDF 단계가 실패하면 결과에 `nodeIds`·`warnings`를 그대로 두고 `pdfError {code,message,hint?}`를 더한다.
- 템플릿은 페이지 바로 아래 있어야 한다(아니면 `INVALID_ARGS`). 컴포넌트 템플릿은 인스턴스를 만든다.
- 텍스트를 넣다가 throw하면 `FONT_MISSING`, 이미지 채우기에서 throw하면 `IMAGE_FAILED` 경고가 된다.
- 예상 못 한 오류가 나도 이미 만든 복제본은 남고, 전체는 여전히 한 undo 단위다.
- 이미지 처리: `image/*` 응답만 받고, 이미지당 20MB, 전체 200MB, 동시 다운로드 4개까지. 값이 http(s) URL이거나 이미지 확장자의 절대 경로이면 이미지 출처로 취급한다(텍스트 레이어에 넣으면 출처 문자열이 그대로 보인다).

### 오류

모든 도구는 실패 시 `{code, message, hint}`를 돌려준다. 단, 인자 검증 오류는 MCP SDK가 `{code,…}` 대신 "Input validation error" 일반 텍스트로 돌려준다.

`NOT_CONNECTED`, `PORT_IN_USE`, `NODE_NOT_FOUND`, `FONT_MISSING`, `IMAGE_FAILED`, `TIMEOUT`, `EXEC_ERROR`, `INVALID_ARGS`, `IO_ERROR`

## 구현 전에 확인할 위험 (1단계 맨 앞, 실험)

1. 플러그인 샌드박스에서 `new Function`/`eval`이 되는가. 안 되면 `execute`를 JSON 명령어 목록 해석 방식으로 바꾸고 설계를 다시 검토한다.
2. 개발 플러그인 UI iframe에서 `ws://127.0.0.1:<port>`에 연결되는가(`networkAccess.devAllowedDomains`).
3. 무료 계정 데스크톱 앱에서 개발 플러그인을 불러와 `exportAsync({format:'PDF'})`가 되는가.

하나라도 막히면 구현을 멈추고 설계로 돌아온다.

## 테스트

- `protocol`: zod 스키마 왕복 단위 테스트.
- `server`: 가짜 플러그인(WebSocket 클라이언트)으로 통합 테스트. 요청·응답 짝짓기, 제한 시간, 끊김과 재연결, 토큰 거부, 포트 충돌, PDF 합치기(샘플 PDF 바이트 → 페이지 수·순서), 저장 경로 충돌 시 이름 붙이기.
- `plugin`: figma 전역 가짜로 handler 단위 테스트. 템플릿 키 찾기, 폰트 모으기, 노드 요약·상한, 배치 좌표.
- 실제 Figma: 단계마다 무료 계정 데스크톱 앱 + Claude Code로 수동 체크리스트를 돌린다.

## 구현 단계

각 단계가 끝나면 실제로 쓸 수 있다.

1. **토대**: 위험 확인 → protocol → server(MCP, WebSocket, 토큰, 세션) → plugin(연결 UI, 재연결) → `list_files`, `get_selection`, `get_node`, `find_nodes`, `screenshot`, `execute`
2. **PDF**: 바이너리 전송 → `export_pdf`
3. **템플릿**: `fill_template`(복제, 배치, 텍스트·이미지, 경고) → `exportPdf` 연결
4. **마무리**: README(설치, `claude mcp add`로 등록, 플러그인 불러오기, 토큰 붙여 넣기), 오류 메시지 다듬기
