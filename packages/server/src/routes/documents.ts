import { Router } from 'express';
import { verifyToken } from '../middleware/auth.js';
import { getDb } from '../db/connection.js';
import { createTask, moveTaskToSection, attachFile } from '../services/asana.js';
import { downloadFile, moveFile } from '../services/dropbox.js';
import { classifyDocument, logUsage } from '../services/classifier.js';
import { getCached } from '../services/filecache.js';
import { convertPdfToImages } from '../services/pdf-utils.js';
import type { EventType, ApproveResult } from 'shared/types.js';

const router = Router();
router.use(verifyToken);

const CLAIM_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// GET /api/documents?paralegal=X&status=pending|approved|history|all
router.get('/', (req, res) => {
  const db = getDb();
  const { paralegal, status } = req.query;

  let sql = `
    SELECT d.*, pf.file_name, pf.mime_type, pf.dropbox_path, pf.dropbox_modified_at
    FROM documents d
    JOIN processed_files pf ON d.processed_file_id = pf.id
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (paralegal) {
    sql += ' AND pf.paralegal_name = ?';
    params.push(paralegal);
  }

  if (status && status !== 'all') {
    if (status === 'history') {
      sql += " AND d.status IN ('approved', 'skipped', 'sorted')";
    } else if (status === 'pending') {
      // Show both pending (classified) and unclassified (OCR/classify failed) docs
      sql += " AND d.status IN ('pending', 'unclassified')";
    } else {
      sql += ' AND d.status = ?';
      params.push(status);
    }
  }

  sql += ' ORDER BY d.created_at ASC'; // FIFO - oldest first

  const documents = db.prepare(sql).all(...params);
  res.json({ documents });
});

// POST /api/documents/reclassify-all — Re-classify all pending/classified docs and reset corrections
// NOTE: Must be defined before /:id routes to avoid Express matching "reclassify-all" as an :id param
router.post('/reclassify-all', async (req, res) => {
  const db = getDb();

  try {
    // 1. Clear old corrections and classification rules (obsoleted by new prompt)
    const deletedCorrections = db.prepare('DELETE FROM corrections').run().changes;
    const deletedRules = db.prepare('DELETE FROM classification_rules').run().changes;

    // 2. Find all documents eligible for reclassification (not yet approved/sorted)
    const docs = db.prepare(`
      SELECT d.id, d.extracted_text, pf.id as pf_id, pf.file_name, pf.mime_type, pf.dropbox_path
      FROM documents d
      JOIN processed_files pf ON d.processed_file_id = pf.id
      WHERE d.status IN ('pending', 'unclassified', 'error')
    `).all() as { id: number; extracted_text: string | null; pf_id: number; file_name: string; mime_type: string | null; dropbox_path: string }[];

    // 3. Clear paralegal edits on these documents
    if (docs.length > 0) {
      db.prepare(`
        UPDATE documents SET
          edited_label = NULL, edited_client_name = NULL,
          edited_event_type = NULL, edited_date = NULL,
          asana_project_gid = NULL, asana_project_name = NULL,
          asana_section_gid = NULL, asana_section_name = NULL
        WHERE status IN ('pending', 'unclassified', 'error')
      `).run();
    }

    // 4. Respond immediately, reclassify in background
    console.log(`[documents] Reclassify-all: cleared ${deletedCorrections} corrections, ${deletedRules} rules, queuing ${docs.length} documents`);
    res.json({
      deletedCorrections,
      deletedRules,
      documentsQueued: docs.length,
    });

    // 5. Process each document in background (sequentially to avoid overload)
    let success = 0;
    let failed = 0;
    for (const doc of docs) {
      try {
        let pageImages: Buffer[] = [];
        let imageMimeType = 'image/jpeg';
        let fileBuffer = getCached(doc.pf_id);
        if (!fileBuffer) {
          try {
            fileBuffer = await downloadFile(doc.dropbox_path);
          } catch {
            // File may have been moved/deleted
          }
        }

        if (fileBuffer) {
          if (doc.mime_type === 'application/pdf') {
            pageImages = await convertPdfToImages(fileBuffer, { dpi: 150 });
          } else if (doc.mime_type?.startsWith('image/')) {
            pageImages = [fileBuffer];
            imageMimeType = doc.mime_type;
          }
        }

        const ocrText = doc.extracted_text && !doc.extracted_text.startsWith('(classified via')
          ? doc.extracted_text : '';

        if (pageImages.length === 0 && !ocrText) {
          console.warn(`[reclassify] Skipping ${doc.file_name}: no images or text`);
          failed++;
          continue;
        }

        const { classification, inputTokens, outputTokens } = await classifyDocument(
          pageImages, ocrText, doc.file_name, imageMimeType,
        );

        db.prepare(`
          UPDATE documents SET
            document_label = ?, client_name = ?, event_type = ?,
            suggested_section = ?, document_date = ?, confidence = ?,
            is_legal_document = ?, classification_error = NULL, status = 'pending'
          WHERE id = ?
        `).run(
          classification.documentLabel,
          classification.clientName,
          classification.eventType,
          classification.suggestedSection,
          classification.documentDate,
          classification.confidence,
          classification.isLegalDocument ? 1 : 0,
          doc.id,
        );

        logUsage(doc.id, inputTokens, outputTokens, 'reclassification');
        success++;
        console.log(`[reclassify] ${success}/${docs.length} ${doc.file_name} → ${classification.documentLabel}`);
      } catch (err) {
        failed++;
        console.error(`[reclassify] Failed ${doc.file_name}:`, err instanceof Error ? err.message : err);
      }
    }
    console.log(`[reclassify] Complete: ${success} succeeded, ${failed} failed out of ${docs.length}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[documents] Reclassify-all failed:', msg);
    if (!res.headersSent) {
      res.status(500).json({ error: `Reclassify-all failed: ${msg}` });
    }
  }
});

