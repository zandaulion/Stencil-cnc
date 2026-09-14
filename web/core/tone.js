/**
 * Photographs to tone, before any style looks at them.
 *
 * Every style needs the same thing from a photograph: how dark is it *here*,
 * on a scale where 1 is ink and 0 is bare sheet. Doing that once means the
 * styles differ in how they draw, not in how they read — otherwise each one
 * grows its own slightly different preparation and they stop being comparable.
 *
 * The important part is that "dark" is judged locally. A global threshold asks
 * "is this pixel darker than the picture's average", which on an indoor snap
 * answers "yes, the whole subject is" and hands back a blob. A local one asks
 * "is this darker than its surroundings", which is what an eye does and what
 * survives a lamp on one side of the face.
 */

/** @typedef {{ width: number, height: number, data: Float32Array }} ToneField */

// Fraction of the shorter side used as the neighbourhood radius. Big enough to
// span a cheek, small enough that a cheek does not become its own background:
// past roughly a tenth of the frame the local mean turns into the global one
// and the whole exercise collapses back to a plain threshold.
const DEFAULT_RADIUS = 0.06;

// How hard local differences are pushed apart. Beyond about 4 the film grain in
// a flat area starts to read as structure, which later becomes cut geometry.
const DEFAULT_GAIN = 1.8;

/**
 * Luminance, matching `maskFromImageData` so a global threshold and a tone
 * field never disagree about which pixel is darker.
 */
function luminance(data, offset, background) {
  const alpha = data[offset + 3] / 255;
  const value = 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
  return value * alpha + background * (1 - alpha);
}

/**
 * Summed-area table, so the neighbourhood mean costs the same whatever its
 * radius. A naive box blur at radius 60 on a 12-megapixel photo is minutes.
 */
function integralImage(values, width, height) {
  const sums = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      rowSum += values[y * width + x];
      sums[(y + 1) * (width + 1) + x + 1] = sums[y * (width + 1) + x + 1] + rowSum;
    }
  }
  return sums;
}

function boxMean(sums, width, height, x, y, radius) {
  const x0 = Math.max(0, x - radius);
  const y0 = Math.max(0, y - radius);
  const x1 = Math.min(width, x + radius + 1);
  const y1 = Math.min(height, y + radius + 1);
  const stride = width + 1;
  const total = sums[y1 * stride + x1] - sums[y0 * stride + x1]
    - sums[y1 * stride + x0] + sums[y0 * stride + x0];
  return total / ((x1 - x0) * (y1 - y0));
}

/**
 * Reads a photograph as ink density.
 *
 * @param {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}} imageData
 * @param {{ mode?: 'local'|'global', radius?: number, gain?: number,
 *           backgroundLuminance?: number, invert?: boolean }} [options]
 * @returns {ToneField} 0 is bare sheet, 1 is ink
 */
export function toneFromImageData(imageData, options = {}) {
  if (!imageData || typeof imageData !== "object") {
    throw new TypeError("Expected ImageData-like input");
  }
  const { width, height, data } = imageData;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError("Image dimensions must be positive integers");
  }
  if (!data || data.length !== width * height * 4) {
    throw new RangeError("RGBA data must contain exactly width × height × 4 entries");
  }

  const mode = options.mode ?? "local";
  const gain = positive(options.gain ?? DEFAULT_GAIN, "gain");
  const background = options.backgroundLuminance ?? 255;
  const invert = options.invert === true;

  const grey = new Float32Array(width * height);
  let min = Infinity;
  let max = -Infinity;
  for (let pixel = 0, offset = 0; pixel < grey.length; pixel += 1, offset += 4) {
    const value = luminance(data, offset, background);
    grey[pixel] = value;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  const tone = new Float32Array(width * height);
  const span = max - min;

  if (mode === "global") {
    // Nothing clever: stretch whatever range the photograph happens to use.
    const scale = span > 1e-6 ? 1 / span : 0;
    for (let pixel = 0; pixel < tone.length; pixel += 1) {
      tone[pixel] = 1 - (grey[pixel] - min) * scale;
    }
  } else if (mode === "local") {
    const radius = Math.max(
      2,
      Math.round(positive(options.radius ?? DEFAULT_RADIUS, "radius") * Math.min(width, height)),
    );
    const sums = integralImage(grey, width, height);
    for (let y = 0, pixel = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1, pixel += 1) {
        const mean = boxMean(sums, width, height, x, y, radius);
        // Difference from the neighbourhood, in units of the whole picture's
        // range, so `gain` means the same thing on a flat photo and a punchy one.
        const relative = span > 1e-6 ? (mean - grey[pixel]) / span : 0;
        tone[pixel] = clamp01(0.5 + relative * gain);
      }
    }
  } else {
    throw new RangeError(`Unknown tone mode: ${mode}`);
  }

  if (invert) {
    for (let pixel = 0; pixel < tone.length; pixel += 1) tone[pixel] = 1 - tone[pixel];
  }
  return { width, height, data: tone };
}

/** Average ink over a rectangle, for styles that sample a cell rather than a pixel. */
export function averageTone(field, x0, y0, x1, y1) {
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.min(field.width, Math.ceil(x1));
  const bottom = Math.min(field.height, Math.ceil(y1));
  if (right <= left || bottom <= top) return 0;
  let total = 0;
  for (let y = top; y < bottom; y += 1) {
    const row = y * field.width;
    for (let x = left; x < right; x += 1) total += field.data[row + x];
  }
  return total / ((right - left) * (bottom - top));
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}
