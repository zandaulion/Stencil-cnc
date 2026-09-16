import { RETAINED, assertMask } from './mask.js';

export const DRAFT_WATERMARK_LABEL = 'KERFLOOM DRAFT · NOT VALIDATED FOR CUTTING';

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

/**
 * Draws a high-contrast, resolution-aware draft band over a PNG canvas.
 * Keeping the label and layout here makes the visible safety marking testable
 * without coupling geometry code to browser download behavior.
 *
 * @param {CanvasRenderingContext2D|Record<string, any>} context
 * @param {number} width
 * @param {number} height
 */
export function drawDraftWatermark(context, width, height) {
  if (!context || typeof context.fillText !== 'function') {
    throw new TypeError('A 2D canvas context is required');
  }
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new TypeError('Positive canvas dimensions are required');
  }
  const shortEdge = Math.max(1, Math.min(width, height));
  const fontSize = Math.max(14, Math.round(shortEdge * 0.055));
  const diagonal = Math.hypot(width, height);
  const bandHeight = fontSize * 2.15;

  context.save();
  context.translate(width / 2, height / 2);
  context.rotate(-Math.PI / 9);
  context.fillStyle = 'rgba(255, 247, 245, 0.9)';
  context.fillRect(-diagonal / 2, -bandHeight / 2, diagonal, bandHeight);
  context.strokeStyle = 'rgba(190, 47, 53, 0.85)';
  context.lineWidth = Math.max(2, fontSize * 0.055);
  context.beginPath();
  context.moveTo(-diagonal / 2, -bandHeight / 2);
  context.lineTo(diagonal / 2, -bandHeight / 2);
  context.moveTo(-diagonal / 2, bandHeight / 2);
  context.lineTo(diagonal / 2, bandHeight / 2);
  context.stroke();
  context.fillStyle = '#be2f35';
  context.font = `700 ${fontSize}px Arial, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(DRAFT_WATERMARK_LABEL, 0, 0, diagonal * 0.82);
  context.restore();
}
