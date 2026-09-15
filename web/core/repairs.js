import { physicalDiscIndices, physicalStrokeIndices } from "./editing.js";
import {
  REMOVED,
  RETAINED,
  assertMask,
  assertSameSize,
  assertSheet,
  cloneMask,
  pixelSizeMm,
} from "./mask.js";

const STRATEGIES = new Set(["preserve", "balanced", "durable"]);
const ACTIONS = new Set(["close", "enlarge", "merge"]);

/**
 * Builds reversible repair choices for every opening rejected by validation.
 * The plan contains edits for all three choices, so the UI can switch an
 * individual opening without rerunning connectivity analysis.
 *
 * `protectedMask` identifies frame/support pixels that must not be carved by
 * an enlargement or merge. Closing an opening may still add material there.
 *
 * @param {import('./mask.js').RasterMask} mask
 * @param {ReturnType<import('./validation.js').validateDesign>} validation
 * @param {{
 *   sheet: {widthMm:number,heightMm:number},
 *   strategy?: "preserve"|"balanced"|"durable",
 *   targetOpeningMm: number,
 *   minimumWebMm?: number,
 *   protectedMask?: import('./mask.js').RasterMask|null,
 * }} options
 */
export function planSmallOpeningRepairs(mask, validation, options) {
  assertMask(mask);
  if (!validation || typeof validation !== "object") throw new TypeError("Validation result is required");
  assertSheet(options?.sheet);
  const strategy = options.strategy ?? "balanced";
  if (!STRATEGIES.has(strategy)) throw new RangeError("Unknown repair strategy");
  const targetOpeningMm = positive(options.targetOpeningMm, "targetOpeningMm");
  const minimumWebMm = nonNegative(options.minimumWebMm ?? 0, "minimumWebMm");
  const protectedMask = options.protectedMask ?? null;
  if (protectedMask) assertSameSize(mask, protectedMask);

  const labels = validation.removed?.labels;
  const components = validation.undersizedOpenings ?? [];
  if (!(labels instanceof Int32Array) || components.length === 0) {
    return emptyPlan(strategy, targetOpeningMm, minimumWebMm);
  }

  const pixel = pixelSizeMm(mask, options.sheet);
  // The validator treats neighbouring pixel cells conservatively. Add one
  // raster diagonal so a nominally safe opening still contains a surviving
  // core instead of landing exactly on a quantisation boundary.
  const rasterSafeOpeningMm = targetOpeningMm + Math.hypot(pixel.x, pixel.y);
  const items = components.map((component, position) => {
    const indices = indicesForComponent(mask, labels, component);
    const centre = centroid(mask, indices, component.bounds);
    const areaMm2 = indices.length * pixel.x * pixel.y;
    const equivalentDiameterMm = 2 * Math.sqrt(areaMm2 / Math.PI);
    const shortSpanMm = Math.min(component.bounds.width * pixel.x, component.bounds.height * pixel.y);
    const longSpanMm = Math.max(component.bounds.width * pixel.x, component.bounds.height * pixel.y);
    const elongated = longSpanMm / Math.max(shortSpanMm, Math.min(pixel.x, pixel.y)) >= 2.4;
    const meaningful = isMeaningful({
      strategy,
      equivalentDiameterMm,
      longSpanMm,
      targetOpeningMm,
      elongated,
    });

    const enlarge = physicalDiscIndices(mask, centre, rasterSafeOpeningMm, options.sheet)
      .filter((index) => protectedMask?.data[index] !== RETAINED);
    const neighbour = nearestOtherOpening(mask, labels, component.id, indices, options.sheet, minimumWebMm);
    const merge = neighbour
      ? unique([
          ...enlarge,
          ...physicalStrokeIndices(mask, neighbour.from, neighbour.to, rasterSafeOpeningMm, options.sheet),
        ]).filter((index) => protectedMask?.data[index] !== RETAINED)
      : null;
    const canEnlarge = enlarge.some((index) => mask.data[index] === RETAINED);
    const canMerge = Boolean(merge?.some((index) => mask.data[index] === RETAINED));
    const recommended = meaningful && canMerge
      ? "merge"
      : meaningful && canEnlarge
        ? "enlarge"
        : "close";

    return {
      id: `opening-${component.id}`,
      position,
      componentId: component.id,
      pixelCount: component.pixelCount,
      bounds: component.bounds,
      centre,
      equivalentDiameterMm,
      shortSpanMm,
      longSpanMm,
      similarityKey: `${elongated ? "elongated" : "compact"}-${sizeBand(equivalentDiameterMm / targetOpeningMm)}`,
      action: recommended,
      recommended,
      availableActions: {
        close: true,
        enlarge: canEnlarge,
        merge: canMerge,
      },
      edits: {
        close: { keep: indices, remove: [] },
        enlarge: { keep: [], remove: enlarge },
        merge: canMerge ? { keep: [], remove: merge } : null,
      },
      mergeGapMm: neighbour?.gapMm ?? null,
    };
  });

  const plan = {
    kind: "small-openings",
    strategy,
    targetOpeningMm,
    minimumWebMm,
    items,
    counts: countActions(items),
  };
  return plan;
}

