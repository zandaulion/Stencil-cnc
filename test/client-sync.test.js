import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

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
    };
    export const storageWorkspaceId = () => state.workspaceId;
    export const listArtifacts = async () => [];
    export const listCheckpoints = async () => [];
    export const clearProjectAssets = async () => {};
    export const importArtifact = async () => {};
    export const importCheckpoint = async () => {};
    export const loadProject = async (id) => state.projects.get(id) || null;
    export const cacheProject = async (record) => (state.projects.set(record.id, record), record);
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
      if (local) state.projects.set(id, {
        ...local, serverRevision: Number(metadata.revision) || 0, serverSha256: metadata.sha256 || null,
      });
      const pending = state.sync.get(id);
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
  const [sync, storage] = await Promise.all([
    import(`${pathToFileURL(syncPath).href}?test=${crypto.randomUUID()}`),
    import(pathToFileURL(storagePath).href),
  ]);
  return { directory, sync, storage };
}

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
    if (requestCount === 1) {
      return new Response(JSON.stringify({
        error: 'This project changed on another device.',
        code: 'revision_conflict',
        currentRevision: 2,
      }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }
    throw new TypeError('offline');
  };

  try {
    const record = { id: 'project-1', name: 'Portrait', serverRevision: 1 };
    storage.state.projects.set(record.id, record);
    const result = await sync.syncProject(record);

    assert.equal(result.status, 'conflict-queued');
    assert.notEqual(result.projectId, record.id);
    assert.match(result.message, /waiting for the server/i);
    assert.equal(storage.state.sync.get(result.projectId)?.kind, 'put');
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
