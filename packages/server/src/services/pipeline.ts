import { getDb } from '../db/connection.js';
import { downloadFile } from './dropbox.js';
import { extractText } from './ocr.js';
import { classifyDocument, logUsage } from './classifier.js';

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

  try {
    // Step 1: Download file from Dropbox
    const fileBuffer = await downloadFile(file.dropbox_path);
    console.log(`[pipeline] Downloaded ${file.file_name} (${fileBuffer.length} bytes)`);

    // Step 2: OCR / text extraction
    const ocrResult = await extractText(fileBuffer, file.mime_type || 'application/octet-stream', file.file_name);
    extractedText = ocrResult.text;
    ocrPartial = ocrResult.partial;

    if (!extractedText) {
      console.warn(`[pipeline] No text extracted from ${file.file_name}`);
      db.prepare("UPDATE processed_files SET status = 'ocr_failed' WHERE id = ?").run(processedFileId);

      db.prepare(`
        INSERT INTO documents (processed_file_id, extracted_text, ocr_partial, classification_error, status, created_at)
        VALUES (?, '', ?, 'OCR failed - no text extracted', 'unclassified', datetime('now'))
      `).run(processedFileId, ocrPartial ? 1 : 0);
      return;
    }

    console.log(`[pipeline] Extracted ${extractedText.length} chars from ${file.file_name}`);
  } catch (err) {
    console.error(`[pipeline] Download/OCR error for ${file.file_name}:`, err);
    db.prepare("UPDATE processed_files SET status = 'error' WHERE id = ?").run(processedFileId);

    db.prepare(`
      INSERT INTO documents (processed_file_id, classification_error, status, created_at)
      VALUES (?, ?, 'unclassified', datetime('now'))
    `).run(processedFileId, err instanceof Error ? err.message : String(err));
    return;
  }

  // Step 3: AI classification
  try {
    const { classification, inputTokens, outputTokens } = await classifyDocument(extractedText, file.file_name);

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
      extractedText,
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
    logUsage(documentId, inputTokens, outputTokens, 'classification');

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

    db.prepare("UPDATE processed_files SET status = 'classified' WHERE id = ?").run(processedFileId);
  }
}
