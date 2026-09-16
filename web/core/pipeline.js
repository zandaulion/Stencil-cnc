import { applyCapsuleBridges } from "./bridges.js";
import { createRectangularFrameMask } from "./frame.js";
import { cloneMask, createMask, unionMasks } from "./mask.js";
import { decodeMask } from "./project.js";
import { validateDesign } from "./validation.js";

/**
 * Builds the current retained-material geometry from a source threshold mask,
 * the configured frame, and non-destructive manual bridges.
 *
 * @param {import('./mask.js').RasterMask} sourceMask
 * @param {{ sheet: {widthMm: number, heightMm: number}, frame?: object, bridges?: Array<object> }} config
 */
export function buildDesignMask(sourceMask, config) {
  if (!config?.sheet) throw new TypeError("A physical sheet is required to build the design");
  const frameMask = config.frame?.enabled === false
    ? createMask(sourceMask.width, sourceMask.height)
    : createRectangularFrameMask(sourceMask.width, sourceMask.height, config.frame ?? {}, config.sheet);
  const withFrame = config.frame?.enabled === false ? cloneMask(sourceMask) : unionMasks(sourceMask, frameMask);
  const mask = applyCapsuleBridges(withFrame, config.bridges ?? [], config.sheet);
  return { mask, frameMask };
}

/**
 * Convenience pipeline for a normalized project containing an encoded source mask.
 * @param {import('./project.js').StencilProject} project
 */
export function buildProjectDesign(project) {
  if (!project?.raster?.sourceMask) throw new Error("The project has no source raster mask");
  return buildDesignMask(decodeMask(project.raster.sourceMask), project);
}

/** @param {import('./project.js').StencilProject} project */
export function validateProject(project) {
  const built = buildProjectDesign(project);
  const validation = validateDesign(built.mask, {
    sheet: project.sheet,
    kerfMm: project.manufacturing.kerfMm,
    minimumWebMm: project.manufacturing.minimumWebMm,
    minimumOpeningMm: project.manufacturing.minimumOpeningMm,
    geometryInterpretation: project.manufacturing.geometryInterpretation,
    anchorMask: built.frameMask,
    anchorBoundary: project.frame.insetMm === 0,
  });
  return { ...built, validation };
}
