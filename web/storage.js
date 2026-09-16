const DB_NAME = 'stencil-cnc';
const DB_VERSION = 4;
const PROJECT_STORE = 'projects';
const META_STORE = 'meta';
const CHECKPOINT_STORE = 'checkpoints';
const ARTIFACT_STORE = 'artifacts';
const SYNC_STORE = 'projectSync';
const CHECKPOINT_LIMIT = 10;
const ARTIFACT_LIMIT = 30;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
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

async function transaction(storeName, mode, operation) {
  const db = await openDatabase();
  try {
    const tx = db.transaction(storeName, mode);
    const result = await operation(tx.objectStore(storeName));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'));
    });
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

export async function putProjectSync(operation) {
  if (!operation?.projectId || !['put', 'delete'].includes(operation.kind)) {
    throw new TypeError('A valid project sync operation is required');
  }
  const value = {
    ...operation,
    projectId: String(operation.projectId),
    queuedAt: operation.queuedAt || new Date().toISOString(),
  };
  await transaction(SYNC_STORE, 'readwrite', (store) => requestResult(store.put(value)));
  return value;
}

export async function loadProjectSync(projectId) {
  if (!projectId) return null;
  return transaction(SYNC_STORE, 'readonly', (store) => requestResult(store.get(projectId)));
}

export async function listProjectSync() {
  const rows = await transaction(SYNC_STORE, 'readonly', (store) => requestResult(store.getAll()));
  return rows.sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
}

export async function deleteProjectSync(projectId) {
  if (!projectId) return;
  await transaction(SYNC_STORE, 'readwrite', (store) => requestResult(store.delete(projectId)));
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
  const value = {
    id: crypto.randomUUID(),
    projectId,
    label: String(checkpoint?.label || 'Imported recovery point').slice(0, 120),
    createdAt: typeof checkpoint?.createdAt === 'string'
      ? checkpoint.createdAt
      : new Date().toISOString(),
    project: checkpoint?.project,
  };
  if (!value.project || typeof value.project !== 'object') {
    throw new TypeError('An editable checkpoint project is required');
  }
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
  if (!projectId || !(artifact?.blob instanceof Blob)) {
    throw new TypeError('A saved project and Blob artefact are required');
  }
  const value = {
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
