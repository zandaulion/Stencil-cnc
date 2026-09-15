import { analyzeConnectivity } from "./connectivity.js";
import { applyCapsuleBridges } from "./bridges.js";
import { erodeMaskPhysical } from "./morphology.js";
import { assertMask, assertSameSize, assertSheet, cloneMask, pixelSizeMm, positiveFinite } from "./mask.js";

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
  if (config?.strategy?.mode === "smart") {
    const connectivity = suggestSmartBridges(mask, config);
    const maximumSpanMm = config.strategy.maximumUnsupportedSpanMm;
    if (config.strategy.kind !== "lamele" || !Number.isFinite(maximumSpanMm)) return connectivity;
    const connected = applyCapsuleBridges(mask, connectivity, config.sheet);
    // Detect the slat centre-lines before kerf so even a narrow, warning-worthy
    // bar still receives a brace instead of vanishing from the planner. The
    // emitted tie width includes kerf allowance, and the completed design is
    // subsequently checked by the normal post-kerf validation pass.
    const stabilizers = suggestSlatStabilizers(connected, {
      sheet: config.sheet,
      anchorMask: config.anchorMask,
      widthMm: Math.max(
        config.widthMm,
        (config.minimumWebMm ?? 0) + (config.kerfMm ?? 0),
      ),
      barAngleDeg: config.strategy.barAngleDeg,
      slatPitchMm: config.strategy.slatPitchMm,
      maximumUnsupportedSpanMm: maximumSpanMm,
      organicVariation: config.strategy.organicVariation,
      detailAt: config.strategy.detailAt,
      featureAt: config.strategy.featureAt,
      idOffset: connectivity.length,
    });
    return [...connectivity, ...stabilizers];
  }
  return suggestNearestBridges(mask, config);
}

/**
 * Plans retained-material supports against the geometry that will actually
 * remain after the cutter has passed. A design can be one component before
 * kerf and hundreds afterwards; the ordinary planner cannot see those weak
 * necks because there is no topological break yet.
 *
 * Each pass plans on the eroded mask, applies full pre-cut bridge width to the
 * original mask, then erodes again. The loop stops only when post-kerf
 * connectivity is satisfied or a pass cannot reduce the component count.
 * Slat span stabilizers are added once, after connectivity repair, so retries
 * cannot lay duplicate rows over the portrait.
 *
 * @param {import('./mask.js').RasterMask} mask
 * @param {{
 *   sheet:{widthMm:number,heightMm:number},
 *   anchorMask?:import('./mask.js').RasterMask|null,
 *   anchorBoundary?:boolean,
 *   widthMm:number,
 *   requireSingleComponent?:boolean,
 *   minimumWebMm?:number,
 *   kerfMm?:number,
 *   targetMinimumWebConnectivity?:boolean,
 *   outsideIsRemoved?:boolean,
 *   maxPasses?:number,
 *   maximumBridges?:number,
 *   strategy?:object,
 * }} config
 */
