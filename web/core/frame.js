import {
  RETAINED,
  assertMask,
  assertSheet,
  cloneMask,
  createMask,
  pixelSizeMm,
  unionMasks,
} from "./mask.js";

const SIDE_NAMES = ["top", "right", "bottom", "left"];

/**
 * Rasterises an inward rectangular frame. Dimensions are expressed in mm;
 * pixel centres are sampled so results are deterministic at a given resolution.
 *
 * @param {number} width
 * @param {number} height
 * @param {{ enabled?: boolean, thicknessMm?: number | Partial<Record<'top'|'right'|'bottom'|'left', number>>, insetMm?: number | Partial<Record<'top'|'right'|'bottom'|'left', number>>, sides?: Partial<Record<'top'|'right'|'bottom'|'left', boolean>> }} frame
 * @param {{ widthMm: number, heightMm: number }} sheet
 */
export function createRectangularFrameMask(width, height, frame, sheet) {
  const output = createMask(width, height);
  assertSheet(sheet);
  if (frame?.enabled === false) return output;

  const thickness = normalizeEdges(frame?.thicknessMm ?? 10, "thicknessMm", true);
  const inset = normalizeEdges(frame?.insetMm ?? 0, "insetMm", false);
  const sides = Object.fromEntries(SIDE_NAMES.map((side) => [side, frame?.sides?.[side] !== false]));
  validateFrameFits(sheet, thickness, inset);

  const scale = pixelSizeMm(output, sheet);
  for (let y = 0; y < height; y += 1) {
    const yMm = (y + 0.5) * scale.y;
    for (let x = 0; x < width; x += 1) {
      const xMm = (x + 0.5) * scale.x;
      const inHorizontalSpan = xMm >= inset.left && xMm <= sheet.widthMm - inset.right;
      const inVerticalSpan = yMm >= inset.top && yMm <= sheet.heightMm - inset.bottom;
      const isTop = sides.top && inHorizontalSpan && yMm >= inset.top && yMm < inset.top + thickness.top;
      const isRight = sides.right && inVerticalSpan && xMm <= sheet.widthMm - inset.right && xMm > sheet.widthMm - inset.right - thickness.right;
      const isBottom = sides.bottom && inHorizontalSpan && yMm <= sheet.heightMm - inset.bottom && yMm > sheet.heightMm - inset.bottom - thickness.bottom;
      const isLeft = sides.left && inVerticalSpan && xMm >= inset.left && xMm < inset.left + thickness.left;
      if (isTop || isRight || isBottom || isLeft) output.data[y * width + x] = RETAINED;
    }
  }

  return output;
}

/**
 * @param {import('./mask.js').RasterMask} mask
 * @param {Parameters<typeof createRectangularFrameMask>[2]} frame
 * @param {{ widthMm: number, heightMm: number }} sheet
 */
export function applyRectangularFrame(mask, frame, sheet) {
  assertMask(mask);
  if (frame?.enabled === false) return cloneMask(mask);
  const frameMask = createRectangularFrameMask(mask.width, mask.height, frame, sheet);
  return unionMasks(mask, frameMask);
}

function normalizeEdges(value, name, requirePositive) {
  const result = {};
  for (const side of SIDE_NAMES) {
    const candidate = typeof value === "number" ? value : value?.[side] ?? 0;
    const isValid = Number.isFinite(candidate) && (requirePositive ? candidate > 0 : candidate >= 0);
    if (!isValid) {
      throw new RangeError(`frame.${name}.${side} must be ${requirePositive ? "positive" : "non-negative"}`);
    }
    result[side] = candidate;
  }
  return result;
}

function validateFrameFits(sheet, thickness, inset) {
  if (inset.left + thickness.left + inset.right + thickness.right >= sheet.widthMm ||
      inset.top + thickness.top + inset.bottom + thickness.bottom >= sheet.heightMm) {
    throw new RangeError("Frame thickness and inset leave no usable sheet interior");
  }
}
