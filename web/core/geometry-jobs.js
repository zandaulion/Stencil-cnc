import { applyCapsuleBridges } from "./bridges.js";
import { kerfErosionMm } from "./geometry-contract.js";
import { erodeMaskPhysical } from "./morphology.js";
import {
  applySmallOpeningRepairPlan,
  measureRepairEffects,
  planManufacturingRepairs,
} from "./repairs.js";
import { suggestKerfAwareBridges } from "./suggestions.js";
import { validateDesign } from "./validation.js";
import { prepareVectorGeometry } from "./vector-geometry.js";
import { materializeBridgeStrategy } from "./feature-guidance.js";
import { encodeMask } from "./project.js";

function geometryOnlyStrategy(strategy) {
  if (!strategy) return strategy;
  return materializeBridgeStrategy({ ...strategy, featureGuidance: null });
}

function finishedPreview(mask, options) {
  const lossMm = kerfErosionMm(options.kerfMm, options.geometryInterpretation);
  return lossMm > 0
    ? erodeMaskPhysical(mask, lossMm / 2, options.sheet)
    : { ...mask, data: Uint8Array.from(mask.data) };
}

function planSupports(payload, report) {
  const { mask, config, validation } = payload;
  const strategy = materializeBridgeStrategy(config.strategy);
  let usedImageFallback = false;
  let plan;
  report("components", "Finding retained-material components and candidate connections…");
  try {
    plan = suggestKerfAwareBridges(mask, { ...config, strategy });
  } catch (featureError) {
    if (!strategy?.featureAt) throw featureError;
    usedImageFallback = true;
    report("fallback", "Image guidance failed; preserving detail with structural placement…");
    try {
      plan = suggestKerfAwareBridges(mask, {
        ...config,
        strategy: { ...strategy, featureAt: null, detailAt: strategy.fallbackDetailAt },
      });
    } catch {
      plan = suggestKerfAwareBridges(mask, {
        ...config,
        strategy: geometryOnlyStrategy(config.strategy),
      });
    }
  }
  report("checking", "Checking the proposed supports against finished connectivity…");
  const proposed = applyCapsuleBridges(mask, plan.bridges, config.sheet);
  const supportSimulation = validateDesign(proposed, validation);
  return { plan, supportSimulation, usedImageFallback };
}

/** Executes one structured-clone-safe geometry task inside a Worker or test. */
export function executeGeometryJob(type, payload, report = () => {}) {
  if (type === "encode-project-masks") {
    return {
      sourceMask: payload.sourceMask ? encodeMask(payload.sourceMask) : null,
      baseMask: payload.baseMask ? encodeMask(payload.baseMask) : null,
    };
  }
  if (type === "vector-prepare") {
    report("simplifying", "Preparing physical-tolerance vector contours…");
    const prepared = prepareVectorGeometry(
      payload.mask,
      payload.sheet,
      payload.exactCircleHoles,
      payload.options,
    );
    const changesRasterResult = prepared.rasterMask !== payload.mask;
    let postFitValidation = null;
    if (changesRasterResult) {
      report("checking", "Rasterizing the actual vector output and rechecking manufacturing constraints…");
      postFitValidation = validateDesign(prepared.rasterMask, payload.validationOptions);
    }
    return { prepared, changesRasterResult, postFitValidation };
  }
  if (type === "validate") {
    report("checking", "Checking connectivity, openings, and finished metal widths…");
    return validateDesign(payload.mask, payload.options);
  }
  if (type === "repair") {
    report("planning", "Testing local corrections against the complete blocker set…");
    const proposal = planManufacturingRepairs(payload.mask, {
      ...payload.options,
      bridgeStrategy: materializeBridgeStrategy(payload.options.bridgeStrategy),
    });
    return {
      proposal,
      finishedMask: finishedPreview(proposal.mask, payload.options),
    };
  }
  if (type === "repair-evaluate") {
    report("checking", "Rechecking the selected repair choices against every blocker…");
    const candidate = applySmallOpeningRepairPlan(payload.mask, payload.plan);
    const beforeValidation = validateDesign(payload.mask, payload.options);
    const afterValidation = validateDesign(candidate, payload.options);
    return {
      candidate,
      finishedMask: finishedPreview(candidate, payload.options),
      beforeValidation,
      afterValidation,
      effects: measureRepairEffects(payload.mask, candidate, {
        sheet: payload.options.sheet,
        beforeValidation,
        afterValidation,
      }),
    };
  }
  if (type === "support") return planSupports(payload, report);
  throw new RangeError(`Unknown geometry job: ${type}`);
}
