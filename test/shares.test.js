import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { AuthService } from '../server/auth.js';
import { initDatabase } from '../server/db.js';
import { parseBundle, ShareService } from '../server/shares.js';
import { createMask, createReleaseManifest } from '../web/core/index.js';

const bundle = Buffer.from(JSON.stringify({
  schema: 'stencil-cnc.share-bundle',
  version: 1,
  clientProjectId: 'browser-project',
  project: {
    schema: 'stencil-cnc.project',
    version: 1,
    name: 'Portrait',
    sheet: { widthMm: 297, heightMm: 420 },
    editor: { projectSummary: { cutStyle: 'lamele', thumbnail: null } },
  },
  source: null,
  checkpoints: [],
  artifacts: [],
}));

function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stencil-share-test-'));
  const db = initDatabase(new DatabaseSync(':memory:'));
  const auth = new AuthService(db, { adminToken: 'a'.repeat(64) });
  const invite = auth.createInvite('Owner');
  const owner = auth.redeemInvite(invite.code).device;
  const service = new ShareService(db, {
    directory,
    encryptionSecret: 'b'.repeat(64),
    ...options,
  });
  return { directory, db, owner, service };
}

test('expired snapshots become inaccessible and their encrypted files are cleaned up', () => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const { directory, db, owner, service } = fixture({ clock: () => now });
  try {
    const share = service.create(owner.id, bundle, { expiresDays: 1 });
    const file = path.join(directory, `${share.id}.share`);
    assert.equal(fs.existsSync(file), true);
    now = new Date('2026-01-03T00:00:00.000Z');
    assert.throws(() => service.claim(share.id, share.token, owner.id), /unavailable or has expired/);
    assert.equal(service.list(owner.id)[0].status, 'expired');
    assert.equal(fs.existsSync(file), false);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('per-owner limits refuse additional snapshots before writing another file', () => {
  const { directory, db, owner, service } = fixture({ maximumActiveShares: 1 });
  try {
    service.create(owner.id, bundle);
    assert.throws(() => service.create(owner.id, bundle), /allowance is full/);
    assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith('.share')).length, 1);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('server bundles verify retained release manifests against their exact export bytes', async () => {
  const exportBlob = new Blob(['<svg/>'], { type: 'image/svg+xml' });
  const mask = createMask(2, 2, 1);
  const releaseManifest = await createReleaseManifest({
    releaseId: 'release-server-check',
    createdAt: '2026-09-21T10:00:00.000Z',
    projectId: 'browser-project',
    projectName: 'Portrait',
    projectRevision: 3,
    projectSchema: 'stencil-cnc.project',
    projectVersion: 6,
    mask,
    sheet: { widthMm: 20, heightMm: 20 },
    filename: 'portrait.svg',
    kind: 'svg',
    mimeType: exportBlob.type,
    blob: exportBlob,
    drawingUnits: 'mm',
    profileSnapshot: { name: 'Profile' },
    geometryInterpretation: 'finished-boundary-cam-v1',
    validation: { valid: true, issues: [] },
    validationRevision: 3,
    validatedAt: '2026-09-21T09:59:00.000Z',
    validationModelVersion: 1,
  });
  const candidate = JSON.parse(bundle.toString('utf8'));
  candidate.artifacts = [{
    filename: 'portrait.svg',
    kind: 'svg',
    mimeType: 'image/svg+xml',
    createdAt: '2026-09-21T10:00:00.000Z',
    profileSnapshot: { name: 'Profile' },
    releaseManifest: JSON.parse(JSON.stringify(releaseManifest)),
    dataUrl: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
  }];

  assert.equal(parseBundle(Buffer.from(JSON.stringify(candidate))).artifacts.length, 1);
  const originalName = candidate.artifacts[0].releaseManifest.project.name;
  candidate.artifacts[0].releaseManifest.project.name = 'Changed after release';
  assert.throws(
    () => parseBundle(Buffer.from(JSON.stringify(candidate))),
    /unsupported export artefacts/i,
  );
  candidate.artifacts[0].releaseManifest.project.name = originalName;
  candidate.artifacts[0].dataUrl = `data:image/svg+xml;base64,${Buffer.from('<svg>changed</svg>').toString('base64')}`;
  assert.throws(
    () => parseBundle(Buffer.from(JSON.stringify(candidate))),
    /unsupported export artefacts/i,
  );
});
