import { assertMask, assertSheet } from './mask.js';
import { physicalDiscIndices, physicalStrokeIndices } from './editing.js';

export const MANUAL_EDIT_OPERATIONS = Object.freeze(['keep', 'remove', 'restore']);
export const MANUAL_EDIT_SHAPES = Object.freeze(['stroke', 'region']);

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new RangeError(`${label} must be finite`);
  return number;
}

function normalizePoint(point, label) {
  if (!point || typeof point !== 'object' || Array.isArray(point)) {
    throw new TypeError(`${label} must be a point`);
  }
  return { x: finite(point.x, `${label}.x`), y: finite(point.y, `${label}.y`) };
}

function normalizeIndices(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  const indices = [];
  const seen = new Set();
  for (const value of values) {
    if (!Number.isInteger(value) || value < 0) throw new RangeError(`${label} must contain non-negative integers`);
    if (!seen.has(value)) {
      seen.add(value);
      indices.push(value);
    }
  }
  return indices;
}

export function normalizeManualEdit(input, index = 0) {
  const label = `manualEdits[${index}]`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object`);
  }
  if (typeof input.id !== 'string' || !input.id.trim()) throw new TypeError(`${label}.id must be a string`);
  if (!MANUAL_EDIT_OPERATIONS.includes(input.operation)) {
    throw new RangeError(`${label}.operation is unsupported`);
  }
  if (!MANUAL_EDIT_SHAPES.includes(input.shape)) throw new RangeError(`${label}.shape is unsupported`);

  const edit = {
    id: input.id.trim(),
    operation: input.operation,
    shape: input.shape,
    enabled: input.enabled !== false,
  };
  if (input.shape === 'stroke') {
    const widthMm = finite(input.widthMm, `${label}.widthMm`);
    if (widthMm <= 0) throw new RangeError(`${label}.widthMm must be greater than zero`);
    if (!Array.isArray(input.pointsMm) || input.pointsMm.length < 1 || input.pointsMm.length > 20000) {
      throw new RangeError(`${label}.pointsMm must contain 1 to 20000 points`);
    }
    edit.widthMm = widthMm;
    edit.pointsMm = input.pointsMm.map((point, pointIndex) => (
      normalizePoint(point, `${label}.pointsMm[${pointIndex}]`)
    ));
  } else {
    if (typeof input.rasterKey !== 'string' || !/^\d+x\d+$/.test(input.rasterKey)) {
      throw new RangeError(`${label}.rasterKey must be WIDTHxHEIGHT`);
    }
    edit.rasterKey = input.rasterKey;
    edit.indices = normalizeIndices(input.indices, `${label}.indices`);
  }
  if (typeof input.createdAt === 'string' && input.createdAt) edit.createdAt = input.createdAt;
  return edit;
}

export function normalizeManualEdits(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new TypeError('manualEdits must be an array');
  if (input.length > 5000) throw new RangeError('manualEdits cannot contain more than 5000 entries');
  const edits = input.map((edit, index) => normalizeManualEdit(edit, index));
  if (new Set(edits.map((edit) => edit.id)).size !== edits.length) {
    throw new RangeError('manualEdits ids must be unique');
  }
  return edits;
}

function remapRegionIndices(indices, rasterKey, width, height) {
  const match = /^(\d+)x(\d+)$/.exec(rasterKey);
  if (!match) return [];
  const fromWidth = Number(match[1]);
  const fromHeight = Number(match[2]);
  if (fromWidth === width && fromHeight === height) {
    return indices.filter((index) => index < width * height);
  }
  const result = new Set();
  for (const index of indices) {
    if (index >= fromWidth * fromHeight) continue;
    const x = index % fromWidth;
    const y = Math.floor(index / fromWidth);
    const minX = Math.max(0, Math.min(width - 1, Math.floor(x / fromWidth * width)));
    const maxX = Math.max(minX, Math.min(width - 1, Math.ceil((x + 1) / fromWidth * width) - 1));
    const minY = Math.max(0, Math.min(height - 1, Math.floor(y / fromHeight * height)));
    const maxY = Math.max(minY, Math.min(height - 1, Math.ceil((y + 1) / fromHeight * height) - 1));
    for (let targetY = minY; targetY <= maxY; targetY += 1) {
      for (let targetX = minX; targetX <= maxX; targetX += 1) result.add(targetY * width + targetX);
    }
  }
  return [...result];
}

export function manualEditIndices(mask, sheet, input) {
  assertMask(mask);
  assertSheet(sheet);
  const edit = normalizeManualEdit(input);
  if (edit.shape === 'region') {
    return remapRegionIndices(edit.indices, edit.rasterKey, mask.width, mask.height);
  }
  const toRaster = (point) => ({
    x: point.x / sheet.widthMm * mask.width,
    y: point.y / sheet.heightMm * mask.height,
  });
  if (edit.pointsMm.length === 1) {
    return physicalDiscIndices(mask, toRaster(edit.pointsMm[0]), edit.widthMm, sheet);
  }
  const indices = new Set();
  for (let index = 1; index < edit.pointsMm.length; index += 1) {
    for (const cell of physicalStrokeIndices(
      mask,
      toRaster(edit.pointsMm[index - 1]),
      toRaster(edit.pointsMm[index]),
      edit.widthMm,
      sheet,
    )) indices.add(cell);
  }
  return [...indices];
}

function validLegacyIndices(values, length) {
  if (!values || typeof values[Symbol.iterator] !== 'function') return [];
  return [...values].filter((index) => Number.isInteger(index) && index >= 0 && index < length);
}

/**
 * Replays ordered, non-destructive manual edits into the two raster override
 * sets consumed by the geometry pipeline. Restore clears both overrides so
 * the generated artwork beneath the manual layer becomes visible again.
 */
export function rasterizeManualEdits(mask, sheet, { legacy = null, edits = [] } = {}) {
  assertMask(mask);
  assertSheet(sheet);
  const keep = new Set(validLegacyIndices(legacy?.keep, mask.data.length));
  const remove = new Set(validLegacyIndices(legacy?.remove, mask.data.length));
  for (const edit of normalizeManualEdits(edits)) {
    if (!edit.enabled) continue;
    for (const index of manualEditIndices(mask, sheet, edit)) {
      if (edit.operation === 'restore') {
        keep.delete(index);
        remove.delete(index);
      } else if (edit.operation === 'keep') {
        keep.add(index);
        remove.delete(index);
      } else {
        remove.add(index);
        keep.delete(index);
      }
    }
  }
  return { keep, remove };
}

export function translateManualEdit(input, deltaXmm, deltaYmm) {
  const edit = normalizeManualEdit(input);
  if (edit.shape !== 'stroke') return edit;
  const dx = finite(deltaXmm, 'deltaXmm');
  const dy = finite(deltaYmm, 'deltaYmm');
  return {
    ...edit,
    pointsMm: edit.pointsMm.map((point) => ({ x: point.x + dx, y: point.y + dy })),
  };
}
