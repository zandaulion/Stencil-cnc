import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FINISHED_BOUNDARY_CAM,
  LEGACY_UNCOMPENSATED_CENTERLINE,
  recommendStyleSettings,
} from '../../web/core/index.js';

const generalPlasma = {
  widthMm: 297,
  heightMm: 420,
  kerfMm: 1.2,
  minimumOpeningMm: 2,
  minimumWebMm: 3,
  geometryInterpretation: FINISHED_BOUNDARY_CAM,
};

test('style guidance scales pattern pitch to the panel short edge', () => {
  const a3 = recommendStyleSettings('lamele', generalPlasma);
  const sheet = recommendStyleSettings('lamele', {
    ...generalPlasma,
    widthMm: 1250,
    heightMm: 2500,
  });

  assert.equal(a3.controls['style-pitch'], 10);
  assert.equal(a3.repeatCount, 30);
  assert.equal(sheet.controls['style-pitch'], 40);
  assert.ok(sheet.controls['style-pitch'] > a3.controls['style-pitch']);
});

test('dot and flow recommendations preserve configured openings and finished webs', () => {
  const dots = recommendStyleSettings('puncte', generalPlasma);
  const flow = recommendStyleSettings('flux', generalPlasma);

  assert.equal(dots.controls['style-dot-pitch'], 10);
  assert.equal(dots.controls['style-dot-max'], 7);
  assert.ok(dots.controls['style-dot-pitch'] - dots.controls['style-dot-max'] >= 3);
  assert.equal(flow.controls['style-flow-pitch'], 10);
  assert.ok(flow.controls['style-flow-width'] >= 2);
  assert.ok(flow.controls['style-flow-pitch'] - flow.controls['style-flow-width'] >= 3);
});

test('strict or legacy manufacturing contracts raise the recommendation floor', () => {
  const strict = recommendStyleSettings('puncte', {
    ...generalPlasma,
    widthMm: 210,
    heightMm: 297,
    kerfMm: 2,
    minimumOpeningMm: 4,
    minimumWebMm: 6,
  });
  const legacy = recommendStyleSettings('lamele', {
    ...generalPlasma,
    widthMm: 210,
    heightMm: 297,
    geometryInterpretation: LEGACY_UNCOMPENSATED_CENTERLINE,
  });

  assert.equal(strict.minimumCycleMm, 14);
  assert.equal(strict.controls['style-dot-pitch'], 14);
  assert.equal(strict.controls['style-dot-max'], 8);
  assert.equal(legacy.drawnWebMm, 4.2);
  assert.equal(legacy.controls['style-pitch'], 8.5);
});

test('guidance leaves non-dimensional creative styles alone', () => {
  const poster = recommendStyleSettings('sablon', generalPlasma);
  assert.deepEqual(poster.controls, {});
  assert.deepEqual(poster.values, []);
});

test('guidance rejects incomplete physical context', () => {
  assert.throws(() => recommendStyleSettings('lamele', {
    ...generalPlasma,
    widthMm: 0,
  }), /panel width/);
});

