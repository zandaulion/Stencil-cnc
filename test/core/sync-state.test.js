import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcileProjectAcknowledgement } from '../../web/core/sync-state.js';

test('an exact project acknowledgement removes only its own operation', () => {
  const operation = {
    projectId: 'project-1',
    operationId: 'operation-a',
    expectedRevision: 3,
    payload: 'A',
  };

  assert.deepEqual(
    reconcileProjectAcknowledgement(operation, 'operation-a', 4),
    { exact: true, superseded: false, pending: null },
  );
});

test('an older acknowledgement preserves and rebases a newer queued edit', () => {
  const newer = {
    projectId: 'project-1',
    operationId: 'operation-b',
    expectedRevision: 3,
    payload: 'B',
  };
  const result = reconcileProjectAcknowledgement(newer, 'operation-a', 4);

  assert.equal(result.exact, false);
  assert.equal(result.superseded, true);
  assert.deepEqual(result.pending, { ...newer, expectedRevision: 4 });
  assert.equal(result.pending.payload, 'B');
});
