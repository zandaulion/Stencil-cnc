import { REMOVED, RETAINED, assertMask, assertSheet, cloneMask, createMask, pixelSizeMm } from "./mask.js";

/**
 * Conservative binary erosion using a physical circular tool radius. The
 * boundary of a neighbouring pixel cell, rather than only its centre, is used
 * for the distance test. This makes sub-pixel limitations explicit and stable.
 *
 * @param {import('./mask.js').RasterMask} mask
 * @param {number} radiusMm
 * @param {{ widthMm: number, heightMm: number }} sheet
 * @param {{ outsideIsRemoved?: boolean }} [options]
 */
export function erodeMaskPhysical(mask, radiusMm, sheet, options = {}) {
  assertMask(mask);
  assertSheet(sheet);
  validateRadius(radiusMm);
  if (radiusMm === 0) return cloneMask(mask);

  const output = createMask(mask.width, mask.height);
  const offsets = physicalOffsets(mask, radiusMm, sheet);
  const outsideIsRemoved = options.outsideIsRemoved === true;

  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      const index = y * mask.width + x;
      if (mask.data[index] !== RETAINED) continue;
      let keep = true;
      for (const [dx, dy] of offsets) {
        const testX = x + dx;
        const testY = y + dy;
        if (testX < 0 || testY < 0 || testX >= mask.width || testY >= mask.height) {
          if (outsideIsRemoved) {
            keep = false;
            break;
          }
          continue;
        }
        if (mask.data[testY * mask.width + testX] === REMOVED) {
          keep = false;
          break;
        }
      }
      if (keep) output.data[index] = RETAINED;
    }
  }
  return output;
}

/**
 * Physical circular dilation, primarily used to estimate areas that cannot
 * contain the requested minimum-width material core.
 *
 * @param {import('./mask.js').RasterMask} mask
 * @param {number} radiusMm
 * @param {{ widthMm: number, heightMm: number }} sheet
 */
export function dilateMaskPhysical(mask, radiusMm, sheet) {
  assertMask(mask);
  assertSheet(sheet);
  validateRadius(radiusMm);
  if (radiusMm === 0) return cloneMask(mask);

  const output = createMask(mask.width, mask.height);
  const offsets = physicalOffsets(mask, radiusMm, sheet);
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      const index = y * mask.width + x;
      if (mask.data[index] === RETAINED) {
        output.data[index] = RETAINED;
        continue;
      }
      for (const [dx, dy] of offsets) {
        const testX = x + dx;
        const testY = y + dy;
        if (testX >= 0 && testY >= 0 && testX < mask.width && testY < mask.height &&
            mask.data[testY * mask.width + testX] === RETAINED) {
          output.data[index] = RETAINED;
          break;
        }
      }
    }
  }
  return output;
}

/**
 * @param {import('./mask.js').RasterMask} mask
 * @param {number} radiusMm
 * @param {{ widthMm: number, heightMm: number }} sheet
 */
function physicalOffsets(mask, radiusMm, sheet) {
  const pixel = pixelSizeMm(mask, sheet);
  const limitX = Math.ceil(radiusMm / pixel.x + 0.5);
  const limitY = Math.ceil(radiusMm / pixel.y + 0.5);
  const radiusSquared = radiusMm ** 2;
  const offsets = [];

  for (let dy = -limitY; dy <= limitY; dy += 1) {
    for (let dx = -limitX; dx <= limitX; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const distanceX = Math.max(0, (Math.abs(dx) - 0.5) * pixel.x);
      const distanceY = Math.max(0, (Math.abs(dy) - 0.5) * pixel.y);
      if (distanceX ** 2 + distanceY ** 2 <= radiusSquared + Number.EPSILON) offsets.push([dx, dy]);
    }
  }
  return offsets;
}

function validateRadius(radiusMm) {
  if (!Number.isFinite(radiusMm) || radiusMm < 0) {
    throw new RangeError("Physical radius must be a non-negative finite number");
  }
}
