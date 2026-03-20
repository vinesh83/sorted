import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { initDb } from './db/schema.js';
import { getDb } from './db/connection.js';
import { authRouter } from './routes/auth.js';
import { documentsRouter } from './routes/documents.js';
import { asanaRouter } from './routes/asana.js';
import { filesRouter } from './routes/files.js';
import { splitsRouter } from './routes/splits.js';
import { startWatcher, getWatcherStatus, setOnNewFile, rescan } from './services/watcher.js';
import { processFile } from './services/pipeline.js';
import { verifyToken } from './middleware/auth.js';
import {
  analyzeCorrectionsAndGenerateRules,
  getActiveRules,
  getRulesHistory,
  getCorrectionsSinceLastAnalysis,
  shouldAutoTrigger,
} from './services/prompt-optimizer.js';
import { SYSTEM_PROMPT } from './services/classifier.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Initialize database
initDb();

// API routes
app.use('/api/auth', authRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/asana', asanaRouter);
app.use('/api/files', filesRouter);
app.use('/api/splits', splitsRouter);

// Status endpoint with watcher health
app.get('/api/status', verifyToken, (_req, res) => {
  const db = getDb();
  const { watcherRunning, dropboxConnected, processingCount } = getWatcherStatus();
  const counts = db.prepare(`
    SELECT
      COUNT(CASE WHEN status = 'pending' THEN 1 END) as pendingCount,
      COUNT(CASE WHEN status = 'approved' THEN 1 END) as approvedCount
    FROM documents
  `).get() as { pendingCount: number; approvedCount: number };

  const fileCount = db.prepare('SELECT COUNT(*) as count FROM processed_files').get() as { count: number };

  res.json({
    watcherRunning,
    dropboxConnected,
    processingCount,
    pendingCount: counts.pendingCount,
    approvedCount: counts.approvedCount,
    processedFiles: fileCount.count,
    timestamp: new Date().toISOString(),
  });
});

// Manual rescan — forces re-reading all folders from scratch
app.post('/api/rescan', verifyToken, async (_req, res) => {
  try {
    await rescan();
    const db = getDb();
    const fileCount = db.prepare('SELECT COUNT(*) as count FROM processed_files').get() as { count: number };
    const docCount = db.prepare('SELECT COUNT(*) as count FROM documents').get() as { count: number };
    res.json({ ok: true, processedFiles: fileCount.count, documents: docCount.count });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Bulk reprocess — re-runs OCR + classification on all unclassified documents
app.post('/api/reprocess', verifyToken, async (_req, res) => {
  try {
    const db = getDb();
    const unclassified = db.prepare(`
      SELECT d.id, d.processed_file_id
      FROM documents d
      WHERE d.status = 'unclassified'
    `).all() as Array<{ id: number; processed_file_id: number }>;

    // Delete the unclassified document records so the pipeline can recreate them
    for (const doc of unclassified) {
      db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    }

    // Get unique processed_file_ids and reset their status to 'pending'
    const fileIds = [...new Set(unclassified.map((d) => d.processed_file_id))];
    for (const fid of fileIds) {
      db.prepare("UPDATE processed_files SET status = 'pending' WHERE id = ?").run(fid);
      // Re-trigger pipeline
      processFile(fid).catch((err) => {
        console.error(`[reprocess] Error for file ${fid}:`, err);
      });
    }

    res.json({ ok: true, reprocessing: fileIds.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Corrections endpoint — view paralegal corrections for prompt improvement
app.get('/api/corrections', verifyToken, (_req, res) => {
  try {
    const db = getDb();
    const corrections = db.prepare(`
      SELECT c.id, c.document_id, c.field_name, c.ai_value, c.paralegal_value,
             c.paralegal_name, c.file_name, c.created_at
      FROM corrections c
      ORDER BY c.created_at DESC
      LIMIT 200
    `).all();

    // Summary stats
    const summary = db.prepare(`
      SELECT field_name, COUNT(*) as count,
             GROUP_CONCAT(COALESCE(ai_value, '(empty)') || ' -> ' || COALESCE(paralegal_value, '(empty)'), ' | ') as examples
      FROM (
        SELECT DISTINCT field_name, ai_value, paralegal_value
        FROM corrections
      )
      GROUP BY field_name
      ORDER BY count DESC
    `).all();

    res.json({ corrections, summary });
  } catch (err) {
    console.error('[corrections] Error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Usage endpoint
app.get('/api/usage', verifyToken, (req, res) => {
  const db = getDb();
  const period = (req.query.period as string) || 'all';

  let dateFilter = '';
  if (period === 'today') {
    dateFilter = "AND created_at >= date('now')";
  } else if (period === 'week') {
    dateFilter = "AND created_at >= date('now', '-7 days')";
  } else if (period === 'month') {
    dateFilter = "AND created_at >= date('now', '-30 days')";
  }

  const summary = db.prepare(`
    SELECT
      COALESCE(SUM(cost_usd), 0) as totalCost,
      COALESCE(SUM(input_tokens), 0) as totalInputTokens,
      COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
      COUNT(*) as requestCount
    FROM api_usage
    WHERE 1=1 ${dateFilter}
  `).get() as { totalCost: number; totalInputTokens: number; totalOutputTokens: number; requestCount: number };

  res.json({ ...summary, period });
});

// ---- Admin endpoints ----

// GET /api/admin/rules — current active rules + history
app.get('/api/admin/rules', verifyToken, (_req, res) => {
  const active = getActiveRules();
  const history = getRulesHistory();
  res.json({ active, history });
});

// GET /api/admin/prompt — full assembled Haiku prompt with rules
app.get('/api/admin/prompt', verifyToken, (_req, res) => {
  const active = getActiveRules();
  let fullPrompt = SYSTEM_PROMPT;
  if (active?.rules_text) {
    fullPrompt += `\n\nLEARNED RULES (from paralegal feedback — follow these strictly):\n${active.rules_text}`;
  }
  // Estimate token count (~4 chars per token)
  const estimatedTokens = Math.ceil(fullPrompt.length / 4);
  res.json({ prompt: fullPrompt, estimatedTokens, rulesVersion: active?.version ?? 0 });
});

// GET /api/admin/corrections-status — corrections count + trigger status
app.get('/api/admin/corrections-status', verifyToken, (_req, res) => {
  const db = getDb();
  const correctionsSinceLastAnalysis = getCorrectionsSinceLastAnalysis();
  const canTrigger = shouldAutoTrigger();
  const totalCorrections = (db.prepare('SELECT COUNT(*) as c FROM corrections').get() as { c: number }).c;
  const totalApproved = (db.prepare("SELECT COUNT(*) as c FROM documents WHERE status IN ('approved', 'sorted')").get() as { c: number }).c;
  const approvedWithCorrections = (db.prepare('SELECT COUNT(DISTINCT document_id) as c FROM corrections').get() as { c: number }).c;
  const accuracyRate = totalApproved > 0 ? ((totalApproved - approvedWithCorrections) / totalApproved * 100) : null;

  // Corrections by field
  const byField = db.prepare(`
    SELECT field_name, COUNT(*) as count FROM corrections GROUP BY field_name ORDER BY count DESC
  `).all();

  // Corrections over time (grouped by date)
  const overTime = db.prepare(`
    SELECT date(created_at) as date, COUNT(*) as count FROM corrections GROUP BY date(created_at) ORDER BY date ASC
  `).all();

  res.json({
    correctionsSinceLastAnalysis,
    triggerThreshold: 10,
    canAutoTrigger: canTrigger,
    totalCorrections,
    totalApproved,
    approvedWithCorrections,
    accuracyRate,
    byField,
    overTime,
  });
});

// POST /api/admin/optimize — manually trigger Opus analysis
app.post('/api/admin/optimize', verifyToken, async (_req, res) => {
  try {
    const result = await analyzeCorrectionsAndGenerateRules();
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[admin] Optimization failed:', msg);
    res.status(500).json({ error: msg });
  }
});

// Serve static frontend in production
if (process.env.NODE_ENV === 'production') {
  const webDist = path.resolve(__dirname, '../../web/dist');
  app.use(express.static(webDist, {
    etag: true,
    maxAge: 0,
    setHeaders: (res, filePath) => {
      // Cache JS/CSS with hashed filenames for 1 year, everything else no-cache
      if (filePath.match(/\.[a-f0-9]{8}\./)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

// Wire up the file processing pipeline
setOnNewFile(processFile);

// --- Graceful shutdown: close SQLite cleanly to prevent corruption ---
function shutdown(signal: string) {
  console.log(`[server] ${signal} received — shutting down gracefully`);
  try {
    const db = getDb();
    db.pragma('wal_checkpoint(TRUNCATE)');  // Flush WAL to main DB file
    db.close();
    console.log('[server] Database closed cleanly');
  } catch (err) {
    console.error('[server] Error closing database:', err);
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- Automatic daily database backup ---
function backupDatabase() {
  try {
    const db = getDb();
    const dbPath = process.env.DATABASE_PATH || './data/doctriage.db';
    const backupDir = path.dirname(dbPath);
    const timestamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const backupPath = path.join(backupDir, `doctriage-backup-${timestamp}.db`);
    db.backup(backupPath).then(() => {
      console.log(`[backup] Database backed up to ${backupPath}`);
      // Remove backups older than 7 days
      import('fs').then(fs => {
        const files = fs.readdirSync(backupDir);
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        for (const file of files) {
          if (file.startsWith('doctriage-backup-') && file.endsWith('.db')) {
            const filePath = path.join(backupDir, file);
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs < cutoff) {
              fs.unlinkSync(filePath);
              console.log(`[backup] Removed old backup: ${file}`);
            }
          }
        }
      });
    }).catch((err: unknown) => {
      console.error('[backup] Backup failed:', err);
    });
  } catch (err) {
    console.error('[backup] Backup error:', err);
  }
}

app.listen(PORT, () => {
  console.log(`[server] Running on http://localhost:${PORT}`);

  // Start watching Dropbox folders
  startWatcher().catch((err) => {
    console.error('[server] Failed to start watcher:', err);
  });

  // Run a backup on startup, then every 24 hours
  backupDatabase();
  setInterval(backupDatabase, 24 * 60 * 60 * 1000);
});
