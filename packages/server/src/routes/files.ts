import { Router } from 'express';
import mammoth from 'mammoth';
import { verifyToken } from '../middleware/auth.js';
import { getDb } from '../db/connection.js';
import { downloadFile } from '../services/dropbox.js';

const router = Router();
router.use(verifyToken);

// GET /api/files/:id/content - Proxy file from Dropbox
router.get('/:id/content', async (req, res) => {
  const db = getDb();
  const file = db.prepare(`
    SELECT pf.dropbox_path, pf.file_name, pf.mime_type
    FROM processed_files pf
    WHERE pf.id = ?
  `).get(req.params.id) as {
    dropbox_path: string;
    file_name: string;
    mime_type: string;
  } | undefined;

  if (!file) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  try {
    const buffer = await downloadFile(file.dropbox_path);
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.file_name)}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    console.error(`[files] Download error for ${file.file_name}:`, err);
    res.status(502).json({ error: 'Failed to download file from Dropbox' });
  }
});

// GET /api/files/:id/preview - Convert DOCX to HTML for in-browser preview
router.get('/:id/preview', async (req, res) => {
  const db = getDb();
  const file = db.prepare(`
    SELECT pf.dropbox_path, pf.file_name, pf.mime_type
    FROM processed_files pf
    WHERE pf.id = ?
  `).get(req.params.id) as {
    dropbox_path: string;
    file_name: string;
    mime_type: string;
  } | undefined;

  if (!file) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  const isDocx = file.file_name.toLowerCase().endsWith('.docx') || file.file_name.toLowerCase().endsWith('.doc');

  if (!isDocx) {
    res.status(400).json({ error: 'Preview only supported for DOCX files' });
    return;
  }

  try {
    const buffer = await downloadFile(file.dropbox_path);
    const result = await mammoth.convertToHtml({ buffer });
    const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    max-width: 800px; margin: 24px auto; padding: 0 20px; color: #1f2937; line-height: 1.6; font-size: 14px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  td, th { border: 1px solid #d1d5db; padding: 6px 10px; }
  img { max-width: 100%; }
  p { margin: 8px 0; }
</style>
</head><body>${result.value}</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error(`[files] DOCX preview error for ${file.file_name}:`, err);
    res.status(502).json({ error: 'Failed to generate preview' });
  }
});

export { router as filesRouter };
