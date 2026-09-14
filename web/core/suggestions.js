import { analyzeConnectivity } from "./connectivity.js";
import { assertMask, assertSameSize, assertSheet, pixelSizeMm, positiveFinite } from "./mask.js";

/**
 * Suggests straight, finite-width capsule bridges from each unsupported
 * component to the nearest supported-material boundary. Nearest points are
 * found with a deterministic two-pass 8-neighbour physical distance field;
 * emitted bridges still use exact physical endpoint coordinates.
 *
 * `maxPerIsland` requests ranked alternatives. Alternatives are intentionally
 * separated by at least one bridge width where the source geometry permits it.
 * Applying the first suggestion for every island is the normal workflow.
 *
 * @param {import('./mask.js').RasterMask} mask
 * @param {{
 *   sheet: {widthMm:number,heightMm:number},
 *   anchorMask?: import('./mask.js').RasterMask | null,
 *   anchorBoundary?: boolean,
 *   widthMm: number,
 *   maxPerIsland?: number,
 *   requireSingleComponent?: boolean,
 * }} config
 */
export function suggestBridges(mask, config) {
  if (config?.strategy?.mode === "smart") return suggestSmartBridges(mask, config);
  return suggestNearestBridges(mask, config);
}

/**
 * Backwards-compatible nearest-root planner. Kept for saved integrations and
 * low-level callers that do not opt into the filter-aware global planner.
 */
function suggestNearestBridges(mask, config) {
  assertMask(mask);
  if (!config || typeof config !== "object") throw new TypeError("Bridge suggestion configuration is required");
  assertSheet(config.sheet);
  positiveFinite(config.widthMm, "widthMm");
  if (config.anchorMask) assertSameSize(mask, config.anchorMask);
  const maxPerIsland = config.maxPerIsland ?? 1;
  if (!Number.isInteger(maxPerIsland) || maxPerIsland <= 0 || maxPerIsland > 20) {
    throw new RangeError("maxPerIsland must be an integer from 1 to 20");
  }

  const analysis = analyzeConnectivity(mask, {
    anchorMask: config.anchorMask ?? null,
    anchorBoundary: config.anchorBoundary,
  });
  let islands = analysis.islands;
  let supportedComponents = analysis.supportedComponents;
  if (config.requireSingleComponent === true) {
    if (analysis.componentCount <= 1) return [];
    const roots = (supportedComponents.length ? supportedComponents : analysis.components)
      .slice()
      .sort((first, second) => second.pixelCount - first.pixelCount || first.id - second.id);
    supportedComponents = roots.slice(0, 1);
    const rootId = supportedComponents[0].id;
    islands = analysis.components.filter((component) => component.id !== rootId);
  }
  if (islands.length === 0 || supportedComponents.length === 0) return [];

  const supportedIds = new Set(supportedComponents.map((component) => component.id));
  const distanceField = nearestSupportedBoundary(mask, analysis.labels, supportedIds, config.sheet);
  const pixel = pixelSizeMm(mask, config.sheet);
  const minimumSeparation = Math.max(config.widthMm, Math.min(pixel.x, pixel.y) * 2);
  const suggestions = [];

  for (const island of islands) {
    const candidates = [];
    for (let y = island.bounds.minY; y <= island.bounds.maxY; y += 1) {
      for (let x = island.bounds.minX; x <= island.bounds.maxX; x += 1) {
        const index = y * mask.width + x;
        if (analysis.labels[index] !== island.id || !isComponentBoundary(index, island.id, analysis.labels, mask.width, mask.height)) {
          continue;
        }
        const targetIndex = distanceField.source[index];
        if (targetIndex < 0) continue;
        const targetX = targetIndex % mask.width;
        const targetY = Math.floor(targetIndex / mask.width);
        const start = { x: (x + 0.5) * pixel.x, y: (y + 0.5) * pixel.y };
        const end = { x: (targetX + 0.5) * pixel.x, y: (targetY + 0.5) * pixel.y };
        candidates.push({
          start,
          end,
          startIndex: index,
          targetIndex,
          targetComponentId: analysis.labels[targetIndex],
          lengthMm: Math.hypot(start.x - end.x, start.y - end.y),
        });
      }
    }
    candidates.sort(compareCandidates);

    const selected = [];
    for (const candidate of candidates) {
      if (selected.length >= maxPerIsland) break;
      if (selected.every((prior) => endpointsAreSeparated(prior, candidate, minimumSeparation))) {
        selected.push(candidate);
      }
    }
    // A tiny component may not have enough spatially distinct alternatives.
    // The nearest candidate is always retained even when separation is moot.
    if (selected.length === 0 && candidates.length > 0) selected.push(candidates[0]);

    selected.forEach((candidate, rank) => {
      suggestions.push({
        id: `auto-${island.id}-${rank + 1}`,
        type: "capsule",
        enabled: true,
        units: "mm",
        start: candidate.start,
        end: candidate.end,
        width: config.widthMm,
        islandComponentId: island.id,
        targetComponentId: candidate.targetComponentId,
        lengthMm: roundMetric(candidate.lengthMm),
        rank: rank + 1,
        source: "automatic",
      });
    });
  }

  return suggestions;
}

