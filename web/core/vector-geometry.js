import { createMask, REMOVED, RETAINED, assertMask, assertSheet } from './mask.js';
import { traceMaskContours } from './svg.js';
import { separateCircleContours } from './vector-dots.js';
import { countValidationLocations, issueLocationCount } from './validation.js';

const EPSILON = 1e-9;

export const VECTOR_SIMPLIFICATION_MODEL_VERSION = 1;

export function vectorManufacturingValidationRegressed(baseline, candidate) {
  if (!candidate?.valid || countValidationLocations(candidate, 'error') > 0) return true;
  const counts = (validation) => {
    const result = new Map();
    for (const issue of validation?.issues ?? []) {
      if (issue.severity !== 'warning') continue;
      result.set(issue.code, (result.get(issue.code) ?? 0) + issueLocationCount(issue));
    }
    return result;
  };
  const before = counts(baseline);
  return [...counts(candidate)].some(([code, count]) => count > (before.get(code) ?? 0));
}

const pointKey = (point) => `${point.x},${point.y}`;
const physicalPoint = (point, scaleX, scaleY) => ({ x: point.x * scaleX, y: point.y * scaleY });

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= EPSILON) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
  ));
  return Math.hypot(
    point.x - (start.x + projection * dx),
    point.y - (start.y + projection * dy),
  );
}

function simplifyOpenPath(path, scaleX, scaleY, toleranceMm) {
  if (path.length <= 2) return path.slice();
  const keep = new Uint8Array(path.length);
  keep[0] = 1;
  keep[path.length - 1] = 1;
  const stack = [[0, path.length - 1]];
  while (stack.length) {
    const [startIndex, endIndex] = stack.pop();
    const start = physicalPoint(path[startIndex], scaleX, scaleY);
    const end = physicalPoint(path[endIndex], scaleX, scaleY);
    let maximum = -1;
    let splitIndex = -1;
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distance = distanceToSegment(physicalPoint(path[index], scaleX, scaleY), start, end);
      if (distance > maximum) {
        maximum = distance;
        splitIndex = index;
      }
    }
    if (maximum > toleranceMm && splitIndex > startIndex) {
      keep[splitIndex] = 1;
      stack.push([startIndex, splitIndex], [splitIndex, endIndex]);
    }
  }
  return path.filter((_, index) => keep[index]);
}

function simplifyClosedContour(contour, scaleX, scaleY, toleranceMm) {
  if (contour.length <= 4 || toleranceMm <= 0) return contour.slice();
  const first = physicalPoint(contour[0], scaleX, scaleY);
  let opposite = 1;
  let farthest = -1;
  for (let index = 1; index < contour.length; index += 1) {
    const point = physicalPoint(contour[index], scaleX, scaleY);
    const distance = (point.x - first.x) ** 2 + (point.y - first.y) ** 2;
    if (distance > farthest) {
      farthest = distance;
      opposite = index;
    }
  }
  const firstPath = contour.slice(0, opposite + 1);
  const secondPath = [...contour.slice(opposite), contour[0]];
  const firstSimplified = simplifyOpenPath(firstPath, scaleX, scaleY, toleranceMm);
  const secondSimplified = simplifyOpenPath(secondPath, scaleX, scaleY, toleranceMm);
  const combined = [
    ...firstSimplified.slice(0, -1),
    ...secondSimplified.slice(0, -1),
  ];
  return combined.length >= 3 ? combined : contour.slice();
}

function signedArea(contour, scaleX, scaleY) {
  let twiceArea = 0;
  for (let index = 0; index < contour.length; index += 1) {
    const point = contour[index];
    const next = contour[(index + 1) % contour.length];
    twiceArea += point.x * scaleX * next.y * scaleY - next.x * scaleX * point.y * scaleY;
  }
  return twiceArea / 2;
}

