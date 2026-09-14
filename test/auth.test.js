import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { initDatabase } from '../server/db.js';
import {
  AuthService,
  normaliseCode,
  RedemptionLimiter
} from '../server/auth.js';

const memoryDatabase = () => initDatabase(new DatabaseSync(':memory:'));

test('invite codes are unambiguous and forgiving about separators', () => {
  assert.equal(normaliseCode('abcd efgh jklm'), 'ABCD-EFGH-JKLM');
  assert.equal(normaliseCode('abcd-efgh-jklm'), 'ABCD-EFGH-JKLM');
  assert.equal(normaliseCode('ABCD-EFGH-IJKL'), '', 'I is not in the alphabet');
  assert.equal(normaliseCode('too-short'), '');
});

test('invite redemption creates one device and drops the plaintext code', () => {
  const db = memoryDatabase();
  const auth = new AuthService(db, {
    publicBaseUrl: 'https://stencil.example',
    clock: () => new Date('2026-09-13T10:00:00.000Z')
  });

  const invite = auth.createInvite('Workshop laptop');
  assert.match(invite.code, /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}$/);
  assert.equal(invite.url, `https://stencil.example/?code=${invite.code}`);

  const redeemed = auth.redeemInvite(invite.code.toLowerCase(), 'Main laptop');
  assert.ok(redeemed.token.length >= 40);
  assert.equal(redeemed.device.label, 'Main laptop');
  assert.equal(auth.deviceForToken(redeemed.token)?.id, redeemed.device.id);

  const listed = auth.listInvites().invites.find((row) => row.id === invite.id);
  assert.equal(listed.code, null);
  assert.equal(listed.url, null);
  assert.equal(listed.device_id, redeemed.device.id);
  assert.ok(listed.used_at);
  db.close();
});

test('grace redemption rotates only the same active device and never slides', () => {
  const db = memoryDatabase();
  let now = new Date('2026-09-13T10:00:00.000Z');
  const auth = new AuthService(db, {
    rebindMinutes: 60,
    clock: () => now
  });
  const invite = auth.createInvite('Laptop');
  const first = auth.redeemInvite(invite.code);

  now = new Date('2026-09-13T10:30:00.000Z');
  const second = auth.redeemInvite(invite.code);
  assert.equal(second.device.id, first.device.id);
  assert.notEqual(second.token, first.token);
  assert.equal(auth.deviceForToken(first.token), null, 'old token was rotated away');

  now = new Date('2026-09-13T11:01:00.000Z');
  assert.throws(() => auth.redeemInvite(invite.code), /already been used/);
  assert.equal(auth.listDevices().devices.length, 1);
  db.close();
});

test('administrator revocation wins over the invite rebind grace period', () => {
  const db = memoryDatabase();
  let now = new Date('2026-09-13T10:00:00.000Z');
  const auth = new AuthService(db, { clock: () => now });
  const invite = auth.createInvite('Lost laptop');
  const redeemed = auth.redeemInvite(invite.code);
  assert.equal(auth.setDeviceRevoked(redeemed.device.id, true), true);
  assert.equal(auth.deviceForToken(redeemed.token), null);

  now = new Date('2026-09-13T10:05:00.000Z');
  assert.throws(() => auth.redeemInvite(invite.code), /already been used/);
  assert.equal(auth.listDevices().devices[0].revoked, true);
  db.close();
});

test('admin secret fails closed and uses an exact match', () => {
  const db = memoryDatabase();
  assert.equal(new AuthService(db).adminTokenMatches('anything'), false);
  const auth = new AuthService(db, { adminToken: 'a-secret-long-enough' });
  assert.equal(auth.adminTokenMatches('a-secret-long-enough'), true);
  assert.equal(auth.adminTokenMatches('a-secret-long-enougH'), false);
  assert.equal(auth.adminTokenMatches('short'), false);
  db.close();
});

test('redemption throttle is per key with a separate global backstop', () => {
  let time = 1_000;
  const limiter = new RedemptionLimiter({
    maxPerKey: 2,
    maxGlobal: 3,
    windowMs: 1_000,
    clock: () => time
  });
  limiter.recordFailure('one');
  assert.equal(limiter.isBlocked('one'), false);
  limiter.recordFailure('one');
  assert.equal(limiter.isBlocked('one'), true);
  assert.equal(limiter.isBlocked('two'), false);
  limiter.recordFailure('two');
  assert.equal(limiter.isBlocked('three'), true, 'global cap applies');
  time += 1_001;
  assert.equal(limiter.isBlocked('one'), false, 'old attempts expire');
});
