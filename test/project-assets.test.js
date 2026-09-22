import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { AuthService } from '../server/auth.js';
import { initDatabase } from '../server/db.js';
import { ProjectAssetError, ProjectAssetService } from '../server/project-assets.js';
import { ProjectService } from '../server/projects.js';

const digest = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function project(id, name = 'Asset portrait') {
  return {
    schema: 'stencil-cnc.project',
    version: 1,
    id,
    name,
    units: 'mm',
    sheet: { widthMm: 297, heightMm: 420 },
    conversion: { mode: 'line-art', threshold: 128, invert: false, backgroundLuminance: 255 },
    frame: { enabled: true, thicknessMm: 12, insetMm: 0, sides: { top: true, right: true, bottom: true, left: true } },
    manufacturing: { kerfMm: 1.2, minimumWebMm: 3, minimumOpeningMm: 2, maximumCantileverMm: null },
    structure: { mode: 'single-sheet' },
    source: { kind: 'none', name: null, mimeType: null, widthPx: null, heightPx: null, imageDataUrl: null },
    raster: { sourceMask: null, baseMask: null },
    bridges: [],
    editor: {
      projectSummary: {
        cutStyle: 'flow-engraving',
        status: 'draft',
        thumbnail: 'data:image/png;base64,iVBORw0KGgo=',
      },
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function manifest(id, asset) {
  return Buffer.from(JSON.stringify({
    schema: 'kerfloom.project-manifest',
    version: 1,
    clientProjectId: id,
    trashedAt: null,
    project: project(id),
    source: {
      assetId: asset.id,
      sha256: asset.sha256,
      size: asset.sizeBytes,
      name: 'portrait.jpg',
      mimeType: 'image/jpeg',
    },
    checkpoints: [],
    artifacts: [],
  }));
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kerfloom-asset-test-'));
  const db = initDatabase(new DatabaseSync(':memory:'));
  const auth = new AuthService(db);
  const owner = auth.redeemInvite(auth.createInvite('Owner').code).device;
  const stranger = auth.redeemInvite(auth.createInvite('Stranger').code).device;
  let now = new Date('2026-01-01T00:00:00.000Z');
  const assets = new ProjectAssetService(db, {
    directory: path.join(root, 'assets'),
    encryptionSecret: 'a'.repeat(64),
    clock: () => now,
    orphanGraceMs: 1_000,
  });
  const projects = new ProjectService(db, {
    directory: path.join(root, 'projects'),
    encryptionSecret: 'a'.repeat(64),
    clock: () => now,
    assets,
  });
  return { root, db, owner, stranger, assets, projects, advance: (milliseconds) => {
    now = new Date(now.getTime() + milliseconds);
  } };
}

test('project assets are encrypted, workspace-scoped, and deduplicated privately', () => {
  const { root, db, owner, stranger, assets } = fixture();
  try {
    const bytes = Buffer.from('private original photo bytes');
    const first = assets.upload(owner.workspaceId, bytes, {
      sha256: digest(bytes),
      kind: 'source',
      mimeType: 'image/jpeg',
    });
    assert.equal(first.created, true);
    const repeated = assets.upload(owner.workspaceId, bytes, {
      sha256: digest(bytes),
      kind: 'source',
      mimeType: 'image/jpeg',
    });
    assert.equal(repeated.created, false);
    assert.equal(repeated.asset.id, first.asset.id);
    assert.deepEqual(assets.read(owner.workspaceId, first.asset.id).buffer, bytes);
    assert.throws(
      () => assets.read(stranger.workspaceId, first.asset.id),
      (error) => error instanceof ProjectAssetError && error.status === 404,
    );
    const stored = fs.readFileSync(path.join(root, 'assets', `${first.asset.id}.asset`));
    assert.equal(stored.includes(bytes), false);
    assert.throws(
      () => assets.upload(owner.workspaceId, bytes, {
        sha256: '0'.repeat(64),
        kind: 'source',
        mimeType: 'image/jpeg',
      }),
      (error) => error instanceof ProjectAssetError && error.code === 'asset_digest_mismatch',
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('asset manifests stay small, track references, and hydrate legacy bundles', () => {
  const { root, db, owner, assets, projects, advance } = fixture();
  try {
    const id = '4193df23-a883-48f2-b638-953b82aa7651';
    const bytes = Buffer.from('jpeg payload');
    const asset = assets.upload(owner.workspaceId, bytes, {
      sha256: digest(bytes),
      kind: 'source',
      mimeType: 'image/jpeg',
    }).asset;
    const payload = manifest(id, asset);
    const saved = projects.save(owner.workspaceId, id, payload, '0');
    assert.equal(saved.storageFormat, 'asset-manifest-v1');
    assert.equal(saved.thumbnail, project(id).editor.projectSummary.thumbnail);
    assert.deepEqual(projects.state(owner.workspaceId, id).buffer, payload);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM project_asset_refs').get().count, 1);

    const portable = JSON.parse(projects.bundle(owner.workspaceId, id).buffer);
    assert.equal(portable.schema, 'stencil-cnc.share-bundle');
    assert.equal(portable.source.dataUrl, `data:image/jpeg;base64,${bytes.toString('base64')}`);

    const withoutSource = JSON.parse(payload);
    withoutSource.source = null;
    withoutSource.project.name = 'No source';
    projects.save(owner.workspaceId, id, Buffer.from(JSON.stringify(withoutSource)), '1');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM project_asset_refs').get().count, 0);
    advance(2_000);
    assert.equal(assets.cleanupUnreferenced().removed, 1);
    assert.equal(fs.existsSync(path.join(root, 'assets', `${asset.id}.asset`)), false);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

