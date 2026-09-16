import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeVectorDots, placeVectorDots } from '../../web/core/index.js';

const descriptor = {
  version: 1,
  coordinateSpace: 'normalized-source',
  radiusSpace: 'normalized-source-width',
  circles: [[0.25, 0.5, 0.05]],
};

test('Variable Dot geometry follows the artwork crop and physical placement', () => {
  const placed = placeVectorDots(
    descriptor,
    { width: 100, height: 200 },
    { x: 10, y: 20, width: 80, height: 160 },
    { xMm: 30, yMm: 40, widthMm: 160, heightMm: 320 },
  );

  assert.deepEqual(placed, [{ cxMm: 60, cyMm: 200, radiusMm: 10 }]);
});

test('Variable Dot centres rotate with the artwork while circles remain circular', () => {
  const placed = placeVectorDots(
    descriptor,
    { width: 100, height: 200 },
    { x: 10, y: 20, width: 80, height: 160 },
    { xMm: 30, yMm: 40, widthMm: 160, heightMm: 320, rotationDeg: 90 },
  );

  assert.ok(Math.abs(placed[0].cxMm - 110) < 1e-9);
  assert.ok(Math.abs(placed[0].cyMm - 150) < 1e-9);
  assert.equal(placed[0].radiusMm, 10);
});

test('Variable Dot descriptors fail closed when a primitive is malformed', () => {
  assert.throws(() => normalizeVectorDots({ ...descriptor, circles: [[0.5, 0.5, -1]] }), /Invalid/);
  assert.equal(normalizeVectorDots(null), null);
});
