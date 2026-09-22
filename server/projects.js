import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ProjectAssetError } from './project-assets.js';
import { parseBundle, ShareError } from './shares.js';

const FILE_MAGIC_V1 = Buffer.from('STPJ1');
const FILE_MAGIC_V2 = Buffer.from('STPJ2');
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID_PART = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const LEGACY_PROJECT_FILE = new RegExp(`^${UUID_PART}\\.project$`, 'i');
const REVISION_PROJECT_FILE = new RegExp(
  `^${UUID_PART}\\.r[1-9][0-9]*\\.${UUID_PART}\\.project$`,
  'i',
);
const DEFAULT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MIGRATION_BACKUP_MS = 7 * 24 * 60 * 60 * 1000;
const PROJECT_MANIFEST_SCHEMA = 'kerfloom.project-manifest';
const PROJECT_MANIFEST_VERSION = 1;
const LEGACY_STORAGE_FORMAT = 'legacy-bundle-v1';
const MANIFEST_STORAGE_FORMAT = 'asset-manifest-v1';

function cleanText(value, fallback, maximum = 120) {
  const cleaned = typeof value === 'string' ? value.trim().slice(0, maximum) : '';
  return cleaned || fallback;
}

function cleanThumbnail(value) {
  if (typeof value !== 'string' || value.length > 256 * 1024) return null;
  return /^data:image\/(?:png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : null;
}

function parseProjectPayload(buffer) {
  let candidate;
  try {
    candidate = JSON.parse(buffer.toString('utf8'));
  } catch {
    candidate = null;
  }
  if (candidate?.schema !== PROJECT_MANIFEST_SCHEMA) {
    return { bundle: parseBundle(buffer), storageFormat: LEGACY_STORAGE_FORMAT, assetRefs: [] };
  }
  if (candidate.version !== PROJECT_MANIFEST_VERSION ||
      !candidate.project || candidate.project.schema !== 'stencil-cnc.project' ||
      !Array.isArray(candidate.checkpoints) || !Array.isArray(candidate.artifacts) ||
      candidate.checkpoints.length > 10 || candidate.artifacts.length > 30 ||
      candidate.source != null && typeof candidate.source !== 'object' ||
      candidate.artifacts.some((artifact) => !artifact || typeof artifact !== 'object')) {
    throw new ProjectError(400, 'The project state manifest is invalid.', 'bad_manifest');
  }
  return { bundle: candidate, storageFormat: MANIFEST_STORAGE_FORMAT, assetRefs: null };
}

function sameHash(left, right) {
  const a = Buffer.from(String(left), 'hex');
  const b = Buffer.from(String(right), 'hex');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function encryptionKey(secret) {
  return crypto.createHash('sha256')
    .update('kerfloom/server-project/v1\0')
    .update(String(secret))
    .digest();
}

function publicRow(row) {
  return {
    id: row.client_project_id,
    revision: row.revision,
    name: row.name,
    sheet: row.panel_width_mm && row.panel_height_mm
      ? { widthMm: row.panel_width_mm, heightMm: row.panel_height_mm }
      : null,
    cutStyle: row.cut_style,
    status: row.status,
    hasSource: Boolean(row.has_source),
    checkpointCount: row.checkpoint_count,
    artifactCount: row.artifact_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    trashedAt: row.trashed_at,
    deletedAt: row.deleted_at,
    sizeBytes: row.size_bytes,
    sha256: row.bundle_sha256,
    storageFormat: row.storage_format || LEGACY_STORAGE_FORMAT,
    thumbnail: row.thumbnail_data_url || null,
  };
}

function expectedRevision(value) {
  const unquoted = String(value ?? '').trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const parsed = Number.parseInt(unquoted, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export class ProjectError extends Error {
  constructor(status, message, code, details = {}) {
    super(message);
    this.name = 'ProjectError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ProjectService {
  constructor(db, options = {}) {
    this.db = db;
    this.directory = options.directory || path.join(
      process.env.DATA_DIR || path.join(process.cwd(), 'data'),
      'projects',
    );
    this.secret = String(options.encryptionSecret ?? process.env.PROJECT_ENCRYPTION_KEY ?? '').trim();
    this.keyId = String(options.encryptionKeyId || 'primary').trim();
    if (!KEY_ID.test(this.keyId)) {
      throw new ProjectError(500, 'The project encryption key identifier is invalid.', 'bad_key_id');
    }
    this.decryptionKeys = new Map();
    const previousKeys = options.decryptionKeys instanceof Map
      ? options.decryptionKeys
      : new Map(Object.entries(options.decryptionKeys || {}));
    for (const [keyId, secret] of previousKeys) {
      if (KEY_ID.test(String(keyId)) && String(secret).trim().length >= 32) {
        this.decryptionKeys.set(String(keyId), String(secret).trim());
      }
    }
    this.decryptionKeys.set(this.keyId, this.secret);
    this.clock = options.clock || (() => new Date());
    this.maximumBytes = Number(
      options.maximumBytes ?? process.env.PROJECT_MAX_BYTES ?? 128 * 1024 * 1024,
    );
    this.maximumWorkspaceBytes = Number(
      options.maximumWorkspaceBytes ?? process.env.PROJECT_WORKSPACE_MAX_BYTES ?? 2 * 1024 * 1024 * 1024,
    );
    this.orphanGraceMs = Number(options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS);
    this.migrationBackupMs = Number(options.migrationBackupMs ?? DEFAULT_MIGRATION_BACKUP_MS);
    this.faultInjector = options.faultInjector || null;
    this.assets = options.assets || null;
    this.onStorageWarning = options.onStorageWarning || ((message, error) => {
      console.error(message, error);
    });
    this.recoverySummary = options.recoverOnStart === false
      ? null
      : this.recoverStorage();
  }

  ensureAvailable() {
    if (this.secret.length < 32) {
      throw new ProjectError(503, 'Server project storage is not configured.', 'storage_unavailable');
    }
  }

  validateClientId(value) {
    const id = String(value || '');
    if (!CLIENT_ID.test(id)) {
      throw new ProjectError(400, 'Invalid project identifier.', 'bad_project_id');
    }
    return id;
  }

  filePath(fileName) {
    return path.join(this.directory, path.basename(fileName));
  }

  revisionFileName(id, revision) {
    return `${id}.r${revision}.${crypto.randomUUID()}.project`;
  }

  injectFault(phase, details = {}) {
    this.faultInjector?.(phase, details);
  }

  warn(message, error) {
    try {
      this.onStorageWarning(message, error);
    } catch {
      // Reporting a cleanup problem must never change committed project data.
    }
  }

  syncDirectory() {
    let descriptor;
    try {
      descriptor = fs.openSync(this.directory, 'r');
      fs.fsyncSync(descriptor);
    } catch (error) {
      // Directory fsync is unavailable on some development filesystems. The
      // file itself is still flushed, and production Linux supports this.
      if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error?.code)) throw error;
    } finally {
      if (descriptor != null) fs.closeSync(descriptor);
    }
  }

  publishRevision(fileName, encrypted) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const target = this.filePath(fileName);
    const temporary = this.filePath(`${fileName}.${crypto.randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, encrypted);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporary, target);
      this.syncDirectory();
      return target;
    } catch (error) {
      if (descriptor != null) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }

  fileMatches(row, fileName) {
    try {
      const plain = this.decrypt(fs.readFileSync(this.filePath(fileName)));
      const digest = crypto.createHash('sha256').update(plain).digest('hex');
      return sameHash(digest, row.bundle_sha256);
    } catch {
      return false;
    }
  }

  ownedOrphanFile(fileName) {
    if (LEGACY_PROJECT_FILE.test(fileName) || REVISION_PROJECT_FILE.test(fileName)) return true;
    if (fileName.endsWith('.tmp')) {
      const base = fileName.replace(new RegExp(`\\.${UUID_PART}\\.tmp$`, 'i'), '');
      return LEGACY_PROJECT_FILE.test(base) || REVISION_PROJECT_FILE.test(base);
    }
    if (fileName.endsWith('.bak')) {
      const base = fileName.replace(new RegExp(`\\.${UUID_PART}\\.bak$`, 'i'), '');
      return LEGACY_PROJECT_FILE.test(base);
    }
    return false;
  }

  recoverStorage() {
    const summary = { restoredLegacyFiles: 0, removedOrphans: 0, warnings: 0 };
    if (this.secret.length < 32 || !fs.existsSync(this.directory)) return summary;

    const activeRows = this.db.prepare(`
      SELECT file_name, bundle_sha256 FROM server_projects
      WHERE deleted_at IS NULL
    `).all();
    const now = this.clock().toISOString();
    const expiredBackups = this.db.prepare(`
      SELECT id, file_name FROM project_revision_backups WHERE expires_at <= ?
    `).all(now);
    for (const backup of expiredBackups) {
      try {
        this.db.prepare('DELETE FROM project_revision_backups WHERE id = ?').run(backup.id);
        fs.rmSync(this.filePath(backup.file_name), { force: true });
        summary.removedOrphans += 1;
      } catch (error) {
        summary.warnings += 1;
        this.warn('Kerfloom could not expire a legacy migration backup.', error);
      }
    }

    // Recover files written by the old replace-in-place protocol. Depending on
    // its crash point, SQLite may still describe the .bak while the target is
    // missing or contains the uncommitted replacement.
    for (const row of activeRows) {
      if (!LEGACY_PROJECT_FILE.test(row.file_name) || this.fileMatches(row, row.file_name)) continue;
      const prefix = `${row.file_name}.`;
      const backups = fs.readdirSync(this.directory)
        .filter((name) => name.startsWith(prefix) && name.endsWith('.bak'));
      const matchingBackup = backups.find((name) => this.fileMatches(row, name));
      if (!matchingBackup) continue;
      const target = this.filePath(row.file_name);
      try {
        if (fs.existsSync(target)) {
          fs.renameSync(target, this.filePath(`${row.file_name}.${crypto.randomUUID()}.unmatched`));
        }
        fs.renameSync(this.filePath(matchingBackup), target);
        this.syncDirectory();
        summary.restoredLegacyFiles += 1;
      } catch (error) {
        summary.warnings += 1;
        this.warn('Kerfloom could not recover a legacy project revision.', error);
      }
    }

    const retainedBackups = this.db.prepare(`
      SELECT file_name FROM project_revision_backups WHERE expires_at > ?
    `).all(now);
    const referenced = new Set([
      ...activeRows.map((row) => path.basename(row.file_name)),
      ...retainedBackups.map((row) => path.basename(row.file_name)),
    ]);
    const cutoff = Date.now() - Math.max(0, this.orphanGraceMs);
    for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || referenced.has(entry.name) || !this.ownedOrphanFile(entry.name)) continue;
      try {
        const candidate = this.filePath(entry.name);
        if (fs.statSync(candidate).mtimeMs > cutoff) continue;
        fs.rmSync(candidate);
        summary.removedOrphans += 1;
      } catch (error) {
        summary.warnings += 1;
        this.warn('Kerfloom could not remove an unreferenced project file.', error);
      }
    }
    if (summary.removedOrphans > 0) {
      try { this.syncDirectory(); } catch (error) {
        summary.warnings += 1;
        this.warn('Kerfloom could not flush project-storage cleanup metadata.', error);
      }
    }
    return summary;
  }

  encrypt(buffer) {
    const keyId = Buffer.from(this.keyId, 'utf8');
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(this.secret), nonce);
    const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
    return Buffer.concat([
      FILE_MAGIC_V2,
      Buffer.from([keyId.length]),
      keyId,
      nonce,
      cipher.getAuthTag(),
      ciphertext,
    ]);
  }

  encryptLegacy(buffer, secret = this.secret) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret), nonce);
    const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
    return Buffer.concat([FILE_MAGIC_V1, nonce, cipher.getAuthTag(), ciphertext]);
  }

  decryptWithSecret(buffer, secret, nonceStart) {
    const tagStart = nonceStart + 12;
    const bodyStart = tagStart + 16;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(secret),
      buffer.subarray(nonceStart, tagStart),
    );
    decipher.setAuthTag(buffer.subarray(tagStart, bodyStart));
    return Buffer.concat([decipher.update(buffer.subarray(bodyStart)), decipher.final()]);
  }

  decrypt(buffer) {
    if (buffer.length >= FILE_MAGIC_V2.length + 29 &&
        buffer.subarray(0, FILE_MAGIC_V2.length).equals(FILE_MAGIC_V2)) {
      const keyIdLength = buffer[FILE_MAGIC_V2.length];
      const nonceStart = FILE_MAGIC_V2.length + 1 + keyIdLength;
      if (keyIdLength < 1 || nonceStart + 28 > buffer.length) {
        throw new ProjectError(500, 'The stored project package is damaged.', 'bundle_damaged');
      }
      const keyId = buffer.subarray(FILE_MAGIC_V2.length + 1, nonceStart).toString('utf8');
      const secret = this.decryptionKeys.get(keyId);
      if (!secret) {
        throw new ProjectError(
          500,
          'The encryption key for this project revision is unavailable.',
          'encryption_key_unavailable',
        );
      }
      try {
        return this.decryptWithSecret(buffer, secret, nonceStart);
      } catch {
        throw new ProjectError(500, 'The stored project package could not be decrypted.', 'bundle_damaged');
      }
    }

    if (buffer.length < FILE_MAGIC_V1.length + 28 ||
        !buffer.subarray(0, FILE_MAGIC_V1.length).equals(FILE_MAGIC_V1)) {
      throw new ProjectError(500, 'The stored project package is damaged.', 'bundle_damaged');
    }
    // Version 1 did not record a key ID. Try the configured ring so it remains
    // readable during a staged rotation, then rewrite it with an ID on save or
    // through the explicit migration command.
    for (const secret of new Set(this.decryptionKeys.values())) {
      try {
        return this.decryptWithSecret(buffer, secret, FILE_MAGIC_V1.length);
      } catch {
        // Try the next retained key.
      }
    }
    throw new ProjectError(500, 'The stored project package could not be decrypted.', 'bundle_damaged');
  }

  row(workspaceId, clientProjectId) {
    return this.db.prepare(`
      SELECT * FROM server_projects
      WHERE workspace_id = ? AND client_project_id = ?
    `).get(workspaceId, clientProjectId);
  }

  list(workspaceId) {
    this.ensureAvailable();
    return this.db.prepare(`
      SELECT * FROM server_projects
      WHERE workspace_id = ?
      ORDER BY updated_at DESC
    `).all(workspaceId).map(publicRow);
  }

  usage(workspaceId, excludingId = null) {
    return this.db.prepare(`
      SELECT
        (SELECT COALESCE(SUM(size_bytes), 0) FROM server_projects
          WHERE workspace_id = ? AND deleted_at IS NULL AND (? IS NULL OR id <> ?)) +
        (SELECT COALESCE(SUM(b.size_bytes), 0) FROM project_revision_backups b
          JOIN server_projects p ON p.id = b.project_id WHERE p.workspace_id = ?) +
        (SELECT COALESCE(SUM(size_bytes), 0) FROM project_assets
          WHERE workspace_id = ?) AS bytes
    `).get(workspaceId, excludingId, excludingId, workspaceId, workspaceId).bytes;
  }

  save(workspaceId, clientProjectId, buffer, ifMatch) {
    this.ensureAvailable();
    const clientId = this.validateClientId(clientProjectId);
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > this.maximumBytes) {
      throw new ProjectError(413, 'The complete project package is too large.', 'bundle_too_large');
    }
    const expected = expectedRevision(ifMatch);
    if (expected == null) {
      throw new ProjectError(428, 'A project revision is required.', 'revision_required');
    }
    let bundle;
    let storageFormat;
    let assetRefs;
    try {
      ({ bundle, storageFormat, assetRefs } = parseProjectPayload(buffer));
      if (storageFormat === MANIFEST_STORAGE_FORMAT) {
        if (!this.assets) {
          throw new ProjectError(503, 'Project asset storage is unavailable.', 'storage_unavailable');
        }
        assetRefs = this.assets.resolveReferences(workspaceId, bundle);
      }
    } catch (error) {
      if (error instanceof ShareError) {
        throw new ProjectError(error.status, error.message, error.code);
      }
      if (error instanceof ProjectAssetError) {
        throw new ProjectError(error.status, error.message, error.code);
      }
      throw error;
    }
    if (bundle.clientProjectId !== clientId || bundle.project?.id !== clientId) {
      throw new ProjectError(400, 'The project package identifier does not match its URL.', 'project_id_mismatch');
    }

    const current = this.row(workspaceId, clientId);
    const actual = current?.revision ?? 0;
    if (actual !== expected) {
      throw new ProjectError(
        409,
        'This project changed on another device.',
        'revision_conflict',
        { currentRevision: actual, project: current ? publicRow(current) : null },
      );
    }
    if (current?.deleted_at) {
      throw new ProjectError(
        409,
        'This project was permanently deleted. Save the offline edit as a new project.',
        'project_deleted',
        { currentRevision: actual, project: publicRow(current) },
      );
    }
    if (this.usage(workspaceId, current?.id ?? null) + buffer.length > this.maximumWorkspaceBytes) {
      throw new ProjectError(507, 'The server project storage allowance is full.', 'project_quota');
    }

    const now = this.clock().toISOString();
    const revision = actual + 1;
    const id = current?.id || crypto.randomUUID();
    const fileName = this.revisionFileName(id, revision);
    const encrypted = this.encrypt(buffer);
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    const project = bundle.project;
    const summary = project.editor?.projectSummary ?? {};
    const trashedAt = typeof bundle.trashedAt === 'string' ? bundle.trashedAt : null;
    const thumbnail = cleanThumbnail(summary.thumbnail);

    let published = false;
    let transactionOpen = false;
    let committed = false;
    try {
      this.publishRevision(fileName, encrypted);
      published = true;
      this.injectFault('after_file_published', { fileName, revision });
      this.db.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      const retainLegacyRevision = current &&
        (current.storage_format || LEGACY_STORAGE_FORMAT) === LEGACY_STORAGE_FORMAT &&
        storageFormat === MANIFEST_STORAGE_FORMAT;
      if (retainLegacyRevision) {
        const expiresAt = new Date(this.clock().getTime() + Math.max(0, this.migrationBackupMs)).toISOString();
        this.db.prepare(`
          INSERT INTO project_revision_backups (
            id, project_id, file_name, size_bytes, bundle_sha256, key_id,
            storage_format, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          crypto.randomUUID(), current.id, current.file_name, current.size_bytes,
          current.bundle_sha256, current.key_id, LEGACY_STORAGE_FORMAT, now, expiresAt,
        );
      }
      if (current) {
        const changed = this.db.prepare(`
          UPDATE server_projects SET
            revision = ?, name = ?, panel_width_mm = ?, panel_height_mm = ?,
            cut_style = ?, status = ?, has_source = ?, checkpoint_count = ?,
            artifact_count = ?, updated_at = ?, trashed_at = ?, deleted_at = NULL, size_bytes = ?,
            bundle_sha256 = ?, key_id = ?, file_name = ?, storage_format = ?, thumbnail_data_url = ?
          WHERE id = ? AND revision = ?
        `).run(
          revision,
          cleanText(project.name, 'Untitled panel'),
          Number(project.sheet?.widthMm) || null,
          Number(project.sheet?.heightMm) || null,
          cleanText(summary.cutStyle, null, 60),
          cleanText(summary.status, 'draft', 30),
          bundle.source ? 1 : 0,
          bundle.checkpoints.length,
          bundle.artifacts.length,
          now,
          trashedAt,
          buffer.length,
          digest,
          this.keyId,
          fileName,
          storageFormat,
          thumbnail,
          current.id,
          expected,
        );
        if (changed.changes !== 1) {
          throw new ProjectError(409, 'This project changed on another device.', 'revision_conflict');
        }
      } else {
        this.db.prepare(`
          INSERT INTO server_projects (
            id, workspace_id, client_project_id, revision, name,
            panel_width_mm, panel_height_mm, cut_style, status,
            has_source, checkpoint_count, artifact_count, created_at, updated_at,
            trashed_at, deleted_at, size_bytes, bundle_sha256, key_id, file_name,
            storage_format, thumbnail_data_url
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          workspaceId,
          clientId,
          revision,
          cleanText(project.name, 'Untitled panel'),
          Number(project.sheet?.widthMm) || null,
          Number(project.sheet?.heightMm) || null,
          cleanText(summary.cutStyle, null, 60),
          cleanText(summary.status, 'draft', 30),
          bundle.source ? 1 : 0,
          bundle.checkpoints.length,
          bundle.artifacts.length,
          project.createdAt || now,
          now,
          trashedAt,
          null,
          buffer.length,
          digest,
          this.keyId,
          fileName,
          storageFormat,
          thumbnail,
        );
      }
      this.db.prepare('DELETE FROM project_asset_refs WHERE project_id = ?').run(id);
      for (const reference of assetRefs) {
        this.db.prepare(`
          INSERT INTO project_asset_refs (project_id, asset_id, role, slot_key, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, reference.row.id, reference.role, reference.slotKey, now);
        this.db.prepare('UPDATE project_assets SET last_referenced_at = ? WHERE id = ?')
          .run(now, reference.row.id);
      }
      this.injectFault('before_database_commit', { fileName, revision });
      this.db.exec('COMMIT');
      transactionOpen = false;
      committed = true;
      this.injectFault('after_database_commit', { fileName, revision });
    } catch (error) {
      if (transactionOpen) {
        try { this.db.exec('ROLLBACK'); } catch {}
      }
      // COMMIT can be ambiguous if the process or storage layer fails while
      // returning. Trust the metadata pointer rather than deleting a bundle it
      // may already reference.
      if (!committed) {
        const persisted = this.row(workspaceId, clientId);
        committed = persisted?.revision === revision && persisted?.file_name === fileName;
      }
      if (!committed && published) {
        fs.rmSync(this.filePath(fileName), { force: true });
      }
      throw error;
    }
    const retainedAsMigrationBackup = current &&
      (current.storage_format || LEGACY_STORAGE_FORMAT) === LEGACY_STORAGE_FORMAT &&
      storageFormat === MANIFEST_STORAGE_FORMAT;
    if (current?.file_name && current.file_name !== fileName && !retainedAsMigrationBackup) {
      try {
        this.injectFault('before_old_revision_cleanup', {
          fileName,
          previousFileName: current.file_name,
          revision,
        });
        fs.rmSync(this.filePath(current.file_name), { force: true });
        this.syncDirectory();
      } catch (error) {
        this.warn('Kerfloom committed a project revision but could not remove its predecessor.', error);
      }
    }
    return publicRow(this.row(workspaceId, clientId));
  }

  migrateEncryption() {
    this.ensureAvailable();
    const result = { keyId: this.keyId, migrated: 0, unchanged: 0, skipped: 0, failed: 0 };
    const rows = this.db.prepare(`
      SELECT * FROM server_projects
      WHERE deleted_at IS NULL
      ORDER BY updated_at ASC
    `).all();

    for (const row of rows) {
      if (row.key_id === this.keyId) {
        result.unchanged += 1;
        continue;
      }
      let plain;
      try {
        plain = this.decrypt(fs.readFileSync(this.filePath(row.file_name)));
        const digest = crypto.createHash('sha256').update(plain).digest('hex');
        if (!sameHash(digest, row.bundle_sha256)) throw new Error('integrity check failed');
      } catch (error) {
        result.failed += 1;
        this.warn('Kerfloom could not read a project during encryption migration.', error);
        continue;
      }

      const fileName = this.revisionFileName(row.id, row.revision);
      let published = false;
      let transactionOpen = false;
      let committed = false;
      try {
        this.publishRevision(fileName, this.encrypt(plain));
        published = true;
        this.db.exec('BEGIN IMMEDIATE');
        transactionOpen = true;
        const changed = this.db.prepare(`
          UPDATE server_projects SET file_name = ?, key_id = ?
          WHERE id = ? AND revision = ? AND file_name = ? AND deleted_at IS NULL
        `).run(fileName, this.keyId, row.id, row.revision, row.file_name);
        if (changed.changes !== 1) {
          this.db.exec('ROLLBACK');
          transactionOpen = false;
          fs.rmSync(this.filePath(fileName), { force: true });
          result.skipped += 1;
          continue;
        }
        this.db.exec('COMMIT');
        transactionOpen = false;
        committed = true;
      } catch (error) {
        if (transactionOpen) {
          try { this.db.exec('ROLLBACK'); } catch {}
        }
        if (!committed) {
          const persisted = this.db.prepare('SELECT file_name, key_id FROM server_projects WHERE id = ?')
            .get(row.id);
          committed = persisted?.file_name === fileName && persisted?.key_id === this.keyId;
        }
        if (committed) {
          result.migrated += 1;
          this.warn('Kerfloom migrated a project but the commit acknowledgement was interrupted.', error);
          continue;
        }
        if (published) fs.rmSync(this.filePath(fileName), { force: true });
        result.failed += 1;
        this.warn('Kerfloom could not migrate a project encryption key.', error);
        continue;
      }

      result.migrated += 1;
      try {
        fs.rmSync(this.filePath(row.file_name), { force: true });
        this.syncDirectory();
      } catch (error) {
        this.warn('Kerfloom migrated a project but could not remove its old encrypted revision.', error);
      }
    }
    return result;
  }

  state(workspaceId, clientProjectId) {
    this.ensureAvailable();
    const row = this.row(workspaceId, this.validateClientId(clientProjectId));
    if (!row || row.deleted_at) throw new ProjectError(404, 'Project not found.', 'project_not_found');
    let encrypted;
    try {
      encrypted = fs.readFileSync(this.filePath(row.file_name));
    } catch {
      throw new ProjectError(410, 'The project package is no longer stored.', 'bundle_missing');
    }
    const buffer = this.decrypt(encrypted);
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    if (!sameHash(digest, row.bundle_sha256)) {
      throw new ProjectError(500, 'The project package failed its integrity check.', 'bundle_damaged');
    }
    return { row: publicRow(row), buffer };
  }

  bundle(workspaceId, clientProjectId) {
    const stored = this.state(workspaceId, clientProjectId);
    if (stored.row.storageFormat !== MANIFEST_STORAGE_FORMAT) return stored;
    let manifest;
    try {
      manifest = JSON.parse(stored.buffer.toString('utf8'));
    } catch {
      throw new ProjectError(500, 'The project state manifest is damaged.', 'bundle_damaged');
    }
    const encodeAsset = (reference) => {
      const result = this.assets.read(workspaceId, reference.assetId);
      return `data:${result.asset.mimeType};base64,${result.buffer.toString('base64')}`;
    };
    const bundle = {
      ...manifest,
      schema: 'stencil-cnc.share-bundle',
      version: 1,
      source: manifest.source ? {
        name: manifest.source.name,
        mimeType: manifest.source.mimeType,
        size: manifest.source.size,
        dataUrl: encodeAsset(manifest.source),
      } : null,
      artifacts: manifest.artifacts.map((artifact) => ({
        filename: artifact.filename,
        kind: artifact.kind,
        mimeType: artifact.mimeType,
        createdAt: artifact.createdAt,
        profileSnapshot: artifact.profileSnapshot ?? null,
        releaseManifest: artifact.releaseManifest ?? null,
        dataUrl: encodeAsset(artifact),
      })),
    };
    return { row: stored.row, buffer: Buffer.from(JSON.stringify(bundle)) };
  }

  delete(workspaceId, clientProjectId, ifMatch) {
    this.ensureAvailable();
    const clientId = this.validateClientId(clientProjectId);
    const row = this.row(workspaceId, clientId);
    if (!row) return { id: clientId, deleted: true };
    const expected = expectedRevision(ifMatch);
    if (expected == null) {
      throw new ProjectError(428, 'A project revision is required.', 'revision_required');
    }
    if (row.revision !== expected) {
      throw new ProjectError(409, 'This project changed on another device.', 'revision_conflict', {
        currentRevision: row.revision,
        project: publicRow(row),
      });
    }
    if (row.deleted_at) return {
      id: clientId,
      deleted: true,
      revision: row.revision,
      deletedAt: row.deleted_at,
    };
    const deletedAt = this.clock().toISOString();
    const revision = row.revision + 1;
    const backupFiles = this.db.prepare(`
      SELECT file_name FROM project_revision_backups WHERE project_id = ?
    `).all(row.id).map((backup) => backup.file_name);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(`
        UPDATE server_projects SET
          revision = ?, updated_at = ?, deleted_at = ?, size_bytes = 0,
          bundle_sha256 = '', has_source = 0, checkpoint_count = 0, artifact_count = 0,
          thumbnail_data_url = NULL
        WHERE workspace_id = ? AND client_project_id = ? AND revision = ?
      `).run(revision, deletedAt, deletedAt, workspaceId, clientId, expected);
      if (result.changes !== 1) {
        throw new ProjectError(409, 'This project changed on another device.', 'revision_conflict');
      }
      this.db.prepare('DELETE FROM project_asset_refs WHERE project_id = ?').run(row.id);
      this.db.prepare('DELETE FROM project_revision_backups WHERE project_id = ?').run(row.id);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    try {
      fs.rmSync(this.filePath(row.file_name), { force: true });
      for (const fileName of backupFiles) fs.rmSync(this.filePath(fileName), { force: true });
      this.syncDirectory();
    } catch (error) {
      this.warn('Kerfloom committed a project deletion but could not remove its bundle.', error);
    }
    return { id: clientId, deleted: true, revision, deletedAt };
  }
}

export { expectedRevision };
