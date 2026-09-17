import crypto from 'node:crypto';

export const COOKIE_NAME = '__Host-stencil-cnc-device';
export const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
export const DEFAULT_INVITE_TTL_DAYS = 7;
export const DEFAULT_REBIND_MINUTES = 60;

// No I/1 or O/0: codes are often copied from one screen or read aloud.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_GROUPS = 3;
const CODE_GROUP_LENGTH = 4;
const CODE_LENGTH = CODE_GROUPS * CODE_GROUP_LENGTH;

export class AuthError extends Error {
  constructor(status, message, code = 'auth_error') {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

export const hashSecret = (value) =>
  crypto.createHash('sha256').update(String(value)).digest('hex');

export function normaliseCode(raw) {
  const compact = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (compact.length !== CODE_LENGTH) return '';
  if ([...compact].some((character) => !CODE_ALPHABET.includes(character))) return '';

  const groups = [];
  for (let offset = 0; offset < compact.length; offset += CODE_GROUP_LENGTH) {
    groups.push(compact.slice(offset, offset + CODE_GROUP_LENGTH));
  }
  return groups.join('-');
}

export function randomCode() {
  let compact = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    compact += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return normaliseCode(compact);
}

const cleanLabel = (value) => {
  if (typeof value !== 'string') return null;
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60) || null;
};

const positiveInteger = (value, fallback, { min = 1, max = 10000 } = {}) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

function publicBase(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function rollback(db) {
  try {
    db.exec('ROLLBACK');
  } catch {
    // A failure before BEGIN, or a SQLite error that already rolled back.
  }
}

/**
 * The standard pwa-invite-console contract plus cookie-backed device access.
 * Keeping the database injectable makes the security behaviour testable with
 * a real in-memory SQLite database rather than mocks.
 */
export class AuthService {
  constructor(db, options = {}) {
    this.db = db;
    this.inviteTtlDays = positiveInteger(
      options.inviteTtlDays ?? process.env.INVITE_TTL_DAYS,
      DEFAULT_INVITE_TTL_DAYS,
      { max: 90 }
    );
    this.rebindMinutes = positiveInteger(
      options.rebindMinutes ?? process.env.INVITE_REBIND_MINUTES,
      DEFAULT_REBIND_MINUTES,
      { min: 0, max: 1440 }
    );
    this.publicBaseUrl = publicBase(options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL);
    this.adminToken = String(options.adminToken ?? process.env.ADMIN_TOKEN ?? '').trim();
    this.clock = options.clock || (() => new Date());
  }

  createInvite(label = null, workspaceId = null, requestedBaseUrl = null) {
    const cleanedLabel = cleanLabel(label);
    const linkedWorkspace = typeof workspaceId === 'string' && workspaceId
      ? this.db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId)?.id ?? null
      : null;
    if (workspaceId && !linkedWorkspace) {
      throw new AuthError(404, 'Workspace not found.', 'workspace_not_found');
    }
    const createdAt = this.clock().toISOString();
    const inviteBaseUrl = publicBase(requestedBaseUrl) || this.publicBaseUrl;
    const expiresAt = new Date(
      Date.parse(createdAt) + this.inviteTtlDays * 24 * 60 * 60 * 1000
    ).toISOString();

    // A collision is fantastically unlikely, but retrying makes it an ordinary
    // event rather than an opaque UNIQUE-constraint failure.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const code = randomCode();
      // Keep the credential in the fragment so it is not sent in HTTP request
      // targets, proxy logs, or referrer headers. The gate still accepts the
      // legacy query-string form for already-issued invitations.
      const url = inviteBaseUrl
        ? `${inviteBaseUrl}/#invite=${encodeURIComponent(code)}`
        : null;
      try {
        const result = this.db.prepare(`
          INSERT INTO invites
            (code_hash, code, label, url, created_at, expires_at, workspace_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(hashSecret(code), code, cleanedLabel, url, createdAt, expiresAt, linkedWorkspace);

        return {
          id: Number(result.lastInsertRowid),
          code,
          url,
          label: cleanedLabel,
          workspace_id: linkedWorkspace,
          expires_at: expiresAt,
          expires_in_days: this.inviteTtlDays
        };
      } catch (error) {
        if (!String(error?.message || '').includes('UNIQUE') || attempt === 3) throw error;
      }
    }
    throw new Error('Could not create an invite');
  }

  listInvites() {
    const now = this.clock().toISOString();
    // An expired plaintext credential serves no purpose. Drop it even before
    // an administrator chooses to prune the audit row itself.
    this.db.prepare(`
      UPDATE invites SET code = NULL, url = NULL
      WHERE expires_at <= ? AND code IS NOT NULL
    `).run(now);

    const rows = this.db.prepare(`
      SELECT id, label, code, url, created_at, expires_at,
             used_at, revoked, device_id, workspace_id
      FROM invites ORDER BY id DESC
    `).all();

    return {
      ttl_days: this.inviteTtlDays,
      invites: rows.map((row) => ({
        id: row.id,
        label: row.label,
        code: row.code,
        url: row.url,
        created_at: row.created_at,
        expires_at: row.expires_at,
        used_at: row.used_at,
        revoked: Boolean(row.revoked),
        device_id: row.device_id,
        workspace_id: row.workspace_id
      }))
    };
  }

  revokeInvite(id) {
    const result = this.db.prepare(`
      UPDATE invites SET revoked = 1, code = NULL, url = NULL
      WHERE id = ? AND used_at IS NULL AND revoked = 0
    `).run(id);
    return result.changes === 1;
  }

  pruneInvites() {
    return this.db.prepare(`
      DELETE FROM invites
      WHERE used_at IS NOT NULL OR revoked = 1 OR expires_at <= ?
    `).run(this.clock().toISOString()).changes;
  }

  /**
   * Redeem once to create a device. For a short absolute grace period the
   * same code can rotate that same device's token; this covers opening a link
   * in a chat browser before opening the installed PWA. It never creates a
   * second device and never restores a device the administrator revoked.
   */
  redeemInvite(rawCode, suppliedLabel = null) {
    const code = normaliseCode(rawCode);
    if (!code) {
      throw new AuthError(400, 'That does not look like an invite code.', 'bad_code');
    }

    const now = this.clock();
    const nowString = now.toISOString();
    const label = cleanLabel(suppliedLabel);
    let result;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const invite = this.db.prepare(
        'SELECT * FROM invites WHERE code_hash = ?'
      ).get(hashSecret(code));

      if (!invite || invite.revoked) {
        throw new AuthError(400, 'That invite is not valid. Ask for a new one.', 'bad_code');
      }
      if (Date.parse(invite.expires_at) <= now.getTime()) {
        throw new AuthError(410, 'That invite has expired. Ask for a new one.', 'expired');
      }

      const token = crypto.randomBytes(32).toString('base64url');
      const tokenHash = hashSecret(token);
      let deviceId;
      let workspaceId;
      let deviceLabel;
      let createdAt;

      if (invite.used_at) {
        const graceMs = this.rebindMinutes * 60 * 1000;
        const withinGrace = graceMs > 0
          && now.getTime() - Date.parse(invite.used_at) <= graceMs;
        const device = invite.device_id
          ? this.db.prepare('SELECT * FROM devices WHERE id = ?').get(invite.device_id)
          : null;

        if (!withinGrace || !device || device.revoked) {
          throw new AuthError(400, 'That invite has already been used.', 'used');
        }

        deviceId = device.id;
        workspaceId = device.workspace_id;
        deviceLabel = label || device.label || invite.label || 'Linked device';
        createdAt = device.created_at;
        this.db.prepare(`
          UPDATE devices SET token_hash = ?, label = ?, last_seen = ?
          WHERE id = ? AND revoked = 0
        `).run(tokenHash, deviceLabel, nowString, deviceId);
      } else {
        deviceId = crypto.randomUUID();
        workspaceId = invite.workspace_id || crypto.randomUUID();
        deviceLabel = label || invite.label || 'Linked device';
        createdAt = nowString;
        if (!invite.workspace_id) {
          this.db.prepare('INSERT INTO workspaces (id, label, created_at) VALUES (?, ?, ?)')
            .run(workspaceId, `${deviceLabel} workspace`, createdAt);
        }
        this.db.prepare(`
          INSERT INTO devices
            (id, token_hash, workspace_id, label, created_at, last_seen)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(deviceId, tokenHash, workspaceId, deviceLabel, createdAt, nowString);

        // The guarded claim is the single-use authority. BEGIN IMMEDIATE also
        // serialises separate processes should the service ever be scaled.
        const claimed = this.db.prepare(`
          UPDATE invites
          SET used_at = ?, device_id = ?, code = NULL, url = NULL
          WHERE id = ? AND used_at IS NULL AND revoked = 0 AND expires_at > ?
        `).run(nowString, deviceId, invite.id, nowString);
        if (claimed.changes !== 1) {
          throw new AuthError(400, 'That invite has already been used.', 'used');
        }
      }

      // Rebinding keeps used_at unchanged, so the grace window cannot slide.
      this.db.prepare(
        'UPDATE invites SET code = NULL, url = NULL WHERE id = ?'
      ).run(invite.id);

      this.db.exec('COMMIT');
      result = {
        token,
        device: {
          id: deviceId,
          workspaceId,
          label: deviceLabel,
          created_at: createdAt,
          last_seen: nowString
        }
      };
    } catch (error) {
      rollback(this.db);
      throw error;
    }

    return result;
  }

  deviceForToken(token, { touch = true } = {}) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 256) return null;
    const row = this.db.prepare(`
      SELECT id, workspace_id, label, created_at, last_seen, revoked
      FROM devices WHERE token_hash = ?
    `).get(hashSecret(token));
    if (!row || row.revoked) return null;