/**
 * Builds reversible repairs for every pair of cut regions that is closer than
 * the machine's minimum web. Each strategy expresses a different trade-off:
 * preserve joins the two cuts, balanced adds a local metal pad to widen their
 * separation, and durable closes the smaller cut region entirely.
 *
 * The validator supplies one closest-point location per cut-component pair,
 * preventing a long parallel near-miss from producing hundreds of edits.
 *
 * @param {import('./mask.js').RasterMask} mask
 * @param {ReturnType<import('./validation.js').validateDesign>} validation
 * @param {{
 *   sheet:{widthMm:number,heightMm:number},
 *   strategy?:"preserve"|"balanced"|"durable",
 *   targetGapMm:number,
 *   targetOpeningMm:number,
 *   protectedMask?:import('./mask.js').RasterMask|null,
 * }} options
 */
export function planCutGapRepairs(mask, validation, options) {
  assertMask(mask);
  if (!validation || typeof validation !== "object") throw new TypeError("Validation result is required");
  assertSheet(options?.sheet);
  const strategy = options.strategy ?? "balanced";
  if (!STRATEGIES.has(strategy)) throw new RangeError("Unknown repair strategy");
  const targetGapMm = positive(options.targetGapMm, "targetGapMm");
  const targetOpeningMm = positive(options.targetOpeningMm, "targetOpeningMm");
  const protectedMask = options.protectedMask ?? null;
  if (protectedMask) assertSameSize(mask, protectedMask);

  const issue = validation.issues?.find((entry) => entry.code === "MIN_CUT_GAP");
  const locations = issue?.details?.locations ?? [];
  const labels = validation.removed?.labels;
  const components = validation.removed?.components ?? [];
  if (!(labels instanceof Int32Array) || locations.length === 0) {
    return {
      kind: "cut-gaps",
      strategy,
      targetGapMm,
      targetOpeningMm,
      items: [],
      counts: { close: 0, enlarge: 0, merge: 0 },
    };
  }

  const pixel = pixelSizeMm(mask, options.sheet);
  const rasterAllowanceMm = Math.hypot(pixel.x, pixel.y);
  const componentsById = new Map(components.map((component) => [component.id, component]));
  const componentIndices = new Map();
  const indicesForId = (id) => {
    if (!componentIndices.has(id)) {
      const component = componentsById.get(id);
      componentIndices.set(id, component ? indicesForComponent(mask, labels, component) : []);
    }
    return componentIndices.get(id);
  };

  const items = locations.map((location, position) => {
    const [firstId, secondId] = location.componentIds;
    const first = componentsById.get(firstId);
    const second = componentsById.get(secondId);
    const smaller = !second || (first && first.pixelCount <= second.pixelCount) ? first : second;
    const close = smaller ? indicesForId(smaller.id) : [];
    const deficitMm = Math.max(0, targetGapMm - location.gapMm);
    const padDiameterMm = Math.max(
      Math.min(pixel.x, pixel.y),
      deficitMm + rasterAllowanceMm,
    );
    const widen = unique(location.points.flatMap((point) =>
      physicalDiscIndices(mask, point, padDiameterMm, options.sheet)));
    const merge = physicalStrokeIndices(
      mask,
      location.points[0],
      location.points[1],
      Math.max(targetOpeningMm, rasterAllowanceMm),
      options.sheet,
    );
    const mergeProtected = merge.some((index) =>
      protectedMask?.data[index] === RETAINED && mask.data[index] === RETAINED);
    const canClose = close.some((index) => mask.data[index] === REMOVED);
    const canWiden = widen.some((index) => mask.data[index] === REMOVED);
    const canMerge = !mergeProtected && merge.some((index) => mask.data[index] === RETAINED);
    const preferred = { preserve: "merge", balanced: "enlarge", durable: "close" }[strategy];
    const availableActions = { close: canClose, enlarge: canWiden, merge: canMerge };
    const recommended = availableActions[preferred]
      ? preferred
      : ["enlarge", "merge", "close"].find((action) => availableActions[action]) ?? "close";
    const smallerAreaMm2 = (smaller?.pixelCount ?? 0) * pixel.x * pixel.y;
    const smallerDiameterMm = 2 * Math.sqrt(smallerAreaMm2 / Math.PI);

    return {
      id: `cut-gap-${firstId}-${secondId}`,
      position,
      componentIds: [firstId, secondId],
      bounds: location.bounds,
      points: location.points,
      gapMm: location.gapMm,
      deficitMm,
      smallerComponentId: smaller?.id ?? null,
      smallerDiameterMm,
      similarityKey: `gap-${sizeBand(location.gapMm / targetGapMm)}-${sizeBand(smallerDiameterMm / targetOpeningMm)}`,
      action: recommended,
      recommended,
      availableActions,
      edits: {
        close: canClose ? { keep: close, remove: [] } : null,
        enlarge: canWiden ? { keep: widen, remove: [] } : null,
        merge: canMerge ? { keep: [], remove: merge } : null,
      },
    };
  });

  return {
    kind: "cut-gaps",
    strategy,
    targetGapMm,
    targetOpeningMm,
    items,
    counts: countActions(items),
  };
}