/**
 * Builds one sparse component graph for the whole artwork, then chooses the
 * least visually disruptive connector tree. Unlike the legacy per-island
 * planner, an island may connect through a neighbouring island and a single
 * tie may join several components it crosses.
 *
 * @param {import('./mask.js').RasterMask} mask
 * @param {{
 *   sheet: {widthMm:number,heightMm:number},
 *   anchorMask?: import('./mask.js').RasterMask | null,
 *   anchorBoundary?: boolean,
 *   widthMm: number,
 *   requireSingleComponent?: boolean,
 *   minimumWebMm?: number,
 *   kerfMm?: number,
 *   strategy: {
 *     mode:'smart', kind?:string, level?:1|2|3,
 *     preferredAngleDeg?:number,
 *     radialCenter?:{x:number,y:number},
 *     detailAt?:(point:{x:number,y:number})=>number,
 *   },
 * }} config
 */
function suggestSmartBridges(mask, config) {
  assertMask(mask);
  if (!config || typeof config !== "object") throw new TypeError("Bridge suggestion configuration is required");
  assertSheet(config.sheet);
  positiveFinite(config.widthMm, "widthMm");
  if (config.anchorMask) assertSameSize(mask, config.anchorMask);
  const strategy = normalizeStrategy(config.strategy);
  const minimumWebMm = nonNegative(config.minimumWebMm ?? 0, "minimumWebMm");
  const kerfMm = nonNegative(config.kerfMm ?? 0, "kerfMm");
  // Kerf eats one half from both sides of a retained tie. Generate the width
  // that must exist before cutting instead of knowingly proposing a bridge
  // the post-kerf connectivity check will remove.
  const widthMm = Math.max(config.widthMm, minimumWebMm + kerfMm);

  const analysis = analyzeConnectivity(mask, {
    anchorMask: config.anchorMask ?? null,
    anchorBoundary: config.anchorBoundary,
  });
  if (analysis.componentCount <= 1) return [];

  const roots = chooseRoots(analysis, config.requireSingleComponent === true);
  const componentIds = analysis.components.map((component) => component.id);
  const field = nearestEveryComponentBoundary(mask, analysis.labels, config.sheet);
  const candidates = componentGraphCandidates(
    mask, analysis.labels, field.source, config.sheet, widthMm, strategy,
  );
  const chosen = connectorTree(candidates, componentIds, roots, mask, analysis.labels, config.sheet, widthMm);

  // A two-pass distance field is deliberately bounded and deterministic. In
  // pathological one-pixel mazes its sparse graph can miss an adjacency; the
  // proven nearest-root planner remains a safety fallback rather than letting
  // the UI claim success with loose pieces.
  if (!connectsEveryComponent(chosen, componentIds, roots)) {
    return suggestNearestBridges(mask, {
      ...config,
      widthMm,
      maxPerIsland: 1,
    }).map((bridge) => ({
      ...bridge,
      fallback: true,
      strategy: strategy.kind,
      aestheticScore: null,
      addedAreaMm2: roundMetric(bridge.lengthMm * widthMm),
    }));
  }

  let minimal = pruneRedundantConnections(chosen, componentIds, roots);
  if (strategy.level === 3) {
    minimal = addSeparatedRedundancy(minimal, candidates, componentIds.length, widthMm);
  }
  return minimal.map((candidate, index) => bridgeFromSmartCandidate(
    candidate, index, widthMm, strategy.kind, roots,
  ));
}