export function suggestKerfAwareBridges(mask, config) {
  assertMask(mask);
  if (!config || typeof config !== "object") throw new TypeError("Bridge suggestion configuration is required");
  assertSheet(config.sheet);
  positiveFinite(config.widthMm, "widthMm");
  if (config.anchorMask) assertSameSize(mask, config.anchorMask);

  const kerfMm = nonNegative(config.kerfMm ?? 0, "kerfMm");
  const minimumWebMm = nonNegative(config.minimumWebMm ?? 0, "minimumWebMm");
  const maxPasses = config.maxPasses ?? 4;
  if (!Number.isInteger(maxPasses) || maxPasses < 1 || maxPasses > 12) {
    throw new RangeError("maxPasses must be an integer between 1 and 12");
  }
  const maximumBridges = config.maximumBridges ?? Number.POSITIVE_INFINITY;
  if (maximumBridges !== Number.POSITIVE_INFINITY &&
      (!Number.isInteger(maximumBridges) || maximumBridges < 1 || maximumBridges > 10_000)) {
    throw new RangeError("maximumBridges must be an integer between 1 and 10000");
  }

  // Ordinary support planning asks whether metal remains connected after the
  // kerf. Manufacturing repair can opt into the stricter question: whether a
  // full minimum-web-width core remains connected after kerf. That turns the
  // validator's narrow-web warning into the same sparse, filter-aware bridge
  // problem instead of painting every thin raster cell indiscriminately.
  const planningErosionMm = kerfMm + (config.targetMinimumWebConnectivity === true ? minimumWebMm : 0);
  const erodeForKerf = (candidate) => planningErosionMm > 0
    ? erodeMaskPhysical(candidate, planningErosionMm / 2, config.sheet, {
      outsideIsRemoved: config.outsideIsRemoved,
    })
    : cloneMask(candidate);
  const planningAnchor = config.anchorMask && planningErosionMm > 0
    ? erodeMaskPhysical(config.anchorMask, planningErosionMm / 2, config.sheet, {
      outsideIsRemoved: config.outsideIsRemoved,
    })
    : config.anchorMask ?? null;

  let working = cloneMask(mask);
  let postKerfMask = erodeForKerf(working);
  const initialComponentCount = analyzeConnectivity(postKerfMask, {
    anchorMask: planningAnchor,
    anchorBoundary: config.anchorBoundary,
  }).componentCount;
  let componentCount = initialComponentCount;
  let passes = 0;
  const bridges = [];

  // Connectivity passes intentionally omit slat stabilization. That separate
  // structural layer is added once below after the topology is known to hold.
  const repairStrategy = config.strategy
    ? { ...config.strategy, maximumUnsupportedSpanMm: undefined }
    : undefined;

  while (componentCount > 1 && passes < maxPasses && bridges.length < maximumBridges) {
    const remaining = maximumBridges - bridges.length;
    const proposed = suggestBridges(postKerfMask, {
      ...config,
      anchorMask: planningAnchor,
      strategy: repairStrategy,
    }).filter((bridge) => !bridge.stabilizer).slice(0, remaining);
    if (!proposed.length) break;

    const numbered = proposed.map((bridge, index) => ({
      ...bridge,
      id: `kerf-${passes + 1}-${index + 1}`,
      repairPhase: "postKerf",
      repairPass: passes + 1,
    }));
    const candidate = applyCapsuleBridges(working, numbered, config.sheet);
    const candidatePostKerf = erodeForKerf(candidate);
    const nextCount = analyzeConnectivity(candidatePostKerf, {
      anchorMask: planningAnchor,
      anchorBoundary: config.anchorBoundary,
    }).componentCount;
    passes += 1;

    // Do not retain a pass that failed to improve the manufactured geometry.
    // Retrying the same deterministic graph would only draw duplicates.
    if (nextCount >= componentCount) break;
    bridges.push(...numbered);
    working = candidate;
    postKerfMask = candidatePostKerf;
    componentCount = nextCount;
  }

  const maximumSpanMm = config.strategy?.maximumUnsupportedSpanMm;
  if (bridges.length < maximumBridges &&
      config.strategy?.kind === "lamele" && Number.isFinite(maximumSpanMm)) {
    const remaining = maximumBridges - bridges.length;
    const stabilizers = suggestSlatStabilizers(postKerfMask, {
      sheet: config.sheet,
      anchorMask: planningAnchor,
      widthMm: Math.max(config.widthMm, minimumWebMm + kerfMm),
      barAngleDeg: config.strategy.barAngleDeg,
      slatPitchMm: config.strategy.slatPitchMm,
      maximumUnsupportedSpanMm: maximumSpanMm,
      organicVariation: config.strategy.organicVariation,
      detailAt: config.strategy.detailAt,
      featureAt: config.strategy.featureAt,
      idOffset: bridges.length,
    }).slice(0, remaining).map((bridge, index) => ({
      ...bridge,
      id: `stabilizer-${index + 1}`,
    }));
    if (stabilizers.length) {
      bridges.push(...stabilizers);
      working = applyCapsuleBridges(working, stabilizers, config.sheet);
      postKerfMask = erodeForKerf(working);
      componentCount = analyzeConnectivity(postKerfMask, {
        anchorMask: planningAnchor,
        anchorBoundary: config.anchorBoundary,
      }).componentCount;
    }
  }

  return {
    bridges,
    postKerfMask,
    initialComponentCount,
    finalComponentCount: componentCount,
    passes,
    complete: componentCount === 1,
    capped: bridges.length >= maximumBridges && componentCount > 1,
  };
}

