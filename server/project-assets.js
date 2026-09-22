import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FILE_MAGIC = Buffer.from('KAST1');
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASSET_FILE = /^[0-9a-f-]{36}\.asset$/i;
const DEFAULT_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

function encryptionKey(secret) {
  return crypto.createHash('sha256')
    .update('kerfloom/server-project-asset/v1\0')
    .update(String(secret))
    .digest();
}

function sameHash(left, right) {
  const a = Buffer.from(String(left), 'hex');
  const b = Buffer.from(String(right), 'hex');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function publicAsset(row) {
  return {
    id: row.id,
    sha256: row.sha256,
    kind: row.kind,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  };
}

export class ProjectAssetError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'ProjectAssetError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Immutable, encrypted project assets. IDs are random capabilities only in
 * shape: every lookup is additionally scoped to the authenticated workspace.
 * The plaintext digest is used for deduplication inside one workspace, but is
 * never accepted as an authorization token or exposed in an asset URL.
 */
export class ProjectAssetService {
  constructor(db, options = {}) {
    this.db = db;
    this.directory = options.directory || path.join(
      process.env.DATA_DIR || path.join(process.cwd(), 'data'),
      'project-assets',
    );
    this.secret = String(options.encryptionSecret ?? process.env.PROJECT_ENCRYPTION_KEY ?? '').trim();
    this.keyId = String(options.encryptionKeyId || 'primary').trim();
    if (!KEY_ID.test(this.keyId)) {
      throw new ProjectAssetError(500, 'The asset encryption key identifier is invalid.', 'bad_key_id');
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
      options.maximumBytes ?? process.env.PROJECT_ASSET_MAX_BYTES ?? 128 * 1024 * 1024,
    );
    this.maximumWorkspaceBytes = Number(
      options.maximumWorkspaceBytes ?? process.env.PROJECT_WORKSPACE_MAX_BYTES ?? 2 * 1024 * 1024 * 1024,
    );
    this.orphanGraceMs = Number(options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS);
    this.onStorageWarning = options.onStorageWarning || ((message, error) => console.error(message, error));
    this.recoverySummary = options.recoverOnStart === false ? null : this.recoverStorage();
  }

  ensureAvailable() {
    if (this.secret.length < 32) {
      throw new ProjectAssetError(503, 'Server project storage is not configured.', 'storage_unavailable');
    }
  }

  filePath(fileName) {
    return path.join(this.directory, path.basename(fileName));
  }

  syncDirectory() {
    let descriptor;
    try {
      descriptor = fs.openSync(this.directory, 'r');
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error?.code)) throw error;
    } finally {
      if (descriptor != null) fs.closeSync(descriptor);
    }
  }

  encrypt(buffer) {
    const keyId = Buffer.from(this.keyId, 'utf8');
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(this.secret), nonce);
    const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
    return Buffer.concat([
      FILE_MAGIC,
      Buffer.from([keyId.length]),
      keyId,
      nonce,
      cipher.getAuthTag(),
      ciphertext,
    ]);
  }

  decrypt(buffer) {
    if (buffer.length < FILE_MAGIC.length + 30 ||
        !buffer.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
      throw new ProjectAssetError(500, 'The stored project asset is damaged.', 'asset_damaged');
    }
    const keyIdLength = buffer[FILE_MAGIC.length];
    const nonceStart = FILE_MAGIC.length + 1 + keyIdLength;
    if (keyIdLength < 1 || nonceStart + 28 > buffer.length) {
      throw new ProjectAssetError(500, 'The stored project asset is damaged.', 'asset_damaged');
    }
    const keyId = buffer.subarray(FILE_MAGIC.length + 1, nonceStart).toString('utf8');
    const secret = this.decryptionKeys.get(keyId);
    if (!secret) {
      throw new ProjectAssetError(
        500,
        'The encryption key for this project asset is unavailable.',
        'encryption_key_unavailable',
      );
    }
    const tagStart = nonceStart + 12;
    const bodyStart = tagStart + 16;
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        encryptionKey(secret),
        buffer.subarray(nonceStart, tagStart),
      );
      decipher.setAuthTag(buffer.subarray(tagStart, bodyStart));
      return Buffer.concat([decipher.update(buffer.subarray(bodyStart)), decipher.final()]);
    } catch {
      throw new ProjectAssetError(500, 'The stored project asset could not be decrypted.', 'asset_damaged');
    }
  }

  usage(workspaceId) {
    const row = this.db.prepare(`
      SELECT
        (SELECT COALESCE(SUM(size_bytes), 0) FROM server_projects
          WHERE workspace_id = ? AND deleted_at IS NULL) +
        (SELECT COALESCE(SUM(size_bytes), 0) FROM project_assets
          WHERE workspace_id = ?) AS bytes
    `).get(workspaceId, workspaceId);
    return Number(row?.bytes) || 0;
  }

  publish(fileName, encrypted) {
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
    } catch (error) {
      if (descriptor != null) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }

  upload(workspaceId, buffer, { sha256, kind, mimeType } = {}) {
    this.ensureAvailable();
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > this.maximumBytes) {
      throw new ProjectAssetError(413, 'The project asset is too large.', 'asset_too_large');
    }
    const claimedDigest = String(sha256 || '').trim().toLowerCase();
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    if (!SHA256.test(claimedDigest) || !sameHash(claimedDigest, digest)) {
      throw new ProjectAssetError(400, 'The project asset digest does not match its contents.', 'asset_digest_mismatch');
    }
    const assetKind = String(kind || '').trim();
    if (!['source', 'artifact'].includes(assetKind)) {
      throw new ProjectAssetError(400, 'The project asset kind is invalid.', 'bad_asset_kind');
    }
    const type = String(mimeType || 'application/octet-stream').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type) || type.length > 120) {
      throw new ProjectAssetError(400, 'The project asset media type is invalid.', 'bad_asset_type');
    }

    const existing = this.db.prepare(`
      SELECT * FROM project_assets WHERE workspace_id = ? AND sha256 = ?
    `).get(workspaceId, digest);
    if (existing) return { asset: publicAsset(existing), created: false };
    if (this.usage(workspaceId) + buffer.length > this.maximumWorkspaceBytes) {
      throw new ProjectAssetError(507, 'The server project storage allowance is full.', 'project_quota');
    }

    const id = crypto.randomUUID();
    const fileName = `${id}.asset`;
    const now = this.clock().toISOString();
    this.publish(fileName, this.encrypt(buffer));
    try {
      this.db.prepare(`
        INSERT INTO project_assets (
          id, workspace_id, sha256, kind, mime_type, size_bytes,
          key_id, file_name, created_at, last_referenced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, workspaceId, digest, assetKind, type, buffer.length, this.keyId, fileName, now, now);
    } catch (error) {
      fs.rmSync(this.filePath(fileName), { force: true });
      throw error;
    }
    return {
      asset: publicAsset(this.db.prepare('SELECT * FROM project_assets WHERE id = ?').get(id)),
      created: true,
    };
  }

  row(workspaceId, assetId) {
    const id = String(assetId || '');
    if (!ASSET_ID.test(id)) return null;
    return this.db.prepare(`
      SELECT * FROM project_assets WHERE workspace_id = ? AND id = ?
    `).get(workspaceId, id) || null;
  }

  read(workspaceId, assetId) {
    this.ensureAvailable();
    const row = this.row(workspaceId, assetId);
    // A foreign-workspace ID and an unknown ID deliberately look identical.
    if (!row) throw new ProjectAssetError(404, 'Project asset not found.', 'asset_not_found');
    let encrypted;
    try {
      encrypted = fs.readFileSync(this.filePath(row.file_name));
    } catch {
      throw new ProjectAssetError(410, 'The project asset is no longer stored.', 'asset_missing');
    }
    const buffer = this.decrypt(encrypted);
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    if (buffer.length !== row.size_bytes || !sameHash(digest, row.sha256)) {
      throw new ProjectAssetError(500, 'The project asset failed its integrity check.', 'asset_damaged');
    }
    return { asset: publicAsset(row), buffer };
  }

  resolveReferences(workspaceId, manifest) {
    const entries = [];
    if (manifest.source) entries.push({ role: 'source', slotKey: 'source', value: manifest.source });
    for (const [index, artifact] of (manifest.artifacts || []).entries()) {
      entries.push({ role: 'artifact', slotKey: String(index), value: artifact });
    }
    return entries.map((entry) => {
      const row = this.row(workspaceId, entry.value?.assetId);
      if (!row) {
        throw new ProjectAssetError(400, 'The project manifest references an unavailable asset.', 'bad_asset_reference');
      }
      if (entry.role === 'source' && row.kind !== 'source' ||
          entry.role === 'artifact' && row.kind !== 'artifact') {
        throw new ProjectAssetError(400, 'The project manifest asset role is invalid.', 'bad_asset_reference');
      }
      if (entry.value.sha256 && !sameHash(entry.value.sha256, row.sha256) ||
          Number.isFinite(Number(entry.value.size)) && Number(entry.value.size) !== row.size_bytes) {
        throw new ProjectAssetError(400, 'The project manifest asset metadata does not match.', 'bad_asset_reference');
      }
      return { ...entry, row };
    });
  }

  recoverStorage() {
    const summary = { removedOrphans: 0, warnings: 0 };
    if (this.secret.length < 32 || !fs.existsSync(this.directory)) return summary;
    const referenced = new Set(this.db.prepare('SELECT file_name FROM project_assets').all()
      .map((row) => path.basename(row.file_name)));
    const cutoff = Date.now() - Math.max(0, this.orphanGraceMs);
    for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
      const isOwned = ASSET_FILE.test(entry.name) || entry.name.endsWith('.asset.tmp') || entry.name.includes('.asset.');
      if (!entry.isFile() || referenced.has(entry.name) || !isOwned) continue;
      try {
        const candidate = this.filePath(entry.name);
        if (fs.statSync(candidate).mtimeMs > cutoff) continue;
        fs.rmSync(candidate);
        summary.removedOrphans += 1;
      } catch (error) {
        summary.warnings += 1;
        try { this.onStorageWarning('Kerfloom could not remove an orphaned project asset file.', error); } catch {}
      }
    }
    return summary;
  }

  cleanupUnreferenced({ graceMs = this.orphanGraceMs } = {}) {
    const cutoff = new Date(this.clock().getTime() - Math.max(0, graceMs)).toISOString();
    const rows = this.db.prepare(`
      SELECT a.* FROM project_assets a
      LEFT JOIN project_asset_refs r ON r.asset_id = a.id
      WHERE r.asset_id IS NULL AND a.last_referenced_at < ?
    `).all(cutoff);
    let removed = 0;
    for (const row of rows) {
      const result = this.db.prepare(`
        DELETE FROM project_assets
        WHERE id = ? AND NOT EXISTS (
          SELECT 1 FROM project_asset_refs WHERE asset_id = ?
        )
      `).run(row.id, row.id);
      if (result.changes !== 1) continue;
      try { fs.rmSync(this.filePath(row.file_name), { force: true }); } catch (error) {
        try { this.onStorageWarning('Kerfloom could not remove an unreferenced project asset.', error); } catch {}
      }
      removed += 1;
    }
    if (removed) this.syncDirectory();
    return { removed };
  }
}
