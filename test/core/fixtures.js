import { RETAINED, createMask } from "../../web/core/mask.js";

/**
 * Creates a semantic mask from readable rows. `#` is retained material and
 * every other character is removed material.
 *
 * @param {string[] | string} source
 */
export function maskFromAscii(source) {
  const rows = Array.isArray(source)
    ? source
    : source.trim().split(/\r?\n/).map((row) => row.trim());
  if (rows.length === 0 || rows[0].length === 0 || rows.some((row) => row.length !== rows[0].length)) {
    throw new Error("ASCII fixture rows must form a non-empty rectangle");
  }
  const mask = createMask(rows[0].length, rows.length);
  rows.forEach((row, y) => {
    [...row].forEach((value, x) => {
      if (value === "#") mask.data[y * mask.width + x] = RETAINED;
    });
  });
  return mask;
}

/**
 * A thick outer frame, a solid central payload, and a one-cell material bridge.
 * It is connected initially but the bridge disappears under modest erosion.
 */
export function narrowBridgeFixture() {
  const mask = createMask(15, 15);
  for (let y = 0; y < 15; y += 1) {
    for (let x = 0; x < 15; x += 1) {
      const frame = x < 3 || y < 3 || x >= 12 || y >= 12;
      const payload = x >= 6 && x <= 8 && y >= 6 && y <= 8;
      const bridge = x === 7 && y >= 9 && y <= 11;
      if (frame || payload || bridge) mask.data[y * mask.width + x] = RETAINED;
    }
  }
  return mask;
}

/** @param {Array<[number, number, number, number]>} pixels */
export function rgbaFixture(pixels) {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach((pixel, index) => data.set(pixel, index * 4));
  return { width: pixels.length, height: 1, data };
}
