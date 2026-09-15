const DB_NAME = 'stencil-cnc';
const DB_VERSION = 1;
const PROJECT_STORE = 'projects';
const META_STORE = 'meta';

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

export async function saveProject(record) {
  const now = new Date().toISOString();
  const value = {
    ...record,
    id: record.id || crypto.randomUUID(),
    createdAt: record.createdAt || now,
    updatedAt: now
  };
  await transaction(PROJECT_STORE, 'readwrite', (store) => requestResult(store.put(value)));
  await transaction(META_STORE, 'readwrite', (store) => requestResult(store.put({
    key: 'lastProjectId',
    value: value.id
  })));
  return value;
}

export async function loadProject(id) {
  if (!id) return null;
  return transaction(PROJECT_STORE, 'readonly', (store) => requestResult(store.get(id)));
}

export async function loadLastProject() {
  const meta = await transaction(META_STORE, 'readonly', (store) => requestResult(store.get('lastProjectId')));
  return meta?.value ? loadProject(meta.value) : null;
}

export async function clearLastProject() {
  await transaction(META_STORE, 'readwrite', (store) => requestResult(store.delete('lastProjectId')));
}

export async function listProjects() {
  const rows = await transaction(PROJECT_STORE, 'readonly', (store) => requestResult(store.getAll()));
  return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function deleteProject(id) {
  await transaction(PROJECT_STORE, 'readwrite', (store) => requestResult(store.delete(id)));
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
