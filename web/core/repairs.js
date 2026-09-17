import { physicalDiscIndices, physicalStrokeIndices } from "./editing.js";
import { applyCapsuleBridges } from "./bridges.js";
import { dilateMaskPhysical } from "./morphology.js";
import { suggestBridges, suggestKerfAwareBridges } from "./suggestions.js";
import { countValidationLocations, validateDesign } from "./validation.js";
import {
  FINISHED_BOUNDARY_CAM,
  normalizeGeometryInterpretation,
  rasterWebWidthMm,
  requiredOpeningMm,
} from "./geometry-contract.js";
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
    const maximumClosureDiameterMm = targetOpeningMm * 1.75;
    const maximumClosureSpanMm = Math.max(targetOpeningMm * 2, minimumWebMm * 1.5);
    const closureProtected = longSpanMm > maximumClosureSpanMm ||
      equivalentDiameterMm > maximumClosureDiameterMm;
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
    const availableActions = {
      close: !closureProtected,
      enlarge: canEnlarge,
      merge: canMerge,
    };
    const recommended = meaningful && canMerge
      ? "merge"
      : meaningful && canEnlarge
        ? "enlarge"
        : availableActions.close
          ? "close"
          : canEnlarge
            ? "enlarge"
            : canMerge
              ? "merge"
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
      closureProtected,
      similarityKey: `${elongated ? "elongated" : "compact"}-${sizeBand(equivalentDiameterMm / targetOpeningMm)}`,
      action: recommended,
      recommended,
      availableActions,
      edits: {
        close: closureProtected ? null : { keep: indices, remove: [] },
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
    protectedClosureCount: items.filter((item) => item.closureProtected).length,
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
      protectedClosureCount: 0,
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
    const smallerWidthMm = (smaller?.bounds.width ?? 0) * pixel.x;
    const smallerHeightMm = (smaller?.bounds.height ?? 0) * pixel.y;
    const smallerLongSpanMm = Math.max(smallerWidthMm, smallerHeightMm);
    const smallerAreaMm2 = (smaller?.pixelCount ?? 0) * pixel.x * pixel.y;
    const smallerDiameterMm = 2 * Math.sqrt(smallerAreaMm2 / Math.PI);
    // Closing means filling the complete cut component with metal. It is safe
    // only for a genuinely minor mark. A long slat, hatch stroke, letterform,
    // or portrait opening may be the smaller member of a conflicting pair but
    // is never disposable merely because doing so makes validation pass.
    const maximumClosureDiameterMm = targetOpeningMm * 1.75;
    const maximumClosureSpanMm = Math.max(targetOpeningMm * 2, targetGapMm * 1.5);
    const closureProtected = smallerLongSpanMm > maximumClosureSpanMm ||
      smallerDiameterMm > maximumClosureDiameterMm;
    const canClose = !closureProtected && close.some((index) => mask.data[index] === REMOVED);
    const canWiden = widen.some((index) => mask.data[index] === REMOVED);
    const canMerge = !mergeProtected && merge.some((index) => mask.data[index] === RETAINED);
    const preferred = { preserve: "merge", balanced: "enlarge", durable: "close" }[strategy];
    const availableActions = { close: canClose, enlarge: canWiden, merge: canMerge };
    const recommended = availableActions[preferred]
      ? preferred
      : ["enlarge", "merge", "close"].find((action) => availableActions[action]) ?? "close";

    return {
      id: `cut-gap-${firstId}-${secondId}`,
      position,
      componentIds: [firstId, secondId],
      bounds: location.bounds,
      points: location.points,
      gapMm: location.gapMm,
      finishedGapMm: location.finishedGapMm ?? location.gapMm,
      deficitMm,
      smallerComponentId: smaller?.id ?? null,
      smallerDiameterMm,
      smallerLongSpanMm,
      closureProtected,
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
    protectedClosureCount: items.filter((item) => item.closureProtected).length,
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

const CONNECTIVITY_ERROR_CODES = new Set([
  "DISCONNECTED_RETAINED_MATERIAL",
  "KERF_DISCONNECTED_RETAINED_MATERIAL",
]);

/**
 * Plans manufacturing repairs as a sequence of independently checked stages.
 *
 * The old workflow applied every available morphology and support suggestion
 * in one pass. A bridge could therefore split a cut into new undersized
 * openings, while strict minimum-web morphology could generate thousands of
 * ties for raster fragments. This planner instead repairs true export blockers
 * first, validates after each stage, and rolls back any stage that does not
 * improve the complete blocking-error result. Warning-only reinforcement is
 * attempted only after the blockers are gone and is bounded by the same bridge
 * budget.
 *
 * @param {import('./mask.js').RasterMask} mask
 * @param {{
 *   sheet:{widthMm:number,heightMm:number},
 *   kerfMm:number,
 *   minimumWebMm:number,
 *   minimumOpeningMm:number,
 *   targetWebMm:number,
 *   targetOpeningMm:number,
 *   strategy?:"preserve"|"balanced"|"durable",
 *   categories?:{slivers?:boolean,gaps?:boolean,webs?:boolean,warnings?:boolean},
 *   protectedMask?:import('./mask.js').RasterMask|null,
 *   bridgeWidthMm:number,
 *   bridgeStrategy?:object,
 *   maximumBridges?:number,
 *   geometryInterpretation?:'finished-boundary-cam-v1'|'legacy-uncompensated-centerline-v1',
 * }} options
 */
export function planManufacturingRepairs(mask, options) {
  assertMask(mask);
  assertSheet(options?.sheet);
  const strategy = options.strategy ?? "balanced";
  if (!STRATEGIES.has(strategy)) throw new RangeError("Unknown repair strategy");
  const kerfMm = nonNegative(options.kerfMm, "kerfMm");
  const minimumWebMm = nonNegative(options.minimumWebMm, "minimumWebMm");
  const minimumOpeningMm = nonNegative(options.minimumOpeningMm, "minimumOpeningMm");
  const targetWebMm = positive(options.targetWebMm, "targetWebMm");
  const targetOpeningMm = positive(options.targetOpeningMm, "targetOpeningMm");
  const geometryInterpretation = normalizeGeometryInterpretation(
    options.geometryInterpretation ?? FINISHED_BOUNDARY_CAM,
  );
  const targetRasterWebMm = rasterWebWidthMm(targetWebMm, kerfMm, geometryInterpretation);
  const targetRasterOpeningMm = requiredOpeningMm(targetOpeningMm, kerfMm);
  const bridgeWidthMm = positive(options.bridgeWidthMm, "bridgeWidthMm");
  const maximumBridges = options.maximumBridges ?? 192;
  if (!Number.isInteger(maximumBridges) || maximumBridges < 1 || maximumBridges > 10_000) {
    throw new RangeError("maximumBridges must be an integer between 1 and 10000");
  }
  const categories = {
    slivers: options.categories?.slivers !== false,
    gaps: options.categories?.gaps !== false,
    webs: options.categories?.webs !== false,
    warnings: options.categories?.warnings === true,
  };
  let protectedMask = options.protectedMask
    ? cloneMask(options.protectedMask)
    : { width: mask.width, height: mask.height, data: new Uint8Array(mask.data.length) };
  assertSameSize(mask, protectedMask);

  const validate = (candidate) => validateDesign(candidate, {
    sheet: options.sheet,
    kerfMm,
    minimumWebMm,
    minimumOpeningMm,
    geometryInterpretation,
    anchorBoundary: false,
    requireAnchored: false,
    requireSingleComponent: true,
  });
  const beforeValidation = validate(mask);
  let candidate = cloneMask(mask);
  let validation = beforeValidation;
  const items = [];
  const notes = [];
  const durableFallbackCategories = new Set();
  const protectedGapClosureIds = new Set();
  const protectedOpeningClosureIds = new Set();
  let supportCount = 0;
  let cleanupRound = 0;

  const applyRawPlan = (plan, category, issueCode, pass) => {
    const stageItems = repairPlanItems(plan, category, issueCode, pass);
    if (!stageItems.length) return [];
    candidate = applySmallOpeningRepairPlan(candidate, { items: stageItems });
    validation = validate(candidate);
    return stageItems;
  };
  const tryCleanupPlan = (plan, category, issueCode, pass) => {
    const previousMask = candidate;
    const previousValidation = validation;
    const previousErrors = countValidationLocations(previousValidation, "error");
    const stageItems = applyRawPlan(plan, category, issueCode, pass);
    if (!stageItems.length) return false;
    if (countValidationLocations(validation, "error") < previousErrors) {
      items.push(...stageItems);
      return true;
    }
    candidate = previousMask;
    validation = previousValidation;
    return false;
  };
  const tryCleanupPlanner = (planner, category, issueCode, pass) => {
    if (tryCleanupPlan(planner(strategy), category, issueCode, pass)) return true;
    // Preserve-detail is a contract, not merely a preference. Only Balanced
    // may escalate a rejected local choice to the metal-preserving Durable
    // action, and the UI reports that fallback explicitly.
    if (strategy !== "balanced") return false;
    const accepted = tryCleanupPlan(planner("durable"), category, issueCode, pass);
    if (accepted) durableFallbackCategories.add(category);
    return accepted;
  };
  const runCheckedCleanup = () => {
    const beforeErrors = countValidationLocations(validation, "error");
    cleanupRound += 1;
    const stagePass = cleanupRound * 10;
    if (categories.slivers) {
      tryCleanupPlanner((attemptStrategy) => planLoosePieceRepairs(candidate, validation, {
        sheet: options.sheet, strategy: attemptStrategy, minimumWebMm: targetWebMm, protectedMask,
      }), "sliver", "DISCONNECTED_RETAINED_MATERIAL", stagePass + 1);
      tryCleanupPlanner((attemptStrategy) => {
        const openingPlan = planSmallOpeningRepairs(candidate, validation, {
          sheet: options.sheet, strategy: attemptStrategy,
          targetOpeningMm: targetRasterOpeningMm, minimumWebMm: targetRasterWebMm, protectedMask,
        });
        for (const item of openingPlan.items) {
          if (item.closureProtected) protectedOpeningClosureIds.add(item.id);
        }
        return openingPlan;
      }, "opening", "MIN_OPENING_UNCUTTABLE", stagePass + 2);
    }
    if (categories.gaps) {
      for (let pass = 1; pass <= 3; pass += 1) {
        const accepted = tryCleanupPlanner((attemptStrategy) => {
          const gapPlan = planCutGapRepairs(candidate, validation, {
            sheet: options.sheet, strategy: attemptStrategy,
            targetGapMm: targetRasterWebMm, targetOpeningMm: targetRasterOpeningMm, protectedMask,
          });
          for (const item of gapPlan.items) {
            if (item.closureProtected) protectedGapClosureIds.add(item.id);
          }
          return gapPlan;
        }, "gap", "MIN_CUT_GAP", stagePass + 2 + pass);
        if (!accepted) break;
      }
    }
    return countValidationLocations(validation, "error") < beforeErrors;
  };
  const runCleanupRounds = () => {
    for (let round = 0; round < 3; round += 1) {
      if (!runCheckedCleanup()) break;
    }
  };

  // Cheap deterministic cleanup reduces the graph before support planning.
  runCleanupRounds();

  if (categories.webs && connectivityErrorCount(validation) > 0) {
    const previousMask = candidate;
    const previousValidation = validation;
    const previousItemsLength = items.length;
    const previousProtectedMask = protectedMask;
    const previousErrors = countValidationLocations(validation, "error");
    const previousConnectivityErrors = connectivityErrorCount(validation);
    const supportPlan = suggestKerfAwareBridges(candidate, {
      sheet: options.sheet,
      widthMm: Math.max(bridgeWidthMm, targetRasterWebMm),
      anchorBoundary: false,
      requireSingleComponent: true,
      minimumWebMm: targetWebMm,
      kerfMm,
      geometryInterpretation,
      targetMinimumWebConnectivity: false,
      maxPasses: 8,
      maximumBridges,
      strategy: options.bridgeStrategy
        ? { ...options.bridgeStrategy, maximumUnsupportedSpanMm: undefined }
        : undefined,
    });
    const supportItem = supportRepairItem(candidate, supportPlan.bridges, options.sheet, "connectivity");
    if (supportItem) {
      candidate = applyCapsuleBridges(candidate, supportPlan.bridges, options.sheet);
      validation = validate(candidate);
      protectedMask = withProtectedEdits(protectedMask, supportItem.edits.enlarge.keep);
      items.push(supportItem);
      supportCount += supportPlan.bridges.length;
      runCleanupRounds();
    }
    const improved = supportItem &&
      connectivityErrorCount(validation) < previousConnectivityErrors &&
      countValidationLocations(validation, "error") < previousErrors;
    if (!improved) {
      candidate = previousMask;
      validation = previousValidation;
      protectedMask = previousProtectedMask;
      items.length = previousItemsLength;
      supportCount = 0;
      notes.push("No support package was kept because it did not reduce the complete blocking-error result.");
    } else if (!supportPlan.complete) {
      notes.push(`Support planning stopped at its ${maximumBridges}-tie safety limit; remaining blockers stay visible for review.`);
    }
  }

  // Structural warnings are an explicit opt-in because correcting them can
  // visibly thicken artwork. First join disconnected full-width cores with a
  // sparse filter-aware tree, then try one-pixel physical dilation shells.
  // Every candidate must keep the blocker count at zero and reduce the warning
  // count without making another structural-warning metric worse.
  if (categories.warnings && countValidationLocations(validation, "error") === 0) {
    for (let pass = 1; pass <= 3 && supportCount < maximumBridges; pass += 1) {
      if (!validation.minimumWebCoreMask || validation.minimumWebCore?.componentCount <= 1) break;
      const available = maximumBridges - supportCount;
      const bridges = suggestBridges(validation.minimumWebCoreMask, {
        sheet: options.sheet,
        widthMm: Math.max(bridgeWidthMm, targetRasterWebMm),
        anchorBoundary: false,
        requireSingleComponent: true,
        minimumWebMm: targetWebMm,
        kerfMm,
        geometryInterpretation,
        strategy: options.bridgeStrategy
          ? { ...options.bridgeStrategy, maximumUnsupportedSpanMm: undefined }
          : undefined,
      }).filter((bridge) => !bridge.stabilizer).slice(0, available);
      const supportItem = supportRepairItem(candidate, bridges, options.sheet, `minimum-web-${pass}`);
      if (!supportItem) break;
      const supported = applyCapsuleBridges(candidate, bridges, options.sheet);
      const supportedValidation = validate(supported);
      const rejection = structuralWarningRejectionReason(validation, supportedValidation);
      if (rejection) {
        notes.push(`The next structural-tie pass was not kept because ${rejection}`);
        break;
      }
      candidate = supported;
      validation = supportedValidation;
      protectedMask = withProtectedEdits(protectedMask, supportItem.edits.enlarge.keep);
      items.push(supportItem);
      supportCount += bridges.length;
    }

    const pixel = pixelSizeMm(candidate, options.sheet);
    const shellRadiusMm = Math.min(pixel.x, pixel.y) * 0.51;
    const maximumShells = { preserve: 1, balanced: 2, durable: 3 }[strategy];
    for (let pass = 1; pass <= maximumShells; pass += 1) {
      if (structuralWarningLocationCount(validation) === 0) break;
      const expanded = dilateMaskPhysical(candidate, shellRadiusMm, options.sheet);
      const issueCode = validation.minimumWebCore?.retainedPixels === 0
        ? "MIN_WEB_NO_SURVIVING_CORE"
        : "MIN_WEB_THIN_AREAS";
      const thickeningItem = materialAdditionRepairItem(candidate, expanded, pass, pixel, issueCode);
      if (!thickeningItem) break;
      const expandedValidation = validate(expanded);
      const rejection = structuralWarningRejectionReason(validation, expandedValidation);
      if (rejection) {
        notes.push(`The next material-thickening pass was not kept because ${rejection}`);
        break;
      }
      candidate = expanded;
      validation = expandedValidation;
      items.push(thickeningItem);
    }

    const remainingStructuralWarnings = structuralWarningLocationCount(validation);
    if (remainingStructuralWarnings > 0) {
      notes.push(
        `${remainingStructuralWarnings} structural warning ${remainingStructuralWarnings === 1 ? "location remains" : "locations remain"}; further automatic thickening would not be safely beneficial.`,
      );
    }
  }

  const afterValidation = validation;
  const beforeErrors = countValidationLocations(beforeValidation, "error");
  const afterErrors = countValidationLocations(afterValidation, "error");
  const beforeWarnings = countValidationLocations(beforeValidation, "warning");
  const afterWarnings = countValidationLocations(afterValidation, "warning");
  const improved = afterErrors < beforeErrors ||
    (beforeErrors === 0 && afterErrors === 0 && afterWarnings < beforeWarnings);
  const safeToApply = items.length > 0 && afterErrors <= beforeErrors && improved;
  const counts = countRepairActions(items);
  if (durableFallbackCategories.size > 0) {
    notes.unshift(
      `Used the durable fallback for ${[...durableFallbackCategories].join(", ")} only where the selected strategy failed its safety check.`,
    );
  }
  if (protectedGapClosureIds.size > 0) {
    const count = protectedGapClosureIds.size;
    const slats = options.bridgeStrategy?.kind === "lamele";
    notes.unshift(slats
      ? `Protected ${count} long slat ${count === 1 ? "cut" : "cuts"} from whole-cut closure. Any remaining close-gap errors need a more widely spaced Slats render or manual review.`
      : `Protected ${count} long or significant ${count === 1 ? "cut" : "cuts"} from whole-cut closure. Any remaining close-gap errors need a roomier source pattern or manual review.`);
  }
  if (protectedOpeningClosureIds.size > 0) {
    const count = protectedOpeningClosureIds.size;
    notes.unshift(
      `Protected ${count} long or significant ${count === 1 ? "opening" : "openings"} from whole-opening closure. Any remaining minimum-opening errors need source-pattern adjustment or manual review.`,
    );
  }

  return {
    kind: "manufacturing",
    strategy,
    categories,
    items,
    counts,
    supportCount,
    mask: candidate,
    beforeValidation,
    afterValidation,
    outcome: {
      beforeErrors,
      afterErrors,
      beforeWarnings,
      afterWarnings,
      beforeConnectivityErrors: connectivityErrorCount(beforeValidation),
      afterConnectivityErrors: connectivityErrorCount(afterValidation),
      beforeWeakWebs: weakWebCount(beforeValidation),
      afterWeakWebs: weakWebCount(afterValidation),
      beforeThinAreaPixels: thinAreaPixelCount(beforeValidation),
      afterThinAreaPixels: thinAreaPixelCount(afterValidation),
      improved,
      safeToApply,
      complete: afterErrors === 0,
      notes,
    },
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

/**
 * Composes a newly previewed mask change into an existing reversible repair
 * layer. The `before` mask already includes that layer, so reversing one of
 * its edits removes the old instruction instead of adding a contradictory one.
 */
export function mergeRepairLayerEdits(before, after, existing = null) {
  assertMask(before);
  assertMask(after);
  assertSameSize(before, after);
  const keep = new Set(existing?.keep ?? []);
  const remove = new Set(existing?.remove ?? []);
  for (let index = 0; index < after.data.length; index += 1) {
    if (before.data[index] === after.data[index]) continue;
    if (after.data[index] === RETAINED) {
      if (!remove.delete(index)) keep.add(index);
    } else if (!keep.delete(index)) {
      remove.add(index);
    }
  }
  return { keep, remove };
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
  plan.counts = countRepairActions(plan.items);
  return targets.length > 0;
}

function emptyPlan(strategy, targetOpeningMm, minimumWebMm) {
  return {
    kind: "small-openings",
    strategy,
    targetOpeningMm,
    minimumWebMm,
    items: [],
    protectedClosureCount: 0,
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

function repairPlanItems(plan, category, issueCode, pass = 1) {
  return (plan?.items ?? []).map((item) => ({
    ...item,
    id: `${category}-${pass}-${item.id}`,
    category,
    issueCode,
  }));
}

function countRepairActions(items) {
  const counts = { close: 0, enlarge: 0, merge: 0 };
  for (const item of items) counts[item.action] += item.supportCount ?? 1;
  return counts;
}

function connectivityErrorCount(validation) {
  return countValidationLocations(validation, "error", CONNECTIVITY_ERROR_CODES);
}

function weakWebCount(validation) {
  const codes = new Set(["MIN_WEB_NO_SURVIVING_CORE", "MIN_WEB_DISCONNECT"]);
  return countValidationLocations(validation, "warning", codes);
}

function structuralWarningLocationCount(validation) {
  const codes = new Set(["MIN_WEB_NO_SURVIVING_CORE", "MIN_WEB_DISCONNECT", "MIN_WEB_THIN_AREAS"]);
  return countValidationLocations(validation, "warning", codes);
}

function thinAreaPixelCount(validation) {
  return validation?.issues?.find((issue) =>
    issue.code === "MIN_WEB_THIN_AREAS" || issue.code === "MIN_WEB_NO_SURVIVING_CORE")
    ?.details?.pixelCount ?? 0;
}

function structuralWarningRejectionReason(before, after) {
  const afterErrors = countValidationLocations(after, "error");
  if (afterErrors !== 0) {
    return `it would create ${afterErrors} blocking ${afterErrors === 1 ? "location" : "locations"}.`;
  }
  const beforeLocations = structuralWarningLocationCount(before);
  const afterLocations = structuralWarningLocationCount(after);
  const beforeWeakWebs = weakWebCount(before);
  const afterWeakWebs = weakWebCount(after);
  const beforeThinPixels = thinAreaPixelCount(before);
  const afterThinPixels = thinAreaPixelCount(after);
  if (afterLocations >= beforeLocations) return "it would not reduce the structural-warning count.";
  if (afterWeakWebs > beforeWeakWebs) return "it would create more disconnected full-width material regions.";
  if (afterThinPixels > beforeThinPixels) return "it would create more thin-material raster cells.";
  return null;
}

function supportRepairItem(mask, bridges, sheet, role) {
  if (!bridges?.length) return null;
  const supported = applyCapsuleBridges(mask, bridges, sheet);
  const keep = [];
  for (let index = 0; index < supported.data.length; index += 1) {
    if (supported.data[index] === RETAINED && mask.data[index] !== RETAINED) keep.push(index);
  }
  if (!keep.length) return null;
  return {
    id: `web-1-${role}-supports`,
    category: "web",
    issueCode: role === "connectivity" ? "KERF_DISCONNECTED_RETAINED_MATERIAL" : "MIN_WEB_DISCONNECT",
    bounds: boundsForIndices(mask, keep),
    pixelCount: keep.length,
    supportCount: bridges.length,
    role,
    similarityKey: `${role}-supports`,
    action: "enlarge",
    recommended: "enlarge",
    availableActions: { close: false, enlarge: true, merge: false },
    edits: { close: null, enlarge: { keep, remove: [] }, merge: null },
  };
}

function materialAdditionRepairItem(mask, expanded, pass, pixel, issueCode = "MIN_WEB_THIN_AREAS") {
  const keep = [];
  for (let index = 0; index < expanded.data.length; index += 1) {
    if (expanded.data[index] === RETAINED && mask.data[index] !== RETAINED) keep.push(index);
  }
  if (!keep.length) return null;
  return {
    id: `warning-${pass}-thin-material-thickening`,
    category: "warning",
    issueCode,
    bounds: boundsForIndices(mask, keep),
    pixelCount: keep.length,
    addedAreaMm2: keep.length * pixel.x * pixel.y,
    similarityKey: `warning-thickening-${pass}`,
    action: "enlarge",
    recommended: "enlarge",
    availableActions: { close: false, enlarge: true, merge: false },
    edits: { close: null, enlarge: { keep, remove: [] }, merge: null },
  };
}

function boundsForIndices(mask, indices) {
  let minX = mask.width;
  let minY = mask.height;
  let maxX = 0;
  let maxY = 0;
  for (const index of indices) {
    const x = index % mask.width;
    const y = Math.floor(index / mask.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function withProtectedEdits(mask, indices) {
  const output = cloneMask(mask);
  for (const index of indices) output.data[index] = RETAINED;
  return output;
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
