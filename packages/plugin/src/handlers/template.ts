import type { TemplateWarning } from '@figma-mcp/protocol/types';
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

  const nodeIds: string[] = [];
  const warnings: TemplateWarning[] = [];

  figma.commitUndo();
  try {
    const target: BaseNode & ChildrenMixin =
      layout === 'page' ? figma.createPage() : (template.parent as PageNode);
    if (layout === 'page') (target as PageNode).name = `${template.name} 생성`;
    const origin = layout === 'page' ? { x: 0, y: 0 } : { x: template.x + template.width + GAP, y: template.y };

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
          try {
            text.characters = plan.text;
          } catch (e) {
            warnings.push({ row: rowNo, key, code: 'FONT_MISSING', detail: (e as Error).message });
          }
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
  } finally {
    figma.commitUndo();
  }
  return { nodeIds, warnings };
};