/**
 * Plans conservative cleanup of tiny retained islands. A one-cell island is
 * always eligible because it is raster noise, while broader cleanup depends
 * on the chosen strategy. Larger detached artwork is deliberately left for a
 * support bridge instead of being erased without consent.
 *
 * @param {import('./mask.js').RasterMask} mask
 * @param {ReturnType<import('./validation.js').validateDesign>} validation
 * @param {{
 *   sheet:{widthMm:number,heightMm:number},
 *   strategy?:"preserve"|"balanced"|"durable",
 *   minimumWebMm:number,
 *   protectedMask?:import('./mask.js').RasterMask|null,
 * }} options
 */
export function planLoosePieceRepairs(mask, validation, options) {
  assertMask(mask);
  if (!validation || typeof validation !== "object") throw new TypeError("Validation result is required");
  assertSheet(options?.sheet);
  const strategy = options.strategy ?? "balanced";
  if (!STRATEGIES.has(strategy)) throw new RangeError("Unknown repair strategy");
  const minimumWebMm = positive(options.minimumWebMm, "minimumWebMm");
  const protectedMask = options.protectedMask ?? null;
  if (protectedMask) assertSameSize(mask, protectedMask);

  const issue = validation.issues?.find((entry) => entry.code === "DISCONNECTED_RETAINED_MATERIAL");
  const locations = issue?.details?.locations ?? [];
  const labels = validation.initial?.labels;
  const components = validation.initial?.components ?? [];
  if (!(labels instanceof Int32Array) || locations.length === 0) {
    return {
      kind: "loose-pieces",
      strategy,
      minimumWebMm,
      totalCount: 0,
      skippedCount: 0,
      items: [],
      counts: { close: 0, enlarge: 0, merge: 0 },
    };
  }

  const pixel = pixelSizeMm(mask, options.sheet);
  const componentsById = new Map(components.map((component) => [component.id, component]));
  const eligible = locations.filter((location) => {
    const component = componentsById.get(location.componentId);
    if (!component) return false;
    const widthMm = component.bounds.width * pixel.x;
    const heightMm = component.bounds.height * pixel.y;
    const areaMm2 = component.pixelCount * pixel.x * pixel.y;
    const equivalentDiameterMm = 2 * Math.sqrt(areaMm2 / Math.PI);
    if (component.pixelCount === 1) return true;
    if (strategy === "preserve") return false;
    if (strategy === "balanced") {
      return widthMm <= minimumWebMm && heightMm <= minimumWebMm &&
        equivalentDiameterMm <= minimumWebMm * 1.25;
    }
    return widthMm <= minimumWebMm * 2 && heightMm <= minimumWebMm * 2 &&
      equivalentDiameterMm <= minimumWebMm * 2;
  });

  const items = eligible.map((location, position) => {
    const component = componentsById.get(location.componentId);
    const indices = indicesForComponent(mask, labels, component)
      .filter((index) => protectedMask?.data[index] !== RETAINED);
    return {
      id: `loose-piece-${component.id}`,
      position,
      componentId: component.id,
      pixelCount: component.pixelCount,
      bounds: component.bounds,
      similarityKey: component.pixelCount === 1 ? "one-cell" : `loose-${sizeBand(component.pixelCount)}`,
      action: "close",
      recommended: "close",
      availableActions: { close: indices.length > 0, enlarge: false, merge: false },
      edits: { close: { keep: [], remove: indices }, enlarge: null, merge: null },
    };
  }).filter((item) => item.availableActions.close);

  return {
    kind: "loose-pieces",
    strategy,
    minimumWebMm,
    totalCount: locations.length,
    skippedCount: locations.length - items.length,
    items,
    counts: countActions(items),
  };
}

