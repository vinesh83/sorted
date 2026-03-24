import { getDb } from '../db/connection.js';
import { downloadFile } from './dropbox.js';
import { extractText } from './ocr.js';
import { classifyDocument, logUsage } from './classifier.js';
import { putCache } from './filecache.js';
import { convertPdfToImages } from './pdf-utils.js';

// Concurrency limit for processing
const MAX_CONCURRENT = 3;
let activeCount = 0;
const queue: Array<() => Promise<void>> = [];

function runNext() {
  if (activeCount >= MAX_CONCURRENT || queue.length === 0) return;
  activeCount++;
  const task = queue.shift()!;
  task().finally(() => {
    activeCount--;
    runNext();
  });
}

export async function processFile(processedFileId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    queue.push(async () => {
      try {
        await doProcess(processedFileId);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    runNext();
  });
}

async function doProcess(processedFileId: number): Promise<void> {
  const db = getDb();

  const file = db.prepare('SELECT * FROM processed_files WHERE id = ?').get(processedFileId) as {
    id: number;
    dropbox_path: string;
    file_name: string;
    mime_type: string;
    paralegal_name: string;
  } | undefined;

  if (!file) {
    console.error(`[pipeline] File not found: ${processedFileId}`);
    return;
  }

  console.log(`[pipeline] Processing: ${file.file_name}`);

  let extractedText = '';
  let ocrPartial = false;
  let fileBuffer: Buffer;

  try {
    // Step 1: Download file from Dropbox and cache locally
    fileBuffer = await downloadFile(file.dropbox_path);
    putCache(processedFileId, fileBuffer);
    console.log(`[pipeline] Downloaded & cached ${file.file_name} (${fileBuffer.length} bytes)`);

    // Step 2: OCR / text extraction (still useful as supplementary context)
    const ocrResult = await extractText(fileBuffer, file.mime_type || 'application/octet-stream', file.file_name);
    extractedText = ocrResult.text;
    ocrPartial = ocrResult.partial;

    if (extractedText) {
      console.log(`[pipeline] Extracted ${extractedText.length} chars from ${file.file_name}`);
    } else {
      console.log(`[pipeline] No text extracted from ${file.file_name}`);
    }
  } catch (err) {
    console.error(`[pipeline] Download/OCR error for ${file.file_name}:`, err);
    db.prepare("UPDATE processed_files SET status = 'error' WHERE id = ?").run(processedFileId);

    db.prepare(`
      INSERT INTO documents (processed_file_id, classification_error, status, created_at)
      VALUES (?, ?, 'unclassified', datetime('now'))
    `).run(processedFileId, err instanceof Error ? err.message : String(err));
    return;
  }

  // Step 3: Convert to page images for vision classification
  let pageImages: Buffer[] = [];
  let imageMimeType = 'image/jpeg';

  if (file.mime_type === 'application/pdf') {
    pageImages = await convertPdfToImages(fileBuffer, { dpi: 150 });
    if (pageImages.length > 0) {
      console.log(`[pipeline] Converted ${pageImages.length} PDF pages to images`);
    } else {
      console.warn(`[pipeline] PDF image conversion failed for ${file.file_name}, using text-only`);
    }
  } else if (file.mime_type?.startsWith('image/')) {
    pageImages = [fileBuffer];
    imageMimeType = file.mime_type;
  }
  // DOCX/DOC/other: pageImages stays empty → text-only classification

  // Must have either images or text to classify
  if (pageImages.length === 0 && !extractedText) {
    console.error(`[pipeline] No images or text available for ${file.file_name}`);
    db.prepare("UPDATE processed_files SET status = 'ocr_failed' WHERE id = ?").run(processedFileId);
    db.prepare(`
      INSERT INTO documents (processed_file_id, extracted_text, ocr_partial, classification_error, status, created_at)
      VALUES (?, '', ?, 'No text or images available for classification', 'unclassified', datetime('now'))
    `).run(processedFileId, ocrPartial ? 1 : 0);
    return;
  }

  // Step 4: AI classification with vision + text
  try {
    const { classification, inputTokens, outputTokens } = await classifyDocument(
      pageImages, extractedText, file.file_name, imageMimeType,
    );

    const requestType = pageImages.length > 0 ? 'vision_classification' : 'classification';
    const storedText = extractedText || (pageImages.length > 0 ? '(classified via vision)' : '');

    // Insert document with classification
    const result = db.prepare(`
      INSERT INTO documents (
        processed_file_id, extracted_text, ocr_partial,
        document_label, client_name, description, event_type, suggested_section,
        document_date, confidence, is_legal_document,
        status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
    `).run(
      processedFileId,
      storedText,
      ocrPartial ? 1 : 0,
      classification.documentLabel,
      classification.clientName,
      classification.description,
      classification.eventType,
      classification.suggestedSection,
      classification.documentDate,
      classification.confidence,
      classification.isLegalDocument ? 1 : 0,
    );

    const documentId = Number(result.lastInsertRowid);

    // Log API usage
    logUsage(documentId, inputTokens, outputTokens, requestType);

    // Handle multi-doc detection
    if (classification.isMultipleDocuments && classification.suggestedSplits?.length > 0) {
      db.prepare(`
        INSERT INTO split_suggestions (processed_file_id, suggested_splits, status)
        VALUES (?, ?, 'pending')
      `).run(processedFileId, JSON.stringify(classification.suggestedSplits));
      console.log(`[pipeline] Multi-doc detected: ${classification.suggestedSplits.length} splits suggested`);
    }

    db.prepare("UPDATE processed_files SET status = 'classified' WHERE id = ?").run(processedFileId);
    console.log(`[pipeline] Classified: ${file.file_name} → ${classification.documentLabel} (${Math.round(classification.confidence * 100)}%)`);
  } catch (err) {
    console.error(`[pipeline] Classification error for ${file.file_name}:`, err);

    // Still save the document with OCR text but no classification
    db.prepare(`
      INSERT INTO documents (processed_file_id, extracted_text, ocr_partial, classification_error, status, created_at)
      VALUES (?, ?, ?, ?, 'unclassified', datetime('now'))
    `).run(processedFileId, extractedText, ocrPartial ? 1 : 0, err instanceof Error ? err.message : String(err));

    db.prepare("UPDATE processed_files SET status = 'classification_failed' WHERE id = ?").run(processedFileId);
  }
}
