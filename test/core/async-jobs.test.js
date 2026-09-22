import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkerJobRunner, isJobCancelled } from '../../web/core/async-jobs.js';

class FakeWorker {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  postMessage(message, transfer = []) {
    this.sent = message;
    this.transfer = transfer;
  }

  terminate() {
    this.terminated = true;
  }

  emit(data) {
    this.onmessage?.({ data });
  }
}

function runner() {
  FakeWorker.instances = [];
  return createWorkerJobRunner({
    workerUrl: '/workers/geometry.js',
    createWorker: (url) => new FakeWorker(url),
  });
}

test('worker jobs report progress and resolve only the matching generation', async () => {
  const jobs = runner();
  const progress = [];
  const pending = jobs.run('validate', { value: 1 }, { onProgress: (value) => progress.push(value) });
  const worker = FakeWorker.instances[0];
  assert.equal(worker.sent.type, 'validate');
  worker.emit({ id: worker.sent.id, kind: 'progress', progress: { phase: 'checking' } });
  worker.emit({ id: worker.sent.id, kind: 'result', result: { value: 42 } });
  assert.deepEqual(await pending, { value: 42 });
  assert.deepEqual(progress, [{ phase: 'checking' }]);
  assert.equal(worker.terminated, true);
  assert.equal(jobs.active, false);
});

test('worker jobs can transfer snapshot buffers without cloning the live source', async () => {
  const jobs = runner();
  const bytes = new Uint8Array([1, 0, 1]);
  const pending = jobs.run('encode-project-masks', { bytes }, { transfer: [bytes.buffer] });
  const worker = FakeWorker.instances[0];
  assert.deepEqual(worker.transfer, [bytes.buffer]);
  worker.emit({ id: worker.sent.id, kind: 'result', result: { value: 'encoded' } });
  assert.equal((await pending).value, 'encoded');
});

test('a newer job terminates and rejects the superseded job', async () => {
  const jobs = runner();
  const first = jobs.run('validate', { revision: 1 });
  const firstWorker = FakeWorker.instances[0];
  const second = jobs.run('validate', { revision: 2 });
  const secondWorker = FakeWorker.instances[1];

  await assert.rejects(first, (error) => isJobCancelled(error));
  assert.equal(firstWorker.terminated, true);
  firstWorker.emit({ id: firstWorker.sent.id, kind: 'result', result: { value: 'stale' } });
  secondWorker.emit({ id: secondWorker.sent.id, kind: 'result', result: { value: 'current' } });
  assert.deepEqual(await second, { value: 'current' });
});

test('explicit cancellation terminates computation and preserves an AbortError contract', async () => {
  const jobs = runner();
  const pending = jobs.run('repair', {});
  const worker = FakeWorker.instances[0];
  assert.equal(jobs.cancel(), true);
  await assert.rejects(pending, (error) => isJobCancelled(error));
  assert.equal(worker.terminated, true);
  assert.equal(jobs.cancel(), false);
});

test('an uncloneable payload rejects cleanly and releases the worker', async () => {
  class RejectingWorker extends FakeWorker {
    postMessage() {
      throw new DOMException('could not be cloned', 'DataCloneError');
    }
  }
  const jobs = createWorkerJobRunner({
    workerUrl: '/workers/geometry.js',
    createWorker: (url) => new RejectingWorker(url),
  });
  await assert.rejects(jobs.run('validate', { callback() {} }), { name: 'DataCloneError' });
  assert.equal(jobs.active, false);
  assert.equal(FakeWorker.instances.at(-1).terminated, true);
});
