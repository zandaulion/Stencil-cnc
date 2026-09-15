const DB_NAME = 'stencil-cnc';
const DB_VERSION = 2;
const PROJECT_STORE = 'projects';
const META_STORE = 'meta';
const CHECKPOINT_STORE = 'checkpoints';
const CHECKPOINT_LIMIT = 10;

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
  const meta = await transaction(META_STORE, 'readonly', (store) => requestResult(store.get('lastProjectId')));
  if (meta?.value === id) await clearLastProject();
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
