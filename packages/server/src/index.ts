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
import { startWatcher, getWatcherStatus, setOnNewFile } from './services/watcher.js';
import { processFile } from './services/pipeline.js';

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
app.get('/api/status', (_req, res) => {
  const db = getDb();
  const { watcherRunning, dropboxConnected, processingCount } = getWatcherStatus();
  const counts = db.prepare(`
    SELECT
      COUNT(CASE WHEN status = 'pending' THEN 1 END) as pendingCount,
      COUNT(CASE WHEN status = 'approved' THEN 1 END) as approvedCount
    FROM documents
  `).get() as { pendingCount: number; approvedCount: number };

  res.json({
    watcherRunning,
    dropboxConnected,
    processingCount,
    pendingCount: counts.pendingCount,
    approvedCount: counts.approvedCount,
    timestamp: new Date().toISOString(),
  });
});

// Usage endpoint
app.get('/api/usage', (_req, res) => {
  const db = getDb();
  const period = (_req.query.period as string) || 'all';

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

// Serve static frontend in production
if (process.env.NODE_ENV === 'production') {
  const webDist = path.resolve(__dirname, '../../web/dist');
  app.use(express.static(webDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

// Wire up the file processing pipeline
setOnNewFile(processFile);

app.listen(PORT, () => {
  console.log(`[server] Running on http://localhost:${PORT}`);

  // Start watching Dropbox folders
  startWatcher().catch((err) => {
    console.error('[server] Failed to start watcher:', err);
  });
});