function orientation(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a, b, point) {
  return Math.abs(orientation(a, b, point)) <= EPSILON &&
    point.x >= Math.min(a.x, b.x) - EPSILON && point.x <= Math.max(a.x, b.x) + EPSILON &&
    point.y >= Math.min(a.y, b.y) - EPSILON && point.y <= Math.max(a.y, b.y) + EPSILON;
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const o1 = orientation(firstStart, firstEnd, secondStart);
  const o2 = orientation(firstStart, firstEnd, secondEnd);
  const o3 = orientation(secondStart, secondEnd, firstStart);
  const o4 = orientation(secondStart, secondEnd, firstEnd);
  if (((o1 > EPSILON && o2 < -EPSILON) || (o1 < -EPSILON && o2 > EPSILON)) &&
      ((o3 > EPSILON && o4 < -EPSILON) || (o3 < -EPSILON && o4 > EPSILON))) return true;
  return (Math.abs(o1) <= EPSILON && onSegment(firstStart, firstEnd, secondStart)) ||
    (Math.abs(o2) <= EPSILON && onSegment(firstStart, firstEnd, secondEnd)) ||
    (Math.abs(o3) <= EPSILON && onSegment(secondStart, secondEnd, firstStart)) ||
    (Math.abs(o4) <= EPSILON && onSegment(secondStart, secondEnd, firstEnd));
}

function intersectionErrors(contours, scaleX, scaleY, sheet) {
  const segments = [];
  for (let contourIndex = 0; contourIndex < contours.length; contourIndex += 1) {
    const contour = contours[contourIndex];
    for (let index = 0; index < contour.length; index += 1) {
      const start = physicalPoint(contour[index], scaleX, scaleY);
      const end = physicalPoint(contour[(index + 1) % contour.length], scaleX, scaleY);
      segments.push({ contourIndex, index, count: contour.length, start, end });
    }
  }
  const cellSize = Math.max(sheet.widthMm, sheet.heightMm) / 96;
  const buckets = new Map();
  const compared = new Set();
  const errors = [];
  for (let currentId = 0; currentId < segments.length; currentId += 1) {
    const current = segments[currentId];
    const minCellX = Math.floor(Math.min(current.start.x, current.end.x) / cellSize);
    const maxCellX = Math.floor(Math.max(current.start.x, current.end.x) / cellSize);
    const minCellY = Math.floor(Math.min(current.start.y, current.end.y) / cellSize);
    const maxCellY = Math.floor(Math.max(current.start.y, current.end.y) / cellSize);
    const candidates = new Set();
    for (let y = minCellY; y <= maxCellY; y += 1) {
      for (let x = minCellX; x <= maxCellX; x += 1) {
        const key = `${x},${y}`;
        for (const id of buckets.get(key) ?? []) candidates.add(id);
      }
    }
    for (const otherId of candidates) {
      const pairKey = `${otherId}:${currentId}`;
      if (compared.has(pairKey)) continue;
      compared.add(pairKey);
      const other = segments[otherId];
      if (other.contourIndex === current.contourIndex) {
        const difference = Math.abs(other.index - current.index);
        if (difference === 1 || difference === current.count - 1) continue;
      }
      if (segmentsIntersect(current.start, current.end, other.start, other.end)) {
        errors.push(other.contourIndex === current.contourIndex
          ? `Contour ${current.contourIndex + 1} self-intersects after simplification.`
          : `Contours ${other.contourIndex + 1} and ${current.contourIndex + 1} intersect after simplification.`);
        if (errors.length >= 8) return errors;
      }
    }
    for (let y = minCellY; y <= maxCellY; y += 1) {
      for (let x = minCellX; x <= maxCellX; x += 1) {
        const key = `${x},${y}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(currentId);
      }
    }
  }
  return errors;
}

function pointInContour(point, contour, scaleX, scaleY) {
  let inside = false;
  for (let index = 0, previous = contour.length - 1; index < contour.length; previous = index++) {
    const a = physicalPoint(contour[index], scaleX, scaleY);
    const b = physicalPoint(contour[previous], scaleX, scaleY);
    if (((a.y > point.y) !== (b.y > point.y)) &&
        point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function containmentSignature(contours, scaleX, scaleY, sheet) {
  const cellSize = Math.max(sheet.widthMm, sheet.heightMm) / 64;
  const bounds = contours.map((contour) => {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const sourcePoint of contour) {
      const point = physicalPoint(sourcePoint, scaleX, scaleY);
      minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
    }
    return { minX, minY, maxX, maxY };
  });
  const buckets = new Map();
  bounds.forEach((box, contourIndex) => {
    for (let y = Math.floor(box.minY / cellSize); y <= Math.floor(box.maxY / cellSize); y += 1) {
      for (let x = Math.floor(box.minX / cellSize); x <= Math.floor(box.maxX / cellSize); x += 1) {
        const key = `${x},${y}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(contourIndex);
      }
    }
  });
  return contours.map((contour, contourIndex) => {
    const point = physicalPoint(contour[0], scaleX, scaleY);
    const candidates = buckets.get(`${Math.floor(point.x / cellSize)},${Math.floor(point.y / cellSize)}`) ?? [];
    return candidates.filter((otherIndex) => {
      if (contourIndex === otherIndex) return false;
      const box = bounds[otherIndex];
      if (point.x < box.minX || point.x > box.maxX || point.y < box.minY || point.y > box.maxY) return false;
      return pointInContour(point, contours[otherIndex], scaleX, scaleY);
    });
  });
}

