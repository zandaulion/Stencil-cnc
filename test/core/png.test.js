import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DRAFT_WATERMARK_LABEL,
  drawDraftWatermark,
  maskToRgba,
} from '../../web/core/index.js';
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

test('draft PNG watermark draws a visible branded safety band', () => {
  const calls = [];
  const context = {
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    translate: (...args) => calls.push(['translate', ...args]),
    rotate: (...args) => calls.push(['rotate', ...args]),
    fillRect: (...args) => calls.push(['fillRect', ...args]),
    beginPath: () => calls.push(['beginPath']),
    moveTo: (...args) => calls.push(['moveTo', ...args]),
    lineTo: (...args) => calls.push(['lineTo', ...args]),
    stroke: () => calls.push(['stroke']),
    fillText: (...args) => calls.push(['fillText', ...args]),
  };

  drawDraftWatermark(context, 1200, 800);

  assert.ok(calls.some(([name]) => name === 'fillRect'), 'the watermark has a contrasting band');
  assert.ok(calls.some(([name]) => name === 'stroke'), 'the watermark band is outlined');
  assert.ok(calls.some(([name, label]) => name === 'fillText' && label === DRAFT_WATERMARK_LABEL));
  assert.deepEqual(calls.at(0), ['save']);
  assert.deepEqual(calls.at(-1), ['restore']);
});
