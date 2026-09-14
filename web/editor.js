/**
 * The editor: the layer between forty-two buttons and the geometry core.
 *
 * The core already knows how to do the hard things — label components, suggest
 * bridges, check widths, trace contours, write SVG and DXF. None of that is
 * repeated here. This module's whole job is to keep one description of the
 * design, rebuild it when a control moves, draw it, and report what the core
 * says about it.
 *
 * One rule shapes the rest: **the design is derived, never edited.** Controls,
 * touch-ups and bridges are the truth; the mask on screen is recomputed from
 * them. That is what makes undo a matter of restoring a small object rather
 * than a bitmap, and what makes a saved project reopen as the same thing
 * instead of a picture of it.
 */

import {
  analyzeConnectivity,
  buildDesignMask,
  calculateArtworkPlacement,
  connectedRegionIndices,
  createProject,
  decodeMask,
  deserializeProject,
  encodeMask,
  erodeMaskPhysical,
  exportDxf,
  exportSvg,
  maskFromImageData,
  orientSheet,
  physicalDiscIndices,
  physicalStrokeIndices,
  placeMaskOnSheet,
  serializeProject,
  suggestKerfAwareBridges,
  trimMaskToContent,
  validateDesign,
  zoomAroundPoint,
  REMOVED,
  RETAINED,
} from '/core/index.js';
import { clearLastProject, downloadText, loadLastProject, saveProject } from '/storage.js';

/* ------------------------------------------------------------------ state */

// The raster the design is computed on. Independent of the panel's real size:
// millimetres come from `sheet`, so this only decides how fine the tracing can
// be. 900 across matches the analysis service, and keeps a rebuild under a
// frame on a laptop.
const RASTER_LONG_EDGE = 900;
const MAX_SHEET_LONG_EDGE = 2600;
const MM_PER_INCH = 25.4;
const PLASMA_MIN_OPENING_MM = 2;
const PLASMA_MIN_WEB_MM = 3;
const UNDO_DEPTH = 40;
const CANDIDATE_LIMIT = 8;
const BASE_STYLE_SETTINGS = Object.freeze({
  'style-gain': '2.2',
  'style-smooth': '0.55',
  'style-curve': '1.4',
  'style-cutout': false,
  'style-clothes': true,
  polarity: 'black-retained',
});
const STYLE_DEFAULT_SETTINGS = Object.freeze({
  icoana: Object.freeze({
    'style-gain': '2.8',
    'style-smooth': '0.70',
    'style-curve': '1.4',
    'style-cutout': true,
    'style-clothes': true,
    polarity: 'black-retained',
  }),
  lamele: Object.freeze({
    'style-gain': '3',
    'style-smooth': '0.70',
    'style-curve': '0.8',
    'style-cutout': true,
    'style-clothes': true,
    polarity: 'black-retained',
  }),
});
const STYLE_SHARED_CONTROL_IDS = Object.freeze([
  'style-gain', 'style-smooth', 'style-curve', 'style-cutout', 'style-clothes',
]);

const state = {
  device: null,
  offline: false,
  projectId: null,
  createdAt: null,
  name: 'Untitled panel',
  stage: 'prepare',
  view: 'material',
  sidePanel: 'candidates',
  tool: 'pan',
  unit: 'mm',

  source: null,          // { file, imageData, width, height, name, bytes }
  mode: 'line-art',      // 'line-art' threshold locally, 'photo' renders on the server
  activeStyle: 'line-art',
  styleSettings: {},     // shared photo controls remembered independently per filter
  styleMask: null,       // what the analysis service returned, before touch-ups
  styleMaskFor: null,    // cut style that produced styleMask
  styleMaskFresh: false, // false while controls have changed or a refinement is pending
  styleBusy: false,
  baseMask: null,        // threshold/style result in the source's own aspect
  sourceMask: null,      // base mask placed on the physical sheet, plus touch-ups
  placement: null,
  contentBounds: null,   // non-empty generated artwork inside the source mask
  contentSourceSize: null,
  designMask: null,      // after frame and bridges
  frameMask: null,
  kerfPreviewMask: null, // live simulation; available before validation

  // Touch-ups are kept as intent, not as a modified bitmap, so they survive a
  // change of threshold instead of being silently overwritten by it.
  painted: { keep: new Set(), remove: new Set() },
  touchupPreview: null,

  bridges: [],
  drawingBridge: false,
  bridgePreview: null,
  automaticSupportsStale: false,
  selectedBridge: null,
  candidates: [],
  selectedCandidateId: null,
  analysis: null,
  validation: null,
  issues: [],
  issueFilter: 'all',
  highlightedIssue: null,
  highlightedIssueLocation: 0,
  validated: false,
  revision: 0,
  validatedRevision: -1,

  zoom: 1,
  pan: { x: 0, y: 0 },
  dirty: false,
  undo: [],
  redo: [],
};

const el = (id) => document.getElementById(id);
const all = (selector) => [...document.querySelectorAll(selector)];

/* ------------------------------------------------------------------ units */

// Every control speaks the chosen unit; everything inside speaks millimetres.
// Converting at the boundary means no calculation ever has to ask which one it
// is holding.
const toMm = (value) => (state.unit === 'in' ? value * MM_PER_INCH : value);
const fromMm = (value) => (state.unit === 'in' ? value / MM_PER_INCH : value);
const roundUnit = (value) => (state.unit === 'in' ? Math.round(value * 1000) / 1000 : Math.round(value * 10) / 10);

function numberField(id, fallback = 0) {
  const value = Number.parseFloat(el(id)?.value);
  return Number.isFinite(value) ? value : fallback;
}

function enforcePlasmaLimits() {
  const adjusted = [];
  for (const [id, minimumMm, label] of [
    ['min-opening', PLASMA_MIN_OPENING_MM, 'minimum opening'],
    ['min-web', PLASMA_MIN_WEB_MM, 'minimum gap'],
    ['bridge-width', PLASMA_MIN_WEB_MM, 'bridge width'],
    ['selected-bridge-width', PLASMA_MIN_WEB_MM, 'selected bridge width'],
  ]) {
    const node = el(id);
    if (!node) continue;
    const displayedMinimum = roundUnit(fromMm(minimumMm));
    node.min = String(displayedMinimum);
    if (toMm(numberField(id, displayedMinimum)) < minimumMm) {
      node.value = String(displayedMinimum);
      adjusted.push(`${label} to ${displayedMinimum} ${state.unit}`);
    }
  }
  return adjusted;
}

function sheet() {
  return {
    widthMm: Math.max(10, toMm(numberField('panel-width', 1250))),
    heightMm: Math.max(10, toMm(numberField('panel-height', 2500))),
  };
}

/* ------------------------------------------------- rebuilding the design */

/** Luminance-per-pixel with the treatment controls applied. */
function treatedImageData() {
  const { imageData } = state.source;
  const { width, height, data } = imageData;
  const out = new Uint8ClampedArray(data.length);

  const contrast = numberField('contrast', 0) / 100;
  const factor = contrast >= 0 ? 1 + contrast * 2 : 1 + contrast;
  const blur = numberField('blur', 0);

  for (let i = 0; i < data.length; i += 4) {
    const grey = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    const adjusted = (grey - 128) * factor + 128;
    out[i] = out[i + 1] = out[i + 2] = adjusted;
    out[i + 3] = data[i + 3];
  }

  const field = { width, height, data: out };
  return blur > 0 ? boxBlur(field, Math.round(blur)) : field;
}

/** Separable box blur: one horizontal pass and one vertical pass. */
function boxBlur(field, radius) {
  const { width, height } = field;
  const horizontal = new Uint8ClampedArray(field.data.length);
  const vertical = new Uint8ClampedArray(field.data.length);
  const blurPass = (src, dst, verticalPass) => {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        let alpha = 0;
        let count = 0;
        for (let k = -radius; k <= radius; k += 1) {
          const sx = verticalPass ? x : x + k;
          const sy = verticalPass ? y + k : y;
          if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
          const sample = (sy * width + sx) * 4;
          sum += src[sample];
          alpha += src[sample + 3];
          count += 1;
        }
        const index = (y * width + x) * 4;
        dst[index] = dst[index + 1] = dst[index + 2] = sum / count;
        dst[index + 3] = alpha / count;
      }
    }
  };
  blurPass(field.data, horizontal, false);
  blurPass(horizontal, vertical, true);
  return { width, height, data: vertical };
}

/** Drops retained specks below the configured area. */
function despeckle(mask, minimumPixels) {
  if (minimumPixels <= 0) return mask;
  const seen = new Uint8Array(mask.data.length);
  const stack = [];
  for (let start = 0; start < mask.data.length; start += 1) {
    if (seen[start] || mask.data[start] !== RETAINED) continue;
    const members = [];
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const index = stack.pop();
      members.push(index);
      const x = index % mask.width;
      const y = (index - x) / mask.width;
      const push = (next) => {
        if (!seen[next] && mask.data[next] === RETAINED) { seen[next] = 1; stack.push(next); }
      };
      if (x > 0) push(index - 1);
      if (x < mask.width - 1) push(index + 1);
      if (y > 0) push(index - mask.width);
      if (y < mask.height - 1) push(index + mask.width);
    }
    if (members.length < minimumPixels) {
      for (const index of members) mask.data[index] = REMOVED;
    }
  }
  return mask;
}

function selectedCutStyle() {
  return document.querySelector('input[name="cutStyle"]:checked')?.value || 'line-art';
}

function cloneStyleSettings(settings = {}) {
  return Object.fromEntries(Object.entries(settings).map(([style, recipe]) => [
    style,
    recipe && typeof recipe === 'object' && !Array.isArray(recipe) ? { ...recipe } : {},
  ]));
}

function readSharedStyleSettings() {
  const recipe = {};
  for (const id of STYLE_SHARED_CONTROL_IDS) {
    const node = el(id);
    if (!node) continue;
    recipe[id] = node.type === 'checkbox' ? node.checked : node.value;
  }
  recipe.polarity = document.querySelector('input[name="polarity"]:checked')?.value || 'black-retained';
  return recipe;
}

function styleDefaults(style) {
  return { ...BASE_STYLE_SETTINGS, ...(STYLE_DEFAULT_SETTINGS[style] || {}) };
}

function rememberStyleSettings(style = state.activeStyle) {
  if (!style) return;
  state.styleSettings[style] = readSharedStyleSettings();
}

function applySharedStyleSettings(recipe) {
  for (const id of STYLE_SHARED_CONTROL_IDS) {
    const node = el(id);
    if (!node || !Object.hasOwn(recipe, id)) continue;
    if (node.type === 'checkbox') node.checked = recipe[id] === true;
    else node.value = recipe[id];
  }
  const polarity = recipe.polarity === 'white-retained' ? 'white-retained' : 'black-retained';
  const polarityNode = document.querySelector(`input[name="polarity"][value="${polarity}"]`);
  if (polarityNode) polarityNode.checked = true;
}

function activateStyleSettings(style) {
  rememberStyleSettings();
  const recipe = state.styleSettings[style] || styleDefaults(style);
  applySharedStyleSettings(recipe);
  state.activeStyle = style;
  rememberStyleSettings(style);
  updateRangeOutputs();
}

function hasCurrentStyleMask() {
  return Boolean(state.styleMask && state.styleMaskFor === selectedCutStyle());
}

function hasFreshStyleMask() {
  return hasCurrentStyleMask() && state.styleMaskFresh;
}

function visibleContentValue() {
  const style = selectedCutStyle();
  if (style === 'line-art') {
    return document.querySelector('input[name="polarity"]:checked')?.value === 'white-retained'
      ? REMOVED : RETAINED;
  }
  // These styles draw the picture as retained metal. The other photograph
  // styles draw it as openings in a retained plate.
  return style === 'grafic' || style === 'lamele' ? RETAINED : REMOVED;
}

function remapPaintedSet(indices, fromKey, toWidth, toHeight) {
  const match = /^(\d+)x(\d+)$/.exec(fromKey || '');
  if (!match) return new Set();
  const fromWidth = Number(match[1]);
  const fromHeight = Number(match[2]);
  const remapped = new Set();
  for (const index of indices) {
    const x = index % fromWidth;
    const y = Math.floor(index / fromWidth);
    const targetX = Math.min(toWidth - 1, Math.floor((x + 0.5) / fromWidth * toWidth));
    const targetY = Math.min(toHeight - 1, Math.floor((y + 0.5) / fromHeight * toHeight));
    remapped.add(targetY * toWidth + targetX);
  }
  return remapped;
}

function rebuildSource() {
  let mask = null;

  if (state.source && hasCurrentStyleMask()) {
    // Server-rendered masks are used by every style when available. Line art
    // has an immediate local fallback below; photograph styles do not, because
    // thresholding a face directly produces thousands of loose specks.
    mask = { ...state.styleMask, data: Uint8Array.from(state.styleMask.data) };
  } else if (state.source && state.mode === 'photo') {
    state.sourceMask = null;
    state.baseMask = null;
    return;
  } else if (state.source) {
    const threshold = Math.round((numberField('threshold', 50) / 100) * 255);
    const whiteIsMetal = document.querySelector('input[name="polarity"]:checked')?.value === 'white-retained';
    mask = maskFromImageData(treatedImageData(), { threshold, invert: whiteIsMetal });
    despeckle(mask, Math.round(numberField('despeckle', 0)));
  } else if (state.baseMask) {
    // A reopened project intentionally keeps the processed mask rather than
    // the private original photograph. Panel placement and support editing
    // remain available even though tone controls cannot be recomputed.
    mask = { ...state.baseMask, data: Uint8Array.from(state.baseMask.data) };
  } else if (state.sourceMask) {
    // Version-0 projects only stored the already-placed raster. Preserve that
    // exact geometry even though it cannot be re-laid out without its source.
    return;
  } else {
    state.sourceMask = null;
    state.placement = null;
    state.contentBounds = null;
    state.contentSourceSize = null;
    return;
  }

  state.baseMask = { ...mask, data: Uint8Array.from(mask.data) };
  state.contentSourceSize = { width: mask.width, height: mask.height };
  const trimmed = trimMaskToContent(mask, visibleContentValue());
  state.contentBounds = trimmed.bounds;
  mask = trimmed.mask;
  const currentSheet = sheet();
  const physicalLimits = [
    toMm(numberField('kerf', 1.2)),
    toMm(numberField('min-opening', 2)),
    toMm(numberField('min-web', 3)),
  ].filter((value) => value > 0);
  const smallestLimit = physicalLimits.length ? Math.min(...physicalLimits) : Number.POSITIVE_INFINITY;
  const requiredLongEdge = Number.isFinite(smallestLimit)
    ? Math.ceil(Math.max(currentSheet.widthMm, currentSheet.heightMm) / smallestLimit * 2)
    : 0;
  const placed = placeMaskOnSheet(mask, sheet(), {
    frame: frameConfig(),
    marginMm: toMm(numberField('panel-margin', 0)),
    fitToFrame: el('fit-artwork')?.checked !== false,
    longEdgePx: Math.min(MAX_SHEET_LONG_EDGE, Math.max(mask.width, mask.height, requiredLongEdge)),
  });
  mask = placed.mask;
  state.placement = placed.placement;

  // Touch-ups last, so a deliberate correction is never undone by a slider.
  // Their coordinates are remapped when the manufacturing raster changes;
  // this is common when a 900 px preview is replaced by a refined server mask.
  const rasterKey = `${mask.width}x${mask.height}`;
  if (state.paintedFor && state.paintedFor !== rasterKey &&
      (state.painted.keep.size || state.painted.remove.size)) {
    state.painted = {
      keep: remapPaintedSet(state.painted.keep, state.paintedFor, mask.width, mask.height),
      remove: remapPaintedSet(state.painted.remove, state.paintedFor, mask.width, mask.height),
    };
  }
  state.paintedFor = rasterKey;
  if (state.paintedFor === rasterKey) {
    for (const index of state.painted.keep) mask.data[index] = RETAINED;
    for (const index of state.painted.remove) mask.data[index] = REMOVED;
  }
  state.sourceMask = mask;
}

/* ------------------------------------------------------- rendering a style */

