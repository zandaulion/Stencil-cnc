import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseBundle, ShareError } from './shares.js';

const FILE_MAGIC = Buffer.from('STPJ1');
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

function cleanText(value, fallback, maximum = 120) {
  const cleaned = typeof value === 'string' ? value.trim().slice(0, maximum) : '';
  return cleaned || fallback;
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
    this.clock = options.clock || (() => new Date());
    this.maximumBytes = Number(
      options.maximumBytes ?? process.env.PROJECT_MAX_BYTES ?? 128 * 1024 * 1024,
    );
    this.maximumWorkspaceBytes = Number(
      options.maximumWorkspaceBytes ?? process.env.PROJECT_WORKSPACE_MAX_BYTES ?? 2 * 1024 * 1024 * 1024,
    );
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

  encrypt(buffer) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(this.secret), nonce);
    const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
    return Buffer.concat([FILE_MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(buffer) {
    if (buffer.length < FILE_MAGIC.length + 28 ||
        !buffer.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
      throw new ProjectError(500, 'The stored project package is damaged.', 'bundle_damaged');
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
      throw new ProjectError(500, 'The stored project package could not be decrypted.', 'bundle_damaged');
    }
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
      SELECT COALESCE(SUM(size_bytes), 0) AS bytes
      FROM server_projects
      WHERE workspace_id = ? AND (? IS NULL OR id <> ?)
    `).get(workspaceId, excludingId, excludingId).bytes;
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
    try {
      bundle = parseBundle(buffer);
    } catch (error) {
      if (error instanceof ShareError) {
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
    const fileName = current?.file_name || `${id}.project`;
    const target = this.filePath(fileName);
    const temporary = this.filePath(`${fileName}.${crypto.randomUUID()}.tmp`);
    const backup = this.filePath(`${fileName}.${crypto.randomUUID()}.bak`);
    const encrypted = this.encrypt(buffer);
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    const project = bundle.project;
    const summary = project.editor?.projectSummary ?? {};
    const trashedAt = typeof bundle.trashedAt === 'string' ? bundle.trashedAt : null;

    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, encrypted, { mode: 0o600, flag: 'wx' });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (current && fs.existsSync(target)) fs.renameSync(target, backup);
      fs.renameSync(temporary, target);
      if (current) {
        const changed = this.db.prepare(`
          UPDATE server_projects SET
            revision = ?, name = ?, panel_width_mm = ?, panel_height_mm = ?,
            cut_style = ?, status = ?, has_source = ?, checkpoint_count = ?,
            artifact_count = ?, updated_at = ?, trashed_at = ?, deleted_at = NULL, size_bytes = ?,
            bundle_sha256 = ?
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
            trashed_at, deleted_at, size_bytes, bundle_sha256, file_name
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          fileName,
        );
      }
      this.db.exec('COMMIT');
      fs.rmSync(backup, { force: true });
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      fs.rmSync(target, { force: true });
      if (fs.existsSync(backup)) fs.renameSync(backup, target);
      fs.rmSync(temporary, { force: true });
      throw error;
    }
    return publicRow(this.row(workspaceId, clientId));
  }

  bundle(workspaceId, clientProjectId) {
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
    const result = this.db.prepare(`
      UPDATE server_projects SET
        revision = ?, updated_at = ?, deleted_at = ?, size_bytes = 0,
        bundle_sha256 = '', has_source = 0, checkpoint_count = 0, artifact_count = 0
      WHERE workspace_id = ? AND client_project_id = ? AND revision = ?
    `).run(revision, deletedAt, deletedAt, workspaceId, clientId, expected);
    if (result.changes !== 1) {
      throw new ProjectError(409, 'This project changed on another device.', 'revision_conflict');
    }
    fs.rmSync(this.filePath(row.file_name), { force: true });
    return { id: clientId, deleted: true, revision, deletedAt };
  }
}

export { expectedRevision };
