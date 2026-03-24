import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

interface ConvertOptions {
  dpi?: number;
  firstPage?: number;
  lastPage?: number;
}

/**
 * Convert a PDF buffer to an array of JPEG image buffers (one per page).
 * Uses poppler's pdftoppm. Returns empty array on failure.
 */
export async function convertPdfToImages(
  pdfBuffer: Buffer,
  options?: ConvertOptions,
): Promise<Buffer[]> {
  const dpi = options?.dpi ?? 150;
  const id = `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpDir = os.tmpdir();
  const tmpPdf = path.join(tmpDir, `${id}.pdf`);
  const tmpPrefix = path.join(tmpDir, id);

  fs.writeFileSync(tmpPdf, pdfBuffer);

  try {
    const args = ['-jpeg', '-r', String(dpi)];
    if (options?.firstPage) args.push('-f', String(options.firstPage));
    if (options?.lastPage) args.push('-l', String(options.lastPage));
    args.push(tmpPdf, tmpPrefix);

    await execFileAsync('pdftoppm', args, { timeout: 60000 });

    // Find all generated JPEG files and sort by name (page order)
    const files = fs.readdirSync(tmpDir)
      .filter((f) => f.startsWith(id) && f.endsWith('.jpg'))
      .sort();

    const images: Buffer[] = [];
    for (const file of files) {
      const filePath = path.join(tmpDir, file);
      images.push(fs.readFileSync(filePath));
      fs.unlinkSync(filePath);
    }

    return images;
  } catch (err) {
    console.warn(`[pdf-utils] pdftoppm failed:`, err instanceof Error ? err.message : err);
    // Clean up any partial output
    try {
      const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith(id) && f.endsWith('.jpg'));
      for (const file of files) fs.unlinkSync(path.join(tmpDir, file));
    } catch { /* ignore cleanup errors */ }
    return [];
  } finally {
    try { fs.unlinkSync(tmpPdf); } catch { /* ignore */ }
  }
}
