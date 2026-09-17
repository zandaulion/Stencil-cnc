import test from 'node:test';
import assert from 'node:assert/strict';

import { formatRulerValue, rulerStep, rulerTicks } from '../../web/core/index.js';

test('ruler intervals stay readable across small and large physical panels', () => {
  assert.equal(rulerStep(297 / 540, 84), 50);
  assert.equal(rulerStep(1250 / 720, 84), 200);
  assert.equal(rulerStep((420 / 25.4) / 450, 84), 2.5);
});

test('A3 portrait ruler positions use the same fit transform as the canvas', () => {
  const result = rulerTicks({
    extent: 297,
    pixelsPerUnit: 540 / 297,
    offsetPx: 30,
    viewportStartPx: 24,
    viewportEndPx: 600,
  });
  assert.equal(result.step, 50);
  assert.deepEqual(result.ticks.map(({ value }) => value), [0, 50, 100, 150, 200, 250]);
  assert.equal(result.ticks[0].positionPx, 30);
  assert.equal(result.ticks[2].positionPx, 30 + 100 * 540 / 297);
});

test('landscape, pan, and zoom change ruler positions without changing physical values', () => {
  const base = rulerTicks({
    extent: 420,
    pixelsPerUnit: 2,
    offsetPx: 20,
    viewportStartPx: 24,
    viewportEndPx: 700,
  });
  const transformed = rulerTicks({
    extent: 420,
    pixelsPerUnit: 4,
    offsetPx: -80,
    viewportStartPx: 24,
    viewportEndPx: 700,
  });
  const baseHundred = base.ticks.find(({ value }) => value === 100);
  const transformedHundred = transformed.ticks.find(({ value }) => value === 100);
  assert.equal(baseHundred.positionPx, 220);
  assert.equal(transformedHundred.positionPx, 320);
});

test('inch rulers expose converted physical coordinates and clip off-screen ticks', () => {
  const extentInches = 420 / 25.4;
  const result = rulerTicks({
    extent: extentInches,
    pixelsPerUnit: 40,
    offsetPx: -100,
    viewportStartPx: 24,
    viewportEndPx: 500,
  });
  assert.equal(result.step, 2);
  assert.deepEqual(result.ticks.map(({ value }) => value), [4, 6, 8, 10, 12, 14]);
  assert.ok(result.ticks.every(({ positionPx }) => positionPx >= 24 && positionPx <= 500));
  assert.equal(formatRulerValue(2.5, 2.5), '2.5');
});
