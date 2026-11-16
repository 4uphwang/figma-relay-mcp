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

## 여러 Claude 세션

Figma 플러그인과 붙는 일은 백그라운드 허브 하나가 맡는다(포트 38451). Claude 세션마다 뜨는 서버는 허브에 붙어 요청을 넘기므로 여러 세션이 동시에 Figma를 쓸 수 있다.

- 허브가 없으면 처음 도구를 부르는(또는 처음 뜬) 세션이 `node …/index.cjs --hub`로 띄운다. 로그는 `~/.figma-relay-mcp/hub.log`.
- 허브는 스스로 꺼지지 않는다. Claude 세션을 모두 닫아도 떠 있어서 플러그인 연결이 유지된다.
- `pnpm hub:install`로 launchd 에이전트(`~/Library/LaunchAgents/com.figma-relay-mcp.hub.plist`)를 등록하면 로그인할 때 허브가 켜지고, 죽거나 재시작하면 launchd가 바로 다시 띄운다. `pnpm hub:status`로 상태, `pnpm hub:uninstall`로 해제. 에이전트 허브(`--hub --stay`)는 다른 허브가 포트를 잡고 있으면 비워질 때까지 기다린다.
- 플러그인 창의 「서버 재시작」(연결됨 상태, 3초 안에 두 번 누름)은 허브를 끄고 새 빌드로 다시 띄운다. launchd 에이전트가 없으면 허브가 끝나기 전에 새 허브를 직접 띄운다. 진행 중인 요청은 끊긴다.
- `pnpm build` 뒤 새로 시작한 세션이 옛 빌드의 허브를 만나면 허브를 내리고 새 빌드로 다시 띄운다(그 순간 다른 세션의 진행 중 요청은 `NOT_CONNECTED`로 끝난다).
- 플러그인 활동 기록에 요청을 보낸 세션의 작업 폴더 이름이 붙는다.
- 같은 파일을 여러 세션이 `execute`로 고치면 서로 덮어쓸 수 있다. 플러그인이 요청을 하나씩 처리하므로 코드가 섞이지는 않는다. 세션마다 다른 파일을 맡기는 것이 안전하다.

## Figma 연결

1. Figma 데스크톱 앱 → 메뉴 → Plugins → Development → Import plugin from manifest… → `packages/plugin/manifest.json`
2. 같은 메뉴에서 figma-relay-mcp 실행
3. 처음 한 번 `~/.figma-relay-mcp/token` 내용을 플러그인 창에 붙여 넣고 "저장하고 연결"
4. 상태가 "연결됨"이면 끝. 조작하는 동안 플러그인 창을 열어 둔다. 창에 요청 기록(성공·실패, 실행한 코드, 「보기」로 노드 선택)이 파일마다 50건 남는다. 머리의 – 단추로 상태 막대만 남게 접을 수 있고, 접어도 페이지 목록이 남아 Figma UI를 숨긴(⌘\\) 채로 페이지를 옮길 수 있다. 플러그인 창에 포커스가 있으면 ⌃1~⌃9로 n번째 페이지로 간다(구분선 페이지는 세지 않는다).

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

모든 도구는 `sessionId`를 받는다. 연결된 파일이 하나일 때만 생략할 수 있고, 둘 이상이면 `INVALID_ARGS`.
세션 ID는 파일마다 고정이라 플러그인을 다시 실행해도 같다(플러그인 창의 "ID"). 같은 파일을 탭 두 개로 열거나 복제한 파일을 함께 열면 나중에 붙은 쪽이 `<ID>-2`를 받는다.

## 오류

| 코드 | 뜻 |
|---|---|
| `NOT_CONNECTED` | 플러그인이 실행 중이 아님 |
| `PORT_IN_USE` | 허브가 아닌 프로세스(옛 버전 figma-relay-mcp 등)가 포트 38451을 쓰는 중 |
| `NODE_NOT_FOUND` | 노드 ID가 없음 |
| `FONT_MISSING` | 텍스트의 폰트를 불러올 수 없음 |
| `IMAGE_FAILED` | 이미지를 읽거나 넣지 못함 |
| `TIMEOUT` | 응답이 제한 시간(기본 30초, PDF·템플릿 5분) 안에 오지 않음 |
| `EXEC_ERROR` | `execute` 코드 오류 |
| `INVALID_ARGS` | 인자가 잘못됨 |
| `IO_ERROR` | 파일 저장 등 입출력 실패 |

## 제약

- 플러그인 창이 열려 있어야 제어할 수 있다.
- PDF는 Figma 기본 출력(RGB). 인쇄용 CMYK·재단 여백은 지원하지 않는다.
- `fill_template`의 템플릿은 페이지 바로 아래 있어야 한다(프레임·섹션 안이면 `INVALID_ARGS`).
- `fill_template` 중 `TIMEOUT`이 나도 이미 만들어진 노드가 남아 있을 수 있다. `find_nodes`로 `<템플릿 이름> / n`을 찾거나 Cmd+Z로 되돌린다.
- `fill_template` 이미지: `image/*` 응답만, 이미지당 20MB, 전체 200MB까지.

## 개발

```bash
pnpm check   # typecheck → test → build
```

## 라이선스

MIT
