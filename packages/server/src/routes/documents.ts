import { Router } from 'express';
import { verifyToken } from '../middleware/auth.js';
import { getDb } from '../db/connection.js';
import { createTask, moveTaskToSection, attachFile } from '../services/asana.js';
import { downloadFile, moveFile } from '../services/dropbox.js';
import { classifyDocument, logUsage } from '../services/classifier.js';
import type { EventType, ApproveResult } from 'shared/types.js';

const router = Router();
router.use(verifyToken);

const CLAIM_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// GET /api/documents?paralegal=X&status=pending|approved|history|all
router.get('/', (req, res) => {
  const db = getDb();
  const { paralegal, status } = req.query;

  let sql = `
    SELECT d.*, pf.file_name, pf.mime_type, pf.dropbox_path
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
      sql += " AND d.status IN ('approved', 'skipped')";
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

// GET /api/documents/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const doc = db.prepare(`
    SELECT d.*, pf.file_name, pf.mime_type, pf.dropbox_path
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
    'edited_label', 'edited_client_name', 'edited_description',
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
    SELECT d.*, pf.file_name, pf.mime_type, pf.dropbox_path
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
    const claimedTime = new Date(doc.claimed_at).getTime();
    if (Date.now() - claimedTime < CLAIM_TIMEOUT_MS) {
      res.status(409).json({ error: `Being reviewed by ${doc.claimed_by}`, claimedBy: doc.claimed_by });
      return;
    }
  }

  db.prepare('UPDATE documents SET claimed_by = ?, claimed_at = datetime(?) WHERE id = ?')
    .run(paralegal, new Date().toISOString(), id);

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
    SELECT d.*, pf.file_name, pf.mime_type, pf.dropbox_path
    FROM documents d
    JOIN processed_files pf ON d.processed_file_id = pf.id
    WHERE d.id = ?
  `).get(id) as {
    id: number;
    document_label: string | null;
    edited_label: string | null;
    description: string | null;
    edited_description: string | null;
    event_type: string | null;
    edited_event_type: string | null;
    document_date: string | null;
    edited_date: string | null;
    asana_project_gid: string | null;
    asana_section_gid: string | null;
    file_name: string;
    mime_type: string | null;
    dropbox_path: string;
  } | undefined;

  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  // Resolve final values (edited overrides AI)
  const documentLabel = doc.edited_label || doc.document_label || 'Untitled Document';
  const description = doc.edited_description || doc.description || documentLabel;
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

  // Update document status
  const asanaError = result.errors.length > 0 ? result.errors.join('; ') : null;
  db.prepare(`
    UPDATE documents
    SET status = 'approved',
        assigned_paralegal = ?,
        asana_error = ?,
        approved_at = datetime('now'),
        claimed_by = NULL,
        claimed_at = NULL
    WHERE id = ?
  `).run(paralegal, asanaError, id);

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
    SELECT d.*, pf.file_name FROM documents d
    JOIN processed_files pf ON d.processed_file_id = pf.id
    WHERE d.id = ?
  `).get(id) as { id: number; extracted_text: string | null; file_name: string } | undefined;

  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  if (!doc.extracted_text) {
    res.status(400).json({ error: 'No extracted text available for classification' });
    return;
  }

  try {
    const { classification, inputTokens, outputTokens } = await classifyDocument(doc.extracted_text, doc.file_name);

    db.prepare(`
      UPDATE documents SET
        document_label = ?, client_name = ?, description = ?, event_type = ?,
        suggested_section = ?, document_date = ?, confidence = ?,
        is_legal_document = ?, classification_error = NULL, status = 'pending'
      WHERE id = ?
    `).run(
      classification.documentLabel,
      classification.clientName,
      classification.description,
      classification.eventType,
      classification.suggestedSection,
      classification.documentDate,
      classification.confidence,
      classification.isLegalDocument ? 1 : 0,
      id,
    );

    logUsage(doc.id, inputTokens, outputTokens, 'reclassification');

    const updated = db.prepare(`
      SELECT d.*, pf.file_name, pf.mime_type, pf.dropbox_path
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
    SELECT pf.dropbox_path, pf.file_name, pf.paralegal_name
    FROM documents d
    JOIN processed_files pf ON d.processed_file_id = pf.id
    WHERE d.id = ?
  `).get(id) as {
    dropbox_path: string;
    file_name: string;
    paralegal_name: string;
  } | undefined;

  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  try {
    // Move to per-paralegal Sorted subfolder
    const sortedPath = `/New Sort Folder/${doc.paralegal_name}/Sorted/${doc.file_name}`;

    await moveFile(doc.dropbox_path, sortedPath);

    // Update the dropbox_path in the database
    db.prepare('UPDATE processed_files SET dropbox_path = ? WHERE dropbox_path = ?')
      .run(sortedPath, doc.dropbox_path);

    res.json({ moved: true, newPath: sortedPath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[documents] Move to sorted failed:', msg);
    res.status(500).json({ error: `Move failed: ${msg}` });
  }
});

export { router as documentsRouter };
