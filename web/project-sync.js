import { deserializeProject, serializeProject } from '/core/index.js';
import {
  acknowledgeProjectSync,
  cacheProject,
  deleteProject,
  deleteProjectSync,
  listArtifacts,
  listCheckpoints,
  listProjects,
  listProjectSync,
  loadProject,
  loadProjectSync,
  putProjectSync,
  replaceProjectCache,
  replaceProjectSyncOperation,
  storageWorkspaceId,
} from '/storage.js';

export const PROJECT_BUNDLE_SCHEMA = 'stencil-cnc.share-bundle';
export const PROJECT_BUNDLE_VERSION = 1;
const PROJECT_CONTENT_TYPE = 'application/vnd.kerfloom.project-bundle+json';
const COMPRESSED_UPLOAD_THRESHOLD_BYTES = 256 * 1024;
const localOperationLocks = new Map();

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read a local artefact'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    const error = new TypeError('Invalid project artefact');
    error.code = 'invalid_project_artifact';
    throw error;
  }
  const separator = dataUrl.indexOf(',');
  if (separator < 0 || !dataUrl.slice(0, separator).includes(';base64')) {
    const error = new TypeError('Unsupported project artefact encoding');
    error.code = 'invalid_project_artifact';
    throw error;
  }
  const mimeType = dataUrl.slice(5, separator).split(';')[0] || 'application/octet-stream';
  const decoded = atob(dataUrl.slice(separator + 1));
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

async function responseError(response, fallback) {
  const data = await response.json().catch(() => ({}));
  const error = new Error(data.error || `${fallback} (${response.status})`);
  error.status = response.status;
  error.code = data.code;
  error.details = data;
  return error;
}

function isProjectConflict(error) {
  return error.status === 409 && ['revision_conflict', 'project_deleted'].includes(error.code);
}

function isRetryableProjectError(error) {
  const status = Number(error?.status);
  if ([408, 425, 429].includes(status) || status >= 500 || (status === 400 && !error?.code)) return true;
  if (error?.code) return false;
  return error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error?.name);
}

function projectFailure({ projectId, name, phase, error }) {
  return {
    projectId: projectId || null,
    name: String(name || projectId || 'Unknown project'),
    phase,
    code: error?.code || error?.name || 'sync_failed',
    message: String(error?.message || 'Project synchronization failed'),
    retryable: isRetryableProjectError(error),
    error,
  };
}

async function sha256Text(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function prepareProjectUpload(payload, { compress = typeof window !== 'undefined' } = {}) {
  const source = new Blob([String(payload)], { type: PROJECT_CONTENT_TYPE });
  const uncompressedBytes = source.size;
  if (
    !compress ||
    uncompressedBytes < COMPRESSED_UPLOAD_THRESHOLD_BYTES ||
    typeof CompressionStream !== 'function'
  ) {
    return { body: payload, contentEncoding: null, uncompressedBytes, uploadBytes: uncompressedBytes };
  }

  try {
    const compressed = await new Response(
      source.stream().pipeThrough(new CompressionStream('gzip')),
    ).blob();
    if (compressed.size >= uncompressedBytes) {
      return { body: payload, contentEncoding: null, uncompressedBytes, uploadBytes: uncompressedBytes };
    }
    return {
      body: compressed,
      contentEncoding: 'gzip',
      uncompressedBytes,
      uploadBytes: compressed.size,
    };
  } catch (error) {
    console.warn('Project upload compression failed; using the original bundle.', error);
    return { body: payload, contentEncoding: null, uncompressedBytes, uploadBytes: uncompressedBytes };
  }
}

async function acknowledgeMatchingUpload(operation, details) {
  const metadata = details?.project;
  if (!metadata?.sha256 || metadata.deletedAt || operation.kind !== 'put') return null;
  if (await sha256Text(operation.payload) !== String(metadata.sha256).toLowerCase()) return null;
  const acknowledged = await acknowledgeProjectSync(
    operation.projectId,
    operation.operationId,
    metadata,
    { workspaceId: operation.workspaceId },
  );
  return {
    status: acknowledged.exact ? 'synced' : 'superseded',
    projectId: operation.projectId,
    project: metadata,
    recoveredAcknowledgement: true,
  };
}

async function requestProjects() {
  const response = await fetch('/api/projects', {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'X-Kerfloom-Workspace': storageWorkspaceId(),
    },
  });
  if (!response.ok) throw await responseError(response, 'Could not load server projects');
  return (await response.json()).projects || [];
}

