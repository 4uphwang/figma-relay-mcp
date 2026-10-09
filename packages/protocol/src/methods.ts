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