function styleParams(stil = selectedCutStyle()) {
  const stilApi = stil === 'line-art' ? 'linie_art' : stil;
  const form = new FormData();
  form.set('foto', state.source.file, state.source.name);
  form.set('stil', stilApi);
  const sourceSize = { width: state.source.width, height: state.source.height };
  const placement = calculateArtworkPlacement(sourceSize, sheet(), {
    frame: frameConfig(),
    marginMm: toMm(numberField('panel-margin', 0)),
    fitToFrame: el('fit-artwork')?.checked !== false,
  });
  form.set('coala_lat_mm', String(placement.widthMm));
  form.set('fara_fundal', String(el('style-cutout')?.checked !== false));
  form.set('cu_haine', String(stil === 'grafic' || el('style-clothes')?.checked === true));
  form.set('castig', String(numberField('style-gain', 2.2)));
  form.set('netezire', String(numberField('style-smooth', 0.55)));
  form.set('gamma', String(numberField('style-curve', 1.4)));
  form.set('inverseaza', String(
    document.querySelector('input[name="polarity"]:checked')?.value === 'white-retained',
  ));
  // Minimum web is the width that must remain in the finished panel. The
  // analysis service receives kerf separately and widens generated retained
  // geometry before cutting, keeping the operator's requirement explicit.
  form.set('punte_min_mm', String(toMm(numberField('min-web', 3))));
  form.set('kerf_mm', String(toMm(numberField('kerf', 1.2))));
  form.set('fanta_min_mm', String(Math.max(
    toMm(numberField('kerf', 1.2)),
    toMm(numberField('min-opening', 2)),
  )));
  if (stil === 'line-art') {
    form.set('prag_linie', String(numberField('threshold', 50) / 100));
    form.set('contrast_linie', String(numberField('contrast', 0)));
    form.set('netezire_linie_px', String(numberField('blur', 0)));
    form.set('pete_min_px2', String(numberField('despeckle', 0)));
    form.set('latime_baza_px', String(state.source.width));
  } else if (stil === 'sablon') {
    form.set('prag_sablon', String(numberField('style-threshold', 50) / 100));
    form.set('contur', String(numberField('style-outline', 60) / 100));
  } else if (stil === 'icoana') {
    form.set('prag_icoana', String(numberField('style-icon-balance', 56) / 100));
    form.set('detaliu_icoana', String(numberField('style-icon-detail', 65) / 100));
    form.set('latime_linie_icoana_mm', String(toMm(numberField('style-icon-line-width', 3))));
    form.set('simplificare_icoana_mm', String(toMm(numberField('style-icon-simplify', 3))));
    form.set('aureola_icoana', String(el('style-icon-halo')?.checked !== false));
    form.set('scala_aureola_icoana', String(numberField('style-icon-halo-scale', 135) / 100));
  } else if (stil === 'grafic') {
    form.set('prag_grafic', String(numberField('style-graphic-balance', 50) / 100));
    form.set('detaliu_grafic', String(numberField('style-graphic-detail', 70) / 100));
    form.set('simplificare_grafic_mm', String(toMm(numberField('style-graphic-simplify', 1.5))));
  } else if (stil === 'lamele') {
    form.set('pas_mm', String(toMm(numberField('style-pitch', 38))));
    form.set('unghi_lamele', String(numberField('style-slat-angle', -55)));
  } else if (stil === 'hasura') {
    form.set('unghi', String(numberField('style-angle', 30)));
    form.set('pas_rand_mm', String(toMm(numberField('style-row-pitch', 9))));
    form.set('celula_mm', String(toMm(numberField('style-cell', 12))));
  } else if (stil === 'linii') {
    form.set('detaliu_linii', String(numberField('style-line-detail', 40) / 100));
    form.set('latime_linie_mm', String(toMm(numberField('style-line-width', 2))));
  } else if (stil === 'gravura') {
    form.set('pas_gravura_mm', String(toMm(numberField('style-wood-spacing', 12))));
    form.set('lungime_gravura_mm', String(toMm(numberField('style-wood-length', 20))));
  } else if (stil === 'silueta') {
    form.set('netezire_silueta_mm', String(toMm(numberField('style-silhouette-smooth', 8))));
  } else if (stil === 'contururi') {
    form.set('niveluri_contur', String(numberField('style-contour-levels', 5)));
    form.set('latime_linie_mm', String(toMm(numberField('style-contour-width', 2.5))));
  } else if (stil === 'raze') {
    form.set('numar_raze', String(numberField('style-ray-count', 64)));
    form.set('celula_raze_mm', String(toMm(numberField('style-ray-cell', 12))));
    form.set('centru_raze_automat', String(el('style-ray-center-auto')?.checked !== false));
    form.set('centru_raze_x', String(numberField('style-ray-center-x', 25) / 100));
    form.set('centru_raze_y', String(numberField('style-ray-center-y', 50) / 100));
    form.set('prag_raze', String(numberField('style-ray-cutoff', 12) / 100));
  } else if (stil === 'ornament') {
    form.set('detaliu_linii', String(numberField('style-ornament-detail', 40) / 100));
    form.set('latime_linie_mm', String(toMm(numberField('style-ornament-width', 2))));
    form.set('patru_directii', String(el('style-ornament-four-way')?.checked === true));
  }
  return form;
}

/**
 * Raises the style's spacing to something the limits actually allow.
 *
 * The cutting limits are not the style's to argue with -- a bar narrower than
 * the minimum web would simply fail validation later -- but a pitch that cannot
 * hold one is a request the server will refuse. Rather than send it and relay
 * the refusal, the control moves and says so. The operator can still widen it
 * further; what they cannot do is ask for geometry that does not exist.
 */
function enforceStyleSpacing() {
  const style = document.querySelector('input[name="cutStyle"]:checked')?.value || 'sablon';
  const kerf = toMm(numberField('kerf', 1.2));
  const web = toMm(numberField('min-web', 3)) + kerf;
  const slot = Math.max(kerf, toMm(numberField('min-opening', 2)));
  // Merely fitting one minimum web beside one minimum opening leaves no range
  // in which tone can change the geometry. Reserve one additional detail band
  // so the lightest and darkest parts of a photograph cannot become identical.
  const minim = fromMm(web + slot + Math.max(slot, web / 2));
  const ajustate = [];

  const pitch = style === 'lamele' ? el('style-pitch') : null;
  if (pitch) {
    pitch.min = String(roundUnit(minim));
    if (numberField('style-pitch', 38) < minim) {
      pitch.value = roundUnit(minim);
      ajustate.push(`bar pitch to ${pitch.value} ${state.unit}`);
    }
  }
  const spacingFields = style === 'hasura'
    ? [['style-row-pitch', 'row spacing'], ['style-cell', 'stroke cell']]
    : style === 'gravura'
      ? [['style-wood-spacing', 'mark spacing']]
      : style === 'raze' ? [['style-ray-cell', 'radial cell']] : [];
  for (const [id, eticheta] of spacingFields) {
    const node = el(id);
    if (!node) continue;
    node.min = String(roundUnit(minim));
    if (numberField(id, 3) < minim) {
      node.value = roundUnit(minim);
      ajustate.push(`${eticheta} to ${node.value} ${state.unit}`);
    }
  }
  const lineField = {
    icoana: 'style-icon-line-width',
    linii: 'style-line-width',
    contururi: 'style-contour-width',
    ornament: 'style-ornament-width',
  }[style];
  if (lineField) {
    const node = el(lineField);
    const minimumLine = fromMm(slot);
    node.min = String(roundUnit(minimumLine));
    if (numberField(lineField, 2) < minimumLine) {
      node.value = roundUnit(minimumLine);
      ajustate.push(`cut-line width to ${node.value} ${state.unit}`);
    }
  }
  if (style === 'gravura') {
    const node = el('style-wood-length');
    const minimumLength = fromMm(slot);
    node.min = String(roundUnit(minimumLength));
    if (numberField('style-wood-length', 20) < minimumLength) {
      node.value = roundUnit(minimumLength);
      ajustate.push(`mark length to ${node.value} ${state.unit}`);
    }
  }
  return ajustate;
}

let styleToken = 0;
let styleAbort = null;
let renderProgressClock = null;

function setRenderProgress(phase = null, style = selectedCutStyle()) {
  const progress = el('render-progress');
  const viewport = el('canvas-viewport');
  const controls = el('style-controls');
  const status = el('style-status');
  const rerender = el('btn-restyle');
  const visible = Boolean(phase && state.source && !state.offline);

  clearInterval(renderProgressClock);
  renderProgressClock = null;
  progress?.toggleAttribute('hidden', !visible);
  viewport?.setAttribute('aria-busy', String(visible));
  controls?.setAttribute('aria-busy', String(visible));
  status?.classList.toggle('is-busy', visible);
  if (rerender) rerender.disabled = visible;
  if (viewport) {
    if (visible) viewport.dataset.renderProgress = phase;
    else delete viewport.dataset.renderProgress;
  }
  if (!visible) return;

  const title = el('render-progress-title');
  const detail = el('render-progress-detail');
  const styleName = CUT_STYLE_NAMES[style] || 'Artwork';
  if (phase === 'queued') {
    if (title) title.textContent = 'Preview update queued';
    if (detail) detail.textContent = `${styleName} will render when you finish adjusting.`;
    return;
  }

  if (title) title.textContent = 'Updating preview…';
  const startedAt = performance.now();
  const updateElapsed = () => {
    const seconds = Math.max(0, Math.floor((performance.now() - startedAt) / 1000));
    if (detail) detail.textContent = seconds > 0
      ? `${styleName} is rendering on the private server · ${seconds}s elapsed.`
      : `${styleName} is rendering on the private server. This can take a few seconds.`;
  };
  updateElapsed();
  renderProgressClock = setInterval(updateElapsed, 1000);
}

function invalidateStyleRender({ useLocalPreview = state.mode === 'line-art' } = {}) {
  state.styleMaskFresh = false;
  if (useLocalPreview) {
    state.styleMask = null;
    state.styleMaskFor = null;
  }
  // Cancel both the network request and its right to update state. Aborting
  // alone is not enough when a response has already reached JSON decoding.
  styleToken += 1;
  styleAbort?.abort();
  styleAbort = null;
  state.styleBusy = false;
  setRenderProgress();
  if (state.selectedCandidateId) {
    state.selectedCandidateId = null;
    renderCandidates();
  }
  markAutomaticSupportsStale();
  invalidateValidation();
  if (state.source) {
    setStyleStatus(state.offline
      ? 'Offline · using the local line-art renderer.'
      : state.mode === 'line-art'
        ? 'Local preview ready · high-quality refinement pending…'
        : 'Updated render pending…');
    markDirty();
  }
}