/**
 * Adds staggered rungs between neighbouring slats. Connectivity alone is not
 * enough for a long, narrow strip: it can be one component and still flex or
 * heat-distort. Stations are spaced along the bar direction so neither end nor
 * two consecutive stations exceeds the requested target span. At each station
 * alternate gaps are joined, then the pairing flips at the next station. This
 * braces every interior slat without drawing one conspicuous rail across the
 * whole portrait.
 *
 * The span is a fabrication target, not an engineering certification. Stock
 * material, thickness, mounting and cutting sequence remain external inputs.
 */
export function suggestSlatStabilizers(mask, config) {
  assertMask(mask);
  if (!config || typeof config !== "object") throw new TypeError("Slat stabilizer configuration is required");
  assertSheet(config.sheet);
  positiveFinite(config.widthMm, "widthMm");
  positiveFinite(config.maximumUnsupportedSpanMm, "maximumUnsupportedSpanMm");
  positiveFinite(config.slatPitchMm, "slatPitchMm");
  if (config.anchorMask) assertSameSize(mask, config.anchorMask);
  if (!Number.isFinite(config.barAngleDeg)) throw new RangeError("barAngleDeg must be finite");
  const organicVariation = config.organicVariation ?? 0.7;
  if (!Number.isFinite(organicVariation) || organicVariation < 0 || organicVariation > 1) {
    throw new RangeError("organicVariation must be between 0 and 1");
  }
  if (config.detailAt != null && typeof config.detailAt !== "function") {
    throw new TypeError("detailAt must be a function");
  }
  if (config.featureAt != null && typeof config.featureAt !== "function") {
    throw new TypeError("featureAt must be a function");
  }

  const radians = config.barAngleDeg * Math.PI / 180;
  const along = { x: Math.cos(radians), y: Math.sin(radians) };
  const across = { x: -along.y, y: along.x };
  const pixel = pixelSizeMm(mask, config.sheet);
  const extent = orientedMaterialExtent(mask, config.anchorMask, pixel, along, across);
  if (!extent || extent.maximumAlong - extent.minimumAlong <= config.maximumUnsupportedSpanMm) return [];

  const desiredJitter = Math.min(
    config.slatPitchMm * 0.65,
    config.maximumUnsupportedSpanMm * 0.22,
  ) * organicVariation;
  const targetSpacing = Math.min(
    config.maximumUnsupportedSpanMm,
    Math.max(config.widthMm * 3, config.maximumUnsupportedSpanMm - desiredJitter * 1.5),
  );
  const span = extent.maximumAlong - extent.minimumAlong;
  const segmentCount = Math.max(1, Math.ceil(span / targetSpacing));
  const stationCount = Math.max(0, segmentCount - 1);
  if (stationCount === 0) return [];
  const stationSpacing = span / segmentCount;
  const jitter = Math.max(0, Math.min(
    desiredJitter,
    (config.maximumUnsupportedSpanMm - stationSpacing) / 1.5,
  ));
  const maximumNeighbourGapMm = config.slatPitchMm * 1.35;
  const sampleStepMm = Math.max(0.1, Math.min(pixel.x, pixel.y) * 0.55);
  const bridges = [];

  for (let stationIndex = 0; stationIndex < stationCount; stationIndex += 1) {
    const nominal = extent.minimumAlong + stationSpacing * (stationIndex + 1);
    const offsets = jitter > 0
      ? [-jitter, -jitter * 0.75, -jitter / 2, -jitter * 0.25, 0,
        jitter * 0.25, jitter / 2, jitter * 0.75, jitter]
      : [0];
    const candidates = offsets.map((offset) => {
      const alongPosition = nominal + offset;
      const gaps = crossSectionGaps(
        mask,
        config.sheet,
        along,
        across,
        alongPosition,
        extent.minimumAcross,
        extent.maximumAcross,
        sampleStepMm,
        maximumNeighbourGapMm,
      );
      let selected = staggeredGaps(gaps, stationIndex % 2);
      if (!selected.length && gaps.length) {
        selected = [gaps.reduce((best, gap) =>
          bridgeVisualPenalty(gap, config.detailAt, config.featureAt) <
          bridgeVisualPenalty(best, config.detailAt, config.featureAt) ? gap : best)];
      }
      const visualPenalty = selected.reduce((sum, gap) =>
        sum + bridgeVisualPenalty(gap, config.detailAt, config.featureAt), 0);
      return { alongPosition, offset, gaps, selected, visualPenalty };
    }).filter((candidate) => candidate.selected.length > 0);

    candidates.sort((first, second) =>
      second.selected.length - first.selected.length ||
      first.visualPenalty / first.selected.length - second.visualPenalty / second.selected.length ||
      Math.abs(first.alongPosition - nominal) - Math.abs(second.alongPosition - nominal));
    const chosen = candidates[0];
    if (!chosen) continue;
    for (const gap of chosen.selected) {
      const positionedGap = chooseOrganicGap(
        gap,
        candidates,
        nominal,
        jitter,
        stationIndex,
        config.slatPitchMm,
        along,
        across,
        config.detailAt,
        config.featureAt,
      );
      const organicGap = skewOrganicGap(
        positionedGap,
        mask,
        config.sheet,
        pixel,
        along,
        across,
        stationIndex,
        config.slatPitchMm,
        config.maximumUnsupportedSpanMm,
        organicVariation,
        config.detailAt,
        config.featureAt,
      );
      const visualMetrics = bridgeVisualMetrics(organicGap, config.detailAt, config.featureAt);
      const actualStation = projectedMidpoint(organicGap, along);
      const actualAngle = Math.atan2(
        organicGap.end.y - organicGap.start.y,
        organicGap.end.x - organicGap.start.x,
      ) * 180 / Math.PI;
      const index = bridges.length + (config.idOffset ?? 0) + 1;
      bridges.push({
        id: `auto-stabilizer-${index}`,
        type: "capsule",
        enabled: true,
        units: "mm",
        start: organicGap.start,
        end: organicGap.end,
        width: config.widthMm,
        lengthMm: roundMetric(organicGap.lengthMm),
        addedAreaMm2: roundMetric(organicGap.lengthMm * config.widthMm),
        aestheticScore: roundMetric(organicGap.lengthMm * config.widthMm * (1 + visualMetrics.scorePenalty)),
        angleErrorDeg: roundMetric(angleDistance180(actualAngle, config.barAngleDeg + 90)),
        detailPenalty: roundMetric(visualMetrics.detailPenalty),
        visibilityPenalty: roundMetric(visualMetrics.visibilityPenalty),
        featureAlignmentPenalty: roundMetric(visualMetrics.featureAlignmentPenalty),
        strategy: "lamele",
        role: "stabilizer",
        stabilizer: true,
        stationMm: roundMetric(actualStation),
        nominalStationMm: roundMetric(nominal),
        organicOffsetMm: roundMetric(actualStation - nominal),
        organicSkewMm: roundMetric(organicGap.organicSkewMm ?? 0),
        organicVariation,
        followsFeatures: Boolean(config.featureAt),
        targetSpanMm: config.maximumUnsupportedSpanMm,
        redundant: false,
        fallback: false,
        rank: index,
        source: "automatic",
      });
    }
  }
  return bridges;
}

