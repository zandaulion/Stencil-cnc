import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMask,
  manualEditIndices,
  normalizeManualEdits,
  rasterizeManualEdits,
  translateManualEdit,
} from '../../web/core/index.js';

const sheet = { widthMm: 100, heightMm: 100 };

test('ordered manual edits can add, remove, and restore generated artwork', () => {
  const mask = createMask(100, 100);
  const edits = [
    { id: 'add', operation: 'keep', shape: 'stroke', enabled: true, widthMm: 8, pointsMm: [{ x: 50, y: 50 }] },
    { id: 'cut', operation: 'remove', shape: 'stroke', enabled: true, widthMm: 4, pointsMm: [{ x: 50, y: 50 }] },
    { id: 'restore', operation: 'restore', shape: 'stroke', enabled: true, widthMm: 2, pointsMm: [{ x: 50, y: 50 }] },
  ];
  const painted = rasterizeManualEdits(mask, sheet, { edits });
  const centre = 50 * mask.width + 50;
  assert.equal(painted.keep.has(centre), false);
  assert.equal(painted.remove.has(centre), false);
  assert.ok(painted.keep.size > 0, 'outer part of the added disc remains');
  assert.ok(painted.remove.size > 0, 'middle ring of the cut remains');
});

test('restore also clears compatible legacy painted pixels', () => {
  const mask = createMask(20, 20);
  const centre = 10 * mask.width + 10;
  const painted = rasterizeManualEdits(mask, { widthMm: 20, heightMm: 20 }, {
    legacy: { keep: [centre], remove: [] },
    edits: [{ id: 'restore', operation: 'restore', shape: 'stroke', enabled: true, widthMm: 3, pointsMm: [{ x: 10, y: 10 }] }],
  });
  assert.equal(painted.keep.has(centre), false);
});

test('physical strokes retain their millimetre size on another raster', () => {
  const edit = { id: 'stroke', operation: 'keep', shape: 'stroke', enabled: true, widthMm: 10, pointsMm: [{ x: 20, y: 50 }, { x: 80, y: 50 }] };
  const low = manualEditIndices(createMask(100, 100), sheet, edit);
  const high = manualEditIndices(createMask(200, 200), sheet, edit);
  assert.ok(high.length > low.length * 3.2);
  assert.ok(high.length < low.length * 4.8);
});

test('raster regions remap while stroke edits remain movable', () => {
  const region = { id: 'region', operation: 'remove', shape: 'region', enabled: true, rasterKey: '2x2', indices: [3] };
  assert.deepEqual(manualEditIndices(createMask(4, 4), sheet, region), [10, 11, 14, 15]);
  assert.deepEqual(translateManualEdit(region, 10, 20), region);
  const stroke = translateManualEdit({ id: 's', operation: 'keep', shape: 'stroke', widthMm: 5, pointsMm: [{ x: 1, y: 2 }] }, 3, 4);
  assert.deepEqual(stroke.pointsMm, [{ x: 4, y: 6 }]);
});

test('manual edit normalization rejects duplicate ids and invalid widths', () => {
  assert.throws(() => normalizeManualEdits([
    { id: 'same', operation: 'keep', shape: 'stroke', widthMm: 2, pointsMm: [{ x: 0, y: 0 }] },
    { id: 'same', operation: 'remove', shape: 'stroke', widthMm: 2, pointsMm: [{ x: 1, y: 1 }] },
  ]), /unique/);
  assert.throws(() => normalizeManualEdits([
    { id: 'bad', operation: 'keep', shape: 'stroke', widthMm: 0, pointsMm: [{ x: 0, y: 0 }] },
  ]), /greater than zero/);
});
