import { reconcileProjectAcknowledgement } from '/core/sync-state.js';

const LEGACY_DB_NAME = 'stencil-cnc';
const WORKSPACE_DB_PREFIX = 'stencil-cnc-workspace:';
const DB_VERSION = 4;
const PROJECT_STORE = 'projects';
const META_STORE = 'meta';
const CHECKPOINT_STORE = 'checkpoints';
const ARTIFACT_STORE = 'artifacts';
const SYNC_STORE = 'projectSync';
const CHECKPOINT_LIMIT = 10;
const ARTIFACT_LIMIT = 30;
let activeWorkspaceId = null;

function normalizeWorkspaceId(value) {
  const workspaceId = String(value || '').trim();
  if (workspaceId.length < 8 || workspaceId.length > 200) {
    throw new TypeError('A valid server workspace identifier is required');
  }
  return workspaceId;
}

export function workspaceDatabaseName(workspaceId) {
  return `${WORKSPACE_DB_PREFIX}${encodeURIComponent(normalizeWorkspaceId(workspaceId))}`;
}

export function configureStorageWorkspace(workspaceId) {
  const normalized = normalizeWorkspaceId(workspaceId);
  if (activeWorkspaceId && activeWorkspaceId !== normalized) {
    throw new Error('Changing workspace requires reloading Kerfloom');
  }
  activeWorkspaceId = normalized;
  return activeWorkspaceId;
}

export function storageWorkspaceId() {
  if (!activeWorkspaceId) throw new Error('The browser workspace has not been configured');
  return activeWorkspaceId;
}

function openDatabase(databaseName = workspaceDatabaseName(storageWorkspaceId())) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECT_STORE)) {
        const projects = db.createObjectStore(PROJECT_STORE, { keyPath: 'id' });
        projects.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(CHECKPOINT_STORE)) {
        const checkpoints = db.createObjectStore(CHECKPOINT_STORE, { keyPath: 'id' });
        checkpoints.createIndex('projectId', 'projectId');
        checkpoints.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(ARTIFACT_STORE)) {
        const artifacts = db.createObjectStore(ARTIFACT_STORE, { keyPath: 'id' });
        artifacts.createIndex('projectId', 'projectId');
        artifacts.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(SYNC_STORE)) {
        const sync = db.createObjectStore(SYNC_STORE, { keyPath: 'projectId' });
        sync.createIndex('queuedAt', 'queuedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(storeName, mode, operation, workspaceId = storageWorkspaceId()) {
  const db = await openDatabase(workspaceDatabaseName(workspaceId));
  try {
    const storeNames = Array.isArray(storeName) ? storeName : [storeName];
    const tx = db.transaction(storeNames, mode);
    const completion = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'));
    });
    const stores = Array.isArray(storeName)
      ? Object.fromEntries(storeNames.map((name) => [name, tx.objectStore(name)]))
      : tx.objectStore(storeName);
    let result;
    try {
      result = await operation(stores);
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // A failed IndexedDB request may already have aborted the transaction.
      }
      await completion.catch(() => {});
      throw error;
    }
    await completion;
    return result;
  } finally {
    db.close();
  }
}

export async function saveProject(record, { makeCurrent = true } = {}) {
  const now = new Date().toISOString();
  const value = {
    ...record,
    id: record.id || crypto.randomUUID(),
    createdAt: record.createdAt || now,
    updatedAt: now
  };
  await transaction(PROJECT_STORE, 'readwrite', (store) => requestResult(store.put(value)));
  if (makeCurrent) await setLastProject(value.id);
  return value;
}

/** Update the browser cache without changing the project's canonical timestamps. */
export async function cacheProject(record, { makeCurrent = false } = {}) {
  if (!record?.id) throw new TypeError('A project identifier is required');
  await transaction(PROJECT_STORE, 'readwrite', (store) => requestResult(store.put(record)));
  if (makeCurrent) await setLastProject(record.id);
  return record;
}

