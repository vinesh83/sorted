import { PDFDocument } from 'pdf-lib';

export interface SplitRange {
  pageStart: number;
  pageEnd: number;
  reason?: string;
}

/**
 * Extract a page range from a PDF buffer and return a new PDF buffer.
 * Pages are 1-indexed (matching the AI's output).
 */
export async function extractPages(
  pdfBuffer: Buffer,
  pageStart: number,
  pageEnd: number,
): Promise<Buffer> {
  const srcDoc = await PDFDocument.load(pdfBuffer);
  const totalPages = srcDoc.getPageCount();

  // Clamp to valid range
  const start = Math.max(1, pageStart);
  const end = Math.min(totalPages, pageEnd);

  if (start > end) {
    throw new Error(`Invalid page range: ${start}-${end} (document has ${totalPages} pages)`);
  }

  const newDoc = await PDFDocument.create();
  // pdf-lib uses 0-indexed pages
  const pageIndices = Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i);
  const copiedPages = await newDoc.copyPages(srcDoc, pageIndices);
  copiedPages.forEach((page) => newDoc.addPage(page));

  const bytes = await newDoc.save();
  return Buffer.from(bytes);
}
