import type { WireError } from '@figma-relay-mcp/protocol/types';

export const HISTORY_LIMIT = 50;
const CODE_LIMIT = 2000;
const NODE_ID_LIMIT = 20;
const NODE_ID = /^I?\d+:\d+(;\d+:\d+)*$/;

export interface HistoryEntry {
  id: string;
  method: string;
  at: number;
  ms?: number; // 응답 전에는 없다
  ok?: boolean;
  summary: string;
  client?: string; // 요청을 보낸 Claude 세션(작업 폴더)
  nodeIds: string[];
  code?: string;
  error?: { code: string; message: string };
}

// MCP 도구 이름(get_node)으로 보여 준다
export const toolName = (method: string) => method.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function summarize(method: string, params: unknown): string {
  const p = isRecord(params) ? params : {};
  if (method === 'execute' && typeof p.code === 'string') {
    const line = p.code
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('//'));
    return line ?? '';
  }
  if (typeof p.id === 'string') return p.id;
  if (typeof p.query === 'string') return p.query;
  if (Array.isArray(p.ids)) return `노드 ${p.ids.length}개`;
  if (Array.isArray(p.rows)) return `${p.rows.length}행`;
  return '';
}

// 요청이 가리키거나 결과로 돌아온 노드. 템플릿 원본(templateId)은 넣지 않는다.
export function collectNodeIds(params: unknown, result: unknown): string[] {
  const ids = new Set<string>();
  const p = isRecord(params) ? params : {};
  if (typeof p.id === 'string' && NODE_ID.test(p.id)) ids.add(p.id);
  if (Array.isArray(p.ids)) for (const id of p.ids) if (typeof id === 'string' && NODE_ID.test(id)) ids.add(id);

  // 문자열은 배열 안에 있을 때만 노드 id로 본다(fillTemplate의 nodeIds). getStatus의 currentPage.id 같은 값은 넣지 않는다.
  const walk = (v: unknown, depth: number, inArray = false) => {
    if (ids.size >= NODE_ID_LIMIT || depth > 6) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1, true);
      return;
    }
    if (typeof v === 'string') {
      if (inArray && NODE_ID.test(v)) ids.add(v);
      return;
    }
    if (!isRecord(v)) return;
    if (typeof v.id === 'string' && typeof v.type === 'string' && NODE_ID.test(v.id)) {
      if (v.type !== 'PAGE' && v.type !== 'DOCUMENT') ids.add(v.id);
      return; // 자식은 이미 부모 안에 보인다
    }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(result, 0);
  return [...ids].slice(0, NODE_ID_LIMIT);
}

export function startEntry(id: string, method: string, params: unknown, at: number, client?: string): HistoryEntry {
  const code = method === 'execute' && isRecord(params) && typeof params.code === 'string' ? params.code : undefined;
  return {
    id,
    method,
    at,
    summary: summarize(method, params),
    ...(client ? { client } : {}),
    nodeIds: collectNodeIds(params, undefined),
    code: code && code.length > CODE_LIMIT ? `${code.slice(0, CODE_LIMIT)}\n…` : code,
  };
}

export function finishEntry(
  entry: HistoryEntry,
  params: unknown,
  response: { ok: true; result: unknown } | { ok: false; error: WireError },
  at: number,
): HistoryEntry {
  return {
    ...entry,
    ms: at - entry.at,
    ok: response.ok,
    nodeIds: response.ok ? collectNodeIds(params, response.result) : [], // 실패한 요청의 대상은 없을 수 있다
    error: response.ok ? undefined : { code: response.error.code, message: withoutStack(response.error.message) },
  };
}

// execute 오류에 붙는 "    at …" 줄(플러그인 내부 위치)은 기록에서 뺀다
export const withoutStack = (message: string) =>
  message
    .split('\n')
    .filter((l) => !/^\s+at /.test(l))
    .join('\n')
    .trim();

// 저장된 값을 믿지 않는다(예전 형식, 손상)
export function loadHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (e): e is HistoryEntry =>
        isRecord(e) && typeof e.id === 'string' && typeof e.method === 'string' && typeof e.at === 'number' && Array.isArray(e.nodeIds),
    )
    .map((e) => (e.ok === undefined ? { ...e, ok: false, error: { code: 'INTERRUPTED', message: '응답 전에 플러그인이 닫혔습니다' } } : e))
    .slice(0, HISTORY_LIMIT) as HistoryEntry[];
}
