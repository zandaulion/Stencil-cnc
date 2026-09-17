import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function response(project) {
  return new Response(JSON.stringify({ project }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function syncHarness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kerfloom-client-sync-'));
  const corePath = path.join(directory, 'core.mjs');
  const storagePath = path.join(directory, 'storage.mjs');
  const syncPath = path.join(directory, 'project-sync.mjs');
  fs.writeFileSync(corePath, `
    export const serializeProject = (record) => JSON.stringify(record);
    export const deserializeProject = (value) => JSON.parse(value);
  `);
  fs.writeFileSync(storagePath, `
    export const state = {
      workspaceId: 'workspace-a', projects: new Map(), sync: new Map(), sequence: 0,
      checkpoints: new Map(), artifacts: new Map(), replaceError: null,
    };
    export const storageWorkspaceId = () => state.workspaceId;
    export const listArtifacts = async (id) => state.artifacts.get(id) || [];
    export const listCheckpoints = async (id) => state.checkpoints.get(id) || [];
    export const loadProject = async (id) => state.projects.get(id) || null;
    export const cacheProject = async (record) => (state.projects.set(record.id, record), record);
    export const replaceProjectCache = async (record, { checkpoints = [], artifacts = [] } = {}) => {
      if (state.replaceError) throw state.replaceError;
      state.projects.set(record.id, record);
      state.checkpoints.set(record.id, checkpoints);
      state.artifacts.set(record.id, artifacts);
      return record;
    };
    export const deleteProject = async (id) => state.projects.delete(id);
    export const listProjects = async ({ trashed = false } = {}) =>
      [...state.projects.values()].filter((row) => Boolean(row.trashedAt) === trashed);
    export const putProjectSync = async (operation) => {
      const value = {
        ...operation,
        workspaceId: operation.workspaceId || state.workspaceId,
        operationId: operation.operationId || 'operation-' + (++state.sequence),
      };
      state.sync.set(value.projectId, value);
      return value;
    };
    export const replaceProjectSyncOperation = async (projectId, operationId, replacement) => {
      const current = state.sync.get(projectId);
      if (!current || current.operationId !== operationId) {
        return { replaced: false, operation: state.sync.get(replacement.projectId) || null };
      }
      state.sync.delete(projectId);
      const value = {
        ...replacement,
        workspaceId: replacement.workspaceId || state.workspaceId,
        operationId: replacement.operationId || 'operation-' + (++state.sequence),
      };
      state.sync.set(value.projectId, value);
      return { replaced: true, operation: value };
    };
    export const loadProjectSync = async (id) => state.sync.get(id) || null;
    export const listProjectSync = async () => [...state.sync.values()];
    export const deleteProjectSync = async (id, operationId = null) => {
      const current = state.sync.get(id);
      if (operationId && current?.operationId !== operationId) return false;
      state.sync.delete(id);
      return true;
    };
    export const acknowledgeProjectSync = async (id, operationId, metadata) => {
      const local = state.projects.get(id);
      const pending = state.sync.get(id);
      const exact = pending?.operationId === operationId;
      const acknowledgesCurrentChange = exact && (
        !pending?.localChangeId || pending.localChangeId === local?.localChangeId
      );
      if (local) state.projects.set(id, {
        ...local,
        serverRevision: Number(metadata.revision) || 0,
        serverSha256: metadata.sha256 || null,
        localSyncPending: acknowledgesCurrentChange
          ? false
          : Boolean(local.localSyncPending || (pending && !exact)),
      });
      if (pending?.operationId === operationId) {
        state.sync.delete(id);
        return { exact: true, superseded: false, project: state.projects.get(id), pending: null };
      }
      if (pending) {
        const rebased = { ...pending, expectedRevision: Number(metadata.revision) || 0 };
        state.sync.set(id, rebased);
        return { exact: false, superseded: true, project: state.projects.get(id), pending: rebased };
      }
      return { exact: false, superseded: false, project: state.projects.get(id), pending: null };
    };
  `);
  const source = fs.readFileSync(path.join(projectRoot, 'web/project-sync.js'), 'utf8')
    .replace("from '/core/index.js'", `from '${pathToFileURL(corePath).href}'`)
    .replace("from '/storage.js'", `from '${pathToFileURL(storagePath).href}'`);
  fs.writeFileSync(syncPath, source);
  const syncUrl = pathToFileURL(syncPath).href;
  const openTab = () => import(`${syncUrl}?test=${crypto.randomUUID()}`);
  const [sync, storage] = await Promise.all([
    openTab(),
    import(pathToFileURL(storagePath).href),
  ]);
  return { directory, openTab, sync, storage };
}

function lockManager() {
  const pending = new Map();
  return {
    request(name, callback) {
      const previous = pending.get(name) || Promise.resolve();
      const run = previous.catch(() => {}).then(callback);
      pending.set(name, run);
      return run.finally(() => {
        if (pending.get(name) === run) pending.delete(name);
      });
    },
  };
}

test('large project uploads are compressed without changing their canonical bundle', async () => {
  const { directory, sync } = await syncHarness();
  try {
    const payload = JSON.stringify({
      schema: sync.PROJECT_BUNDLE_SCHEMA,
      project: { id: 'project-1', mask: '00110011'.repeat(600_000) },
    });
    const upload = await sync.prepareProjectUpload(payload, { compress: true });
    assert.equal(upload.contentEncoding, 'gzip');
    assert.ok(upload.uploadBytes < upload.uncompressedBytes / 20);
    assert.equal(gunzipSync(Buffer.from(await upload.body.arrayBuffer())).toString(), payload);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('pending project count includes durable local markers and deduplicates queued operations', async () => {
  const { directory, sync, storage } = await syncHarness();
  try {
    storage.state.projects.set('project-1', {
      id: 'project-1', serverRevision: 3, localSyncPending: true,
    });
    storage.state.projects.set('project-2', {
      id: 'project-2', serverRevision: 0, localSyncPending: false,
    });
    storage.state.sync.set('project-1', {
      projectId: 'project-1', kind: 'put', operationId: 'operation-1',
    });
    assert.equal(await sync.pendingProjectSyncCount(), 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an older upload acknowledgement cannot remove a newer queued edit', async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;
  const { directory, sync, storage } = await syncHarness();
  const requests = [];
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });
  globalThis.fetch = async (_url, options) => {
    requests.push(options);
    if (requests.length === 1) {
      markFirstStarted();
      return new Promise((resolve) => { releaseFirst = () => resolve(response({ revision: 1, sha256: 'a' })); });
    }
    return response({ revision: 2, sha256: 'b' });
  };

  try {
    const firstRecord = { id: 'project-1', name: 'A', serverRevision: 0 };
    storage.state.projects.set(firstRecord.id, firstRecord);
    const first = sync.syncProject(firstRecord);
    await firstStarted;

    const secondRecord = { ...firstRecord, name: 'B' };
    storage.state.projects.set(secondRecord.id, secondRecord);
    const second = sync.syncProject(secondRecord);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(storage.state.sync.get('project-1').operationId, 'operation-2');

    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.status, 'superseded');
    assert.equal(secondResult.status, 'synced');
    assert.equal(requests.length, 2);
    assert.equal(new Headers(requests[0].headers).get('If-Match'), '"0"');
    assert.equal(new Headers(requests[1].headers).get('If-Match'), '"1"');
    assert.equal(JSON.parse(requests[1].body).project.name, 'B');
    assert.equal(storage.state.sync.size, 0);
    assert.equal(storage.state.projects.get('project-1').serverRevision, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an upload acknowledgement cannot clear a newer locally cached edit that is not queued yet', async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;
  const { directory, sync, storage } = await syncHarness();
  let releaseUpload;
  let markUploadStarted;
  const uploadStarted = new Promise((resolve) => { markUploadStarted = resolve; });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });
  globalThis.fetch = async () => {
    markUploadStarted();
    return new Promise((resolve) => {
      releaseUpload = () => resolve(response({ revision: 2, sha256: 'first' }));
    });
  };

  try {
    const first = {
      id: 'project-1', name: 'First edit', serverRevision: 1,
      localChangeId: 'change-a', localSyncPending: true,
    };
    storage.state.projects.set(first.id, first);
    const uploading = sync.syncProject(first);
    await uploadStarted;
    storage.state.projects.set(first.id, {
      ...first,
      name: 'Newer local edit',
      localChangeId: 'change-b',
      localSyncPending: true,
    });

    releaseUpload();
    assert.equal((await uploading).status, 'synced');
    assert.equal(storage.state.sync.has(first.id), false);
    assert.equal(storage.state.projects.get(first.id).name, 'Newer local edit');
    assert.equal(storage.state.projects.get(first.id).localSyncPending, true);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('independent tabs serialize writes through a shared Web Lock', async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;
  const { directory, openTab, sync, storage } = await syncHarness();
  const secondTab = await openTab();
  const requests = [];
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true, locks: lockManager() },
  });
  globalThis.fetch = async (_url, options) => {
    requests.push(options);
    if (requests.length === 1) {
      markFirstStarted();
      return new Promise((resolve) => { releaseFirst = () => resolve(response({ revision: 1, sha256: 'a' })); });
    }
    return response({ revision: 2, sha256: 'b' });
  };

  try {
    const firstRecord = { id: 'project-1', name: 'Tab A', serverRevision: 0 };
    storage.state.projects.set(firstRecord.id, firstRecord);
    const first = sync.syncProject(firstRecord);
    await firstStarted;

    const secondRecord = { ...firstRecord, name: 'Tab B' };
    storage.state.projects.set(secondRecord.id, secondRecord);
    const second = secondTab.syncProject(secondRecord);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(requests.length, 1, 'the second tab must wait for the first tab\'s lock');

    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.status, 'superseded');
    assert.equal(secondResult.status, 'synced');
    assert.equal(new Headers(requests[1].headers).get('If-Match'), '"1"');
    assert.equal(JSON.parse(requests[1].body).project.name, 'Tab B');
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a two-tab edit racing a permanent delete is preserved under a new id', async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;
  const { directory, openTab, sync, storage } = await syncHarness();
  const secondTab = await openTab();
  let releaseDelete;
  let markDeleteStarted;
  let requestCount = 0;
  const deleteStarted = new Promise((resolve) => { markDeleteStarted = resolve; });
  const tombstone = {
    id: 'project-1', name: 'Portrait', revision: 2, sha256: '',
    deletedAt: '2026-09-16T11:00:00.000Z',
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true, locks: lockManager() },
  });
  globalThis.fetch = async (_url, options) => {
    requestCount += 1;
    if (requestCount === 1) {
      assert.equal(options.method, 'DELETE');
      markDeleteStarted();
      return new Promise((resolve) => {
        releaseDelete = () => resolve(new Response(JSON.stringify({
          id: tombstone.id,
          deleted: true,
          revision: tombstone.revision,
          deletedAt: tombstone.deletedAt,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      });
    }
    if (requestCount === 2) {
      assert.equal(options.method, 'PUT');
      assert.equal(new Headers(options.headers).get('If-Match'), '"2"');
      return new Response(JSON.stringify({
        error: 'This project was permanently deleted.',
        code: 'project_deleted',
        currentRevision: 2,
        project: tombstone,
      }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }
    const replacementId = JSON.parse(options.body).project.id;
    return response({ id: replacementId, revision: 1, sha256: 'replacement' });
  };

  try {
    const record = { id: 'project-1', name: 'Portrait', serverRevision: 1 };
    storage.state.projects.set(record.id, record);
    const deleting = sync.deleteServerProject(record);
    await deleteStarted;

    const edited = { ...record, name: 'Portrait edited in tab B' };
    storage.state.projects.set(edited.id, edited);
    const saving = secondTab.syncProject(edited);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(requestCount, 1);

    releaseDelete();
    const [deleteResult, saveResult] = await Promise.all([deleting, saving]);
    assert.equal(deleteResult.status, 'superseded');
    assert.equal(saveResult.status, 'conflict');
    assert.notEqual(saveResult.projectId, record.id);
    assert.equal(storage.state.projects.has(record.id), false);
    assert.equal(storage.state.projects.get(saveResult.projectId).serverRevision, 1);
    assert.equal(storage.state.sync.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a lost upload response is reconciled by content instead of creating a conflict copy', async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;
  const { directory, sync, storage } = await syncHarness();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });
  let committedPayload = null;
  let committedSha256 = null;
  let requestCount = 0;
  globalThis.fetch = async (url, options = {}) => {
    requestCount += 1;
    if (requestCount === 1) {
      committedPayload = options.body;
      committedSha256 = createHash('sha256').update(committedPayload).digest('hex');
      throw new TypeError('response lost after commit');
    }
    if (url === '/api/projects') {
      return new Response(JSON.stringify({
        projects: [{ id: 'project-1', name: 'Portrait', revision: 1, sha256: committedSha256 }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    assert.equal(options.body, committedPayload);
    return new Response(JSON.stringify({
      error: 'This project changed on another device.',
      code: 'revision_conflict',
      currentRevision: 1,
      project: { id: 'project-1', name: 'Portrait', revision: 1, sha256: committedSha256 },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const record = { id: 'project-1', name: 'Portrait', serverRevision: 0 };
    storage.state.projects.set(record.id, record);
    assert.equal((await sync.syncProject(record)).status, 'queued');
    assert.ok(storage.state.sync.has(record.id));

    const result = await sync.synchronizeProjectLibrary();
    assert.equal(result.status, 'synced');
    assert.equal(result.conflicts, 0);
    assert.equal(storage.state.projects.size, 1);
    assert.equal(storage.state.projects.get(record.id).serverRevision, 1);
    assert.equal(storage.state.sync.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a stale-tab workspace rejection leaves its original operation queued', async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;
  const { directory, sync, storage } = await syncHarness();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });
  globalThis.fetch = async (_url, options) => {
    assert.equal(new Headers(options.headers).get('X-Kerfloom-Workspace'), 'workspace-a');
    return new Response(JSON.stringify({
      error: 'The linked workspace changed. Reload before synchronizing projects.',
      code: 'workspace_changed',
    }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const record = { id: 'project-1', name: 'Workspace A portrait', serverRevision: 0 };
    storage.state.projects.set(record.id, record);
    await assert.rejects(() => sync.syncProject(record), (error) => error.code === 'workspace_changed');

    assert.equal(storage.state.projects.size, 1);
    assert.equal(storage.state.projects.get(record.id).name, record.name);
    assert.equal(storage.state.sync.get(record.id)?.kind, 'put');
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an offline edit of a permanently deleted project becomes a new conflict copy', async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;
  const { directory, sync, storage } = await syncHarness();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });
  let requestCount = 0;
  globalThis.fetch = async (url, options = {}) => {
    requestCount += 1;
    if (url === '/api/projects') {
      return new Response(JSON.stringify({
        projects: [{
          id: 'project-1', name: 'Deleted portrait', revision: 2,
          sha256: '', deletedAt: '2026-09-16T10:00:00.000Z',
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === '/api/projects/project-1') {
      return new Response(JSON.stringify({
        error: 'This project changed on another device.',
        code: 'revision_conflict',
        currentRevision: 2,
        project: {
          id: 'project-1', name: 'Deleted portrait', revision: 2,
          sha256: '', deletedAt: '2026-09-16T10:00:00.000Z',
        },
      }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }
    const replacementId = JSON.parse(options.body).project.id;
    return response({ id: replacementId, revision: 1, sha256: 'replacement' });
  };

  try {
    const record = { id: 'project-1', name: 'Offline portrait edit', serverRevision: 1 };
    storage.state.projects.set(record.id, record);
    await sync.queueProjectSync(record);

    const result = await sync.synchronizeProjectLibrary();
    assert.equal(result.conflicts, 1);
    assert.equal(result.remapped.length, 1);
    assert.equal(result.remapped[0].fromProjectId, record.id);
    assert.equal(storage.state.projects.has(record.id), false);
    assert.equal(storage.state.projects.size, 1);
    const [copy] = storage.state.projects.values();
    assert.notEqual(copy.id, record.id);
    assert.equal(result.remapped[0].toProjectId, copy.id);
    assert.match(copy.name, /conflict/i);
    assert.equal(copy.serverRevision, 1);
    assert.equal(storage.state.sync.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a lost delete response is acknowledged by the server tombstone', async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;
  const { directory, sync, storage } = await syncHarness();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });
  let requestCount = 0;
  globalThis.fetch = async (url) => {
    requestCount += 1;
    if (requestCount === 1) throw new TypeError('response lost after delete commit');
    assert.equal(url, '/api/projects');
    return new Response(JSON.stringify({
      projects: [{
        id: 'project-1', name: 'Portrait', revision: 2, sha256: '',
        deletedAt: '2026-09-16T12:00:00.000Z',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const record = { id: 'project-1', name: 'Portrait', serverRevision: 1 };
    storage.state.projects.set(record.id, record);
    assert.equal((await sync.deleteServerProject(record)).status, 'queued');
    storage.state.projects.delete(record.id);

    const result = await sync.synchronizeProjectLibrary();
    assert.deepEqual(result.deleted, [record.id]);
    assert.equal(storage.state.projects.has(record.id), false);
    assert.equal(storage.state.sync.size, 0);
    assert.equal(requestCount, 2, 'the tombstone confirms deletion without another DELETE');
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a downloaded bundle records the response revision instead of stale list metadata', async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;
  const { directory, sync, storage } = await syncHarness();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });
  globalThis.fetch = async (url) => {
    if (url === '/api/projects') {
      return new Response(JSON.stringify({
        projects: [{ id: 'project-1', name: 'Old list name', revision: 1, sha256: 'old' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const bundle = {
      schema: sync.PROJECT_BUNDLE_SCHEMA,
      version: sync.PROJECT_BUNDLE_VERSION,
      clientProjectId: 'project-1',
      project: { id: 'project-1', name: 'New bundle name' },
      source: null,
      checkpoints: [],
      artifacts: [],
    };
    return new Response(JSON.stringify(bundle), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ETag: '"2"' },
    });
  };

  try {
    await sync.synchronizeProjectLibrary();
    const cached = storage.state.projects.get('project-1');
    assert.equal(cached.name, 'New bundle name');
    assert.equal(cached.serverRevision, 2);
    assert.equal(cached.serverSha256, null);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('startup recovers a locally saved edit whose upload was never queued', async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;
  const { directory, sync, storage } = await syncHarness();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });
  const local = {
    id: 'project-1',
    name: 'Backgrounded edit',
    serverRevision: 1,
    localChangeId: 'change-after-background',
    localSyncPending: true,
  };
  storage.state.projects.set(local.id, local);
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === '/api/projects') {
      return new Response(JSON.stringify({
        projects: [{ id: local.id, name: 'Older server copy', revision: 1, sha256: 'old' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return response({ revision: 2, sha256: 'recovered' });
  };

  try {
    const result = await sync.synchronizeProjectLibrary();
    assert.equal(result.status, 'synced');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].options.method, 'PUT');
    assert.equal(JSON.parse(requests[1].options.body).project.name, local.name);
    assert.equal(storage.state.projects.get(local.id).localSyncPending, false);
    assert.equal(storage.state.projects.get(local.id).serverRevision, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a damaged queued payload is rebuilt from the complete local project', async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;
  const { directory, sync, storage } = await syncHarness();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });
  const local = {
    id: 'project-1', name: 'Recoverable local edit', serverRevision: 1,
    localChangeId: 'recoverable-change', localSyncPending: true,
  };
  storage.state.projects.set(local.id, local);
  storage.state.sync.set(local.id, {
    projectId: local.id,
    kind: 'put',
    expectedRevision: 1,
    payload: '{damaged',
    localChangeId: local.localChangeId,
    workspaceId: storage.state.workspaceId,
    operationId: 'damaged-operation',
    queuedAt: '2026-09-16T12:00:00.000Z',
  });
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/projects') {
      return new Response(JSON.stringify({
        projects: [{ id: local.id, name: 'Older server copy', revision: 1, sha256: 'old' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    assert.equal(JSON.parse(options.body).project.name, local.name);
    return response({ id: local.id, revision: 2, sha256: 'repaired' });
  };

  try {
    const result = await sync.synchronizeProjectLibrary();
    assert.equal(result.status, 'synced');
    assert.equal(result.failures.length, 0);
    assert.equal(storage.state.projects.get(local.id).serverRevision, 2);
    assert.equal(storage.state.projects.get(local.id).localSyncPending, false);
    assert.equal(storage.state.sync.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a malformed downloaded asset cannot replace the last complete local revision', async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;
  const { directory, sync, storage } = await syncHarness();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });
  const oldProject = { id: 'project-1', name: 'Complete local copy', serverRevision: 1 };
  const oldCheckpoint = { id: 'checkpoint-old', projectId: oldProject.id };
  const oldArtifact = { id: 'artifact-old', projectId: oldProject.id, blob: new Blob(['old']) };
  storage.state.projects.set(oldProject.id, oldProject);
  storage.state.projects.set('project-2', {
    id: 'project-2', name: 'Healthy queued edit', serverRevision: 0,
    localSyncPending: true, localChangeId: 'healthy-change',
  });
  storage.state.checkpoints.set(oldProject.id, [oldCheckpoint]);
  storage.state.artifacts.set(oldProject.id, [oldArtifact]);
  globalThis.fetch = async (url) => {
    if (url === '/api/projects') {
      return new Response(JSON.stringify({
        projects: [{ id: oldProject.id, name: 'Remote copy', revision: 2, sha256: 'new' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === '/api/projects/project-2') {
      return response({ id: 'project-2', revision: 1, sha256: 'healthy' });
    }
    return new Response(JSON.stringify({
      schema: sync.PROJECT_BUNDLE_SCHEMA,
      version: sync.PROJECT_BUNDLE_VERSION,
      clientProjectId: oldProject.id,
      project: { id: oldProject.id, name: 'Incomplete remote copy' },
      source: null,
      checkpoints: [],
      artifacts: [{ filename: 'broken.png', dataUrl: 'not-a-data-url' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ETag: '"2"' },
    });
  };

  try {
    const result = await sync.synchronizeProjectLibrary();
    assert.equal(result.status, 'partial');
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].projectId, oldProject.id);
    assert.match(result.failures[0].message, /Invalid project artefact/);
    assert.strictEqual(storage.state.projects.get(oldProject.id), oldProject);
    assert.deepEqual(storage.state.checkpoints.get(oldProject.id), [oldCheckpoint]);
    assert.deepEqual(storage.state.artifacts.get(oldProject.id), [oldArtifact]);
    assert.equal(storage.state.projects.get('project-2').serverRevision, 1);
    assert.equal(storage.state.projects.get('project-2').localSyncPending, false);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a failed atomic cache replacement retains the prior revision and queued edit', async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;
  const { directory, sync, storage } = await syncHarness();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });
  const oldProject = { id: 'project-1', name: 'Offline edit', serverRevision: 1 };
  const queued = { projectId: 'project-2', kind: 'put', operationId: 'operation-local' };
  storage.state.projects.set(oldProject.id, oldProject);
  storage.state.sync.set(queued.projectId, queued);
  storage.state.replaceError = new DOMException('Storage quota exceeded', 'QuotaExceededError');
  globalThis.fetch = async (url) => {
    if (url === '/api/projects') {
      return new Response(JSON.stringify({
        projects: [{ id: oldProject.id, name: 'Remote copy', revision: 2, sha256: 'new' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      schema: sync.PROJECT_BUNDLE_SCHEMA,
      version: sync.PROJECT_BUNDLE_VERSION,
      clientProjectId: oldProject.id,
      project: { id: oldProject.id, name: 'Complete remote copy' },
      source: null,
      checkpoints: [],
      artifacts: [{
        filename: 'preview.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,bmV3',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ETag: '"2"' },
    });
  };

  try {
    const result = await sync.synchronizeProjectLibrary();
    assert.equal(result.status, 'partial');
    assert.ok(result.failures.some((failure) => failure.error?.name === 'QuotaExceededError'));
    assert.strictEqual(storage.state.projects.get(oldProject.id), oldProject);
    assert.strictEqual(storage.state.sync.get(queued.projectId), queued);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a conflict copy that cannot upload remains queued instead of claiming server save', async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;
  const { directory, sync, storage } = await syncHarness();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1 || requestCount === 3) {
      return new Response(JSON.stringify({
        error: 'This project changed on another device.',
        code: 'revision_conflict',
        currentRevision: 2,
      }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }
    if (requestCount === 2) throw new TypeError('offline');
    const pending = [...storage.state.sync.values()].find((operation) => operation.projectId !== 'project-1');
    return response({ id: pending.projectId, revision: 1, sha256: 'replacement' });
  };

  try {
    const record = { id: 'project-1', name: 'Portrait', serverRevision: 1 };
    storage.state.projects.set(record.id, record);
    const originalOperation = await sync.queueProjectSync(record);
    const result = await sync.flushQueuedProjectSync(record.id);

    assert.equal(result.status, 'conflict-queued');
    assert.notEqual(result.projectId, record.id);
    assert.match(result.message, /waiting for the server/i);
    const conflict = storage.state.projects.get(result.projectId);
    const pending = storage.state.sync.get(result.projectId);
    assert.equal(pending?.kind, 'put');
    assert.equal(conflict.localSyncPending, true);
    assert.equal(pending.localChangeId, conflict.localChangeId);

    // Simulate a stale tab retrying the same original operation after the
    // conflict copy was already created. It must converge on the same ID.
    storage.state.sync.set(originalOperation.projectId, originalOperation);
    const retried = await sync.flushQueuedProjectSync(originalOperation.projectId);
    assert.equal(retried.status, 'conflict');
    assert.equal(retried.projectId, result.projectId);
    assert.equal(
      [...storage.state.projects.keys()].filter((id) => id.startsWith('conflict-')).length,
      1,
    );
    assert.equal(storage.state.projects.get(result.projectId).serverRevision, 1);
    assert.equal(storage.state.sync.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an existing conflict copy rebases in place instead of spawning another project', async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;
  const { directory, sync, storage } = await syncHarness();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });
  let requests = 0;
  globalThis.fetch = async (_url, options = {}) => {
    requests += 1;
    if (requests === 1) {
      assert.equal(options.headers['If-Match'], '"1"');
      return new Response(JSON.stringify({
        error: 'This project changed on another device.',
        code: 'revision_conflict',
        currentRevision: 2,
        project: { id: 'conflict-existing', revision: 2 },
      }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }
    assert.equal(options.headers['If-Match'], '"2"');
    return response({ id: 'conflict-existing', revision: 3, sha256: 'rebased' });
  };

  try {
    const record = {
      id: 'conflict-existing',
      name: 'Portrait (conflict Sep 16, 10:27 PM)',
      serverRevision: 1,
      localSyncPending: true,
      localChangeId: 'conflict-edit',
    };
    storage.state.projects.set(record.id, record);
    await sync.queueProjectSync(record);
    const result = await sync.flushQueuedProjectSync(record.id);

    assert.equal(result.status, 'synced');
    assert.equal(result.projectId, record.id);
    assert.equal(requests, 2);
    assert.deepEqual([...storage.state.projects.keys()], [record.id]);
    assert.equal(storage.state.sync.size, 0);
    assert.equal(storage.state.projects.get(record.id).serverRevision, 3);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('recoverable local drafts cannot enter the server synchronization queue', async () => {
  const { directory, sync } = await syncHarness();
  try {
    await assert.rejects(
      sync.queueProjectSync({ id: 'kerfloom-local-draft', name: 'Draft', localDraft: true }),
      /cannot be added to the server sync queue/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
