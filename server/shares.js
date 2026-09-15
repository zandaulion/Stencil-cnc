import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BUNDLE_SCHEMA = 'stencil-cnc.share-bundle';
const BUNDLE_VERSION = 1;
const FILE_MAGIC = Buffer.from('STSH1');
const TOKEN_BYTES = 32;

function cleanText(value, fallback, maximum = 120) {
  const cleaned = typeof value === 'string' ? value.trim().slice(0, maximum) : '';
  return cleaned || fallback;
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sameHash(left, right) {
  const a = Buffer.from(String(left), 'hex');
  const b = Buffer.from(String(right), 'hex');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function encryptionKey(secret) {
  return crypto.createHash('sha256')
    .update('stencil-cnc/project-share/v1\0')
    .update(String(secret))
    .digest();
}

function parseBundle(buffer) {
  let bundle;
  try {
    bundle = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new ShareError(400, 'The shared project package is not valid JSON.', 'bad_bundle');
  }
  if (!bundle || bundle.schema !== BUNDLE_SCHEMA || bundle.version !== BUNDLE_VERSION) {
    throw new ShareError(400, 'Unsupported shared project package.', 'bad_bundle');
  }
  if (!bundle.project || bundle.project.schema !== 'stencil-cnc.project') {
    throw new ShareError(400, 'The package does not contain an editable Stencil project.', 'bad_bundle');
  }
  if (bundle.source != null && (
    typeof bundle.source !== 'object' ||
    typeof bundle.source.dataUrl !== 'string' ||
    !bundle.source.dataUrl.startsWith('data:image/')
  )) {
    throw new ShareError(400, 'The source-image artefact is invalid.', 'bad_bundle');
  }
  if (!Array.isArray(bundle.checkpoints) || !Array.isArray(bundle.artifacts)) {
    throw new ShareError(400, 'The package artefact manifest is incomplete.', 'bad_bundle');
  }
  if (bundle.checkpoints.length > 10 || bundle.artifacts.length > 30 ||
      bundle.artifacts.some((artifact) => (
        !artifact || typeof artifact.dataUrl !== 'string' ||
        !/^data:(?:image\/png|image\/svg\+xml|application\/dxf);base64,/.test(artifact.dataUrl)
      ))) {
    throw new ShareError(400, 'The package contains unsupported export artefacts.', 'bad_bundle');
  }
  return bundle;
}

function rowStatus(row, now = new Date()) {
  if (row.revoked_at) return 'revoked';
  if (Date.parse(row.expires_at) <= now.getTime()) return 'expired';
  return 'active';
}

function publicRow(row, deviceId) {
  return {
    id: row.id,
    clientProjectId: row.client_project_id,
    name: row.name,
    sheet: row.panel_width_mm && row.panel_height_mm
      ? { widthMm: row.panel_width_mm, heightMm: row.panel_height_mm }
      : null,
    cutStyle: row.cut_style,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    sizeBytes: row.size_bytes,
    status: rowStatus(row),
    direction: row.owner_device_id === deviceId ? 'sent' : 'received',
    claimed: Boolean(row.recipient_device_id),
    ownerLabel: row.owner_label || null,
    hasSource: Boolean(row.has_source),
    checkpointCount: row.checkpoint_count,
    artifactCount: row.artifact_count,
  };
}

export class ShareError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'ShareError';
    this.status = status;
    this.code = code;
  }
}

export class ShareService {
  constructor(db, options = {}) {
    this.db = db;
    this.directory = options.directory || path.join(
      process.env.DATA_DIR || path.join(process.cwd(), 'data'),
      'shares',
    );
    this.secret = String(options.encryptionSecret ?? process.env.SHARE_ENCRYPTION_KEY ?? '').trim();
    this.clock = options.clock || (() => new Date());
    this.maximumBytes = Number(options.maximumBytes ?? process.env.SHARE_MAX_BYTES ?? 64 * 1024 * 1024);
    this.maximumOwnerBytes = Number(
      options.maximumOwnerBytes ?? process.env.SHARE_OWNER_MAX_BYTES ?? 512 * 1024 * 1024,
    );
    this.maximumActiveShares = Number(
      options.maximumActiveShares ?? process.env.SHARE_OWNER_MAX_ACTIVE ?? 50,
    );
  }

  ensureAvailable() {
    if (this.secret.length < 32) {
      throw new ShareError(503, 'Server project sharing is not configured.', 'sharing_unavailable');
    }
  }

  filePath(fileName) {
    return path.join(this.directory, path.basename(fileName));
  }

