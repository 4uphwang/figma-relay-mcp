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
