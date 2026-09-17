import {
  FINISHED_BOUNDARY_CAM,
  rasterWebWidthMm,
  requiredOpeningMm,
} from './geometry-contract.js';

const STYLE_LABELS = Object.freeze({
  'style-pitch': 'Bar pitch',
  'style-row-pitch': 'Row spacing',
  'style-cell': 'Stroke cell',
  'style-dot-pitch': 'Dot pitch',
  'style-dot-max': 'Maximum dot diameter',
  'style-wood-spacing': 'Mark spacing',
  'style-wood-length': 'Maximum mark length',
  'style-flow-pitch': 'Ribbon pitch',
  'style-flow-width': 'Maximum cut width',
  'style-flow-smooth': 'Flow smoothing',
  'style-ray-cell': 'Radial pitch',
  'style-ray-hub': 'Solid hub diameter',
  'style-icon-line-width': 'Detail cut width',
  'style-icon-simplify': 'Shape simplification',
  'style-graphic-simplify': 'Shape simplification',
  'style-silhouette-smooth': 'Edge simplification',
  'style-line-width': 'Cut-line width',
  'style-contour-width': 'Contour width',
  'style-ornament-width': 'Cut-line width',
});

function finitePositive(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}

function finiteNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function halfMillimetre(value) {
  return Math.round(value * 2) / 2;
}

function put(controls, id, value, minimum, maximum) {
  controls[id] = halfMillimetre(clamp(value, minimum, maximum));
}

/**
 * A dimensional starting point, not a promise that a particular photograph
 * will validate. Recommendations deliberately avoid tone, angle, and other
 * artistic decisions: they scale only physical pattern dimensions to the
 * current panel and cutting contract.
 */
export function recommendStyleSettings(style, {
  widthMm,
  heightMm,
  kerfMm,
  minimumOpeningMm,
  minimumWebMm,
  geometryInterpretation = FINISHED_BOUNDARY_CAM,
} = {}) {
  finitePositive(widthMm, 'panel width');
  finitePositive(heightMm, 'panel height');
  finiteNonNegative(kerfMm, 'kerf');
  finitePositive(minimumOpeningMm, 'minimum opening');
  finitePositive(minimumWebMm, 'minimum web');

  const shortEdgeMm = Math.min(widthMm, heightMm);
  const openingMm = requiredOpeningMm(minimumOpeningMm, kerfMm);
  const drawnWebMm = rasterWebWidthMm(minimumWebMm, kerfMm, geometryInterpretation);
  // Leave room for one opening, one finished web, and a second tone band. This
  // is the same feasibility floor enforced before the server renders a style.
  const minimumCycleMm = drawnWebMm + openingMm + Math.max(openingMm, drawnWebMm / 2);
  const targetCycleMm = halfMillimetre(Math.max(minimumCycleMm, shortEdgeMm / 30));
  const lineWidthMm = halfMillimetre(Math.max(openingMm, shortEdgeMm / 400));
  const simplificationMm = halfMillimetre(Math.max(openingMm, shortEdgeMm / 160));
  const controls = {};

  switch (style) {
    case 'lamele':
      put(controls, 'style-pitch', targetCycleMm, minimumCycleMm, 40);
      break;
    case 'hasura':
      put(controls, 'style-row-pitch', targetCycleMm * 0.75, minimumCycleMm, 30);
      put(controls, 'style-cell', targetCycleMm * 1.15, minimumCycleMm, 40);
      break;
    case 'puncte': {
      const pitchMm = clamp(targetCycleMm, minimumCycleMm, 80);
      put(controls, 'style-dot-pitch', pitchMm, minimumCycleMm, 80);
      put(controls, 'style-dot-max', pitchMm - drawnWebMm, openingMm, 70);
      break;
    }
    case 'gravura':
      put(controls, 'style-wood-spacing', targetCycleMm * 0.75, minimumCycleMm, 40);
      put(controls, 'style-wood-length', targetCycleMm * 1.5, openingMm, 60);
      break;
    case 'flux': {
      const pitchMm = clamp(targetCycleMm, minimumCycleMm, 60);
      put(controls, 'style-flow-pitch', pitchMm, minimumCycleMm, 60);
      put(controls, 'style-flow-width', Math.max(openingMm, pitchMm * 0.58), openingMm, pitchMm - drawnWebMm);
      put(controls, 'style-flow-smooth', shortEdgeMm / 100, 1, 50);
      break;
    }
    case 'raze':
      put(controls, 'style-ray-cell', targetCycleMm, minimumCycleMm, 60);
      put(controls, 'style-ray-hub', shortEdgeMm * 0.12, Math.max(5, (openingMm + drawnWebMm) / Math.PI), 600);
      break;
    case 'icoana':
      put(controls, 'style-icon-line-width', lineWidthMm, openingMm, 20);
      put(controls, 'style-icon-simplify', simplificationMm, 0, 20);
      break;
    case 'grafic':
      put(controls, 'style-graphic-simplify', simplificationMm * 0.75, 0, 20);
      break;
    case 'silueta':
      put(controls, 'style-silhouette-smooth', shortEdgeMm / 45, 0, 30);
      break;
    case 'linii':
      put(controls, 'style-line-width', lineWidthMm, openingMm, 20);
      break;
    case 'contururi':
      put(controls, 'style-contour-width', lineWidthMm, openingMm, 20);
      break;
    case 'ornament':
      put(controls, 'style-ornament-width', lineWidthMm, openingMm, 20);
      break;
    default:
      break;
  }

  const values = Object.entries(controls).map(([id, valueMm]) => ({
    id,
    label: STYLE_LABELS[id] ?? id,
    valueMm,
  }));
  const repeatCount = targetCycleMm > 0 ? Math.max(1, Math.round(shortEdgeMm / targetCycleMm)) : null;
  return {
    style,
    controls,
    values,
    shortEdgeMm,
    openingMm,
    drawnWebMm,
    minimumCycleMm,
    targetCycleMm,
    repeatCount,
  };
}