function skewOrganicGap(gap, mask, sheet, pixel, along, across, stationIndex,
  slatPitchMm, maximumSpanMm, organicVariation, detailAt, featureAt) {
  if (organicVariation <= 0) return gap;
  const band = Math.round(projectedMidpoint(gap, across) / Math.max(slatPitchMm, Number.EPSILON));
  const maximumSkew = Math.min(slatPitchMm * 0.18, maximumSpanMm * 0.06) * organicVariation;
  const preferredSkew = deterministicVariation(stationIndex + 19, band + 7) * maximumSkew;
  const skews = featureAt
    ? [preferredSkew, 0, -maximumSkew, -maximumSkew / 2, maximumSkew / 2, maximumSkew]
    : [preferredSkew];
  const candidates = skews.map((skew) => {
    const start = shiftedRetainedPoint(gap.start, skew, along, mask, sheet, pixel);
    const end = shiftedRetainedPoint(gap.end, -skew, along, mask, sheet, pixel);
    const candidate = {
      ...gap,
      start,
      end,
      lengthMm: Math.hypot(end.x - start.x, end.y - start.y),
      organicSkewMm: projectedPoint(end, along) - projectedPoint(start, along),
    };
    const preferenceCost = Math.abs(skew - preferredSkew) / Math.max(maximumSkew, Number.EPSILON) * 0.35;
    return {
      candidate,
      score: bridgeVisualPenalty(candidate, detailAt, featureAt) + preferenceCost,
    };
  });
  candidates.sort((first, second) => first.score - second.score ||
    Math.abs(first.candidate.organicSkewMm) - Math.abs(second.candidate.organicSkewMm));
  return candidates[0]?.candidate ?? gap;
}

