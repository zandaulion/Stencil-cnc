/**
 * Reconciles the operation currently queued for a project with an older
 * server acknowledgement. The exact operation may be removed; a newer one is
 * retained and rebased onto the acknowledged server revision.
 */
export function reconcileProjectAcknowledgement(pending, operationId, revision) {
  const normalizedRevision = Number(revision) || 0;
  if (!pending) return { exact: false, superseded: false, pending: null };
  if (pending.operationId === operationId) {
    return { exact: true, superseded: false, pending: null };
  }
  return {
    exact: false,
    superseded: true,
    pending: { ...pending, expectedRevision: normalizedRevision },
  };
}
