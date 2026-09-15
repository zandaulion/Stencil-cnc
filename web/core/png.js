import { RETAINED, assertMask } from './mask.js';

/**
 * Converts manufacturing geometry into an opaque, shareable black-and-white
 * raster. Retained metal is black and removed material is white, matching the
 * conventional stencil preview without adding UI overlays or annotations.
 *
 * PNG compression itself is intentionally left to the browser canvas so the
 * geometry core remains dependency-free and works in both Node and browsers.
 *
 * @param {{ width: number, height: number, data: Uint8Array }} mask
 * @returns {{ width: number, height: number, data: Uint8ClampedArray }}
 */
export function maskToRgba(mask) {
  assertMask(mask);
  const data = new Uint8ClampedArray(mask.width * mask.height * 4);
  for (let pixel = 0, offset = 0; pixel < mask.data.length; pixel += 1, offset += 4) {
    const channel = mask.data[pixel] === RETAINED ? 0 : 255;
    data[offset] = channel;
    data[offset + 1] = channel;
    data[offset + 2] = channel;
    data[offset + 3] = 255;
  }
  return { width: mask.width, height: mask.height, data };
}
