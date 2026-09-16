export const FINISHED_BOUNDARY_CAM = "finished-boundary-cam-v1";
export const LEGACY_UNCOMPENSATED_CENTERLINE = "legacy-uncompensated-centerline-v1";

export const GEOMETRY_INTERPRETATIONS = Object.freeze([
  FINISHED_BOUNDARY_CAM,
  LEGACY_UNCOMPENSATED_CENTERLINE,
]);

export function normalizeGeometryInterpretation(value = FINISHED_BOUNDARY_CAM) {
  if (!GEOMETRY_INTERPRETATIONS.includes(value)) {
    throw new RangeError(`Unsupported geometry interpretation: ${value}`);
  }
  return value;
}

export function isLegacyGeometryInterpretation(value) {
  return normalizeGeometryInterpretation(value) === LEGACY_UNCOMPENSATED_CENTERLINE;
}

/**
 * Width that must exist in the stored raster for the requested finished web.
 * Finished-boundary geometry already describes the final edge. Legacy rasters
 * described uncompensated cutter-centre geometry and therefore need a complete
 * kerf of sacrificial width, half on either side of a web.
 */
export function rasterWebWidthMm(minimumWebMm, kerfMm, interpretation = FINISHED_BOUNDARY_CAM) {
  assertNonNegative(minimumWebMm, "minimumWebMm");
  assertNonNegative(kerfMm, "kerfMm");
  return minimumWebMm + (isLegacyGeometryInterpretation(interpretation) ? kerfMm : 0);
}

/**
 * A compensated internal contour needs room for its inward tool-centre
 * offset. The configured opening may be stricter, but it cannot be smaller
 * than the cutter itself and still contain a closed compensated path.
 */
export function requiredOpeningMm(minimumOpeningMm, kerfMm) {
  assertNonNegative(minimumOpeningMm, "minimumOpeningMm");
  assertNonNegative(kerfMm, "kerfMm");
  return Math.max(minimumOpeningMm, kerfMm);
}

export function kerfErosionMm(kerfMm, interpretation = FINISHED_BOUNDARY_CAM) {
  assertNonNegative(kerfMm, "kerfMm");
  return isLegacyGeometryInterpretation(interpretation) ? kerfMm : 0;
}

function assertNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
}
