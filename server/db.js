import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** ISO timestamps sort correctly as text and are portable across SQLite tools. */
export const nowIso = () => new Date().toISOString();

/**
 * Create the small server-side store used only for invites and device access.
 * Projects and source photographs remain in the browser's IndexedDB.
 */
export function initDatabase(db) {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id          TEXT PRIMARY KEY,
      token_hash  TEXT NOT NULL UNIQUE,
      label       TEXT,
      created_at  TEXT NOT NULL,
      last_seen   TEXT NOT NULL,
      revoked     INTEGER NOT NULL DEFAULT 0,
      has_push    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS invites (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code_hash   TEXT NOT NULL UNIQUE,
      code        TEXT,
      label       TEXT,
      url         TEXT,
      created_at  TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      used_at     TEXT,
      revoked     INTEGER NOT NULL DEFAULT 0,
      device_id   TEXT REFERENCES devices(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_devices_created_at
      ON devices(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_invites_created_at
      ON invites(created_at DESC);
  `);

  return db;
}

export function openDatabase(file = null) {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const dbFile = file || path.join(dataDir, 'stencil-cnc.db');

  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  return initDatabase(new DatabaseSync(dbFile));
}
