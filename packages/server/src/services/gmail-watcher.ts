// Gmail → Dropbox attachment poller. Mirrors watcher.ts: a setTimeout polling
// loop in the same process. Pulls real file attachments from new inbox mail and
// drops them into the New Sort Folder root for manual sorting.

import { getDb } from '../db/connection.js';
import { uploadFile } from './dropbox.js';
import { NEW_SORT_ROOT } from 'shared/types.js';
import {
  isConfigured,
  isConnected,
  ensureProcessedLabel,
  listMessageIds,
  getMessage,
  getAttachment,
  addLabel,
  extractAttachments,
  getHeader,
} from './gmail.js';

const POLL_INTERVAL = Number(process.env.GMAIL_POLL_INTERVAL) || 60_000;

// Base query: inbox mail with an attachment that we haven't already handled.
// At poll time we append `after:<watermark>` so ONLY mail that arrived after
// activation is ever considered — existing/old mail is never listed, labeled,
// or downloaded.
const BASE_QUERY = 'in:inbox has:attachment -label:Sorted/Processed';

let watcherRunning = false;
let gmailConnected = false;
let lastCheckedAt: string | null = null;
let pollTimeout: ReturnType<typeof setTimeout> | null = null;
let polling = false; // guard against overlapping polls

export function getGmailStatus() {
  const db = getDb();
  const processedTotal =
    (db.prepare('SELECT COUNT(*) as c FROM gmail_messages').get() as { c: number } | undefined)?.c ?? 0;
  return {
    gmailWatcherRunning: watcherRunning,
    gmailConnected,
    gmailLastCheckedAt: lastCheckedAt,
    gmailProcessedTotal: processedTotal,
  };
}

