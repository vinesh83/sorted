import { getDb } from '../db/connection.js';
import {
  listFolder,
  listFolderContinue,
  getParalegalFolders,
  getMimeType,
  isConnected,
  type DropboxFileEntry,
} from './dropbox.js';
import type { ParalegalName } from 'shared/types.js';

const POLL_INTERVAL = 30_000; // 30 seconds
const SUPPORTED_EXTENSIONS = new Set(['pdf', 'jpg', 'jpeg', 'png', 'docx', 'doc']);

// Store cursors per folder
const cursors = new Map<string, string>();

let watcherRunning = false;
let dropboxConnected = false;
let processingCount = 0;

// Pipeline callback — set by index.ts to wire OCR + classification
let onNewFile: ((fileId: number) => Promise<void>) | null = null;

export function setOnNewFile(fn: (fileId: number) => Promise<void>) {
  onNewFile = fn;
}

export function getWatcherStatus() {
  return { watcherRunning, dropboxConnected, processingCount };
}

function getExtension(name: string): string {
  return name.toLowerCase().split('.').pop() || '';
}

function isNewFile(entry: DropboxFileEntry): boolean {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM processed_files WHERE dropbox_file_id = ?').get(entry.id);
  return !existing;
}

function insertProcessedFile(entry: DropboxFileEntry, paralegalName: ParalegalName): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO processed_files (dropbox_file_id, dropbox_path, file_name, file_size, mime_type, content_hash, paralegal_name, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    entry.id,
    entry.path_display,
    entry.name,
    entry.size,
    getMimeType(entry.name),
    entry.content_hash,
    paralegalName,
  );
  return Number(result.lastInsertRowid);
}

async function scanFolder(name: ParalegalName, folderPath: string): Promise<DropboxFileEntry[]> {
  const existingCursor = cursors.get(folderPath);

  try {
    if (existingCursor) {
      // Delta poll — only new/changed files
      const { entries, cursor } = await listFolderContinue(existingCursor);
      cursors.set(folderPath, cursor);
      return entries;
    } else {
      // Initial scan — get everything
      const { entries, cursor } = await listFolder(folderPath);
      cursors.set(folderPath, cursor);
      return entries;
    }
  } catch (err) {
    console.error(`[watcher] Error scanning ${name} (${folderPath}):`, err);
    // If cursor is stale, reset it
    if (existingCursor) {
      cursors.delete(folderPath);
    }
    return [];
  }
}

async function processNewFiles(entries: DropboxFileEntry[], paralegalName: ParalegalName) {
  for (const entry of entries) {
    const ext = getExtension(entry.name);
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      console.log(`[watcher] Skipping unsupported file: ${entry.name}`);
      continue;
    }

    if (!isNewFile(entry)) {
      continue;
    }

    console.log(`[watcher] New file: ${entry.name} (${paralegalName})`);
    const fileId = insertProcessedFile(entry, paralegalName);

    // Trigger pipeline asynchronously (don't block the watcher)
    if (onNewFile) {
      processingCount++;
      onNewFile(fileId)
        .catch((err) => {
          console.error(`[watcher] Pipeline error for ${entry.name}:`, err);
          const db = getDb();
          db.prepare("UPDATE processed_files SET status = 'error' WHERE id = ?").run(fileId);
        })
        .finally(() => {
          processingCount--;
        });
    }
  }
}

async function pollOnce() {
  const folders = getParalegalFolders();

  for (const { name, path } of folders) {
    const entries = await scanFolder(name, path);
    if (entries.length > 0) {
      await processNewFiles(entries, name);
    }
  }
}

export async function startWatcher() {
  console.log('[watcher] Starting file watcher...');

  // Check Dropbox connection first
  dropboxConnected = await isConnected();
  if (!dropboxConnected) {
    console.error('[watcher] Cannot connect to Dropbox. Will retry...');
  } else {
    console.log('[watcher] Dropbox connected');
  }

  watcherRunning = true;

  // Initial scan
  try {
    await pollOnce();
  } catch (err) {
    console.error('[watcher] Initial scan error:', err);
  }

  // Start polling loop
  const poll = async () => {
    if (!watcherRunning) return;

    try {
      await pollOnce();
      dropboxConnected = true;
    } catch (err) {
      dropboxConnected = false;
      console.error('[watcher] Poll error:', err);
    }

    setTimeout(poll, POLL_INTERVAL);
  };

  setTimeout(poll, POLL_INTERVAL);
}

export async function rescan() {
  console.log('[watcher] Manual rescan triggered — clearing cursors');
  cursors.clear();
  await pollOnce();
}

export function stopWatcher() {
  watcherRunning = false;
  console.log('[watcher] Stopped');
}
