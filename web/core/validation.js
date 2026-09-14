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
    for (const component of disconnectedComponents(initial)) {
      issues.push(issue(
        "DISCONNECTED_RETAINED_MATERIAL",
        "error",
        `Retained piece ${component.id} is disconnected from the main panel.`,
        {
          phase: "initial",
          componentId: component.id,
          pixelCount: component.pixelCount,
          bounds: component.bounds,
          componentCount: initial.componentCount,
        },
      ));
    }
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
      for (const component of disconnectedComponents(postKerf)) {
        issues.push(issue(
          "KERF_DISCONNECTED_RETAINED_MATERIAL",
          "error",
          `Retained piece ${component.id} becomes disconnected after kerf.`,
          {
            phase: "postKerf",
            componentId: component.id,
            pixelCount: component.pixelCount,
            bounds: component.bounds,
            componentCount: postKerf.componentCount,
          },
        ));
      }
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
    removed = analyzeConnectivity(removedMask, { anchorBoundary: false });
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
      issues.push(issue(
        "MIN_OPENING_UNCUTTABLE",
        "error",
        `${undersizedOpenings.length} removed ${undersizedOpenings.length === 1 ? "region is" : "regions are"} too small for the configured minimum opening.`,
        { componentCount: undersizedOpenings.length, minimumOpeningMm },
      ));
    }
  }

  // Unlike the broader minimum-web morphology below, this is specifically a
  // distance between two distinct cut regions. That makes it a safe hard
  // constraint: rounded outer corners do not look like two cuts and therefore
  // cannot create a false export blocker.
  if (minimumWebMm > 0 && removed?.componentCount > 1) {
    const gap = findCutGapViolation(removedMask, removed.labels, config.sheet, minimumWebMm);
    if (gap) {
      issues.push(issue(
        "MIN_CUT_GAP",
        "error",
        `Separate cuts are only ${gap.gapMm.toFixed(2)} mm apart; the configured minimum is ${minimumWebMm} mm.`,
        { minimumWebMm, ...gap },
      ));
    }
  }

  let minimumWebCoreMask = null;
  let minimumWebCore = null;
  let thinAreaMask = createMask(mask.width, mask.height);
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

    if (minimumWebCore.retainedPixels === 0) {
      issues.push(issue(
        "MIN_WEB_NO_SURVIVING_CORE",
        "warning",
        "No material region contains the configured minimum web width after kerf.",
        { minimumWebMm },
      ));
    }
    for (const component of minimumWebCore.islands) {
      issues.push(issue(
        "MIN_WEB_DISCONNECT",
        "warning",
        `The minimum-web simulation leaves a detached material core (${component.id}).`,
        {
          phase: "minimumWeb",
          componentId: component.id,
          pixelCount: component.pixelCount,
          bounds: component.bounds,
          minimumWebMm,
        },
      ));
    }
    if (thinPixelCount > 0) {
      issues.push(issue(
        "MIN_WEB_THIN_AREAS",
        "warning",
        `${thinPixelCount} raster cells are outside any full-width material core.`,
        { pixelCount: thinPixelCount, minimumWebMm },
      ));
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
    thinAreaMask,
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
 * Finds a pair of distinct cut regions whose edge-to-edge distance is below
 * the machine floor. Boundary pixels are spatially bucketed, keeping this
 * bounded by local cutter-scale neighbourhoods instead of comparing every
 * contour point with every other one.
 */
function findCutGapViolation(removedMask, labels, sheet, minimumGapMm) {
  const pixel = pixelSizeMm(removedMask, sheet);
  const cellSize = minimumGapMm + Math.max(pixel.x, pixel.y);
  const buckets = new Map();

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
            return {
              gapMm,
              componentIds: [other.componentId, componentId],
              bounds: {
                minX: Math.min(x, other.x),
                minY: Math.min(y, other.y),
                maxX: Math.max(x, other.x),
                maxY: Math.max(y, other.y),
                width: Math.abs(x - other.x) + 1,
                height: Math.abs(y - other.y) + 1,
              },
            };
          }
        }
      }
      const key = `${bucketX},${bucketY}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(point);
    }
  }
  return null;
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
  return analysis.components
    .slice()
    .sort((first, second) => second.pixelCount - first.pixelCount || first.id - second.id)
    .slice(1);
}

function nonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative`);
  return value;
}
