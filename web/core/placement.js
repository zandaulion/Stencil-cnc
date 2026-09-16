import { RETAINED, assertMask, assertSheet, createMask } from "./mask.js";

const SIDES = ["top", "right", "bottom", "left"];

/**
 * Returns the same physical sheet with its dimensions ordered for the chosen
 * orientation. No scaling is involved: changing orientation is a 90-degree
 * turn of the stock, not a resize.
 *
 * @param {{widthMm:number,heightMm:number}} sheet
 * @param {'portrait'|'landscape'} orientation
 */
export function orientSheet(sheet, orientation) {
  assertSheet(sheet);
  if (orientation !== "portrait" && orientation !== "landscape") {
    throw new RangeError("orientation must be portrait or landscape");
  }
  const shouldSwap = orientation === "landscape"
    ? sheet.widthMm < sheet.heightMm
    : sheet.widthMm > sheet.heightMm;
  return shouldSwap
    ? { widthMm: sheet.heightMm, heightMm: sheet.widthMm }
    : { widthMm: sheet.widthMm, heightMm: sheet.heightMm };
}

/**
 * Calculates an aspect-preserving physical rectangle for source artwork.
 * `fitToFrame=false` still preserves aspect ratio; it merely ignores the
 * frame-and-margin safe area and fits against the whole sheet.
 *
 * @param {{width:number,height:number}} source
 * @param {{widthMm:number,heightMm:number}} sheet
 * @param {{frame?:object,marginMm?:number,fitToFrame?:boolean,artworkTransform?:object}} [config]
 */
export function calculateArtworkPlacement(source, sheet, config = {}) {
  assertSourceDimensions(source);
  assertSheet(sheet);
  const marginMm = nonNegative(config.marginMm ?? 0, "marginMm");
  const frame = config.frame ?? {};
  const useSafeArea = config.fitToFrame !== false;
  const thickness = edgeValues(frame.thicknessMm ?? 0);
  const sides = Object.fromEntries(SIDES.map((side) => [side, frame.sides?.[side] !== false]));
  const frameEnabled = frame.enabled !== false;

  const inset = Object.fromEntries(SIDES.map((side) => [
    side,
    useSafeArea ? marginMm + (frameEnabled && sides[side] ? thickness[side] : 0) : 0,
  ]));
  const availableWidth = sheet.widthMm - inset.left - inset.right;
  const availableHeight = sheet.heightMm - inset.top - inset.bottom;
  if (availableWidth <= 0 || availableHeight <= 0) {
    throw new RangeError("The frame and artwork margin leave no usable panel area");
  }

  // This is deliberately not capped at 1. A small source must be enlarged,
  // just as an oversized source must be reduced, until one dimension reaches
  // the safe area's opposing margins. Both dimensions use the same scale so
  // the artwork can never be stretched to the panel's aspect ratio.
  const fitScale = Math.min(availableWidth / source.width, availableHeight / source.height);
  const transform = normalizeArtworkTransform(config.artworkTransform);
  const widthMm = source.width * fitScale * transform.scale;
  const heightMm = source.height * fitScale * transform.scale;
  const centerX = inset.left + availableWidth / 2 + transform.offsetXMm;
  const centerY = inset.top + availableHeight / 2 + transform.offsetYMm;

  return {
    xMm: centerX - widthMm / 2,
    yMm: centerY - heightMm / 2,
    widthMm,
    heightMm,
    rotationDeg: transform.rotationDeg,
    safeArea: {
      xMm: inset.left,
      yMm: inset.top,
      widthMm: availableWidth,
      heightMm: availableHeight,
    },
  };
}

/**
 * Maps a normalized point in the unrotated artwork rectangle onto the sheet.
 * Rotation is around the artwork centre, matching the raster placement and
 * the editor's photographic preview.
 *
 * @param {{xMm:number,yMm:number,widthMm:number,heightMm:number,rotationDeg?:number}} placement
 * @param {number} normalizedX
 * @param {number} normalizedY
 */
export function pointFromArtworkPlacement(placement, normalizedX, normalizedY) {
  const angle = (Number(placement.rotationDeg) || 0) * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const localX = (normalizedX - 0.5) * placement.widthMm;
  const localY = (normalizedY - 0.5) * placement.heightMm;
  return {
    x: placement.xMm + placement.widthMm / 2 + localX * cosine - localY * sine,
    y: placement.yMm + placement.heightMm / 2 + localX * sine + localY * cosine,
  };
}

/** The inverse of pointFromArtworkPlacement. */
export function pointToArtworkPlacement(placement, point) {
  const angle = -(Number(placement.rotationDeg) || 0) * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const dx = point.x - (placement.xMm + placement.widthMm / 2);
  const dy = point.y - (placement.yMm + placement.heightMm / 2);
  const localX = dx * cosine - dy * sine;
  const localY = dx * sine + dy * cosine;
  return {
    x: localX / placement.widthMm + 0.5,
    y: localY / placement.heightMm + 0.5,
  };
}

/**
 * Removes only rows and columns that contain none of the chosen visible phase.
 * The returned bounds refer to the original mask, allowing the photograph
 * preview to use exactly the same crop as the generated geometry.
 *
 * @param {import('./mask.js').RasterMask} sourceMask
 * @param {0|1} [contentValue]
 */