export async function buildProjectBundle(record) {
  if (!record?.id) throw new TypeError('A saved project is required');
  const [checkpoints, artifacts] = await Promise.all([
    listCheckpoints(record.id),
    listArtifacts(record.id),
  ]);
  const sourceBlob = record.localSource instanceof Blob && record.localSource.size
    ? record.localSource
    : null;
  const sourceType = sourceBlob?.type || record.source?.mimeType || 'image/jpeg';
  const typedSource = sourceBlob && sourceBlob.type
    ? sourceBlob
    : sourceBlob ? new Blob([sourceBlob], { type: sourceType }) : null;
  const source = typedSource ? {
    name: record.source?.name || 'source-image',
    mimeType: sourceType,
    size: typedSource.size,
    dataUrl: await blobToDataUrl(typedSource),
  } : null;
  const encodedArtifacts = await Promise.all(artifacts.map(async (artifact) => ({
    filename: artifact.filename,
    kind: artifact.kind,
    mimeType: artifact.mimeType,
    createdAt: artifact.createdAt,
    profileSnapshot: artifact.profileSnapshot ?? null,
    dataUrl: await blobToDataUrl(artifact.blob),
  })));
  return {
    schema: PROJECT_BUNDLE_SCHEMA,
    version: PROJECT_BUNDLE_VERSION,
    createdAt: new Date().toISOString(),
    clientProjectId: record.id,
    trashedAt: record.trashedAt || null,
    project: JSON.parse(serializeProject(record)),
    source,
    checkpoints: checkpoints.map((checkpoint) => ({
      label: checkpoint.label,
      createdAt: checkpoint.createdAt,
      project: checkpoint.project,
    })),
    artifacts: encodedArtifacts,
  };
}

async function cacheBundle(metadata, bundle) {
  if (bundle.schema !== PROJECT_BUNDLE_SCHEMA || bundle.version !== PROJECT_BUNDLE_VERSION) {
    throw new Error('The server returned an unsupported project package.');
  }
  const project = deserializeProject(JSON.stringify(bundle.project));
  const id = metadata.id || bundle.clientProjectId;
  const localSource = bundle.source?.dataUrl ? dataUrlToBlob(bundle.source.dataUrl) : null;
  if (localSource && Number.isFinite(Number(bundle.source?.size)) && localSource.size !== Number(bundle.source.size)) {
    throw new Error('The downloaded source image is incomplete.');
  }
  const checkpoints = (bundle.checkpoints || []).slice(0, 10).map((checkpoint) => ({
    ...checkpoint,
    project: deserializeProject(JSON.stringify(checkpoint?.project)),
  }));
  const artifacts = (bundle.artifacts || []).slice(0, 30).map((artifact) => ({
    ...artifact,
    blob: dataUrlToBlob(artifact?.dataUrl),
  }));
  const localSyncPending = metadata.localSyncPending === true;
  const cached = {
    ...project,
    id,
    localSource,
    trashedAt: metadata.trashedAt || bundle.trashedAt || null,
    serverRevision: Number(metadata.revision) || 0,
    serverSyncedAt: new Date().toISOString(),
    serverSha256: metadata.sha256 || null,
    localSyncPending,
    localChangeId: localSyncPending ? metadata.localChangeId || crypto.randomUUID() : null,
    conflictOriginId: metadata.conflictOriginId || bundle.conflictOriginId || null,
  };
  return replaceProjectCache(cached, { checkpoints, artifacts });
}

async function pullProject(metadata, workspaceId = storageWorkspaceId()) {
  const response = await fetch(`/api/projects/${encodeURIComponent(metadata.id)}/bundle`, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      Accept: PROJECT_CONTENT_TYPE,
      'X-Kerfloom-Workspace': workspaceId,
    },
  });
  if (!response.ok) throw await responseError(response, 'Could not download the project');
  const responseRevision = Number(String(response.headers.get('ETag') || '').replaceAll('"', ''));
  const actualMetadata = {
    ...metadata,
    revision: Number.isFinite(responseRevision) && responseRevision > 0
      ? responseRevision
      : metadata.revision,
    sha256: responseRevision === Number(metadata.revision) ? metadata.sha256 : null,
  };
  return cacheBundle(actualMetadata, await response.json());
}