function maximumContourDeviation(source, candidate, scaleX, scaleY) {
  const sourceIndex = new Map(source.map((point, index) => [pointKey(point), index]));
  const indices = candidate.map((point) => sourceIndex.get(pointKey(point)));
  if (indices.some((index) => index === undefined)) return Number.POSITIVE_INFINITY;
  let maximum = 0;
  for (let segmentIndex = 0; segmentIndex < candidate.length; segmentIndex += 1) {
    const startIndex = indices[segmentIndex];
    const endIndex = indices[(segmentIndex + 1) % candidate.length];
    const start = physicalPoint(source[startIndex], scaleX, scaleY);
    const end = physicalPoint(source[endIndex], scaleX, scaleY);
    let index = startIndex;
    while (index !== endIndex) {
      maximum = Math.max(maximum, distanceToSegment(physicalPoint(source[index], scaleX, scaleY), start, end));
      index = (index + 1) % source.length;
    }
  }
  return maximum;
}

function circleErrors(contours, circles, scaleX, scaleY, sheet) {
  const errors = [];
  for (let circleIndex = 0; circleIndex < circles.length; circleIndex += 1) {
    const circle = circles[circleIndex];
    if (!circle || ![circle.cxMm, circle.cyMm, circle.radiusMm].every(Number.isFinite) ||
        circle.radiusMm <= 0 || circle.cxMm - circle.radiusMm < -EPSILON ||
        circle.cyMm - circle.radiusMm < -EPSILON ||
        circle.cxMm + circle.radiusMm > sheet.widthMm + EPSILON ||
        circle.cyMm + circle.radiusMm > sheet.heightMm + EPSILON) {
      errors.push(`Exact circle ${circleIndex + 1} falls outside the panel.`);
      continue;
    }
    const center = { x: circle.cxMm, y: circle.cyMm };
    const retainedAtCenter = contours.reduce(
      (inside, contour) => inside !== pointInContour(center, contour, scaleX, scaleY),
      false,
    );
    if (!retainedAtCenter) errors.push(`Exact circle ${circleIndex + 1} is not contained by retained material.`);
    for (const contour of contours) {
      for (let index = 0; index < contour.length; index += 1) {
        const start = physicalPoint(contour[index], scaleX, scaleY);
        const end = physicalPoint(contour[(index + 1) % contour.length], scaleX, scaleY);
        if (distanceToSegment(center, start, end) <= circle.radiusMm + EPSILON) {
          errors.push(`Exact circle ${circleIndex + 1} intersects a simplified contour.`);
          break;
        }
      }
      if (errors.length && errors.at(-1).startsWith(`Exact circle ${circleIndex + 1} intersects`)) break;
    }
    for (let otherIndex = 0; otherIndex < circleIndex; otherIndex += 1) {
      const other = circles[otherIndex];
      if (Math.hypot(circle.cxMm - other.cxMm, circle.cyMm - other.cyMm) <=
          circle.radiusMm + other.radiusMm + EPSILON) {
        errors.push(`Exact circles ${otherIndex + 1} and ${circleIndex + 1} overlap.`);
      }
    }
  }
  return errors;
}

