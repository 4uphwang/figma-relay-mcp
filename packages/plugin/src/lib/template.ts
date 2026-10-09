import type { CellValue, TemplateRow, WarningCode } from '@figma-mcp/protocol/types';

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
