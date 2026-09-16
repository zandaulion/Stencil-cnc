import { REMOVED, RETAINED, assertMask, cloneMask } from './mask.js';

export const CANDIDATE_PAYLOAD_VERSION = 3;

function validIndices(values) {
  if (!values || typeof values[Symbol.iterator] !== 'function') return [];
  return values;
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