export async function setLastProject(id) {
  if (!id) return clearLastProject();
  await transaction(META_STORE, 'readwrite', (store) => requestResult(store.put({
    key: 'lastProjectId',
    value: id,
  })));
}

export async function loadProject(id) {
  if (!id) return null;
  return transaction(PROJECT_STORE, 'readonly', (store) => requestResult(store.get(id)));
}

export async function loadLastProject() {
  const meta = await transaction(META_STORE, 'readonly', (store) => requestResult(store.get('lastProjectId')));
  const project = meta?.value ? await loadProject(meta.value) : null;
  return project?.trashedAt ? null : project;
}

export async function clearLastProject() {
  await transaction(META_STORE, 'readwrite', (store) => requestResult(store.delete('lastProjectId')));
}

export async function listProjects({ trashed = false } = {}) {
  const rows = await transaction(PROJECT_STORE, 'readonly', (store) => requestResult(store.getAll()));
  return rows
    .filter((row) => Boolean(row.trashedAt) === trashed)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function deleteProject(id) {
  await transaction(PROJECT_STORE, 'readwrite', (store) => requestResult(store.delete(id)));
  const checkpoints = await listCheckpoints(id);
  for (const checkpoint of checkpoints) {
    await transaction(CHECKPOINT_STORE, 'readwrite', (store) => requestResult(store.delete(checkpoint.id)));
  }
  const artifacts = await listArtifacts(id);
  for (const artifact of artifacts) {
    await transaction(ARTIFACT_STORE, 'readwrite', (store) => requestResult(store.delete(artifact.id)));
  }
  const meta = await transaction(META_STORE, 'readonly', (store) => requestResult(store.get('lastProjectId')));
  if (meta?.value === id) await clearLastProject();
}

export async function clearProjectAssets(id) {
  const checkpoints = await listCheckpoints(id);
  for (const checkpoint of checkpoints) {
    await transaction(CHECKPOINT_STORE, 'readwrite', (store) => requestResult(store.delete(checkpoint.id)));
  }
  const artifacts = await listArtifacts(id);
  for (const artifact of artifacts) {
    await transaction(ARTIFACT_STORE, 'readwrite', (store) => requestResult(store.delete(artifact.id)));
  }
}

function importedCheckpoint(projectId, checkpoint) {
  const value = {
    id: crypto.randomUUID(),
    projectId,
    label: String(checkpoint?.label || 'Imported recovery point').slice(0, 120),
    createdAt: typeof checkpoint?.createdAt === 'string'
      ? checkpoint.createdAt
      : new Date().toISOString(),
    project: checkpoint?.project,
  };
  if (!value.project || typeof value.project !== 'object' || Array.isArray(value.project)) {
    throw new TypeError('An editable checkpoint project is required');
  }
  return value;
}

function importedArtifact(projectId, artifact) {
  if (!(artifact?.blob instanceof Blob)) {
    throw new TypeError('A saved project and Blob artefact are required');
  }
  return {
    id: crypto.randomUUID(),
    projectId,
    filename: String(artifact.filename || 'shared-artefact').slice(0, 240),
    kind: String(artifact.kind || 'file').slice(0, 30),
    mimeType: String(artifact.mimeType || artifact.blob.type || 'application/octet-stream').slice(0, 120),
    createdAt: typeof artifact.createdAt === 'string'
      ? artifact.createdAt
      : new Date().toISOString(),
    blob: artifact.blob,
  };
}

/**
 * Replace a downloaded project's complete local cache as one IndexedDB commit.
 * Values are normalized before the transaction starts; clone/quota failures
 * abort that transaction so the prior usable revision remains complete.
 */
export async function replaceProjectCache(
  record,
  { checkpoints = [], artifacts = [], makeCurrent = false } = {},
) {
  if (!record?.id) throw new TypeError('A project identifier is required');
  if (!Array.isArray(checkpoints) || !Array.isArray(artifacts)) {
    throw new TypeError('Project checkpoints and artefacts must be arrays');
  }
  const preparedCheckpoints = checkpoints
    .slice(0, CHECKPOINT_LIMIT)
    .map((checkpoint) => importedCheckpoint(record.id, checkpoint));
  const preparedArtifacts = artifacts
    .slice(0, ARTIFACT_LIMIT)
    .map((artifact) => importedArtifact(record.id, artifact));
  const storeNames = [PROJECT_STORE, CHECKPOINT_STORE, ARTIFACT_STORE];
  if (makeCurrent) storeNames.push(META_STORE);

  await transaction(storeNames, 'readwrite', async (stores) => {
    const [checkpointIds, artifactIds] = await Promise.all([
      requestResult(stores[CHECKPOINT_STORE].index('projectId').getAllKeys(record.id)),
      requestResult(stores[ARTIFACT_STORE].index('projectId').getAllKeys(record.id)),
    ]);
    const writes = [];
    const queue = (request) => {
      const pending = requestResult(request);
      // If a later `put` throws synchronously (for example DataCloneError),
      // the outer transaction aborts. Mark already queued request rejections
      // as observed while still allowing Promise.all below to propagate them.
      pending.catch(() => {});
      writes.push(pending);
    };
    queue(stores[PROJECT_STORE].put(record));
    for (const id of checkpointIds) queue(stores[CHECKPOINT_STORE].delete(id));
    for (const id of artifactIds) queue(stores[ARTIFACT_STORE].delete(id));
    for (const checkpoint of preparedCheckpoints) {
      queue(stores[CHECKPOINT_STORE].put(checkpoint));
    }
    for (const artifact of preparedArtifacts) {
      queue(stores[ARTIFACT_STORE].put(artifact));
    }
    if (makeCurrent) {
      queue(stores[META_STORE].put({ key: 'lastProjectId', value: record.id }));
    }
    await Promise.all(writes);
  });
  return record;
}

export async function putProjectSync(operation) {
  if (!operation?.projectId || !['put', 'delete'].includes(operation.kind)) {
    throw new TypeError('A valid project sync operation is required');
  }
  const value = {
    ...operation,
    projectId: String(operation.projectId),
    workspaceId: operation.workspaceId || storageWorkspaceId(),
    operationId: operation.operationId || crypto.randomUUID(),
    queuedAt: operation.queuedAt || new Date().toISOString(),
  };
  if (value.workspaceId !== storageWorkspaceId()) {
    throw new Error('A sync operation cannot cross browser workspaces');
  }
  await transaction(SYNC_STORE, 'readwrite', (store) => requestResult(store.put(value)));
  return value;
}

export async function loadProjectSync(projectId, { workspaceId = storageWorkspaceId() } = {}) {
  if (!projectId) return null;
  return transaction(SYNC_STORE, 'readonly', (store) => requestResult(store.get(projectId)), workspaceId);
}

export async function listProjectSync({ workspaceId = storageWorkspaceId() } = {}) {
  const rows = await transaction(SYNC_STORE, 'readonly', (store) => requestResult(store.getAll()), workspaceId);
  return rows.sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
}

export async function deleteProjectSync(projectId, operationId = null, { workspaceId = storageWorkspaceId() } = {}) {
  if (!projectId) return false;
  return transaction(SYNC_STORE, 'readwrite', async (store) => {
    if (operationId) {
      const current = await requestResult(store.get(projectId));
      if (!current || current.operationId !== operationId) return false;
    }
    await requestResult(store.delete(projectId));
    return true;
  }, workspaceId);
}

/**
 * Commits a server acknowledgement without allowing it to erase a newer
 * queued edit. If another operation replaced the acknowledged one, that
 * operation is rebased onto the returned server revision in the same
 * transaction and remains pending.
 */
export async function acknowledgeProjectSync(
  projectId,
  operationId,
  metadata,
  { workspaceId = storageWorkspaceId() } = {},
) {
  return transaction([PROJECT_STORE, SYNC_STORE], 'readwrite', async (stores) => {
    const [local, pending] = await Promise.all([
      requestResult(stores[PROJECT_STORE].get(projectId)),
      requestResult(stores[SYNC_STORE].get(projectId)),
    ]);
    const revision = Number(metadata?.revision) || 0;
    const project = local ? {
      ...local,
      serverRevision: revision,
      serverSyncedAt: new Date().toISOString(),
      serverSha256: metadata?.sha256 || null,
    } : null;
    if (project) await requestResult(stores[PROJECT_STORE].put(project));

    const reconciliation = reconcileProjectAcknowledgement(pending, operationId, revision);
    const nextPending = reconciliation.pending;
    if (reconciliation.exact) {
      await requestResult(stores[SYNC_STORE].delete(projectId));
    } else if (nextPending) {
      await requestResult(stores[SYNC_STORE].put(nextPending));
    }
    return { ...reconciliation, project };
  }, workspaceId);
}

export async function setStorageMeta(key, value) {
  await transaction(META_STORE, 'readwrite', (store) => requestResult(store.put({ key, value })));
}

export async function loadStorageMeta(key) {
  const row = await transaction(META_STORE, 'readonly', (store) => requestResult(store.get(key)));
  return row?.value;
}

export async function updateProject(id, changes) {
  const current = await loadProject(id);
  if (!current) throw new RangeError('Project not found');
  const value = { ...current, ...changes, id, updatedAt: new Date().toISOString() };
  await transaction(PROJECT_STORE, 'readwrite', (store) => requestResult(store.put(value)));
  return value;
}

export async function trashProject(id) {
  const value = await updateProject(id, { trashedAt: new Date().toISOString() });
  const meta = await transaction(META_STORE, 'readonly', (store) => requestResult(store.get('lastProjectId')));
  if (meta?.value === id) await clearLastProject();
  return value;
}

export async function restoreProject(id) {
  return updateProject(id, { trashedAt: null });
}

export async function saveCheckpoint(project, label) {
  if (!project?.id) throw new TypeError('A saved project is required for a checkpoint');
  const { localSource: _localSource, ...portableProject } = project;
  const checkpoint = {
    id: crypto.randomUUID(),
    projectId: project.id,
    label: String(label || 'Automatic checkpoint'),
    createdAt: new Date().toISOString(),
    project: portableProject,
  };
  await transaction(CHECKPOINT_STORE, 'readwrite', (store) => requestResult(store.put(checkpoint)));
  const checkpoints = await listCheckpoints(project.id);
  for (const stale of checkpoints.slice(CHECKPOINT_LIMIT)) {
    await transaction(CHECKPOINT_STORE, 'readwrite', (store) => requestResult(store.delete(stale.id)));
  }
  return checkpoint;
}

export async function listCheckpoints(projectId) {
  if (!projectId) return [];
  const rows = await transaction(CHECKPOINT_STORE, 'readonly', (store) => (
    requestResult(store.index('projectId').getAll(projectId))
  ));
  return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function importCheckpoint(projectId, checkpoint) {
  const value = importedCheckpoint(projectId, checkpoint);
  await transaction(CHECKPOINT_STORE, 'readwrite', (store) => requestResult(store.put(value)));
  return value;
}

export async function saveArtifact(projectId, artifact) {
  if (!projectId || !(artifact?.blob instanceof Blob)) {
    throw new TypeError('A saved project and Blob artefact are required');
  }
  const value = {
    id: crypto.randomUUID(),
    projectId,
    filename: String(artifact.filename || 'project-artefact').slice(0, 240),
    kind: String(artifact.kind || 'file').slice(0, 30),
    mimeType: String(artifact.mimeType || artifact.blob.type || 'application/octet-stream').slice(0, 120),
    createdAt: new Date().toISOString(),
    blob: artifact.blob,
  };
  await transaction(ARTIFACT_STORE, 'readwrite', (store) => requestResult(store.put(value)));
  const artifacts = await listArtifacts(projectId);
  for (const stale of artifacts.slice(ARTIFACT_LIMIT)) {
    await transaction(ARTIFACT_STORE, 'readwrite', (store) => requestResult(store.delete(stale.id)));
  }
  return value;
}

export async function importArtifact(projectId, artifact) {
  if (!projectId) {
    throw new TypeError('A saved project and Blob artefact are required');
  }
  const value = importedArtifact(projectId, artifact);
  await transaction(ARTIFACT_STORE, 'readwrite', (store) => requestResult(store.put(value)));
  return value;
}

export async function listArtifacts(projectId) {
  if (!projectId) return [];
  const rows = await transaction(ARTIFACT_STORE, 'readonly', (store) => (
    requestResult(store.index('projectId').getAll(projectId))
  ));
  return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function saveShareSecret(id, token) {
  if (!id || !token) return;
  await transaction(META_STORE, 'readwrite', (store) => requestResult(store.put({
    key: `shareSecret:${id}`,
    value: String(token),
  })));
}

export async function loadShareSecret(id) {
  if (!id) return null;
  const row = await transaction(META_STORE, 'readonly', (store) => (
    requestResult(store.get(`shareSecret:${id}`))
  ));
  return typeof row?.value === 'string' ? row.value : null;
}

export async function deleteShareSecret(id) {
  if (!id) return;
  await transaction(META_STORE, 'readwrite', (store) => requestResult(store.delete(`shareSecret:${id}`)));
}

async function legacyRows(storeName) {
  const db = await openDatabase(LEGACY_DB_NAME);
  try {
    const tx = db.transaction(storeName, 'readonly');
    const rows = await requestResult(tx.objectStore(storeName).getAll());
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Legacy storage transaction aborted'));
    });
    return rows;
  } finally {
    db.close();
  }
}

async function importedLegacyProjectIds() {
  const value = await loadStorageMeta('legacyImportedProjectIds:v1');
  return new Set(Array.isArray(value) ? value.map(String) : []);
}

/** Returns quarantined browser-only projects that have not been imported here. */
export async function legacyProjectSummary() {
  const [projects, imported] = await Promise.all([
    legacyRows(PROJECT_STORE),
    importedLegacyProjectIds(),
  ]);
  const available = projects.filter((project) => !imported.has(String(project.id)));
  return {
    count: available.length,
    names: available.slice(0, 3).map((project) => String(project.name || 'Untitled panel')),
  };
}

/**
 * Copies legacy origin-wide projects into the active workspace as new,
 * unsynced projects. Originals remain untouched so an ambiguous ownership
 * decision is always recoverable.
 */
export async function importLegacyProjects() {
  const [projects, checkpoints, artifacts, imported] = await Promise.all([
    legacyRows(PROJECT_STORE),
    legacyRows(CHECKPOINT_STORE),
    legacyRows(ARTIFACT_STORE),
    importedLegacyProjectIds(),
  ]);
  const importedProjects = [];
  for (const source of projects) {
    const sourceId = String(source.id);
    if (imported.has(sourceId)) continue;
    const id = crypto.randomUUID();
    const project = {
      ...source,
      id,
      name: `${String(source.name || 'Untitled panel')} (legacy import)`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      trashedAt: null,
      serverRevision: 0,
      serverSyncedAt: null,
      serverSha256: null,
    };
    try {
      await cacheProject(project);
      for (const checkpoint of checkpoints.filter((entry) => entry.projectId === source.id)) {
        await importCheckpoint(id, {
          ...checkpoint,
          project: { ...checkpoint.project, id },
        });
      }
      for (const artifact of artifacts.filter((entry) => entry.projectId === source.id)) {
        await importArtifact(id, artifact);
      }
      imported.add(sourceId);
      await setStorageMeta('legacyImportedProjectIds:v1', [...imported]);
      importedProjects.push(project);
    } catch (error) {
      await deleteProject(id).catch(() => {});
      throw error;
    }
  }
  return importedProjects;
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadText(filename, text, type = 'application/json') {
  downloadBlob(filename, new Blob([text], { type }));
}
