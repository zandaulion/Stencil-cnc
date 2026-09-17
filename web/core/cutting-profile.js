export const CUTTING_PROFILE_SCHEMA = 'kerfloom.cutting-profile';
export const CUTTING_PROFILE_VERSION = 1;

// Version 1 has one honest process contract. Future schema versions can add
// laser/router/waterjet semantics once their generators and checks are real.
const PROCESSES = new Set(['plasma']);
const PROVENANCE_KINDS = new Set([
  'kerfloom-default',
  'legacy-project',
  'custom',
  'machine-documentation',
  'shop-test',
]);

const DEFAULT_PROFILE = Object.freeze({
  schema: CUTTING_PROFILE_SCHEMA,
  version: CUTTING_PROFILE_VERSION,
  id: 'general-plasma-v1',
  name: 'General plasma starting point',
  revision: 1,
  status: 'provisional',
  process: 'plasma',
  material: Object.freeze({ name: null, grade: null, thicknessMm: null }),
  machine: Object.freeze({ name: null, consumable: null }),
  limits: Object.freeze({
    kerfMm: 1.2,
    minimumWebMm: 3,
    minimumOpeningMm: 2,
    supportWidthMm: 6,
    maximumUnsupportedSpanMm: 250,
  }),
  provenance: Object.freeze({
    kind: 'kerfloom-default',
    note: 'Conservative starting values only; confirm them with machine documentation or shop test coupons.',
    verifiedBy: null,
    verifiedAt: null,
  }),
});

export function createCuttingProfile(overrides = {}) {
  return normalizeCuttingProfile({
    ...DEFAULT_PROFILE,
    ...overrides,
    material: { ...DEFAULT_PROFILE.material, ...overrides.material },
    machine: { ...DEFAULT_PROFILE.machine, ...overrides.machine },
    limits: { ...DEFAULT_PROFILE.limits, ...overrides.limits },
    provenance: { ...DEFAULT_PROFILE.provenance, ...overrides.provenance },
  });
}

export function legacyCuttingProfile(manufacturing = {}) {
  return normalizeCuttingProfile({
    ...DEFAULT_PROFILE,
    id: null,
    name: 'Legacy project settings',
    status: 'provisional',
    limits: {
      kerfMm: manufacturing.kerfMm ?? DEFAULT_PROFILE.limits.kerfMm,
      minimumWebMm: manufacturing.minimumWebMm ?? DEFAULT_PROFILE.limits.minimumWebMm,
      minimumOpeningMm: manufacturing.minimumOpeningMm ?? DEFAULT_PROFILE.limits.minimumOpeningMm,
      supportWidthMm: manufacturing.supportWidthMm ?? DEFAULT_PROFILE.limits.supportWidthMm,
      maximumUnsupportedSpanMm:
        manufacturing.maximumCantileverMm ?? DEFAULT_PROFILE.limits.maximumUnsupportedSpanMm,
    },
    provenance: {
      kind: 'legacy-project',
      note: 'Migrated from project-level manufacturing values; confirm against the actual machine, stock, and consumable.',
      verifiedBy: null,
      verifiedAt: null,
    },
  });
}

export function normalizeCuttingProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('cutting profile must be an object');
  }
  if (input.schema !== CUTTING_PROFILE_SCHEMA) {
    throw new RangeError(`Unsupported cutting profile schema: ${input.schema}`);
  }
  if (input.version !== CUTTING_PROFILE_VERSION) {
    throw new RangeError(`Unsupported cutting profile version: ${input.version}`);
  }
  if (!PROCESSES.has(input.process)) throw new RangeError(`Unsupported cutting process: ${input.process}`);
  if (!PROVENANCE_KINDS.has(input.provenance?.kind)) {
    throw new RangeError(`Unsupported cutting profile provenance: ${input.provenance?.kind}`);
  }
  if (input.status !== 'provisional' && input.status !== 'verified') {
    throw new RangeError('cutting profile status must be provisional or verified');
  }

  const normalized = {
    schema: CUTTING_PROFILE_SCHEMA,
    version: CUTTING_PROFILE_VERSION,
    id: nullableString(input.id, 'cutting profile id'),
    name: requiredString(input.name, 'cutting profile name'),
    revision: positiveInteger(input.revision, 'cutting profile revision'),
    status: input.status,
    process: input.process,
    material: {
      name: nullableString(input.material?.name, 'material name'),
      grade: nullableString(input.material?.grade, 'material grade'),
      thicknessMm: nullablePositive(input.material?.thicknessMm, 'material thickness'),
    },
    machine: {
      name: nullableString(input.machine?.name, 'machine name'),
      consumable: nullableString(input.machine?.consumable, 'machine consumable'),
    },
    limits: {
      kerfMm: nonNegative(input.limits?.kerfMm, 'profile kerf'),
      minimumWebMm: positive(input.limits?.minimumWebMm, 'profile minimum web'),
      minimumOpeningMm: positive(input.limits?.minimumOpeningMm, 'profile minimum opening'),
      supportWidthMm: nullablePositive(input.limits?.supportWidthMm, 'profile support width'),
      maximumUnsupportedSpanMm: nullablePositive(
        input.limits?.maximumUnsupportedSpanMm,
        'profile maximum unsupported span',
      ),
    },
    provenance: {
      kind: input.provenance.kind,
      note: nullableString(input.provenance?.note, 'profile evidence note'),
      verifiedBy: nullableString(input.provenance?.verifiedBy, 'profile verifier'),
      verifiedAt: nullableTimestamp(input.provenance?.verifiedAt, 'profile verification date'),
    },
  };
  const problems = cuttingProfileVerificationProblems(normalized);
  if (normalized.status === 'verified' && problems.length) {
    throw new RangeError(`Verified cutting profile is missing evidence: ${problems.join(', ')}`);
  }
  return normalized;
}

export function cuttingProfileVerificationProblems(profile) {
  const problems = [];
  if (!['machine-documentation', 'shop-test'].includes(profile?.provenance?.kind)) {
    problems.push('machine documentation or shop test source');
  }
  if (!profile?.material?.name?.trim()) problems.push('material');
  if (!Number.isFinite(profile?.material?.thicknessMm) || profile.material.thicknessMm <= 0) {
    problems.push('stock thickness');
  }
  if (!profile?.machine?.name?.trim()) problems.push('machine');
  if (!profile?.provenance?.note?.trim()) problems.push('evidence note');
  if (!profile?.provenance?.verifiedBy?.trim()) problems.push('verified by');
  if (!profile?.provenance?.verifiedAt) problems.push('verification date');
  return problems;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function nullableString(value, name) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError(`${name} must be null or a string`);
  return value.trim() || null;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

function nonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative`);
  return value;
}

function nullablePositive(value, name) {
  if (value == null || value === '') return null;
  return positive(value, name);
}

function nullableTimestamp(value, name) {
  const normalized = nullableString(value, name);
  if (normalized == null) return null;
  if (!Number.isFinite(Date.parse(normalized))) throw new RangeError(`${name} must be an ISO timestamp`);
  return normalized;
}
