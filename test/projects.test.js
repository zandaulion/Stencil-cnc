import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { AuthService } from '../server/auth.js';
import { initDatabase } from '../server/db.js';
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
