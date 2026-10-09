# figma-mcp

Claude Code에서 로컬 MCP로 Figma를 다룬다. 무료 계정으로 동작한다(Dev Mode·REST API 불필요).

- 디자인 읽기·만들기·고치기 (`execute`로 Figma Plugin API 실행)
- 프레임 여러 개를 한 PDF로 저장 (`export_pdf`)
- 템플릿을 JSON 행으로 일괄 생성하고 PDF까지 (`fill_template`)

## 설치

```bash
pnpm install
pnpm build
claude mcp add figma-mcp -s user -- node "$(pwd)/packages/server/dist/index.cjs"
```

Claude Code를 새로 시작하면 서버가 뜨고 `~/.figma-mcp/token`이 생긴다.

## Figma 연결

1. Figma 데스크톱 앱 → 메뉴 → Plugins → Development → Import plugin from manifest… → `packages/plugin/manifest.json`
2. 같은 메뉴에서 figma-mcp 실행
3. 처음 한 번 `~/.figma-mcp/token` 내용을 플러그인 창에 붙여 넣고 "토큰 저장 후 연결"
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
| `fill_template` | 레이어 이름 `{{키}}`를 행마다 채운 복제본 생성, 선택적으로 PDF(PDF 단계가 실패하면 노드는 남기고 `pdfError`를 붙여 돌려준다) |

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
- `fill_template`의 템플릿은 페이지 바로 아래 있어야 한다(프레임·섹션 안이면 `INVALID_ARGS`).

## 개발

```bash
pnpm check   # typecheck → test → build
```