function shiftedRetainedPoint(point, shiftMm, along, mask, sheet, pixel) {
  for (const factor of [1, 0.75, 0.5, 0.25, 0]) {
    const candidate = {
      x: point.x + along.x * shiftMm * factor,
      y: point.y + along.y * shiftMm * factor,
    };
    if (candidate.x < 0 || candidate.y < 0 ||
        candidate.x >= sheet.widthMm || candidate.y >= sheet.heightMm) continue;
    const x = Math.max(0, Math.min(mask.width - 1, Math.floor(candidate.x / pixel.x)));
    const y = Math.max(0, Math.min(mask.height - 1, Math.floor(candidate.y / pixel.y)));
    if (mask.data[y * mask.width + x] === 1) return candidate;
  }
  return point;
}

function projectedPoint(point, axis) {
  return point.x * axis.x + point.y * axis.y;
}

function chooseOrganicGap(base, sections, nominal, jitter, stationIndex,
  slatPitchMm, along, across, detailAt, featureAt) {
  if (jitter <= 0 || sections.length <= 1) return base;
  const baseAcross = projectedMidpoint(base, across);
  const band = Math.round(baseAcross / Math.max(slatPitchMm, Number.EPSILON));
  const targetOffset = deterministicVariation(stationIndex, band) * jitter;
  const alternatives = [];
  for (const section of sections) {
    let nearest = null;
    let acrossDistance = Number.POSITIVE_INFINITY;
    for (const gap of section.gaps) {
      const distance = Math.abs(projectedMidpoint(gap, across) - baseAcross);
      if (distance < acrossDistance) {
        nearest = gap;
        acrossDistance = distance;
      }
    }
    if (!nearest || acrossDistance > slatPitchMm * 0.55) continue;
    const actualOffset = projectedMidpoint(nearest, along) - nominal;
    const offsetError = Math.abs(actualOffset - targetOffset) / Math.max(jitter, Number.EPSILON);
    const score = acrossDistance / slatPitchMm * 4
      + bridgeVisualPenalty(nearest, detailAt, featureAt) * 0.25
      + offsetError * 1.8;
    alternatives.push({ gap: nearest, score, offsetError, acrossDistance });
  }
  alternatives.sort((first, second) =>
    first.score - second.score ||
    first.acrossDistance - second.acrossDistance ||
    first.offsetError - second.offsetError ||
    first.gap.start.y - second.gap.start.y ||
    first.gap.start.x - second.gap.start.x);
  return alternatives[0]?.gap ?? base;
}

function projectedMidpoint(gap, axis) {
  return (gap.start.x + gap.end.x) / 2 * axis.x
    + (gap.start.y + gap.end.y) / 2 * axis.y;
}

function deterministicVariation(stationIndex, band) {
  // Smooth deterministic noise changes gradually between neighbouring slats
  // and stations. That avoids rigid rows without the dangerous large jumps
  // produced by independent random offsets.
  const first = Math.sin((stationIndex + 1) * 0.82 + band * 0.57) * 0.68;
  const second = Math.sin((stationIndex + 1) * 0.37 - band * 0.23 + 1.7) * 0.32;
  return Math.max(-1, Math.min(1, first + second));
}

function orientedMaterialExtent(mask, anchorMask, pixel, along, across) {
  let minimumAlong = Number.POSITIVE_INFINITY;
  let maximumAlong = Number.NEGATIVE_INFINITY;
  let minimumAcross = Number.POSITIVE_INFINITY;
  let maximumAcross = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < mask.data.length; index += 1) {
    if (mask.data[index] !== 1 || anchorMask?.data[index] === 1) continue;
    const point = indexToMm(index, mask.width, pixel);
    const alongPosition = point.x * along.x + point.y * along.y;
    const acrossPosition = point.x * across.x + point.y * across.y;
    minimumAlong = Math.min(minimumAlong, alongPosition);
    maximumAlong = Math.max(maximumAlong, alongPosition);
    minimumAcross = Math.min(minimumAcross, acrossPosition);
    maximumAcross = Math.max(maximumAcross, acrossPosition);
  }
  if (!Number.isFinite(minimumAlong)) return null;
  return { minimumAlong, maximumAlong, minimumAcross, maximumAcross };
}

