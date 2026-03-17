import { getDb } from './connection.js';

export function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      request_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS processed_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dropbox_file_id TEXT UNIQUE NOT NULL,
      dropbox_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_size INTEGER,
      mime_type TEXT,
      content_hash TEXT,
      paralegal_name TEXT NOT NULL,
      processed_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      processed_file_id INTEGER NOT NULL REFERENCES processed_files(id),
      page_start INTEGER,
      page_end INTEGER,
      split_group_id TEXT,
      extracted_text TEXT,
      ocr_partial INTEGER DEFAULT 0,
      document_label TEXT,
      client_name TEXT,
      description TEXT,
      event_type TEXT,
      suggested_section TEXT,
      document_date TEXT,
      confidence REAL,
      is_legal_document INTEGER DEFAULT 1,
      classification_error TEXT,
      edited_label TEXT,
      edited_client_name TEXT,
      edited_description TEXT,
      edited_event_type TEXT,
      edited_date TEXT,
      asana_project_gid TEXT,
      asana_project_name TEXT,
      asana_section_gid TEXT,
      asana_section_name TEXT,
      claimed_by TEXT,
      claimed_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      assigned_paralegal TEXT,
      asana_task_gid TEXT,
      asana_task_url TEXT,
      asana_error TEXT,
      approved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS split_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      processed_file_id INTEGER NOT NULL REFERENCES processed_files(id),
      suggested_splits TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      final_splits TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  console.log('[db] Schema initialized');
}