export async function queueProjectSync(record) {
  if (record?.localDraft === true) {
    throw new TypeError('A recoverable local draft cannot be added to the server sync queue');
  }
  const bundle = await buildProjectBundle(record);
  const conflictOriginId = record.conflictOriginId || (/(?:^|\s)\(conflict\s/i.test(record.name || '')
    ? record.id
    : null);
  if (conflictOriginId) bundle.conflictOriginId = conflictOriginId;
  return putProjectSync({
    projectId: record.id,
    kind: 'put',
    expectedRevision: Number(record.serverRevision) || 0,
    payload: JSON.stringify(bundle),
    localChangeId: record.localChangeId || null,
    conflictOriginId,
    workspaceId: storageWorkspaceId(),
    queuedAt: new Date().toISOString(),
  });
}

export async function queueProjectDeletion(record) {
  if (!record?.id) throw new TypeError('A saved project is required');
  return putProjectSync({
    projectId: record.id,
    kind: 'delete',
    expectedRevision: Number(record.serverRevision) || 0,
    localChangeId: record.localChangeId || null,
    workspaceId: storageWorkspaceId(),
    queuedAt: new Date().toISOString(),
  });
}

function validateQueuedProjectOperation(operation) {
  if (operation.kind !== 'put') return operation;
  let bundle;
  try {
    bundle = JSON.parse(operation.payload);
  } catch {
    throw new TypeError('The queued project package is not valid JSON');
  }
  if (bundle.schema !== PROJECT_BUNDLE_SCHEMA || bundle.version !== PROJECT_BUNDLE_VERSION) {
    const error = new TypeError('The queued project package uses an unsupported format');
    error.code = 'local_queue_format';
    throw error;
  }
  if (bundle.clientProjectId !== operation.projectId || bundle.project?.id !== operation.projectId) {
    const error = new TypeError('The queued project identifier does not match its package');
    error.code = 'local_queue_id_mismatch';
    throw error;
  }
  deserializeProject(JSON.stringify(bundle.project));
  return operation;
}

async function repairQueuedProjectOperation(operation) {
  try {
    return validateQueuedProjectOperation(operation);
  } catch (cause) {
    const local = await loadProject(operation.projectId);
    if (!local) {
      const error = new Error('The queued change is damaged and has no complete local project to rebuild it from');
      error.code = 'local_queue_unrecoverable';
      error.cause = cause;
      throw error;
    }
    console.warn(`Rebuilding damaged sync entry for ${operation.projectId}.`, cause);
    return queueProjectSync(local);
  }
}

async function forkConflict(operation, details) {
  const bundle = JSON.parse(operation.payload);
  const identity = await sha256Text([
    operation.workspaceId,
    operation.projectId,
    operation.localChangeId || operation.operationId,
  ].join(':'));
  const newId = `conflict-${identity.slice(0, 32)}`;
  const queuedAt = new Date(operation.queuedAt);
  const timestamp = Number.isFinite(queuedAt.getTime()) ? queuedAt : new Date(0);
  const suffix = new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(timestamp);
  bundle.clientProjectId = newId;
  bundle.createdAt = timestamp.toISOString();
  bundle.project.id = newId;
  bundle.project.name = `${bundle.project.name} (conflict ${suffix})`;
  bundle.project.createdAt = timestamp.toISOString();
  bundle.project.updatedAt = timestamp.toISOString();
  bundle.conflictOriginId = operation.conflictOriginId || operation.projectId;

  const localChangeId = operation.localChangeId || `conflict-${identity.slice(32)}`;
  await cacheBundle({
    id: newId,
    revision: 0,
    trashedAt: bundle.trashedAt,
    localSyncPending: true,
    localChangeId,
    conflictOriginId: bundle.conflictOriginId,
  }, bundle);
  const replacement = {
    projectId: newId,
    kind: 'put',
    expectedRevision: 0,
    payload: JSON.stringify(bundle),
    localChangeId,
    conflictOriginId: bundle.conflictOriginId,
    workspaceId: operation.workspaceId,
    operationId: `conflict-${identity}`,
    queuedAt: timestamp.toISOString(),
  };
  const transition = await replaceProjectSyncOperation(
    operation.projectId,
    operation.operationId,
    replacement,
    { workspaceId: operation.workspaceId },
  );
  const activeReplacement = transition.operation;
  if (!activeReplacement) {
    return {
      status: 'superseded',
      projectId: operation.projectId,
      originalProjectId: operation.projectId,
    };
  }

  if (details?.project?.deletedAt) {
    await deleteProject(operation.projectId);
  } else if (details?.project) {
    await pullProject(details.project, operation.workspaceId);
  }
  const result = await flushProjectOperation(activeReplacement, { resolveConflicts: false });
  const saved = result.status === 'synced';
  return {
    ...result,
    status: saved ? 'conflict' : 'conflict-queued',
    projectId: newId,
    originalProjectId: operation.projectId,
    name: bundle.project.name,
    message: saved
      ? 'Another device changed this project. Your edit was saved as a separate conflict copy.'
      : 'Another device changed this project. Your conflict copy is saved locally and waiting for the server.',
  };
}

function isConflictCopyOperation(operation) {
  if (operation?.conflictOriginId) return true;
  try {
    return /(?:^|\s)\(conflict\s/i.test(JSON.parse(operation?.payload || '{}').project?.name || '');
  } catch {
    return false;
  }
}

async function rebaseConflictCopy(operation, details) {
  const revision = Number(details?.project?.revision ?? details?.currentRevision);
  if (details?.project?.deletedAt || !Number.isFinite(revision) || revision < 1) {
    return {
      status: 'conflict-queued',
      projectId: operation.projectId,
      message: 'This conflict copy also changed elsewhere. It remains queued for review; Kerfloom will not create another copy.',
    };
  }
  const rebased = await putProjectSync({
    ...operation,
    expectedRevision: revision,
    conflictOriginId: operation.conflictOriginId || operation.projectId,
    operationId: crypto.randomUUID(),
    queuedAt: new Date().toISOString(),
  });
  return performProjectOperation(rebased, { resolveConflicts: false });
}

async function withProjectOperationLock(operation, callback) {
  const key = `${operation.workspaceId}:${operation.projectId}`;
  const previous = localOperationLocks.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const execute = async () => {
      const current = await loadProjectSync(operation.projectId, { workspaceId: operation.workspaceId });
      if (!current || current.operationId !== operation.operationId) {
        return { status: 'superseded', projectId: operation.projectId };
      }
      return callback(current);
    };
    if (navigator.locks?.request) {
      return navigator.locks.request(`kerfloom:${key}`, execute);
    }
    return execute();
  });
  localOperationLocks.set(key, run);
  try {
    return await run;
  } finally {
    if (localOperationLocks.get(key) === run) localOperationLocks.delete(key);
  }
}

