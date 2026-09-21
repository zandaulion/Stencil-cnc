import { assertMask, assertSheet } from './mask.js';

export const RELEASE_MANIFEST_SCHEMA = 'kerfloom.manufacturing-release';
export const RELEASE_MANIFEST_VERSION = 1;
export const RASTER_BOUNDARY_EXPORTER_VERSION = 1;

const SHA256 = /^[0-9a-f]{64}$/;

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

async function sha256Parts(parts) {
  const bytes = await new Blob(parts).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256Blob(blob) {
  if (!(blob instanceof Blob)) throw new TypeError('An export Blob is required');
  return sha256Parts([blob]);
}

export function effectiveRasterResolution(mask, sheet) {
  assertMask(mask);
  assertSheet(sheet);
  const mmPerCellX = sheet.widthMm / mask.width;
  const mmPerCellY = sheet.heightMm / mask.height;
  return {
    widthCells: mask.width,
    heightCells: mask.height,
    mmPerCellX,
    mmPerCellY,
    maximumCellMm: Math.max(mmPerCellX, mmPerCellY),
  };
}

function findingSnapshot(issue) {
  const locations = Array.isArray(issue?.details?.locations)
    ? issue.details.locations.length
    : Number.isFinite(issue?.details?.violationCount)
      ? issue.details.violationCount
      : 1;
  return {
    code: String(issue?.code || 'UNKNOWN'),
    message: String(issue?.message || 'Unlabelled validation finding'),
    locations: Math.max(1, Math.floor(locations)),
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

/**
 * Captures the exact raster and output bytes used for one retained export.
 * The returned object is frozen; persistence stores it as append-only artefact
 * metadata rather than copying it into mutable project settings.
 */
export async function createReleaseManifest({
  releaseId = crypto.randomUUID(),
  createdAt = new Date().toISOString(),
  projectId = null,
  projectName,
  projectRevision,
  projectSchema,
  projectVersion,
  mask,
  sheet,
  exactCircleHoles = [],
  filename,
  kind,
  mimeType,
  blob,
  drawingUnits,
  profileSnapshot,
  geometryInterpretation,
  validation,
  validationRevision,
  validatedAt,
  validationModelVersion,
}) {
  assertMask(mask);
  assertSheet(sheet);
  if (!(blob instanceof Blob)) throw new TypeError('An export Blob is required');
  const resolution = effectiveRasterResolution(mask, sheet);
  const circles = Array.isArray(exactCircleHoles) ? exactCircleHoles.map((circle) => ({
    cxMm: Number(circle.cxMm),
    cyMm: Number(circle.cyMm),
    radiusMm: Number(circle.radiusMm),
  })) : [];
  const rasterHeader = canonicalJson({
    schema: 'kerfloom.raster-geometry',
    version: 1,
    width: mask.width,
    height: mask.height,
  });
  const rasterSha256 = await sha256Parts([rasterHeader, '\n', mask.data]);
  const geometrySha256 = await sha256Parts([
    canonicalJson({ rasterSha256, sheet, exactCircleHoles: circles }),
  ]);
  const outputSha256 = await sha256Blob(blob);
  const currentValidation = validation && validationRevision === projectRevision;
  const findings = currentValidation && Array.isArray(validation.issues) ? validation.issues : [];
  const warnings = findings.filter((issue) => issue.severity === 'warning').map(findingSnapshot);
  const blockers = findings.filter((issue) => issue.severity === 'error').map(findingSnapshot);
  const validationStatus = currentValidation
    ? validation.valid === true ? 'validated' : 'checked-with-blockers'
    : 'not-current';

  const content = {
    schema: RELEASE_MANIFEST_SCHEMA,
    version: RELEASE_MANIFEST_VERSION,
    releaseId: String(releaseId),
    createdAt: String(createdAt),
    project: {
      id: projectId == null ? null : String(projectId),
      name: String(projectName || 'Untitled panel'),
      workingRevision: Number(projectRevision) || 0,
      schema: String(projectSchema),
      version: Number(projectVersion),
    },
    sheet: {
      widthMm: sheet.widthMm,
      heightMm: sheet.heightMm,
      drawingUnits: drawingUnits === 'in' ? 'in' : 'mm',
    },
    geometry: {
      sha256: geometrySha256,
      rasterSha256,
      rasterWidthCells: resolution.widthCells,
      rasterHeightCells: resolution.heightCells,
      mmPerCellX: resolution.mmPerCellX,
      mmPerCellY: resolution.mmPerCellY,
      exactCircleHoleCount: circles.length,
      representation: 'grid-aligned-raster-boundaries-v1',
      approximationNote: 'Coordinate decimals do not improve the source raster resolution.',
    },
    compensation: {
      geometryInterpretation: String(geometryInterpretation),
      includedInExport: false,
      camResponsibility: 'Apply inside/outside kerf compensation exactly once in CAM.',
    },
    profileSnapshot: cloneJson(profileSnapshot),
    processing: {
      rasterBoundaryExporterVersion: RASTER_BOUNDARY_EXPORTER_VERSION,
      validationModelVersion: Number(validationModelVersion),
    },
    validation: {
      status: validationStatus,
      workingRevision: currentValidation ? Number(validationRevision) : null,
      validatedAt: currentValidation && validatedAt ? String(validatedAt) : null,
      warnings,
      blockers,
    },
    outputs: [{
      filename: String(filename),
      kind: String(kind),
      mimeType: String(mimeType || blob.type || 'application/octet-stream'),
      bytes: blob.size,
      sha256: outputSha256,
    }],
  };
  const manifestSha256 = await sha256Parts([canonicalJson(content)]);
  return deepFreeze({ ...content, manifestSha256 });
}

export function normalizeReleaseManifest(input) {
  if (input == null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Release manifest must be an object');
  }
  if (input.schema !== RELEASE_MANIFEST_SCHEMA || input.version !== RELEASE_MANIFEST_VERSION) {
    throw new RangeError('Unsupported release manifest');
  }
  if (!SHA256.test(String(input.manifestSha256)) || !SHA256.test(String(input.geometry?.sha256))) {
    throw new TypeError('Release manifest hashes are invalid');
  }
  if (!Array.isArray(input.outputs) || input.outputs.length !== 1 ||
      !SHA256.test(String(input.outputs[0]?.sha256))) {
    throw new TypeError('Release manifest output is invalid');
  }
  return cloneJson(input);
}