function normalizeStrategy(strategy) {
  const level = Number(strategy?.level ?? 2);
  if (![1, 2, 3].includes(level)) throw new RangeError("strategy.level must be 1, 2, or 3");
  const preferredAngleDeg = strategy?.preferredAngleDeg;
  if (preferredAngleDeg !== undefined && !Number.isFinite(preferredAngleDeg)) {
    throw new RangeError("strategy.preferredAngleDeg must be finite");
  }
  const radialCenter = strategy?.radialCenter;
  if (radialCenter && (!Number.isFinite(radialCenter.x) || !Number.isFinite(radialCenter.y))) {
    throw new RangeError("strategy.radialCenter must contain finite coordinates");
  }
  if (strategy?.detailAt !== undefined && typeof strategy.detailAt !== "function") {
    throw new TypeError("strategy.detailAt must be a function");
  }
  return {
    kind: typeof strategy?.kind === "string" ? strategy.kind : "generic",
    level,
    preferredAngleDeg,
    radialCenter,
    detailAt: strategy?.detailAt ?? null,
  };
}

function chooseRoots(analysis, requireSingleComponent) {
  const ranked = (analysis.supportedComponents.length
    ? analysis.supportedComponents
    : analysis.components).slice().sort(
    (first, second) => second.pixelCount - first.pixelCount || first.id - second.id,
  );
  return requireSingleComponent ? [ranked[0].id] : ranked.map((component) => component.id);
}

/** Seed every component boundary, then form an approximate physical Voronoi field. */
function nearestEveryComponentBoundary(mask, labels, sheet) {
  const distance = new Float64Array(mask.data.length);
  distance.fill(Number.POSITIVE_INFINITY);
  const source = new Int32Array(mask.data.length);
  source.fill(-1);

  for (let index = 0; index < labels.length; index += 1) {
    const id = labels[index];
    if (id > 0 && isComponentBoundary(index, id, labels, mask.width, mask.height)) {
      distance[index] = 0;
      source[index] = index;
    }
  }

  const pixel = pixelSizeMm(mask, sheet);
  const diagonal = Math.hypot(pixel.x, pixel.y);
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      const index = y * mask.width + x;
      if (x > 0) relax(index, index - 1, pixel.x, distance, source);
      if (y > 0) relax(index, index - mask.width, pixel.y, distance, source);
      if (x > 0 && y > 0) relax(index, index - mask.width - 1, diagonal, distance, source);
      if (x + 1 < mask.width && y > 0) relax(index, index - mask.width + 1, diagonal, distance, source);
    }
  }
  for (let y = mask.height - 1; y >= 0; y -= 1) {
    for (let x = mask.width - 1; x >= 0; x -= 1) {
      const index = y * mask.width + x;
      if (x + 1 < mask.width) relax(index, index + 1, pixel.x, distance, source);
      if (y + 1 < mask.height) relax(index, index + mask.width, pixel.y, distance, source);
      if (x + 1 < mask.width && y + 1 < mask.height) relax(index, index + mask.width + 1, diagonal, distance, source);
      if (x > 0 && y + 1 < mask.height) relax(index, index + mask.width - 1, diagonal, distance, source);
    }
  }
  return { distance, source };
}

/** Keep a few aesthetically distinct ties for each neighbouring component pair. */
function componentGraphCandidates(mask, labels, source, sheet, widthMm, strategy) {
  const pixel = pixelSizeMm(mask, sheet);
  const byPair = new Map();
  const visitSeam = (firstIndex, secondIndex) => {
    const firstSource = source[firstIndex];
    const secondSource = source[secondIndex];
    if (firstSource < 0 || secondSource < 0) return;
    let firstId = labels[firstSource];
    let secondId = labels[secondSource];
    if (firstId <= 0 || secondId <= 0 || firstId === secondId) return;
    let startIndex = firstSource;
    let targetIndex = secondSource;
    if (firstId > secondId) {
      [firstId, secondId] = [secondId, firstId];
      [startIndex, targetIndex] = [targetIndex, startIndex];
    }
    const start = indexToMm(startIndex, mask.width, pixel);
    const end = indexToMm(targetIndex, mask.width, pixel);
    const lengthMm = Math.hypot(start.x - end.x, start.y - end.y);
    if (lengthMm <= 0) return;
    const candidate = {
      firstId,
      secondId,
      start,
      end,
      startIndex,
      targetIndex,
      lengthMm,
    };
    Object.assign(candidate, scoreVisualCandidate(candidate, widthMm, strategy));
    const key = `${firstId}:${secondId}`;
    const alternatives = byPair.get(key) ?? [];
    if (alternatives.some((item) => item.startIndex === startIndex && item.targetIndex === targetIndex)) return;
    alternatives.push(candidate);
    alternatives.sort(compareSmartCandidates);
    // More than six mainly repeats adjacent raster positions. Keeping a small
    // separated set lets detail protection move a tie without making a large
    // photograph consume an unbounded candidate graph.
    const separated = [];
    for (const item of alternatives) {
      if (separated.every((prior) => endpointsAreSeparated(prior, item, widthMm))) separated.push(item);
      if (separated.length >= 6) break;
    }
    byPair.set(key, separated);
  };

  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      const index = y * mask.width + x;
      if (x + 1 < mask.width) visitSeam(index, index + 1);
      if (y + 1 < mask.height) visitSeam(index, index + mask.width);
    }
  }
  return [...byPair.values()].flat().sort(compareSmartCandidates);
}

