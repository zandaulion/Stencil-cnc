import { analyzeConnectivity } from "./connectivity.js";
import { dilateMaskPhysical, erodeMaskPhysical } from "./morphology.js";
import {
  RETAINED,
  assertMask,
  assertSameSize,
  assertSheet,
  countRetained,
  createMask,
  pixelSizeMm,
} from "./mask.js";

/**
 * Runs topology and approximate physical-width checks. Kerf is modelled as an
 * inward erosion of retained material by half its configured width. Minimum
 * web checks use a second erosion and therefore intentionally err on the safe
 * side at raster resolution.
 *
 * Only structural disconnection is an error in the MVP. Approximate width and
 * raster-resolution findings are warnings for a human/CAM review.
 *
 * @param {import('./mask.js').RasterMask} mask
 * @param {{
 *   sheet: { widthMm: number, heightMm: number },
 *   kerfMm?: number,
 *   minimumWebMm?: number,
 *   minimumOpeningMm?: number,
 *   anchorMask?: import('./mask.js').RasterMask | null,
 *   anchorBoundary?: boolean,
 *   requireAnchored?: boolean,
 *   requireSingleComponent?: boolean,
 *   outsideIsRemoved?: boolean,
 * }} config
 */
export function validateDesign(mask, config) {
  assertMask(mask);
  if (!config || typeof config !== "object") throw new TypeError("Validation configuration is required");
  assertSheet(config.sheet);
  if (config.anchorMask) assertSameSize(mask, config.anchorMask);

  const kerfMm = nonNegative(config.kerfMm ?? 0, "kerfMm");
  const minimumWebMm = nonNegative(config.minimumWebMm ?? 0, "minimumWebMm");
  const minimumOpeningMm = nonNegative(config.minimumOpeningMm ?? 0, "minimumOpeningMm");
  const connectivityOptions = {
    anchorMask: config.anchorMask ?? null,
    anchorBoundary: config.anchorBoundary,
  };
  const issues = [];
  const initial = analyzeConnectivity(mask, connectivityOptions);

  if (initial.retainedPixels === 0) {
    issues.push(issue("EMPTY_DESIGN", "error", "The design contains no retained material."));
  }
  if (config.requireSingleComponent === true && initial.componentCount > 1) {
    const components = disconnectedComponents(initial);
    const locations = componentLocations(components);
    issues.push(issue(
      "DISCONNECTED_RETAINED_MATERIAL",
      "error",
      `${components.length} retained ${components.length === 1 ? "piece is" : "pieces are"} disconnected from the main panel.`,
      {
        phase: "initial",
        componentCount: components.length,
        totalComponentCount: initial.componentCount,
        componentId: locations[0].componentId,
        pixelCount: locations.reduce((sum, location) => sum + location.pixelCount, 0),
        bounds: locations[0].bounds,
        locations,
      },
    ));
  }
  if (config.requireAnchored !== false) {
    for (const component of initial.islands) {
      issues.push(issue(
        "UNSUPPORTED_COMPONENT",
        "error",
        `Retained component ${component.id} is not connected to the supporting frame.`,
        { phase: "initial", componentId: component.id, pixelCount: component.pixelCount, bounds: component.bounds },
      ));
    }
  }

  const postKerfMask = kerfMm > 0
    ? erodeMaskPhysical(mask, kerfMm / 2, config.sheet, { outsideIsRemoved: config.outsideIsRemoved })
    : { width: mask.width, height: mask.height, data: mask.data.slice() };
  const postKerf = analyzeConnectivity(postKerfMask, connectivityOptions);

  if (initial.retainedPixels > 0 && postKerf.retainedPixels === 0) {
    issues.push(issue("KERF_REMOVED_ALL", "error", "The configured kerf removes all retained material."));
  }
  if (kerfMm > 0) {
    if (config.requireSingleComponent === true && postKerf.componentCount > 1) {
      const components = disconnectedComponents(postKerf);
      const locations = componentLocations(components);
      issues.push(issue(
        "KERF_DISCONNECTED_RETAINED_MATERIAL",
        "error",
        `${components.length} retained ${components.length === 1 ? "piece becomes" : "pieces become"} disconnected after kerf.`,
        {
          phase: "postKerf",
          componentCount: components.length,
          totalComponentCount: postKerf.componentCount,
          componentId: locations[0].componentId,
          pixelCount: locations.reduce((sum, location) => sum + location.pixelCount, 0),
          bounds: locations[0].bounds,
          locations,
        },
      ));
    }
    if (config.requireAnchored !== false) {
      for (const component of postKerf.islands) {
        issues.push(issue(
          "KERF_UNSUPPORTED_COMPONENT",
          "error",
          `Component ${component.id} becomes unsupported after kerf simulation.`,
          { phase: "postKerf", componentId: component.id, pixelCount: component.pixelCount, bounds: component.bounds },
        ));
      }
    }
  }

  // A removed component with no surviving radius after erosion cannot contain
  // the configured cutter/opening. Checking per component avoids flagging the
  // harmless rounded corner band produced by a morphological reopen.
  let openingCoreMask = null;
  const undersizedOpenings = [];
  let removedMask = null;
  let removed = null;
  if (minimumOpeningMm > 0 || minimumWebMm > 0) {
    removedMask = createMask(mask.width, mask.height);
    for (let index = 0; index < mask.data.length; index += 1) {
      if (mask.data[index] !== RETAINED) removedMask.data[index] = RETAINED;
    }
    // Cut topology uses 8-connectivity deliberately. Diagonally adjacent
    // removed cells are one continuous cutter path at raster resolution; if
    // labelled with 4-connectivity they become two cuts with a fictitious
    // 0.00 mm gap and generate hundreds of impossible repair targets.
    removed = analyzeConnectivity(removedMask, {
      anchorBoundary: false,
      connectivity: 8,
    });
  }
  if (minimumOpeningMm > 0) {
    openingCoreMask = erodeMaskPhysical(removedMask, minimumOpeningMm / 2, config.sheet, {
      outsideIsRemoved: false,
    });
    const surviving = new Set();
    for (let index = 0; index < openingCoreMask.data.length; index += 1) {
      if (openingCoreMask.data[index] === RETAINED && removed.labels[index] > 0) {
        surviving.add(removed.labels[index]);
      }
    }
    for (const component of removed.components) {
      if (!surviving.has(component.id)) undersizedOpenings.push(component);
    }
    if (undersizedOpenings.length > 0) {
      const locations = undersizedOpenings.map((component) => ({
        componentId: component.id,
        pixelCount: component.pixelCount,
        bounds: component.bounds,
      }));
      issues.push(issue(
        "MIN_OPENING_UNCUTTABLE",
        "error",
        `${undersizedOpenings.length} removed ${undersizedOpenings.length === 1 ? "region is" : "regions are"} too small for the configured minimum opening.`,
        {
          phase: "opening",
          componentCount: undersizedOpenings.length,
          minimumOpeningMm,
          componentId: locations[0].componentId,
          bounds: locations[0].bounds,
          locations,
        },
      ));
    }
  }

  // Unlike the broader minimum-web morphology below, this is specifically a
  // distance between two distinct cut regions. That makes it a safe hard
  // constraint: rounded outer corners do not look like two cuts and therefore
  // cannot create a false export blocker.
  if (minimumWebMm > 0 && removed?.componentCount > 1) {
    const gaps = findCutGapViolations(removedMask, removed.labels, config.sheet, minimumWebMm);
    if (gaps.length > 0) {
      const closest = gaps[0];
      const count = gaps.length;
      issues.push(issue(
        "MIN_CUT_GAP",
        "error",
        count === 1
          ? `Separate cuts are only ${closest.gapMm.toFixed(2)} mm apart; the configured minimum is ${minimumWebMm} mm.`
          : `${count} pairs of separate cuts are closer than ${minimumWebMm} mm; the closest gap is ${closest.gapMm.toFixed(2)} mm.`,
        {
          phase: "cutGap",
          violationCount: count,
          minimumWebMm,
          ...closest,
          locations: gaps,
        },
      ));
    }
  }

  let minimumWebCoreMask = null;
  let minimumWebCore = null;
  let thinAreaMask = createMask(mask.width, mask.height);
  let thinAreaZones = null;
  let thinPixelCount = 0;
  if (minimumWebMm > 0 && postKerf.retainedPixels > 0) {
    const webRadius = minimumWebMm / 2;
    minimumWebCoreMask = erodeMaskPhysical(postKerfMask, webRadius, config.sheet, {
      outsideIsRemoved: config.outsideIsRemoved,
    });
    minimumWebCore = analyzeConnectivity(minimumWebCoreMask, connectivityOptions);
    const reopened = dilateMaskPhysical(minimumWebCoreMask, webRadius, config.sheet);

    for (let index = 0; index < postKerfMask.data.length; index += 1) {
      if (postKerfMask.data[index] === RETAINED && reopened.data[index] !== RETAINED) {
        thinAreaMask.data[index] = RETAINED;
        thinPixelCount += 1;
      }
    }

    // In anchored mode, a surviving full-width core is weak when it no
    // longer reaches the configured support. In the editor's single-piece
    // mode no external anchor is required, so every component is technically
    // an "island"; compare full-width cores to the largest/main core instead.
    // Treating all unanchored components as weak made even a completely solid
    // panel report one unavoidable warning.
    const weakCoreComponents = config.requireAnchored !== false
      ? minimumWebCore.islands
      : config.requireSingleComponent === true
        ? disconnectedComponents(minimumWebCore)
        : [];
    if (thinPixelCount > 0) {
      // Raw morphology can split the same physical edge band into many tiny
      // raster fragments as resolution changes. Group thin cells by the
      // structural post-kerf component they belong to. This keeps occurrence
      // counts and Locate navigation stable while labels still cover only the
      // actual thin cells.
      thinAreaZones = groupMaskByReference(thinAreaMask, postKerf);
    }

    if (minimumWebCore.retainedPixels === 0) {
      const locations = componentLocations(thinAreaZones?.components ?? postKerf.components);
      issues.push(issue(
        "MIN_WEB_NO_SURVIVING_CORE",
        "warning",
        `${locations.length} material ${locations.length === 1 ? "region contains" : "regions contain"} no area at the configured ${minimumWebMm} mm web width after kerf.`,
        {
          phase: "thinArea",
          componentCount: locations.length,
          minimumWebMm,
          componentId: locations[0]?.componentId,
          pixelCount: thinPixelCount,
          bounds: locations[0]?.bounds,
          locations,
        },
      ));
    } else {
      if (weakCoreComponents.length > 0) {
        const locations = componentLocations(weakCoreComponents);
        const count = locations.length;
        issues.push(issue(
          "MIN_WEB_DISCONNECT",
          "warning",
          `${count} full-width material ${count === 1 ? "region relies" : "regions rely"} on connections narrower than ${minimumWebMm} mm.`,
          {
            phase: "minimumWeb",
            componentCount: count,
            minimumWebMm,
            componentId: locations[0].componentId,
            pixelCount: locations.reduce((sum, location) => sum + location.pixelCount, 0),
            bounds: locations[0].bounds,
            locations,
          },
        ));
      }
      if (thinPixelCount > 0) {
        const locations = componentLocations(thinAreaZones.components);
        const zoneCount = locations.length;
        issues.push(issue(
          "MIN_WEB_THIN_AREAS",
          "warning",
          `${thinPixelCount} thin-material raster ${thinPixelCount === 1 ? "cell lies" : "cells lie"} outside a full-width core in ${zoneCount} material ${zoneCount === 1 ? "region" : "regions"}.`,
          {
            phase: "thinArea",
            componentCount: zoneCount,
            componentId: locations[0].componentId,
            bounds: locations[0].bounds,
            locations,
            pixelCount: thinPixelCount,
            minimumWebMm,
          },
        ));
      }
    }
  }

  const pixel = pixelSizeMm(mask, config.sheet);
  const smallestModelledRadius = Math.min(
    ...[kerfMm / 2, minimumWebMm / 2, minimumOpeningMm / 2].filter((value) => value > 0),
  );
  if (Number.isFinite(smallestModelledRadius) && smallestModelledRadius < Math.min(pixel.x, pixel.y) / 2) {
    issues.push(issue(
      "FEATURE_BELOW_RASTER_RESOLUTION",
      "warning",
      "A configured physical feature is smaller than half a raster cell; validation may miss it.",
      { pixelWidthMm: pixel.x, pixelHeightMm: pixel.y },
    ));
  }

  const errors = issues.filter((entry) => entry.severity === "error");
  const warnings = issues.filter((entry) => entry.severity === "warning");
  return {
    valid: errors.length === 0,
    hasWarnings: warnings.length > 0,
    issues,
    errors,
    warnings,
    initial,
    postKerf,
    postKerfMask,
    minimumWebCore,
    minimumWebCoreMask,
    openingCoreMask,
    undersizedOpenings,
    removed,
    removedMask,
    thinAreaMask,
    thinAreaZones,
    metrics: {
      widthMm: config.sheet.widthMm,
      heightMm: config.sheet.heightMm,
      pixelWidthMm: pixel.x,
      pixelHeightMm: pixel.y,
      retainedPixels: countRetained(mask),
      postKerfRetainedPixels: postKerf.retainedPixels,
      thinPixelCount,
      kerfMm,
      minimumWebMm,
      minimumOpeningMm,
    },
  };
}