export function trimMaskToContent(sourceMask, contentValue = RETAINED) {
  assertMask(sourceMask);
  if (contentValue !== 0 && contentValue !== 1) {
    throw new RangeError("contentValue must be 0 or 1");
  }

  let minX = sourceMask.width;
  let minY = sourceMask.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < sourceMask.height; y += 1) {
    for (let x = 0; x < sourceMask.width; x += 1) {
      if (sourceMask.data[y * sourceMask.width + x] !== contentValue) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) {
    return {
      mask: { ...sourceMask, data: Uint8Array.from(sourceMask.data) },
      bounds: null,
    };
  }

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const mask = createMask(width, height);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = (minY + y) * sourceMask.width + minX;
    mask.data.set(sourceMask.data.subarray(sourceStart, sourceStart + width), y * width);
  }
  return {
    mask,
    bounds: { x: minX, y: minY, width, height },
  };
}

/**
 * Places a source mask into a sheet-shaped raster without stretching it.
 * The output raster follows the sheet aspect ratio, so X and Y cells describe
 * the same physical distance (apart from unavoidable integer rounding).
 *
 * @param {import('./mask.js').RasterMask} sourceMask
 * @param {{widthMm:number,heightMm:number}} sheet
 * @param {{frame?:object,marginMm?:number,fitToFrame?:boolean,artworkTransform?:object,longEdgePx?:number,fillLetterboxWithMetal?:boolean}} [config]
 */
export function placeMaskOnSheet(sourceMask, sheet, config = {}) {
  assertMask(sourceMask);
  assertSheet(sheet);
  const placement = calculateArtworkPlacement(sourceMask, sheet, config);
  const requestedLongEdge = config.longEdgePx ?? Math.max(sourceMask.width, sourceMask.height);
  if (!Number.isFinite(requestedLongEdge) || requestedLongEdge <= 0) {
    throw new RangeError("longEdgePx must be positive");
  }
  const longEdge = Math.max(1, Math.round(requestedLongEdge));
  const landscape = sheet.widthMm >= sheet.heightMm;
  const width = landscape
    ? longEdge
    : Math.max(1, Math.round(longEdge * sheet.widthMm / sheet.heightMm));
  const height = landscape
    ? Math.max(1, Math.round(longEdge * sheet.heightMm / sheet.widthMm))
    : longEdge;
  const output = createMask(width, height);
  const pixelWidthMm = sheet.widthMm / width;
  const pixelHeightMm = sheet.heightMm / height;
  const safe = placement.safeArea;
  const inverseAngle = -(placement.rotationDeg || 0) * Math.PI / 180;
  const inverseCosine = Math.cos(inverseAngle);
  const inverseSine = Math.sin(inverseAngle);
  const centerX = placement.xMm + placement.widthMm / 2;
  const centerY = placement.yMm + placement.heightMm / 2;

  for (let y = 0; y < height; y += 1) {
    const yMm = (y + 0.5) * pixelHeightMm;
    const dy = yMm - centerY;
    for (let x = 0; x < width; x += 1) {
      const xMm = (x + 0.5) * pixelWidthMm;
      const dx = xMm - centerX;
      const localX = dx * inverseCosine - dy * inverseSine;
      const localY = dx * inverseSine + dy * inverseCosine;
      const sourceX = Math.floor((localX / placement.widthMm + 0.5) * sourceMask.width);
      const sourceY = Math.floor((localY / placement.heightMm + 0.5) * sourceMask.height);
      if (sourceX >= 0 && sourceX < sourceMask.width && sourceY >= 0 && sourceY < sourceMask.height) {
        output.data[y * width + x] = sourceMask.data[sourceY * sourceMask.width + sourceX];
        continue;
      }
      if (config.fillLetterboxWithMetal !== true) continue;
      const insideSafeArea = xMm >= safe.xMm && xMm < safe.xMm + safe.widthMm &&
        yMm >= safe.yMm && yMm < safe.yMm + safe.heightMm;
      if (insideSafeArea) {
        output.data[y * width + x] = RETAINED;
      }
    }
  }

  return { mask: output, placement };
}

function normalizeArtworkTransform(value = {}) {
  const scale = value?.scale ?? 1;
  const offsetXMm = value?.offsetXMm ?? 0;
  const offsetYMm = value?.offsetYMm ?? 0;
  const rotationDeg = value?.rotationDeg ?? 0;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError("artworkTransform.scale must be positive");
  }
  for (const [name, candidate] of Object.entries({ offsetXMm, offsetYMm, rotationDeg })) {
    if (!Number.isFinite(candidate)) throw new RangeError(`artworkTransform.${name} must be finite`);
  }
  return { scale, offsetXMm, offsetYMm, rotationDeg };
}

function assertSourceDimensions(source) {
  if (!source || !Number.isInteger(source.width) || source.width <= 0 ||
      !Number.isInteger(source.height) || source.height <= 0) {
    throw new TypeError("Source dimensions must be positive integers");
  }
}

function edgeValues(value) {
  if (typeof value === "number") {
    const normalized = nonNegative(value, "frame.thicknessMm");
    return Object.fromEntries(SIDES.map((side) => [side, normalized]));
  }
  const output = {};
  for (const side of SIDES) output[side] = nonNegative(value?.[side] ?? 0, `frame.thicknessMm.${side}`);
  return output;
}

function nonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative`);
  return value;
}
