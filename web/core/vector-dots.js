import { pointFromArtworkPlacement } from './placement.js';

/**
 * Normalizes the compact Variable Dots descriptor returned by the analysis
 * service. Circles are stored in source-normalized coordinates so the exact
 * geometry survives cropping, panel resizing, project sync, and sharing.
 */
export function normalizeVectorDots(input) {
  if (input == null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.version !== 1 ||
      input.coordinateSpace !== 'normalized-source' ||
      input.radiusSpace !== 'normalized-source-width' || !Array.isArray(input.circles)) {
    throw new RangeError('Unsupported Variable Dots vector geometry');
  }
  if (input.circles.length > 250_000) {
    throw new RangeError('Variable Dots vector geometry contains too many circles');
  }
  const circles = input.circles.map((circle, index) => {
    if (!Array.isArray(circle) || circle.length !== 3 ||
        !circle.every(Number.isFinite) || circle[0] < 0 || circle[0] > 1 ||
        circle[1] < 0 || circle[1] > 1 || circle[2] <= 0 || circle[2] > 0.5) {
      throw new RangeError(`Invalid Variable Dots circle at index ${index}`);
    }
    return [circle[0], circle[1], circle[2]];
  });
  return {
    version: 1,
    coordinateSpace: 'normalized-source',
    radiusSpace: 'normalized-source-width',
    circles,
  };
}

/**
 * Maps exact source circles through the same content crop and placement used
 * for the manufacturing raster. Returned coordinates are physical millimetres.
 */
export function placeVectorDots(vectorDots, sourceSize, contentBounds, placement) {
  const normalized = normalizeVectorDots(vectorDots);
  if (!normalized || !sourceSize || !contentBounds || !placement) return [];
  const sourceWidth = Number(sourceSize.width);
  const sourceHeight = Number(sourceSize.height);
  if (!(sourceWidth > 0 && sourceHeight > 0 && contentBounds.width > 0 && contentBounds.height > 0)) {
    return [];
  }
  const scaleX = placement.widthMm / contentBounds.width;
  const scaleY = placement.heightMm / contentBounds.height;
  return normalized.circles.map(([cx, cy, radius]) => {
    const sourceX = cx * sourceWidth;
    const sourceY = cy * sourceHeight;
    const radiusPixels = radius * sourceWidth;
    const center = pointFromArtworkPlacement(
      placement,
      (sourceX - contentBounds.x) / contentBounds.width,
      (sourceY - contentBounds.y) / contentBounds.height,
    );
    return {
      cxMm: center.x,
      cyMm: center.y,
      // Placement preserves aspect ratio. Averaging suppresses only the tiny
      // difference caused by integer crop dimensions.
      radiusMm: radiusPixels * (scaleX + scaleY) / 2,
    };
  }).filter((circle) => circle.radiusMm > 0);
}

/**
 * Separates raster contours that correspond to exact circle holes. The small
 * tolerance covers one-pixel sampling uncertainty; it is not curve fitting.
 */
export function separateCircleContours(contours, mask, sheet, circles = []) {
  if (!Array.isArray(circles) || circles.length === 0) {
    return { contours, matchedCircles: [] };
  }
  const scaleX = sheet.widthMm / mask.width;
  const scaleY = sheet.heightMm / mask.height;
  const descriptors = contours.map((contour, index) => {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    let signedAreaTwice = 0;
    for (let pointIndex = 0; pointIndex < contour.length; pointIndex += 1) {
      const point = contour[pointIndex];
      const next = contour[(pointIndex + 1) % contour.length];
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
      signedAreaTwice += point.x * next.y - next.x * point.y;
    }
    return {
      index,
      isHole: signedAreaTwice < 0,
      cxPx: (minX + maxX) / 2,
      cyPx: (minY + maxY) / 2,
      widthPx: maxX - minX,
      heightPx: maxY - minY,
    };
  });
  const buckets = new Map();
  for (const descriptor of descriptors) {
    const key = `${Math.round(descriptor.cxPx)},${Math.round(descriptor.cyPx)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(descriptor);
  }
  const used = new Set();
  const matchedCircles = [];
  const centreTolerancePx = 2.25;
  const diameterTolerancePx = 3.25;
  for (const circle of circles) {
    if (!circle || ![circle.cxMm, circle.cyMm, circle.radiusMm].every(Number.isFinite) || circle.radiusMm <= 0) continue;
    const cxPx = circle.cxMm / scaleX;
    const cyPx = circle.cyMm / scaleY;
    const diameterXPx = circle.radiusMm * 2 / scaleX;
    const diameterYPx = circle.radiusMm * 2 / scaleY;
    let best = null;
    let bestScore = Infinity;
    for (let dy = -3; dy <= 3; dy += 1) {
      for (let dx = -3; dx <= 3; dx += 1) {
        const candidates = buckets.get(`${Math.round(cxPx) + dx},${Math.round(cyPx) + dy}`) ?? [];
        for (const candidate of candidates) {
          if (!candidate.isHole || used.has(candidate.index)) continue;
          const centreError = Math.hypot(candidate.cxPx - cxPx, candidate.cyPx - cyPx);
          const sizeError = Math.max(
            Math.abs(candidate.widthPx - diameterXPx),
            Math.abs(candidate.heightPx - diameterYPx),
          );
          if (centreError > centreTolerancePx || sizeError > diameterTolerancePx) continue;
          const score = centreError + sizeError;
          if (score < bestScore) { best = candidate; bestScore = score; }
        }
      }
    }
    if (best) {
      used.add(best.index);
      matchedCircles.push(circle);
    }
  }
  return {
    contours: contours.filter((_, index) => !used.has(index)),
    matchedCircles,
  };
}
