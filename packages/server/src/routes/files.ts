import { Router } from 'express';
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

export { router as filesRouter };
