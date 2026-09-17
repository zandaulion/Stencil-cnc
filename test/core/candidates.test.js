import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REMOVED,
  RETAINED,
  applyRasterLayers,
  maskFingerprint,
  retireConflictingRepairEdit,
} from '../../web/core/index.js';
import { maskFromAscii } from './fixtures.js';

test('candidate raster layers apply manual edits before active manufacturing repairs', () => {
  const base = maskFromAscii([
    '#..',
    '.#.',
  ]);
  const result = applyRasterLayers(base, {
    painted: { keep: [1], remove: [4] },
    manufacturingRepairs: {
      keep: [4],
      remove: [0],
      enabled: true,
      stale: false,
    },
  });

  assert.deepEqual([...result.data], [0, 1, 0, 0, 1, 0]);
  assert.deepEqual([...base.data], [1, 0, 0, 0, 1, 0], 'the saved base recipe remains immutable');
});

test('hidden or stale manufacturing repairs do not alter candidate geometry', () => {
  const base = maskFromAscii(['#..']);
  const hidden = applyRasterLayers(base, {
    manufacturingRepairs: { keep: [1], remove: [0], enabled: false, stale: false },
  });
  const stale = applyRasterLayers(base, {
    manufacturingRepairs: { keep: [1], remove: [0], enabled: true, stale: true },
  });

  assert.deepEqual([...hidden.data], [...base.data]);
  assert.deepEqual([...stale.data], [...base.data]);
});

test('manual painting retires only the opposite automatic repair cells', () => {
  const layer = {
    keep: new Set([1, 2]),
    remove: new Set([3, 4]),
    enabled: true,
    stale: false,
    summary: { repairCount: 4 },
  };

  assert.equal(retireConflictingRepairEdit(layer, 1, REMOVED), true);
  assert.equal(retireConflictingRepairEdit(layer, 3, RETAINED), true);
  assert.equal(retireConflictingRepairEdit(layer, 2, RETAINED), false, 'matching generated material remains');
  assert.equal(retireConflictingRepairEdit(layer, 4, REMOVED), false, 'matching generated opening remains');
  assert.deepEqual([...layer.keep], [2]);
  assert.deepEqual([...layer.remove], [4]);
  assert.equal(layer.enabled, true);
  assert.equal(layer.stale, false);
  assert.equal(layer.summary.manualOverrideCount, 2);
});

test('manual painting does not rewrite an already stale repair layer', () => {
  const layer = {
    keep: new Set([1]),
    remove: new Set([2]),
    enabled: false,
    stale: true,
    summary: null,
  };

  assert.equal(retireConflictingRepairEdit(layer, 1, REMOVED), false);
  assert.deepEqual([...layer.keep], [1]);
  assert.equal(layer.summary, null);
});

test('candidate geometry fingerprints are deterministic and sensitive to one-cell changes', () => {
  const first = maskFromAscii(['##.']);
  const same = maskFromAscii(['##.']);
  const changed = maskFromAscii(['#..']);

  assert.equal(maskFingerprint(first), maskFingerprint(same));
  assert.notEqual(maskFingerprint(first), maskFingerprint(changed));
  assert.match(maskFingerprint(first), /^fnv1a32:3x1:[a-f0-9]{8}$/);
});