// GET /api/documents/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const doc = db.prepare(`
    SELECT d.*, pf.file_name, pf.mime_type, pf.dropbox_path, pf.dropbox_modified_at
    FROM documents d
    JOIN processed_files pf ON d.processed_file_id = pf.id
    WHERE d.id = ?
  `).get(req.params.id);

  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  res.json({ document: doc });
});

// PATCH /api/documents/:id - Edit classification fields
router.patch('/:id', (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const updates = req.body;

  const allowedFields = [
    'edited_label', 'edited_client_name',
    'edited_event_type', 'edited_date',
    'asana_project_gid', 'asana_project_name',
    'asana_section_gid', 'asana_section_name',
  ];

  const setClauses: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      setClauses.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (setClauses.length === 0) {
    res.status(400).json({ error: 'No valid fields to update' });
    return;
  }

  values.push(id);
  db.prepare(`UPDATE documents SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

  const updated = db.prepare(`
    SELECT d.*, pf.file_name, pf.mime_type, pf.dropbox_path, pf.dropbox_modified_at
    FROM documents d
    JOIN processed_files pf ON d.processed_file_id = pf.id
    WHERE d.id = ?
  `).get(id);

  res.json({ document: updated });
});

// POST /api/documents/:id/claim
router.post('/:id/claim', (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const paralegal = req.user!.paralegal;

  const doc = db.prepare('SELECT claimed_by, claimed_at FROM documents WHERE id = ?').get(id) as {
    claimed_by: string | null;
    claimed_at: string | null;
  } | undefined;

  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  if (doc.claimed_by && doc.claimed_by !== paralegal && doc.claimed_at) {
    const claimedTime = new Date(doc.claimed_at + 'Z').getTime(); // Append Z since SQLite stores UTC without timezone marker
    if (Date.now() - claimedTime < CLAIM_TIMEOUT_MS) {
      res.status(409).json({ error: `Being reviewed by ${doc.claimed_by}`, claimedBy: doc.claimed_by });
      return;
    }
  }

  db.prepare("UPDATE documents SET claimed_by = ?, claimed_at = datetime('now') WHERE id = ?")
    .run(paralegal, id);

  res.json({ claimed: true });
});

