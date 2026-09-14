import { RETAINED, assertMask, assertSheet, cloneMask, pixelSizeMm, positiveFinite } from "./mask.js";

/**
 * Paints a finite-width line with round caps as retained material.
 * The default unit is mm. Pixel-space bridges are useful for low-level tools
 * and tests; their coordinates refer to the same grid whose cell centres are
 * x + 0.5, y + 0.5.
 *
 * @param {import('./mask.js').RasterMask} mask
 * @param {{ start: {x: number, y: number}, end: {x: number, y: number}, width: number, units?: 'mm'|'px', enabled?: boolean }} bridge
 * @param {{ widthMm: number, heightMm: number } | null} [sheet]
 * @param {{ mutate?: boolean }} [options]
 */
export function applyCapsuleBridge(mask, bridge, sheet = null, options = {}) {
  assertMask(mask);
  validateBridge(bridge);
  const output = options.mutate === true ? mask : cloneMask(mask);
  if (bridge.enabled === false) return output;

  const units = bridge.units ?? "mm";
  if (units === "mm") assertSheet(sheet);
  if (units !== "mm" && units !== "px") throw new RangeError("Bridge units must be 'mm' or 'px'");

  const scale = units === "mm" ? pixelSizeMm(mask, sheet) : { x: 1, y: 1 };
  const radiusSquared = (bridge.width / 2) ** 2;
  const radius = bridge.width / 2;
  const start = bridge.start;
  const end = bridge.end;
  const minX = Math.max(0, Math.floor((Math.min(start.x, end.x) - radius) / scale.x - 0.5));
  const maxX = Math.min(mask.width - 1, Math.ceil((Math.max(start.x, end.x) + radius) / scale.x - 0.5));
  const minY = Math.max(0, Math.floor((Math.min(start.y, end.y) - radius) / scale.y - 0.5));
  const maxY = Math.min(mask.height - 1, Math.ceil((Math.max(start.y, end.y) + radius) / scale.y - 0.5));

  for (let y = minY; y <= maxY; y += 1) {
    const pointY = (y + 0.5) * scale.y;
    for (let x = minX; x <= maxX; x += 1) {
      const pointX = (x + 0.5) * scale.x;
      if (squaredDistanceToSegment(pointX, pointY, start.x, start.y, end.x, end.y) <= radiusSquared + Number.EPSILON) {
        output.data[y * mask.width + x] = RETAINED;
      }
    }
  }

  return output;
}

/**
 * @param {import('./mask.js').RasterMask} mask
 * @param {Array<Parameters<typeof applyCapsuleBridge>[1]>} bridges
 * @param {{ widthMm: number, heightMm: number } | null} [sheet]
 */
export function applyCapsuleBridges(mask, bridges, sheet = null) {
  if (!Array.isArray(bridges)) throw new TypeError("bridges must be an array");
  const output = cloneMask(mask);
  for (const bridge of bridges) applyCapsuleBridge(output, bridge, sheet, { mutate: true });
  return output;
}

/** @param {Parameters<typeof applyCapsuleBridge>[1]} bridge */
export function validateBridge(bridge) {
  if (!bridge || typeof bridge !== "object" || !bridge.start || !bridge.end) {
    throw new TypeError("A bridge requires start and end points");
  }
  for (const [name, point] of [["start", bridge.start], ["end", bridge.end]]) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new RangeError(`Bridge ${name} coordinates must be finite`);
    }
  }
  positiveFinite(bridge.width, "bridge.width");
  return bridge;
}

function squaredDistanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return (px - ax) ** 2 + (py - ay) ** 2;
  const projection = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const nearestX = ax + projection * dx;
  const nearestY = ay + projection * dy;
  return (px - nearestX) ** 2 + (py - nearestY) ** 2;
}