function getState(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setState(key: string, value: string) {
  const db = getDb();
  db.prepare(
    'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

function alreadyProcessed(messageId: string): boolean {
  const db = getDb();
  return Boolean(
    db.prepare('SELECT 1 FROM gmail_messages WHERE gmail_message_id = ?').get(messageId),
  );
}

function recordMessage(
  messageId: string,
  from: string | undefined,
  subject: string | undefined,
  receivedAt: string | undefined,
  attachmentCount: number,
  status: string,
) {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO gmail_messages
       (gmail_message_id, from_address, subject, received_at, attachment_count, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(messageId, from ?? null, subject ?? null, receivedAt ?? null, attachmentCount, status);
}

/** Establish the "only new mail going forward" watermark on first activation.
 *  We record the current time (epoch seconds) and ONLY ever ingest mail received
 *  strictly after it. Old/existing mail is never listed, labeled, or downloaded —
 *  this is instant regardless of inbox size and leaves the existing inbox untouched. */
function ensureWatermark(): number {
  const existing = getState('gmail_since_epoch');
  if (existing) return Number(existing);
  const nowEpoch = Math.floor(Date.now() / 1000);
  setState('gmail_since_epoch', String(nowEpoch));
  console.log(
    `[gmail] Activation watermark set to ${new Date(nowEpoch * 1000).toISOString()} — ` +
      'only mail received after this is ingested; existing inbox is left untouched.',
  );
  return nowEpoch;
}

/** Make an attachment filename safe to use as a flat Dropbox filename:
 *  strip any path separators / control chars and leading dots so it can never
 *  create unintended subfolders or a malformed path. */
function sanitizeFilename(name: string, attachmentId: string): string {
  const cleaned = name
    .replace(/[/\\]/g, '_')       // no path separators
    .replace(/[\x00-\x1f]/g, '')  // no control chars
    .replace(/^\.+/, '')          // no leading dots (hidden files / traversal)
    .trim();
  return cleaned || `attachment-${attachmentId.slice(0, 12)}.bin`;
}

async function processMessage(messageId: string, labelId: string, sinceEpoch: number) {
  if (alreadyProcessed(messageId)) return;

  const msg = await getMessage(messageId);

  // Belt-and-suspenders: never ingest mail received at or before the activation
  // watermark, even if the server-side `after:` filter is coarse. Skip silently
  // (don't label) — old mail is simply ignored, never touched.
  if (msg.internalDate && Number(msg.internalDate) <= sinceEpoch * 1000) {
    return;
  }

  const headers = msg.payload?.headers;
  const from = getHeader(headers, 'From');
  const subject = getHeader(headers, 'Subject');
  const receivedAt = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString()
    : undefined;

  const attachments = extractAttachments(msg.payload);

  let uploaded = 0;
  for (const att of attachments) {
    const safeName = sanitizeFilename(att.filename, att.attachmentId);
    try {
      const data = await getAttachment(messageId, att.attachmentId);
      const dest = `${NEW_SORT_ROOT}/${safeName}`;
      const actualPath = await uploadFile(dest, data);
      uploaded++;
      console.log(`[gmail] Uploaded "${safeName}" → ${actualPath}`);
    } catch (err) {
      console.error(`[gmail] Failed to upload attachment "${safeName}" from ${messageId}:`, err);
      // Deliberately bubble up WITHOUT labeling the message. The whole message is
      // retried next poll. Worst case is a duplicate of an already-uploaded sibling
      // attachment (Dropbox autorename → "name (1).pdf", never an overwrite). This
      // is intentional: we prefer a rare visible duplicate over a lost attachment.
      throw err;
    }
  }

  // Only label (mark done) after all attachments uploaded successfully.
  await addLabel(messageId, labelId);
  recordMessage(messageId, from, subject, receivedAt, uploaded, 'processed');

  if (uploaded === 0) {
    console.log(`[gmail] ${messageId}: no real attachments (inline-only) — labeled, nothing uploaded`);
  }
}

async function pollOnce(labelId: string, sinceEpoch: number) {
  const query = `${BASE_QUERY} after:${sinceEpoch}`;
  const ids = await listMessageIds(query);
  if (ids.length > 0) {
    console.log(`[gmail] ${ids.length} new message(s) with attachments`);
  }
  for (const id of ids) {
    try {
      await processMessage(id, labelId, sinceEpoch);
    } catch (err) {
      console.error(`[gmail] Error processing message ${id} (will retry next poll):`, err);
    }
  }
}

/** Force a single poll cycle on demand (used by POST /api/gmail/ingest). */
export async function ingestNow(): Promise<{ ok: boolean }> {
  if (!isConfigured()) throw new Error('Gmail is not configured');
  const labelId = await ensureProcessedLabel();
  const sinceEpoch = ensureWatermark();
  await pollOnce(labelId, sinceEpoch);
  lastCheckedAt = new Date().toISOString();
  return { ok: true };
}

export async function startGmailWatcher() {
  if (!isConfigured()) {
    console.log('[gmail] Not configured (GOOGLE_* env missing) — Gmail ingest disabled');
    return;
  }

  console.log('[gmail] Starting Gmail watcher...');
  gmailConnected = await isConnected();
  if (!gmailConnected) {
    console.error('[gmail] Cannot connect to Gmail. Will retry...');
  } else {
    console.log('[gmail] Connected');
  }

  watcherRunning = true;

  let labelId: string;
  let sinceEpoch: number;
  try {
    labelId = await ensureProcessedLabel();
    sinceEpoch = ensureWatermark();
  } catch (err) {
    console.error('[gmail] Setup failed:', err);
    // Retry the whole startup after one interval
    pollTimeout = setTimeout(() => {
      startGmailWatcher().catch((e) => console.error('[gmail] Restart failed:', e));
    }, POLL_INTERVAL);
    return;
  }

  const poll = async () => {
    if (!watcherRunning) return;
    if (polling) {
      pollTimeout = setTimeout(poll, POLL_INTERVAL);
      return;
    }
    polling = true;
    try {
      await pollOnce(labelId, sinceEpoch);
      gmailConnected = true;
    } catch (err) {
      gmailConnected = false;
      console.error('[gmail] Poll error:', err);
    } finally {
      polling = false;
      lastCheckedAt = new Date().toISOString();
    }
    if (watcherRunning) {
      pollTimeout = setTimeout(poll, POLL_INTERVAL);
    }
  };

  pollTimeout = setTimeout(poll, POLL_INTERVAL);
}

export function stopGmailWatcher() {
  watcherRunning = false;
  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }
  console.log('[gmail] Stopped');
}
