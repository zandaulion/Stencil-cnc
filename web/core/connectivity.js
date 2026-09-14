import { RETAINED, assertMask, assertSameSize } from "./mask.js";

/**
 * Labels finite-width retained regions using 4-connectivity. A diagonal point
 * contact is deliberately not treated as a structural connection.
 *
 * @param {import('./mask.js').RasterMask} mask
 * @param {{ anchorMask?: import('./mask.js').RasterMask | null, anchorBoundary?: boolean }} [options]
 */
export function analyzeConnectivity(mask, options = {}) {
  assertMask(mask);
  const anchorMask = options.anchorMask ?? null;
  if (anchorMask) assertSameSize(mask, anchorMask);
  const anchorBoundary = options.anchorBoundary ?? anchorMask === null;

  const labels = new Int32Array(mask.data.length);
  const queue = new Int32Array(mask.data.length);
  const components = [];
  let retainedPixels = 0;
  let nextId = 1;

  for (let start = 0; start < mask.data.length; start += 1) {
    if (mask.data[start] !== RETAINED) continue;
    retainedPixels += 1;
    if (labels[start] !== 0) continue;

    let head = 0;
    let tail = 0;
    let pixelCount = 0;
    let anchored = false;
    let touchesBoundary = false;
    let minX = mask.width;
    let minY = mask.height;
    let maxX = -1;
    let maxY = -1;
    labels[start] = nextId;
    queue[tail++] = start;

    while (head < tail) {
      const index = queue[head++];
      const x = index % mask.width;
      const y = Math.floor(index / mask.width);
      pixelCount += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);

      const onBoundary = x === 0 || y === 0 || x === mask.width - 1 || y === mask.height - 1;
      touchesBoundary ||= onBoundary;
      anchored ||= (anchorBoundary && onBoundary) || Boolean(anchorMask?.data[index]);

      if (x > 0) tail = enqueue(index - 1, nextId, mask, labels, queue, tail);
      if (x + 1 < mask.width) tail = enqueue(index + 1, nextId, mask, labels, queue, tail);
      if (y > 0) tail = enqueue(index - mask.width, nextId, mask, labels, queue, tail);
      if (y + 1 < mask.height) tail = enqueue(index + mask.width, nextId, mask, labels, queue, tail);
    }

    components.push({
      id: nextId,
      pixelCount,
      anchored,
      touchesBoundary,
      bounds: {
        minX,
        minY,
        maxX,
        maxY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      },
    });
    nextId += 1;
  }

  const islands = components.filter((component) => !component.anchored);
  return {
    connectivity: 4,
    labels,
    retainedPixels,
    componentCount: components.length,
    islandCount: islands.length,
    components,
    supportedComponents: components.filter((component) => component.anchored),
    islands,
    islandComponentIds: islands.map((component) => component.id),
    allSupported: islands.length === 0,
  };
}

/** @param {import('./mask.js').RasterMask} mask @param {Parameters<typeof analyzeConnectivity>[1]} [options] */
export function findUnsupportedComponents(mask, options) {
  return analyzeConnectivity(mask, options).islands;
}

function enqueue(index, id, mask, labels, queue, tail) {
  if (mask.data[index] === RETAINED && labels[index] === 0) {
    labels[index] = id;
    queue[tail] = index;
    return tail + 1;
  }
  return tail;
}
