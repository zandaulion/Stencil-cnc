import assert from 'node:assert/strict';
import test from 'node:test';

import { maskToRgba } from '../../web/core/index.js';
import { maskFromAscii } from './fixtures.js';

test('PNG raster maps retained metal to black and openings to opaque white', () => {
  const raster = maskToRgba(maskFromAscii(['#.', '.#']));

  assert.equal(raster.width, 2);
  assert.equal(raster.height, 2);
  assert.deepEqual([...raster.data], [
    0, 0, 0, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 0, 0, 0, 255,
  ]);
});