export function validateVectorGeometry(sourceContours, candidateContours, mask, sheet, circles = [], toleranceMm = 0) {
  assertMask(mask);
  assertSheet(sheet);
  const scaleX = sheet.widthMm / mask.width;
  const scaleY = sheet.heightMm / mask.height;
  const errors = [];
  if (!Array.isArray(sourceContours) || !Array.isArray(candidateContours) ||
      sourceContours.length !== candidateContours.length) {
    return { valid: false, maximumDeviationMm: null, errors: ['Contour count changed during simplification.'] };
  }
  let maximumDeviationMm = 0;
  for (let index = 0; index < candidateContours.length; index += 1) {
    const source = sourceContours[index];
    const candidate = candidateContours[index];
    if (!Array.isArray(candidate) || candidate.length < 3 ||
        candidate.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) {
      errors.push(`Contour ${index + 1} has insufficient or invalid vertices.`);
      continue;
    }
    const sourceArea = signedArea(source, scaleX, scaleY);
    const candidateArea = signedArea(candidate, scaleX, scaleY);
    if (Math.abs(candidateArea) <= EPSILON || Math.sign(sourceArea) !== Math.sign(candidateArea)) {
      errors.push(`Contour ${index + 1} changed orientation or collapsed.`);
    }
    maximumDeviationMm = Math.max(
      maximumDeviationMm,
      maximumContourDeviation(source, candidate, scaleX, scaleY),
    );
  }
  if (maximumDeviationMm > toleranceMm + 1e-7) {
    errors.push(`Maximum boundary deviation ${maximumDeviationMm.toFixed(4)} mm exceeds ${toleranceMm} mm.`);
  }
  errors.push(...intersectionErrors(candidateContours, scaleX, scaleY, sheet));
  const sourceContainment = containmentSignature(sourceContours, scaleX, scaleY, sheet);
  const candidateContainment = containmentSignature(candidateContours, scaleX, scaleY, sheet);
  if (JSON.stringify(sourceContainment) !== JSON.stringify(candidateContainment)) {
    errors.push('Contour nesting changed during simplification.');
  }
  errors.push(...circleErrors(candidateContours, circles, scaleX, scaleY, sheet));
  return {
    valid: errors.length === 0,
    maximumDeviationMm: Number.isFinite(maximumDeviationMm) ? maximumDeviationMm : null,
    errors: [...new Set(errors)].slice(0, 12),
  };
}

