/**
 * Separating the subject from the background, before tone is ever measured.
 *
 * Without this, a style spends its ink on whatever the room happened to
 * contain: a jumper's weave, a chair, wallpaper. Worse, it spends *material* on
 * it — those become real slots in real metal.
 *
 * The separation is done in colour, not brightness. A blue-grey wall and brown
 * hair can sit at the same luminance and still be plainly different; throw the
 * hue away first, as the tone field does, and they merge into one dark mass
 * with no seam to find. So this module reads the photograph again from scratch
 * rather than working from the tone field.
 *
 * The method is deliberately classical: sample colours from the frame's border
 * as background and from a central ellipse as subject, then judge every pixel
 * by which of the two it resembles. No model to download, nothing to keep in
 * sync with a vendor, and it runs offline like the rest of the core. It will
 * lose a subject that fills the frame edge-to-edge, or one photographed against
 * its own colour — and when it does, `strictness` is the honest place to argue
 * with it rather than a number buried in a network.
 */

import { REMOVED, RETAINED, createMask } from "./mask.js";

/** @typedef {import('./mask.js').RasterMask} RasterMask */

// Colour is quantised to this many levels per channel before counting. Fine
// enough to tell hair from wall, coarse enough that a few thousand sampled
// pixels actually populate the bins instead of scattering into noise.
const LEVELS = 12;

/**
 * @param {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}} imageData
 * @param {{ borderFraction?: number, centreFraction?: number, strictness?: number,
 *           centrePull?: number, smoothPx?: number, fillHoles?: boolean }} [options]
 * @returns {RasterMask} RETAINED where the subject is
 */
export function subjectMask(imageData, options = {}) {
  const { width, height, data } = imageData ?? {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8) {
    throw new RangeError("Subject detection needs an image of at least 8×8");
  }
  if (!data || data.length !== width * height * 4) {
    throw new RangeError("RGBA data must contain exactly width × height × 4 entries");
  }

  const borderFraction = inRange(options.borderFraction ?? 0.08, 0.01, 0.45, "borderFraction");
  const centreFraction = inRange(options.centreFraction ?? 0.42, 0.05, 0.95, "centreFraction");
  // The one knob worth turning, and it has to actually turn. An unbounded log
  // ratio reaches ±13 once the two colour sets separate at all, which leaves
  // any threshold in single digits doing nothing: measured on a real portrait,
  // -1, 0 and +1.2 kept 38%, 37% and 35%. Squashing the ratio into (-1, 1)
  // first gives the knob a range it can meaningfully sweep.
  const strictness = inRange(options.strictness ?? 0, -1, 1, "strictness");
  const centrePull = inRange(options.centrePull ?? 0.6, 0, 3, "centrePull");
  const smoothPx = Math.max(0, Math.round(options.smoothPx ?? Math.min(width, height) * 0.012));

  const background = new Float64Array(LEVELS ** 3);
  const subject = new Float64Array(LEVELS ** 3);
  const borderX = Math.max(1, Math.round(width * borderFraction));
  const borderY = Math.max(1, Math.round(height * borderFraction));
  const centreX = width / 2;
  const centreY = height / 2;
  const radiusX = (width * centreFraction) / 2;
  const radiusY = (height * centreFraction) / 2;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const bin = binOf(data, (y * width + x) * 4);
      if (x < borderX || x >= width - borderX || y < borderY || y >= height - borderY) {
        background[bin] += 1;
      }
      const dx = (x - centreX) / radiusX;
      const dy = (y - centreY) / radiusY;
      if (dx * dx + dy * dy <= 1) subject[bin] += 1;
    }
  }

  normalise(background);
  normalise(subject);

  const raw = createMask(width, height);
  for (let y = 0; y < height; y += 1) {
    // A gentle preference for the middle, so a colour that genuinely occurs in
    // both places is decided by where it sits. Without it, a shadow on the wall
    // the same brown as the hair keeps half the wall.
    const dy = (y - centreY) / (height / 2);
    for (let x = 0; x < width; x += 1) {
      const bin = binOf(data, (y * width + x) * 4);
      const dx = (x - centreX) / (width / 2);
      const distance = Math.sqrt(dx * dx + dy * dy);
      const ratio = Math.log((subject[bin] + 1e-6) / (background[bin] + 1e-6));
      // Divided by 4 before squashing: a ratio of about e^4 is already a
      // confident colour, and anything beyond it should not crowd out the
      // spatial term.
      const evidence = Math.tanh(ratio / 4) + 0.5 * centrePull * (1 - distance);
      if (evidence > strictness) raw.data[y * width + x] = RETAINED;
    }
  }

  const cleaned = smoothPx > 0 ? closeThenOpen(raw, smoothPx) : raw;
  const largest = keepLargestComponent(cleaned);
  return options.fillHoles === false ? largest : fillEnclosedHoles(largest);
}