function crossSectionGaps(mask, sheet, along, across, alongPosition,
  minimumAcross, maximumAcross, sampleStepMm, maximumGapMm) {
  const pixel = pixelSizeMm(mask, sheet);
  const gaps = [];
  let priorIndex = -1;
  let lastRetained = null;
  let opening = false;
  let cluster = 0;
  for (let acrossPosition = minimumAcross; acrossPosition <= maximumAcross + sampleStepMm / 2; acrossPosition += sampleStepMm) {
    const point = {
      x: alongPosition * along.x + acrossPosition * across.x,
      y: alongPosition * along.y + acrossPosition * across.y,
    };
    if (point.x < 0 || point.y < 0 || point.x >= sheet.widthMm || point.y >= sheet.heightMm) continue;
    const x = Math.max(0, Math.min(mask.width - 1, Math.floor(point.x / pixel.x)));
    const y = Math.max(0, Math.min(mask.height - 1, Math.floor(point.y / pixel.y)));
    const index = y * mask.width + x;
    if (index === priorIndex) continue;
    priorIndex = index;
    const retained = mask.data[index] === 1;
    const center = indexToMm(index, mask.width, pixel);
    if (retained) {
      if (opening && lastRetained) {
        const lengthMm = Math.hypot(center.x - lastRetained.x, center.y - lastRetained.y);
        if (lengthMm > Math.min(pixel.x, pixel.y) * 0.5 && lengthMm <= maximumGapMm) {
          gaps.push({ start: lastRetained, end: center, lengthMm, cluster });
        } else if (lengthMm > maximumGapMm) {
          cluster += 1;
        }
      }
      lastRetained = center;
      opening = false;
    } else if (lastRetained) {
      opening = true;
    }
  }
  return gaps;
}

function staggeredGaps(gaps, parity) {
  const groups = new Map();
  for (const gap of gaps) {
    if (!groups.has(gap.cluster)) groups.set(gap.cluster, []);
    groups.get(gap.cluster).push(gap);
  }
  const selected = [];
  for (const group of groups.values()) {
    const groupSelection = group.filter((_, index) => index % 2 === parity);
    // Alternating pairs make the ties read as a staggered ladder. Ensure the
    // two edge slats are not the price of that aesthetic: each local run gets
    // its first and last gap too when the chosen parity would leave an outside
    // bar unsupported until the following station.
    if (group.length && !groupSelection.includes(group[0])) groupSelection.unshift(group[0]);
    const last = group.at(-1);
    if (last && !groupSelection.includes(last)) groupSelection.push(last);
    selected.push(...groupSelection);
  }
  return selected;
}

function bridgeDetail(bridge, detailAt) {
  if (!detailAt) return 0;
  return sampleBridgeDetail(bridge, detailAt);
}

function bridgeVisualMetrics(bridge, detailAt, featureAt) {
  const angleDeg = Math.atan2(
    bridge.end.y - bridge.start.y,
    bridge.end.x - bridge.start.x,
  ) * 180 / Math.PI;
  const featureMetrics = featureAt
    ? sampleBridgeFeatures(bridge, angleDeg, featureAt)
    : { visibilityPenalty: 0, featureAlignmentPenalty: 0, detailPenalty: 0 };
  const detailPenalty = detailAt ? bridgeDetail(bridge, detailAt) : featureMetrics.detailPenalty;
  return {
    ...featureMetrics,
    detailPenalty,
    scorePenalty: detailPenalty * 3.5
      + featureMetrics.visibilityPenalty * 9
      + featureMetrics.featureAlignmentPenalty * 2.5,
  };
}

