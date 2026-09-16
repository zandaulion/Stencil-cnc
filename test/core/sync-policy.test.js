import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSyncRetryController,
  isRetryableSyncError,
  isStorageQuotaError,
} from '../../web/core/sync-policy.js';

test('synchronization retries are deduplicated, backed off, and bounded', async () => {
  const timers = [];
  const states = [];
  const retries = [];
  const controller = createSyncRetryController({
    delays: [10, 20],
    onRetry: async (retry) => retries.push(retry),
    onState: (state) => states.push(state),
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
  });

  assert.deepEqual(controller.schedule(), { status: 'scheduled', attempt: 1, delayMs: 10 });
  assert.deepEqual(controller.schedule(), { status: 'scheduled', attempt: 1, delayMs: 10 });
  assert.equal(timers.length, 1, 'only one retry timer may be active');
  await timers[0].callback();
  assert.deepEqual(retries, [{ attempt: 1, delayMs: 10 }]);

  assert.deepEqual(controller.schedule(), { status: 'scheduled', attempt: 2, delayMs: 20 });
  await timers[1].callback();
  assert.deepEqual(retries[1], { attempt: 2, delayMs: 20 });
  assert.deepEqual(controller.schedule(), { status: 'exhausted', attempt: 2 });
  assert.equal(timers.length, 2, 'the retry budget must not create an unbounded timer loop');

  controller.reset();
  assert.deepEqual(controller.snapshot(), { attempt: 0, scheduled: false });
  assert.equal(states.at(-1).status, 'exhausted');
});

test('synchronization retry pauses without consuming its budget while inactive', () => {
  let active = false;
  let timers = 0;
  const controller = createSyncRetryController({
    delays: [10],
    canRun: () => active,
    onRetry: () => {},
    setTimer: () => { timers += 1; return timers; },
  });
  assert.deepEqual(controller.schedule(), { status: 'paused', attempt: 0 });
  assert.equal(timers, 0);
  active = true;
  assert.equal(controller.schedule().status, 'scheduled');
  assert.equal(timers, 1);
});

test('quota and transient synchronization failures are classified conservatively', () => {
  assert.equal(isStorageQuotaError(new DOMException('Storage quota exceeded', 'QuotaExceededError')), true);
  assert.equal(isStorageQuotaError(new Error('invalid project')), false);
  assert.equal(isRetryableSyncError(new TypeError('network failed')), true);
  assert.equal(isRetryableSyncError(Object.assign(new Error('busy'), { status: 503 })), true);
  assert.equal(isRetryableSyncError(Object.assign(new Error('invalid'), { status: 400, code: 'invalid_bundle' })), false);
});