function issue(code, severity, message, details = {}) {
  return { code, severity, message, details };
}

/**
 * Finds every distinct pair of cut regions whose closest edge-to-edge distance
 * is below the machine floor. One location is returned per component pair, so
 * a long parallel near-miss is one actionable finding rather than hundreds of
 * pixel-level duplicates. Boundary pixels are spatially bucketed, keeping the
 * search bounded by local cutter-scale neighbourhoods.
 */
function findCutGapViolations(removedMask, labels, sheet, minimumGapMm) {
  const pixel = pixelSizeMm(removedMask, sheet);
  const cellSize = minimumGapMm + Math.max(pixel.x, pixel.y);
  const buckets = new Map();
  const closestByPair = new Map();

  for (let y = 0; y < removedMask.height; y += 1) {
    for (let x = 0; x < removedMask.width; x += 1) {
      const index = y * removedMask.width + x;
      const componentId = labels[index];
      if (componentId <= 0 || !isRemovedBoundary(removedMask, x, y)) continue;
      const point = { componentId, x, y, xMm: (x + 0.5) * pixel.x, yMm: (y + 0.5) * pixel.y };
      const bucketX = Math.floor(point.xMm / cellSize);
      const bucketY = Math.floor(point.yMm / cellSize);

      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const nearby = buckets.get(`${bucketX + offsetX},${bucketY + offsetY}`) ?? [];
          for (const other of nearby) {
            if (other.componentId === componentId) continue;
            // Pixel centres include half a raster cell from each cut. Remove
            // those cell extents to report the physical metal gap, not the
            // centre-to-centre distance.
            const gapX = Math.max(0, Math.abs(point.xMm - other.xMm) - pixel.x);
            const gapY = Math.max(0, Math.abs(point.yMm - other.yMm) - pixel.y);
            const gapMm = Math.hypot(gapX, gapY);
            if (gapMm + 1e-9 >= minimumGapMm) continue;
            const componentIds = [other.componentId, componentId].sort((first, second) => first - second);
            const pairKey = `${componentIds[0]},${componentIds[1]}`;
            const current = closestByPair.get(pairKey);
            if (current && current.gapMm <= gapMm) continue;
            closestByPair.set(pairKey, {
              gapMm,
              componentIds,
              points: [
                { x: other.x, y: other.y },
                { x, y },
              ],
              bounds: {
                minX: Math.min(x, other.x),
                minY: Math.min(y, other.y),
                maxX: Math.max(x, other.x),
                maxY: Math.max(y, other.y),
                width: Math.abs(x - other.x) + 1,
                height: Math.abs(y - other.y) + 1,
              },
            });
          }
        }
      }
      const key = `${bucketX},${bucketY}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(point);
    }
  }
  return [...closestByPair.values()].sort((first, second) =>
    first.gapMm - second.gapMm ||
    first.componentIds[0] - second.componentIds[0] ||
    first.componentIds[1] - second.componentIds[1]);
}

function isRemovedBoundary(mask, x, y) {
  const index = y * mask.width + x;
  if (mask.data[index] !== RETAINED) return false;
  return (x > 0 && mask.data[index - 1] !== RETAINED) ||
    (x < mask.width - 1 && mask.data[index + 1] !== RETAINED) ||
    (y > 0 && mask.data[index - mask.width] !== RETAINED) ||
    (y < mask.height - 1 && mask.data[index + mask.width] !== RETAINED);
}

function disconnectedComponents(analysis) {
  return analysis.detachedComponents ?? analysis.components
    .slice()
    .sort((first, second) => second.pixelCount - first.pixelCount || first.id - second.id)
    .slice(1);
}

function componentLocations(components) {
  return components.map((component) => ({
    componentId: component.id,
    pixelCount: component.pixelCount,
    bounds: component.bounds,
  }));
}

function groupMaskByReference(mask, reference) {
  const labels = new Int32Array(mask.data.length);
  const byId = new Map();
  const referenceById = new Map(reference.components.map((component) => [component.id, component]));
  let retainedPixels = 0;
  for (let index = 0; index < mask.data.length; index += 1) {
    if (mask.data[index] !== RETAINED) continue;
    const componentId = reference.labels[index];
    if (componentId <= 0) continue;
    labels[index] = componentId;
    retainedPixels += 1;
    const x = index % mask.width;
    const y = Math.floor(index / mask.width);
    const component = byId.get(componentId) ?? {
      id: componentId,
      pixelCount: 0,
      anchored: referenceById.get(componentId)?.anchored ?? false,
      touchesBoundary: referenceById.get(componentId)?.touchesBoundary ?? false,
      bounds: { minX: mask.width, minY: mask.height, maxX: -1, maxY: -1, width: 0, height: 0 },
    };
    component.pixelCount += 1;
    component.bounds.minX = Math.min(component.bounds.minX, x);
    component.bounds.minY = Math.min(component.bounds.minY, y);
    component.bounds.maxX = Math.max(component.bounds.maxX, x);
    component.bounds.maxY = Math.max(component.bounds.maxY, y);
    byId.set(componentId, component);
  }
  const components = [...byId.values()].sort((first, second) => first.id - second.id);
  for (const component of components) {
    component.bounds.width = component.bounds.maxX - component.bounds.minX + 1;
    component.bounds.height = component.bounds.maxY - component.bounds.minY + 1;
  }
  const orderedBySize = components
    .slice()
    .sort((first, second) => second.pixelCount - first.pixelCount || first.id - second.id);
  const islands = components.filter((component) => !component.anchored);
  return {
    groupedBy: "postKerfComponent",
    connectivity: reference.connectivity,
    labels,
    retainedPixels,
    componentCount: components.length,
    components,
    mainComponent: orderedBySize[0] ?? null,
    detachedComponents: orderedBySize.slice(1),
    supportedComponents: components.filter((component) => component.anchored),
    islands,
    islandCount: islands.length,
    islandComponentIds: islands.map((component) => component.id),
    allSupported: islands.length === 0,
  };
}

export function issueLocationCount(entry) {
  return Math.max(1, Array.isArray(entry?.details?.locations) ? entry.details.locations.length : 1);
}

export function countValidationLocations(validation, severity, codes = null) {
  return (validation?.issues ?? [])
    .filter((entry) => entry.severity === severity && (!codes || codes.has(entry.code)))
    .reduce((sum, entry) => sum + issueLocationCount(entry), 0);
}

function nonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative`);
  return value;
}