    let lastSeen = row.last_seen;
    if (touch) {
      const now = this.clock().toISOString();
      // Static-module requests arrive in bursts. At most one write per five
      // minutes is enough for a useful console timestamp.
      if (Date.parse(now) - Date.parse(row.last_seen) >= 5 * 60 * 1000) {
        this.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(now, row.id);
        lastSeen = now;
      }
    }

    return {
      id: row.id,
      workspaceId: row.workspace_id,
      label: row.label || 'Linked device',
      created_at: row.created_at,
      last_seen: lastSeen
    };
  }

  listDevices() {
    return {
      devices: this.db.prepare(`
        SELECT id, workspace_id, label, created_at, last_seen, revoked, has_push
        FROM devices ORDER BY created_at DESC
      `).all().map((row) => ({
        id: row.id,
        workspace_id: row.workspace_id,
        label: row.label || 'Unnamed device',
        created_at: row.created_at,
        last_seen: row.last_seen,
        revoked: Boolean(row.revoked),
        has_push: Boolean(row.has_push)
      }))
    };
  }

  listWorkspaceAccess(workspaceId) {
    const now = this.clock().toISOString();
    this.db.prepare(`
      UPDATE invites SET code = NULL, url = NULL
      WHERE workspace_id = ? AND expires_at <= ? AND code IS NOT NULL
    `).run(workspaceId, now);

    return {
      devices: this.db.prepare(`
        SELECT id, label, created_at, last_seen, revoked, has_push
        FROM devices
        WHERE workspace_id = ?
        ORDER BY revoked ASC, last_seen DESC, created_at DESC
      `).all(workspaceId).map((row) => ({
        id: row.id,
        label: row.label || 'Unnamed device',
        created_at: row.created_at,
        last_seen: row.last_seen,
        revoked: Boolean(row.revoked),
        has_push: Boolean(row.has_push),
      })),
      invites: this.db.prepare(`
        SELECT id, label, code, url, created_at, expires_at
        FROM invites
        WHERE workspace_id = ?
          AND used_at IS NULL
          AND revoked = 0
          AND expires_at > ?
        ORDER BY created_at DESC
      `).all(workspaceId, now).map((row) => ({
        id: row.id,
        label: row.label || 'New device',
        code: row.code,
        url: row.url,
        created_at: row.created_at,
        expires_at: row.expires_at,
      })),
    };
  }

  revokeWorkspaceDevice(workspaceId, id) {
    return this.db.prepare(`
      UPDATE devices SET revoked = 1
      WHERE id = ? AND workspace_id = ? AND revoked = 0
    `).run(id, workspaceId).changes === 1;
  }

  revokeWorkspaceInvite(workspaceId, id) {
    return this.db.prepare(`
      UPDATE invites SET revoked = 1, code = NULL, url = NULL
      WHERE id = ? AND workspace_id = ? AND used_at IS NULL AND revoked = 0
    `).run(id, workspaceId).changes === 1;
  }

  setDeviceRevoked(id, revoked) {
    return this.db.prepare(
      'UPDATE devices SET revoked = ? WHERE id = ?'
    ).run(revoked ? 1 : 0, id).changes === 1;
  }

  setDeviceLabel(id, label) {
    return this.db.prepare(
      'UPDATE devices SET label = ? WHERE id = ?'
    ).run(cleanLabel(label), id).changes === 1;
  }

  deleteDevice(id) {
    return this.db.prepare('DELETE FROM devices WHERE id = ?').run(id).changes === 1;
  }

  pruneDevices() {
    return this.db.prepare('DELETE FROM devices WHERE revoked = 1').run().changes;
  }

  adminTokenMatches(supplied) {
    if (!this.adminToken) return false;
    const expected = Buffer.from(this.adminToken);
    const candidate = Buffer.from(String(supplied || ''));
    return expected.length === candidate.length
      && crypto.timingSafeEqual(expected, candidate);
  }
}