function bridgeVisualPenalty(bridge, detailAt, featureAt) {
  return bridgeVisualMetrics(bridge, detailAt, featureAt).scorePenalty;
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
 *     featureAt?:(point:{x:number,y:number})=>{lightness:number,strength?:number,tangentAngleDeg?:number,detail?:number},
 *     barAngleDeg?:number,
 *     slatPitchMm?:number,
 *     maximumUnsupportedSpanMm?:number,
 *     organicVariation?:number,
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
    candidate, index, widthMm, strategy, roots,
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
  if (strategy?.detailAt != null && typeof strategy.detailAt !== "function") {
    throw new TypeError("strategy.detailAt must be a function");
  }
  if (strategy?.featureAt != null && typeof strategy.featureAt !== "function") {
    throw new TypeError("strategy.featureAt must be a function");
  }
  return {
    kind: typeof strategy?.kind === "string" ? strategy.kind : "generic",
    level,
    preferredAngleDeg,
    radialCenter,
    detailAt: strategy?.detailAt ?? null,
    featureAt: strategy?.featureAt ?? null,
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
  const featureMetrics = strategy.featureAt
    ? sampleBridgeFeatures(candidate, actual, strategy.featureAt)
    : { visibilityPenalty: 0, featureAlignmentPenalty: 0, detailPenalty: 0 };
  const detailPenalty = strategy.detailAt
    ? sampleBridgeDetail(candidate, strategy.detailAt)
    : featureMetrics.detailPenalty;
  const alignmentWeight = strategy.level === 1 ? 0.8 : strategy.level === 2 ? 4.5 : 2.5;
  const detailWeight = strategy.level === 1 ? 0.8 : strategy.level === 2 ? 3.5 : 2.0;
  // A retained tie over a bright cut-out is immediately visible. This cost is
  // intentionally stronger than the generic detail cost: when structurally
  // equivalent choices exist, dark hair, brows, folds and shadows should win.
  const visibilityWeight = strategy.level === 1 ? 4.5 : strategy.level === 2 ? 9 : 7;
  const featureAlignmentWeight = strategy.level === 1 ? 1 : strategy.level === 2 ? 2.5 : 2;
  const addedAreaMm2 = candidate.lengthMm * widthMm;
  return {
    score: addedAreaMm2 * (1
      + alignmentWeight * alignmentPenalty
      + detailWeight * detailPenalty
      + visibilityWeight * featureMetrics.visibilityPenalty
      + featureAlignmentWeight * featureMetrics.featureAlignmentPenalty),
    addedAreaMm2,
    angleErrorDeg,
    ...featureMetrics,
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

function sampleBridgeFeatures(candidate, bridgeAngleDeg, featureAt) {
  let totalLightness = 0;
  let maximumLightness = 0;
  let featureAlignmentPenalty = 0;
  let totalDetail = 0;
  let maximumDetail = 0;
  const samples = 11;
  for (let index = 0; index < samples; index += 1) {
    const t = (index + 0.5) / samples;
    const sample = featureAt({
      x: candidate.start.x + (candidate.end.x - candidate.start.x) * t,
      y: candidate.start.y + (candidate.end.y - candidate.start.y) * t,
    }) ?? {};
    const rawLightness = Number(sample.lightness);
    const lightness = Number.isFinite(rawLightness) ? clamp01(rawLightness) : 1;
    const rawStrength = Number(sample.strength);
    const strength = Number.isFinite(rawStrength) ? clamp01(rawStrength) : 0;
    const tangentAngleDeg = Number(sample.tangentAngleDeg);
    const rawDetail = Number(sample.detail);
    const detail = Number.isFinite(rawDetail) ? clamp01(rawDetail) : 0;
    const localAlignment = Number.isFinite(tangentAngleDeg)
      ? Math.sin(angleDistance180(bridgeAngleDeg, tangentAngleDeg) * Math.PI / 180) ** 2
      : 0;
    totalLightness += lightness;
    maximumLightness = Math.max(maximumLightness, lightness);
    featureAlignmentPenalty += localAlignment * strength;
    totalDetail += detail;
    maximumDetail = Math.max(maximumDetail, detail);
  }
  return {
    // Sharing the maximum with the average rejects a bridge that is mostly in
    // shadow but crosses one conspicuous highlight, eye white, or bright cheek.
    visibilityPenalty: (totalLightness / samples + maximumLightness) / 2,
    featureAlignmentPenalty: featureAlignmentPenalty / samples,
    detailPenalty: (totalDetail / samples + maximumDetail) / 2,
  };
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

function bridgeFromSmartCandidate(candidate, index, widthMm, strategy, roots) {
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
    visibilityPenalty: roundMetric(candidate.visibilityPenalty ?? 0),
    featureAlignmentPenalty: roundMetric(candidate.featureAlignmentPenalty ?? 0),
    strategy: strategy.kind,
    followsFeatures: Boolean(strategy.featureAt),
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
