import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** ISO timestamps sort correctly as text and are portable across SQLite tools. */
export const nowIso = () => new Date().toISOString();

/**
 * Create the server-side metadata store. Editable projects remain in the
 * browser's IndexedDB unless a user explicitly publishes an encrypted share.
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

    CREATE TABLE IF NOT EXISTS project_shares (
      id                  TEXT PRIMARY KEY,
      owner_device_id     TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      recipient_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
      client_project_id   TEXT,
      token_hash          TEXT NOT NULL,
      name                TEXT NOT NULL,
      panel_width_mm      REAL,
      panel_height_mm     REAL,
      cut_style           TEXT,
      has_source          INTEGER NOT NULL DEFAULT 0,
      checkpoint_count    INTEGER NOT NULL DEFAULT 0,
      artifact_count      INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT NOT NULL,
      expires_at          TEXT NOT NULL,
      revoked_at          TEXT,
      size_bytes          INTEGER NOT NULL,
      bundle_sha256       TEXT NOT NULL,
      file_name           TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_project_shares_owner
      ON project_shares(owner_device_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_shares_recipient
      ON project_shares(recipient_device_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_shares_expiry
      ON project_shares(expires_at);
  `);

  return db;
}

export function openDatabase(file = null) {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const dbFile = file || path.join(dataDir, 'stencil-cnc.db');

  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  return initDatabase(new DatabaseSync(dbFile));
}