/**
 * Silences a tone field outside the subject.
 *
 * Zero ink is the right neutral for both polarities: a positive style draws no
 * material there, a negative one cuts no slot. So the background simply stops
 * existing rather than each style needing to know about it.
 *
 * @param {import('./tone.js').ToneField} tone
 * @param {RasterMask} subject
 */
export function applySubjectMask(tone, subject) {
  if (tone.width !== subject.width || tone.height !== subject.height) {
    throw new RangeError("The tone field and the subject mask must be the same size");
  }
  const data = new Float32Array(tone.data);
  for (let index = 0; index < data.length; index += 1) {
    if (subject.data[index] !== RETAINED) data[index] = 0;
  }
  return { width: tone.width, height: tone.height, data };
}

function binOf(data, offset) {
  const r = (data[offset] * LEVELS) >> 8;
  const g = (data[offset + 1] * LEVELS) >> 8;
  const b = (data[offset + 2] * LEVELS) >> 8;
  return (r * LEVELS + g) * LEVELS + b;
}

function normalise(histogram) {
  let total = 0;
  for (const value of histogram) total += value;
  if (total === 0) return;
  for (let index = 0; index < histogram.length; index += 1) histogram[index] /= total;
}

/** Closing welds speckle into the subject; opening then sheds what is left. */
function closeThenOpen(mask, radius) {
  return morph(morph(morph(morph(mask, radius, true), radius, false), radius, false), radius, true);
}

function morph(mask, radius, dilate) {
  const output = createMask(mask.width, mask.height);
  const hit = dilate ? RETAINED : REMOVED;
  const fill = dilate ? RETAINED : REMOVED;
  const other = dilate ? REMOVED : RETAINED;
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      let found = false;
      for (let dy = -radius; dy <= radius && !found; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= mask.height) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= mask.width) continue;
          if (dx * dx + dy * dy > radius * radius) continue;
          if (mask.data[ny * mask.width + nx] === hit) { found = true; break; }
        }
      }
      output.data[y * mask.width + x] = found ? fill : other;
    }
  }
  return output;
}

function keepLargestComponent(mask) {
  const seen = new Uint8Array(mask.data.length);
  let best = null;
  let bestSize = 0;
  const stack = [];
  for (let start = 0; start < mask.data.length; start += 1) {
    if (seen[start] || mask.data[start] !== RETAINED) continue;
    const members = [];
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const index = stack.pop();
      members.push(index);
      const x = index % mask.width;
      const y = (index - x) / mask.width;
      if (x > 0) push(index - 1);
      if (x < mask.width - 1) push(index + 1);
      if (y > 0) push(index - mask.width);
      if (y < mask.height - 1) push(index + mask.width);
    }
    if (members.length > bestSize) { bestSize = members.length; best = members; }
  }
  function push(next) {
    if (!seen[next] && mask.data[next] === RETAINED) { seen[next] = 1; stack.push(next); }
  }
  const output = createMask(mask.width, mask.height);
  if (best) for (const index of best) output.data[index] = RETAINED;
  return output;
}

/**
 * Anything enclosed by the subject belongs to it.
 *
 * Eyes, nostrils and the gap under a chin often match the background's colour,
 * and dropping them would hand the styles a face with holes where the features
 * are. Only background that reaches the frame edge is really background.
 */
function fillEnclosedHoles(mask) {
  const outside = new Uint8Array(mask.data.length);
  const stack = [];
  const consider = (index) => {
    if (!outside[index] && mask.data[index] !== RETAINED) { outside[index] = 1; stack.push(index); }
  };
  for (let x = 0; x < mask.width; x += 1) {
    consider(x);
    consider((mask.height - 1) * mask.width + x);
  }
  for (let y = 0; y < mask.height; y += 1) {
    consider(y * mask.width);
    consider(y * mask.width + mask.width - 1);
  }
  while (stack.length) {
    const index = stack.pop();
    const x = index % mask.width;
    const y = (index - x) / mask.width;
    if (x > 0) consider(index - 1);
    if (x < mask.width - 1) consider(index + 1);
    if (y > 0) consider(index - mask.width);
    if (y < mask.height - 1) consider(index + mask.width);
  }
  const output = createMask(mask.width, mask.height);
  for (let index = 0; index < mask.data.length; index += 1) {
    output.data[index] = outside[index] ? REMOVED : RETAINED;
  }
  return output;
}

function inRange(value, low, high, name) {
  if (!Number.isFinite(value) || value < low || value > high) {
    throw new RangeError(`${name} must be a finite number between ${low} and ${high}`);
  }
  return value;
}
