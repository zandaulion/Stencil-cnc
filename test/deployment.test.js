import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { AuthService, COOKIE_NAME } from '../server/auth.js';
import { initDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stencil-cnc-http-'));
const webDirectory = path.join(temporaryRoot, 'web');
fs.mkdirSync(path.join(webDirectory, 'core'), { recursive: true });
fs.mkdirSync(path.join(webDirectory, 'workers'), { recursive: true });
fs.writeFileSync(path.join(webDirectory, 'index.html'), '<!doctype html><title>__BUILD_VERSION__</title>');
fs.writeFileSync(path.join(webDirectory, 'app.js'), 'globalThis.bootstrap = true;');
fs.writeFileSync(path.join(webDirectory, 'editor.js'), 'export const editor = true;');
fs.writeFileSync(path.join(webDirectory, 'storage.js'), 'export const storage = true;');
fs.writeFileSync(path.join(webDirectory, 'project-sync.js'), 'export const sync = true;');
fs.writeFileSync(path.join(webDirectory, 'core', 'geometry.js'), 'export const geometry = true;');
fs.writeFileSync(path.join(webDirectory, 'workers', 'image.js'), 'postMessage(true);');
fs.writeFileSync(path.join(webDirectory, 'bust.html'), '<!doctype html><title>Bust</title>');
fs.writeFileSync(path.join(webDirectory, 'sw.js'), "const C='__BUILD_VERSION__';");

const db = initDatabase(new DatabaseSync(':memory:'));
const auth = new AuthService(db, {
  adminToken: 'test-admin-token-that-is-not-secret',
  publicBaseUrl: 'https://stencil-cnc.zandaulion.com'
});
const shareDirectory = path.join(temporaryRoot, 'shares');
const projectDirectory = path.join(temporaryRoot, 'projects');
const app = createApp({
  db,
  auth,
  webDir: webDirectory,
  shareDirectory,
  projectDirectory,
  projectEncryptionKey: 'server-project-test-key'.repeat(4),
});
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

const request = (pathname, options = {}) => fetch(base + pathname, {
  ...options,
  headers: {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {})
  }
});

const adminHeaders = { 'X-Admin-Token': 'test-admin-token-that-is-not-secret' };

async function register(label = 'Test laptop') {
  const inviteResponse = await request('/api/admin/invites', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ label })
  });
  assert.equal(inviteResponse.status, 201);
  const invite = await inviteResponse.json();
  const response = await request('/api/auth/redeem', {
    method: 'POST',
    body: JSON.stringify({ code: invite.code, label })
  });
  assert.equal(response.status, 200);
  return {
    body: await response.json(),
    cookie: response.headers.get('set-cookie').split(';')[0],
    setCookie: response.headers.get('set-cookie')
  };
}

test('health and invite shell are public but admin is hidden', async () => {
  assert.equal((await request('/api/health')).status, 200);
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/app.js')).status, 200);
  assert.equal((await request('/api/admin/devices')).status, 404);
});

test('redemption uses only a secure HttpOnly host cookie', async () => {
  const session = await register();
  assert.equal(session.body.ok, true);
  assert.equal(session.body.token, undefined);
  assert.match(session.setCookie, new RegExp(`^${COOKIE_NAME}=`));
  assert.match(session.setCookie, /HttpOnly/i);
  assert.match(session.setCookie, /Secure/i);
  assert.match(session.setCookie, /SameSite=Lax/i);
  assert.match(session.setCookie, /Path=\//i);

  assert.equal((await request('/api/auth/me')).status, 401);
  const me = await request('/api/auth/me', { headers: { Cookie: session.cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).device.id, session.body.device.id);
});

test('operational modules require the cookie while gate assets do not', async () => {
  for (const pathname of ['/editor.js', '/storage.js', '/project-sync.js', '/core/geometry.js', '/workers/image.js']) {
    const response = await request(pathname);
    assert.equal(response.status, 401, pathname);
    assert.match(response.headers.get('cache-control'), /no-store/);
  }

  const session = await register('Authorised laptop');
  for (const pathname of ['/editor.js', '/storage.js', '/project-sync.js', '/core/geometry.js', '/workers/image.js']) {
    const response = await request(pathname, { headers: { Cookie: session.cookie } });
    assert.equal(response.status, 200, pathname);
    assert.match(response.headers.get('cache-control'), /private/);
    assert.match(response.headers.get('vary'), /Cookie/);
  }
});

test('revoking through the console immediately blocks online protected assets', async () => {
  const session = await register('Revoked device');
  const revoked = await request(`/api/admin/devices/${session.body.device.id}/revoke`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ revoked: true })
  });
  assert.equal(revoked.status, 200);
  assert.equal((await request('/editor.js', { headers: { Cookie: session.cookie } })).status, 401);
});

