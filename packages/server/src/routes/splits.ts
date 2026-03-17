import { Router } from 'express';
import { verifyToken } from '../middleware/auth.js';
import { getDb } from '../db/connection.js';
import { extractPages, type SplitRange } from '../services/splitter.js';
import { downloadFile } from '../services/dropbox.js';
import { extractText } from '../services/ocr.js';
import { classifyDocument, logUsage } from '../services/classifier.js';

const router = Router();

router.use(verifyToken);

// GET /api/splits/:fileId — get split suggestions for a processed file
router.get('/:fileId', (req, res) => {
  const db = getDb();
  const suggestion = db.prepare(
    'SELECT * FROM split_suggestions WHERE processed_file_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(req.params.fileId) as {
    id: number;
    processed_file_id: number;
    suggested_splits: string;
    status: string;
    final_splits: string | null;
  } | undefined;

  if (!suggestion) {
    res.json({ splits: null });
    return;
  }

  res.json({
    splits: {
      id: suggestion.id,
      processedFileId: suggestion.processed_file_id,
      suggestedSplits: JSON.parse(suggestion.suggested_splits),
      status: suggestion.status,
      finalSplits: suggestion.final_splits ? JSON.parse(suggestion.final_splits) : null,
    },
  });
});

// POST /api/splits/:fileId/accept — accept suggested splits, create child documents
router.post('/:fileId/accept', async (req, res) => {
  const db = getDb();
  const fileId = Number(req.params.fileId);

  const suggestion = db.prepare(
    'SELECT * FROM split_suggestions WHERE processed_file_id = ? AND status = ?',
  ).get(fileId, 'pending') as {
    id: number;
    suggested_splits: string;
  } | undefined;

  if (!suggestion) {
    res.status(404).json({ error: 'No pending split suggestion found' });
    return;
  }

  const splits: SplitRange[] = JSON.parse(suggestion.suggested_splits);
  const file = db.prepare('SELECT * FROM processed_files WHERE id = ?').get(fileId) as {
    dropbox_path: string;
    file_name: string;
    mime_type: string;
    paralegal_name: string;
  };

  if (!file || !file.mime_type?.includes('pdf')) {
    res.status(400).json({ error: 'Splitting only supported for PDF files' });
    return;
  }

  try {
    const pdfBuffer = await downloadFile(file.dropbox_path);
    const createdDocs: number[] = [];

    for (const split of splits) {
      // Extract pages
      const splitBuffer = await extractPages(pdfBuffer, split.pageStart, split.pageEnd);

      // OCR the split
      const ocrResult = await extractText(splitBuffer, 'application/pdf', file.file_name);

      // Classify
      let docId: number;
      if (ocrResult.text) {
        try {
          const { classification, inputTokens, outputTokens } = await classifyDocument(
            ocrResult.text,
            `${file.file_name} (pages ${split.pageStart}-${split.pageEnd})`,
          );

          const result = db.prepare(`
            INSERT INTO documents (
              processed_file_id, page_start, page_end, split_group_id,
              extracted_text, ocr_partial,
              document_label, client_name, description, event_type,
              suggested_section, document_date, confidence, is_legal_document,
              status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
          `).run(
            fileId, split.pageStart, split.pageEnd, `split-${suggestion.id}`,
            ocrResult.text, ocrResult.partial ? 1 : 0,
            classification.documentLabel, classification.clientName,
            classification.description, classification.eventType,
            classification.suggestedSection, classification.documentDate,
            classification.confidence, classification.isLegalDocument ? 1 : 0,
          );
          docId = Number(result.lastInsertRowid);
          logUsage(docId, inputTokens, outputTokens, 'split_classification');
        } catch {
          const result = db.prepare(`
            INSERT INTO documents (
              processed_file_id, page_start, page_end, split_group_id,
              extracted_text, ocr_partial, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'unclassified', datetime('now'))
          `).run(fileId, split.pageStart, split.pageEnd, `split-${suggestion.id}`,
            ocrResult.text, ocrResult.partial ? 1 : 0);
          docId = Number(result.lastInsertRowid);
        }
      } else {
        const result = db.prepare(`
          INSERT INTO documents (
            processed_file_id, page_start, page_end, split_group_id,
            classification_error, status, created_at
          ) VALUES (?, ?, ?, ?, 'OCR failed on split', 'unclassified', datetime('now'))
        `).run(fileId, split.pageStart, split.pageEnd, `split-${suggestion.id}`);
        docId = Number(result.lastInsertRowid);
      }
      createdDocs.push(docId);
    }

    // Mark the original document as superseded by marking suggestion as accepted
    db.prepare("UPDATE split_suggestions SET status = 'accepted', final_splits = ? WHERE id = ?")
      .run(JSON.stringify(splits), suggestion.id);

    // Mark original document(s) for this file as skipped (superseded by splits)
    db.prepare(`
      UPDATE documents SET status = 'skipped'
      WHERE processed_file_id = ? AND split_group_id IS NULL AND status IN ('pending', 'unclassified')
    `).run(fileId);

    res.json({ accepted: true, documentIds: createdDocs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[splits] Accept failed:', msg);
    res.status(500).json({ error: `Split processing failed: ${msg}` });
  }
});

// POST /api/splits/:fileId/reject — reject splits, keep original document
router.post('/:fileId/reject', (req, res) => {
  const db = getDb();
  const fileId = Number(req.params.fileId);

  const result = db.prepare(
    "UPDATE split_suggestions SET status = 'rejected' WHERE processed_file_id = ? AND status = 'pending'",
  ).run(fileId);

  if (result.changes === 0) {
    res.status(404).json({ error: 'No pending split suggestion found' });
    return;
  }

  res.json({ rejected: true });
});

// POST /api/splits/:fileId/edit — accept with custom split ranges
router.post('/:fileId/edit', async (req, res) => {
  const db = getDb();
  const fileId = Number(req.params.fileId);
  const { splits } = req.body as { splits: SplitRange[] };

  if (!splits || !Array.isArray(splits) || splits.length === 0) {
    res.status(400).json({ error: 'Must provide splits array with pageStart and pageEnd' });
    return;
  }

  // Update the suggestion with edited splits, then process like accept
  const suggestion = db.prepare(
    "SELECT id FROM split_suggestions WHERE processed_file_id = ? AND status = 'pending'",
  ).get(fileId) as { id: number } | undefined;

  if (!suggestion) {
    res.status(404).json({ error: 'No pending split suggestion found' });
    return;
  }

  // Update suggested_splits with the edited version and re-trigger accept logic
  db.prepare('UPDATE split_suggestions SET suggested_splits = ? WHERE id = ?')
    .run(JSON.stringify(splits), suggestion.id);

  // Forward to accept handler by calling the same logic
  // (simplest approach: just redirect the request internally)
  req.params.fileId = String(fileId);
  // Re-fetch and process
  const file = db.prepare('SELECT * FROM processed_files WHERE id = ?').get(fileId) as {
    dropbox_path: string;
    file_name: string;
    mime_type: string;
  };

  if (!file || !file.mime_type?.includes('pdf')) {
    res.status(400).json({ error: 'Splitting only supported for PDF files' });
    return;
  }

  try {
    const pdfBuffer = await downloadFile(file.dropbox_path);
    const createdDocs: number[] = [];

    for (const split of splits) {
      const splitBuffer = await extractPages(pdfBuffer, split.pageStart, split.pageEnd);
      const ocrResult = await extractText(splitBuffer, 'application/pdf', file.file_name);

      let docId: number;
      if (ocrResult.text) {
        try {
          const { classification, inputTokens, outputTokens } = await classifyDocument(
            ocrResult.text,
            `${file.file_name} (pages ${split.pageStart}-${split.pageEnd})`,
          );
          const result = db.prepare(`
            INSERT INTO documents (
              processed_file_id, page_start, page_end, split_group_id,
              extracted_text, ocr_partial,
              document_label, client_name, description, event_type,
              suggested_section, document_date, confidence, is_legal_document,
              status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
          `).run(
            fileId, split.pageStart, split.pageEnd, `split-${suggestion.id}`,
            ocrResult.text, ocrResult.partial ? 1 : 0,
            classification.documentLabel, classification.clientName,
            classification.description, classification.eventType,
            classification.suggestedSection, classification.documentDate,
            classification.confidence, classification.isLegalDocument ? 1 : 0,
          );
          docId = Number(result.lastInsertRowid);
          logUsage(docId, inputTokens, outputTokens, 'split_classification');
        } catch {
          const result = db.prepare(`
            INSERT INTO documents (
              processed_file_id, page_start, page_end, split_group_id,
              extracted_text, ocr_partial, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'unclassified', datetime('now'))
          `).run(fileId, split.pageStart, split.pageEnd, `split-${suggestion.id}`,
            ocrResult.text, ocrResult.partial ? 1 : 0);
          docId = Number(result.lastInsertRowid);
        }
      } else {
        const result = db.prepare(`
          INSERT INTO documents (
            processed_file_id, page_start, page_end, split_group_id,
            classification_error, status, created_at
          ) VALUES (?, ?, ?, ?, 'OCR failed on split', 'unclassified', datetime('now'))
        `).run(fileId, split.pageStart, split.pageEnd, `split-${suggestion.id}`);
        docId = Number(result.lastInsertRowid);
      }
      createdDocs.push(docId);
    }

    db.prepare("UPDATE split_suggestions SET status = 'accepted', final_splits = ? WHERE id = ?")
      .run(JSON.stringify(splits), suggestion.id);

    db.prepare(`
      UPDATE documents SET status = 'skipped'
      WHERE processed_file_id = ? AND split_group_id IS NULL AND status IN ('pending', 'unclassified')
    `).run(fileId);

    res.json({ accepted: true, documentIds: createdDocs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Split processing failed: ${msg}` });
  }
});

export { router as splitsRouter };
