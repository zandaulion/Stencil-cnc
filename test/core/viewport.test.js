import test from 'node:test';
import assert from 'node:assert/strict';

import { zoomAroundPoint } from '../../web/core/index.js';

test('cursor-centred zoom keeps the same world point under the cursor', () => {
  const before = { zoom: 0.5, pan: { x: 30, y: -20 } };
  const anchor = { x: 250, y: 180 };
  const worldBefore = {
    x: (anchor.x - before.pan.x) / before.zoom,
    y: (anchor.y - before.pan.y) / before.zoom,
  };
  const after = zoomAroundPoint(before, anchor, 1.4);
  assert.equal((anchor.x - after.pan.x) / after.zoom, worldBefore.x);
  assert.equal((anchor.y - after.pan.y) / after.zoom, worldBefore.y);
});

test('zoom limits are applied without losing the anchor', () => {
  const after = zoomAroundPoint(
    { zoom: 1, pan: { x: 0, y: 0 } },
    { x: 100, y: 50 },
    100,
    { minimum: 0.1, maximum: 4 },
  );
  assert.equal(after.zoom, 4);
  assert.deepEqual(after.pan, { x: -300, y: -150 });
});