/** A bounded, in-memory throttle for the only anonymous credential endpoint. */
export class RedemptionLimiter {
  constructor(options = {}) {
    this.windowMs = positiveInteger(options.windowMs, 60_000, { max: 3_600_000 });
    this.maxPerKey = positiveInteger(options.maxPerKey, 8, { max: 1000 });
    this.maxGlobal = positiveInteger(options.maxGlobal, 120, { max: 10000 });
    this.clock = options.clock || (() => Date.now());
    this.failures = new Map();
  }

  prune() {
    const cutoff = this.clock() - this.windowMs;
    for (const [key, timestamps] of this.failures) {
      const current = timestamps.filter((timestamp) => timestamp > cutoff);
      if (current.length) this.failures.set(key, current);
      else this.failures.delete(key);
    }
  }

  isBlocked(key) {
    this.prune();
    const globalCount = [...this.failures.values()]
      .reduce((total, timestamps) => total + timestamps.length, 0);
    return (this.failures.get(key)?.length || 0) >= this.maxPerKey
      || globalCount >= this.maxGlobal;
  }

  recordFailure(key) {
    this.prune();
    const safeKey = String(key || 'unknown').slice(0, 128);
    const entries = this.failures.get(safeKey) || [];
    entries.push(this.clock());
    this.failures.set(safeKey, entries);
  }
}

export function tokenFromCookieHeader(cookieHeader) {
  for (const part of String(cookieHeader || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== COOKIE_NAME) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}
