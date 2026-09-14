/**
 * A RasterMask is the canonical geometry representation used by the core.
 * Values are semantic, never colour values: 1 means retained material and
 * 0 means material removed by the CNC process.
 *
 * @typedef {{ width: number, height: number, data: Uint8Array }} RasterMask
 */

export const REMOVED = 0;
export const RETAINED = 1;

const INTEGER_ERROR = "Mask dimensions must be positive integers";

/** @param {number} width @param {number} height */
export function assertDimensions(width, height) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new TypeError(INTEGER_ERROR);
  }
}

/** @param {unknown} value @returns {asserts value is RasterMask} */
export function assertMask(value) {
  if (!value || typeof value !== "object") {
    throw new TypeError("Expected a raster mask");
  }

  const mask = /** @type {RasterMask} */ (value);
  assertDimensions(mask.width, mask.height);
  if (!(mask.data instanceof Uint8Array) || mask.data.length !== mask.width * mask.height) {
    throw new TypeError("Mask data must be a Uint8Array matching width × height");
  }
}

/**
 * @param {number} width
 * @param {number} height
 * @param {0 | 1 | boolean} [fill]
 * @returns {RasterMask}
 */
export function createMask(width, height, fill = REMOVED) {
  assertDimensions(width, height);
  const data = new Uint8Array(width * height);
  if (fill === true || fill === RETAINED) data.fill(RETAINED);
  return { width, height, data };
}

/** @param {RasterMask} mask @returns {RasterMask} */
export function cloneMask(mask) {
  assertMask(mask);
  return { width: mask.width, height: mask.height, data: mask.data.slice() };
}

/**
 * Creates a semantic mask from any array-like binary input.
 * Truthy values become retained material.
 *
 * @param {number} width
 * @param {number} height
 * @param {ArrayLike<unknown>} values
 * @returns {RasterMask}
 */
export function maskFromBinary(width, height, values) {
  assertDimensions(width, height);
  if (!values || values.length !== width * height) {
    throw new RangeError("Binary mask data must match width × height");
  }

  const mask = createMask(width, height);
  for (let i = 0; i < values.length; i += 1) {
    mask.data[i] = values[i] ? RETAINED : REMOVED;
  }
  return mask;
}

/**
 * Converts RGBA pixels to the semantic retained-material mask.
 * By default dark pixels are retained. `invert` reverses that mapping.
 * Transparency is composited onto a configurable background before thresholding.
 *
 * @param {{ width: number, height: number, data: ArrayLike<number> }} imageData
 * @param {{ threshold?: number, invert?: boolean, backgroundLuminance?: number }} [options]
 * @returns {RasterMask}
 */
export function maskFromImageData(imageData, options = {}) {
  if (!imageData || typeof imageData !== "object") {
    throw new TypeError("Expected ImageData-like input");
  }
  const { width, height, data } = imageData;
  assertDimensions(width, height);
  if (!data || data.length !== width * height * 4) {
    throw new RangeError("RGBA data must contain exactly width × height × 4 entries");
  }

  const threshold = finiteInRange(options.threshold ?? 128, 0, 255, "threshold");
  const background = finiteInRange(
    options.backgroundLuminance ?? 255,
    0,
    255,
    "backgroundLuminance",
  );
  const invert = options.invert === true;
  const mask = createMask(width, height);

  for (let pixel = 0, offset = 0; pixel < mask.data.length; pixel += 1, offset += 4) {
    const red = finiteChannel(data[offset]);
    const green = finiteChannel(data[offset + 1]);
    const blue = finiteChannel(data[offset + 2]);
    const alpha = finiteChannel(data[offset + 3]) / 255;
    const sourceLuminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    const luminance = sourceLuminance * alpha + background * (1 - alpha);
    const darkIsRetained = luminance <= threshold;
    mask.data[pixel] = darkIsRetained !== invert ? RETAINED : REMOVED;
  }

  return mask;
}

/** @param {RasterMask} mask @param {number} x @param {number} y */
export function getMaskValue(mask, x, y) {
  assertMask(mask);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= mask.width || y >= mask.height) {
    return REMOVED;
  }
  return mask.data[y * mask.width + x];
}

/** @param {RasterMask} mask @param {number} x @param {number} y @param {unknown} value */
export function setMaskValue(mask, x, y, value) {
  assertMask(mask);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= mask.width || y >= mask.height) {
    throw new RangeError("Mask coordinates are outside the raster");
  }
  mask.data[y * mask.width + x] = value ? RETAINED : REMOVED;
  return mask;
}

/** @param {RasterMask} mask */
export function countRetained(mask) {
  assertMask(mask);
  let count = 0;
  for (const value of mask.data) count += value === RETAINED ? 1 : 0;
  return count;
}

/**
 * Returns the union of masks as retained material.
 * @param {RasterMask} first
 * @param {...RasterMask} rest
 * @returns {RasterMask}
 */
export function unionMasks(first, ...rest) {
  assertMask(first);
  const output = cloneMask(first);
  for (const mask of rest) {
    assertSameSize(first, mask);
    for (let index = 0; index < output.data.length; index += 1) {
      if (mask.data[index] === RETAINED) output.data[index] = RETAINED;
    }
  }
  return output;
}

/** @param {RasterMask} first @param {RasterMask} second */
export function assertSameSize(first, second) {
  assertMask(first);
  assertMask(second);
  if (first.width !== second.width || first.height !== second.height) {
    throw new RangeError("Masks must have identical dimensions");
  }
}

/** @param {{ widthMm: number, heightMm: number }} sheet */
export function assertSheet(sheet) {
  if (!sheet || typeof sheet !== "object") throw new TypeError("Sheet dimensions are required");
  positiveFinite(sheet.widthMm, "sheet.widthMm");
  positiveFinite(sheet.heightMm, "sheet.heightMm");
}

/** @param {RasterMask} mask @param {{ widthMm: number, heightMm: number }} sheet */
export function pixelSizeMm(mask, sheet) {
  assertMask(mask);
  assertSheet(sheet);
  return {
    x: sheet.widthMm / mask.width,
    y: sheet.heightMm / mask.height,
  };
}

/** @param {number} value @param {string} name */
export function positiveFinite(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}

function finiteInRange(value, minimum, maximum, name) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function finiteChannel(value) {
  return Number.isFinite(Number(value)) ? Math.min(255, Math.max(0, Number(value))) : 0;
}