async function performProjectOperation(operation, { resolveConflicts = true } = {}) {
  if (operation.workspaceId !== storageWorkspaceId()) {
    return { status: 'stale-workspace', projectId: operation.projectId };
  }
  try {
    if (operation.kind === 'delete') {
      const response = await fetch(`/api/projects/${encodeURIComponent(operation.projectId)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'If-Match': `"${operation.expectedRevision}"`,
          'X-Kerfloom-Workspace': operation.workspaceId,
        },
      });
      if (!response.ok) {
        const error = await responseError(response, 'Could not delete the server project');
        if (error.status === 404) {
          const acknowledged = await acknowledgeProjectSync(
            operation.projectId,
            operation.operationId,
            { revision: 0, sha256: null },
            { workspaceId: operation.workspaceId },
          );
          return {
            status: acknowledged.exact ? 'deleted' : 'superseded',
            projectId: operation.projectId,
          };
        }
        if (isProjectConflict(error) && resolveConflicts) {
          if (operation.workspaceId !== storageWorkspaceId()) {
            return { status: 'stale-workspace', projectId: operation.projectId };
          }
          const current = await loadProjectSync(operation.projectId, { workspaceId: operation.workspaceId });
          if (current && current.operationId !== operation.operationId && current.kind === 'put') {
            return forkConflict(current, error.details);
          }
          if (error.details?.project?.deletedAt) {
            const acknowledged = await acknowledgeProjectSync(
              operation.projectId,
              operation.operationId,
              error.details.project,
              { workspaceId: operation.workspaceId },
            );
            await deleteProject(operation.projectId);
            return {
              status: acknowledged.exact ? 'deleted' : 'superseded',
              projectId: operation.projectId,
              recoveredAcknowledgement: true,
            };
          } else if (error.details?.project) {
            await deleteProjectSync(operation.projectId, operation.operationId, { workspaceId: operation.workspaceId });
            await pullProject(error.details.project, operation.workspaceId);
          }
          return {
            status: 'conflict',
            projectId: operation.projectId,
            message: 'This project changed on another device, so it was not deleted. The newer server copy was kept.',
          };
        }
        throw error;
      }
      const metadata = await response.json();
      const acknowledged = await acknowledgeProjectSync(
        operation.projectId,
        operation.operationId,
        metadata,
        { workspaceId: operation.workspaceId },
      );
      return {
        status: acknowledged.exact ? 'deleted' : 'superseded',
        projectId: operation.projectId,
      };
    }

    const upload = await prepareProjectUpload(operation.payload);
    const response = await fetch(`/api/projects/${encodeURIComponent(operation.projectId)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': PROJECT_CONTENT_TYPE,
        ...(upload.contentEncoding ? { 'Content-Encoding': upload.contentEncoding } : {}),
        'If-Match': `"${operation.expectedRevision}"`,
        'X-Kerfloom-Workspace': operation.workspaceId,
      },
      body: upload.body,
    });
    if (!response.ok) {
      const error = await responseError(response, 'Could not save the server project');
      if (isProjectConflict(error)) {
        // A second tab may repeat the deterministic conflict-copy upload after
        // the first tab committed it. Matching content is an acknowledgement,
        // not another conflict that needs another copy.
        const recovered = await acknowledgeMatchingUpload(operation, error.details);
        if (recovered) return recovered;
      }
      if (isProjectConflict(error) && resolveConflicts) {
        if (operation.workspaceId !== storageWorkspaceId()) {
          return { status: 'stale-workspace', projectId: operation.projectId };
        }
        const current = await loadProjectSync(operation.projectId, { workspaceId: operation.workspaceId });
        const active = current?.kind === 'put' ? current : operation;
        if (isConflictCopyOperation(active)) return rebaseConflictCopy(active, error.details);
        return forkConflict(active, error.details);
      }
      throw error;
    }
    const metadata = (await response.json()).project;
    const acknowledged = await acknowledgeProjectSync(
      operation.projectId,
      operation.operationId,
      metadata,
      { workspaceId: operation.workspaceId },
    );
    return {
      status: acknowledged.exact ? 'synced' : 'superseded',
      projectId: operation.projectId,
      project: metadata,
    };
  } catch (error) {
    if (error instanceof TypeError || !navigator.onLine) {
      return { status: 'queued', projectId: operation.projectId, error };
    }
    throw error;
  }
}

