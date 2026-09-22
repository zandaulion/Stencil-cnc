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

test('project masks are RLE encoded by the background worker task', () => {
  const sourceMask = maskFromAscii(['##..#']);
  const baseMask = maskFromAscii(['#.#.#']);
  const result = executeGeometryJob('encode-project-masks', { sourceMask, baseMask });

  assert.deepEqual(result.sourceMask.runs, [2, 2, 1]);
  assert.deepEqual(result.baseMask.runs, [1, 1, 1, 1, 1]);
  assert.doesNotThrow(() => structuredClone(result));
});

test('vector preparation and post-fit manufacturing validation stay off-thread and cloneable', () => {
  const rows = Array.from({ length: 20 }, (_, y) => (
    Array.from({ length: 20 }, (_, x) => (
      y >= 2 && y < 18 && x >= 2 && x < 10 + (y % 2) ? '#' : '.'
    )).join('')
  ));
  const mask = maskFromAscii(rows);
  const phases = [];
  const result = executeGeometryJob('vector-prepare', {
    mask,
    sheet: { widthMm: 200, heightMm: 200 },
    exactCircleHoles: [],
    options: { simplify: true, toleranceMm: 6 },
    validationOptions: {
      ...validationOptions,
      sheet: { widthMm: 200, heightMm: 200 },
      minimumWebMm: 0,
      minimumOpeningMm: 0,
    },
  }, (phase) => phases.push(phase));

  assert.equal(result.prepared.report.status, 'simplified');
  assert.equal(result.changesRasterResult, true);
  assert.ok(result.postFitValidation);
  assert.deepEqual(phases, ['simplifying', 'checking']);
  assert.doesNotThrow(() => structuredClone(result));
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
