import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  createMask,
  createReleaseManifest,
  effectiveRasterResolution,
  normalizeReleaseManifest,
} from '../../web/core/index.js';

function fixtureMask() {
  const mask = createMask(4, 2);
  mask.data.set([1, 1, 0, 0, 1, 0, 1, 0]);
  return mask;
}

test('effective raster resolution reports physical cell size on each axis', () => {
  assert.deepEqual(effectiveRasterResolution(fixtureMask(), { widthMm: 20, heightMm: 20 }), {
    widthCells: 4,
    heightCells: 2,
    mmPerCellX: 5,
    mmPerCellY: 10,
    maximumCellMm: 10,
  });
});

test('release manifests bind exact geometry, export bytes, profile, and validation evidence', async () => {
  const blob = new Blob(['exact svg bytes'], { type: 'image/svg+xml' });
  const manifest = await createReleaseManifest({
    releaseId: 'release-1',
    createdAt: '2026-09-21T10:00:00.000Z',
    projectId: 'project-1',
    projectName: 'Portrait',
    projectRevision: 8,
    projectSchema: 'stencil-cnc.project',
    projectVersion: 6,
    mask: fixtureMask(),
    sheet: { widthMm: 20, heightMm: 20 },
    filename: 'portrait.svg',
    kind: 'svg',
    mimeType: blob.type,
    blob,
    drawingUnits: 'mm',
    profileSnapshot: { schema: 'stencil-cnc.cutting-profile', version: 1, name: 'Shop profile' },
    geometryInterpretation: 'finished-boundary-cam-v1',
    validation: {
      valid: true,
      issues: [{ severity: 'warning', code: 'MIN_WEB', message: 'Review this web', details: { locations: [{}, {}] } }],
    },
    validationRevision: 8,
    validatedAt: '2026-09-21T09:59:00.000Z',
    validationModelVersion: 1,
  });

  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(manifest.validation.status, 'validated');
  assert.equal(manifest.validation.warnings[0].locations, 2);
  assert.equal(manifest.geometry.mmPerCellX, 5);
  assert.equal(manifest.outputs[0].sha256, createHash('sha256').update('exact svg bytes').digest('hex'));
  assert.deepEqual(normalizeReleaseManifest(manifest), manifest);
});

test('a draft manifest does not reuse validation from an older working revision', async () => {
  const blob = new Blob(['preview'], { type: 'image/png' });
  const manifest = await createReleaseManifest({
    releaseId: 'release-2',
    createdAt: '2026-09-21T10:00:00.000Z',
    projectName: 'Draft',
    projectRevision: 9,
    projectSchema: 'stencil-cnc.project',
    projectVersion: 6,
    mask: fixtureMask(),
    sheet: { widthMm: 20, heightMm: 20 },
    filename: 'draft.png',
    kind: 'png',
    mimeType: blob.type,
    blob,
    drawingUnits: 'mm',
    profileSnapshot: {},
    geometryInterpretation: 'finished-boundary-cam-v1',
    validation: { valid: true, issues: [] },
    validationRevision: 8,
    validatedAt: '2026-09-21T09:59:00.000Z',
    validationModelVersion: 1,
  });

  assert.equal(manifest.validation.status, 'not-current');
  assert.equal(manifest.validation.validatedAt, null);
});
