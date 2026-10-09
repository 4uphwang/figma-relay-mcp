import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Bridge } from './bridge';
import { NOT_CONNECTED_HINT, ToolError } from './errors';
import { defaultPdfPath, expandPath, uniquePath } from './paths';
import { mergePdfs } from './pdf';

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
    {
      name: 'export_pdf',
      description:
        '노드들을 주어진 순서대로 한 PDF로 합쳐 저장한다(Figma 기본 PDF: RGB, 벡터, 텍스트 선택 가능). ' +
        'outPath 생략 시 ~/Downloads/<파일이름>-<시각>.pdf. 같은 이름이 있으면 -2, -3을 붙이고 덮어쓰지 않는다.',
      inputSchema: z.object({ ids: z.array(z.string()).min(1), outPath: z.string().optional(), sessionId }),
      handler: async (a: { ids: string[]; outPath?: string; sessionId?: string }) =>
        json(await exportPdfToFile(deps, a.ids, a.outPath, a.sessionId)),
    },
  ];
}