export function rasterizeVectorGeometry(contours, circles, mask, sheet) {
  assertMask(mask);
  assertSheet(sheet);
  const output = createMask(mask.width, mask.height, REMOVED);
  for (let y = 0; y < mask.height; y += 1) {
    const scanY = y + 0.5;
    const intersections = [];
    for (const contour of contours) {
      for (let index = 0; index < contour.length; index += 1) {
        const start = contour[index];
        const end = contour[(index + 1) % contour.length];
        if ((start.y > scanY) === (end.y > scanY)) continue;
        intersections.push(start.x + (scanY - start.y) * (end.x - start.x) / (end.y - start.y));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      const from = Math.max(0, Math.ceil(intersections[index] - 0.5));
      const to = Math.min(mask.width, Math.ceil(intersections[index + 1] - 0.5));
      output.data.fill(RETAINED, y * mask.width + from, y * mask.width + to);
    }
  }
  const scaleX = sheet.widthMm / mask.width;
  const scaleY = sheet.heightMm / mask.height;
  for (const circle of circles) {
    const minX = Math.max(0, Math.floor((circle.cxMm - circle.radiusMm) / scaleX));
    const maxX = Math.min(mask.width - 1, Math.ceil((circle.cxMm + circle.radiusMm) / scaleX));
    const minY = Math.max(0, Math.floor((circle.cyMm - circle.radiusMm) / scaleY));
    const maxY = Math.min(mask.height - 1, Math.ceil((circle.cyMm + circle.radiusMm) / scaleY));
    for (let y = minY; y <= maxY; y += 1) {
      const py = (y + 0.5) * scaleY;
      for (let x = minX; x <= maxX; x += 1) {
        const px = (x + 0.5) * scaleX;
        if (Math.hypot(px - circle.cxMm, py - circle.cyMm) <= circle.radiusMm) {
          output.data[y * mask.width + x] = REMOVED;
        }
      }
    }
  }
  return output;
}

export function prepareVectorGeometry(mask, sheet, exactCircleHoles = [], options = {}) {
  assertMask(mask);
  assertSheet(sheet);
  const exactRasterContours = traceMaskContours(mask);
  const source = separateCircleContours(exactRasterContours, mask, sheet, exactCircleHoles);
  const sourceVertexCount = source.contours.reduce((sum, contour) => sum + contour.length, 0);
  const exact = (report = {}) => ({
    contours: source.contours,
    matchedCircles: source.matchedCircles,
    exactRasterContours,
    rasterMask: source.matchedCircles.length
      ? rasterizeVectorGeometry(source.contours, source.matchedCircles, mask, sheet)
      : mask,
    report: {
      modelVersion: VECTOR_SIMPLIFICATION_MODEL_VERSION,
      requested: options.simplify === true,
      status: options.simplify === true ? 'fallback' : 'exact',
      requestedToleranceMm: options.simplify === true ? Number(options.toleranceMm) : null,
      appliedToleranceMm: null,
      sourceVertexCount,
      outputVertexCount: sourceVertexCount,
      maximumDeviationMm: 0,
      topologyValidated: true,
      fallbackReason: null,
      ...report,
    },
  });
  if (options.simplify !== true) return exact();
  const requestedToleranceMm = Number(options.toleranceMm);
  if (!Number.isFinite(requestedToleranceMm) || requestedToleranceMm <= 0) {
    return exact({ fallbackReason: 'The requested physical tolerance is invalid.' });
  }
  const scaleX = sheet.widthMm / mask.width;
  const scaleY = sheet.heightMm / mask.height;
  let lastErrors = [];
  for (const divisor of [1, 2, 4, 8, 16]) {
    const appliedToleranceMm = requestedToleranceMm / divisor;
    const contours = source.contours.map((contour) => (
      simplifyClosedContour(contour, scaleX, scaleY, appliedToleranceMm)
    ));
    const outputVertexCount = contours.reduce((sum, contour) => sum + contour.length, 0);
    if (outputVertexCount >= sourceVertexCount) {
      return exact({
        status: 'unchanged',
        requestedToleranceMm,
        fallbackReason: 'The exact trace already has no removable vertices within this tolerance.',
      });
    }
    const validation = validateVectorGeometry(
      source.contours,
      contours,
      mask,
      sheet,
      source.matchedCircles,
      appliedToleranceMm,
    );
    lastErrors = validation.errors;
    if (!validation.valid) continue;
    return {
      contours,
      matchedCircles: source.matchedCircles,
      exactRasterContours,
      rasterMask: rasterizeVectorGeometry(contours, source.matchedCircles, mask, sheet),
      report: {
        modelVersion: VECTOR_SIMPLIFICATION_MODEL_VERSION,
        requested: true,
        status: 'simplified',
        requestedToleranceMm,
        appliedToleranceMm,
        sourceVertexCount,
        outputVertexCount,
        maximumDeviationMm: validation.maximumDeviationMm,
        topologyValidated: true,
        fallbackReason: divisor === 1 ? null : 'A smaller safe tolerance was used to preserve topology.',
      },
    };
  }
  return exact({
    requestedToleranceMm,
    topologyValidated: false,
    fallbackReason: lastErrors[0] || 'No topology-preserving simplification was found.',
  });
}
