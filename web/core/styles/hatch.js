/**
 * Tone rendered as short strokes cut out of a solid plate.
 *
 * The negative of the slat style. There the drawing was the material and the
 * background fell away; here the plate stays whole and light tone is the set
 * of slots taken out of it. That mapping is what makes a back-lit panel
 * references cuttable at all: as positive geometry their strokes are hundreds
 * of separate splinters, but as slots in a plate they are just holes, and holes
 * cannot fall out of anything.
 *
 * So connectivity stops being about the drawing and becomes a single question:
 * does any closed ring of slots cut a piece of plate loose? Keeping a minimum
 * web between neighbouring strokes answers it by construction — every patch of
 * remaining plate touches the patch beside it — which is why the spacing limits
 * are enforced here rather than checked afterwards.
 *
 * Strokes shorter than the tool can enter are omitted, not shrunk. A slot below
 * the cutter's diameter is not a faint mark, it is a slot the machine will
 * either refuse or widen without asking; leaving the plate solid there is the
 * honest rendering of "too dark to illuminate".
 */

import { REMOVED, RETAINED, assertSheet, createMask } from "../mask.js";

/** @typedef {import('../mask.js').RasterMask} RasterMask */
/** @typedef {import('../tone.js').ToneField} ToneField */

/**
 * @param {ToneField} tone
 * @param {{ sheet: {widthMm: number, heightMm: number}, angleDeg?: number,
 *           rowPitchMm?: number, cellMm?: number, minSlotMm?: number,
 *           minWebMm?: number, gamma?: number, invert?: boolean }} config
 * @returns {RasterMask}
 */
export function hatchMask(tone, config) {
  assertToneField(tone);
  if (!config?.sheet) throw new TypeError("A physical sheet is required to place strokes");
  assertSheet(config.sheet);

  const angle = Number.isFinite(config.angleDeg) ? config.angleDeg : 45;
  const rowPitchMm = positive(config.rowPitchMm ?? 4, "rowPitchMm");
  const cellMm = positive(config.cellMm ?? 4, "cellMm");
  const minSlotMm = positive(config.minSlotMm ?? 1, "minSlotMm");
  const minWebMm = positive(config.minWebMm ?? 1.2, "minWebMm");
  const gamma = positive(config.gamma ?? 1, "gamma");
  const invert = config.invert === true;

  // Both directions need room for a slot and the web beside it, or the plate
  // comes back as lace. Said now, in millimetres the operator recognises.
  if (rowPitchMm < minSlotMm + minWebMm) {
    throw new RangeError(
      `Rows ${rowPitchMm} mm apart cannot hold a ${minSlotMm} mm slot and a ${minWebMm} mm web; `
      + `use at least ${(minSlotMm + minWebMm).toFixed(2)} mm`,
    );
  }
  if (cellMm < minSlotMm + minWebMm) {
    throw new RangeError(
      `Cells ${cellMm} mm long cannot hold a ${minSlotMm} mm slot and a ${minWebMm} mm web; `
      + `use at least ${(minSlotMm + minWebMm).toFixed(2)} mm`,
    );
  }

  const mmPerPixelX = config.sheet.widthMm / tone.width;
  const mmPerPixelY = config.sheet.heightMm / tone.height;
  // Strokes are square-ish geometry on a possibly non-square pixel grid; using
  // the finer axis keeps a slot from being legal in one direction only.
  const mmPerPixel = Math.min(mmPerPixelX, mmPerPixelY);

  const rowPitch = rowPitchMm / mmPerPixel;
  const cell = cellMm / mmPerPixel;
  const minSlot = minSlotMm / mmPerPixel;
  const maxLength = (cellMm - minWebMm) / mmPerPixel;
  const width = Math.max(minSlot, (rowPitchMm - minWebMm) / mmPerPixel);

  if (rowPitch < 2 || cell < 2) {
    throw new RangeError(
      "The stroke grid is under two pixels at this resolution; "
      + "raise the spacing or the raster size",
    );
  }

  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  // The plate starts whole; strokes are taken out of it.
  const mask = createMask(tone.width, tone.height, RETAINED);

  // A rotated grid has to cover the image's corners, so the span is the
  // diagonal rather than the sides.
  const reach = Math.ceil(Math.hypot(tone.width, tone.height) / 2) + 1;
  const centreX = tone.width / 2;
  const centreY = tone.height / 2;
  const rows = Math.ceil((2 * reach) / rowPitch);
  const cells = Math.ceil((2 * reach) / cell);

  for (let row = 0; row < rows; row += 1) {
    const v = -reach + (row + 0.5) * rowPitch;
    for (let column = 0; column < cells; column += 1) {
      const u = -reach + (column + 0.5) * cell;

      // Centre of this stroke, back in image coordinates.
      const cx = centreX + u * cos - v * sin;
      const cy = centreY + u * sin + v * cos;
      if (cx < 0 || cy < 0 || cx >= tone.width || cy >= tone.height) continue;

      const ink = tone.data[Math.floor(cy) * tone.width + Math.floor(cx)];
      // With normal "black is metal" polarity, light is removed so it glows
      // through a back-lit panel. Inverting polarity removes dark tone instead.
      const cutTone = invert ? ink : 1 - ink;
      const length = Math.pow(cutTone, gamma) * maxLength;
      // Below the tool's reach the honest answer is no slot at all.
      if (length < minSlot) continue;

      carveStroke(mask, cx, cy, length, width, cos, sin);
    }
  }
  return mask;
}

/** Removes one rotated rectangle of material. */
function carveStroke(mask, cx, cy, length, width, cos, sin) {
  const halfLength = length / 2;
  const halfWidth = width / 2;
  const reach = Math.ceil(Math.hypot(halfLength, halfWidth)) + 1;
  const x0 = Math.max(0, Math.floor(cx - reach));
  const x1 = Math.min(mask.width - 1, Math.ceil(cx + reach));
  const y0 = Math.max(0, Math.floor(cy - reach));
  const y1 = Math.min(mask.height - 1, Math.ceil(cy + reach));

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      // Into the stroke's own frame, where the test is a plain rectangle.
      const along = dx * cos + dy * sin;
      const across = -dx * sin + dy * cos;
      if (Math.abs(along) <= halfLength && Math.abs(across) <= halfWidth) {
        mask.data[y * mask.width + x] = REMOVED;
      }
    }
  }
}

function assertToneField(tone) {
  if (!tone || !(tone.data instanceof Float32Array)
    || tone.data.length !== tone.width * tone.height) {
    throw new TypeError("Expected a tone field from toneFromImageData");
  }
}

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}
