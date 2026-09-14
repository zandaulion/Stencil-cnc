import { RETAINED, assertMask, assertSheet } from "./mask.js";

/**
 * Extracts deterministic grid-aligned boundary loops from retained material.
 * Returned points use raster grid coordinates (not pixel-centre coordinates).
 *
 * @param {import('./mask.js').RasterMask} mask
 * @returns {Array<Array<{x: number, y: number}>>}
 */
export function traceMaskContours(mask) {
  assertMask(mask);
  const edges = [];
  const retainedAt = (x, y) => x >= 0 && y >= 0 && x < mask.width && y < mask.height &&
    mask.data[y * mask.width + x] === RETAINED;

  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (!retainedAt(x, y)) continue;
      if (!retainedAt(x, y - 1)) edges.push(edge(x, y, x + 1, y, 0));
      if (!retainedAt(x + 1, y)) edges.push(edge(x + 1, y, x + 1, y + 1, 1));
      if (!retainedAt(x, y + 1)) edges.push(edge(x + 1, y + 1, x, y + 1, 2));
      if (!retainedAt(x - 1, y)) edges.push(edge(x, y + 1, x, y, 3));
    }
  }

  edges.sort(compareEdges);
  const outgoing = new Map();
  for (let index = 0; index < edges.length; index += 1) {
    const key = vertexKey(edges[index].start.x, edges[index].start.y);
    if (!outgoing.has(key)) outgoing.set(key, []);
    outgoing.get(key).push(index);
  }

  const visited = new Uint8Array(edges.length);
  const contours = [];
  for (let startIndex = 0; startIndex < edges.length; startIndex += 1) {
    if (visited[startIndex]) continue;
    const start = edges[startIndex].start;
    const points = [{ ...start }];
    let currentIndex = startIndex;

    while (true) {
      if (visited[currentIndex]) throw new Error("Boundary tracing encountered an already-used edge");
      visited[currentIndex] = 1;
      const current = edges[currentIndex];
      const end = current.end;
      if (end.x === start.x && end.y === start.y) break;
      points.push({ ...end });

      const candidates = (outgoing.get(vertexKey(end.x, end.y)) ?? []).filter((index) => !visited[index]);
      if (candidates.length === 0) throw new Error("Raster boundary is unexpectedly open");
      currentIndex = chooseNextEdge(current.direction, candidates, edges);
    }
    contours.push(simplifyClosedContour(points));
  }
  return contours;
}

/**
 * Exports retained geometry at exact physical sheet dimensions. No timestamp,
 * random identifier, or environment-dependent value is included, so identical
 * input produces byte-for-byte identical SVG.
 *
 * @param {import('./mask.js').RasterMask} mask
 * @param {{ widthMm: number, heightMm: number }} sheet
 * @param {{ precision?: number, title?: string, fill?: string, includeXmlDeclaration?: boolean, units?: 'mm'|'in' }} [options]
 */
export function exportSvg(mask, sheet, options = {}) {
  assertMask(mask);
  assertSheet(sheet);
  const precision = options.precision ?? 6;
  if (!Number.isInteger(precision) || precision < 0 || precision > 12) {
    throw new RangeError("SVG precision must be an integer from 0 to 12");
  }
  const units = options.units ?? "mm";
  if (units !== "mm" && units !== "in") throw new RangeError("SVG units must be 'mm' or 'in'");
  const millimetresPerUnit = units === "in" ? 25.4 : 1;
  const widthInUnits = sheet.widthMm / millimetresPerUnit;
  const heightInUnits = sheet.heightMm / millimetresPerUnit;
  const width = formatNumber(widthInUnits, precision);
  const height = formatNumber(heightInUnits, precision);
  const fill = options.fill ?? "#000000";
  const contours = traceMaskContours(mask);
  const pathData = contours.map((contour) => contourToPath(
    contour,
    widthInUnits / mask.width,
    heightInUnits / mask.height,
    precision,
  )).join("");

  const lines = [];
  if (options.includeXmlDeclaration !== false) lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}${units}" height="${height}${units}" viewBox="0 0 ${width} ${height}">`);
  if (options.title) lines.push(`  <title>${escapeXml(options.title)}</title>`);
  if (pathData) {
    lines.push(`  <path data-stencil-role="retained-material" d="${pathData}" fill="${escapeXml(fill)}" fill-rule="evenodd"/>`);
  }
  lines.push("</svg>");
  return `${lines.join("\n")}\n`;
}

export const maskToSvg = exportSvg;

function edge(startX, startY, endX, endY, direction) {
  return {
    start: { x: startX, y: startY },
    end: { x: endX, y: endY },
    direction,
  };
}

function compareEdges(first, second) {
  return first.start.y - second.start.y ||
    first.start.x - second.start.x ||
    first.direction - second.direction ||
    first.end.y - second.end.y ||
    first.end.x - second.end.x;
}

function chooseNextEdge(incomingDirection, candidates, edges) {
  const turnPriority = new Map([[1, 0], [0, 1], [3, 2], [2, 3]]);
  return candidates.slice().sort((firstIndex, secondIndex) => {
    const firstTurn = (edges[firstIndex].direction - incomingDirection + 4) % 4;
    const secondTurn = (edges[secondIndex].direction - incomingDirection + 4) % 4;
    return turnPriority.get(firstTurn) - turnPriority.get(secondTurn) || firstIndex - secondIndex;
  })[0];
}

function simplifyClosedContour(points) {
  if (points.length <= 4) return points;
  let output = points;
  let changed = true;
  while (changed && output.length > 4) {
    changed = false;
    const next = [];
    for (let index = 0; index < output.length; index += 1) {
      const previous = output[(index - 1 + output.length) % output.length];
      const current = output[index];
      const following = output[(index + 1) % output.length];
      const firstDx = current.x - previous.x;
      const firstDy = current.y - previous.y;
      const secondDx = following.x - current.x;
      const secondDy = following.y - current.y;
      if (firstDx * secondDy === firstDy * secondDx && firstDx * secondDx + firstDy * secondDy > 0) {
        changed = true;
      } else {
        next.push(current);
      }
    }
    output = next;
  }
  return output;
}

function contourToPath(contour, scaleX, scaleY, precision) {
  if (contour.length === 0) return "";
  const first = contour[0];
  let result = `M${formatNumber(first.x * scaleX, precision)} ${formatNumber(first.y * scaleY, precision)}`;
  for (let index = 1; index < contour.length; index += 1) {
    const point = contour[index];
    result += `L${formatNumber(point.x * scaleX, precision)} ${formatNumber(point.y * scaleY, precision)}`;
  }
  return `${result}Z`;
}

function formatNumber(value, precision) {
  const rounded = Number(value.toFixed(precision));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function vertexKey(x, y) {
  return `${x},${y}`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
