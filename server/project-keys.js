const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function parsePreviousProjectKeys(value = '') {
  const keys = {};
  const text = String(value || '').trim();
  if (!text) return keys;
  for (const item of text.split(',')) {
    const separator = item.indexOf('=');
    const keyId = separator > 0 ? item.slice(0, separator).trim() : '';
    const secret = separator > 0 ? item.slice(separator + 1).trim() : '';
    if (!KEY_ID.test(keyId) || secret.length < 32) {
      throw new Error('PROJECT_PREVIOUS_ENCRYPTION_KEYS contains an invalid key ID or short secret.');
    }
    if (Object.hasOwn(keys, keyId)) {
      throw new Error(`PROJECT_PREVIOUS_ENCRYPTION_KEYS repeats key ID ${keyId}.`);
    }
    keys[keyId] = secret;
  }
  return keys;
}

export function resolveProjectEncryption(options = {}) {
  const projectSecret = String(
    options.projectEncryptionKey ?? process.env.PROJECT_ENCRYPTION_KEY ?? '',
  ).trim();
  const shareSecret = String(
    options.shareEncryptionKey ?? process.env.SHARE_ENCRYPTION_KEY ?? '',
  ).trim();
  const adminSecret = String(options.adminToken ?? process.env.ADMIN_TOKEN ?? '').trim();
  const configuredKeyId = String(
    options.projectEncryptionKeyId ?? process.env.PROJECT_ENCRYPTION_KEY_ID ?? '',
  ).trim();

  let encryptionSecret;
  let encryptionKeyId;
  if (projectSecret) {
    encryptionSecret = projectSecret;
    encryptionKeyId = configuredKeyId || 'project-primary-v1';
  } else if (shareSecret) {
    encryptionSecret = shareSecret;
    encryptionKeyId = configuredKeyId || 'share-derived-v1';
  } else {
    encryptionSecret = adminSecret;
    encryptionKeyId = configuredKeyId || 'admin-derived-v1';
  }
  if (!KEY_ID.test(encryptionKeyId)) {
    throw new Error('PROJECT_ENCRYPTION_KEY_ID is invalid.');
  }

  const decryptionKeys = options.projectDecryptionKeys
    ?? parsePreviousProjectKeys(process.env.PROJECT_PREVIOUS_ENCRYPTION_KEYS);
  return { encryptionSecret, encryptionKeyId, decryptionKeys };
}