function scoreVisualCandidate(candidate, widthMm, strategy) {
  const midpoint = {
    x: (candidate.start.x + candidate.end.x) / 2,
    y: (candidate.start.y + candidate.end.y) / 2,
  };
  let preferred = strategy.preferredAngleDeg;
  if (strategy.kind === "raze" && strategy.radialCenter) {
    const radial = Math.atan2(
      midpoint.y - strategy.radialCenter.y,
      midpoint.x - strategy.radialCenter.x,
    ) * 180 / Math.PI;
    preferred = radial + 90;
  }
  const actual = Math.atan2(
    candidate.end.y - candidate.start.y,
    candidate.end.x - candidate.start.x,
  ) * 180 / Math.PI;
  const angleErrorDeg = Number.isFinite(preferred) ? angleDistance180(actual, preferred) : 0;
  const alignmentPenalty = Math.sin(angleErrorDeg * Math.PI / 180) ** 2;
  const detailPenalty = strategy.detailAt ? sampleBridgeDetail(candidate, strategy.detailAt) : 0;
  const alignmentWeight = strategy.level === 1 ? 0.8 : strategy.level === 2 ? 4.5 : 2.5;
  const detailWeight = strategy.level === 1 ? 0.8 : strategy.level === 2 ? 3.5 : 2.0;
  const addedAreaMm2 = candidate.lengthMm * widthMm;
  return {
    score: addedAreaMm2 * (1 + alignmentWeight * alignmentPenalty + detailWeight * detailPenalty),
    addedAreaMm2,
    angleErrorDeg,
    detailPenalty,
  };
}

function sampleBridgeDetail(candidate, detailAt) {
  let total = 0;
  let maximum = 0;
  const samples = 9;
  for (let index = 0; index < samples; index += 1) {
    const t = (index + 0.5) / samples;
    const value = clamp01(Number(detailAt({
      x: candidate.start.x + (candidate.end.x - candidate.start.x) * t,
      y: candidate.start.y + (candidate.end.y - candidate.start.y) * t,
    })) || 0);
    total += value;
    maximum = Math.max(maximum, value);
  }
  // One eye or mouth crossed by a bridge matters even when the rest of the
  // segment lies over quiet tone, hence the maximum shares the average.
  return (total / samples + maximum) / 2;
}

function connectorTree(candidates, componentIds, roots, mask, labels, sheet, widthMm) {
  const sets = new DisjointSet(Math.max(...componentIds));
  for (let index = 1; index < roots.length; index += 1) sets.union(roots[0], roots[index]);
  const chosen = [];
  for (const candidate of candidates) {
    if (sets.find(candidate.firstId) === sets.find(candidate.secondId)) continue;
    const componentIdsAlongBridge = touchedComponents(
      candidate, mask, labels, sheet, widthMm,
    );
    candidate.componentIds = componentIdsAlongBridge;
    chosen.push(candidate);
    const first = componentIdsAlongBridge[0];
    for (let index = 1; index < componentIdsAlongBridge.length; index += 1) {
      sets.union(first, componentIdsAlongBridge[index]);
    }
    if (componentIds.every((id) => sets.find(id) === sets.find(roots[0]))) break;
  }
  return chosen;
}

