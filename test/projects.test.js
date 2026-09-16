import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { AuthService } from '../server/auth.js';
import { initDatabase, openDatabase } from '../server/db.js';
import { ProjectError, ProjectService } from '../server/projects.js';

function bundle(id, name = 'Portrait', { trashedAt = null } = {}) {
  return Buffer.from(JSON.stringify({
    schema: 'stencil-cnc.share-bundle',
    version: 1,
    clientProjectId: id,
    trashedAt,
    project: {
      schema: 'stencil-cnc.project',
      version: 1,
      id,
      name,
      units: 'mm',
      sheet: { widthMm: 297, heightMm: 420 },
      conversion: { mode: 'line-art', threshold: 128, invert: false, backgroundLuminance: 255 },
      frame: {
        enabled: true,
        thicknessMm: 12,
        insetMm: 0,
        sides: { top: true, right: true, bottom: true, left: true },
      },
      manufacturing: { kerfMm: 1.2, minimumWebMm: 3, minimumOpeningMm: 2, maximumCantileverMm: null },
      structure: { mode: 'single-sheet' },
      source: { kind: 'none', name: null, mimeType: null, widthPx: null, heightPx: null, imageDataUrl: null },
      raster: { sourceMask: null, baseMask: null },
      bridges: [],
      editor: { projectSummary: { cutStyle: 'lamele', status: 'draft', thumbnail: null } },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    source: null,
    checkpoints: [],
    artifacts: [],
  }));
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kerfloom-project-test-'));
  const db = initDatabase(new DatabaseSync(':memory:'));
  const auth = new AuthService(db);
  const invite = auth.createInvite('Owner');
  const owner = auth.redeemInvite(invite.code).device;
  const service = new ProjectService(db, {
    directory,
    encryptionSecret: 'p'.repeat(64),
  });
  return { directory, db, auth, owner, service };
}

test('complete projects are encrypted, revision checked, and isolated by workspace', () => {
  const { directory, db, auth, owner, service } = fixture();
  try {
    const id = '6d2c3840-6c42-4e37-8a4c-471f55f59362';
    const created = service.save(owner.workspaceId, id, bundle(id), '0');
    assert.equal(created.revision, 1);
    assert.equal(created.name, 'Portrait');
    assert.equal(service.list(owner.workspaceId).length, 1);

    const storedFile = fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]));
    assert.equal(storedFile.includes(Buffer.from('Portrait')), false);
    assert.deepEqual(JSON.parse(service.bundle(owner.workspaceId, id).buffer), JSON.parse(bundle(id)));

    assert.throws(
      () => service.save(owner.workspaceId, id, bundle(id, 'Stale edit'), '0'),
      (error) => error instanceof ProjectError && error.status === 409 && error.details.currentRevision === 1,
    );
    const updated = service.save(owner.workspaceId, id, bundle(id, 'New name'), '1');
    assert.equal(updated.revision, 2);

    const otherInvite = auth.createInvite('Other person');
    const other = auth.redeemInvite(otherInvite.code).device;
    assert.equal(service.list(other.workspaceId).length, 0);
    assert.throws(() => service.bundle(other.workspaceId, id), /not found/i);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('device invites join the issuing workspace and trash state travels with the bundle', () => {
  const { directory, db, auth, owner, service } = fixture();
  try {
    const linkedInvite = auth.createInvite('Second laptop', owner.workspaceId);
    const linked = auth.redeemInvite(linkedInvite.code).device;
    assert.equal(linked.workspaceId, owner.workspaceId);

    const id = '9b23ed19-55fd-44b0-9d27-0584907d045e';
    const saved = service.save(
      owner.workspaceId,
      id,
      bundle(id, 'Trashed', { trashedAt: '2026-01-02T00:00:00.000Z' }),
      '0',
    );
    assert.equal(saved.trashedAt, '2026-01-02T00:00:00.000Z');
    assert.equal(service.list(linked.workspaceId)[0].id, id);
    const deleted = service.delete(linked.workspaceId, id, '1');
    assert.equal(deleted.id, id);
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.revision, 2);
    const tombstone = service.list(owner.workspaceId)[0];
    assert.equal(tombstone.deletedAt, deleted.deletedAt);
    assert.equal(tombstone.sizeBytes, 0);
    assert.throws(() => service.bundle(owner.workspaceId, id), /not found/i);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a permanently deleted project id cannot be silently resurrected', () => {
  const { directory, db, owner, service } = fixture();
  try {
    const id = 'f5140d8d-e5b6-47eb-92b5-2c33f907b24d';
    service.save(owner.workspaceId, id, bundle(id, 'Original'), '0');
    const deleted = service.delete(owner.workspaceId, id, '1');

    assert.throws(
      () => service.save(owner.workspaceId, id, bundle(id, 'Stale offline edit'), String(deleted.revision)),
      (error) => error instanceof ProjectError &&
        error.status === 409 &&
        error.code === 'project_deleted' &&
        error.details.project.deletedAt === deleted.deletedAt,
    );

    const recoveredId = 'f5140d8d-e5b6-47eb-92b5-2c33f907b24e';
    const recovered = service.save(owner.workspaceId, recoveredId, bundle(recoveredId, 'Recovered copy'), '0');
    assert.equal(recovered.revision, 1);
    assert.equal(service.list(owner.workspaceId).filter((project) => !project.deletedAt).length, 1);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a failure before metadata commit leaves the previous revision readable', () => {
  const { directory, db, owner, service } = fixture();
  try {
    const id = '3d9b9fc1-58f8-4a4d-88dd-7b9ffdb98de7';
    service.save(owner.workspaceId, id, bundle(id, 'Committed revision'), '0');
    const failing = new ProjectService(db, {
      directory,
      encryptionSecret: 'p'.repeat(64),
      faultInjector(phase) {
        if (phase === 'before_database_commit') throw new Error('injected precommit failure');
      },
    });

    assert.throws(
      () => failing.save(owner.workspaceId, id, bundle(id, 'Uncommitted revision'), '1'),
      /injected precommit failure/,
    );
    assert.equal(failing.bundle(owner.workspaceId, id).row.revision, 1);
    assert.equal(JSON.parse(failing.bundle(owner.workspaceId, id).buffer).project.name, 'Committed revision');
    assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith('.project')).length, 1);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a failure after metadata commit leaves the new revision readable and recoverable', () => {
  const { directory, db, owner, service } = fixture();
  try {
    const id = '8cb5e87b-fc80-47df-b205-af6767daf47f';
    service.save(owner.workspaceId, id, bundle(id, 'First revision'), '0');
    const failing = new ProjectService(db, {
      directory,
      encryptionSecret: 'p'.repeat(64),
      recoverOnStart: false,
      faultInjector(phase) {
        if (phase === 'after_database_commit') throw new Error('injected postcommit failure');
      },
    });

    assert.throws(
      () => failing.save(owner.workspaceId, id, bundle(id, 'Committed replacement'), '1'),
      /injected postcommit failure/,
    );
    assert.equal(failing.bundle(owner.workspaceId, id).row.revision, 2);
    assert.equal(JSON.parse(failing.bundle(owner.workspaceId, id).buffer).project.name, 'Committed replacement');
    assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith('.project')).length, 2);

    const recovered = new ProjectService(db, {
      directory,
      encryptionSecret: 'p'.repeat(64),
      orphanGraceMs: 0,
    });
    assert.equal(recovered.recoverySummary.removedOrphans, 1);
    assert.equal(JSON.parse(recovered.bundle(owner.workspaceId, id).buffer).project.name, 'Committed replacement');
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('old-revision cleanup failure cannot roll back a committed replacement', () => {
  const { directory, db, owner, service } = fixture();
  const warnings = [];
  try {
    const id = 'c303cc16-970b-471c-b335-62e3b2f52387';
    service.save(owner.workspaceId, id, bundle(id, 'First revision'), '0');
    const cleanupFailure = new ProjectService(db, {
      directory,
      encryptionSecret: 'p'.repeat(64),
      recoverOnStart: false,
      faultInjector(phase) {
        if (phase === 'before_old_revision_cleanup') throw new Error('injected cleanup failure');
      },
      onStorageWarning(message, error) {
        warnings.push({ message, error });
      },
    });

    const saved = cleanupFailure.save(owner.workspaceId, id, bundle(id, 'Second revision'), '1');
    assert.equal(saved.revision, 2);
    assert.equal(JSON.parse(cleanupFailure.bundle(owner.workspaceId, id).buffer).project.name, 'Second revision');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /committed/i);
    assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith('.project')).length, 2);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy replacement artifacts recover the revision referenced by SQLite', () => {
  const { directory, db, owner, service } = fixture();
  try {
    const id = '1e5c479b-66d0-45e1-926d-88d0eb67d080';
    service.save(owner.workspaceId, id, bundle(id, 'Referenced revision'), '0');
    const row = service.row(owner.workspaceId, id);
    const legacyName = `${row.id}.project`;
    const legacyTarget = path.join(directory, legacyName);
    const legacyBackup = path.join(directory, `${legacyName}.${crypto.randomUUID()}.bak`);
    fs.renameSync(path.join(directory, row.file_name), legacyBackup);
    fs.writeFileSync(legacyTarget, service.encrypt(bundle(id, 'Uncommitted replacement')));
    db.prepare('UPDATE server_projects SET file_name = ? WHERE id = ?').run(legacyName, row.id);

    const recovered = new ProjectService(db, {
      directory,
      encryptionSecret: 'p'.repeat(64),
      orphanGraceMs: 0,
    });
    assert.equal(recovered.recoverySummary.restoredLegacyFiles, 1);
    assert.equal(JSON.parse(recovered.bundle(owner.workspaceId, id).buffer).project.name, 'Referenced revision');
    assert.ok(fs.readdirSync(directory).some((name) => name.endsWith('.unmatched')));
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an isolated database, bundle-directory, and key restore opens sources and exports', () => {
  const liveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kerfloom-live-'));
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kerfloom-restore-'));
  const liveDbFile = path.join(liveRoot, 'stencil-cnc.db');
  const liveProjects = path.join(liveRoot, 'projects');
  const secret = 'restore-key-'.padEnd(64, 'r');
  let liveDb = openDatabase(liveDbFile);
  let restoredDb;
  try {
    const auth = new AuthService(liveDb);
    const owner = auth.redeemInvite(auth.createInvite('Restore owner').code).device;
    const service = new ProjectService(liveDb, {
      directory: liveProjects,
      encryptionSecret: secret,
    });
    const id = '5f630645-edc9-443a-9f75-94212e3e48be';
    const complete = JSON.parse(bundle(id, 'Restorable project'));
    complete.source = {
      name: 'portrait.png',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,c291cmNl',
    };
    complete.artifacts = [{
      name: 'kerfloom-export.svg',
      kind: 'svg',
      dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
    }];
    service.save(owner.workspaceId, id, Buffer.from(JSON.stringify(complete)), '0');
    liveDb.close();
    liveDb = null;

    fs.copyFileSync(liveDbFile, path.join(backupRoot, 'stencil-cnc.db'));
    fs.cpSync(liveProjects, path.join(backupRoot, 'projects'), { recursive: true });
    restoredDb = openDatabase(path.join(backupRoot, 'stencil-cnc.db'));
    const restored = new ProjectService(restoredDb, {
      directory: path.join(backupRoot, 'projects'),
      encryptionSecret: secret,
    });
    const restoredBundle = JSON.parse(restored.bundle(owner.workspaceId, id).buffer);
    assert.equal(restoredBundle.source.name, 'portrait.png');
    assert.equal(restoredBundle.source.dataUrl, complete.source.dataUrl);
    assert.deepEqual(restoredBundle.artifacts, complete.artifacts);
  } finally {
    liveDb?.close();
    restoredDb?.close();
    fs.rmSync(liveRoot, { recursive: true, force: true });
    fs.rmSync(backupRoot, { recursive: true, force: true });
  }
});

test('key rotation reads legacy bundles and migrates every live pointer to the named current key', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kerfloom-key-test-'));
  const db = initDatabase(new DatabaseSync(':memory:'));
  try {
    const auth = new AuthService(db);
    const owner = auth.redeemInvite(auth.createInvite('Key owner').code).device;
    const oldSecret = 'old-key-'.padEnd(64, 'a');
    const newSecret = 'new-key-'.padEnd(64, 'b');
    const id = '02b791ba-adbe-4336-9b2c-d38aef9b7ae0';
    const oldService = new ProjectService(db, {
      directory,
      encryptionSecret: oldSecret,
      encryptionKeyId: 'admin-derived-v1',
    });
    oldService.save(owner.workspaceId, id, bundle(id, 'Legacy encrypted project'), '0');

    // Simulate an STPJ1 file from a deployment before key IDs existed.
    const oldRow = oldService.row(owner.workspaceId, id);
    fs.writeFileSync(
      path.join(directory, oldRow.file_name),
      oldService.encryptLegacy(bundle(id, 'Legacy encrypted project'), oldSecret),
    );
    db.prepare('UPDATE server_projects SET key_id = NULL WHERE id = ?').run(oldRow.id);

    const rotating = new ProjectService(db, {
      directory,
      encryptionSecret: newSecret,
      encryptionKeyId: 'project-2026-09',
      decryptionKeys: { 'admin-derived-v1': oldSecret },
    });
    assert.equal(JSON.parse(rotating.bundle(owner.workspaceId, id).buffer).project.name, 'Legacy encrypted project');
    assert.deepEqual(rotating.migrateEncryption(), {
      keyId: 'project-2026-09',
      migrated: 1,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    });
    assert.equal(rotating.row(owner.workspaceId, id).key_id, 'project-2026-09');

    const retiredOldKey = new ProjectService(db, {
      directory,
      encryptionSecret: newSecret,
      encryptionKeyId: 'project-2026-09',
    });
    assert.equal(JSON.parse(retiredOldKey.bundle(owner.workspaceId, id).buffer).project.name, 'Legacy encrypted project');
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
