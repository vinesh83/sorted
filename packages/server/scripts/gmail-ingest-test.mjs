#!/usr/bin/env node
// Test/verification runner: starts ONLY the Gmail→Dropbox poller (no Dropbox
// watcher, no OCR/classification pipeline, no Express). Safe to run alongside
// the Railway deployment because it never touches Asana or the classification
// pipeline — it only reads Gmail and uploads attachments to /New Sort Folder.
//
// Usage (from repo root):  node packages/server/scripts/gmail-ingest-test.mjs

import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const { initDb } = await import('../dist/db/schema.js');
const { startGmailWatcher, getGmailStatus } = await import('../dist/services/gmail-watcher.js');

initDb();
await startGmailWatcher();

setInterval(() => {
  const s = getGmailStatus();
  console.log('[status]', JSON.stringify(s));
}, 15000);

console.log('[gmail-ingest-test] Running. Send a test email with an attachment to docs@vpatellaw.com.');