/** Applies the selected action of every item to a cloned mask. */
export function applySmallOpeningRepairPlan(mask, plan) {
  assertMask(mask);
  const output = cloneMask(mask);
  for (const item of plan?.items ?? []) {
    const edits = item.edits?.[item.action];
    if (!edits) continue;
    for (const index of edits.keep) output.data[index] = RETAINED;
  }
  // Removal wins where plans overlap. This keeps a deliberate merge open even
  // when its neighbour was independently classified as a speck to close.
  for (const item of plan?.items ?? []) {
    const edits = item.edits?.[item.action];
    if (!edits) continue;
    for (const index of edits.remove) output.data[index] = REMOVED;
  }
  return output;
}

/** Changes one repair, or every geometrically similar repair, in place. */
export function setSmallOpeningRepairAction(plan, itemId, action, { similar = false } = {}) {
  if (!plan?.items) throw new TypeError("Repair plan is required");
  if (!ACTIONS.has(action)) throw new RangeError("Unknown repair action");
  const selected = plan.items.find((item) => item.id === itemId);
  if (!selected || !selected.availableActions[action]) return false;
  const targets = similar
    ? plan.items.filter((item) => item.similarityKey === selected.similarityKey && item.availableActions[action])
    : [selected];
  for (const item of targets) item.action = action;
  plan.counts = countActions(plan.items);
  return targets.length > 0;
}

function emptyPlan(strategy, targetOpeningMm, minimumWebMm) {
  return {
    kind: "small-openings",
    strategy,
    targetOpeningMm,
    minimumWebMm,
    items: [],
    counts: { close: 0, enlarge: 0, merge: 0 },
  };
}

function indicesForComponent(mask, labels, component) {
  const indices = [];
  const bounds = component.bounds;
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const index = y * mask.width + x;
      if (labels[index] === component.id) indices.push(index);
    }
  }
  return indices;
}

function centroid(mask, indices, bounds) {
  if (!indices.length) {
    return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
  }
  let x = 0;
  let y = 0;
  for (const index of indices) {
    x += index % mask.width;
    y += Math.floor(index / mask.width);
  }
  return { x: x / indices.length, y: y / indices.length };
}

function isMeaningful({ strategy, equivalentDiameterMm, longSpanMm, targetOpeningMm, elongated }) {
  const thresholds = {
    preserve: { diameter: 0.30, length: 0.60 },
    balanced: { diameter: 0.62, length: 0.95 },
    durable: { diameter: 0.88, length: 1.35 },
  }[strategy];
  return equivalentDiameterMm >= targetOpeningMm * thresholds.diameter ||
    (elongated && longSpanMm >= targetOpeningMm * thresholds.length);
}

function sizeBand(ratio) {
  if (ratio < 0.35) return "tiny";
  if (ratio < 0.7) return "medium";
  return "near-limit";
}

function countActions(items) {
  const counts = { close: 0, enlarge: 0, merge: 0 };
  for (const item of items) counts[item.action] += 1;
  return counts;
}

function nearestOtherOpening(mask, labels, componentId, indices, sheet, maximumGapMm) {
  if (!(maximumGapMm > 0)) return null;
  const pixel = pixelSizeMm(mask, sheet);
  const radiusX = Math.max(1, Math.ceil((maximumGapMm + pixel.x) / pixel.x));
  const radiusY = Math.max(1, Math.ceil((maximumGapMm + pixel.y) / pixel.y));
  let best = null;

  for (const index of indices) {
    const x = index % mask.width;
    const y = Math.floor(index / mask.width);
    for (let dy = -radiusY; dy <= radiusY; dy += 1) {
      for (let dx = -radiusX; dx <= radiusX; dx += 1) {
        const targetX = x + dx;
        const targetY = y + dy;
        if (targetX < 0 || targetY < 0 || targetX >= mask.width || targetY >= mask.height) continue;
        const otherId = labels[targetY * mask.width + targetX];
        if (otherId <= 0 || otherId === componentId) continue;
        const gapX = Math.max(0, Math.abs(dx) * pixel.x - pixel.x);
        const gapY = Math.max(0, Math.abs(dy) * pixel.y - pixel.y);
        const gapMm = Math.hypot(gapX, gapY);
        if (gapMm > maximumGapMm + Number.EPSILON || gapMm >= (best?.gapMm ?? Number.POSITIVE_INFINITY)) continue;
        best = {
          componentId: otherId,
          gapMm,
          from: { x, y },
          to: { x: targetX, y: targetY },
        };
      }
    }
  }
  return best;
}

function unique(values) {
  return [...new Set(values)];
}

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

function nonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative`);
  return value;
}
