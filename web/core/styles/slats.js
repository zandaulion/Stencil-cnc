/**
 * Tone rendered as slats of varying width.
 *
 * A row of parallel bars at a fixed pitch; each bar grows where the picture is
 * dark and thins where it is light. Step back and the widths average into
 * shading, which is the whole trick — the same one a newspaper halftone plays,
 * except the dots are joined into bars.
 *
 * Two properties make this the style to build first.
 *
 * Every bar runs the full height of the sheet, so no bar can ever be an island:
 * the only connectivity question left is the one the frame answers. Compare a
 * hatch style, where every stroke is a separate piece and bridges are not a
 * finishing touch but the main problem.
 *
 * And the cutting limits go into the generator rather than a repair pass after
 * it. A bar is never allowed thinner than the material can hold, nor the gap
 * narrower than the tool can enter, because the width is clamped between those
 * two before it is drawn. Generating freely and repairing afterwards means
 * fighting the repairer: it widens a bar, which narrows a gap, which the next
 * pass widens back.
 *
 * The bars are deliberately not joined to each other. Slats plus a frame is one
 * piece; slats alone is a pile of sticks. `buildDesignMask` already unions the
 * frame in, so this returns the bars and lets that stay one job.
 */

import { RETAINED, assertSheet, createMask } from "../mask.js";

/** @typedef {import('../mask.js').RasterMask} RasterMask */
/** @typedef {import('../tone.js').ToneField} ToneField */

/**
 * @param {ToneField} tone
 * @param {{ sheet: {widthMm: number, heightMm: number}, pitchMm?: number,
 *           minWebMm?: number, minSlotMm?: number,
 *           orientation?: 'vertical'|'horizontal', gamma?: number }} config
 * @returns {RasterMask}
 */
export function slatMask(tone, config) {
  assertToneField(tone);
  if (!config?.sheet) throw new TypeError("A physical sheet is required to place slats");
  assertSheet(config.sheet);

  const orientation = config.orientation ?? "vertical";
  if (orientation !== "vertical" && orientation !== "horizontal") {
    throw new RangeError(`Unknown slat orientation: ${orientation}`);
  }
  const pitchMm = positive(config.pitchMm ?? 6, "pitchMm");
  const minWebMm = positive(config.minWebMm ?? 1.2, "minWebMm");
  const minSlotMm = positive(config.minSlotMm ?? 1, "minSlotMm");
  const gamma = positive(config.gamma ?? 1, "gamma");

  // Refused rather than silently squeezed. A pitch with no room for both a bar
  // and a gap cannot be drawn at all, and the honest moment to say so is now --
  // not after the sheet is on the machine.
  if (pitchMm < minWebMm + minSlotMm) {
    throw new RangeError(
      `A pitch of ${pitchMm} mm cannot hold a ${minWebMm} mm web and a ${minSlotMm} mm slot; `
      + `use at least ${(minWebMm + minSlotMm).toFixed(2)} mm`,
    );
  }

  // Across the bars is the direction that carries the pitch; along them the
  // picture is read row by row.
  const across = orientation === "vertical" ? tone.width : tone.height;
  const along = orientation === "vertical" ? tone.height : tone.width;
  const mmPerPixelAcross = orientation === "vertical"
    ? config.sheet.widthMm / tone.width
    : config.sheet.heightMm / tone.height;

  const pitch = pitchMm / mmPerPixelAcross;
  const minWeb = minWebMm / mmPerPixelAcross;
  const maxWeb = (pitchMm - minSlotMm) / mmPerPixelAcross;
  if (pitch < 2) {
    throw new RangeError(
      `A pitch of ${pitchMm} mm is under two pixels at this resolution; `
      + "raise the pitch or the raster size",
    );
  }

  const mask = createMask(tone.width, tone.height);
  const count = Math.max(1, Math.floor(across / pitch));
  // Any remainder is shared out so the bars sit centred rather than leaving a
  // ragged strip down one edge.
  const margin = (across - count * pitch) / 2;

  for (let index = 0; index < count; index += 1) {
    const centre = margin + (index + 0.5) * pitch;
    const cellStart = centre - pitch / 2;
    const cellEnd = centre + pitch / 2;

    for (let position = 0; position < along; position += 1) {
      const ink = cellTone(tone, orientation, cellStart, cellEnd, position);
      const width = minWeb + Math.pow(ink, gamma) * (maxWeb - minWeb);
      const from = Math.round(centre - width / 2);
      const to = Math.round(centre + width / 2);
      for (let step = from; step < to; step += 1) {
        if (step < 0 || step >= across) continue;
        const x = orientation === "vertical" ? step : position;
        const y = orientation === "vertical" ? position : step;
        mask.data[y * mask.width + x] = RETAINED;
      }
    }
  }
  return mask;
}

/** Mean ink across one slat's cell at one position along it. */
function cellTone(tone, orientation, cellStart, cellEnd, position) {
  const from = Math.max(0, Math.floor(cellStart));
  const to = Math.min(orientation === "vertical" ? tone.width : tone.height, Math.ceil(cellEnd));
  if (to <= from) return 0;
  let total = 0;
  for (let step = from; step < to; step += 1) {
    const index = orientation === "vertical"
      ? position * tone.width + step
      : step * tone.width + position;
    total += tone.data[index];
  }
  return total / (to - from);
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
