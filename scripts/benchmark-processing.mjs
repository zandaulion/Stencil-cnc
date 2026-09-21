import { performance } from 'node:perf_hooks';

import { createMask } from '../web/core/mask.js';
import { executeGeometryJob } from '../web/core/geometry-jobs.js';
import { FINISHED_BOUNDARY_CAM } from '../web/core/geometry-contract.js';

function slatFixture(width, height, { pitch = 18, bar = 8, frame = 4 } = {}) {
  const mask = createMask(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const border = x < frame || y < frame || x >= width - frame || y >= height - frame;
      const slat = ((x + Math.round(y * 0.65)) % pitch) < bar;
      if (border || slat) mask.data[y * width + x] = 1;
    }
  }
  return mask;
}

function options(sheet) {
  return {
    sheet,
    kerfMm: 1.2,
    minimumWebMm: 3,
    minimumOpeningMm: 2,
    geometryInterpretation: FINISHED_BOUNDARY_CAM,
    anchorBoundary: false,
    requireAnchored: false,
    requireSingleComponent: true,
  };
}

function timed(label, operation) {
  const startedAt = performance.now();
  const value = operation();
  return { label, milliseconds: Math.round((performance.now() - startedAt) * 10) / 10, value };
}

const fixtures = [
  { name: 'A3 portrait · 420 × 594 cells', sheet: { widthMm: 297, heightMm: 420 }, mask: slatFixture(420, 594) },
  { name: 'Large portrait · 450 × 900 cells', sheet: { widthMm: 1250, heightMm: 2500 }, mask: slatFixture(450, 900, { pitch: 15, bar: 6 }) },
];

const results = fixtures.map(({ name, sheet, mask }) => {
  const measurement = timed(name, () => executeGeometryJob('validate', { mask, options: options(sheet) }));
  return {
    fixture: name,
    cells: mask.data.length,
    validationMs: measurement.milliseconds,
    blockingLocations: measurement.value.issues
      .filter((issue) => issue.severity === 'error')
      .reduce((sum, issue) => sum + (issue.details?.locations?.length ?? 1), 0),
  };
});

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  runtime: process.version,
  architecture: process.arch,
  results,
}, null, 2));