function touchedComponents(candidate, mask, labels, sheet, widthMm) {
  const pixel = pixelSizeMm(mask, sheet);
  const startX = candidate.startIndex % mask.width;
  const startY = Math.floor(candidate.startIndex / mask.width);
  const endX = candidate.targetIndex % mask.width;
  const endY = Math.floor(candidate.targetIndex / mask.width);
  const steps = Math.max(Math.abs(endX - startX), Math.abs(endY - startY), 1);
  const radiusX = Math.max(1, Math.ceil(widthMm / 2 / pixel.x));
  const radiusY = Math.max(1, Math.ceil(widthMm / 2 / pixel.y));
  const stride = Math.max(1, Math.floor(Math.min(radiusX, radiusY) / 2));
  const found = new Set([candidate.firstId, candidate.secondId]);
  for (let step = 0; step <= steps; step += stride) {
    const t = Math.min(1, step / steps);
    const x = Math.round(startX + (endX - startX) * t);
    const y = Math.round(startY + (endY - startY) * t);
    for (const [offsetX, offsetY] of [
      [0, 0], [radiusX, 0], [-radiusX, 0], [0, radiusY], [0, -radiusY],
      [Math.round(radiusX * 0.7), Math.round(radiusY * 0.7)],
      [-Math.round(radiusX * 0.7), Math.round(radiusY * 0.7)],
      [Math.round(radiusX * 0.7), -Math.round(radiusY * 0.7)],
      [-Math.round(radiusX * 0.7), -Math.round(radiusY * 0.7)],
    ]) {
      const sampleX = x + offsetX;
      const sampleY = y + offsetY;
      if (sampleX < 0 || sampleY < 0 || sampleX >= mask.width || sampleY >= mask.height) continue;
      const id = labels[sampleY * mask.width + sampleX];
      if (id > 0) found.add(id);
    }
  }
  return [...found].sort((first, second) => first - second);
}

function connectsEveryComponent(candidates, componentIds, roots) {
  if (componentIds.length <= 1) return true;
  const sets = new DisjointSet(Math.max(...componentIds));
  for (let index = 1; index < roots.length; index += 1) sets.union(roots[0], roots[index]);
  for (const candidate of candidates) {
    const ids = candidate.componentIds ?? [candidate.firstId, candidate.secondId];
    for (let index = 1; index < ids.length; index += 1) sets.union(ids[0], ids[index]);
  }
  return componentIds.every((id) => sets.find(id) === sets.find(roots[0]));
}

function pruneRedundantConnections(candidates, componentIds, roots) {
  const kept = candidates.slice();
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const without = kept.filter((_, candidateIndex) => candidateIndex !== index);
    if (connectsEveryComponent(without, componentIds, roots)) kept.splice(index, 1);
  }
  return kept;
}

function addSeparatedRedundancy(chosen, candidates, componentCount, widthMm) {
  const result = chosen.slice();
  const chosenKeys = new Set(chosen.map((candidate) => `${candidate.startIndex}:${candidate.targetIndex}`));
  const limit = Math.min(10, Math.max(1, Math.ceil((componentCount - 1) * 0.2)));
  for (const candidate of candidates) {
    if (result.length >= chosen.length + limit) break;
    if (chosenKeys.has(`${candidate.startIndex}:${candidate.targetIndex}`)) continue;
    if (!result.every((prior) => endpointsAreSeparated(prior, candidate, widthMm * 2))) continue;
    candidate.componentIds ??= [candidate.firstId, candidate.secondId];
    candidate.redundant = true;
    result.push(candidate);
  }
  return result;
}

function bridgeFromSmartCandidate(candidate, index, widthMm, kind, roots) {
  const componentIds = candidate.componentIds ?? [candidate.firstId, candidate.secondId];
  const rootSet = new Set(roots);
  const islandComponentId = componentIds.find((id) => !rootSet.has(id)) ?? candidate.firstId;
  return {
    id: `auto-smart-${index + 1}`,
    type: "capsule",
    enabled: true,
    units: "mm",
    start: candidate.start,
    end: candidate.end,
    width: widthMm,
    islandComponentId,
    targetComponentId: componentIds.find((id) => id !== islandComponentId) ?? candidate.secondId,
    componentIds,
    lengthMm: roundMetric(candidate.lengthMm),
    addedAreaMm2: roundMetric(candidate.addedAreaMm2),
    aestheticScore: roundMetric(candidate.score),
    angleErrorDeg: roundMetric(candidate.angleErrorDeg),
    detailPenalty: roundMetric(candidate.detailPenalty),
    strategy: kind,
    redundant: candidate.redundant === true,
    fallback: false,
    rank: index + 1,
    source: "automatic",
  };
}

function indexToMm(index, width, pixel) {
  return {
    x: (index % width + 0.5) * pixel.x,
    y: (Math.floor(index / width) + 0.5) * pixel.y,
  };
}

