import { getDb } from '../db/connection.js';
import { downloadFile } from './dropbox.js';
import { extractText } from './ocr.js';
import { classifyDocument, classifyDocumentVision, logUsage } from './classifier.js';

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
      console.warn(`[pipeline] No text extracted from ${file.file_name}, trying vision classification...`);

      // Try vision-based classification as fallback
      const isImage = file.mime_type?.startsWith('image/');
      if (isImage || file.mime_type === 'application/pdf') {
        try {
          let imageBuffer = fileBuffer;

          // For PDFs, we need to convert first page to image
          // Use poppler's pdftoppm if available, otherwise send as-is for images
          if (file.mime_type === 'application/pdf') {
            const { execSync } = await import('child_process');
            const fs = await import('fs');
            const os = await import('os');
            const path = await import('path');
            const tmpDir = os.default.tmpdir();
            const tmpPdf = path.default.join(tmpDir, `doctriage-${processedFileId}.pdf`);
            const tmpImg = path.default.join(tmpDir, `doctriage-${processedFileId}`);
            fs.default.writeFileSync(tmpPdf, fileBuffer);
            try {
              execSync(`pdftoppm -jpeg -f 1 -l 1 -r 200 "${tmpPdf}" "${tmpImg}"`, { timeout: 15000 });
              const jpegPath = `${tmpImg}-1.jpg`;
              if (fs.default.existsSync(jpegPath)) {
                imageBuffer = fs.default.readFileSync(jpegPath);
                fs.default.unlinkSync(jpegPath);
              }
            } catch {
              console.warn(`[pipeline] pdftoppm failed, skipping vision for PDF`);
            }
            fs.default.unlinkSync(tmpPdf);
          }

          const mimeForVision = file.mime_type?.startsWith('image/') ? file.mime_type : 'image/jpeg';
          const { classification, inputTokens, outputTokens } = await classifyDocumentVision(
            imageBuffer, mimeForVision, file.file_name,
          );

          const result = db.prepare(`
            INSERT INTO documents (
              processed_file_id, extracted_text, ocr_partial,
              document_label, client_name, description, event_type, suggested_section,
              document_date, confidence, is_legal_document,
              status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
          `).run(
            processedFileId, '(classified via vision — no OCR text)', 0,
            classification.documentLabel, classification.clientName,
            classification.description, classification.eventType,
            classification.suggestedSection, classification.documentDate,
            classification.confidence, classification.isLegalDocument ? 1 : 0,
          );
          const docId = Number(result.lastInsertRowid);
          logUsage(docId, inputTokens, outputTokens, 'vision_classification');
          db.prepare("UPDATE processed_files SET status = 'classified' WHERE id = ?").run(processedFileId);
          console.log(`[pipeline] Vision classified: ${file.file_name} → ${classification.documentLabel}`);
          return;
        } catch (visionErr) {
          console.error(`[pipeline] Vision classification also failed for ${file.file_name}:`, visionErr);
        }
      }

      // If vision also failed, create unclassified document
      db.prepare("UPDATE processed_files SET status = 'ocr_failed' WHERE id = ?").run(processedFileId);
      db.prepare(`
        INSERT INTO documents (processed_file_id, extracted_text, ocr_partial, classification_error, status, created_at)
        VALUES (?, '', ?, 'OCR and vision classification both failed', 'unclassified', datetime('now'))
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

    db.prepare("UPDATE processed_files SET status = 'classification_failed' WHERE id = ?").run(processedFileId);
  }
}