  encrypt(buffer) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(this.secret), nonce);
    const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
    return Buffer.concat([FILE_MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(buffer) {
    if (buffer.length < FILE_MAGIC.length + 28 ||
        !buffer.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
      throw new ShareError(500, 'The stored project package is damaged.', 'bundle_damaged');
    }
    const nonceStart = FILE_MAGIC.length;
    const tagStart = nonceStart + 12;
    const bodyStart = tagStart + 16;
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        encryptionKey(this.secret),
        buffer.subarray(nonceStart, tagStart),
      );
      decipher.setAuthTag(buffer.subarray(tagStart, bodyStart));
      return Buffer.concat([decipher.update(buffer.subarray(bodyStart)), decipher.final()]);
    } catch {
      throw new ShareError(500, 'The stored project package could not be decrypted.', 'bundle_damaged');
    }
  }

  create(ownerDeviceId, buffer, { expiresDays = 30 } = {}) {
    this.ensureAvailable();
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > this.maximumBytes) {
      throw new ShareError(413, 'The complete project package is too large to share.', 'bundle_too_large');
    }
    const bundle = parseBundle(buffer);
    this.purgeExpiredFiles();
    const usage = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
      FROM project_shares
      WHERE owner_device_id = ? AND revoked_at IS NULL AND expires_at > ?
    `).get(ownerDeviceId, this.clock().toISOString());
    if (usage.count >= this.maximumActiveShares || usage.bytes + buffer.length > this.maximumOwnerBytes) {
      throw new ShareError(
        409,
        'The server sharing allowance is full. Revoke an older project link and try again.',
        'share_quota',
      );
    }
    const days = Math.max(1, Math.min(90, Number.parseInt(expiresDays, 10) || 30));
    const createdAt = this.clock().toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + days * 86_400_000).toISOString();
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    const fileName = `${id}.share`;
    const encrypted = this.encrypt(buffer);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const target = this.filePath(fileName);
    const temporary = this.filePath(`${fileName}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temporary, encrypted, { mode: 0o600, flag: 'wx' });
    try {
      fs.renameSync(temporary, target);
      const project = bundle.project;
      const summary = project.editor?.projectSummary ?? {};
      this.db.prepare(`
        INSERT INTO project_shares (
          id, owner_device_id, client_project_id, token_hash, name,
          panel_width_mm, panel_height_mm, cut_style,
          has_source, checkpoint_count, artifact_count,
          created_at, expires_at, size_bytes, bundle_sha256, file_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        ownerDeviceId,
        cleanText(bundle.clientProjectId ?? project.id, null, 100),
        hashSecret(token),
        cleanText(project.name, 'Shared stencil project'),
        Number(project.sheet?.widthMm) || null,
        Number(project.sheet?.heightMm) || null,
        cleanText(summary.cutStyle, null, 60),
        bundle.source ? 1 : 0,
        bundle.checkpoints.length,
        bundle.artifacts.length,
        createdAt,
        expiresAt,
        buffer.length,
        crypto.createHash('sha256').update(buffer).digest('hex'),
        fileName,
      );
    } catch (error) {
      fs.rmSync(target, { force: true });
      throw error;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    const row = this.row(id);
    return { ...publicRow(row, ownerDeviceId), token };
  }

  row(id) {
    return this.db.prepare(`
      SELECT project_shares.*, devices.label AS owner_label
      FROM project_shares
      JOIN devices ON devices.id = project_shares.owner_device_id
      WHERE project_shares.id = ?
    `).get(id);
  }

  authorize(id, token, deviceId, { claim = false } = {}) {
    this.ensureAvailable();
    let row = this.row(id);
    if (!row || !sameHash(row.token_hash, hashSecret(token)) || rowStatus(row, this.clock()) !== 'active') {
      throw new ShareError(404, 'This project share is unavailable or has expired.', 'share_unavailable');
    }
    if (row.owner_device_id === deviceId) return row;
    if (!row.recipient_device_id && claim) {
      this.db.prepare(`
        UPDATE project_shares SET recipient_device_id = ?
        WHERE id = ? AND recipient_device_id IS NULL
      `).run(deviceId, id);
      row = this.row(id);
    }
    if (row.recipient_device_id !== deviceId) {
      throw new ShareError(403, 'This share has already been claimed by another device.', 'share_claimed');
    }
    return row;
  }

  claim(id, token, deviceId) {
    const row = this.authorize(id, token, deviceId, { claim: true });
    const { buffer } = this.readBundle(row);
    const bundle = parseBundle(buffer);
    const thumbnail = bundle.project?.editor?.projectSummary?.thumbnail;
    return {
      ...publicRow(row, deviceId),
      thumbnail: typeof thumbnail === 'string' && thumbnail.length <= 500_000 &&
        thumbnail.startsWith('data:image/png;base64,')
        ? thumbnail
        : null,
    };
  }

  readBundle(row) {
    let encrypted;
    try {
      encrypted = fs.readFileSync(this.filePath(row.file_name));
    } catch {
      throw new ShareError(410, 'The shared project package is no longer stored.', 'bundle_missing');
    }
    const buffer = this.decrypt(encrypted);
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    if (!sameHash(digest, row.bundle_sha256)) {
      throw new ShareError(500, 'The shared project package failed its integrity check.', 'bundle_damaged');
    }
    return { row, buffer };
  }

  bundle(id, token, deviceId) {
    return this.readBundle(this.authorize(id, token, deviceId));
  }

  list(deviceId) {
    this.purgeExpiredFiles();
    const rows = this.db.prepare(`
      SELECT project_shares.*, devices.label AS owner_label
      FROM project_shares
      JOIN devices ON devices.id = project_shares.owner_device_id
      WHERE owner_device_id = ? OR recipient_device_id = ?
      ORDER BY created_at DESC
    `).all(deviceId, deviceId);
    return rows.map((row) => publicRow(row, deviceId));
  }

  revoke(id, ownerDeviceId) {
    const row = this.row(id);
    if (!row || row.owner_device_id !== ownerDeviceId) {
      throw new ShareError(404, 'Project share not found.', 'share_not_found');
    }
    if (!row.revoked_at) {
      this.db.prepare('UPDATE project_shares SET revoked_at = ? WHERE id = ?')
        .run(this.clock().toISOString(), id);
      fs.rmSync(this.filePath(row.file_name), { force: true });
    }
    return { id, status: 'revoked' };
  }

  purgeExpiredFiles() {
    const now = this.clock().toISOString();
    const rows = this.db.prepare(`
      SELECT file_name FROM project_shares
      WHERE revoked_at IS NULL AND expires_at <= ?
    `).all(now);
    for (const row of rows) fs.rmSync(this.filePath(row.file_name), { force: true });
    return rows.length;
  }
}

export { BUNDLE_SCHEMA, BUNDLE_VERSION };