async function flushProjectOperation(operation, options = {}) {
  return withProjectOperationLock(operation, (current) => performProjectOperation(current, options));
}

export async function flushQueuedProjectSync(projectId) {
  const operation = await loadProjectSync(projectId);
  if (!operation) return { status: 'idle', projectId };
  if (!navigator.onLine) return { status: 'queued', projectId };
  return flushProjectOperation(operation);
}

export async function syncProject(record) {
  const operation = await queueProjectSync(record);
  if (!navigator.onLine) return { status: 'queued', projectId: record.id };
  return flushProjectOperation(operation);
}

export async function deleteServerProject(record) {
  const operation = await queueProjectDeletion(record);
  if (!navigator.onLine) return { status: 'queued', projectId: record.id };
  return flushProjectOperation(operation);
}

export async function synchronizeProjectLibrary(onProgress = null) {
  if (!navigator.onLine) return { status: 'offline', pending: (await listProjectSync()).length };
  const remote = await requestProjects();
  const remoteById = new Map(remote.map((row) => [row.id, row]));
  const local = [...await listProjects(), ...await listProjects({ trashed: true })];
  const localById = new Map(local.map((row) => [row.id, row]));
  const pending = new Map((await listProjectSync()).map((row) => [row.projectId, row]));
  let completed = 0;
  const deleted = [];
  const failures = [];
  const remapped = [];
  const total = remote.length + local.length + pending.size;
  const progress = (message) => onProgress?.({ completed, total, message });
  const fail = (details) => {
    const failure = projectFailure(details);
    failures.push(failure);
    console.error(`Project sync ${failure.phase} failed for ${failure.projectId || failure.name}:`, failure.error);
    return failure;
  };

  for (const metadata of remote) {
    try {
      const cached = localById.get(metadata.id);
      if (metadata.deletedAt) {
        const queuedOperation = pending.get(metadata.id);
        if (queuedOperation?.kind === 'put' || cached?.localSyncPending) {
          // Let the normal revision-conflict path preserve the offline edit as
          // a separate project instead of discarding it for the tombstone.
        } else {
          await deleteProject(metadata.id);
          await deleteProjectSync(metadata.id);
          pending.delete(metadata.id);
          deleted.push(metadata.id);
        }
      } else if (!pending.has(metadata.id) && !cached?.localSyncPending && (
        !cached || Number(cached.serverRevision) < metadata.revision
      )) {
        progress(`Downloading “${metadata.name}”…`);
        await pullProject(metadata);
      }
    } catch (error) {
      fail({ projectId: metadata.id, name: metadata.name, phase: 'download', error });
    } finally {
      completed += 1;
    }
  }

  for (const record of local) {
    try {
      if (record.localSyncPending && !pending.has(record.id)) {
        progress(`Uploading “${record.name}”…`);
        pending.set(record.id, await queueProjectSync(record));
      } else if (!record.serverRevision && !pending.has(record.id)) {
        progress(`Uploading “${record.name}”…`);
        pending.set(record.id, await queueProjectSync(record));
      } else if (record.serverRevision && !remoteById.has(record.id) && !pending.has(record.id)) {
        // A missing server row can mean recovery from a restored or damaged
        // server database. Preserve the only remaining complete copy and offer
        // it back to the server as a new revision-zero project.
        const recoverable = await cacheProject({
          ...record,
          serverRevision: 0,
          serverSyncedAt: null,
          serverSha256: null,
          localSyncPending: true,
          localChangeId: record.localChangeId || crypto.randomUUID(),
        });
        progress(`Recovering “${recoverable.name}” to the server…`);
        pending.set(record.id, await queueProjectSync(recoverable));
      }
    } catch (error) {
      fail({ projectId: record.id, name: record.name, phase: 'queue', error });
    } finally {
      completed += 1;
    }
  }

  let queued = 0;
  let conflicts = 0;
  for (const operation of (await listProjectSync())) {
    try {
      progress(operation.kind === 'delete' ? 'Removing a deleted project…' : 'Saving a project to the server…');
      const repaired = await repairQueuedProjectOperation(operation);
      const result = await flushProjectOperation(repaired);
      if (result.status === 'queued' || result.status === 'conflict-queued') queued += 1;
      if (result.status === 'conflict' || result.status === 'conflict-queued') {
        conflicts += 1;
        remapped.push({
          fromProjectId: result.originalProjectId || operation.projectId,
          toProjectId: result.projectId,
          name: result.name || localById.get(operation.projectId)?.name || operation.projectId,
          status: result.status,
        });
      }
    } catch (error) {
      const record = localById.get(operation.projectId) || await loadProject(operation.projectId).catch(() => null);
      const failure = fail({
        projectId: operation.projectId,
        name: record?.name || operation.projectId,
        phase: operation.kind === 'delete' ? 'delete' : 'upload',
        error,
      });
      if (failure.retryable) queued += 1;
    } finally {
      completed += 1;
    }
  }

  const needsAttention = failures.some((failure) => !failure.retryable);
  return {
    status: needsAttention ? 'partial' : queued ? 'queued' : 'synced',
    queued,
    conflicts,
    deleted,
    failures,
    remapped,
  };
}

export async function pendingProjectSyncCount() {
  const [operations, active, trash] = await Promise.all([
    listProjectSync(),
    listProjects(),
    listProjects({ trashed: true }),
  ]);
  const pendingIds = new Set(operations.map((operation) => operation.projectId));
  for (const project of [...active, ...trash]) {
    if (project.localSyncPending || !project.serverRevision) pendingIds.add(project.id);
  }
  return pendingIds.size;
}

export async function hasPendingProjectSync(projectId) {
  return Boolean(await loadProjectSync(projectId));
}