async function renderStyle() {
  if (!state.source?.file || state.offline) {
    setRenderProgress();
    return false;
  }
  const requestedStyle = selectedCutStyle();
  const ajustate = [...enforcePlasmaLimits(), ...enforceStyleSpacing()];
  if (ajustate.length) {
    toast(`Raised ${ajustate.join(' and ')} to fit the cut limits.`);
  }
  const mine = ++styleToken;
  styleAbort?.abort();
  styleAbort = new AbortController();
  state.styleBusy = true;
  setRenderProgress('running', requestedStyle);
  setStyleStatus(requestedStyle === 'line-art'
    ? 'Refining at manufacturing resolution…'
    : 'Rendering on the server…');
  const hadPlacedMask = Boolean(state.sourceMask);
  try {
    const response = await fetch('/api/analizeaza', {
      method: 'POST', body: styleParams(requestedStyle), credentials: 'same-origin', signal: styleAbort.signal,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || payload.message || `Failed (${response.status})`);
    // A slower earlier answer must not overwrite a newer one: the same race
    // that made a slider look stuck in the other app.
    if (mine !== styleToken || requestedStyle !== selectedCutStyle()) return false;
    state.styleMask = decodeMask(payload.sourceMask);
    state.styleMaskFor = requestedStyle;
    state.styleMaskFresh = true;
    if (requestedStyle === 'raze' && payload.info.radialCenter) {
      const radial = payload.info.radialCenter;
      const centerX = el('style-ray-center-x');
      const centerY = el('style-ray-center-y');
      if (centerX) centerX.value = String(Math.round(radial.x * 1000) / 10);
      if (centerY) centerY.value = String(Math.round(radial.y * 1000) / 10);
      const centerStatus = el('style-ray-center-status');
      if (centerStatus) {
        centerStatus.textContent = radial.automatic
          ? radial.matchedMetal
            ? `Auto-placed in existing metal · complete hub radius ${radial.hubRadiusMm} mm.`
            : 'No solid-metal area could contain the complete hub · using the 25% / 50% fallback.'
          : 'Manual focal point. Switch automatic placement on to conceal the solid hub in existing metal.';
      }
      updateRangeOutputs();
    }
    setStyleStatus(`Rendered · ${Math.round(payload.info.material * 100)}% material`);
    refresh({ immediate: true });
    if (!hadPlacedMask) fitToView();
    return true;
  } catch (error) {
    if (error.name === 'AbortError') return false;
    if (mine !== styleToken) return false;
    console.error(error);
    setStyleStatus(error.message);
    toast(error.message);
    return false;
  } finally {
    if (mine === styleToken) {
      state.styleBusy = false;
      styleAbort = null;
      setRenderProgress();
    }
  }
}

function setStyleStatus(text) {
  const node = el('style-status');
  if (node) node.textContent = text;
}

function reflectModeControls() {
  const style = document.querySelector('input[name="cutStyle"]:checked')?.value || 'line-art';
  const lineArt = style === 'line-art';
  el('tool-icon-stencil')?.setAttribute('aria-pressed', String(style === 'icoana'));
  el('tool-icon-stencil')?.classList.toggle('is-selected', style === 'icoana');
  el('style-controls')?.removeAttribute('hidden');
  el('tone-controls')?.toggleAttribute('hidden', !lineArt);
  el('style-photo-common')?.toggleAttribute('hidden', lineArt);
  el('style-curve-control')?.toggleAttribute(
    'hidden', !['lamele', 'hasura', 'gravura', 'raze'].includes(style),
  );
  el('btn-restyle')?.toggleAttribute('hidden', lineArt);
  el('style-stencil')?.toggleAttribute('hidden', style !== 'sablon');
  el('style-icon')?.toggleAttribute('hidden', style !== 'icoana');
  el('style-graphic')?.toggleAttribute('hidden', style !== 'grafic');
  el('style-slats')?.toggleAttribute('hidden', style !== 'lamele');
  el('style-hatch')?.toggleAttribute('hidden', style !== 'hasura');
  el('style-linework')?.toggleAttribute('hidden', style !== 'linii');
  el('style-woodcut')?.toggleAttribute('hidden', style !== 'gravura');
  el('style-silhouette')?.toggleAttribute('hidden', style !== 'silueta');
  el('style-contours')?.toggleAttribute('hidden', style !== 'contururi');
  el('style-radial')?.toggleAttribute('hidden', style !== 'raze');
  el('style-ornament')?.toggleAttribute('hidden', style !== 'ornament');
  const cutout = el('style-cutout');
  if (cutout) {
    cutout.disabled = style === 'icoana';
    if (style === 'icoana') cutout.checked = true;
  }
  el('style-icon-halo-scale-control')?.toggleAttribute(
    'hidden', el('style-icon-halo')?.checked === false,
  );
  reflectRayCentreControls();
  updateSlatStabilizerControls();
}

function reflectRayCentreControls() {
  const automatic = el('style-ray-center-auto')?.checked !== false;
  for (const id of ['style-ray-center-x', 'style-ray-center-y']) {
    const node = el(id);
    if (node) node.disabled = automatic || !state.source;
  }
  const status = el('style-ray-center-status');
  if (status && automatic && !state.source) {
    status.textContent = 'The server will place the complete solid hub inside planned metal.';
  } else if (status && !automatic) {
    status.textContent = 'Manual focal point. Switch automatic placement on to conceal the solid hub in existing metal.';
  }
}

function updateSlatStabilizerControls() {
  const isSlats = selectedCutStyle() === 'lamele';
  const toggle = el('stabilize-slats');
  const span = el('max-cantilever');
  const organic = el('stabilizer-organic');
  if (toggle) toggle.disabled = !isSlats;
  if (organic) organic.disabled = !isSlats || toggle?.checked === false;
  if (!span) return;
  span.disabled = !isSlats || toggle?.checked === false;
  span.min = String(roundUnit(fromMm(25)));
  span.max = String(roundUnit(fromMm(2000)));
  span.step = state.unit === 'in' ? '0.25' : '10';
}

function setMode(mode) {
  state.mode = mode;
  reflectModeControls();
  if (!state.source) { refresh({ immediate: true }); return; }
  if (mode === 'line-art') {
    refresh({ immediate: true });
    if (!hasFreshStyleMask()) void renderStyle();
  } else if (!hasCurrentStyleMask()) {
    void renderStyle();
  } else {
    refresh({ immediate: true });
  }
}

function frameConfig() {
  const thickness = toMm(numberField('frame-width', 30));
  const sides = {};
  for (const box of all('input[name="anchorEdge"]')) sides[box.value] = box.checked;
  return {
    enabled: thickness > 0 && Object.values(sides).some(Boolean),
    thicknessMm: thickness,
    insetMm: 0,
    sides,
  };
}

function rebuildDesign() {
  if (!state.sourceMask) {
    state.designMask = null;
    state.frameMask = null;
    state.kerfPreviewMask = null;
    return;
  }
  const built = buildDesignMask(state.sourceMask, {
    sheet: sheet(),
    frame: frameConfig(),
    bridges: state.bridges.filter((bridge) => bridge.enabled !== false),
  });
  state.designMask = built.mask;
  state.frameMask = built.frameMask;
  const kerfMm = toMm(numberField('kerf', 1.2));
  state.kerfPreviewMask = kerfMm > 0
    ? erodeMaskPhysical(state.designMask, kerfMm / 2, sheet())
    : { ...state.designMask, data: Uint8Array.from(state.designMask.data) };
}

function invalidateValidation({ clearAnalysis = false } = {}) {
  state.revision += 1;
  state.validated = false;
  state.validatedRevision = -1;
  state.validation = null;
  state.highlightedIssue = null;
  state.highlightedIssueLocation = 0;
  if (clearAnalysis) state.analysis = null;
  updateExportReadiness();
}

/**
 * The one path everything takes.
 *
 * Any control that changes the design calls this and nothing else. Having a
 * single rebuild is what stops the screen, the issue list and the export from
 * ever describing three different designs.
 */
let rebuildTimer = null;
function refresh({ immediate = false, reanalyse = true, rebuildSourceMask = true } = {}) {
  clearTimeout(rebuildTimer);
  const run = () => {
    rebuildTimer = null;
    if (state.selectedCandidateId) {
      state.selectedCandidateId = null;
      renderCandidates();
    }
    if (rebuildSourceMask) markAutomaticSupportsStale();
    if (rebuildSourceMask) rebuildSource();
    rebuildDesign();
    updateCandidateAvailability();
    // Any rebuild changes the exact geometry. Expensive support analysis may
    // be deferred during a brush stroke, but its old validation can never be
    // allowed to keep export unlocked.
    invalidateValidation({ clearAnalysis: !reanalyse });
    if (reanalyse) analyse();
    draw();
    updateReadouts();
    markDirty();
  };
  if (immediate) run(); else rebuildTimer = setTimeout(run, 120);
}

/* --------------------------------------------------------------- analysis */

function analyse() {
  if (!state.designMask) { state.analysis = null; renderIssues([]); return; }
  state.analysis = analyzeConnectivity(state.designMask, {
    anchorMask: state.frameMask,
    anchorBoundary: false,
  });
  updateConnectivityCard();
  renderIssues(issuesFromAnalysis());
}

function issuesFromAnalysis() {
  if (!state.analysis) return [];
  if (state.analysis.componentCount <= 1) return [];
  const ordered = state.analysis.components.slice().sort((a, b) => b.pixelCount - a.pixelCount || a.id - b.id);
  return ordered.slice(1).map((component, index) => ({
    severity: 'error',
    code: 'unsupported_component',
    message: `Unsupported piece ${index + 1} would fall out`,
    details: {
      phase: 'analysis',
      componentId: component.id,
      pixelCount: component.pixelCount,
      bounds: component.bounds,
    },
  }));
}

function updateConnectivityCard() {
  const card = el('connectivity-summary');
  const count = el('island-count');
  if (!card || !count) return;
  if (!state.analysis) {
    card.dataset.state = 'pending';
    count.textContent = 'Not analysed';
    return;
  }
  const separate = Math.max(0, state.analysis.componentCount - 1);
  card.dataset.state = separate === 0 ? 'ok' : 'warn';
  count.textContent = separate === 0
    ? 'Everything is one connected piece'
    : `${separate} unsupported ${separate === 1 ? 'piece' : 'pieces'}`;
}

function geometryForExport() {
  if (!state.designMask) return null;
  if (el('export-frame')?.checked !== false || !state.frameMask) return state.designMask;
  return {
    ...state.designMask,
    data: Uint8Array.from(state.designMask.data, (value, index) => (
      state.frameMask.data[index] === RETAINED ? REMOVED : value
    )),
  };
}

async function runValidation() {
  if (!state.designMask) { toast('Import an image first.'); return; }
  setSidePanel('issues');
  if (state.source && !state.offline && !hasFreshStyleMask()) {
    clearTimeout(styleTimer);
    styleTimer = null;
    toast('Finishing the high-quality render before validation…');
    const ready = await renderStyle();
    if (!ready || !hasFreshStyleMask()) return;
  }
  const validationMask = geometryForExport();
  state.validation = validateDesign(validationMask, {
    sheet: sheet(),
    kerfMm: toMm(numberField('kerf', 1.2)),
    minimumWebMm: toMm(numberField('min-web', 3)),
    minimumOpeningMm: toMm(numberField('min-opening', 2)),
    anchorBoundary: false,
    requireAnchored: false,
    requireSingleComponent: true,
  });
  state.validated = state.validation.valid;
  state.validatedRevision = state.revision;
  renderIssues(state.validation.issues ?? []);
  updateExportReadiness();
  draw();
  toast(state.validation.valid
    ? 'Checks passed. The panel holds together.'
    : 'Connectivity errors block export.');
}

/* ----------------------------------------------------------------- issues */

function renderIssues(issues) {
  if (state.highlightedIssue && !issues.includes(state.highlightedIssue)) {
    state.highlightedIssue = null;
    state.highlightedIssueLocation = 0;
  }
  state.issues = issues;
  const list = el('issue-list');
  if (!list) return;

  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.filter((issue) => issue.severity === 'warning').length;
  el('issue-total').textContent = String(issues.length);
  el('filter-count-all').textContent = String(issues.length);
  el('filter-count-error').textContent = String(errors);
  el('filter-count-warning').textContent = String(warnings);

  const health = el('health-summary');
  if (health) {
    const ring = health.querySelector('.health-ring span');
    const text = health.querySelector('div:last-child');
    if (!state.designMask) {
      health.dataset.state = 'idle';
      if (ring) ring.textContent = '—';
      if (text) text.innerHTML = '<strong>Waiting for artwork</strong><small>Connectivity and strength checks will appear here.</small>';
    } else if (errors > 0) {
      health.dataset.state = 'error';
      if (ring) ring.textContent = String(errors);
      if (text) text.innerHTML = `<strong>${errors} blocking ${errors === 1 ? 'issue' : 'issues'}</strong><small>Pieces would fall out of the panel.</small>`;
    } else if (warnings > 0) {
      health.dataset.state = 'warning';
      if (ring) ring.textContent = String(warnings);
      if (text) text.innerHTML = `<strong>${warnings} to review</strong><small>Thin or fragile, but it holds together.</small>`;
    } else {
      health.dataset.state = 'ok';
      if (ring) ring.textContent = '✓';
      if (text) text.innerHTML = '<strong>Ready to cut</strong><small>One connected piece, within the limits given.</small>';
    }
  }

  const shown = issues
    .map((issue, index) => ({ issue, index }))
    .filter(({ issue }) => state.issueFilter === 'all' || issue.severity === state.issueFilter);
  if (!shown.length) {
    list.innerHTML = `<li class="issues-empty" data-empty>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8h10M7 12h7M7 16h5"></path><rect x="4" y="3" width="16" height="18" rx="3"></rect></svg>
      <p><strong>${issues.length ? 'Nothing in this filter' : 'No issues found'}</strong><span>${
        issues.length ? 'Other severities are still listed.' : 'Run validation after changing the geometry.'
      }</span></p></li>`;
    return;
  }
  list.innerHTML = shown.map(({ issue, index }) => {
    const selectable = Boolean(issue.details?.bounds);
    const locationCount = issue.details?.locations?.length ?? 1;
    const locationLabel = issue === state.highlightedIssue && locationCount > 1
      ? `${state.highlightedIssueLocation + 1}/${locationCount} · Next`
      : 'Locate';
    return `
    <li class="issue-item${issue === state.highlightedIssue ? ' is-selected' : ''}" data-severity="${issue.severity}"
      data-issue-index="${index}" ${selectable ? `data-highlightable="true" role="button" tabindex="0" aria-pressed="${issue === state.highlightedIssue}"` : ''}>
      <i class="severity-dot ${issue.severity}"></i>
      <div><strong>${escapeHtml(issue.message || issue.code || 'Issue')}</strong>
      ${detailText(issue) ? `<small>${escapeHtml(detailText(issue))}</small>` : ''}</div>
      ${selectable ? `<span class="issue-locate" aria-hidden="true">${locationLabel}</span>` : ''}
    </li>`;
  }).join('');
}

/**
 * Issue details arrive as an object of measurements, not a sentence.
 *
 * Passing it through `String()` renders "[object Object]" -- technically a
 * string, and useless to the person deciding whether a 3.2 mm web is
 * acceptable. The numbers are the whole reason the detail exists.
 */
function detailText(issue) {
  const details = issue.details;
  if (!details) return '';
  if (typeof details === 'string') return details;
  return Object.entries(details)
    .filter(([key, value]) => key !== 'phase' && key !== 'componentId' &&
      value !== null && value !== undefined && typeof value !== 'object')
    .map(([key, value]) => {
      const label = key.replace(/Mm$/, ' mm').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
      return `${label}: ${typeof value === 'number' ? Math.round(value * 100) / 100 : value}`;
    })
    .join(' · ');
}

function activeIssueDetails(issue) {
  const details = issue?.details;
  const locations = details?.locations;
  if (!Array.isArray(locations) || locations.length === 0) return details;
  const location = locations[Math.min(state.highlightedIssueLocation, locations.length - 1)];
  return { ...details, ...location };
}

function focusIssue(issue) {
  const bounds = activeIssueDetails(issue)?.bounds;
  const viewport = el('canvas-viewport');
  if (!bounds || !viewport || !state.designMask) return;
  const availableWidth = Math.max(80, viewport.clientWidth - 120);
  const availableHeight = Math.max(80, viewport.clientHeight - 120);
  const fitted = Math.min(
    availableWidth / Math.max(1, bounds.width),
    availableHeight / Math.max(1, bounds.height),
    4,
  );
  state.zoom = Math.max(state.zoom, fitted);
  const centreX = (bounds.minX + bounds.maxX + 1) / 2;
  const centreY = (bounds.minY + bounds.maxY + 1) / 2;
  state.pan = {
    x: viewport.clientWidth / 2 - centreX * state.zoom,
    y: viewport.clientHeight / 2 - centreY * state.zoom,
  };
  applyTransform();
}

function toggleIssueHighlight(index) {
  const issue = state.issues[index];
  if (!issue?.details?.bounds) return;
  const locations = issue.details.locations;
  if (state.highlightedIssue === issue && Array.isArray(locations) && locations.length > 1) {
    state.highlightedIssueLocation = (state.highlightedIssueLocation + 1) % locations.length;
  } else if (state.highlightedIssue === issue) {
    state.highlightedIssue = null;
    state.highlightedIssueLocation = 0;
  } else {
    state.highlightedIssue = issue;
    state.highlightedIssueLocation = 0;
  }
  renderIssues(state.issues);
  if (state.highlightedIssue) {
    setSidePanel('issues');
    setView('issues');
    focusIssue(issue);
  } else {
    draw();
  }
}

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/* ---------------------------------------------------------------- drawing */

function draw() {
  const canvas = el('editor-canvas');
  const overlay = el('overlay-canvas');
  if (!canvas || !overlay) return;
  const mask = state.designMask;
  const stage = el('canvas-stage');
  if (stage) stage.dataset.view = state.view;
  el('empty-state')?.toggleAttribute('hidden', Boolean(mask));
  stage?.classList.toggle('has-design', Boolean(mask));
  if (!mask) {
    if (stage) { stage.style.width = ''; stage.style.height = ''; stage.style.transform = ''; }
    clear(canvas); clear(overlay); return;
  }

  if (canvas.width !== mask.width || canvas.height !== mask.height) {
    for (const c of [canvas, overlay]) { c.width = mask.width; c.height = mask.height; }
  }
  // The stage has the raster's intrinsic aspect ratio. Zooming scales both
  // axes equally, so a square in the source can never become a rectangle just
  // because the laptop workspace is wide.
  if (stage) {
    stage.style.width = `${mask.width}px`;
    stage.style.height = `${mask.height}px`;
  }

  const context = canvas.getContext('2d');
  if (state.view === 'original' && state.source?.previewCanvas && state.placement) {
    const currentSheet = sheet();
    context.fillStyle = '#e5e8e5';
    context.fillRect(0, 0, mask.width, mask.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    const preview = state.source.previewCanvas;
    const bounds = state.contentBounds;
    const sourceSize = state.contentSourceSize;
    const sourceX = bounds && sourceSize ? bounds.x / sourceSize.width * preview.width : 0;
    const sourceY = bounds && sourceSize ? bounds.y / sourceSize.height * preview.height : 0;
    const sourceWidth = bounds && sourceSize ? bounds.width / sourceSize.width * preview.width : preview.width;
    const sourceHeight = bounds && sourceSize ? bounds.height / sourceSize.height * preview.height : preview.height;
    context.drawImage(
      preview,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      state.placement.xMm / currentSheet.widthMm * mask.width,
      state.placement.yMm / currentSheet.heightMm * mask.height,
      state.placement.widthMm / currentSheet.widthMm * mask.width,
      state.placement.heightMm / currentSheet.heightMm * mask.height,
    );
    drawOverlay(overlay, mask);
    applyTransform();
    return;
  }
  const image = context.createImageData(mask.width, mask.height);
  const source = state.view === 'source' && state.sourceMask ? state.sourceMask : mask;
  // Kerf simulation shows what survives the cutter, which is the honest
  // preview of the finished part rather than the ideal geometry.
  const kerf = el('simulate-kerf')?.checked && state.kerfPreviewMask;
  const shown = (state.view === 'material' || state.view === 'backlit') && kerf
    ? state.kerfPreviewMask : source;

  const labels = state.view === 'issues' ? state.analysis?.labels : null;
  const disconnectedIds = new Set((state.analysis?.components ?? [])
    .slice()
    .sort((first, second) => second.pixelCount - first.pixelCount || first.id - second.id)
    .slice(1)
    .map((component) => component.id));
  const highlighted = activeIssueDetails(state.highlightedIssue);
  let highlightedLabels = null;
  if (highlighted?.phase === 'analysis') highlightedLabels = state.analysis?.labels;
  else if (highlighted?.phase === 'postKerf') highlightedLabels = state.validation?.postKerf?.labels;
  else if (highlighted?.phase === 'minimumWeb') highlightedLabels = state.validation?.minimumWebCore?.labels;
  else if (highlighted?.phase === 'opening') highlightedLabels = state.validation?.removed?.labels;
  else if (highlighted) highlightedLabels = state.validation?.initial?.labels;

  for (let index = 0; index < shown.data.length; index += 1) {
    const offset = index * 4;
    const metal = shown.data[index] === RETAINED;
    let r = state.view === 'backlit' ? 255 : 245;
    let g = state.view === 'backlit' ? 241 : 244;
    let b = state.view === 'backlit' ? 190 : 240;
    const isHighlighted = highlightedLabels &&
      highlightedLabels[index] === highlighted.componentId;
    if (isHighlighted) { r = 244; g = 127; b = 36; }
    else if (metal) {
      const unsupported = labels && disconnectedIds.has(labels[index]);
      if (unsupported) { r = 190; g = 72; b = 48; }
      else if (state.view === 'backlit') { r = 20; g = 28; b = 33; }
      else { r = 42; g = 46; b = 52; }
    }
    image.data[offset] = r; image.data[offset + 1] = g;
    image.data[offset + 2] = b; image.data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);

  drawOverlay(overlay, mask);
  applyTransform();
}

function drawOverlay(overlay, mask) {
  const context = overlay.getContext('2d');
  context.clearRect(0, 0, overlay.width, overlay.height);
  const { widthMm, heightMm } = sheet();
  const pxPerMm = mask.width / widthMm;

  if (el('show-grid')?.checked) {
    // A 50 mm grid: fine enough to judge a bridge, coarse enough not to become
    // the picture.
    context.strokeStyle = 'rgba(90, 96, 104, .18)';
    context.lineWidth = 1;
    for (let mm = 50; mm < widthMm; mm += 50) {
      const x = Math.round(mm * pxPerMm) + 0.5;
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, overlay.height); context.stroke();
    }
    for (let mm = 50; mm < heightMm; mm += 50) {
      const y = Math.round(mm * (mask.height / heightMm)) + 0.5;
      context.beginPath(); context.moveTo(0, y); context.lineTo(overlay.width, y); context.stroke();
    }
  }

  for (const bridge of state.bridges) {
    const selected = bridge === state.selectedBridge;
    const staleAutomatic = state.automaticSupportsStale && bridge.source === 'automatic';
    const fallbackAutomatic = bridge.source === 'automatic' && bridge.fallback === true;
    const stabilizer = bridge.stabilizer === true;
    const needsReview = staleAutomatic || fallbackAutomatic;
    context.strokeStyle = selected
      ? '#1f7a5a'
      : needsReview
        ? 'rgba(196, 126, 20, .8)'
        : stabilizer ? 'rgba(0, 143, 156, .72)' : 'rgba(31, 122, 90, .55)';
    context.lineWidth = Math.max(2, bridge.width * pxPerMm);
    context.lineCap = 'round';
    context.setLineDash(needsReview ? [Math.max(4, 8 / state.zoom), Math.max(3, 5 / state.zoom)] : []);
    context.beginPath();
    context.moveTo(bridge.start.x * pxPerMm, bridge.start.y * (mask.height / heightMm));
    context.lineTo(bridge.end.x * pxPerMm, bridge.end.y * (mask.height / heightMm));
    context.stroke();
    context.setLineDash([]);
  }

  if (state.bridgePreview) {
    context.strokeStyle = 'rgba(31, 122, 90, .82)';
    context.lineWidth = Math.max(2, state.bridgePreview.width * pxPerMm);
    context.lineCap = 'round';
    context.setLineDash([Math.max(5, 9 / state.zoom), Math.max(3, 5 / state.zoom)]);
    context.beginPath();
    context.moveTo(state.bridgePreview.start.x * pxPerMm, state.bridgePreview.start.y * (mask.height / heightMm));
    context.lineTo(state.bridgePreview.end.x * pxPerMm, state.bridgePreview.end.y * (mask.height / heightMm));
    context.stroke();
    context.setLineDash([]);
  }

  if (state.selectedBridge) {
    const radius = Math.max(3, 6 / Math.max(state.zoom, 0.1));
    context.fillStyle = '#f5f4f0';
    context.strokeStyle = '#1f7a5a';
    context.lineWidth = Math.max(1.5, 2 / Math.max(state.zoom, 0.1));
    for (const point of [state.selectedBridge.start, state.selectedBridge.end]) {
      context.beginPath();
      context.arc(point.x * pxPerMm, point.y * (mask.height / heightMm), radius, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
  }

  if (state.touchupPreview && (state.tool === 'keep' || state.tool === 'remove')) {
    const preview = state.touchupPreview;
    const yPerMm = mask.height / heightMm;
    const radiusMm = preview.diameterMm / 2;
    const color = state.tool === 'keep' ? 'rgba(31, 122, 90, .88)' : 'rgba(220, 93, 48, .88)';
    context.strokeStyle = color;
    context.fillStyle = state.tool === 'keep' ? 'rgba(31, 122, 90, .16)' : 'rgba(220, 93, 48, .16)';
    context.lineWidth = Math.max(1.5, 2 / Math.max(state.zoom, 0.1));
    if (preview.mode === 'straight' && preview.start && preview.end) {
      context.lineWidth = Math.max(2, preview.diameterMm * pxPerMm);
      context.lineCap = 'round';
      context.globalAlpha = 0.58;
      context.beginPath();
      context.moveTo(preview.start.x, preview.start.y);
      context.lineTo(preview.end.x, preview.end.y);
      context.stroke();
      context.globalAlpha = 1;
    } else if (preview.point) {
      context.beginPath();
      context.ellipse(
        preview.point.x,
        preview.point.y,
        Math.max(2, radiusMm * pxPerMm),
        Math.max(2, radiusMm * yPerMm),
        0, 0, Math.PI * 2,
      );
      context.fill();
      context.stroke();
    }
  }

  const activeDetails = activeIssueDetails(state.highlightedIssue);
  const bounds = activeDetails?.bounds;
  if (bounds) {
    const padding = Math.max(3, 6 / Math.max(state.zoom, 0.1));
    context.strokeStyle = '#f47f24';
    context.lineWidth = Math.max(2, 3 / Math.max(state.zoom, 0.1));
    context.setLineDash([Math.max(4, 8 / state.zoom), Math.max(3, 5 / state.zoom)]);
    context.strokeRect(
      Math.max(0, bounds.minX - padding),
      Math.max(0, bounds.minY - padding),
      Math.min(mask.width - bounds.minX, bounds.width + padding * 2),
      Math.min(mask.height - bounds.minY, bounds.height + padding * 2),
    );
    context.setLineDash([]);
    if (Array.isArray(activeDetails.points) && activeDetails.points.length === 2) {
      const points = activeDetails.points.map((point) => ({ x: point.x + 0.5, y: point.y + 0.5 }));
      context.strokeStyle = '#f47f24';
      context.fillStyle = '#f47f24';
      context.lineWidth = Math.max(2, 3 / Math.max(state.zoom, 0.1));
      context.beginPath();
      context.moveTo(points[0].x, points[0].y);
      context.lineTo(points[1].x, points[1].y);
      context.stroke();
      for (const point of points) {
        context.beginPath();
        context.arc(point.x, point.y, Math.max(2, 4 / Math.max(state.zoom, 0.1)), 0, Math.PI * 2);
        context.fill();
      }
    }
  }
}

function clear(canvas) {
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

function applyTransform() {
  const stage = el('canvas-stage');
  if (!stage) return;
  stage.style.transformOrigin = '0 0';
  stage.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  el('zoom-value').textContent = `${Math.round(state.zoom * 100)}%`;
  const bar = el('scale-readout')?.querySelector('span');
  const label = el('scale-readout')?.querySelector('small');
  if (bar && label && state.designMask) {
    const physicalMm = state.unit === 'in' ? 4 * MM_PER_INCH : 100;
    const pixels = physicalMm / sheet().widthMm * state.designMask.width * state.zoom;
    bar.style.width = `${Math.max(12, pixels)}px`;
    label.textContent = state.unit === 'in' ? '4 in' : '100 mm';
  }
}

function fitToView() {
  const viewport = el('canvas-viewport');
  const canvas = el('editor-canvas');
  if (!viewport || !canvas || !state.designMask) return;
  const margin = 48;
  const scale = Math.min(
    (viewport.clientWidth - margin) / canvas.width,
    (viewport.clientHeight - margin) / canvas.height,
  );
  state.zoom = Math.max(0.05, Math.min(scale, 8));
  state.pan = {
    x: (viewport.clientWidth - canvas.width * state.zoom) / 2,
    y: (viewport.clientHeight - canvas.height * state.zoom) / 2,
  };
  applyTransform();
}

function zoomAt(requestedZoom, anchor = null) {
  const viewport = el('canvas-viewport');
  if (!viewport || !state.designMask) return;
  const point = anchor ?? {
    x: viewport.clientWidth / 2,
    y: viewport.clientHeight / 2,
  };
  const next = zoomAroundPoint(
    { zoom: state.zoom, pan: state.pan },
    point,
    requestedZoom,
    { minimum: 0.05, maximum: 8 },
  );
  state.zoom = next.zoom;
  state.pan = next.pan;
  applyTransform();
}

/* -------------------------------------------------------------- readouts */

function updateReadouts() {
  const { widthMm, heightMm } = sheet();
  const label = state.unit === 'in'
    ? `${roundUnit(fromMm(widthMm))} × ${roundUnit(fromMm(heightMm))} in`
    : `${Math.round(widthMm)} × ${Math.round(heightMm)} mm`;
  el('panel-scale-status').textContent = label;
  el('export-size').textContent = label;
  const exportUnit = el('export-units')?.value === 'in' ? 'in' : 'mm';
  const exportSize = exportUnit === 'in'
    ? `${Math.round(widthMm / MM_PER_INCH * 1000) / 1000} × ${Math.round(heightMm / MM_PER_INCH * 1000) / 1000} in`
    : `${Math.round(widthMm * 10) / 10} × ${Math.round(heightMm * 10) / 10} mm`;
  el('export-size').textContent = exportSize;
  if (el('export-unit-scale')) el('export-unit-scale').textContent = `1 drawing unit = 1 ${exportUnit}`;
  for (const node of all('[data-unit-label]')) node.textContent = state.unit;
  const webNote = el('prekerf-web-note');
  if (webNote) {
    const finished = toMm(numberField('min-web', 3));
    const kerf = toMm(numberField('kerf', 1.2));
    webNote.textContent = `Filters generate at least ${roundUnit(fromMm(finished + kerf))} ${state.unit} before cutting so ${roundUnit(fromMm(finished))} ${state.unit} remains after the ${roundUnit(fromMm(kerf))} ${state.unit} kerf.`;
  }
}

function reflectPanelOrientation(preferred = null) {
  const { widthMm, heightMm } = sheet();
  const orientation = widthMm > heightMm
    ? 'landscape'
    : widthMm < heightMm
      ? 'portrait'
      : preferred || document.querySelector('input[name="panelOrientation"]:checked')?.value || 'portrait';
  const node = document.querySelector(`input[name="panelOrientation"][value="${orientation}"]`);
  if (node) node.checked = true;
}

function updateExportReadiness() {
  const card = el('export-readiness');
  const ready = state.validated && state.validatedRevision === state.revision && state.designMask;
  if (card) {
    card.dataset.state = ready ? 'ready' : 'blocked';
    card.querySelector('span').innerHTML = ready
      ? '<strong>Ready to export</strong><small>Checks passed for the current geometry.</small>'
      : '<strong>Validation required</strong><small>Run all checks before exporting geometry.</small>';
  }
  for (const id of ['btn-export-svg', 'btn-export-dxf']) el(id)?.toggleAttribute('disabled', !ready);
  all('[data-next-stage="export"]').forEach((button) => button.toggleAttribute('disabled', !ready));
}

/* ---------------------------------------------------------------- history */

function snapshot() {
  rememberStyleSettings();
  return JSON.stringify({
    controls: readControls(),
    styleSettings: cloneStyleSettings(state.styleSettings),
    bridges: state.bridges,
    painted: { keep: [...state.painted.keep], remove: [...state.painted.remove] },
    automaticSupportsStale: state.automaticSupportsStale,
  });
}

function readControls() {
  const values = {};
  const nodes = all('#app input, #app select');
  const groupedCheckboxes = new Set(nodes
    .filter((node) => node.type === 'checkbox' && node.name &&
      nodes.filter((other) => other.type === 'checkbox' && other.name === node.name).length > 1)
    .map((node) => node.name));
  for (const name of groupedCheckboxes) {
    values[name] = nodes
      .filter((node) => node.type === 'checkbox' && node.name === name && node.checked)
      .map((node) => node.value);
  }
  for (const node of nodes) {
    if (node.closest('#candidate-side-panel')) continue;
    if (node.id === 'project-name' || node.id === 'selected-bridge-width') continue;
    if (node.type === 'file' || node.type === 'button' || node.type === 'submit') continue;
    if (!node.id && !node.name) continue;
    if (node.type === 'radio') {
      if (node.checked) values[node.name] = node.value;
      continue;
    }
    if (node.type === 'checkbox' && groupedCheckboxes.has(node.name)) continue;
    const key = node.id || node.name;
    values[key] = node.type === 'checkbox' ? node.checked : node.value;
  }
  return values;
}

function applyControls(controls = {}) {
  // Version 1 shipped with a 35 mm artwork margin. That old default made the
  // visible artwork look undersized even after its empty source border had
  // been trimmed. Migrate only that legacy value; other user-selected margins
  // remain untouched. The hidden version marker makes this a one-time change.
  const migratedControls = { ...controls };
  if (!Object.hasOwn(controls, 'placement-fit-version') &&
      Number(controls['panel-margin']) === 35) {
    migratedControls['panel-margin'] = '0';
  }
  migratedControls['placement-fit-version'] = '2';
  if (!Object.hasOwn(controls, 'style-slat-angle') &&
      Object.hasOwn(controls, 'style-horizontal')) {
    migratedControls['style-slat-angle'] = controls['style-horizontal'] === true ? '0' : '90';
  }
  if (!Object.hasOwn(controls, 'slats-default-version')) {
    if (Number(controls['style-pitch']) === 8) migratedControls['style-pitch'] = '38';
    const untouchedLegacyRecipe = controls.cutStyle === 'lamele' &&
      Number(controls['style-gain']) === 2.2 &&
      Number(controls['style-smooth']) === 0.55 &&
      Number(controls['style-curve']) === 1.4 &&
      controls['style-cutout'] === false &&
      controls['style-clothes'] !== false &&
      controls.polarity !== 'white-retained';
    if (untouchedLegacyRecipe) {
      Object.assign(migratedControls, STYLE_DEFAULT_SETTINGS.lamele);
    }
  }
  migratedControls['slats-default-version'] = '2';
  const stabilizerVersion = Number(controls['stabilizer-version'] ?? 0);
  if (stabilizerVersion < 1) {
    migratedControls['stabilize-slats'] = true;
    if (!Object.hasOwn(controls, 'max-cantilever') || Number(controls['max-cantilever']) === 120) {
      migratedControls['max-cantilever'] = '250';
    }
  }
  if (stabilizerVersion < 2 && !Object.hasOwn(controls, 'stabilizer-organic')) {
    migratedControls['stabilizer-organic'] = '75';
  }
  migratedControls['stabilizer-version'] = '2';

  for (const [key, value] of Object.entries(migratedControls)) {
    const named = [...document.getElementsByName(key)];
    if (named.length && named[0].type === 'radio') {
      for (const node of named) node.checked = node.value === value;
      continue;
    }
    if (named.length && named[0].type === 'checkbox' && Array.isArray(value)) {
      for (const node of named) node.checked = value.includes(node.value);
      continue;
    }
    const node = el(key) || named[0];
    if (!node) continue;
    if (node.type === 'checkbox') node.checked = value === true;
    else node.value = value;
  }
  // Before cut styles were unified, line art lived in a separate input-mode
  // switch while an unrelated (hidden) photo style remained selected. Honour
  // that old switch when reopening those projects.
  if (controls.inputMode === 'line-art') {
    const lineArt = document.querySelector('input[name="cutStyle"][value="line-art"]');
    if (lineArt) lineArt.checked = true;
  }
  state.unit = el('measurement-unit')?.value === 'in' ? 'in' : 'mm';
  reflectPanelOrientation();
  enforcePlasmaLimits();
  state.mode = document.querySelector('input[name="cutStyle"]:checked')?.value === 'line-art'
    ? 'line-art' : 'photo';
  state.activeStyle = selectedCutStyle();
  rememberStyleSettings(state.activeStyle);
  reflectModeControls();
}

function restore(serialised) {
  const data = JSON.parse(serialised);
  const previousStyle = selectedCutStyle();
  const automaticSupportsStale = data.automaticSupportsStale === true;
  state.styleSettings = cloneStyleSettings(data.styleSettings);
  applyControls(data.controls);
  state.bridges = cloneBridges(data.bridges);
  state.painted = { keep: new Set(data.painted.keep), remove: new Set(data.painted.remove) };
  state.selectedBridge = null;
  if (state.source) {
    invalidateStyleRender({
      useLocalPreview: state.mode === 'line-art' || previousStyle !== selectedCutStyle(),
    });
  }
  refresh({ immediate: true });
  state.automaticSupportsStale = automaticSupportsStale;
  updateAutomaticSupportState();
  if (state.source && !state.offline) void renderStyle();
}

let lastSnapshot = null;
function resetHistory() {
  state.undo = [];
  state.redo = [];
  lastSnapshot = null;
  updateHistoryButtons();
}

function pushHistory() {
  const now = snapshot();
  if (now === lastSnapshot) return;
  if (lastSnapshot !== null) {
    state.undo.push(lastSnapshot);
    if (state.undo.length > UNDO_DEPTH) state.undo.shift();
    state.redo.length = 0;
  }
  lastSnapshot = now;
  updateHistoryButtons();
}

function updateHistoryButtons() {
  el('btn-undo')?.toggleAttribute('disabled', state.undo.length === 0);
  el('btn-redo')?.toggleAttribute('disabled', state.redo.length === 0);
}

function undo() {
  if (!state.undo.length) return;
  state.redo.push(snapshot());
  lastSnapshot = state.undo.pop();
  restore(lastSnapshot);
  updateHistoryButtons();
}

function redo() {
  if (!state.redo.length) return;
  state.undo.push(snapshot());
  lastSnapshot = state.redo.pop();
  restore(lastSnapshot);
  updateHistoryButtons();
}

/* ------------------------------------------------------------- persistence */

function markDirty() {
  if (!state.source && !state.baseMask && !state.sourceMask) return;
  state.dirty = true;
  const badge = el('save-state');
  if (badge) { badge.textContent = 'Unsaved'; badge.dataset.state = 'dirty'; }
  scheduleSave();
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 1200);
}

function projectFromState() {
  rememberStyleSettings();
  const threshold = Math.round((numberField('threshold', 50) / 100) * 255);
  const sourceWidth = state.source?.width ?? state.baseMask?.width ?? null;
  const sourceHeight = state.source?.height ?? state.baseMask?.height ?? null;
  return createProject({
    id: state.projectId,
    name: state.name,
    sheet: sheet(),
    conversion: {
      mode: state.mode === 'photo' ? 'photograph' : 'line-art',
      threshold,
      invert: document.querySelector('input[name="polarity"]:checked')?.value === 'white-retained',
      backgroundLuminance: 255,
    },
    frame: frameConfig(),
    manufacturing: {
      kerfMm: toMm(numberField('kerf', 1.2)),
      minimumWebMm: toMm(numberField('min-web', 3)),
      minimumOpeningMm: toMm(numberField('min-opening', 2)),
      maximumCantileverMm: null,
    },
    structure: { mode: 'single-sheet' },
    source: {
      kind: state.baseMask ? 'image' : 'none',
      name: state.source?.name ?? null,
      mimeType: state.source?.file?.type ?? null,
      widthPx: sourceWidth,
      heightPx: sourceHeight,
      imageDataUrl: null,
    },
    raster: {
      sourceMask: state.sourceMask ? encodeMask(state.sourceMask) : null,
      baseMask: state.baseMask ? encodeMask(state.baseMask) : null,
    },
    bridges: state.bridges,
    editor: {
      controls: readControls(),
      styleSettings: cloneStyleSettings(state.styleSettings),
      painted: { keep: [...state.painted.keep], remove: [...state.painted.remove] },
      candidates: state.candidates,
      selectedCandidateId: state.selectedCandidateId,
      automaticSupportsStale: state.automaticSupportsStale,
    },
    createdAt: state.createdAt,
  });
}

async function persist() {
  saveTimer = null;
  if (!state.sourceMask) return;
  try {
    // The original image is kept as a browser-local Blob so an automatic PWA
    // refresh does not turn an editable photograph into frozen geometry. It is
    // deliberately outside the portable project schema: project downloads do
    // not contain the private photograph, and nothing sends it to the web app.
    const record = {
      ...projectFromState(),
      localSource: state.source?.file ?? null,
    };
    const saved = await saveProject(record);
    state.projectId = saved.id;
    state.createdAt = saved.createdAt;
    state.dirty = false;
    const badge = el('save-state');
    if (badge) { badge.textContent = 'Saved'; badge.dataset.state = 'saved'; }
  } catch (error) {
    console.error(error);
    toast('Could not save locally.');
  }
}

/* ----------------------------------------------------------------- import */

function setSourceRecipeAvailability(available) {
  for (const node of all('#polarity input, #style-controls input, #style-controls button')) {
    node.disabled = !available;
  }
  if (available) reflectModeControls();
  if (!available) setStyleStatus('Processed geometry restored. Re-import the photograph to re-render its style.');
}

function applyCanonicalProjectControls(project) {
  el('measurement-unit').value = 'mm';
  state.unit = 'mm';
  el('panel-width').value = project.sheet.widthMm;
  el('panel-height').value = project.sheet.heightMm;
  reflectPanelOrientation();
  const frameWidth = typeof project.frame.thicknessMm === 'number'
    ? project.frame.thicknessMm
    : project.frame.thicknessMm.top;
  el('frame-width').value = project.frame.enabled ? frameWidth : 0;
  for (const node of all('input[name="anchorEdge"]')) node.checked = project.frame.sides[node.value] !== false;
  const modeValue = project.conversion.mode === 'photograph' ? 'photo' : 'line-art';
  const styleValue = modeValue === 'line-art' ? 'line-art' : 'sablon';
  const modeNode = document.querySelector(`input[name="cutStyle"][value="${styleValue}"]`);
  if (modeNode) modeNode.checked = true;
  state.mode = modeValue;
  const polarity = project.conversion.invert ? 'white-retained' : 'black-retained';
  const polarityNode = document.querySelector(`input[name="polarity"][value="${polarity}"]`);
  if (polarityNode) polarityNode.checked = true;
  el('threshold').value = Math.round(project.conversion.threshold / 255 * 100);
  el('kerf').value = project.manufacturing.kerfMm;
  el('min-web').value = project.manufacturing.minimumWebMm;
  el('min-opening').value = project.manufacturing.minimumOpeningMm ?? 2;
  enforcePlasmaLimits();
  reflectModeControls();
}

async function decodeSourceFile(file, fallbackName = 'Source image') {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, RASTER_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0, width, height);
  const decoded = {
    file,
    imageData: context.getImageData(0, 0, width, height),
    previewCanvas: canvas,
    width,
    height,
    originalWidth: bitmap.width,
    originalHeight: bitmap.height,
    name: file.name || fallbackName,
    bytes: file.size,
  };
  bitmap.close?.();
  return decoded;
}

async function loadProjectState(project, { imported = false } = {}) {
  state.styleSettings = cloneStyleSettings(project.editor?.styleSettings);
  applyCanonicalProjectControls(project);
  if (project.editor?.controls) applyControls(project.editor.controls);
  else {
    state.activeStyle = selectedCutStyle();
    rememberStyleSettings(state.activeStyle);
  }
  state.projectId = imported ? null : project.id;
  state.createdAt = imported ? null : project.createdAt;
  state.name = project.name || 'Untitled panel';
  el('project-name').value = state.name;
  state.source = null;
  state.styleMask = null;
  state.styleMaskFor = null;
  state.styleMaskFresh = false;
  state.contentBounds = null;
  state.contentSourceSize = null;
  state.baseMask = project.raster?.baseMask
    ? decodeMask(project.raster.baseMask)
    : null;
  state.sourceMask = project.raster?.sourceMask
    ? decodeMask(project.raster.sourceMask)
    : null;
  if (project.localSource instanceof Blob && project.localSource.size > 0) {
    try {
      state.source = await decodeSourceFile(project.localSource, project.source?.name || 'Source image');
      if (state.mode === 'photo' && state.baseMask) {
        state.styleMask = { ...state.baseMask, data: Uint8Array.from(state.baseMask.data) };
        state.styleMaskFor = selectedCutStyle();
        state.styleMaskFresh = true;
      }
    } catch (error) {
      console.error('Could not restore the browser-local source image:', error);
      state.source = null;
    }
  }
  // Legacy projects contain only the already-placed mask. Keep it exact; new
  // projects also carry baseMask and can be re-placed when panel dimensions change.
  state.bridges = cloneBridges(project.bridges ?? []);
  state.automaticSupportsStale = project.editor?.automaticSupportsStale === true;
  state.candidates = project.editor?.candidates ?? [];
  state.selectedCandidateId = project.editor?.selectedCandidateId ?? null;
  state.painted = {
    keep: new Set(project.editor?.painted?.keep ?? []),
    remove: new Set(project.editor?.painted?.remove ?? []),
  };
  state.paintedFor = state.sourceMask ? `${state.sourceMask.width}x${state.sourceMask.height}` : null;
  state.selectedBridge = null;
  state.validation = null;
  reflectModeControls();
  setSourceRecipeAvailability(Boolean(state.source));

  el('drop-zone').dataset.state = state.sourceMask ? 'filled' : 'empty';
  el('source-file').hidden = !state.sourceMask;
  if (state.source) {
    el('source-preview').src = URL.createObjectURL(state.source.file);
    el('source-preview').hidden = false;
  } else {
    el('source-preview').hidden = true;
  }
  el('source-name').textContent = project.source?.name || 'Restored processed artwork';
  el('source-meta').textContent = state.source
    ? `${state.source.originalWidth} × ${state.source.originalHeight} · restored from this browser`
    : 'Processed geometry · re-import the photograph to change its style';
  if (state.baseMask) rebuildSource();
  rebuildDesign();
  invalidateValidation();
  analyse();
  draw();
  fitToView();
  updateRangeOutputs();
  updateReadouts();
  updateViewAvailability();
  updateAutomaticSupportState();
  renderCandidates();
  selectBridge(null);
  resetHistory();
  if (state.source && state.mode === 'line-art' && !state.offline) void renderStyle();
}

async function importProjectFile(file) {
  try {
    const project = deserializeProject(await file.text());
    await loadProjectState(project, { imported: true });
    pushHistory();
    markDirty();
    toast('Editable Stencil project opened as a new local copy.');
  } catch (error) {
    console.error(error);
    toast('That Stencil project could not be read.');
  }
}

async function importFile(file) {
  if (!file) return;
  if (file.name.toLowerCase().endsWith('.stencil.json') || file.type === 'application/json') {
    await importProjectFile(file);
    return;
  }
  if (!file.type.startsWith('image/')) { toast('That file is not an image.'); return; }
  if (file.size > 30 * 1024 * 1024) { toast('Images must be 30 MB or smaller.'); return; }
  try {
    state.source = await decodeSourceFile(file, file.name);
    state.projectId = null;
    state.createdAt = null;
    state.baseMask = null;
    state.styleMask = null;
    state.styleMaskFor = null;
    state.styleMaskFresh = false;
    state.contentBounds = null;
    state.contentSourceSize = null;
    state.painted = { keep: new Set(), remove: new Set() };
    state.paintedFor = null;
    state.bridges = [];
    state.automaticSupportsStale = false;
    state.candidates = [];
    state.selectedCandidateId = null;
    state.selectedBridge = null;
    state.validation = null;
    resetHistory();
    setSourceRecipeAvailability(true);
    updateViewAvailability();
    updateAutomaticSupportState();
    renderCandidates();

    el('drop-zone').dataset.state = 'filled';
    el('source-file').hidden = false;
    el('source-preview').src = URL.createObjectURL(file);
    el('source-preview').hidden = false;
    el('source-name').textContent = file.name;
    el('source-meta').textContent = `${state.source.originalWidth} × ${state.source.originalHeight} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;

    if (el('fit-artwork')?.checked && el('btn-link-dimensions')?.getAttribute('aria-pressed') === 'true') {
      // The panel takes the picture's proportions, so the artwork is not
      // stretched before anyone has said anything about size.
      const widthMm = toMm(numberField('panel-width', 1250));
      el('panel-height').value = roundUnit(fromMm(widthMm * (state.source.originalHeight / state.source.originalWidth)));
    }

    if (state.mode === 'photo') {
      await renderStyle();
    } else {
      refresh({ immediate: true });
      fitToView();
      pushHistory();
      void renderStyle();
    }
    setStage('prepare');
    toast(state.mode === 'photo'
      ? 'Image imported. Rendering the style…'
      : state.offline
        ? 'Image imported. Using the offline line-art renderer.'
        : 'Image imported. Preview ready; refining it at full quality…');
  } catch (error) {
    console.error(error);
    toast('That image could not be read.');
  }
}

/* ------------------------------------------------ creative candidates */

const CUT_STYLE_NAMES = {
  'line-art': 'Line art',
  sablon: 'Poster stencil',
  icoana: 'Icon stencil',
  grafic: 'Graphic portrait',
  linii: 'Negative-space linework',
  gravura: 'Icon / Woodcut',
  silueta: 'Silhouette',
  contururi: 'Contour bands',
  raze: 'Radial cuts',
  ornament: 'Ornamental symmetry',
  lamele: 'Slats',
  hasura: 'Hatch',
};

function cloneBridges(bridges = state.bridges) {
  return bridges.map((bridge) => ({
    ...bridge,
    width: Math.max(PLASMA_MIN_WEB_MM, Number(bridge.width) || PLASMA_MIN_WEB_MM),
    start: { ...bridge.start },
    end: { ...bridge.end },
  }));
}

function maskThumbnail(mask) {
  if (!mask) return null;
  const maximumWidth = 260;
  const maximumHeight = 150;
  const scale = Math.min(maximumWidth / mask.width, maximumHeight / mask.height, 1);
  const width = Math.max(1, Math.round(mask.width * scale));
  const height = Math.max(1, Math.round(mask.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  const image = context.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(mask.height - 1, Math.floor(y / height * mask.height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(mask.width - 1, Math.floor(x / width * mask.width));
      const metal = mask.data[sourceY * mask.width + sourceX] === RETAINED;
      const offset = (y * width + x) * 4;
      const value = metal ? 42 : 245;
      image.data[offset] = value;
      image.data[offset + 1] = metal ? 46 : 244;
      image.data[offset + 2] = metal ? 52 : 240;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

function candidateName(style) {
  const label = CUT_STYLE_NAMES[style] || 'Candidate';
  const count = state.candidates.filter((candidate) => candidate.controls?.cutStyle === style).length;
  return `${label} ${count + 1}`;
}

async function saveCurrentCandidate() {
  if (!state.baseMask || !state.designMask) { toast('Import and render artwork first.'); return; }
  if (state.candidates.length >= CANDIDATE_LIMIT) {
    toast(`Keep up to ${CANDIDATE_LIMIT} candidates. Delete one before saving another.`);
    return;
  }
  if (state.source && !state.offline && !hasFreshStyleMask()) {
    clearTimeout(styleTimer);
    styleTimer = null;
    toast('Finishing the high-quality render before saving this candidate…');
    if (!await renderStyle()) return;
  }

  const style = selectedCutStyle();
  const candidate = {
    id: crypto.randomUUID(),
    name: candidateName(style),
    createdAt: new Date().toISOString(),
    controls: readControls(),
    baseMask: encodeMask(state.baseMask),
    painted: { keep: [...state.painted.keep], remove: [...state.painted.remove] },
    bridges: cloneBridges(),
    thumbnail: maskThumbnail(state.designMask),
    automaticSupportsStale: state.automaticSupportsStale,
  };
  state.candidates.push(candidate);
  state.selectedCandidateId = candidate.id;
  renderCandidates();
  markDirty();
  await persist();
  setSidePanel('candidates');
  toast(`${candidate.name} saved on this device.`);
}

function restoreCandidate(id) {
  const candidate = state.candidates.find((item) => item.id === id);
  if (!candidate?.baseMask) { toast('This candidate has no processed artwork.'); return; }
  clearTimeout(styleTimer);
  styleTimer = null;
  styleToken += 1;
  styleAbort?.abort();
  styleAbort = null;
  state.styleBusy = false;
  setRenderProgress();

  rememberStyleSettings();
  applyControls(candidate.controls);
  state.baseMask = decodeMask(candidate.baseMask);
  state.sourceMask = null;
  if (state.source) {
    state.styleMask = { ...state.baseMask, data: Uint8Array.from(state.baseMask.data) };
    state.styleMaskFor = selectedCutStyle();
    state.styleMaskFresh = true;
  } else {
    state.styleMask = null;
    state.styleMaskFor = null;
    state.styleMaskFresh = false;
  }
  state.painted = {
    keep: new Set(candidate.painted?.keep ?? []),
    remove: new Set(candidate.painted?.remove ?? []),
  };
  state.paintedFor = null;
  state.bridges = cloneBridges(candidate.bridges ?? []);
  state.selectedBridge = null;
  state.automaticSupportsStale = candidate.automaticSupportsStale === true;
  refresh({ immediate: true });
  state.selectedCandidateId = candidate.id;
  state.automaticSupportsStale = candidate.automaticSupportsStale === true;
  updateRangeOutputs();
  updateReadouts();
  updateAutomaticSupportState();
  renderCandidates();
  setStyleStatus(`${candidate.name} restored from saved processed geometry.`);
  setView('material');
  setStage('prepare');
  fitToView();
  pushHistory();
  toast(`${candidate.name} restored. You can continue editing it.`);
}

function duplicateCandidate(id) {
  if (state.candidates.length >= CANDIDATE_LIMIT) {
    toast(`Keep up to ${CANDIDATE_LIMIT} candidates. Delete one before duplicating.`);
    return;
  }
  const candidate = state.candidates.find((item) => item.id === id);
  if (!candidate) return;
  const copy = JSON.parse(JSON.stringify(candidate));
  copy.id = crypto.randomUUID();
  copy.name = `${candidate.name} copy`;
  copy.createdAt = new Date().toISOString();
  state.candidates.push(copy);
  state.selectedCandidateId = copy.id;
  renderCandidates();
  markDirty();
  toast(`${copy.name} created.`);
}

async function deleteCandidate(id) {
  const candidate = state.candidates.find((item) => item.id === id);
  if (!candidate) return;
  if (!await confirmAction('Delete this candidate?', `${candidate.name} will be removed from this project.`, 'Delete')) return;
  state.candidates = state.candidates.filter((item) => item.id !== id);
  if (state.selectedCandidateId === id) state.selectedCandidateId = null;
  renderCandidates();
  markDirty();
}

function renderCandidates() {
  const list = el('candidate-list');
  updateCandidateAvailability();
  const total = el('candidate-total');
  if (total) {
    total.textContent = String(state.candidates.length);
    total.setAttribute('aria-label', `${state.candidates.length} saved ${state.candidates.length === 1 ? 'candidate' : 'candidates'}`);
  }
  if (!list) return;
  if (!state.candidates.length) {
    list.innerHTML = '<li class="candidate-empty"><strong>No candidates yet</strong><span>Tune the artwork, then save a version you may want to return to.</span></li>';
    return;
  }
  list.innerHTML = state.candidates.slice().reverse().map((candidate) => {
    const style = CUT_STYLE_NAMES[candidate.controls?.cutStyle] || 'Processed artwork';
    const thumbnail = /^data:image\/png;base64,[a-z0-9+/=]+$/i.test(candidate.thumbnail || '')
      ? candidate.thumbnail : null;
    const savedAt = candidate.createdAt ? new Date(candidate.createdAt) : null;
    const when = savedAt && Number.isFinite(savedAt.getTime())
      ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(savedAt)
      : 'Saved candidate';
    return `<li class="candidate-item${candidate.id === state.selectedCandidateId ? ' is-selected' : ''}" data-candidate-id="${escapeAttribute(candidate.id)}">
      <button class="candidate-restore" type="button" data-candidate-action="restore" aria-label="Restore ${escapeAttribute(candidate.name)}">
        ${thumbnail ? `<img src="${escapeAttribute(thumbnail)}" alt="">` : ''}
      </button>
      <div class="candidate-body">
        <input class="candidate-name" value="${escapeAttribute(candidate.name)}" maxlength="60" aria-label="Candidate name">
        <small class="candidate-meta">${escapeHtml(style)} · ${escapeHtml(when)}${candidate.automaticSupportsStale ? ' · supports need review' : ''}</small>
        <div class="candidate-actions">
          <button class="candidate-action" type="button" data-candidate-action="restore">Restore</button>
          <button class="candidate-action" type="button" data-candidate-action="duplicate">Duplicate</button>
          <button class="candidate-action" type="button" data-candidate-action="delete">Delete</button>
        </div>
      </div>
    </li>`;
  }).join('');
}

function updateCandidateAvailability() {
  const button = el('btn-save-candidate');
  if (button) button.disabled = !state.designMask || state.candidates.length >= CANDIDATE_LIMIT;
}

const escapeAttribute = (value) => escapeHtml(value)
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/* ---------------------------------------------------------------- bridges */

function automaticSupportCount() {
  return state.bridges.filter((bridge) => bridge.source === 'automatic').length;
}

function markAutomaticSupportsStale() {
  if (!automaticSupportCount() || state.automaticSupportsStale) return;
  state.automaticSupportsStale = true;
  updateAutomaticSupportState();
}

function updateAutomaticSupportState() {
  const count = automaticSupportCount();
  if (count === 0) state.automaticSupportsStale = false;
  const stale = count > 0 && state.automaticSupportsStale;
  el('automatic-support-stale')?.toggleAttribute('hidden', !stale);
  const action = el('automatic-support-action');
  if (action) action.textContent = stale
    ? 'Update smart supports'
    : count ? 'Recalculate smart supports' : 'Suggest smart bridges';
  el('btn-clear-auto-bridges')?.toggleAttribute('disabled', count === 0);
  const counter = el('automatic-support-count');
  if (counter) counter.textContent = count ? String(count) : '';
}

function sourcePointOnSheet(normalizedX, normalizedY) {
  const placement = state.placement;
  const bounds = state.contentBounds;
  const sourceSize = state.contentSourceSize;
  if (!placement || !bounds || !sourceSize) return null;
  const sourceX = normalizedX * Math.max(0, sourceSize.width - 1);
  const sourceY = normalizedY * Math.max(0, sourceSize.height - 1);
  return {
    x: placement.xMm + (sourceX - bounds.x) / Math.max(1, bounds.width) * placement.widthMm,
    y: placement.yMm + (sourceY - bounds.y) / Math.max(1, bounds.height) * placement.heightMm,
  };
}

/**
 * Server filters express pitch in the pre-crop physical artwork. Fitting the
 * visible crop to the panel can enlarge it again, so structural planning must
 * use the pitch that is actually visible on the final sheet.
 */
function placedStyleScale() {
  const bounds = state.contentBounds;
  const sourceSize = state.contentSourceSize;
  if (!state.source || !state.placement || !bounds || !sourceSize) return 1;
  const rendered = calculateArtworkPlacement(
    { width: state.source.width, height: state.source.height },
    sheet(),
    {
      frame: frameConfig(),
      marginMm: toMm(numberField('panel-margin', 0)),
      fitToFrame: el('fit-artwork')?.checked !== false,
    },
  );
  const croppedWidthMm = rendered.widthMm * bounds.width / Math.max(1, sourceSize.width);
  if (!(croppedWidthMm > 0)) return 1;
  return state.placement.widthMm / croppedWidthMm;
}

/**
 * Samples source-image salience without uploading or persisting another map.
 * High-contrast details receive the strongest protection; the central portrait
 * oval gets a gentler cost so a flat cheek is not mistaken for empty space.
 */
function bridgeDetailSampler() {
  if (el('protect-faces')?.checked !== true || !state.source?.imageData || !state.placement) return null;
  const { width, height, data } = state.source.imageData;
  const luminance = new Float32Array(width * height);
  for (let index = 0; index < luminance.length; index += 1) {
    const offset = index * 4;
    luminance[index] = 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
  }
  const detail = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const gx = luminance[y * width + x + 1] - luminance[y * width + x - 1];
      const gy = luminance[(y + 1) * width + x] - luminance[(y - 1) * width + x];
      detail[y * width + x] = Math.min(1, Math.hypot(gx, gy) / 150);
    }
  }
  const placement = { ...state.placement };
  const bounds = state.contentBounds ? { ...state.contentBounds } : null;
  const sourceSize = state.contentSourceSize ? { ...state.contentSourceSize } : null;
  return ({ x, y }) => {
    if (!bounds || !sourceSize || x < placement.xMm || y < placement.yMm ||
        x > placement.xMm + placement.widthMm || y > placement.yMm + placement.heightMm) return 0;
    const localX = (x - placement.xMm) / Math.max(placement.widthMm, Number.EPSILON);
    const localY = (y - placement.yMm) / Math.max(placement.heightMm, Number.EPSILON);
    const fullX = (bounds.x + localX * bounds.width) / Math.max(1, sourceSize.width);
    const fullY = (bounds.y + localY * bounds.height) / Math.max(1, sourceSize.height);
    const imageX = Math.max(0, Math.min(width - 1, Math.round(fullX * (width - 1))));
    const imageY = Math.max(0, Math.min(height - 1, Math.round(fullY * (height - 1))));
    const dx = (fullX - 0.5) / 0.42;
    const dy = (fullY - 0.43) / 0.48;
    const portraitFocus = Math.max(0, 1 - Math.hypot(dx, dy));
    return Math.min(1, Math.max(detail[imageY * width + imageX], portraitFocus * 0.55));
  };
}

function smartBridgeStrategy() {
  const style = selectedCutStyle();
  const level = Math.max(1, Math.min(3, Number(el('bridge-count')?.value || 2)));
  const strategy = {
    mode: 'smart',
    kind: style,
    level,
    detailAt: bridgeDetailSampler(),
  };
  // A tie across parallel retained bars is their normal. It reads as one of
  // the pattern's own rungs, like the supplied diagonal-slat reference.
  if (style === 'lamele') {
    const barAngleDeg = numberField('style-slat-angle', -55);
    strategy.preferredAngleDeg = barAngleDeg + 90;
    strategy.barAngleDeg = barAngleDeg;
    strategy.slatPitchMm = toMm(numberField('style-pitch', 38)) * placedStyleScale();
    strategy.organicVariation = numberField('stabilizer-organic', 75) / 100;
    if (el('stabilize-slats')?.checked !== false) {
      strategy.maximumUnsupportedSpanMm = toMm(numberField('max-cantilever', 250));
    }
  } else if (style === 'hasura') {
    strategy.preferredAngleDeg = numberField('style-angle', 30) + 90;
  } else if (style === 'icoana') {
    // Horizontal ties read as intentional icon construction and align with
    // the segmented halo instead of crossing facial features diagonally.
    strategy.preferredAngleDeg = 0;
  } else if (style === 'raze') {
    strategy.radialCenter = sourcePointOnSheet(
      numberField('style-ray-center-x', 25) / 100,
      numberField('style-ray-center-y', 50) / 100,
    );
  }
  return strategy;
}

async function autoBridge() {
  if (!state.sourceMask) { toast('Import an image first.'); return; }
  const button = el('btn-auto-bridge');
  const action = el('automatic-support-action');
  button?.setAttribute('aria-busy', 'true');
  if (button) button.disabled = true;
  if (action) action.textContent = 'Planning smart supports…';
  toast('Planning the smallest style-aware support network…');
  // Let the pending state paint before the component graph occupies the main
  // thread. The planner remains entirely local to the browser.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const kerfMm = toMm(numberField('kerf', 1.2));
  const minimumWebMm = Math.max(PLASMA_MIN_WEB_MM, toMm(numberField('min-web', 3)));
  const requestedWidthMm = Math.max(PLASMA_MIN_WEB_MM, toMm(numberField('bridge-width', 6)));
  const widthMm = Math.max(requestedWidthMm, minimumWebMm + kerfMm);
  if (widthMm > requestedWidthMm + 1e-9) {
    el('bridge-width').value = roundUnit(fromMm(widthMm));
    updateRangeOutputs();
    toast(`Raised bridge width to ${el('bridge-width').value} ${state.unit} so the minimum web survives the kerf.`);
  }
  try {
    const manual = state.bridges.filter((bridge) => bridge.source !== 'automatic');
    const base = buildDesignMask(state.sourceMask, {
      sheet: sheet(), frame: frameConfig(), bridges: manual,
    });
    const plan = suggestKerfAwareBridges(base.mask, {
      sheet: sheet(),
      widthMm,
      anchorMask: base.frameMask,
      anchorBoundary: false,
      requireSingleComponent: true,
      minimumWebMm,
      kerfMm,
      maxPasses: 4,
      strategy: smartBridgeStrategy(),
    });
    const suggested = plan.bridges;
    state.bridges = [...manual, ...suggested];
    state.automaticSupportsStale = false;
    selectBridge(null);
    updateAutomaticSupportState();
    refresh({ immediate: true, rebuildSourceMask: false });
    pushHistory();
    const supportSimulation = validateDesign(state.designMask, {
      sheet: sheet(),
      kerfMm,
      minimumWebMm: 0,
      minimumOpeningMm: 0,
      anchorBoundary: false,
      requireAnchored: false,
      requireSingleComponent: true,
    });
    const survivesKerf = supportSimulation.postKerf.componentCount === 1;
    const fallbackCount = suggested.filter((bridge) => bridge.fallback).length;
    const redundantCount = suggested.filter((bridge) => bridge.redundant).length;
    const stabilizerCount = suggested.filter((bridge) => bridge.stabilizer).length;
    const connectorCount = suggested.length - stabilizerCount;
    const additions = [
      connectorCount ? `${connectorCount} connectivity ${connectorCount === 1 ? 'bridge' : 'bridges'}` : '',
      stabilizerCount ? `${stabilizerCount} staggered slat ${stabilizerCount === 1 ? 'stabilizer' : 'stabilizers'}` : '',
    ].filter(Boolean).join(' and ');
    const repairSummary = plan.initialComponentCount > 1
      ? ` Post-kerf pieces: ${plan.initialComponentCount} → ${plan.finalComponentCount} in ${plan.passes} ${plan.passes === 1 ? 'pass' : 'passes'}.`
      : '';
    toast(suggested.length
      ? `Added ${additions}${redundantCount ? ` (${redundantCount} redundant)` : ''}${fallbackCount ? ` · ${fallbackCount} safe fallback` : ''}.${repairSummary}${survivesKerf ? ' Kerf simulation stays connected.' : ' Some geometry still separates after kerf; run validation to locate it.'}`
      : survivesKerf
        ? 'Everything is already one connected piece after kerf.'
        : 'No safe automatic repair was found; reduce detail or add a manual support.');
  } catch (error) {
    console.error(error);
    toast('Could not work out where to bridge.');
  } finally {
    button?.removeAttribute('aria-busy');
    if (button) button.disabled = false;
    updateAutomaticSupportState();
  }
}

function selectBridge(bridge) {
  state.selectedBridge = bridge;
  el('bridge-selection').hidden = !bridge;
  el('bridge-selection-empty').hidden = Boolean(bridge);
  if (bridge) {
    el('selected-bridge-width').value = roundUnit(fromMm(bridge.width));
    const metadata = el('bridge-selection-meta');
    if (metadata) {
      const length = Number.isFinite(bridge.lengthMm)
        ? ` · ${roundUnit(fromMm(bridge.lengthMm))} ${state.unit} long`
        : '';
      const styleName = CUT_STYLE_NAMES[bridge.strategy] || 'Artwork';
      if (bridge.source !== 'automatic') metadata.textContent = 'Manual support';
      else if (bridge.stabilizer) metadata.textContent = `Slat stabilizer · ${roundUnit(fromMm(bridge.targetSpanMm || toMm(numberField('max-cantilever', 250))))} ${state.unit} target span${length}`;
      else if (bridge.fallback) metadata.textContent = `Safe shortest-path fallback${length} · review its placement`;
      else if (bridge.redundant) metadata.textContent = `${styleName}-aware secure redundancy${length}`;
      else metadata.textContent = `${styleName}-aware smart support${length}`;
    }
  }
  updateAutomaticSupportState();
  draw();
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function requiredBridgeWidthMm() {
  return Math.max(
    PLASMA_MIN_WEB_MM,
    toMm(numberField('min-web', 3)) + toMm(numberField('kerf', 1.2)),
  );
}

function safeBridgeWidthMm(value = toMm(numberField('bridge-width', 6))) {
  return Math.max(Number.isFinite(value) ? value : 0, requiredBridgeWidthMm());
}

function preferredManualSupportAngle(start, end) {
  if (el('support-follow-style')?.checked !== true) return null;
  const style = selectedCutStyle();
  if (style === 'lamele') return numberField('style-slat-angle', -55) + 90;
  if (style === 'hasura') return numberField('style-angle', 30) + 90;
  if (style === 'icoana') return 0;
  if (style === 'raze') {
    const center = sourcePointOnSheet(
      numberField('style-ray-center-x', 25) / 100,
      numberField('style-ray-center-y', 50) / 100,
    );
    if (!center) return null;
    const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    return Math.atan2(midpoint.y - center.y, midpoint.x - center.x) * 180 / Math.PI + 90;
  }
  return null;
}

function constrainSupportEndpoint(start, end) {
  const angle = preferredManualSupportAngle(start, end);
  if (!Number.isFinite(angle)) return end;
  const radians = angle * Math.PI / 180;
  const unit = { x: Math.cos(radians), y: Math.sin(radians) };
  const delta = { x: end.x - start.x, y: end.y - start.y };
  const length = Math.hypot(delta.x, delta.y);
  if (length <= Number.EPSILON) return end;
  const direction = delta.x * unit.x + delta.y * unit.y < 0 ? -1 : 1;
  return { x: start.x + unit.x * length * direction, y: start.y + unit.y * length * direction };
}

function nearestRetainedPoint(point, maximumDistanceMm = 30) {
  if (el('support-snap')?.checked !== true || !state.designMask) return point;
  const currentSheet = sheet();
  const mask = state.designMask;
  const pixel = { x: currentSheet.widthMm / mask.width, y: currentSheet.heightMm / mask.height };
  const centerX = Math.round(point.x / pixel.x - 0.5);
  const centerY = Math.round(point.y / pixel.y - 0.5);
  const radiusX = Math.ceil(maximumDistanceMm / pixel.x);
  const radiusY = Math.ceil(maximumDistanceMm / pixel.y);
  let nearest = null;
  let nearestDistance = maximumDistanceMm;
  for (let y = Math.max(0, centerY - radiusY); y <= Math.min(mask.height - 1, centerY + radiusY); y += 1) {
    for (let x = Math.max(0, centerX - radiusX); x <= Math.min(mask.width - 1, centerX + radiusX); x += 1) {
      if (mask.data[y * mask.width + x] !== RETAINED) continue;
      const candidate = { x: (x + 0.5) * pixel.x, y: (y + 0.5) * pixel.y };
      const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = candidate;
      }
    }
  }
  return nearest ?? point;
}

function manualSupportPoint(point, start = null) {
  const currentSheet = sheet();
  const raw = {
    x: Math.max(0, Math.min(currentSheet.widthMm, point.x)),
    y: Math.max(0, Math.min(currentSheet.heightMm, point.y)),
  };
  const maximumDistance = Math.max(20, safeBridgeWidthMm() * 3);
  if (!start) return nearestRetainedPoint(raw, maximumDistance);
  const aligned = constrainSupportEndpoint(start, raw);
  if (el('support-snap')?.checked !== true) return aligned;
  const snappedAligned = nearestRetainedPoint(aligned, maximumDistance);
  if (snappedAligned !== aligned) return snappedAligned;
  // Direction guidance must never make a support miss the piece the user
  // deliberately pointed at. When the aligned target has no nearby metal,
  // preserve the user's target and only apply endpoint snapping there.
  return nearestRetainedPoint(raw, maximumDistance);
}

function promoteBridgeToManual(bridge) {
  if (!bridge || bridge.source !== 'automatic') return;
  bridge.source = 'manual';
  bridge.fallback = false;
  bridge.redundant = false;
  bridge.strategy = null;
  bridge.lengthMm = Math.hypot(bridge.end.x - bridge.start.x, bridge.end.y - bridge.start.y);
  updateAutomaticSupportState();
}

function pointerToMm(event) {
  const point = pointerToMask(event);
  if (!state.designMask) return { ...point, mmX: 0, mmY: 0 };
  const currentSheet = sheet();
  return {
    ...point,
    mmX: point.x / state.designMask.width * currentSheet.widthMm,
    mmY: point.y / state.designMask.height * currentSheet.heightMm,
  };
}

function bridgeAtPointer(event) {
  if (!state.designMask) return null;
  const point = pointerToMm(event);
  if (!point.inside) return null;
  const canvasWidth = Math.max(1, el('editor-canvas').getBoundingClientRect().width);
  const screenToleranceMm = sheet().widthMm / canvasWidth * 8;
  for (let index = state.bridges.length - 1; index >= 0; index -= 1) {
    const bridge = state.bridges[index];
    const distance = distanceToSegment(
      { x: point.mmX, y: point.mmY }, bridge.start, bridge.end,
    );
    if (distance <= Math.max(bridge.width / 2, screenToleranceMm)) return bridge;
  }
  return null;
}

function bridgeHandleAtPointer(event) {
  const bridge = state.selectedBridge;
  if (!bridge || !state.designMask) return null;
  const point = pointerToMm(event);
  if (!point.inside) return null;
  const canvasWidth = Math.max(1, el('editor-canvas').getBoundingClientRect().width);
  const toleranceMm = sheet().widthMm / canvasWidth * 12;
  const cursor = { x: point.mmX, y: point.mmY };
  if (Math.hypot(cursor.x - bridge.start.x, cursor.y - bridge.start.y) <= toleranceMm) return 'start';
  if (Math.hypot(cursor.x - bridge.end.x, cursor.y - bridge.end.y) <= toleranceMm) return 'end';
  return null;
}

/* ----------------------------------------------------------------- export */

function exportGeometry(kind) {
  if (!state.designMask || !state.validated || state.validatedRevision !== state.revision) {
    toast('Run the checks again for the current geometry.');
    return;
  }
  // Validation and download deliberately use the same transformed mask. This
  // prevents export-only options from bypassing the safety result.
  const mask = geometryForExport();
  const name = state.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'panel';
  try {
    const units = el('export-units')?.value === 'in' ? 'in' : 'mm';
    if (kind === 'svg') {
      downloadText(`${name}.svg`, exportSvg(mask, sheet(), { title: state.name, units }), 'image/svg+xml');
    } else {
      downloadText(`${name}.dxf`, exportDxf(mask, sheet(), { units }), 'application/dxf');
    }
    toast(`${kind.toUpperCase()} written.`);
  } catch (error) {
    console.error(error);
    toast(`The ${kind.toUpperCase()} could not be written.`);
  }
}

/* ------------------------------------------------------------------ chrome */

function setStage(stage) {
  state.stage = stage;
  const order = ['prepare', 'panel', 'support', 'validate', 'export'];
  for (const name of order) {
    const tab = el(`stage-${name}`);
    const panel = el(`panel-${name}`);
    const active = name === stage;
    tab?.setAttribute('aria-selected', String(active));
    tab?.classList.toggle('is-active', active);
    panel?.toggleAttribute('hidden', !active);
    panel?.classList.toggle('is-active', active);
  }
  el('current-step-number').textContent = String(order.indexOf(stage) + 1);
  el('current-stage-title').textContent = el(`stage-${stage}`)?.dataset.title
    || el(`stage-${stage}`)?.textContent.trim() || stage;
  setSidePanel(stage === 'prepare' || stage === 'panel' ? 'candidates' : 'issues');
}

function setView(view) {
  if (view === 'original' && !state.source) {
    toast('The original image is not available in this project file.');
    return;
  }
  state.view = view;
  for (const name of ['original', 'source', 'material', 'backlit', 'issues']) {
    const button = el(`view-${name}`);
    button?.setAttribute('aria-pressed', String(name === view));
    button?.classList.toggle('is-selected', name === view);
  }
  el('tool-problems')?.setAttribute('aria-pressed', String(view === 'issues'));
  el('tool-problems')?.classList.toggle('is-selected', view === 'issues');
  draw();
}

function updateViewAvailability() {
  const original = el('view-original');
  if (original) original.disabled = !state.source;
  if (!state.source && state.view === 'original') state.view = 'material';
}

function setSidePanel(panel) {
  state.sidePanel = panel === 'issues' ? 'issues' : 'candidates';
  for (const name of ['candidates', 'issues']) {
    const selected = name === state.sidePanel;
    el(`side-${name}`)?.setAttribute('aria-selected', String(selected));
    el(`side-${name}`)?.classList.toggle('is-selected', selected);
    el(name === 'candidates' ? 'candidate-side-panel' : 'issues-side-panel')
      ?.toggleAttribute('hidden', !selected);
  }
}

function setTool(tool) {
  if (!['pan', 'keep', 'remove', 'support'].includes(tool)) return;
  state.tool = tool;
  state.touchupPreview = null;
  state.drawingBridge = tool === 'support';
  state.bridgePreview = null;
  for (const name of ['pan', 'keep', 'remove', 'support']) {
    const button = el(`tool-${name}`);
    button?.setAttribute('aria-pressed', String(name === tool));
    button?.classList.toggle('is-selected', name === tool);
  }
  const editing = tool === 'keep' || tool === 'remove';
  el('touchup-options')?.toggleAttribute('hidden', !editing);
  el('touchup-empty')?.toggleAttribute('hidden', editing);
  if (editing) updateTouchupControls();
  el('canvas-viewport').style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
  draw();
}

function activateSupportTool() {
  if (!state.designMask) { toast('Import an image first.'); return; }
  const safeWidth = safeBridgeWidthMm();
  if (safeWidth > toMm(numberField('bridge-width', 6)) + 1e-9) {
    el('bridge-width').value = roundUnit(fromMm(safeWidth));
  }
  setStage('support');
  setTool('support');
  toast('Support tool active. Drag between two pieces; endpoints snap to metal.');
}

function activateIconStencil() {
  setStage('prepare');
  const option = document.querySelector('input[name="cutStyle"][value="icoana"]');
  if (!option) return;
  if (!option.checked) option.click();
  else reflectModeControls();
  el('style-icon')?.scrollIntoView({ block: 'nearest' });
  toast('Icon stencil selected. Its halo and detail settings are open.');
}

function touchupMode() {
  return document.querySelector('input[name="touchupMode"]:checked')?.value || 'freehand';
}

function touchupMinimumMm() {
  return state.tool === 'remove'
    ? Math.max(PLASMA_MIN_OPENING_MM, toMm(numberField('min-opening', 2)))
    : Math.max(
      PLASMA_MIN_WEB_MM,
      toMm(numberField('min-web', 3)) + toMm(numberField('kerf', 1.2)),
    );
}

function touchupSizeMm() {
  return Math.max(touchupMinimumMm(), toMm(numberField('touchup-size', 8)));
}

function updateTouchupControls() {
  const remove = state.tool === 'remove';
  const mode = touchupMode();
  const size = el('touchup-size');
  const minimum = roundUnit(fromMm(touchupMinimumMm()));
  if (size) {
    size.min = String(minimum);
    size.max = String(roundUnit(fromMm(250)));
    size.step = state.unit === 'in' ? '0.01' : '0.5';
    size.disabled = mode === 'region';
    if (toMm(numberField('touchup-size', minimum)) < touchupMinimumMm()) size.value = String(minimum);
  }
  const label = el('touchup-size-label');
  if (label) label.innerHTML = `${remove ? 'Cut width' : 'Material width'} <small>${mode === 'region' ? 'Not used for a whole region' : 'Physical size on the panel'}</small>`;
  const hint = el('touchup-hint');
  if (!hint) return;
  if (mode === 'straight') hint.textContent = `Drag between two points for a precise ${remove ? 'cut' : 'material strip'}.`;
  else if (mode === 'region') hint.textContent = `Click a connected ${remove ? 'metal piece to remove it' : 'opening to fill it'}.`;
  else hint.textContent = `Drag a continuous ${roundUnit(fromMm(touchupSizeMm()))} ${state.unit} physical-width stroke.`;
}

function toast(message) {
  const region = el('toast-region');
  if (!region) return;
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  region.append(node);
  setTimeout(() => node.remove(), 4200);
}

function confirmAction(title, message, label = 'Continue') {
  const dialog = el('confirm-dialog');
  if (!dialog) return Promise.resolve(true);
  el('confirm-dialog-title').textContent = title;
  el('confirm-dialog-message').textContent = message;
  el('confirm-dialog-action').textContent = label;
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
  });
}

/* ------------------------------------------------------------------- wiring */

function pointerToMask(event) {
  const canvas = el('editor-canvas');
  const box = canvas.getBoundingClientRect();
  const x = Math.floor((event.clientX - box.left) / box.width * canvas.width);
  const y = Math.floor((event.clientY - box.top) / box.height * canvas.height);
  return { x, y, inside: x >= 0 && y >= 0 && x < canvas.width && y < canvas.height };
}

function paintIndex(index) {
  if (!state.sourceMask || index < 0 || index >= state.sourceMask.data.length) return false;
  const target = state.tool === 'keep' ? state.painted.keep : state.painted.remove;
  const other = state.tool === 'keep' ? state.painted.remove : state.painted.keep;
  if (target.has(index) && !other.has(index)) return false;
  target.add(index);
  other.delete(index);
  return true;
}

function paintDisc(point, diameterMm = touchupSizeMm()) {
  if (!state.sourceMask) return false;
  let changed = false;
  for (const index of physicalDiscIndices(state.sourceMask, point, diameterMm, sheet())) {
    changed = paintIndex(index) || changed;
  }
  return changed;
}

function paintSegment(start, end) {
  if (!state.sourceMask) return false;
  let changed = false;
  for (const index of physicalStrokeIndices(state.sourceMask, start, end, touchupSizeMm(), sheet())) {
    changed = paintIndex(index) || changed;
  }
  return changed;
}

function paintConnectedRegion(point) {
  if (!state.sourceMask) return false;
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  if (x < 0 || y < 0 || x >= state.sourceMask.width || y >= state.sourceMask.height) return false;
  const start = y * state.sourceMask.width + x;
  const desired = state.tool === 'keep' ? RETAINED : REMOVED;
  const original = state.sourceMask.data[start];
  if (original === desired) return false;
  const maximum = Math.min(50000, Math.floor(state.sourceMask.data.length * 0.15));
  const region = connectedRegionIndices(state.sourceMask, point, { maximumPixels: Math.max(1, maximum) });
  if (region.truncated) {
    toast('That region is too large for a touch-up. Adjust the filter instead.');
    return false;
  }
  let changed = false;
  for (const index of region.indices) changed = paintIndex(index) || changed;
  return changed;
}

function reportTouchupResult() {
  if (el('touchup-safety')?.checked !== true || !state.analysis) return;
  const loose = Math.max(0, state.analysis.componentCount - 1);
  if (loose > 0) {
    toast(`Edit leaves ${loose} loose ${loose === 1 ? 'piece' : 'pieces'}. They are highlighted in Problems.`);
    setSidePanel('issues');
  } else {
    toast('Edit keeps the panel connected. Run validation for hole and gap checks.');
  }
}

let styleTimer = null;

function wire() {
  // --- stages
  for (const name of ['prepare', 'panel', 'support', 'validate', 'export']) {
    el(`stage-${name}`)?.addEventListener('click', () => setStage(name));
  }
  for (const button of all('.stage-next')) {
    button.addEventListener('click', () => setStage(button.dataset.nextStage));
  }
  el('btn-stage-help')?.addEventListener('click', () => {
    const help = {
      prepare: 'Choose line art or a photograph, then tune which areas remain metal.',
      panel: 'Set the real sheet size, artwork margin, and structural edge frame.',
      support: 'Automatic supports are suggestions. Select, move, resize, or remove them at any time.',
      validate: 'Checks use the exact geometry and units that will be exported.',
      export: 'SVG and DXF are true-scale. Kerf compensation remains the CAM tool’s responsibility.',
    };
    toast(help[state.stage] || 'Work through the five stages to produce cut-ready geometry.');
  });

  // --- import
  el('file-input')?.addEventListener('change', (event) => importFile(event.target.files?.[0]));
  el('btn-empty-import')?.addEventListener('click', () => el('file-input')?.click());
  const zone = el('drop-zone');
  zone?.addEventListener('dragover', (event) => { event.preventDefault(); zone.dataset.dragging = 'true'; });
  zone?.addEventListener('dragleave', () => { delete zone.dataset.dragging; });
  zone?.addEventListener('drop', (event) => {
    event.preventDefault();
    delete zone.dataset.dragging;
    importFile(event.dataTransfer?.files?.[0]);
  });
  el('btn-remove-source')?.addEventListener('click', async () => {
    if (!await confirmAction('Remove the source image?', 'The artwork and its saved candidates are cleared; panel settings stay.', 'Remove')) return;
    styleAbort?.abort();
    state.source = null; state.styleMask = null; state.styleMaskFor = null;
    state.styleMaskFresh = false; state.baseMask = null;
    state.sourceMask = null; state.designMask = null; state.frameMask = null; state.kerfPreviewMask = null;
    state.placement = null; state.contentBounds = null; state.contentSourceSize = null;
    state.painted = { keep: new Set(), remove: new Set() };
    state.paintedFor = null; state.bridges = []; state.automaticSupportsStale = false;
    state.candidates = []; state.selectedCandidateId = null; state.validation = null;
    state.projectId = null; state.createdAt = null; state.dirty = false;
    await clearLastProject();
    if (el('save-state')) { el('save-state').textContent = 'No artwork'; el('save-state').dataset.state = 'saved'; }
    setSourceRecipeAvailability(true);
    updateViewAvailability();
    updateAutomaticSupportState();
    renderCandidates();
    el('drop-zone').dataset.state = 'empty';
    el('source-file').hidden = true;
    refresh({ immediate: true });
  });

  // A style is a round trip to the server, so it is not re-requested on every
  // tick of a slider. Settling for half a second turns a drag into one request
  // instead of thirty.
  const restyle = () => {
    invalidateStyleRender();
    clearTimeout(styleTimer);
    styleTimer = setTimeout(() => { styleTimer = null; renderStyle(); }, 500);
    setRenderProgress('queued');
  };

  // --- treatment, panel, and constraints
  const treatment = ['threshold', 'contrast', 'blur', 'despeckle'];
  for (const id of treatment) {
    el(id)?.addEventListener('input', () => {
      updateRangeOutputs();
      restyle();
      if (state.mode === 'line-art') refresh();
    });
    el(id)?.addEventListener('change', pushHistory);
  }

  const syncLinkedPanelDimension = (changedId) => {
    if (el('btn-link-dimensions')?.getAttribute('aria-pressed') !== 'true') return;
    const sourceWidth = state.source?.width ?? state.baseMask?.width;
    const sourceHeight = state.source?.height ?? state.baseMask?.height;
    if (!sourceWidth || !sourceHeight) return;
    const aspect = sourceWidth / sourceHeight;
    const frame = frameConfig();
    const margin = el('fit-artwork')?.checked === false ? 0 : toMm(numberField('panel-margin', 0));
    const sideInset = (side) => margin + (frame.enabled && frame.sides[side] ? frame.thicknessMm : 0);
    const horizontalInset = sideInset('left') + sideInset('right');
    const verticalInset = sideInset('top') + sideInset('bottom');
    if (changedId === 'panel-width') {
      const safeWidth = Math.max(1, toMm(numberField('panel-width', 1250)) - horizontalInset);
      el('panel-height').value = roundUnit(fromMm(safeWidth / aspect + verticalInset));
    } else if (changedId === 'panel-height') {
      const safeHeight = Math.max(1, toMm(numberField('panel-height', 2500)) - verticalInset);
      el('panel-width').value = roundUnit(fromMm(safeHeight * aspect + horizontalInset));
    }
  };

  const layout = ['panel-width', 'panel-height', 'panel-margin', 'frame-width'];
  for (const id of layout) {
    el(id)?.addEventListener('input', () => {
      syncLinkedPanelDimension(id);
      if (id === 'panel-width' || id === 'panel-height') reflectPanelOrientation();
      updateRangeOutputs();
      restyle();
      refresh();
    });
    el(id)?.addEventListener('change', pushHistory);
  }
  for (const node of all('input[name="panelOrientation"]')) {
    node.addEventListener('change', () => {
      const oriented = orientSheet(sheet(), node.value);
      el('panel-width').value = roundUnit(fromMm(oriented.widthMm));
      el('panel-height').value = roundUnit(fromMm(oriented.heightMm));
      reflectPanelOrientation(node.value);
      updateRangeOutputs();
      restyle();
      refresh({ immediate: true });
      pushHistory();
    });
  }
  el('fit-artwork')?.addEventListener('change', () => {
    restyle();
    refresh({ immediate: true });
    pushHistory();
  });

  for (const node of all('input[name="polarity"]')) {
    node.addEventListener('change', () => {
      rememberStyleSettings();
      restyle();
      if (state.mode === 'line-art') refresh({ immediate: true });
      pushHistory();
    });
  }
  for (const node of all('input[name="anchorEdge"]')) {
    node.addEventListener('change', () => {
      restyle();
      refresh({ immediate: true });
      pushHistory();
    });
  }
  for (const node of all('input[name="cutStyle"]')) {
    node.addEventListener('change', (event) => {
      activateStyleSettings(event.target.value);
      const mode = event.target.value === 'line-art' ? 'line-art' : 'photo';
      clearTimeout(styleTimer);
      styleTimer = null;
      invalidateStyleRender({ useLocalPreview: true });
      setMode(mode);
      pushHistory();
    });
  }
  for (const id of ['style-threshold', 'style-outline', 'style-icon-balance', 'style-icon-detail',
    'style-icon-line-width', 'style-icon-simplify', 'style-icon-halo', 'style-icon-halo-scale',
    'style-pitch', 'style-slat-angle', 'style-angle',
    'style-row-pitch', 'style-cell', 'style-gain', 'style-smooth', 'style-curve',
    'style-line-detail', 'style-line-width', 'style-wood-spacing', 'style-wood-length',
    'style-graphic-balance', 'style-graphic-detail', 'style-graphic-simplify',
    'style-silhouette-smooth', 'style-contour-levels', 'style-contour-width',
    'style-ray-count', 'style-ray-cell', 'style-ray-center-auto', 'style-ray-center-x', 'style-ray-center-y', 'style-ray-cutoff', 'style-ornament-detail',
    'style-ornament-width', 'style-ornament-four-way', 'style-cutout', 'style-clothes']) {
    el(id)?.addEventListener('input', () => {
      if (STYLE_SHARED_CONTROL_IDS.includes(id)) rememberStyleSettings();
      if (id === 'style-ray-center-auto') reflectRayCentreControls();
      if (id === 'style-icon-halo') reflectModeControls();
      updateRangeOutputs();
      restyle();
    });
    el(id)?.addEventListener('change', () => {
      if (STYLE_SHARED_CONTROL_IDS.includes(id)) rememberStyleSettings();
      restyle();
      pushHistory();
    });
  }
  el('btn-restyle')?.addEventListener('click', renderStyle);

  for (const id of ['kerf', 'min-web', 'min-opening']) {
    el(id)?.addEventListener('input', () => {
      const adjusted = enforcePlasmaLimits();
      if (adjusted.length) toast(`Raised ${adjusted.join(' and ')} to fit the plasma limits.`);
      updateTouchupControls();
      restyle();
      refresh();
    });
    el(id)?.addEventListener('change', pushHistory);
  }
  for (const node of all('input[name="kerfPreview"]')) node.addEventListener('change', draw);
  el('show-grid')?.addEventListener('change', draw);
  el('export-frame')?.addEventListener('change', () => {
    invalidateValidation();
    analyse();
    draw();
    markDirty();
  });
  el('export-units')?.addEventListener('change', updateReadouts);

  el('btn-reset-treatment')?.addEventListener('click', () => {
    el('threshold').value = 50; el('contrast').value = 0;
    el('blur').value = 0; el('despeckle').value = 0;
    updateRangeOutputs(); restyle(); refresh({ immediate: true }); pushHistory();
  });

  el('measurement-unit')?.addEventListener('change', (event) => {
    const previous = state.unit;
    state.unit = event.target.value;
    // The numbers on screen are re-expressed, not re-interpreted: switching
    // units must not silently resize the panel.
    for (const id of ['panel-width', 'panel-height', 'panel-margin', 'frame-width',
      'bridge-width', 'touchup-size', 'kerf', 'min-web', 'min-opening', 'max-cantilever', 'curve-tolerance',
      'style-pitch', 'style-row-pitch', 'style-cell', 'style-line-width',
      'style-graphic-simplify', 'style-icon-line-width', 'style-icon-simplify',
      'style-wood-spacing', 'style-wood-length', 'style-silhouette-smooth',
      'style-contour-width', 'style-ray-cell', 'style-ornament-width']) {
      const node = el(id);
      if (!node) continue;
      const mm = previous === 'in' ? Number(node.value) * MM_PER_INCH : Number(node.value);
      node.value = state.unit === 'in' ? Math.round(mm / MM_PER_INCH * 1000) / 1000 : Math.round(mm * 10) / 10;
    }
    enforcePlasmaLimits();
    updateTouchupControls();
    updateSlatStabilizerControls();
    updateReadouts(); restyle(); refresh({ immediate: true });
    pushHistory();
  });

  el('btn-link-dimensions')?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    const linked = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(linked));
    button.classList.toggle('is-linked', linked);
    if (linked) {
      syncLinkedPanelDimension('panel-width');
      restyle();
      refresh({ immediate: true });
      pushHistory();
    }
  });

  // --- tools and view
  el('tool-pan')?.addEventListener('click', () => setTool('pan'));
  for (const name of ['keep', 'remove']) {
    el(`tool-${name}`)?.addEventListener('click', () => {
      setStage('prepare');
      setTool(name);
    });
  }
  el('tool-support')?.addEventListener('click', activateSupportTool);
  el('tool-icon-stencil')?.addEventListener('click', activateIconStencil);
  el('tool-problems')?.addEventListener('click', () => {
    setStage('validate');
    setSidePanel('issues');
    setView('issues');
    if (!state.validation) toast('Run all checks to locate manufacturing problems.');
  });
  for (const node of all('input[name="touchupMode"]')) {
    node.addEventListener('change', () => { updateTouchupControls(); draw(); pushHistory(); });
  }
  el('touchup-size')?.addEventListener('input', () => { updateTouchupControls(); draw(); });
  el('touchup-size')?.addEventListener('change', pushHistory);
  el('touchup-safety')?.addEventListener('change', pushHistory);
  for (const name of ['original', 'source', 'material', 'backlit', 'issues']) {
    el(`view-${name}`)?.addEventListener('click', () => setView(name));
  }
  for (const name of ['candidates', 'issues']) {
    el(`side-${name}`)?.addEventListener('click', () => setSidePanel(name));
  }

  el('btn-save-candidate')?.addEventListener('click', saveCurrentCandidate);
  const candidateList = el('candidate-list');
  candidateList?.addEventListener('click', (event) => {
    const action = event.target.closest?.('[data-candidate-action]');
    const item = event.target.closest?.('[data-candidate-id]');
    if (!action || !item) return;
    const id = item.dataset.candidateId;
    if (action.dataset.candidateAction === 'restore') restoreCandidate(id);
    else if (action.dataset.candidateAction === 'duplicate') duplicateCandidate(id);
    else if (action.dataset.candidateAction === 'delete') void deleteCandidate(id);
  });
  candidateList?.addEventListener('change', (event) => {
    if (!event.target.matches?.('.candidate-name')) return;
    const item = event.target.closest('[data-candidate-id]');
    const candidate = state.candidates.find((entry) => entry.id === item?.dataset.candidateId);
    if (!candidate) return;
    const name = event.target.value.trim();
    if (!name) {
      event.target.value = candidate.name;
      toast('Candidate names cannot be empty.');
      return;
    }
    candidate.name = name;
    event.target.value = name;
    markDirty();
  });

  // --- bridges
  el('bridge-count')?.addEventListener('input', updateRangeOutputs);
  const supportPlanChanged = () => { markAutomaticSupportsStale(); pushHistory(); };
  el('bridge-count')?.addEventListener('change', supportPlanChanged);
  el('protect-faces')?.addEventListener('change', supportPlanChanged);
  el('support-snap')?.addEventListener('change', pushHistory);
  el('support-follow-style')?.addEventListener('change', pushHistory);
  el('stabilize-slats')?.addEventListener('change', () => {
    updateSlatStabilizerControls();
    supportPlanChanged();
  });
  el('max-cantilever')?.addEventListener('input', updateSlatStabilizerControls);
  el('max-cantilever')?.addEventListener('change', supportPlanChanged);
  el('stabilizer-organic')?.addEventListener('input', updateRangeOutputs);
  el('stabilizer-organic')?.addEventListener('change', supportPlanChanged);
  el('bridge-width')?.addEventListener('input', () => {
    const adjusted = enforcePlasmaLimits();
    if (adjusted.length) toast(`Raised ${adjusted.join(' and ')} to fit the plasma limits.`);
  });
  el('bridge-width')?.addEventListener('change', supportPlanChanged);
  el('btn-auto-bridge')?.addEventListener('click', autoBridge);
  el('btn-add-bridge')?.addEventListener('click', activateSupportTool);
  el('btn-clear-auto-bridges')?.addEventListener('click', () => {
    const before = state.bridges.length;
    state.bridges = state.bridges.filter((bridge) => bridge.source !== 'automatic');
    state.automaticSupportsStale = false;
    selectBridge(null);
    updateAutomaticSupportState();
    if (state.bridges.length === before) return;
    refresh({ immediate: true, rebuildSourceMask: false });
    pushHistory();
    toast('Automatic supports removed. You can keep editing the artwork.');
  });
  el('btn-delete-bridge')?.addEventListener('click', () => {
    state.bridges = state.bridges.filter((bridge) => bridge !== state.selectedBridge);
    selectBridge(null);
    refresh({ immediate: true, rebuildSourceMask: false });
    pushHistory();
  });
  el('selected-bridge-width')?.addEventListener('change', (event) => {
    if (!state.selectedBridge) return;
    promoteBridgeToManual(state.selectedBridge);
    state.selectedBridge.width = safeBridgeWidthMm(toMm(Number(event.target.value)));
    event.target.value = roundUnit(fromMm(state.selectedBridge.width));
    refresh({ immediate: true, rebuildSourceMask: false });
    pushHistory();
  });

  // --- validation and export
  el('btn-validate')?.addEventListener('click', runValidation);
  el('btn-validate-sidebar')?.addEventListener('click', runValidation);
  el('btn-export-svg')?.addEventListener('click', () => exportGeometry('svg'));
  el('btn-export-dxf')?.addEventListener('click', () => exportGeometry('dxf'));
  el('btn-download-project')?.addEventListener('click', async () => {
    if (!state.sourceMask) { toast('Import an image first.'); return; }
    await persist();
    downloadText(`${state.name || 'panel'}.stencil.json`, serializeProject(projectFromState(), { pretty: true }));
  });

  for (const chip of all('[data-issue-filter]')) {
    chip.addEventListener('click', () => {
      state.issueFilter = chip.dataset.issueFilter;
      for (const other of all('[data-issue-filter]')) {
        const on = other === chip;
        other.setAttribute('aria-pressed', String(on));
        other.classList.toggle('is-selected', on);
      }
      renderIssues(state.issues);
    });
  }
  const issueList = el('issue-list');
  const activateIssue = (target) => {
    const row = target.closest?.('[data-highlightable="true"]');
    if (!row) return;
    toggleIssueHighlight(Number(row.dataset.issueIndex));
  };
  issueList?.addEventListener('click', (event) => activateIssue(event.target));
  issueList?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    activateIssue(event.target);
  });

  // --- history and project
  el('btn-undo')?.addEventListener('click', undo);
  el('btn-redo')?.addEventListener('click', redo);
  el('btn-new-project')?.addEventListener('click', async () => {
    if (!await confirmAction('Start a new panel?', 'The current panel is saved on this device first.', 'Start new')) return;
    await persist();
    await clearLastProject();
    location.reload();
  });
  el('project-name')?.addEventListener('input', (event) => {
    state.name = event.target.textContent?.trim() || event.target.value?.trim() || 'Untitled panel';
    markDirty();
  });

  // --- canvas
  const viewport = el('canvas-viewport');
  let panning = null;
  let drawingFrom = null;
  let draggingBridge = null;
  let touchupStroke = null;

  viewport?.addEventListener('pointerdown', (event) => {
    const { x, y, inside } = pointerToMask(event);
    if (state.drawingBridge && inside) {
      const point = pointerToMm(event);
      drawingFrom = manualSupportPoint({ x: point.mmX, y: point.mmY });
      state.bridgePreview = { start: drawingFrom, end: drawingFrom, width: safeBridgeWidthMm() };
      viewport.setPointerCapture(event.pointerId);
      draw();
      return;
    }
    if (state.tool === 'keep' || state.tool === 'remove') {
      if (!inside) return;
      const mode = touchupMode();
      touchupStroke = {
        mode,
        start: { x, y },
        last: { x, y },
        changed: mode === 'region' ? paintConnectedRegion({ x, y }) : mode === 'freehand' ? paintDisc({ x, y }) : false,
      };
      state.touchupPreview = mode === 'straight'
        ? { mode: 'straight', start: { x, y }, end: { x, y }, diameterMm: touchupSizeMm() }
        : { mode: 'cursor', point: { x, y }, diameterMm: touchupSizeMm() };
      viewport.setPointerCapture(event.pointerId);
      if (touchupStroke.changed) refresh({ reanalyse: false });
      else draw();
      return;
    }
    const handle = bridgeHandleAtPointer(event);
    if (handle && state.selectedBridge) {
      const point = pointerToMm(event);
      draggingBridge = {
        mode: handle,
        bridge: state.selectedBridge,
        origin: { x: point.mmX, y: point.mmY },
        start: { ...state.selectedBridge.start },
        end: { ...state.selectedBridge.end },
      };
      viewport.setPointerCapture(event.pointerId);
      viewport.style.cursor = 'crosshair';
      return;
    }
    const hit = bridgeAtPointer(event);
    if (hit) {
      const point = pointerToMm(event);
      selectBridge(hit);
      draggingBridge = {
        mode: 'move',
        bridge: hit,
        origin: { x: point.mmX, y: point.mmY },
        start: { ...hit.start },
        end: { ...hit.end },
      };
      viewport.setPointerCapture(event.pointerId);
      viewport.style.cursor = 'move';
      return;
    }
    selectBridge(null);
    panning = { x: event.clientX - state.pan.x, y: event.clientY - state.pan.y };
    viewport.setPointerCapture(event.pointerId);
    viewport.style.cursor = 'grabbing';
  });

  viewport?.addEventListener('pointermove', (event) => {
    const { x, y, inside, mmX, mmY } = pointerToMm(event);
    if (inside && state.designMask) {
      el('pointer-position').textContent = state.unit === 'in'
        ? `x ${(mmX / MM_PER_INCH).toFixed(2)}  y ${(mmY / MM_PER_INCH).toFixed(2)}`
        : `x ${Math.round(mmX)}  y ${Math.round(mmY)}`;
    }
    if (drawingFrom) {
      if (!inside) return;
      const end = manualSupportPoint({ x: mmX, y: mmY }, drawingFrom);
      state.bridgePreview = { start: drawingFrom, end, width: safeBridgeWidthMm() };
      draw();
    } else if (touchupStroke) {
      if (!inside) return;
      if (touchupStroke.mode === 'freehand') {
        touchupStroke.changed = paintSegment(touchupStroke.last, { x, y }) || touchupStroke.changed;
        touchupStroke.last = { x, y };
        state.touchupPreview = { mode: 'cursor', point: { x, y }, diameterMm: touchupSizeMm() };
        refresh({ reanalyse: false });
      } else if (touchupStroke.mode === 'straight') {
        touchupStroke.last = { x, y };
        state.touchupPreview = {
          mode: 'straight', start: touchupStroke.start, end: { x, y }, diameterMm: touchupSizeMm(),
        };
        draw();
      }
    } else if (draggingBridge) {
      promoteBridgeToManual(draggingBridge.bridge);
      draggingBridge.bridge.width = safeBridgeWidthMm(draggingBridge.bridge.width);
      if (draggingBridge.mode === 'start' || draggingBridge.mode === 'end') {
        const other = draggingBridge.mode === 'start' ? draggingBridge.bridge.end : draggingBridge.bridge.start;
        const endpoint = manualSupportPoint({ x: mmX, y: mmY }, other);
        draggingBridge.bridge[draggingBridge.mode] = endpoint;
      } else {
        const currentSheet = sheet();
        let dx = mmX - draggingBridge.origin.x;
        let dy = mmY - draggingBridge.origin.y;
        dx = Math.max(-Math.min(draggingBridge.start.x, draggingBridge.end.x), Math.min(
          currentSheet.widthMm - Math.max(draggingBridge.start.x, draggingBridge.end.x), dx,
        ));
        dy = Math.max(-Math.min(draggingBridge.start.y, draggingBridge.end.y), Math.min(
          currentSheet.heightMm - Math.max(draggingBridge.start.y, draggingBridge.end.y), dy,
        ));
        draggingBridge.bridge.start = { x: draggingBridge.start.x + dx, y: draggingBridge.start.y + dy };
        draggingBridge.bridge.end = { x: draggingBridge.end.x + dx, y: draggingBridge.end.y + dy };
      }
      draggingBridge.bridge.lengthMm = Math.hypot(
        draggingBridge.bridge.end.x - draggingBridge.bridge.start.x,
        draggingBridge.bridge.end.y - draggingBridge.bridge.start.y,
      );
      refresh({ immediate: true, reanalyse: false, rebuildSourceMask: false });
    } else if (panning) {
      state.pan = { x: event.clientX - panning.x, y: event.clientY - panning.y };
      applyTransform();
    } else if (state.tool === 'keep' || state.tool === 'remove') {
      state.touchupPreview = inside
        ? { mode: 'cursor', point: { x, y }, diameterMm: touchupSizeMm() }
        : null;
      draw();
    }
  });

  viewport?.addEventListener('pointerup', (event) => {
    const releasePoint = pointerToMask(event);
    const inside = releasePoint.inside;
    if (draggingBridge) {
      draggingBridge.bridge.lengthMm = Math.hypot(
        draggingBridge.bridge.end.x - draggingBridge.bridge.start.x,
        draggingBridge.bridge.end.y - draggingBridge.bridge.start.y,
      );
      selectBridge(draggingBridge.bridge);
      draggingBridge = null;
      refresh({ immediate: true, rebuildSourceMask: false });
      pushHistory();
    }
    if (drawingFrom) {
      const end = state.bridgePreview?.end;
      if (inside && end && Math.hypot(end.x - drawingFrom.x, end.y - drawingFrom.y) > Number.EPSILON) {
        const bridge = {
          id: `manual-${Date.now()}`, type: 'capsule', enabled: true, units: 'mm',
          start: drawingFrom, end,
          width: safeBridgeWidthMm(),
          lengthMm: Math.hypot(end.x - drawingFrom.x, end.y - drawingFrom.y),
          source: 'manual',
        };
        state.bridges.push(bridge);
        refresh({ immediate: true, rebuildSourceMask: false });
        selectBridge(bridge);
        pushHistory();
        toast('Support added. Drag either endpoint handle to refine it.');
      }
      drawingFrom = null;
      state.drawingBridge = state.tool === 'support';
      state.bridgePreview = null;
    }
    if (touchupStroke) {
      if (touchupStroke.mode === 'straight' && inside) {
        touchupStroke.changed = paintSegment(touchupStroke.start, releasePoint) || touchupStroke.changed;
      } else if (touchupStroke.mode === 'freehand' && inside) {
        touchupStroke.changed = paintSegment(touchupStroke.last, releasePoint) || touchupStroke.changed;
      }
      const changed = touchupStroke.changed;
      touchupStroke = null;
      state.touchupPreview = inside
        ? { mode: 'cursor', point: releasePoint, diameterMm: touchupSizeMm() }
        : null;
      if (changed) {
        refresh({ immediate: true });
        pushHistory();
        reportTouchupResult();
      } else {
        draw();
      }
    }
    panning = null;
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    viewport.style.cursor = state.tool === 'pan' ? 'grab' : 'crosshair';
  });

  viewport?.addEventListener('pointerleave', () => {
    if (touchupStroke || drawingFrom || draggingBridge) return;
    state.touchupPreview = null;
    draw();
  });

  viewport?.addEventListener('pointercancel', (event) => {
    const painted = touchupStroke?.changed === true;
    const movedBridge = Boolean(draggingBridge);
    touchupStroke = null;
    drawingFrom = null;
    draggingBridge = null;
    panning = null;
    state.drawingBridge = state.tool === 'support';
    state.bridgePreview = null;
    state.touchupPreview = null;
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    if (painted) {
      refresh({ immediate: true });
      pushHistory();
      reportTouchupResult();
    } else if (movedBridge) {
      refresh({ immediate: true, rebuildSourceMask: false });
      pushHistory();
    } else {
      draw();
    }
  });

  viewport?.addEventListener('wheel', (event) => {
    if (!state.designMask) return;
    event.preventDefault();
    const bounds = viewport.getBoundingClientRect();
    const anchor = {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    };
    const deltaUnit = event.deltaMode === 1
      ? 16
      : event.deltaMode === 2 ? viewport.clientHeight : 1;
    const delta = Math.max(-500, Math.min(500, event.deltaY * deltaUnit));
    zoomAt(state.zoom * Math.exp(-delta * 0.0015), anchor);
  }, { passive: false });

  el('btn-zoom-in')?.addEventListener('click', () => zoomAt(state.zoom * 1.35));
  el('btn-zoom-out')?.addEventListener('click', () => zoomAt(state.zoom / 1.35));
  el('btn-zoom-reset')?.addEventListener('click', () => zoomAt(1));
  el('btn-fit')?.addEventListener('click', fitToView);

  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey) {
      if (event.key === 'z' && !event.shiftKey) { event.preventDefault(); undo(); }
      if (event.key === 'y' || (event.key === 'z' && event.shiftKey)) { event.preventDefault(); redo(); }
      return;
    }
    if (event.altKey || event.target?.matches?.('input, textarea, select') || event.target?.isContentEditable) return;
    if (event.key === 'Escape') { event.preventDefault(); setTool('pan'); }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomAt(state.zoom * 1.35); }
    if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomAt(state.zoom / 1.35); }
    if (event.key === '0') { event.preventDefault(); zoomAt(1); }
    if (event.key === 'f' || event.key === 'F') { event.preventDefault(); fitToView(); }
    if (event.key === 'i' || event.key === 'I') { event.preventDefault(); activateIconStencil(); }
    if (event.key === 'k' || event.key === 'K') { event.preventDefault(); setStage('prepare'); setTool('keep'); }
    if (event.key === 'r' || event.key === 'R') { event.preventDefault(); setStage('prepare'); setTool('remove'); }
    if ((event.key === 'b' || event.key === 'B') && state.designMask) {
      event.preventDefault();
      setStage('support');
      el('btn-add-bridge')?.click();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

function updateRangeOutputs() {
  const set = (id, text) => { const node = el(id); if (node) node.textContent = text; };
  set('threshold-value', `${numberField('threshold', 50)}%`);
  set('contrast-value', String(numberField('contrast', 0)));
  set('blur-value', `${numberField('blur', 0)} px`);
  set('despeckle-value', `${numberField('despeckle', 0)} px²`);
  const secure = Number(el('bridge-count')?.value || 2);
  set('bridge-count-value', ['Minimal', 'Aesthetic', 'Secure'][secure - 1] ?? 'Aesthetic');
  set('stabilizer-organic-value', `${numberField('stabilizer-organic', 75)}%`);
  set('style-gain-value', numberField('style-gain', 2.2).toFixed(1));
  set('style-smooth-value', numberField('style-smooth', 0.55).toFixed(2));
  set('style-curve-value', numberField('style-curve', 1.4).toFixed(1));
  set('style-threshold-value', `${numberField('style-threshold', 50)}%`);
  set('style-outline-value', `${numberField('style-outline', 60)}%`);
  set('style-icon-balance-value', `${numberField('style-icon-balance', 56)}%`);
  set('style-icon-detail-value', `${numberField('style-icon-detail', 65)}%`);
  set('style-icon-halo-scale-value', `${numberField('style-icon-halo-scale', 135)}%`);
  set('style-graphic-balance-value', `${numberField('style-graphic-balance', 50)}%`);
  set('style-graphic-detail-value', `${numberField('style-graphic-detail', 70)}%`);
  set('style-line-detail-value', `${numberField('style-line-detail', 40)}%`);
  set('style-contour-levels-value', String(numberField('style-contour-levels', 5)));
  set('style-ray-count-value', String(numberField('style-ray-count', 64)));
  set('style-ray-center-x-value', `${numberField('style-ray-center-x', 25)}%`);
  set('style-ray-center-y-value', `${numberField('style-ray-center-y', 50)}%`);
  set('style-ray-cutoff-value', `${numberField('style-ray-cutoff', 12)}%`);
  set('style-ornament-detail-value', `${numberField('style-ornament-detail', 40)}%`);
}

/* -------------------------------------------------------------------- entry */

export async function startEditor({ device, offline = false } = {}) {
  state.device = device;
  state.offline = offline;

  wire();
  enforcePlasmaLimits();
  setMode(document.querySelector('input[name="cutStyle"]:checked')?.value === 'line-art' ? 'line-art' : 'photo');
  setStage('prepare');
  setView('material');
  setTool('pan');
  updateRangeOutputs();
  updateReadouts();
  updateExportReadiness();
  updateHistoryButtons();
  updateViewAvailability();
  updateAutomaticSupportState();
  renderCandidates();
  renderIssues([]);

  // A panel left open yesterday should still be there. Only the settings and
  // the source mask come back -- the photograph itself never left the machine
  // and is not ours to keep.
  try {
    const previous = await loadLastProject();
    if (previous?.raster?.sourceMask) {
      await loadProjectState(previous);
      toast('Reopened your last panel.');
    }
  } catch (error) {
    console.error(error);
  }

  pushHistory();
  window.stencilCncIsBusy = () => Boolean(
    state.dirty || state.styleBusy || rebuildTimer || saveTimer || styleTimer,
  );
  window.addEventListener('resize', () => fitToView());
}
