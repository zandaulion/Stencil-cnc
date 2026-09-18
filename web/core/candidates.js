import { REMOVED, RETAINED, assertMask, cloneMask } from './mask.js';

export const CANDIDATE_PAYLOAD_VERSION = 4;

function validIndices(values) {
  if (!values || typeof values[Symbol.iterator] !== 'function') return [];
  return values;
}

/**
 * Gives an explicit hand-painted value precedence over the opposite generated
 * repair at the same raster cell. Matching repairs are not conflicts and stay
 * in the reversible layer. The layer is mutated deliberately because editor
 * strokes may touch thousands of cells and cloning both repair sets per cell
 * would make freehand work noticeably laggy.
 */
export function retireConflictingRepairEdit(manufacturingRepairs, index, manualValue) {
  if (!manufacturingRepairs || manufacturingRepairs.stale === true ||
      !Number.isInteger(index) || index < 0) return false;
  const conflicting = manualValue === RETAINED
    ? manufacturingRepairs.remove
    : manualValue === REMOVED
      ? manufacturingRepairs.keep
      : null;
  if (!(conflicting instanceof Set) || !conflicting.delete(index)) return false;
  const previous = Number(manufacturingRepairs.summary?.manualOverrideCount) || 0;
  manufacturingRepairs.summary = {
    ...(manufacturingRepairs.summary ?? {}),
    manualOverrideCount: previous + 1,
  };
  return true;
}

/**
 * Applies the two reversible raster-edit layers in their canonical order.
 * A clone is returned by default so candidate comparisons never mutate their
 * recipe. The editor may opt into in-place application while rebuilding its
 * already-disposable working raster.
 */
export function applyRasterLayers(
  mask,
  { painted = null, manufacturingRepairs = null } = {},
  { clone = true } = {},
) {
  assertMask(mask);
  const result = clone ? cloneMask(mask) : mask;
  for (const index of validIndices(painted?.keep)) {
    if (Number.isInteger(index) && index >= 0 && index < result.data.length) result.data[index] = RETAINED;
  }
  for (const index of validIndices(painted?.remove)) {
    if (Number.isInteger(index) && index >= 0 && index < result.data.length) result.data[index] = REMOVED;
  }
  if (manufacturingRepairs?.enabled !== false && manufacturingRepairs?.stale !== true) {
    for (const index of validIndices(manufacturingRepairs?.keep)) {
      if (Number.isInteger(index) && index >= 0 && index < result.data.length) result.data[index] = RETAINED;
    }
    for (const index of validIndices(manufacturingRepairs?.remove)) {
      if (Number.isInteger(index) && index >= 0 && index < result.data.length) result.data[index] = REMOVED;
    }
  }
  return result;
}

/**
 * A compact deterministic identity for detecting recipe drift. This is an
 * integrity hint, not a cryptographic or manufacturing-safety certificate.
 */
export function maskFingerprint(mask) {
  assertMask(mask);
  let hash = 0x811c9dc5;
  const mix = (value) => {
    hash ^= value & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  for (const dimension of [mask.width, mask.height]) {
    for (const shift of [0, 8, 16, 24]) mix(dimension >>> shift);
  }
  for (const value of mask.data) mix(value);
  return `fnv1a32:${mask.width}x${mask.height}:${hash.toString(16).padStart(8, '0')}`;
}
