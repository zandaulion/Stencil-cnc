import assert from 'node:assert/strict';
import test from 'node:test';

import { applyRasterLayers, maskFingerprint } from '../../web/core/index.js';
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

test('candidate geometry fingerprints are deterministic and sensitive to one-cell changes', () => {
  const first = maskFromAscii(['##.']);
  const same = maskFromAscii(['##.']);
  const changed = maskFromAscii(['#..']);

  assert.equal(maskFingerprint(first), maskFingerprint(same));
  assert.notEqual(maskFingerprint(first), maskFingerprint(changed));
  assert.match(maskFingerprint(first), /^fnv1a32:3x1:[a-f0-9]{8}$/);
});
