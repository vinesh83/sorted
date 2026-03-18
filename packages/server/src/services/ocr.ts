import Tesseract from 'tesseract.js';
import mammoth from 'mammoth';

// pdf-parse has ESM compatibility issues — lazy load to handle both tsx and compiled contexts
let _pdfParse: ((buffer: Buffer, options?: Record<string, unknown>) => Promise<{ text: string; numpages: number }>) | null = null;

async function getPdfParse() {
  if (_pdfParse) return _pdfParse;
  try {
    // Try ESM dynamic import first (works in compiled output)
    const mod = await import('pdf-parse');
    _pdfParse = (mod as any).default || mod;
  } catch {
    // Fallback to createRequire for tsx/dev mode
    const { createRequire } = await import('module');
    const req = createRequire(import.meta.url);
    _pdfParse = req('pdf-parse');
  }
  return _pdfParse!;
}

const MAX_PAGES_OCR = 20;
const MIN_CHARS_PER_PAGE = 50;

export interface OcrResult {
  text: string;
  partial: boolean; // true if capped at MAX_PAGES_OCR
}

export async function extractText(
  fileBuffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<OcrResult> {
  switch (mimeType) {
    case 'application/pdf':
      return extractFromPdf(fileBuffer);
    case 'image/jpeg':
    case 'image/png':
      return extractFromImage(fileBuffer);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return extractFromDocx(fileBuffer);
    default:
      console.warn(`[ocr] Unsupported mime type: ${mimeType} for ${fileName}`);
      return { text: '', partial: false };
  }
}

async function extractFromPdf(buffer: Buffer): Promise<OcrResult> {
  try {
    // Lazy-load pdf-parse
    const pdfParse = await getPdfParse();
    // Try text extraction first (text-based PDFs)
    const parsed = await pdfParse(buffer, { max: MAX_PAGES_OCR });
    const pageCount = parsed.numpages;
    const text = parsed.text.trim();

    // Check if we got meaningful text
    if (text.length > MIN_CHARS_PER_PAGE * Math.min(pageCount, MAX_PAGES_OCR)) {
      console.log(`[ocr] PDF text extraction: ${text.length} chars from ${pageCount} pages`);
      return { text, partial: pageCount > MAX_PAGES_OCR };
    }

    // If little/no text, it's likely scanned — fall back to Tesseract OCR
    // For now, use what pdf-parse gave us + note it may need image-based OCR
    if (text.length > 0) {
      console.log(`[ocr] PDF has sparse text (${text.length} chars, ${pageCount} pages), using what we got`);
      return { text, partial: pageCount > MAX_PAGES_OCR };
    }

    // No text at all — scanned PDF. Convert pages to images via pdftoppm and OCR each.
    console.log('[ocr] PDF has no text layer — converting to images for OCR');
    return await ocrScannedPdf(buffer, pageCount);
  } catch (err) {
    console.error('[ocr] PDF extraction failed:', err);
    return { text: '', partial: false };
  }
}

async function extractFromImage(buffer: Buffer): Promise<OcrResult> {
  return await ocrWithTesseract(buffer);
}

async function extractFromDocx(buffer: Buffer): Promise<OcrResult> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value.trim(), partial: false };
  } catch (err) {
    console.error('[ocr] DOCX extraction failed:', err);
    return { text: '', partial: false };
  }
}

async function ocrScannedPdf(buffer: Buffer, pageCount: number): Promise<OcrResult> {
  const { execSync } = await import('child_process');
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');

  const tmpDir = os.default.tmpdir();
  const id = `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpPdf = path.default.join(tmpDir, `${id}.pdf`);
  const tmpPrefix = path.default.join(tmpDir, id);

  fs.default.writeFileSync(tmpPdf, buffer);

  const pagesToOcr = Math.min(pageCount, MAX_PAGES_OCR);
  let allText = '';
  const partial = pageCount > MAX_PAGES_OCR;

  try {
    // Convert pages to JPEG images
    execSync(`pdftoppm -jpeg -r 200 -f 1 -l ${pagesToOcr} "${tmpPdf}" "${tmpPrefix}"`, { timeout: 60000 });

    // Find generated images and OCR each
    const files = fs.default.readdirSync(tmpDir)
      .filter((f: string) => f.startsWith(id) && f.endsWith('.jpg'))
      .sort();

    for (const imgFile of files) {
      const imgPath = path.default.join(tmpDir, imgFile);
      const imgBuffer = fs.default.readFileSync(imgPath);
      const result = await ocrWithTesseract(imgBuffer);
      allText += result.text + '\n';
      fs.default.unlinkSync(imgPath);
    }

    console.log(`[ocr] Scanned PDF OCR: ${allText.length} chars from ${files.length} pages`);
  } catch (err) {
    console.error('[ocr] pdftoppm/OCR failed:', err);
  } finally {
    try { fs.default.unlinkSync(tmpPdf); } catch {}
  }

  return { text: allText.trim(), partial };
}

async function ocrWithTesseract(buffer: Buffer): Promise<OcrResult> {
  try {
    const { data } = await Tesseract.recognize(buffer, 'eng+spa', {
      logger: (info) => {
        if (info.status === 'recognizing text') {
          // Only log progress at 25% intervals to reduce noise
          const pct = Math.round((info.progress || 0) * 100);
          if (pct % 25 === 0) {
            console.log(`[ocr] Tesseract: ${pct}%`);
          }
        }
      },
    });
    console.log(`[ocr] Tesseract extracted ${data.text.length} chars, confidence: ${data.confidence}%`);
    return { text: data.text.trim(), partial: false };
  } catch (err) {
    console.error('[ocr] Tesseract OCR failed:', err);
    return { text: '', partial: false };
  }
}
