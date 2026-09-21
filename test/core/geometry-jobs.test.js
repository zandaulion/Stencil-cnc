import assert from 'node:assert/strict';
import test from 'node:test';

import { FINISHED_BOUNDARY_CAM } from '../../web/core/geometry-contract.js';
import { executeGeometryJob } from '../../web/core/geometry-jobs.js';
import { maskFromAscii } from './fixtures.js';

const validationOptions = {
  sheet: { widthMm: 5, heightMm: 5 },
  kerfMm: 0,
  minimumWebMm: 1,
  minimumOpeningMm: 1,
  geometryInterpretation: FINISHED_BOUNDARY_CAM,
  anchorBoundary: false,
  requireAnchored: false,
  requireSingleComponent: true,
};

test('background validation is deterministic and structured-clone safe', () => {
  const mask = maskFromAscii([
    '#####',
    '#...#',
    '#.#.#',
    '#...#',
    '#####',
  ]);
  const phases = [];
  const first = executeGeometryJob('validate', { mask, options: validationOptions }, (phase) => phases.push(phase));
  const second = executeGeometryJob('validate', { mask, options: validationOptions });
  assert.deepEqual(first, second);
  assert.deepEqual(phases, ['checking']);
  assert.doesNotThrow(() => structuredClone(first));
});

test('background support planning returns a proposal and finished-connectivity check', () => {
  const mask = maskFromAscii(['#...#']);
  const result = executeGeometryJob('support', {
    mask,
    config: {
      sheet: { widthMm: 5, heightMm: 1 },
      widthMm: 1,
      anchorBoundary: false,
      requireSingleComponent: true,
      minimumWebMm: 0,
      kerfMm: 0,
      geometryInterpretation: FINISHED_BOUNDARY_CAM,
      maxPasses: 4,
      strategy: { mode: 'smart', kind: 'line-art', level: 2, featureGuidance: null },
    },
    validation: {
      ...validationOptions,
      sheet: { widthMm: 5, heightMm: 1 },
      minimumWebMm: 0,
      minimumOpeningMm: 0,
    },
  });
  assert.equal(result.plan.bridges.length, 1);
  assert.equal(result.supportSimulation.postKerf.componentCount, 1);
  assert.doesNotThrow(() => structuredClone(result));
});

test('repair evaluation keeps its candidate and measurements cloneable', () => {
  const mask = maskFromAscii([
    '#####',
    '##.##',
    '#####',
    '#####',
    '#####',
  ]);
  const plan = {
    items: [{
      id: 'opening-1',
      action: 'close',
      availableActions: { close: true, enlarge: false, merge: false },
      edits: { close: { keep: [7], remove: [] } },
    }],
  };
  const result = executeGeometryJob('repair-evaluate', {
    mask,
    plan,
    options: validationOptions,
  });
  assert.equal(result.candidate.data[7], 1);
  assert.ok(result.effects.addedAreaMm2 > 0);
  assert.doesNotThrow(() => structuredClone(result));
});

test('unknown background jobs fail closed', () => {
  assert.throws(() => executeGeometryJob('unknown', {}), /Unknown geometry job/);
});
