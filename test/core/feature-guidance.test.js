import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bridgeSamplersFromGuidance,
  createFeatureGuidance,
  materializeBridgeStrategy,
} from '../../web/core/feature-guidance.js';

function portraitStrip() {
  const width = 4;
  const height = 2;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = x < 2 ? 20 : 230;
      const offset = (y * width + x) * 4;
      data.set([value, value, value, 255], offset);
    }
  }
  return { width, height, data };
}

test('feature guidance is bounded, serializable, and reconstructs dark-feature samplers', () => {
  const guidance = createFeatureGuidance(portraitStrip(), {
    placement: { xMm: 0, yMm: 0, widthMm: 40, heightMm: 20, rotationDeg: 0 },
    bounds: { x: 0, y: 0, width: 4, height: 2 },
    sourceSize: { width: 4, height: 2 },
    protectDetail: true,
    followFeatures: true,
    maximumDimension: 4,
  });
  assert.equal(guidance.width, 4);
  assert.equal(guidance.height, 2);
  assert.ok(guidance.luminance instanceof Float32Array);
  assert.doesNotThrow(() => structuredClone(guidance));

  const samplers = bridgeSamplersFromGuidance(guidance);
  const dark = samplers.featureAt({ x: 5, y: 10 });
  const light = samplers.featureAt({ x: 35, y: 10 });
  assert.ok(dark.lightness < light.lightness);
  assert.equal(samplers.detailAt, null, 'feature sampling carries detail in one lookup');
  assert.equal(typeof samplers.fallbackDetailAt, 'function');
});

test('materializing a strategy restores callbacks without retaining the transferable field', () => {
  const guidance = createFeatureGuidance(portraitStrip(), {
    placement: { xMm: 0, yMm: 0, widthMm: 40, heightMm: 20, rotationDeg: 0 },
    bounds: { x: 0, y: 0, width: 4, height: 2 },
    sourceSize: { width: 4, height: 2 },
    followFeatures: true,
  });
  const strategy = materializeBridgeStrategy({ mode: 'smart', kind: 'lamele', featureGuidance: guidance });
  assert.equal(typeof strategy.featureAt, 'function');
  assert.equal(strategy.featureGuidance, undefined);
});