test('encrypted project snapshots are claimable by one invited recipient and revocable by the owner', async () => {
  const owner = await register('Project owner');
  const recipient = await register('Project recipient');
  const stranger = await register('Other workshop');
  const bundle = {
    schema: 'stencil-cnc.share-bundle',
    version: 1,
    clientProjectId: 'local-project-1',
    project: {
      schema: 'stencil-cnc.project',
      version: 1,
      name: 'Private portrait',
      sheet: { widthMm: 297, heightMm: 420 },
      editor: {
        projectSummary: {
          cutStyle: 'lamele',
          thumbnail: 'data:image/png;base64,cHJldmlldw==',
        },
      },
    },
    source: {
      name: 'private.jpg',
      mimeType: 'image/jpeg',
      dataUrl: 'data:image/jpeg;base64,cHJpdmF0ZS1waG90bw==',
    },
    checkpoints: [{ label: 'Validated', project: { schema: 'stencil-cnc.project' } }],
    artifacts: [],
  };
  const created = await request('/api/shares?expiresDays=30', {
    method: 'POST',
    headers: {
      Cookie: owner.cookie,
      'Content-Type': 'application/vnd.stencil-cnc.share+json',
    },
    body: JSON.stringify(bundle),
  });
  assert.equal(created.status, 201);
  const share = await created.json();
  assert.match(share.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(share.path, `/share/${share.id}`);
  assert.equal(share.hasSource, true);
  assert.equal(share.checkpointCount, 1);

  const encryptedFile = fs.readFileSync(path.join(shareDirectory, `${share.id}.share`));
  assert.equal(encryptedFile.includes(Buffer.from('Private portrait')), false);
  assert.equal(encryptedFile.includes(Buffer.from('private-photo')), false);
  assert.equal(encryptedFile.includes(Buffer.from('cHJldmlldw==')), false);

  assert.equal((await request(`/api/shares/${share.id}/claim`, {
    method: 'POST',
    headers: { Cookie: recipient.cookie, 'X-Share-Token': 'wrong' },
  })).status, 404);
  const claimed = await request(`/api/shares/${share.id}/claim`, {
    method: 'POST',
    headers: { Cookie: recipient.cookie, 'X-Share-Token': share.token },
  });
  assert.equal(claimed.status, 200);
  const claimedMetadata = await claimed.json();
  assert.equal(claimedMetadata.direction, 'received');
  assert.equal(claimedMetadata.thumbnail, bundle.project.editor.projectSummary.thumbnail);

  assert.equal((await request(`/api/shares/${share.id}/claim`, {
    method: 'POST',
    headers: { Cookie: stranger.cookie, 'X-Share-Token': share.token },
  })).status, 403);

  const downloaded = await request(`/api/shares/${share.id}/bundle`, {
    headers: { Cookie: recipient.cookie, 'X-Share-Token': share.token },
  });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(await downloaded.json(), bundle);

  const ownerShares = await request('/api/shares', { headers: { Cookie: owner.cookie } });
  assert.equal((await ownerShares.json()).shares[0].direction, 'sent');
  const recipientShares = await request('/api/shares', { headers: { Cookie: recipient.cookie } });
  assert.equal((await recipientShares.json()).shares[0].direction, 'received');

  assert.equal((await request(`/api/shares/${share.id}`, {
    method: 'DELETE',
    headers: { Cookie: recipient.cookie },
  })).status, 404);
  assert.equal((await request(`/api/shares/${share.id}`, {
    method: 'DELETE',
    headers: { Cookie: owner.cookie },
  })).status, 200);
  assert.equal(fs.existsSync(path.join(shareDirectory, `${share.id}.share`)), false);
  assert.equal((await request(`/api/shares/${share.id}/bundle`, {
    headers: { Cookie: recipient.cookie, 'X-Share-Token': share.token },
  })).status, 404);
});

test('server projects synchronize complete encrypted bundles across linked workspace devices', async () => {
  const owner = await register('Workspace owner');
  const linkedInviteResponse = await request('/api/workspace/device-invites', {
    method: 'POST',
    headers: { Cookie: owner.cookie },
    body: JSON.stringify({ label: 'Linked laptop' }),
  });
  assert.equal(linkedInviteResponse.status, 201);
  const linkedInvite = await linkedInviteResponse.json();
  const linkedResponse = await request('/api/auth/redeem', {
    method: 'POST',
    body: JSON.stringify({ code: linkedInvite.code, label: 'Linked laptop' }),
  });
  const linked = {
    body: await linkedResponse.json(),
    cookie: linkedResponse.headers.get('set-cookie').split(';')[0],
  };
  assert.equal(linked.body.device.workspaceId, owner.body.device.workspaceId);

  const id = 'b1518649-d420-44fd-a18c-1ac71c706166';
  const bundle = {
    schema: 'stencil-cnc.share-bundle',
    version: 1,
    clientProjectId: id,
    trashedAt: null,
    project: {
      schema: 'stencil-cnc.project',
      version: 1,
      id,
      name: 'Server portrait',
      sheet: { widthMm: 297, heightMm: 420 },
      editor: { projectSummary: { cutStyle: 'lamele', status: 'ready' } },
    },
    source: { name: 'portrait.jpg', mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,cHJpdmF0ZQ==' },
    checkpoints: [],
    artifacts: [],
  };
  const saved = await request(`/api/projects/${id}`, {
    method: 'PUT',
    headers: {
      Cookie: owner.cookie,
      'Content-Type': 'application/vnd.kerfloom.project-bundle+json',
      'If-Match': '"0"',
    },
    body: JSON.stringify(bundle),
  });
  assert.equal(saved.status, 201);
  assert.equal((await saved.json()).project.revision, 1);
  const encryptedFile = fs.readFileSync(path.join(projectDirectory, fs.readdirSync(projectDirectory)[0]));
  assert.equal(encryptedFile.includes(Buffer.from('Server portrait')), false);
  assert.equal(encryptedFile.includes(Buffer.from('private')), false);

  const listed = await request('/api/projects', { headers: { Cookie: linked.cookie } });
  assert.equal((await listed.json()).projects[0].id, id);
  const downloaded = await request(`/api/projects/${id}/bundle`, {
    headers: { Cookie: linked.cookie },
  });
  assert.equal(downloaded.headers.get('etag'), '"1"');
  assert.deepEqual(await downloaded.json(), bundle);

  const conflict = await request(`/api/projects/${id}`, {
    method: 'PUT',
    headers: {
      Cookie: owner.cookie,
      'Content-Type': 'application/vnd.kerfloom.project-bundle+json',
      'If-Match': '"0"',
    },
    body: JSON.stringify(bundle),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).currentRevision, 1);

  const removed = await request(`/api/projects/${id}`, {
    method: 'DELETE',
    headers: { Cookie: linked.cookie, 'If-Match': '"1"' },
  });
  assert.equal(removed.status, 200);
  const tombstone = (await (await request('/api/projects', {
    headers: { Cookie: owner.cookie },
  })).json()).projects[0];
  assert.equal(tombstone.id, id);
  assert.equal(tombstone.revision, 2);
  assert.equal(typeof tombstone.deletedAt, 'string');
  assert.equal(tombstone.sizeBytes, 0);
  assert.equal((await request(`/api/projects/${id}/bundle`, {
    headers: { Cookie: owner.cookie },
  })).status, 404);
  assert.equal(fs.readdirSync(projectDirectory).length, 0);
});

test('pwa-kit worker is content-stamped and the escape hatch has hard headers', async () => {
  const worker = await request('/sw.js');
  assert.equal(worker.status, 200);
  assert.doesNotMatch(await worker.text(), /__BUILD_VERSION__/);
  assert.match(worker.headers.get('cache-control'), /no-store/);

  const bust = await request('/bust');
  assert.equal(bust.status, 200);
  assert.equal(bust.headers.get('clear-site-data'), '"cache"');
  assert.match(bust.headers.get('cache-control'), /no-store/);
});

test('deployment files preserve the rootless and proxy boundaries', () => {
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const container = fs.readFileSync(path.join(projectRoot, 'deploy/Containerfile'), 'utf8');
  const quadlet = fs.readFileSync(path.join(projectRoot, 'deploy/quadlet/stencil-cnc.container'), 'utf8');
  const caddy = fs.readFileSync(path.join(projectRoot, 'deploy/Caddyfile.snippet'), 'utf8');
  const example = fs.readFileSync(path.join(projectRoot, 'site.env.example'), 'utf8');

  assert.match(container, /USER 10010:10010/);
  assert.match(quadlet, /PublishPort=127\.0\.0\.1:8101:3000/);
  assert.match(quadlet, /NoNewPrivileges=true/);
  assert.match(quadlet, /DropCapability=all/i);
  assert.match(caddy, /stencil-cnc\.zandaulion\.com/);
  assert.match(caddy, /respond @stencil_admin 404/);
  assert.match(caddy, /header_up -X-Admin-Token/);
  assert.match(caddy, /header_up X-Admin-Token \{\$STENCIL_CNC_ADMIN_TOKEN\}/);
  assert.match(example, /^ADMIN_TOKEN=$/m, 'the repository contains no admin secret');
});
