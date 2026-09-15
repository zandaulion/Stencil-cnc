import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { AuthService } from '../server/auth.js';
import { initDatabase } from '../server/db.js';
import { ShareService } from '../server/shares.js';

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
