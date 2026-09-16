import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePreviousProjectKeys, resolveProjectEncryption } from '../server/project-keys.js';

test('project key resolution names each fallback source without exposing its value', () => {
  const adminToken = 'a'.repeat(64);
  const shareKey = 's'.repeat(64);
  const projectKey = 'p'.repeat(64);

  assert.deepEqual(resolveProjectEncryption({ adminToken, projectEncryptionKey: '', shareEncryptionKey: '' }), {
    encryptionSecret: adminToken,
    encryptionKeyId: 'admin-derived-v1',
    decryptionKeys: {},
  });
  assert.equal(resolveProjectEncryption({
    adminToken,
    shareEncryptionKey: shareKey,
    projectEncryptionKey: '',
  }).encryptionKeyId, 'share-derived-v1');
  assert.deepEqual(resolveProjectEncryption({
    adminToken,
    shareEncryptionKey: shareKey,
    projectEncryptionKey: projectKey,
    projectEncryptionKeyId: 'project-2026-09',
    projectDecryptionKeys: { 'admin-derived-v1': adminToken },
  }), {
    encryptionSecret: projectKey,
    encryptionKeyId: 'project-2026-09',
    decryptionKeys: { 'admin-derived-v1': adminToken },
  });
});

test('previous project keys require unique safe IDs and sufficiently long secrets', () => {
  assert.deepEqual(parsePreviousProjectKeys(`old-a=${'a'.repeat(32)},old-b=${'b'.repeat(64)}`), {
    'old-a': 'a'.repeat(32),
    'old-b': 'b'.repeat(64),
  });
  assert.throws(() => parsePreviousProjectKeys('bad id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), /invalid/i);
  assert.throws(() => parsePreviousProjectKeys('old=short'), /short/i);
  assert.throws(
    () => parsePreviousProjectKeys(`old=${'a'.repeat(32)},old=${'b'.repeat(32)}`),
    /repeats/i,
  );
});
