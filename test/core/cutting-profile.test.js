import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CUTTING_PROFILE_SCHEMA,
  CUTTING_PROFILE_VERSION,
  createCuttingProfile,
  cuttingProfileVerificationProblems,
  legacyCuttingProfile,
  normalizeCuttingProfile,
} from '../../web/core/index.js';

test('the reusable plasma starting profile is explicitly provisional', () => {
  const profile = createCuttingProfile();

  assert.equal(profile.schema, CUTTING_PROFILE_SCHEMA);
  assert.equal(profile.version, CUTTING_PROFILE_VERSION);
  assert.equal(profile.id, 'general-plasma-v1');
  assert.equal(profile.revision, 1);
  assert.equal(profile.status, 'provisional');
  assert.equal(profile.process, 'plasma');
  assert.deepEqual(profile.limits, {
    kerfMm: 1.2,
    minimumWebMm: 3,
    minimumOpeningMm: 2,
    supportWidthMm: 6,
    maximumUnsupportedSpanMm: 250,
  });
  assert.ok(cuttingProfileVerificationProblems(profile).length > 0);
});

test('verified status requires recorded shop or machine evidence', () => {
  assert.throws(
    () => createCuttingProfile({ status: 'verified' }),
    /missing evidence/,
  );

  const verifiedAt = '2026-09-17T10:00:00.000Z';
  const verified = createCuttingProfile({
    id: null,
    name: 'Shop plasma · 2 mm mild steel',
    revision: 4,
    status: 'verified',
    material: { name: 'Mild steel', grade: 'S235', thicknessMm: 2 },
    machine: { name: 'Table A', consumable: '45 A fine-cut' },
    provenance: {
      kind: 'shop-test',
      note: 'Coupon KF-17 measured after cooling.',
      verifiedBy: 'Workshop owner',
      verifiedAt,
    },
  });

  assert.equal(verified.status, 'verified');
  assert.equal(verified.provenance.verifiedAt, verifiedAt);
  assert.deepEqual(cuttingProfileVerificationProblems(verified), []);
  assert.deepEqual(normalizeCuttingProfile(JSON.parse(JSON.stringify(verified))), verified);
});

test('version 1 refuses process labels whose manufacturing contract is not implemented', () => {
  assert.throws(
    () => createCuttingProfile({ process: 'laser' }),
    /Unsupported cutting process/,
  );
});

test('legacy manufacturing values migrate without being certified', () => {
  const profile = legacyCuttingProfile({
    kerfMm: 0.9,
    minimumWebMm: 2.4,
    minimumOpeningMm: 1.8,
    supportWidthMm: 5,
    maximumCantileverMm: 180,
  });

  assert.equal(profile.id, null);
  assert.equal(profile.name, 'Legacy project settings');
  assert.equal(profile.status, 'provisional');
  assert.equal(profile.provenance.kind, 'legacy-project');
  assert.deepEqual(profile.limits, {
    kerfMm: 0.9,
    minimumWebMm: 2.4,
    minimumOpeningMm: 1.8,
    supportWidthMm: 5,
    maximumUnsupportedSpanMm: 180,
  });
});