function compareSmartCandidates(first, second) {
  return first.score - second.score || first.lengthMm - second.lengthMm ||
    first.startIndex - second.startIndex || first.targetIndex - second.targetIndex;
}

function angleDistance180(first, second) {
  const difference = Math.abs(((first - second + 90) % 180 + 180) % 180 - 90);
  return Math.min(90, difference);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function nonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative`);
  return value;
}

class DisjointSet {
  constructor(maximumId) {
    this.parent = Int32Array.from({ length: maximumId + 1 }, (_, index) => index);
    this.rank = new Uint8Array(maximumId + 1);
  }

  find(id) {
    let root = id;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[id] !== id) {
      const parent = this.parent[id];
      this.parent[id] = root;
      id = parent;
    }
    return root;
  }

  union(first, second) {
    let firstRoot = this.find(first);
    let secondRoot = this.find(second);
    if (firstRoot === secondRoot) return false;
    if (this.rank[firstRoot] < this.rank[secondRoot]) [firstRoot, secondRoot] = [secondRoot, firstRoot];
    this.parent[secondRoot] = firstRoot;
    if (this.rank[firstRoot] === this.rank[secondRoot]) this.rank[firstRoot] += 1;
    return true;
  }
}

function nearestSupportedBoundary(mask, labels, supportedIds, sheet) {
  const distance = new Float64Array(mask.data.length);
  distance.fill(Number.POSITIVE_INFINITY);
  const source = new Int32Array(mask.data.length);
  source.fill(-1);

  for (let index = 0; index < labels.length; index += 1) {
    const id = labels[index];
    if (supportedIds.has(id) && isComponentBoundary(index, id, labels, mask.width, mask.height)) {
      distance[index] = 0;
      source[index] = index;
    }
  }

  const pixel = pixelSizeMm(mask, sheet);
  const diagonal = Math.hypot(pixel.x, pixel.y);
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      const index = y * mask.width + x;
      if (x > 0) relax(index, index - 1, pixel.x, distance, source);
      if (y > 0) relax(index, index - mask.width, pixel.y, distance, source);
      if (x > 0 && y > 0) relax(index, index - mask.width - 1, diagonal, distance, source);
      if (x + 1 < mask.width && y > 0) relax(index, index - mask.width + 1, diagonal, distance, source);
    }
  }
  for (let y = mask.height - 1; y >= 0; y -= 1) {
    for (let x = mask.width - 1; x >= 0; x -= 1) {
      const index = y * mask.width + x;
      if (x + 1 < mask.width) relax(index, index + 1, pixel.x, distance, source);
      if (y + 1 < mask.height) relax(index, index + mask.width, pixel.y, distance, source);
      if (x + 1 < mask.width && y + 1 < mask.height) relax(index, index + mask.width + 1, diagonal, distance, source);
      if (x > 0 && y + 1 < mask.height) relax(index, index + mask.width - 1, diagonal, distance, source);
    }
  }
  return { distance, source };
}

function relax(index, neighbour, edgeLength, distance, source) {
  if (source[neighbour] < 0) return;
  const candidateDistance = distance[neighbour] + edgeLength;
  const candidateSource = source[neighbour];
  const isShorter = candidateDistance < distance[index] - 1e-12;
  const isStableTie = Math.abs(candidateDistance - distance[index]) <= 1e-12 &&
    (source[index] < 0 || candidateSource < source[index]);
  if (isShorter || isStableTie) {
    distance[index] = candidateDistance;
    source[index] = candidateSource;
  }
}

function isComponentBoundary(index, id, labels, width, height) {
  const x = index % width;
  const y = Math.floor(index / width);
  return x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
    labels[index - 1] !== id || labels[index + 1] !== id ||
    labels[index - width] !== id || labels[index + width] !== id;
}

function compareCandidates(first, second) {
  return first.lengthMm - second.lengthMm ||
    first.startIndex - second.startIndex ||
    first.targetIndex - second.targetIndex;
}

function endpointsAreSeparated(first, second, minimum) {
  const startDistance = Math.hypot(first.start.x - second.start.x, first.start.y - second.start.y);
  const endDistance = Math.hypot(first.end.x - second.end.x, first.end.y - second.end.y);
  return startDistance >= minimum || endDistance >= minimum;
}

function roundMetric(value) {
  return Number(value.toFixed(6));
}
