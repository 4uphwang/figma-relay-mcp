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
