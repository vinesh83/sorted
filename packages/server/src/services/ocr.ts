import Tesseract from 'tesseract.js';
// @ts-expect-error pdf-parse has no proper ESM export
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

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

    // No text at all — try Tesseract on the raw buffer
    // Note: Tesseract.js can handle PDFs directly in some cases
    console.log('[ocr] PDF has no text layer, attempting Tesseract OCR...');
    return await ocrWithTesseract(buffer);
  } catch (err) {
    console.error('[ocr] PDF extraction failed, trying Tesseract:', err);
    return await ocrWithTesseract(buffer);
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