// POST /api/documents/:id/skip
router.post('/:id/skip', (req, res) => {
  const db = getDb();
  const { id } = req.params;

  db.prepare(`
    UPDATE documents SET status = 'skipped', assigned_paralegal = ?, claimed_by = NULL, claimed_at = NULL
    WHERE id = ?
  `).run(req.user!.paralegal, id);

  res.json({ skipped: true });
});

// POST /api/documents/:id/approve
router.post('/:id/approve', async (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const paralegal = req.user!.paralegal;

  const doc = db.prepare(`
    SELECT d.*, pf.file_name, pf.mime_type, pf.dropbox_path, pf.dropbox_modified_at
    FROM documents d
    JOIN processed_files pf ON d.processed_file_id = pf.id
    WHERE d.id = ?
  `).get(id) as {
    id: number;
    document_label: string | null;
    client_name: string | null;
    edited_label: string | null;
    edited_client_name: string | null;
    event_type: string | null;
    edited_event_type: string | null;
    document_date: string | null;
    edited_date: string | null;
    asana_project_gid: string | null;
    asana_section_gid: string | null;
    file_name: string;
    mime_type: string | null;
    dropbox_path: string;
    status: string;
  } | undefined;

  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  // Guard against double-approval
  if (doc.status === 'approved' || doc.status === 'sorted') {
    res.status(409).json({ error: 'Document already approved' });
    return;
  }

  // Resolve final values (edited overrides AI)
  const documentLabel = doc.edited_label || doc.document_label || 'Untitled Document';
  const eventType = (doc.edited_event_type || doc.event_type || 'Received') as EventType;
  const docDate = doc.edited_date || doc.document_date;
  const projectGid = doc.asana_project_gid;

  if (!projectGid) {
    res.status(400).json({ error: 'No Asana project selected' });
    return;
  }

  // Format task name: "Document Label, Month Day, Year"
  let taskName = documentLabel;
  if (docDate) {
    try {
      const d = new Date(docDate + 'T00:00:00');
      const formatted = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      taskName = `${documentLabel}, ${formatted}`;
    } catch {
      taskName = `${documentLabel}, ${docDate}`;
    }
  }

  const result: ApproveResult = {
    success: false,
    taskCreated: false,
    sectionMoved: false,
    fileAttached: false,
    errors: [],
  };

  // Step 1: Create task
  try {
    const task = await createTask({
      name: taskName,
      paralegalName: paralegal || 'Unknown',
      eventType,
      documentLabel,
      projectGid,
    });
    result.taskGid = task.gid;
    result.taskUrl = task.url;
    result.taskCreated = true;

    db.prepare(`
      UPDATE documents SET asana_task_gid = ?, asana_task_url = ? WHERE id = ?
    `).run(task.gid, task.url, id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Task creation failed: ${msg}`);
    db.prepare(`
      UPDATE documents SET status = 'error', asana_error = ?, assigned_paralegal = ? WHERE id = ?
    `).run(`Task creation failed: ${msg}`, paralegal, id);
    res.status(500).json({ result });
    return;
  }

  // Step 2: Move to section (if section selected)
  if (doc.asana_section_gid && result.taskGid) {
    try {
      await moveTaskToSection(result.taskGid, doc.asana_section_gid);
      result.sectionMoved = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Section move failed: ${msg}`);
    }
  } else {
    result.sectionMoved = true; // no section to move to
  }

  // Step 3: Attach file
  if (result.taskGid) {
    try {
      const fileBuffer = await downloadFile(doc.dropbox_path);
      await attachFile(
        result.taskGid,
        fileBuffer,
        doc.file_name,
        doc.mime_type || 'application/octet-stream',
      );
      result.fileAttached = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`File attachment failed: ${msg}`);
    }
  }

  result.success = result.taskCreated;

  // Look up project name and section name for confirmation display
  let projectName = '';
  let sectionName = '';
  try {
    const projData = await (await fetch(`https://app.asana.com/api/1.0/projects/${projectGid}`, {
      headers: { Authorization: `Bearer ${process.env.ASANA_PAT}` },
    })).json() as { data?: { name?: string } };
    projectName = projData.data?.name || '';
  } catch {}
  if (doc.asana_section_gid) {
    try {
      const secData = await (await fetch(`https://app.asana.com/api/1.0/sections/${doc.asana_section_gid}`, {
        headers: { Authorization: `Bearer ${process.env.ASANA_PAT}` },
      })).json() as { data?: { name?: string } };
      sectionName = secData.data?.name || '';
    } catch {}
  }

  // Log corrections silently — compare AI suggestion vs what paralegal approved
  const corrections: Array<{ field: string; ai: string | null; human: string | null }> = [];
  if (doc.edited_label && doc.edited_label !== doc.document_label) {
    corrections.push({ field: 'document_label', ai: doc.document_label, human: doc.edited_label });
  }
  if (doc.edited_client_name && doc.edited_client_name !== doc.client_name) {
    corrections.push({ field: 'client_name', ai: doc.client_name, human: doc.edited_client_name });
  }
  if (doc.edited_event_type && doc.edited_event_type !== doc.event_type) {
    corrections.push({ field: 'event_type', ai: doc.event_type, human: doc.edited_event_type });
  }
  if (doc.edited_date && doc.edited_date !== doc.document_date) {
    corrections.push({ field: 'document_date', ai: doc.document_date, human: doc.edited_date });
  }
  // Log corrections + update status atomically
  const asanaError = result.errors.length > 0 ? result.errors.join('; ') : null;
  const insertCorrection = db.prepare(`
    INSERT INTO corrections (document_id, field_name, ai_value, paralegal_value, paralegal_name, file_name)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const updateStatus = db.prepare(`
    UPDATE documents
    SET status = 'approved',
        assigned_paralegal = ?,
        asana_error = ?,
        approved_at = datetime('now'),
        claimed_by = NULL,
        claimed_at = NULL
    WHERE id = ?
  `);

  const commitApproval = db.transaction(() => {
    for (const c of corrections) {
      insertCorrection.run(Number(id), c.field, c.ai, c.human, paralegal, doc.file_name);
    }
    updateStatus.run(paralegal, asanaError, id);
  });
  commitApproval();

  res.json({
    result: {
      ...result,
      taskName,
      projectName,
      sectionName,
      eventType,
      documentLabel,
    },
  });
});

// POST /api/documents/:id/retry-classify
router.post('/:id/retry-classify', async (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const doc = db.prepare(`
    SELECT d.*, pf.file_name, pf.mime_type, pf.id as pf_id FROM documents d
    JOIN processed_files pf ON d.processed_file_id = pf.id
    WHERE d.id = ?
  `).get(id) as { id: number; extracted_text: string | null; file_name: string; mime_type: string | null; pf_id: number } | undefined;

  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  try {
    // Try to get page images from cached file, or re-download from Dropbox
    let pageImages: Buffer[] = [];
    let imageMimeType = 'image/jpeg';
    let fileBuffer = getCached(doc.pf_id);
    if (!fileBuffer) {
      // Cache miss — try re-downloading from Dropbox
      try {
        const pf = db.prepare('SELECT dropbox_path FROM processed_files WHERE id = ?').get(doc.pf_id) as { dropbox_path: string } | undefined;
        if (pf?.dropbox_path) {
          fileBuffer = await downloadFile(pf.dropbox_path);
        }
      } catch (err) {
        console.warn(`[documents] Failed to re-download file for reclassification:`, err instanceof Error ? err.message : err);
      }
    }

    if (fileBuffer) {
      if (doc.mime_type === 'application/pdf') {
        pageImages = await convertPdfToImages(fileBuffer, { dpi: 150 });
      } else if (doc.mime_type?.startsWith('image/')) {
        pageImages = [fileBuffer];
        imageMimeType = doc.mime_type;
      }
    }

    // Filter out placeholder text that isn't real OCR content
    const ocrText = doc.extracted_text && !doc.extracted_text.startsWith('(classified via')
      ? doc.extracted_text : '';

    if (pageImages.length === 0 && !ocrText) {
      res.status(400).json({ error: 'No images or text available for classification' });
      return;
    }

    const { classification, inputTokens, outputTokens } = await classifyDocument(
      pageImages, ocrText, doc.file_name, imageMimeType,
    );

    db.prepare(`
      UPDATE documents SET
        document_label = ?, client_name = ?, event_type = ?,
        suggested_section = ?, document_date = ?, confidence = ?,
        is_legal_document = ?, classification_error = NULL, status = 'pending'
      WHERE id = ?
    `).run(
      classification.documentLabel,
      classification.clientName,
      classification.eventType,
      classification.suggestedSection,
      classification.documentDate,
      classification.confidence,
      classification.isLegalDocument ? 1 : 0,
      id,
    );

    logUsage(doc.id, inputTokens, outputTokens, 'reclassification');

    const updated = db.prepare(`
      SELECT d.*, pf.file_name, pf.mime_type, pf.dropbox_path, pf.dropbox_modified_at
      FROM documents d
      JOIN processed_files pf ON d.processed_file_id = pf.id
      WHERE d.id = ?
    `).get(id);

    res.json({ document: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[documents] Retry classify failed:', msg);
    res.status(500).json({ error: `Classification failed: ${msg}` });
  }
});

// POST /api/documents/:id/retry-attach
router.post('/:id/retry-attach', async (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const doc = db.prepare(`
    SELECT d.asana_task_gid, pf.file_name, pf.mime_type, pf.dropbox_path
    FROM documents d
    JOIN processed_files pf ON d.processed_file_id = pf.id
    WHERE d.id = ?
  `).get(id) as {
    asana_task_gid: string | null;
    file_name: string;
    mime_type: string | null;
    dropbox_path: string;
  } | undefined;

  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  if (!doc.asana_task_gid) {
    res.status(400).json({ error: 'No Asana task exists to attach to' });
    return;
  }

  try {
    const fileBuffer = await downloadFile(doc.dropbox_path);
    await attachFile(
      doc.asana_task_gid,
      fileBuffer,
      doc.file_name,
      doc.mime_type || 'application/octet-stream',
    );

    // Clear the attachment error from asana_error if present
    const existing = db.prepare('SELECT asana_error FROM documents WHERE id = ?').get(id) as { asana_error: string | null };
    if (existing?.asana_error) {
      const cleaned = existing.asana_error
        .split('; ')
        .filter((e) => !e.startsWith('File attachment failed'))
        .join('; ') || null;
      db.prepare('UPDATE documents SET asana_error = ? WHERE id = ?').run(cleaned, id);
    }

    res.json({ attached: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[documents] Retry attach failed:', msg);
    res.status(500).json({ error: `Attachment failed: ${msg}` });
  }
});

// POST /api/documents/:id/move-to-sorted — Move file to Sorted subfolder in Dropbox
router.post('/:id/move-to-sorted', async (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const doc = db.prepare(`
    SELECT d.status as doc_status, pf.id as pf_id, pf.dropbox_path, pf.file_name, pf.paralegal_name
    FROM documents d
    JOIN processed_files pf ON d.processed_file_id = pf.id
    WHERE d.id = ?
  `).get(id) as {
    doc_status: string;
    pf_id: number;
    dropbox_path: string;
    file_name: string;
    paralegal_name: string;
  } | undefined;

  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  if (!['pending', 'approved', 'unclassified'].includes(doc.doc_status)) {
    res.status(400).json({ error: 'Document has already been sorted or skipped' });
    return;
  }

  try {
    // Move to per-paralegal Sorted subfolder
    const sortedPath = `/New Sort Folder/${doc.paralegal_name}/Sorted/${doc.file_name}`;

    const actualPath = await moveFile(doc.dropbox_path, sortedPath);

    // Update the dropbox_path using the processed file ID (unique)
    db.prepare('UPDATE processed_files SET dropbox_path = ? WHERE id = ?')
      .run(actualPath, doc.pf_id);
    db.prepare("UPDATE documents SET status = 'sorted' WHERE id = ?").run(id);

    res.json({ moved: true, newPath: actualPath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[documents] Move to sorted failed:', msg);
    res.status(500).json({ error: `Move failed: ${msg}` });
  }
});

export { router as documentsRouter };
