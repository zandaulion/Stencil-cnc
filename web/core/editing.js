import { assertMask, assertSheet, pixelSizeMm, positiveFinite } from "./mask.js";

/**
 * Pixel indices touched by a circular physical brush centred on a raster point.
 * The raster may have non-square pixels; the brush remains circular in mm.
 */
export function physicalDiscIndices(mask, point, diameterMm, sheet) {
  assertMask(mask);
  assertSheet(sheet);
  validatePoint(point);
  positiveFinite(diameterMm, "diameterMm");
  const pixel = pixelSizeMm(mask, sheet);
  const radiusMm = diameterMm / 2;
  const radiusX = Math.max(1, Math.ceil(radiusMm / pixel.x));
  const radiusY = Math.max(1, Math.ceil(radiusMm / pixel.y));
  const centerX = Math.round(point.x);
  const centerY = Math.round(point.y);
  const indices = [];
  for (let dy = -radiusY; dy <= radiusY; dy += 1) {
    for (let dx = -radiusX; dx <= radiusX; dx += 1) {
      if ((dx * pixel.x) ** 2 + (dy * pixel.y) ** 2 > radiusMm ** 2 + Number.EPSILON) continue;
      const x = centerX + dx;
      const y = centerY + dy;
      if (x >= 0 && y >= 0 && x < mask.width && y < mask.height) indices.push(y * mask.width + x);
    }
  }
  return indices;
}

/** Returns one continuous physical-width stroke, independent of pointer event rate. */
export function physicalStrokeIndices(mask, start, end, diameterMm, sheet) {
  assertMask(mask);
  assertSheet(sheet);
  validatePoint(start);
  validatePoint(end);
  positiveFinite(diameterMm, "diameterMm");
  const pixel = pixelSizeMm(mask, sheet);
  const dxMm = (end.x - start.x) * pixel.x;
  const dyMm = (end.y - start.y) * pixel.y;
  const distanceMm = Math.hypot(dxMm, dyMm);
  const stepMm = Math.max(Math.min(pixel.x, pixel.y) / 2, diameterMm * 0.28);
  const steps = Math.max(1, Math.ceil(distanceMm / stepMm));
  const indices = new Set();
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    for (const index of physicalDiscIndices(mask, {
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
    }, diameterMm, sheet)) indices.add(index);
  }
  return [...indices];
}

/** Finds the 4-connected raster region under a point without modifying it. */
export function connectedRegionIndices(mask, point, options = {}) {
  assertMask(mask);
  validatePoint(point);
  const maximumPixels = options.maximumPixels ?? mask.data.length;
  if (!Number.isInteger(maximumPixels) || maximumPixels <= 0) {
    throw new RangeError("maximumPixels must be a positive integer");
  }
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return { indices: [], truncated: false };
  const start = y * mask.width + x;
  const value = mask.data[start];
  const seen = new Uint8Array(mask.data.length);
  const stack = [start];
  const indices = [];
  seen[start] = 1;
  while (stack.length) {
    const index = stack.pop();
    if (mask.data[index] !== value) continue;
    indices.push(index);
    if (indices.length > maximumPixels) return { indices: [], truncated: true };
    const currentX = index % mask.width;
    const currentY = Math.floor(index / mask.width);
    for (const next of [
      currentX > 0 ? index - 1 : -1,
      currentX + 1 < mask.width ? index + 1 : -1,
      currentY > 0 ? index - mask.width : -1,
      currentY + 1 < mask.height ? index + mask.width : -1,
    ]) {
      if (next >= 0 && !seen[next] && mask.data[next] === value) {
        seen[next] = 1;
        stack.push(next);
      }
    }
  }
  return { indices, truncated: false };
}

function validatePoint(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError("point must contain finite x and y coordinates");
  }
}
