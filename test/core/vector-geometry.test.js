import test from 'node:test';
import assert from 'node:assert/strict';

import {
  exportDxf,
  exportSvg,
  prepareVectorGeometry,
  traceMaskContours,
  validateVectorGeometry,
  vectorManufacturingValidationRegressed,
} from '../../web/core/index.js';
import { maskFromAscii } from './fixtures.js';

test('physical-tolerance simplification reduces nodes without exceeding its bound', () => {
  const rows = Array.from({ length: 20 }, (_, y) => (
    Array.from({ length: 20 }, (_, x) => (
      y >= 2 && y < 18 && x >= 2 && x < 10 + (y % 2) ? '#' : '.'
    )).join('')
  ));
  const mask = maskFromAscii(rows);
  const prepared = prepareVectorGeometry(mask, { widthMm: 200, heightMm: 200 }, [], {
    simplify: true,
    toleranceMm: 6,
  });

  assert.equal(prepared.report.status, 'simplified');
  assert.ok(prepared.report.outputVertexCount < prepared.report.sourceVertexCount);
  assert.ok(prepared.report.maximumDeviationMm <= prepared.report.appliedToleranceMm);
  assert.equal(prepared.report.topologyValidated, true);
  assert.deepEqual(prepared.rasterMask.data.length, mask.data.length);
});

test('vector validation rejects a self-intersecting replacement contour', () => {
  const mask = maskFromAscii([
    '####',
    '####',
    '####',
    '####',
  ]);
  const source = traceMaskContours(mask);
  const crossed = [[source[0][0], source[0][2], source[0][1], source[0][3]]];
  const validation = validateVectorGeometry(
    source,
    crossed,
    mask,
    { widthMm: 40, heightMm: 40 },
    [],
    100,
  );

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => /self-intersects|collapsed/i.test(error)));
});

test('prepared vectors are the geometry written by SVG and DXF exporters', () => {
  const mask = maskFromAscii([
    '####',
    '####',
    '####',
    '####',
  ]);
  const preparedGeometry = {
    contours: [[
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 2, y: 4 },
    ]],
    matchedCircles: [],
  };

  const svg = exportSvg(mask, { widthMm: 40, heightMm: 40 }, { preparedGeometry });
  const dxf = exportDxf(mask, { widthMm: 40, heightMm: 40 }, { preparedGeometry });
  assert.match(svg, /d="M0 0L40 0L20 40Z"/);
  assert.match(dxf, /\n90\n3\n70\n1\n/);
});

test('exact circle substitutions are rasterized for post-fit manufacturing checks', () => {
  const mask = maskFromAscii([
    '#####',
    '#...#',
    '#...#',
    '#...#',
    '#####',
  ]);
  const prepared = prepareVectorGeometry(
    mask,
    { widthMm: 5, heightMm: 5 },
    [{ cxMm: 2.5, cyMm: 2.5, radiusMm: 1.5 }],
    { simplify: false },
  );

  assert.equal(prepared.matchedCircles.length, 1);
  assert.notEqual(prepared.rasterMask, mask);
  assert.deepEqual(prepared.rasterMask.data, mask.data);
});

test('post-fit validation fails closed on blockers and advisory regressions', () => {
  const warning = (code, locations) => ({
    code,
    severity: 'warning',
    details: { locations: Array.from({ length: locations }, () => ({})) },
  });
  const baseline = { valid: true, issues: [warning('MIN_WEB', 2)] };

  assert.equal(vectorManufacturingValidationRegressed(
    baseline,
    { valid: true, issues: [warning('MIN_WEB', 2)] },
  ), false);
  assert.equal(vectorManufacturingValidationRegressed(
    baseline,
    { valid: true, issues: [warning('MIN_WEB', 3)] },
  ), true);
  assert.equal(vectorManufacturingValidationRegressed(
    baseline,
    { valid: true, issues: [warning('RASTER_LIMIT', 1)] },
  ), true);
  assert.equal(vectorManufacturingValidationRegressed(
    baseline,
    { valid: false, issues: [{ code: 'DISCONNECTED', severity: 'error' }] },
  ), true);
});
