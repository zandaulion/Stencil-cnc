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
  CANDIDATE_PAYLOAD_VERSION,
  FINISHED_BOUNDARY_CAM,
  analyzeConnectivity,
  applyCapsuleBridges,
  applyRasterLayers,
  applySmallOpeningRepairPlan,
  buildDesignMask,
  buildExportFilename,
  calculateArtworkPlacement,
  connectedRegionIndices,
  countValidationLocations,
  createCuttingProfile,
  createProject,
  createSyncRetryController,
  decodeMask,
  deserializeProject,
  drawDraftWatermark,
  encodeMask,
  erodeMaskPhysical,
  exportDxf,
  exportSvg,
  maskFromImageData,
  maskFingerprint,
  maskToRgba,
  mergeRepairLayerEdits,
  manualEditIndices,
  normalizeManualEdit,
  normalizeManualEdits,
  orientSheet,
  physicalDiscIndices,
  physicalStrokeIndices,
  normalizeCuttingProfile,
  normalizeVectorDots,
  nextIssueReviewTarget,
  placeVectorDots,
  planManufacturingRepairs,
  placeMaskOnSheet,
  pointFromArtworkPlacement,
  pointToArtworkPlacement,
  serializeProject,
  setSmallOpeningRepairAction,
  suggestKerfAwareBridges,
  trimMaskToContent,
  upgradeProjectRecord,
  validateDesign,
  zoomAroundPoint,
  isRetryableSyncError,
  isStorageQuotaError,
  issueLocationCount,
  cuttingProfileVerificationProblems,
  isCanvasShortcutTarget,
  isEditableShortcutTarget,
  tabIndexForKey,
  isLegacyGeometryInterpretation,
  kerfErosionMm,
  rasterWebWidthMm,
  rasterizeManualEdits,
  recommendStyleSettings,
  retireConflictingRepairEdit,
  formatRulerValue,
  rulerTicks,
  translateManualEdit,
  REMOVED,
  RETAINED,
} from '/core/index.js';
import {
  LOCAL_DRAFT_PROJECT_ID,
  clearLastProject,
  deleteProject,
  deleteShareSecret,
  downloadBlob,
  downloadText,
  importArtifact,
  importCheckpoint,
  importLegacyProjects,
  listArtifacts,
  listCheckpoints,
  listProjects,
  legacyProjectSummary,
  loadLastProject,
  loadProject,
  loadShareSecret,
  promoteLocalDraft,
  restoreProject,
  saveArtifact,
  saveCheckpoint,
  saveProject,
  saveShareSecret,
  setLastProject,
  trashProject,
  updateProject,
} from '/storage.js';
import {
  buildProjectBundle,
  deleteServerProject,
  flushQueuedProjectSync,
  hasPendingProjectSync,
  pendingProjectSyncCount,
  PROJECT_BUNDLE_SCHEMA,
  PROJECT_BUNDLE_VERSION,
  queueProjectSync,
  synchronizeProjectLibrary,
  syncProject,
} from '/project-sync.js';

/* ------------------------------------------------------------------ state */

// The raster the design is computed on. Independent of the panel's real size:
// millimetres come from `sheet`, so this only decides how fine the tracing can
// be. 900 across matches the analysis service, and keeps a rebuild under a
// frame on a laptop.
const RASTER_LONG_EDGE = 900;
const MAX_SHEET_LONG_EDGE = 2600;
const MM_PER_INCH = 25.4;
const PLASMA_MIN_OPENING_MM = 2;
// New projects retain the conservative 3 mm default from the profile, while
// calibrated machines may use a verified finished web down to 2 mm.
const PLASMA_MIN_WEB_MM = 2;
const UNDO_DEPTH = 40;
const CANDIDATE_LIMIT = 8;
const LOCAL_SAVE_DELAY_MS = 160;
const SERVER_SYNC_DELAY_MS = 1200;
const SHARE_BUNDLE_SCHEMA = PROJECT_BUNDLE_SCHEMA;
const SHARE_BUNDLE_VERSION = PROJECT_BUNDLE_VERSION;
const MANUAL_ONLY_STYLES = new Set(['icoana']);
const PANEL_SIZE_PRESETS = Object.freeze({
  a0: Object.freeze({ widthMm: 841, heightMm: 1189 }),
  a1: Object.freeze({ widthMm: 594, heightMm: 841 }),
  a2: Object.freeze({ widthMm: 420, heightMm: 594 }),
  a3: Object.freeze({ widthMm: 297, heightMm: 420 }),
  a4: Object.freeze({ widthMm: 210, heightMm: 297 }),
  'sheet-1250-2050': Object.freeze({ widthMm: 1250, heightMm: 2050 }),
  'sheet-1250-2500': Object.freeze({ widthMm: 1250, heightMm: 2500 }),
});
const BASE_STYLE_SETTINGS = Object.freeze({
  'style-tone-brightness': '0',
  'style-tone-contrast': '0',
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
  puncte: Object.freeze({
    'style-gain': '3.3',
    'style-smooth': '0.30',
    'style-curve': '1.2',
    'style-cutout': true,
    'style-clothes': false,
    polarity: 'black-retained',
  }),
  flux: Object.freeze({
    'style-gain': '2.6',
    'style-smooth': '0.65',
    'style-curve': '1.2',
    'style-cutout': true,
    'style-clothes': false,
    polarity: 'black-retained',
  }),
});
const STYLE_SHARED_CONTROL_IDS = Object.freeze([
  'style-tone-brightness', 'style-tone-contrast',
  'style-gain', 'style-smooth', 'style-curve', 'style-cutout', 'style-clothes',
]);

const state = {
  device: null,
  offline: false,
  projectId: null,
  isDraft: true,
  conflictOriginId: null,
  serverRevision: 0,
  createdAt: null,
  name: 'Untitled panel',
  stage: 'prepare',
  view: 'material',
  sidePanel: 'candidates',
  tool: 'pan',
  unit: 'mm',
  geometryInterpretation: FINISHED_BOUNDARY_CAM,
  cuttingProfile: createCuttingProfile(),
  cuttingProfileRevisionCounter: 1,

  source: null,          // { file, imageData, width, height, name, bytes }
  mode: 'line-art',      // 'line-art' threshold locally, 'photo' renders on the server
  activeStyle: 'line-art',
  styleSettings: {},     // shared photo controls remembered independently per filter
  styleMask: null,       // what the analysis service returned, before touch-ups
  styleMaskFor: null,    // cut style that produced styleMask
  styleMaskFresh: false, // false while controls have changed or a refinement is pending
  vectorDots: null,      // exact source-space circles for Variable Dots
  placedVectorDots: [],  // the same circles after crop and panel placement, in mm
  tonePreviewCanvas: null, // exact server interpretation before pattern generation
  tonePreviewFor: null,
  toneStatistics: null,
  lineToneCache: null,
  styleBusy: false,
  shareBusy: false,
  baseMask: null,        // threshold/style result in the source's own aspect
  sourceMask: null,      // base mask placed on the physical sheet, plus touch-ups
  placement: null,
  contentBounds: null,   // non-empty generated artwork inside the source mask
  contentSourceSize: null,
  designMask: null,      // after frame and bridges
  frameMask: null,
  kerfPreviewMask: null, // live simulation; available before validation

  // Old projects keep their raster paint as a compatibility base. New work is
  // an ordered physical-unit operation layer, so individual edits can be
  // restored, hidden, moved, resized, or removed without baking a bitmap.
  painted: { keep: new Set(), remove: new Set() },
  paintedFor: null,
  manualEdits: [],
  selectedManualEditId: null,
  touchupPreview: null,
  touchupLive: false,

  // Machine-generated corrections are kept separate from both the filter and
  // hand painting. They can be hidden, removed, or regenerated as one layer;
  // an artwork/control change marks them stale instead of baking obsolete
  // raster edits into the new image.
  manufacturingRepairs: {
    keep: new Set(),
    remove: new Set(),
    enabled: true,
    stale: false,
    summary: null,
  },

  bridges: [],
  drawingBridge: false,
  bridgePreview: null,
  supportTapStart: null,
  supportProposal: null,
  automaticSupportsStale: false,
  selectedBridge: null,
  hoveredBridge: null,
  candidates: [],
  selectedCandidateId: null,
  analysis: null,
  validation: null,
  validationPending: false,
  supportAnalysis: null,
  issues: [],
  issueFilter: 'all',
  highlightedIssue: null,
  highlightedIssueLocation: 0,
  repairPlan: null,
  repairPreviewBaseMask: null,
  repairPreviewUsesExistingLayer: false,
  repairPreviewMask: null,
  repairPreviewKerfMask: null,
  repairItemIndex: 0,
  repairResult: null,
  validated: false,
  revision: 0,
  validatedRevision: -1,
  exportTimestamp: null,
  lastValidatedAt: null,
  lastExportedAt: null,

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

function optionalText(id) {
  const value = el(id)?.value?.trim();
  return value || null;
}

function optionalPhysicalValue(id) {
  const value = Number.parseFloat(el(id)?.value);
  return Number.isFinite(value) && value > 0 ? toMm(value) : null;
}

function cuttingProfileFromControls({
  revision = state.cuttingProfile.revision,
  status = state.cuttingProfile.status,
  id = state.cuttingProfile.id,
  verifiedAt = state.cuttingProfile.provenance.verifiedAt,
} = {}) {
  return normalizeCuttingProfile({
    ...state.cuttingProfile,
    id,
    name: optionalText('cutting-profile-name') || state.cuttingProfile.name,
    revision,
    status,
    process: el('cutting-profile-process')?.value || state.cuttingProfile.process,
    material: {
      name: optionalText('cutting-profile-material'),
      grade: optionalText('cutting-profile-grade'),
      thicknessMm: optionalPhysicalValue('cutting-profile-thickness'),
    },
    machine: {
      name: optionalText('cutting-profile-machine'),
      consumable: optionalText('cutting-profile-consumable'),
    },
    limits: {
      kerfMm: toMm(numberField('kerf', 1.2)),
      minimumWebMm: toMm(numberField('min-web', 3)),
      minimumOpeningMm: toMm(numberField('min-opening', 2)),
      supportWidthMm: toMm(numberField('bridge-width', 6)),
      maximumUnsupportedSpanMm: toMm(numberField('max-cantilever', 250)),
    },
    provenance: {
      kind: el('cutting-profile-provenance')?.value || state.cuttingProfile.provenance.kind,
      note: optionalText('cutting-profile-evidence'),
      verifiedBy: optionalText('cutting-profile-verified-by'),
      verifiedAt,
    },
  });
}

function profileProcessLabel(process) {
  return ({ plasma: 'Plasma', laser: 'Laser', router: 'Router', waterjet: 'Waterjet', other: 'Other' })[process] || process;
}

function renderCuttingProfileStatus() {
  const profile = state.cuttingProfile;
  const status = profile.status === 'verified' ? 'verified' : 'provisional';
  const statusLabel = status === 'verified' ? 'Verified' : 'Provisional';
  const badge = el('cutting-profile-status');
  if (badge) {
    badge.dataset.status = status;
    badge.textContent = statusLabel;
  }
  const summary = el('cutting-profile-summary');
  if (summary) summary.dataset.status = status;
  if (el('cutting-profile-summary-title')) el('cutting-profile-summary-title').textContent = profile.name;
  const material = optionalText('cutting-profile-material') || profile.material.name;
  const thicknessMm = optionalPhysicalValue('cutting-profile-thickness') ?? profile.material.thicknessMm;
  const machine = optionalText('cutting-profile-machine') || profile.machine.name;
  const identity = [
    material || 'Material not set',
    thicknessMm ? `${roundUnit(fromMm(thicknessMm))} ${state.unit}` : 'Thickness not set',
    machine || 'Machine not set',
  ].join(' · ');
  if (el('cutting-profile-summary-copy')) {
    el('cutting-profile-summary-copy').textContent = `${profileProcessLabel(profile.process)} · ${identity}`;
  }
  if (el('cutting-profile-revision')) el('cutting-profile-revision').textContent = String(profile.revision);
  const preset = el('manufacturing-profile');
  if (preset) {
    const customOption = preset.querySelector('option[value="project-custom"]');
    if (customOption) customOption.textContent = `This project · ${profile.name}`;
    preset.value = profile.id === 'general-plasma-v1' && profile.revision === 1
      ? 'general-plasma'
      : 'project-custom';
  }
  const supportWidth = roundUnit(numberField('bridge-width', fromMm(profile.limits.supportWidthMm ?? 6)));
  const maximumSpan = roundUnit(numberField(
    'max-cantilever',
    fromMm(profile.limits.maximumUnsupportedSpanMm ?? 250),
  ));
  if (el('cutting-profile-support-summary')) {
    el('cutting-profile-support-summary').textContent =
      `${supportWidth} ${state.unit} support width · ${maximumSpan} ${state.unit} maximum unsupported span`;
  }
  const verification = el('cutting-profile-verification-copy');
  if (verification) {
    verification.textContent = status === 'verified'
      ? `Verified by ${profile.provenance.verifiedBy} on ${new Date(profile.provenance.verifiedAt).toLocaleDateString()}. Editing any profile value returns it to provisional.`
      : 'Provisional profiles guide geometry but are not evidence that a setup has been tested.';
  }
  el('btn-verify-cutting-profile')?.toggleAttribute('hidden', status === 'verified');
  el('btn-unverify-cutting-profile')?.toggleAttribute('hidden', status !== 'verified');
}

function syncCuttingProfileControls(profile = state.cuttingProfile) {
  state.cuttingProfile = normalizeCuttingProfile(JSON.parse(JSON.stringify(profile)));
  state.cuttingProfileRevisionCounter = Math.max(
    state.cuttingProfileRevisionCounter,
    state.cuttingProfile.revision,
  );
  const set = (id, value) => { if (el(id)) el(id).value = value ?? ''; };
  set('cutting-profile-name', profile.name);
  set('cutting-profile-process', profile.process);
  set('cutting-profile-material', profile.material.name);
  set('cutting-profile-grade', profile.material.grade);
  set('cutting-profile-thickness', profile.material.thicknessMm == null
    ? '' : roundUnit(fromMm(profile.material.thicknessMm)));
  set('cutting-profile-machine', profile.machine.name);
  set('cutting-profile-consumable', profile.machine.consumable);
  set('cutting-profile-provenance', profile.provenance.kind);
  set('cutting-profile-evidence', profile.provenance.note);
  set('cutting-profile-verified-by', profile.provenance.verifiedBy);
  set('kerf', roundUnit(fromMm(profile.limits.kerfMm)));
  set('min-web', roundUnit(fromMm(profile.limits.minimumWebMm)));
  set('min-opening', roundUnit(fromMm(profile.limits.minimumOpeningMm)));
  if (profile.limits.supportWidthMm != null) {
    set('bridge-width', roundUnit(fromMm(profile.limits.supportWidthMm)));
  }
  if (profile.limits.maximumUnsupportedSpanMm != null) {
    set('max-cantilever', roundUnit(fromMm(profile.limits.maximumUnsupportedSpanMm)));
  }
  renderCuttingProfileStatus();
}

function nextCuttingProfileRevision() {
  state.cuttingProfileRevisionCounter = Math.max(
    state.cuttingProfileRevisionCounter,
    state.cuttingProfile.revision,
  ) + 1;
  return state.cuttingProfileRevisionCounter;
}

function markCuttingProfileSourceAsCustom() {
  const source = el('cutting-profile-provenance');
  if (source && ['kerfloom-default', 'legacy-project'].includes(source.value)) source.value = 'custom';
}

function updateWorkingCuttingProfile({ invalidate = false } = {}) {
  const wasVerified = state.cuttingProfile.status === 'verified';
  state.cuttingProfile = cuttingProfileFromControls({
    id: null,
    status: 'provisional',
    verifiedAt: null,
  });
  renderCuttingProfileStatus();
  if (invalidate || wasVerified) {
    invalidateValidation();
    state.lastValidatedAt = null;
  }
}

function commitCuttingProfileRevision({ affectsGeometryLimits = false } = {}) {
  state.cuttingProfile = cuttingProfileFromControls({
    id: null,
    revision: nextCuttingProfileRevision(),
    status: 'provisional',
    verifiedAt: null,
  });
  renderCuttingProfileStatus();
  if (affectsGeometryLimits) {
    markAutomaticSupportsStale();
    markManufacturingRepairsStale();
  }
  invalidateValidation();
  state.lastValidatedAt = null;
  updateReadouts();
  markDirty();
  pushHistory();
}

function applyGeneralPlasmaProfile() {
  state.cuttingProfile = createCuttingProfile();
  syncCuttingProfileControls();
  enforcePlasmaLimits();
  updateTouchupControls();
  updateSlatStabilizerControls();
  state.lastValidatedAt = null;
  refresh({ immediate: true });
  pushHistory();
  toast('General plasma starting values applied. The profile remains provisional until supported by shop evidence.');
}

function verifyCuttingProfile() {
  const verifiedAt = new Date().toISOString();
  const candidate = cuttingProfileFromControls({
    id: null,
    revision: state.cuttingProfile.revision + 1,
    status: 'provisional',
    verifiedAt,
  });
  const problems = cuttingProfileVerificationProblems(candidate);
  if (problems.length) {
    el('cutting-profile-details')?.setAttribute('open', '');
    toast(`Add ${problems.join(', ')} before marking this profile verified.`);
    return;
  }
  state.cuttingProfile = normalizeCuttingProfile({
    ...candidate,
    revision: nextCuttingProfileRevision(),
    status: 'verified',
  });
  renderCuttingProfileStatus();
  invalidateValidation();
  state.lastValidatedAt = null;
  markDirty();
  pushHistory();
  toast('Profile marked verified from the recorded shop evidence. Run geometry checks again.');
}

function returnCuttingProfileToProvisional() {
  state.cuttingProfile = cuttingProfileFromControls({
    id: null,
    revision: nextCuttingProfileRevision(),
    status: 'provisional',
    verifiedAt: null,
  });
  renderCuttingProfileStatus();
  invalidateValidation();
  state.lastValidatedAt = null;
  markDirty();
  pushHistory();
  toast('Profile returned to provisional.');
}

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
      adjusted.push({ id, label, value: displayedMinimum, unit: state.unit });
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

function artworkTransform() {
  return {
    scale: Math.max(0.1, Math.min(4, numberField('artwork-scale', 100) / 100)),
    rotationDeg: Math.max(-180, Math.min(180, numberField('artwork-rotation', 0))),
    offsetXMm: toMm(numberField('artwork-offset-x', 0)),
    offsetYMm: toMm(numberField('artwork-offset-y', 0)),
  };
}

function setArtworkOffset(offsetXMm, offsetYMm) {
  if (el('artwork-offset-x')) el('artwork-offset-x').value = roundUnit(fromMm(offsetXMm));
  if (el('artwork-offset-y')) el('artwork-offset-y').value = roundUnit(fromMm(offsetYMm));
}

function resetArtworkTransformControls() {
  if (el('artwork-scale')) el('artwork-scale').value = '100';
  if (el('artwork-rotation')) el('artwork-rotation').value = '0';
  setArtworkOffset(0, 0);
  updateRangeOutputs();
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

function lineArtTonePreview() {
  if (!state.source) return null;
  const key = [
    numberField('contrast', 0),
    numberField('blur', 0),
    state.source.width,
    state.source.height,
  ].join(':');
  if (state.lineToneCache?.key === key) return state.lineToneCache;
  const field = treatedImageData();
  const canvas = new OffscreenCanvas(field.width, field.height);
  const context = canvas.getContext('2d');
  const image = context.createImageData(field.width, field.height);
  image.data.set(field.data);
  context.putImageData(image, 0, 0);
  let dark = 0;
  let midtone = 0;
  let light = 0;
  for (let index = 0; index < field.data.length; index += 4) {
    const value = field.data[index];
    if (value < 255 / 3) dark += 1;
    else if (value < 255 * 2 / 3) midtone += 1;
    else light += 1;
  }
  const total = Math.max(1, dark + midtone + light);
  state.lineToneCache = {
    key,
    canvas,
    statistics: { dark: dark / total, midtone: midtone / total, light: light / total },
  };
  return state.lineToneCache;
}

function currentTonePreview() {
  if (!state.source) return null;
  if (state.mode === 'line-art') {
    const preview = lineArtTonePreview();
    return preview ? { ...preview, provisional: false } : null;
  }
  // Keep the last complete interpretation visible while replacement settings
  // render. It still corresponds to the currently displayed artwork, and the
  // progress affordance makes the pending replacement explicit.
  if (state.tonePreviewCanvas && state.tonePreviewFor === selectedCutStyle()) {
    return {
      canvas: state.tonePreviewCanvas,
      statistics: state.toneStatistics,
      provisional: false,
    };
  }

  // Exact server interpretations are deliberately not persisted with every
  // local project/candidate. Keep Tone useful after restore (and offline) by
  // falling back to the source luminance until the user re-renders.
  const preview = lineArtTonePreview();
  return preview ? { ...preview, provisional: true } : null;
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

function syncStylePicker() {
  const option = document.querySelector('input[name="cutStyle"]:checked')?.closest('.style-option');
  if (!option) return;
  const name = option.querySelector('strong')?.textContent?.trim() || 'Cut style';
  const description = option.querySelector('small')?.textContent?.trim() || '';
  const category = option.dataset.category || 'Cut style';
  if (el('style-picker-selected-name')) el('style-picker-selected-name').textContent = name;
  if (el('style-picker-selected-description')) el('style-picker-selected-description').textContent = description;
  if (el('style-picker-selected-category')) el('style-picker-selected-category').textContent = category;
}

function positionStylePicker() {
  const dialog = el('style-picker-dialog');
  const trigger = el('style-picker-trigger');
  if (!dialog?.open || !trigger) return;
  if (window.matchMedia('(max-width: 720px)').matches) {
    dialog.style.removeProperty('top');
    dialog.style.removeProperty('left');
    return;
  }
  const triggerBox = trigger.getBoundingClientRect();
  const gutter = 12;
  const width = dialog.offsetWidth;
  const height = dialog.offsetHeight;
  const left = Math.min(
    Math.max(gutter, triggerBox.left),
    Math.max(gutter, window.innerWidth - width - gutter),
  );
  const below = triggerBox.bottom + 8;
  const top = below + height <= window.innerHeight - gutter
    ? below
    : Math.max(gutter, triggerBox.top - height - 8);
  dialog.style.left = `${Math.round(left)}px`;
  dialog.style.top = `${Math.round(top)}px`;
}

function openStylePicker() {
  const dialog = el('style-picker-dialog');
  const trigger = el('style-picker-trigger');
  if (!dialog || dialog.open || trigger?.disabled) return;
  syncStylePicker();
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  trigger?.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => {
    positionStylePicker();
    const selected = document.querySelector('input[name="cutStyle"]:checked');
    selected?.closest('.style-option')?.scrollIntoView({ block: 'nearest' });
    selected?.focus({ preventScroll: true });
  });
}

function closeStylePicker({ returnFocus = false } = {}) {
  const dialog = el('style-picker-dialog');
  if (!dialog?.open) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
  el('style-picker-trigger')?.setAttribute('aria-expanded', 'false');
  if (returnFocus) el('style-picker-trigger')?.focus();
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
  // Older projects can have a complete recipe from before newer shared tone
  // controls existed. Merge it over current defaults so omitted controls do
  // not leak across styles while switching filters.
  const recipe = { ...styleDefaults(style), ...(state.styleSettings[style] || {}) };
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
  if (style === 'flux') return el('style-cutout')?.checked !== false ? RETAINED : REMOVED;
  return style === 'grafic' || style === 'lamele' ? RETAINED : REMOVED;
}

function availableVectorDotHoles() {
  const sourceIsCurrent = !state.source || state.styleMaskFresh;
  if (selectedCutStyle() !== 'puncte' || !state.vectorDots || !state.placedVectorDots.length ||
      !sourceIsCurrent) return [];
  return state.placedVectorDots;
}

function exactVectorDotHoles() {
  const circles = availableVectorDotHoles();
  const repairEditsActive = state.manufacturingRepairs.enabled !== false &&
    state.manufacturingRepairs.stale !== true &&
    (state.manufacturingRepairs.keep.size > 0 || state.manufacturingRepairs.remove.size > 0);
  const activeManualEdits = state.manualEdits.some((edit) => edit.enabled !== false);
  if (!circles.length || state.painted.keep.size || state.painted.remove.size || activeManualEdits ||
      repairEditsActive || state.bridges.some((bridge) => bridge.enabled !== false)) return [];
  return circles;
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
    state.placedVectorDots = [];
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
    state.placedVectorDots = [];
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
    artworkTransform: artworkTransform(),
    fillLetterboxWithMetal: true,
    longEdgePx: Math.min(MAX_SHEET_LONG_EDGE, Math.max(mask.width, mask.height, requiredLongEdge)),
  });
  mask = placed.mask;
  state.placement = placed.placement;
  state.placedVectorDots = selectedCutStyle() === 'puncte' && state.vectorDots
    ? placeVectorDots(state.vectorDots, state.contentSourceSize, state.contentBounds, state.placement)
    : [];

  // Touch-ups last, so a deliberate correction is never undone by a slider.
  // Legacy raster paint is remapped when resolution changes; ordered stroke
  // edits are rasterized afresh from their physical millimetre coordinates.
  const rasterKey = `${mask.width}x${mask.height}`;
  if (state.paintedFor && state.paintedFor !== rasterKey &&
      (state.painted.keep.size || state.painted.remove.size)) {
    state.painted = {
      keep: remapPaintedSet(state.painted.keep, state.paintedFor, mask.width, mask.height),
      remove: remapPaintedSet(state.painted.remove, state.paintedFor, mask.width, mask.height),
    };
  }
  state.paintedFor = rasterKey;
  const painted = rasterizeManualEdits(mask, currentSheet, {
    legacy: state.paintedFor === rasterKey ? state.painted : null,
    edits: state.manualEdits,
  });
  mask = applyRasterLayers(mask, {
    painted,
    manufacturingRepairs: state.manufacturingRepairs,
  }, { clone: false });
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
    artworkTransform: artworkTransform(),
  });
  form.set('coala_lat_mm', String(placement.widthMm));
  form.set('fara_fundal', String(el('style-cutout')?.checked !== false));
  form.set('cu_haine', String(stil === 'grafic' || el('style-clothes')?.checked === true));
  form.set('castig', String(numberField('style-gain', 2.2)));
  form.set('netezire', String(numberField('style-smooth', 0.55)));
  form.set('gamma', String(numberField('style-curve', 1.4)));
  form.set('luminozitate_ton', String(numberField('style-tone-brightness', 0)));
  form.set('contrast_ton', String(numberField('style-tone-contrast', 0)));
  form.set('inverseaza', String(
    document.querySelector('input[name="polarity"]:checked')?.value === 'white-retained',
  ));
  // Minimum web is always the requested finished width. The versioned
  // interpretation tells the analysis service whether the raster itself is a
  // finished boundary or a preserved legacy uncompensated centre path.
  form.set('punte_min_mm', String(toMm(numberField('min-web', 3))));
  form.set('kerf_mm', String(toMm(numberField('kerf', 1.2))));
  form.set('interpretare_geometrie', state.geometryInterpretation);
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
  } else if (stil === 'puncte') {
    form.set('pas_puncte_mm', String(toMm(numberField('style-dot-pitch', 41))));
    form.set('diametru_max_puncte_mm', String(toMm(numberField('style-dot-max', 33.8))));
    form.set('unghi_puncte', String(numberField('style-dot-angle', 10)));
    form.set('prag_puncte', String(numberField('style-dot-cutoff', 42) / 100));
  } else if (stil === 'linii') {
    form.set('detaliu_linii', String(numberField('style-line-detail', 40) / 100));
    form.set('latime_linie_mm', String(toMm(numberField('style-line-width', 2))));
  } else if (stil === 'gravura') {
    form.set('pas_gravura_mm', String(toMm(numberField('style-wood-spacing', 12))));
    form.set('lungime_gravura_mm', String(toMm(numberField('style-wood-length', 20))));
  } else if (stil === 'flux') {
    form.set('pas_flux_mm', String(toMm(numberField('style-flow-pitch', 12))));
    form.set('latime_flux_mm', String(toMm(numberField('style-flow-width', 7))));
    form.set('unghi_flux', String(numberField('style-flow-angle', -15)));
    form.set('urmarire_flux', String(numberField('style-flow-follow', 72) / 100));
    form.set('netezire_flux_mm', String(toMm(numberField('style-flow-smooth', 10))));
    form.set('prag_flux', String(numberField('style-flow-cutoff', 16) / 100));
  } else if (stil === 'silueta') {
    form.set('netezire_silueta_mm', String(toMm(numberField('style-silhouette-smooth', 8))));
  } else if (stil === 'contururi') {
    form.set('niveluri_contur', String(numberField('style-contour-levels', 5)));
    form.set('latime_linie_mm', String(toMm(numberField('style-contour-width', 2.5))));
  } else if (stil === 'raze') {
    form.set('numar_raze', String(numberField('style-ray-count', 64)));
    form.set('celula_raze_mm', String(toMm(numberField('style-ray-cell', 12))));
    form.set('diametru_miez_raze_mm', String(toMm(numberField('style-ray-hub', 50))));
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
  const web = rasterWebWidthMm(
    toMm(numberField('min-web', 3)),
    kerf,
    state.geometryInterpretation,
  );
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
      ajustate.push({ id: 'style-pitch', label: 'bar pitch', value: pitch.value, unit: state.unit });
    }
  }
  const spacingFields = style === 'hasura'
    ? [['style-row-pitch', 'row spacing'], ['style-cell', 'stroke cell']]
    : style === 'puncte'
      ? [['style-dot-pitch', 'dot pitch']]
    : style === 'gravura'
      ? [['style-wood-spacing', 'mark spacing']]
    : style === 'flux'
      ? [['style-flow-pitch', 'ribbon pitch']]
      : style === 'raze' ? [['style-ray-cell', 'radial pitch']] : [];
  for (const [id, eticheta] of spacingFields) {
    const node = el(id);
    if (!node) continue;
    node.min = String(roundUnit(minim));
    if (numberField(id, 3) < minim) {
      node.value = roundUnit(minim);
      ajustate.push({ id, label: eticheta, value: node.value, unit: state.unit });
    }
  }
  if (style === 'raze') {
    const node = el('style-ray-hub');
    const minimumDiameterMm = Math.max(5, (slot + web) / Math.PI);
    const sourceSize = state.source
      ? { width: state.source.width, height: state.source.height }
      : null;
    const placement = sourceSize
      ? calculateArtworkPlacement(sourceSize, sheet(), {
          frame: frameConfig(),
          marginMm: toMm(numberField('panel-margin', 0)),
          fitToFrame: el('fit-artwork')?.checked !== false,
          artworkTransform: artworkTransform(),
        })
      : sheet();
    // The deterministic fallback is one quarter from the left edge. Limiting
    // the diameter to half the artwork width keeps the complete circle inside
    // the rendered image even when no feature is large enough to conceal it.
    const maximumDiameterMm = Math.max(
      minimumDiameterMm,
      Math.min(placement.widthMm / 2, placement.heightMm),
    );
    const minimumDiameter = fromMm(minimumDiameterMm);
    const maximumDiameter = fromMm(maximumDiameterMm);
    node.min = String(roundUnit(minimumDiameter));
    node.max = String(roundUnit(maximumDiameter));
    if (numberField('style-ray-hub', 50) < minimumDiameter) {
      node.value = roundUnit(minimumDiameter);
      ajustate.push({ id: 'style-ray-hub', label: 'solid hub diameter', value: node.value, unit: state.unit });
    } else if (numberField('style-ray-hub', 50) > maximumDiameter) {
      node.value = roundUnit(maximumDiameter);
      ajustate.push({ id: 'style-ray-hub', label: 'solid hub diameter', value: node.value, unit: state.unit });
    }
  }
  if (style === 'puncte') {
    const node = el('style-dot-max');
    const maximumDiameterMm = Math.max(slot, toMm(numberField('style-dot-pitch', 41)) - web);
    const minimumDiameter = fromMm(slot);
    const maximumDiameter = fromMm(maximumDiameterMm);
    node.min = String(roundUnit(minimumDiameter));
    node.max = String(roundUnit(maximumDiameter));
    if (numberField('style-dot-max', 33.8) < minimumDiameter) {
      node.value = roundUnit(minimumDiameter);
      ajustate.push({ id: 'style-dot-max', label: 'maximum dot diameter', value: node.value, unit: state.unit });
    } else if (numberField('style-dot-max', 33.8) > maximumDiameter) {
      node.value = roundUnit(maximumDiameter);
      ajustate.push({ id: 'style-dot-max', label: 'maximum dot diameter', value: node.value, unit: state.unit });
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
      ajustate.push({ id: lineField, label: 'cut-line width', value: node.value, unit: state.unit });
    }
  }
  if (style === 'gravura') {
    const node = el('style-wood-length');
    const minimumLength = fromMm(slot);
    node.min = String(roundUnit(minimumLength));
    if (numberField('style-wood-length', 20) < minimumLength) {
      node.value = roundUnit(minimumLength);
      ajustate.push({ id: 'style-wood-length', label: 'mark length', value: node.value, unit: state.unit });
    }
  }
  if (style === 'flux') {
    const widthNode = el('style-flow-width');
    const minimumWidth = fromMm(slot);
    const maximumWidth = fromMm(Math.max(slot, toMm(numberField('style-flow-pitch', 12)) - web));
    widthNode.min = String(roundUnit(minimumWidth));
    widthNode.max = String(roundUnit(maximumWidth));
    if (numberField('style-flow-width', 7) < minimumWidth) {
      widthNode.value = roundUnit(minimumWidth);
      ajustate.push({ id: 'style-flow-width', label: 'maximum ribbon width', value: widthNode.value, unit: state.unit });
    } else if (numberField('style-flow-width', 7) > maximumWidth) {
      widthNode.value = roundUnit(maximumWidth);
      ajustate.push({ id: 'style-flow-width', label: 'maximum ribbon width', value: widthNode.value, unit: state.unit });
    }
  }
  return ajustate;
}

function activeStyleRecommendation() {
  const panel = sheet();
  return recommendStyleSettings(selectedCutStyle(), {
    ...panel,
    kerfMm: toMm(numberField('kerf', 1.2)),
    minimumOpeningMm: toMm(numberField('min-opening', 2)),
    minimumWebMm: toMm(numberField('min-web', 3)),
    geometryInterpretation: state.geometryInterpretation,
  });
}

function recommendationValue(valueMm) {
  return `${roundUnit(fromMm(valueMm))} ${state.unit}`;
}

function updateStyleGuidance() {
  const card = el('style-guidance');
  if (!card) return;
  const recommendation = activeStyleRecommendation();
  const styleName = CUT_STYLE_NAMES[recommendation.style] || 'This style';
  const profileState = state.cuttingProfile.status === 'verified' ? 'verified' : 'provisional';
  const panelLabel = state.unit === 'in'
    ? `${roundUnit(fromMm(recommendation.shortEdgeMm))} in short edge`
    : `${Math.round(recommendation.shortEdgeMm * 10) / 10} mm short edge`;
  el('style-guidance-title').textContent = `${styleName} · ${panelLabel}`;

  const values = recommendation.values.map(({ label, valueMm }) => `${label} ${recommendationValue(valueMm)}`);
  el('style-guidance-values').textContent = values.length
    ? `Suggested: ${values.join(' · ')}`
    : 'No dimensional preset is needed for this style; its creative controls remain unchanged.';
  el('style-guidance-reason').textContent = values.length
    ? `Scaled from the panel and the ${profileState} “${state.cuttingProfile.name}” profile. The pattern floor preserves at least ${recommendationValue(recommendation.openingMm)} openings and ${recommendationValue(toMm(numberField('min-web', 3)))} finished metal.`
    : `The ${profileState} “${state.cuttingProfile.name}” profile still governs validation and any later supports.`;

  const button = el('btn-apply-style-guidance');
  if (!button) return;
  button.hidden = values.length === 0;
  const current = recommendation.values.every(({ id, valueMm }) => (
    Math.abs(toMm(numberField(id, fromMm(valueMm))) - valueMm) <= 0.06
  ));
  button.disabled = current;
  button.textContent = current ? 'Using suggested start' : 'Apply suggested start';
  card.dataset.state = current ? 'applied' : 'available';
}

function applyStyleGuidance() {
  const recommendation = activeStyleRecommendation();
  for (const { id, valueMm } of recommendation.values) {
    const node = el(id);
    if (node) node.value = String(roundUnit(fromMm(valueMm)));
  }
  rememberStyleSettings();
  reflectRayCentreControls();
  updateRangeOutputs();
  updateStyleGuidance();
  return recommendation;
}

function adjustmentText(adjustment) {
  return `${adjustment.label} to ${adjustment.value} ${adjustment.unit}`;
}

function presentConstraintAdjustments(adjustments, { announce = true } = {}) {
  for (const node of all('[data-profile-adjusted="true"]')) {
    delete node.dataset.profileAdjusted;
    if (node.getAttribute('aria-describedby') === 'constraint-adjustment-note') {
      node.removeAttribute('aria-describedby');
    }
  }
  const note = el('constraint-adjustment-note');
  if (!adjustments.length) {
    note?.setAttribute('hidden', '');
    return;
  }
  for (const adjustment of adjustments) {
    const node = el(adjustment.id);
    if (!node) continue;
    node.dataset.profileAdjusted = 'true';
    node.setAttribute('aria-describedby', 'constraint-adjustment-note');
  }
  const summary = adjustments.map(adjustmentText).join(' and ');
  const copy = el('constraint-adjustment-copy');
  if (copy) {
    copy.textContent = `${summary}. “${state.cuttingProfile.name}” requires ${roundUnit(numberField('min-opening', 2))} ${state.unit} openings and ${roundUnit(numberField('min-web', 3))} ${state.unit} finished metal, so the previous value could not produce the requested geometry.`;
  }
  note?.removeAttribute('hidden');
  if (announce) toast(`Adjusted ${summary} to fit the cutting profile.`);
}

function updateGeometryPreviewState() {
  const container = el('geometry-preview-state');
  const label = el('geometry-preview-state-label');
  const copy = el('geometry-preview-state-copy');
  if (!container || !label || !copy) return;

  if (!state.source && !state.designMask) {
    container.dataset.state = 'empty';
    label.textContent = 'No artwork';
    copy.textContent = 'Import an image to begin.';
    return;
  }
  if (state.source && (state.styleBusy || !hasFreshStyleMask())) {
    container.dataset.state = 'provisional';
    label.textContent = 'Provisional preview';
    copy.textContent = state.offline
      ? 'Local draft only; reconnect to process the final style geometry.'
      : 'A quick draft is visible while the final style geometry is pending.';
    return;
  }
  container.dataset.state = 'processed';
  label.textContent = 'Processed geometry';
  copy.textContent = 'Final style render; manufacturing validation is separate.';
}

let styleToken = 0;
let styleAbort = null;
let renderProgressClock = null;
let toolOptionsKind = null;

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
  updateGeometryPreviewState();
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
  updateViewAvailability();
  if (state.selectedCandidateId) {
    state.selectedCandidateId = null;
    renderCandidates();
  }
  markAutomaticSupportsStale();
  const repairLayerWasActive = manufacturingRepairCount() > 0 &&
    state.manufacturingRepairs.enabled && !state.manufacturingRepairs.stale;
  markManufacturingRepairsStale();
  if (repairLayerWasActive) {
    rebuildSource();
    rebuildDesign();
  }
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
  presentConstraintAdjustments(ajustate);
  updateStyleGuidance();
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
    const decodedTone = payload.tonePreview
      ? await decodeTonePreview(payload.tonePreview)
      : null;
    if (mine !== styleToken || requestedStyle !== selectedCutStyle()) return false;
    state.styleMask = decodeMask(payload.sourceMask);
    state.styleMaskFor = requestedStyle;
    state.styleMaskFresh = true;
    state.vectorDots = requestedStyle === 'puncte'
      ? normalizeVectorDots(payload.info?.vectorDots)
      : null;
    state.tonePreviewCanvas = decodedTone;
    state.tonePreviewFor = decodedTone ? requestedStyle : null;
    state.toneStatistics = payload.tonePreview?.statistics ?? null;
    updateViewAvailability();
    if (requestedStyle === 'raze' && payload.info.radialCenter) {
      const radial = payload.info.radialCenter;
      const centerX = el('style-ray-center-x');
      const centerY = el('style-ray-center-y');
      if (centerX) centerX.value = String(Math.round(radial.x * 1000) / 10);
      if (centerY) centerY.value = String(Math.round(radial.y * 1000) / 10);
      const centerStatus = el('style-ray-center-status');
      if (centerStatus) {
        const diameter = radial.hubDiameterMm ?? Math.round((radial.hubRadiusMm ?? 25) * 2 * 100) / 100;
        centerStatus.textContent = radial.automatic
          ? radial.matchedMetal
            ? `${diameter} mm solid hub auto-placed in existing metal · rays split progressively outward.`
            : `No solid-metal area could contain the ${diameter} mm hub · using the 25% / 50% fallback.`
          : `${diameter} mm solid hub at the manual focal point.`;
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
  syncStylePicker();
  const lineArt = style === 'line-art';
  if (style !== 'icoana' && toolOptionsKind === 'icon') closeToolOptions();
  syncToolRailState();
  el('style-controls')?.removeAttribute('hidden');
  el('tone-controls')?.toggleAttribute('hidden', !lineArt);
  el('style-photo-common')?.toggleAttribute('hidden', lineArt);
  el('tone-adjustments')?.toggleAttribute('hidden', lineArt);
  el('style-curve-control')?.toggleAttribute(
    'hidden', !['lamele', 'hasura', 'puncte', 'gravura', 'flux', 'raze'].includes(style),
  );
  el('btn-restyle')?.toggleAttribute('hidden', lineArt);
  el('style-stencil')?.toggleAttribute('hidden', style !== 'sablon');
  el('style-icon')?.toggleAttribute('hidden', style !== 'icoana');
  el('style-graphic')?.toggleAttribute('hidden', style !== 'grafic');
  el('style-slats')?.toggleAttribute('hidden', style !== 'lamele');
  el('style-hatch')?.toggleAttribute('hidden', style !== 'hasura');
  el('style-dots')?.toggleAttribute('hidden', style !== 'puncte');
  el('style-linework')?.toggleAttribute('hidden', style !== 'linii');
  el('style-woodcut')?.toggleAttribute('hidden', style !== 'gravura');
  el('style-flow')?.toggleAttribute('hidden', style !== 'flux');
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
  updateStyleGuidance();
}

function reflectRayCentreControls() {
  const automatic = el('style-ray-center-auto')?.checked !== false;
  for (const id of ['style-ray-center-x', 'style-ray-center-y']) {
    const node = el(id);
    if (node) node.disabled = automatic || !state.source;
  }
  const status = el('style-ray-center-status');
  if (status && automatic && !state.source) {
    status.textContent = 'The server will place the selected solid hub inside planned metal.';
  } else if (status && !automatic) {
    status.textContent = `${numberField('style-ray-hub', 50)} ${state.unit} solid hub at the manual focal point.`;
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
  updateViewAvailability();
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
  state.kerfPreviewMask = finishedGeometryPreview(state.designMask);
}

function finishedGeometryPreview(mask) {
  const lossMm = kerfErosionMm(
    toMm(numberField('kerf', 1.2)),
    state.geometryInterpretation,
  );
  return lossMm > 0
    ? erodeMaskPhysical(mask, lossMm / 2, sheet())
    : { ...mask, data: Uint8Array.from(mask.data) };
}

function invalidateValidation({ clearAnalysis = false } = {}) {
  cancelManualValidationReview();
  state.revision += 1;
  state.validated = false;
  state.validatedRevision = -1;
  state.exportTimestamp = null;
  state.validation = null;
  state.highlightedIssue = null;
  state.highlightedIssueLocation = 0;
  state.repairPlan = null;
  state.repairPreviewBaseMask = null;
  state.repairPreviewUsesExistingLayer = false;
  state.repairPreviewMask = null;
  state.repairPreviewKerfMask = null;
  state.repairItemIndex = 0;
  state.repairResult = null;
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
function refresh({
  immediate = false,
  reanalyse = true,
  rebuildSourceMask = true,
  preserveManufacturingRepairs = false,
  manualGeometryEdit = false,
} = {}) {
  clearTimeout(rebuildTimer);
  const run = () => {
    rebuildTimer = null;
    if (state.selectedCandidateId) {
      state.selectedCandidateId = null;
      renderCandidates();
    }
    if (rebuildSourceMask) markAutomaticSupportsStale();
    const repairLayerWasActive = manufacturingRepairCount() > 0 &&
      state.manufacturingRepairs.enabled && !state.manufacturingRepairs.stale;
    if (!preserveManufacturingRepairs && !manualGeometryEdit) markManufacturingRepairsStale();
    if (rebuildSourceMask || repairLayerWasActive) rebuildSource();
    rebuildDesign();
    if (manualGeometryEdit) updateManufacturingRepairState();
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
  if (!state.designMask) {
    state.analysis = null;
    state.supportAnalysis = null;
    updateConnectivityCard();
    renderIssues([]);
    return;
  }
  state.analysis = analyzeConnectivity(state.designMask, {
    anchorMask: state.frameMask,
    anchorBoundary: false,
  });
  state.supportAnalysis = analyzeConnectivity(state.kerfPreviewMask ?? state.designMask, {
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
  const detail = el('connectivity-detail');
  if (!card || !count || !detail) return;
  if (!state.analysis) {
    card.dataset.state = 'pending';
    count.textContent = 'Not analysed';
    detail.textContent = 'Run support analysis after importing artwork.';
    return;
  }
  const preCutSeparate = Math.max(0, state.analysis.componentCount - 1);
  const finishedSeparate = Math.max(0, (state.supportAnalysis?.componentCount ?? state.analysis.componentCount) - 1);
  const currentValidation = state.validatedRevision === state.revision ? state.validation : null;
  const narrowWebIssue = currentValidation?.issues?.find((issue) => issue.code === 'MIN_WEB_DISCONNECT');
  const narrowRegions = narrowWebIssue?.details?.componentCount ?? 0;

  if (preCutSeparate > 0) {
    card.dataset.state = 'error';
    count.textContent = `${preCutSeparate} disconnected ${preCutSeparate === 1 ? 'piece' : 'pieces'}`;
    detail.textContent = 'These pieces are separate in the stored contours. Add supports to retain them.';
  } else if (finishedSeparate > 0) {
    card.dataset.state = 'error';
    count.textContent = `${finishedSeparate} ${finishedSeparate === 1 ? 'piece separates' : 'pieces separate'} in the legacy cut model`;
    detail.textContent = 'This legacy project models uncompensated cutter loss. Upgrade its workflow or widen the connections.';
  } else if (narrowRegions > 0) {
    card.dataset.state = 'warn';
    count.textContent = `Connected, with ${narrowRegions} narrow-web ${narrowRegions === 1 ? 'region' : 'regions'}`;
    detail.textContent = `The finished geometry is connected, but these regions rely on connections narrower than ${narrowWebIssue.details.minimumWebMm} mm.`;
  } else {
    card.dataset.state = 'ok';
    count.textContent = 'Everything is one connected finished piece';
    detail.textContent = currentValidation
      ? 'The full-width material core also remains connected.'
      : 'Run validation to check the configured minimum web width.';
  }
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

function currentGeometryIsValidated() {
  return Boolean(
    state.designMask &&
    state.validated &&
    state.validation?.valid &&
    state.validatedRevision === state.revision
  );
}

let manualValidationTimer = null;
let pendingManualReview = null;

function cancelManualValidationReview() {
  if (manualValidationTimer !== null) clearTimeout(manualValidationTimer);
  manualValidationTimer = null;
  pendingManualReview = null;
  state.validationPending = false;
}

function captureManualValidationReview() {
  if (state.validation && state.validatedRevision === state.revision) {
    const issue = state.highlightedIssue;
    const details = issue ? activeIssueDetails(issue) : null;
    return {
      code: issue?.code ?? null,
      severity: issue?.severity ?? null,
      bounds: details?.bounds ? { ...details.bounds } : null,
    };
  }
  return pendingManualReview ? {
    ...pendingManualReview,
    bounds: pendingManualReview.bounds ? { ...pendingManualReview.bounds } : null,
  } : null;
}

function scheduleManualValidationReview(reviewAnchor) {
  if (!reviewAnchor || !state.designMask) return;
  if (manualValidationTimer !== null) clearTimeout(manualValidationTimer);
  pendingManualReview = reviewAnchor;
  const requestedRevision = state.revision;
  state.validationPending = true;
  renderIssues([]);
  updateExportReadiness();
  manualValidationTimer = setTimeout(() => {
    manualValidationTimer = null;
    if (!state.designMask || requestedRevision !== state.revision) {
      pendingManualReview = null;
      state.validationPending = false;
      return;
    }
    const anchor = pendingManualReview;
    pendingManualReview = null;
    const result = validateCurrentGeometry({
      reviewAnchor: anchor,
      focusReview: Boolean(anchor?.code),
    });
    setSidePanel('issues');
    setView('issues');
    markDirty();
    if (result.blockingLocations === 0) {
      toast(result.advisoryLocations > 0
        ? `Manual review cleared every blocker; ${result.advisoryLocations} advisory ${result.advisoryLocations === 1 ? 'location remains' : 'locations remain'}.`
        : 'Manual review cleared every geometry issue. Ready for CAM review.');
    }
  }, 280);
}

async function runValidation() {
  if (!state.designMask) { toast('Import an image first.'); return; }
  cancelManualValidationReview();
  setSidePanel('issues');
  if (state.source && !state.offline && !hasFreshStyleMask()) {
    clearTimeout(styleTimer);
    styleTimer = null;
    toast('Finishing the high-quality render before validation…');
    const ready = await renderStyle();
    if (!ready || !hasFreshStyleMask()) return;
  }
  const { blockingLocations, advisoryLocations } = validateCurrentGeometry();
  toast(state.validation.valid
    ? advisoryLocations > 0
      ? `No blocking geometry issues found; review ${advisoryLocations} advisory ${advisoryLocations === 1 ? 'location' : 'locations'} before CAM review.`
      : 'No blocking geometry issues or advisories found. Ready for CAM review.'
    : `${blockingLocations} blocking geometry ${blockingLocations === 1 ? 'location must' : 'locations must'} be corrected before SVG or DXF export. A watermarked draft PNG remains available.`);
  markDirty();
  await createRecoveryPoint(state.validation.valid ? 'Geometry checks passed' : 'Geometry checks run');
}

function validateCurrentGeometry({ reviewAnchor = null, focusReview = false } = {}) {
  const validationMask = geometryForExport();
  state.validation = validateDesign(validationMask, {
    sheet: sheet(),
    kerfMm: toMm(numberField('kerf', 1.2)),
    minimumWebMm: toMm(numberField('min-web', 3)),
    minimumOpeningMm: toMm(numberField('min-opening', 2)),
    geometryInterpretation: state.geometryInterpretation,
    anchorBoundary: false,
    requireAnchored: false,
    requireSingleComponent: true,
  });
  state.validationPending = false;
  state.validated = state.validation.valid;
  state.validatedRevision = state.revision;
  state.exportTimestamp = state.validation.valid ? new Date() : null;
  state.lastValidatedAt = new Date().toISOString();
  const reviewTarget = nextIssueReviewTarget(state.validation.issues ?? [], reviewAnchor);
  state.highlightedIssue = reviewTarget?.issue ?? null;
  state.highlightedIssueLocation = reviewTarget?.locationIndex ?? 0;
  renderIssues(state.validation.issues ?? []);
  updateConnectivityCard();
  updateExportReadiness();
  if (focusReview && reviewTarget) focusIssue(reviewTarget.issue);
  draw();
  const blockingLocations = countValidationLocations(state.validation, 'error');
  const advisoryLocations = countValidationLocations(state.validation, 'warning');
  return { blockingLocations, advisoryLocations, reviewTarget };
}

/* ----------------------------------------------------------------- issues */

function renderIssues(issues) {
  const list = el('issue-list');
  if (!list) return;
  if (state.validationPending) {
    state.issues = [];
    for (const id of ['issue-total', 'filter-count-all', 'filter-count-error', 'filter-count-warning']) {
      if (el(id)) el(id).textContent = '…';
    }
    const health = el('health-summary');
    if (health) {
      health.dataset.state = 'checking';
      const ring = health.querySelector('.health-ring span');
      const text = health.querySelector('div:last-child');
      if (ring) ring.textContent = '…';
      if (text) text.innerHTML = '<strong>Rechecking geometry</strong><small>The issue queue will continue automatically after this manual edit.</small>';
    }
    renderRepairPanel();
    list.innerHTML = `<li class="issues-empty" data-empty>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 1-2.3-5.7M20 4v7h-7"></path></svg>
      <p><strong>Updating the issue queue…</strong><span>Resolved locations will disappear and the nearest remaining problem will be selected.</span></p></li>`;
    return;
  }
  if (state.highlightedIssue && !issues.includes(state.highlightedIssue)) {
    state.highlightedIssue = null;
    state.highlightedIssueLocation = 0;
  }
  state.issues = issues;

  const errors = issues
    .filter((issue) => issue.severity === 'error')
    .reduce((sum, issue) => sum + issueLocationCount(issue), 0);
  const warnings = issues
    .filter((issue) => issue.severity === 'warning')
    .reduce((sum, issue) => sum + issueLocationCount(issue), 0);
  const total = errors + warnings;
  el('issue-total').textContent = String(total);
  el('filter-count-all').textContent = String(total);
  el('filter-count-error').textContent = String(errors);
  el('filter-count-warning').textContent = String(warnings);

  const health = el('health-summary');
  if (health) {
    const ring = health.querySelector('.health-ring span');
    const text = health.querySelector('div:last-child');
    if (!state.designMask) {
      health.dataset.state = 'idle';
      if (ring) ring.textContent = '—';
      if (text) text.innerHTML = '<strong>Waiting for artwork</strong><small>Connectivity and configured minimum-feature checks will appear here.</small>';
    } else if (errors > 0) {
      health.dataset.state = 'error';
      if (ring) ring.textContent = String(errors);
      const fallingPiece = issues.some((issue) => [
        'DISCONNECTED_RETAINED_MATERIAL',
        'UNSUPPORTED_COMPONENT',
        'KERF_DISCONNECTED_RETAINED_MATERIAL',
        'KERF_UNSUPPORTED_COMPONENT',
      ].includes(issue.code));
      if (text) text.innerHTML = `<strong>${errors} blocking ${errors === 1 ? 'issue' : 'locations'}</strong><small>${
        fallingPiece ? 'One or more pieces could separate from the panel.' : 'Geometry must be repaired before export.'
      }</small>`;
    } else if (warnings > 0) {
      health.dataset.state = 'warning';
      if (ring) ring.textContent = String(warnings);
      if (text) text.innerHTML = `<strong>${warnings} advisory ${warnings === 1 ? 'location' : 'locations'} to review</strong><small>No blockers found; review material thinner than the configured limits.</small>`;
    } else {
      health.dataset.state = 'ok';
      if (ring) ring.textContent = '✓';
      if (text) text.innerHTML = '<strong>Ready for CAM review</strong><small>No blocking issues or advisories found for the configured geometry limits.</small>';
    }
  }

  renderRepairPanel();

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
  if (issue.code === 'MIN_CUT_GAP') {
    const count = details.violationCount ?? details.locations?.length ?? 1;
    const finishedGapMm = details.finishedGapMm ?? details.gapMm;
    return `violation count: ${count} · minimum finished web: ${Math.round(details.minimumWebMm * 100) / 100} mm · closest finished gap: ${Math.round(finishedGapMm * 100) / 100} mm`;
  }
  return Object.entries(details)
    .filter(([key, value]) => key !== 'phase' && key !== 'componentId' &&
      value !== null && value !== undefined && typeof value !== 'object')
    .map(([key, value]) => {
      const label = key.replace(/Mm$/, ' mm').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
      return `${label}: ${typeof value === 'number' ? Math.round(value * 100) / 100 : value}`;
    })
    .join(' · ');
}

/* ----------------------------------------------------- small-feature repair */

const REPAIR_STRATEGY_COPY = Object.freeze({
  manufacturing: Object.freeze({
    preserve: 'Keeps the most image detail: cleans only raster noise, prefers merging cuts, and adds the fewest structural ties.',
    balanced: 'Balances recognizable detail with the configured plasma geometry limits and adds a sparse filter-aware support network.',
    durable: 'Prefers more retained metal: closes marginal cuts, removes more slivers, and accepts broader structural corrections.',
  }),
  'small-openings': Object.freeze({
    preserve: 'Enlarges more recognizable marks and closes only clearly insignificant specks.',
    balanced: 'Keeps recognizable details, but closes isolated specks that do not meet the configured minimum opening.',
    durable: 'Favors more retained metal and closes nearly every marginal feature.',
  }),
  'cut-gaps': Object.freeze({
    preserve: 'Joins nearby cuts into one opening, retaining the negative-space detail while removing the undersized web.',
    balanced: 'Adds a small local metal pad so both cuts remain separate at the selected geometry target.',
    durable: 'Closes the smaller conflicting cut. This preserves the most metal but removes fine detail.',
  }),
  'loose-pieces': Object.freeze({
    preserve: 'Removes only isolated one-cell specks and leaves every larger piece for support.',
    balanced: 'Also removes compact loose pieces smaller than the configured minimum web.',
    durable: 'Removes loose fragments up to twice the minimum web; larger artwork still requires support.',
  }),
});

function repairKindForIssue(issue) {
  if (['KERF_DISCONNECTED_RETAINED_MATERIAL', 'MIN_WEB_NO_SURVIVING_CORE', 'MIN_WEB_DISCONNECT', 'MIN_WEB_THIN_AREAS']
    .includes(issue?.code)) return 'manufacturing';
  if (issue?.code === 'DISCONNECTED_RETAINED_MATERIAL') return 'loose-pieces';
  if (issue?.code === 'MIN_OPENING_UNCUTTABLE') return 'small-openings';
  if (issue?.code === 'MIN_CUT_GAP') return 'cut-gaps';
  return null;
}

function repairableIssue(kind = null) {
  const codes = kind === 'small-openings'
    ? ['MIN_OPENING_UNCUTTABLE']
    : kind === 'cut-gaps'
      ? ['MIN_CUT_GAP']
      : kind === 'loose-pieces'
        ? ['DISCONNECTED_RETAINED_MATERIAL']
        : [
            'DISCONNECTED_RETAINED_MATERIAL',
            'KERF_DISCONNECTED_RETAINED_MATERIAL',
            'MIN_OPENING_UNCUTTABLE',
            'MIN_CUT_GAP',
            'MIN_WEB_NO_SURVIVING_CORE',
            'MIN_WEB_DISCONNECT',
            'MIN_WEB_THIN_AREAS',
          ];
  return state.validation?.issues?.find((issue) => codes.includes(issue.code)) ?? null;
}

function repairIssueCount(issue) {
  return issue ? issueLocationCount(issue) : 0;
}

function repairableValidationLocationCount(validation, severity = 'error') {
  const codes = new Set([
    'DISCONNECTED_RETAINED_MATERIAL',
    'KERF_DISCONNECTED_RETAINED_MATERIAL',
    'MIN_OPENING_UNCUTTABLE',
    'MIN_CUT_GAP',
    'MIN_WEB_NO_SURVIVING_CORE',
    'MIN_WEB_DISCONNECT',
    'MIN_WEB_THIN_AREAS',
  ]);
  return countValidationLocations(validation, severity, codes);
}

function structuralWarningLocationCount(validation) {
  const codes = new Set([
    'MIN_WEB_NO_SURVIVING_CORE',
    'MIN_WEB_DISCONNECT',
    'MIN_WEB_THIN_AREAS',
  ]);
  return countValidationLocations(validation, 'warning', codes);
}

function selectedRepairStrategy() {
  return document.querySelector('input[name="openingRepairStrategy"]:checked')?.value || 'balanced';
}

function repairAllowanceMm() {
  return el('repair-safety')?.value === 'minimum' ? 0 : 0.4;
}

function repairProtectedMask(mask) {
  if (!state.sourceMask || state.sourceMask.width !== mask.width || state.sourceMask.height !== mask.height) return null;
  const protectedMask = { width: mask.width, height: mask.height, data: new Uint8Array(mask.data.length) };
  for (let index = 0; index < mask.data.length; index += 1) {
    // Material introduced by the frame or a support is structural. A repair
    // may join it, but never silently carve it away.
    if (mask.data[index] === RETAINED && state.sourceMask.data[index] !== RETAINED) {
      protectedMask.data[index] = RETAINED;
    }
  }
  return protectedMask;
}

function repairValidation(mask) {
  return validateDesign(mask, {
    sheet: sheet(),
    kerfMm: toMm(numberField('kerf', 1.2)),
    minimumWebMm: toMm(numberField('min-web', 3)),
    minimumOpeningMm: toMm(numberField('min-opening', 2)),
    geometryInterpretation: state.geometryInterpretation,
    anchorBoundary: false,
    requireAnchored: false,
    requireSingleComponent: true,
  });
}

function selectedRepairCategories(mode = 'errors') {
  if (mode === 'warnings') {
    return { slivers: false, gaps: false, webs: false, warnings: true };
  }
  return {
    slivers: el('repair-category-slivers')?.checked !== false,
    gaps: el('repair-category-gaps')?.checked !== false,
    webs: el('repair-category-webs')?.checked !== false,
    warnings: false,
  };
}

function cloneGeometry(mask) {
  return mask ? { ...mask, data: Uint8Array.from(mask.data) } : null;
}

function repairPlanningGeometry() {
  const current = cloneGeometry(geometryForExport());
  const usesExistingLayer = manufacturingRepairCount() > 0 &&
    state.manufacturingRepairs.enabled && !state.manufacturingRepairs.stale;
  return { current, usesExistingLayer };
}

async function buildRepairPreview({ focus = true, mode = 'errors' } = {}) {
  const { current: mask, usesExistingLayer } = repairPlanningGeometry();
  if (!mask) {
    toast('Import artwork before planning manufacturing repairs.');
    return false;
  }
  if (mode === 'warnings' && (!state.validation || countValidationLocations(state.validation, 'error') > 0)) {
    toast('Fix every blocking error before reducing structural warnings.');
    return false;
  }
  const categories = selectedRepairCategories(mode);
  if (!categories.slivers && !categories.gaps && !categories.webs && !categories.warnings) {
    toast('Select at least one repair category.');
    return false;
  }

  const button = el(mode === 'warnings' ? 'btn-preview-warning-repairs' : 'btn-preview-repairs');
  button?.setAttribute('aria-busy', 'true');
  if (button) {
    button.disabled = true;
    button.textContent = mode === 'warnings' ? 'Planning warning corrections…' : 'Planning error repairs…';
  }
  toast(mode === 'warnings'
    ? 'Planning optional structural warning corrections…'
    : 'Planning selected blocking-error repairs…');
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  try {
    const allowance = repairAllowanceMm();
    const strategy = selectedRepairStrategy();
    const minimumWebMm = toMm(numberField('min-web', 3));
    const minimumOpeningMm = toMm(numberField('min-opening', 2));
    const kerfMm = toMm(numberField('kerf', 1.2));
    const targetWebMm = minimumWebMm + allowance;
    const targetOpeningMm = minimumOpeningMm + allowance;
    const requestedWidthMm = Math.max(PLASMA_MIN_WEB_MM, toMm(numberField('bridge-width', 6)));
    const proposal = planManufacturingRepairs(mask, {
      sheet: sheet(),
      strategy,
      categories,
      kerfMm,
      minimumWebMm,
      minimumOpeningMm,
      geometryInterpretation: state.geometryInterpretation,
      targetWebMm,
      targetOpeningMm,
      protectedMask: repairProtectedMask(mask),
      bridgeWidthMm: Math.max(
        requestedWidthMm,
        rasterWebWidthMm(targetWebMm, kerfMm, state.geometryInterpretation),
      ),
      bridgeStrategy: smartBridgeStrategy(),
      maximumBridges: 192,
    });
    const candidate = proposal.mask;
    const plan = {
      kind: proposal.kind,
      mode,
      strategy: proposal.strategy,
      categories: proposal.categories,
      items: proposal.items,
      counts: proposal.counts,
      supportCount: proposal.supportCount,
      outcome: proposal.outcome,
    };
    if (!plan.items.length || !plan.outcome.safeToApply) {
      state.repairPlan = null;
      state.repairPreviewBaseMask = null;
      state.repairPreviewUsesExistingLayer = false;
      state.repairPreviewMask = null;
      state.repairPreviewKerfMask = null;
      const explanation = plan.outcome.notes[0] ??
        'The selected categories found no change that reduced blocking defects without creating new ones.';
      toast(`No automatic changes met the current geometry checks. ${explanation}`);
      renderRepairPanel();
      draw();
      return false;
    }
    state.repairPlan = plan;
    state.repairPreviewBaseMask = mask;
    state.repairPreviewUsesExistingLayer = usesExistingLayer;
    state.repairPreviewMask = candidate;
    state.repairPreviewKerfMask = finishedGeometryPreview(candidate);
    state.repairItemIndex = Math.min(state.repairItemIndex, plan.items.length - 1);
    state.repairResult = null;
    renderRepairPanel();
    if (focus) focusRepairItem(state.repairItemIndex);
    else draw();
    return true;
  } catch (error) {
    console.error(error);
    state.repairPlan = null;
    state.repairPreviewBaseMask = null;
    state.repairPreviewUsesExistingLayer = false;
    state.repairPreviewMask = null;
    state.repairPreviewKerfMask = null;
    toast('Automatic repair planning failed; the geometry was not changed.');
    return false;
  } finally {
    button?.removeAttribute('aria-busy');
    if (button) button.disabled = false;
    renderRepairPanel();
  }
}

function updateRepairPreviewMasks() {
  const mask = state.repairPreviewBaseMask ?? geometryForExport();
  if (!mask || !state.repairPlan) {
    state.repairPreviewMask = null;
    state.repairPreviewKerfMask = null;
    return;
  }
  state.repairPreviewMask = applySmallOpeningRepairPlan(mask, state.repairPlan);
  if (state.repairPlan.kind === 'manufacturing') {
    const validation = repairValidation(state.repairPreviewMask);
    const outcome = state.repairPlan.outcome;
    outcome.afterErrors = countValidationLocations(validation, 'error');
    outcome.afterWarnings = countValidationLocations(validation, 'warning');
    outcome.afterConnectivityErrors = countValidationLocations(validation, 'error', new Set([
      'DISCONNECTED_RETAINED_MATERIAL', 'KERF_DISCONNECTED_RETAINED_MATERIAL',
    ]));
    outcome.afterWeakWebs = countValidationLocations(validation, 'warning', new Set([
      'MIN_WEB_NO_SURVIVING_CORE', 'MIN_WEB_DISCONNECT',
    ]));
    outcome.improved = outcome.afterErrors < outcome.beforeErrors ||
      (outcome.beforeErrors === 0 && outcome.afterErrors === 0 &&
        outcome.afterWarnings < outcome.beforeWarnings);
    outcome.safeToApply = outcome.afterErrors <= outcome.beforeErrors && outcome.improved;
    outcome.complete = outcome.afterErrors === 0;
  }
  state.repairPreviewKerfMask = finishedGeometryPreview(state.repairPreviewMask);
}

function discardRepairPreview() {
  state.repairPlan = null;
  state.repairPreviewBaseMask = null;
  state.repairPreviewUsesExistingLayer = false;
  state.repairPreviewMask = null;
  state.repairPreviewKerfMask = null;
  state.repairItemIndex = 0;
  renderRepairPanel();
  draw();
}

function focusRepairItem(index) {
  if (!state.repairPlan?.items.length) return;
  state.repairItemIndex = (index + state.repairPlan.items.length) % state.repairPlan.items.length;
  const item = state.repairPlan.items[state.repairItemIndex];
  const issue = state.validation?.issues?.find((candidate) => candidate.code === item.issueCode) ??
    repairableIssue(state.repairPlan?.kind);
  if (!issue) {
    focusIssue({ details: { bounds: item.bounds } });
    draw();
    return;
  }
  state.highlightedIssue = issue;
  const locations = issue.details?.locations ?? [];
  const matchingLocation = locations.findIndex((location) =>
    (item.componentId && location.componentId === item.componentId) ||
    (item.componentIds && item.componentIds.every((id) => location.componentIds?.includes(id))));
  state.highlightedIssueLocation = matchingLocation >= 0 ? matchingLocation : 0;
  setSidePanel('issues');
  setView('issues');
  renderIssues(state.issues);
  focusIssue(issue);
  draw();
}

function renderRepairPanel() {
  const panel = el('repair-panel');
  if (!panel) return;
  const result = state.repairResult;
  const issue = repairableIssue(state.repairPlan?.kind ?? result?.kind);
  const kind = state.repairPlan?.kind ?? result?.kind ?? 'manufacturing';
  const manufacturing = kind === 'manufacturing';
  const cutGaps = kind === 'cut-gaps';
  const loosePieces = kind === 'loose-pieces';
  panel.hidden = !issue && !result && manufacturingRepairCount() === 0;
  if (panel.hidden) return;
  updateManufacturingRepairState();

  const blockingLocations = countValidationLocations(state.validation, 'error');
  const warningLocations = structuralWarningLocationCount(state.validation);
  const validationReady = Boolean(state.validation);
  const errorStep = el('repair-error-step');
  const warningStep = el('repair-warning-step');
  const errorButton = el('btn-preview-repairs');
  const warningButton = el('btn-preview-warning-repairs');
  if (errorStep) errorStep.dataset.state = !validationReady
    ? 'locked'
    : blockingLocations > 0 ? 'ready' : 'complete';
  if (warningStep) warningStep.dataset.state = !validationReady || blockingLocations > 0
    ? 'locked'
    : warningLocations > 0 ? 'ready' : 'complete';
  if (errorButton) {
    errorButton.disabled = !validationReady || blockingLocations === 0;
    errorButton.textContent = state.repairPlan?.mode === 'errors'
      ? 'Regenerate error-repair preview'
      : 'Preview error repairs';
  }
  if (warningButton) {
    warningButton.disabled = !validationReady || blockingLocations > 0 || warningLocations === 0;
    warningButton.textContent = state.repairPlan?.mode === 'warnings'
      ? 'Regenerate warning-correction preview'
      : 'Preview warning corrections';
  }
  const errorReadiness = el('repair-error-readiness');
  if (errorReadiness) errorReadiness.textContent = !validationReady
    ? 'Run validation to find blocking errors.'
    : blockingLocations > 0
      ? `${blockingLocations} blocking ${blockingLocations === 1 ? 'location needs' : 'locations need'} correction.`
      : 'Complete · no blocking errors remain.';
  const warningReadiness = el('repair-warning-readiness');
  if (warningReadiness) warningReadiness.textContent = !validationReady
    ? 'Run validation before correcting warnings.'
    : blockingLocations > 0
      ? 'Locked until every blocking error is resolved.'
      : warningLocations > 0
        ? `${warningLocations} structural warning ${warningLocations === 1 ? 'location is' : 'locations are'} eligible for optional correction.`
        : 'Complete · no structural warnings remain.';

  const complete = !issue && Boolean(result);
  panel.classList.toggle('is-complete', complete);
  el('repair-title').textContent = state.repairPlan?.mode === 'warnings'
    ? 'Reduce structural warnings'
    : complete
    ? manufacturing ? 'Manufacturing repairs applied' : loosePieces ? 'Tiny loose pieces removed' : cutGaps ? 'Close cut gaps repaired' : 'Small openings repaired'
    : manufacturing ? 'Repair manufacturing issues' : loosePieces ? 'Remove tiny loose pieces' : cutGaps ? 'Repair close cuts' : 'Repair small openings';
  el('repair-intro').textContent = manufacturing
    ? 'Fix blockers first, then optionally reduce structural warnings. Both stages remain in one reversible layer.'
    : loosePieces
    ? 'Remove only sub-manufacturing specks in one batch. Larger detached artwork remains available for smart supports.'
    : cutGaps
      ? 'Repair every undersized cut gap as a batch, preview the result, then override important exceptions.'
      : 'Repair this repeated problem as a batch, then override important exceptions.';
  const validationErrors = repairableValidationLocationCount(state.validation);
  const validationWarnings = structuralWarningLocationCount(state.validation);
  const plannedCount = state.repairPlan?.mode === 'warnings'
    ? state.repairPlan.outcome.beforeWarnings
    : state.repairPlan?.outcome.beforeErrors;
  const targetCount = state.repairPlan ? plannedCount : (validationErrors || validationWarnings);
  el('repair-count').textContent = complete ? '✓' : String(manufacturing
    ? targetCount
    : repairIssueCount(issue));
  const applied = el('repair-applied');
  applied.hidden = !result;
  if (result) {
    const remaining = result.remaining ?? repairIssueCount(issue);
    const noun = result.mode === 'warnings'
      ? 'warning corrections'
      : result.kind === 'manufacturing'
      ? 'manufacturing repair groups'
      : result.kind === 'loose-pieces'
      ? 'loose pieces removed'
      : result.kind === 'cut-gaps' ? 'gap repairs' : 'opening repairs';
    el('repair-applied-message').textContent = result.running
      ? `${result.count} ${noun} applied · validating…`
      : remaining > 0
        ? `${result.count} repairs applied · ${remaining} still need review.`
        : result.remainingWarnings > 0
          ? `${result.count} ${noun} applied · no blockers; ${result.remainingWarnings} warning locations remain.`
        : `${result.count} repairs applied; the configured geometry checks pass.`;
  }
  if (!issue && !state.repairPlan) return;

  const strategy = selectedRepairStrategy();
  el('repair-strategy-description').textContent = REPAIR_STRATEGY_COPY[kind][strategy];
  el('repair-target-control').hidden = loosePieces;
  const preview = el('repair-preview');
  preview.hidden = !state.repairPlan;
  if (!state.repairPlan) return;

  const { counts, items } = state.repairPlan;
  const strategyName = { preserve: 'Preserve detail', balanced: 'Balanced', durable: 'Durable' }[state.repairPlan.strategy];
  el('repair-plan-strategy').textContent = strategyName;
  el('repair-close-label').textContent = manufacturing ? 'Clean / close' : loosePieces ? 'Remove' : cutGaps ? 'Close cut' : 'Close';
  el('repair-enlarge-label').textContent = manufacturing ? 'Widen / support' : cutGaps ? 'Widen web' : 'Enlarge';
  el('repair-merge-label').textContent = manufacturing ? 'Merge cuts' : cutGaps ? 'Merge cuts' : 'Merge';
  el('repair-enlarge-label').closest('div').hidden = loosePieces;
  el('repair-merge-label').closest('div').hidden = loosePieces;
  el('repair-close-count').textContent = String(counts.close);
  el('repair-enlarge-count').textContent = String(counts.enlarge);
  el('repair-merge-count').textContent = String(counts.merge);
  el('btn-apply-repairs').textContent = manufacturing
    ? state.repairPlan.mode === 'warnings' ? 'Apply warning corrections' : 'Apply error repairs'
    : `Apply ${items.length} repairs`;
  const outcome = state.repairPlan.outcome;
  el('repair-before-errors').textContent = String(outcome?.beforeErrors ?? '—');
  el('repair-after-errors').textContent = String(outcome?.afterErrors ?? '—');
  el('repair-before-warnings').textContent = String(outcome?.beforeWarnings ?? '—');
  el('repair-after-warnings').textContent = String(outcome?.afterWarnings ?? '—');
  const status = el('repair-plan-status');
  const note = el('repair-plan-note');
  const applicable = outcome?.safeToApply === true;
  const fullyRepaired = applicable && outcome.complete;
  status.dataset.state = applicable ? 'safe' : 'unsafe';
  status.textContent = fullyRepaired
    ? state.repairPlan.categories.warnings && outcome.afterWarnings > 0
      ? `Preview resolves all blockers; ${outcome.afterWarnings} advisory ${outcome.afterWarnings === 1 ? 'location remains' : 'locations remain'}.`
      : 'Preview resolves all detected blocking locations.'
    : applicable
      ? `Preview improves the geometry checks; ${outcome.afterErrors} blocking ${outcome.afterErrors === 1 ? 'location remains' : 'locations remain'} for review.`
      : 'Preview does not improve the geometry checks and cannot be applied.';
  const notes = outcome?.notes ?? [];
  note.hidden = notes.length === 0;
  note.textContent = notes.join(' ');
  el('btn-apply-repairs').disabled = !applicable;

  state.repairItemIndex = Math.min(state.repairItemIndex, items.length - 1);
  const item = items[state.repairItemIndex];
  el('btn-repair-next').textContent = `${state.repairItemIndex + 1} / ${items.length} · Next`;
  const actionCopy = {
    close: loosePieces || item.category === 'sliver' ? 'remove this unmanufacturable metal speck' : cutGaps || item.category === 'gap' ? 'close the smaller cut' : 'close it as an insignificant speck',
    enlarge: cutGaps || item.category === 'gap' ? 'add metal locally to widen the web' : 'enlarge it into a cuttable opening',
    merge: cutGaps || item.category === 'gap' ? 'merge the cuts into one opening' : 'merge it with the nearby cut',
  }[item.action];
  const measured = item.category === 'warning'
    ? Math.round(item.addedAreaMm2)
    : loosePieces || item.category === 'sliver'
    ? item.pixelCount
    : Math.round(((cutGaps || item.category === 'gap')
      ? item.finishedGapMm ?? item.gapMm
      : item.equivalentDiameterMm) * 10) / 10;
  el('repair-current-description').textContent = manufacturing && item.category === 'web'
    ? item.role === 'connectivity'
      ? `${item.supportCount} filter-aware ${item.supportCount === 1 ? 'tie connects' : 'ties connect'} detached finished material.`
      : `${item.supportCount} filter-aware ${item.supportCount === 1 ? 'tie reinforces' : 'ties reinforce'} disconnected full-width material regions.`
    : manufacturing && item.category === 'warning'
      ? `${item.pixelCount} raster cells add about ${measured} mm² of metal to thicken weak material.`
    : manufacturing && item.category === 'sliver'
      ? `${item.pixelCount} raster ${item.pixelCount === 1 ? 'cell' : 'cells'}; this detached sliver will be removed.`
      : manufacturing && item.category === 'gap'
        ? `${measured} mm gap; the batch plan will ${actionCopy}.`
        : manufacturing && item.category === 'opening'
          ? `About ${measured} mm across; the batch plan will ${actionCopy}.`
      : loosePieces
    ? `${measured} raster ${measured === 1 ? 'cell' : 'cells'}; the batch plan will ${actionCopy}.`
    : cutGaps
      ? `${measured} mm gap; the batch plan will ${actionCopy}.`
      : `About ${measured} mm across; the batch plan will ${actionCopy}.`;
  const actionLabels = item.category === 'warning'
    ? { close: 'Close', enlarge: 'Thicken', merge: 'Merge' }
    : loosePieces || item.category === 'sliver'
    ? { close: 'Remove speck', enlarge: 'Enlarge', merge: 'Merge' }
    : cutGaps || item.category === 'gap'
      ? { close: 'Close cut', enlarge: 'Widen web', merge: 'Merge cuts' }
      : { close: 'Close', enlarge: 'Enlarge', merge: 'Merge' };
  for (const button of all('[data-repair-action]')) {
    const action = button.dataset.repairAction;
    button.textContent = actionLabels[action];
    button.hidden = item.category === 'warning'
      ? action !== 'enlarge'
      : (loosePieces || item.category === 'sliver') && action !== 'close';
    button.disabled = item.availableActions[action] !== true;
    button.setAttribute('aria-pressed', String(item.action === action));
  }
}

function overrideRepairAction(action) {
  const item = state.repairPlan?.items[state.repairItemIndex];
  if (!item) return;
  const changed = setSmallOpeningRepairAction(state.repairPlan, item.id, action, {
    similar: el('repair-similar')?.checked === true,
  });
  if (!changed) return;
  updateRepairPreviewMasks();
  renderRepairPanel();
  draw();
}

async function applyRepairPlan() {
  if (!state.sourceMask || !state.repairPlan?.items.length ||
      !state.repairPreviewBaseMask || !state.repairPreviewMask) return;
  if (state.repairPlan.outcome?.safeToApply !== true) {
    toast('This preview does not improve the complete geometry-check result, so it cannot be applied.');
    return;
  }
  // Merge this pass into the active reversible layer. Warning correction can
  // therefore build on error repair without replacing the earlier edits.
  const { keep, remove } = mergeRepairLayerEdits(
    state.repairPreviewBaseMask,
    state.repairPreviewMask,
    state.repairPreviewUsesExistingLayer ? state.manufacturingRepairs : null,
  );
  if (keep.size + remove.size === 0) {
    toast('The proposed repairs do not change the editable artwork.');
    return;
  }

  const repairCount = state.repairPlan.items.length;
  const repairKind = state.repairPlan.kind;
  const repairMode = state.repairPlan.mode;
  const repairSummary = {
    ...state.repairPlan.outcome,
    repairCount,
    mode: repairMode,
    supportCount: state.repairPlan.supportCount ?? 0,
    strategy: state.repairPlan.strategy,
    categories: state.repairPlan.categories,
  };
  state.manufacturingRepairs = {
    keep,
    remove,
    enabled: true,
    stale: false,
    summary: repairSummary,
  };
  state.repairPlan = null;
  state.repairPreviewBaseMask = null;
  state.repairPreviewUsesExistingLayer = false;
  state.repairPreviewMask = null;
  state.repairPreviewKerfMask = null;
  refresh({ immediate: true, preserveManufacturingRepairs: true });
  state.repairResult = {
    kind: repairKind, mode: repairMode, count: repairCount, running: true, remaining: null,
  };
  updateManufacturingRepairState();
  pushHistory();
  renderRepairPanel();
  await runValidation();
  const remaining = countValidationLocations(state.validation, 'error');
  const remainingWarnings = countValidationLocations(state.validation, 'warning');
  state.repairResult = {
    kind: repairKind, mode: repairMode, count: repairCount, running: false, remaining, remainingWarnings,
  };
  renderRepairPanel();
  toast(remaining > 0
    ? `Repair layer applied; ${remaining} blocking locations still need review.`
    : remainingWarnings > 0
      ? repairMode === 'warnings'
        ? `Warning corrections applied; ${remainingWarnings} warning locations remain for review.`
        : `Error repairs applied; no blockers and ${remainingWarnings} warning locations remain. Optional warning correction is now available.`
      : `Manufacturing repair layer applied and checked.`);
  await createRecoveryPoint(repairMode === 'warnings'
    ? 'Structural warnings repaired'
    : 'Manufacturing errors repaired');
}

function undoLastRepair() {
  if (!state.repairResult || state.undo.length === 0) return;
  state.repairResult = null;
  undo();
  setSidePanel('issues');
  setView('issues');
  toast('Automatic repairs undone.');
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

function clearIssueHighlight() {
  if (!state.highlightedIssue) return false;
  state.highlightedIssue = null;
  state.highlightedIssueLocation = 0;
  renderIssues(state.issues);
  draw();
  return true;
}

function toggleIssueHighlight(index) {
  const issue = state.issues[index];
  if (!issue?.details?.bounds) return;
  const locations = issue.details.locations;
  if (state.highlightedIssue === issue && Array.isArray(locations) && locations.length > 1) {
    state.highlightedIssueLocation = (state.highlightedIssueLocation + 1) % locations.length;
  } else if (state.highlightedIssue === issue) {
    clearIssueHighlight();
    return;
  } else {
    state.highlightedIssue = issue;
    state.highlightedIssueLocation = 0;
  }
  if (issue.code === 'MIN_OPENING_UNCUTTABLE') {
    state.repairItemIndex = state.highlightedIssueLocation;
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

function drawPlacedImage(context, preview, mask, background = '#e5e8e5') {
  const currentSheet = sheet();
  context.fillStyle = background;
  context.fillRect(0, 0, mask.width, mask.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  const bounds = state.contentBounds;
  const sourceSize = state.contentSourceSize;
  const sourceX = bounds && sourceSize ? bounds.x / sourceSize.width * preview.width : 0;
  const sourceY = bounds && sourceSize ? bounds.y / sourceSize.height * preview.height : 0;
  const sourceWidth = bounds && sourceSize ? bounds.width / sourceSize.width * preview.width : preview.width;
  const sourceHeight = bounds && sourceSize ? bounds.height / sourceSize.height * preview.height : preview.height;
  const destinationWidth = state.placement.widthMm / currentSheet.widthMm * mask.width;
  const destinationHeight = state.placement.heightMm / currentSheet.heightMm * mask.height;
  const destinationCenterX = (state.placement.xMm + state.placement.widthMm / 2) /
    currentSheet.widthMm * mask.width;
  const destinationCenterY = (state.placement.yMm + state.placement.heightMm / 2) /
    currentSheet.heightMm * mask.height;
  context.save();
  context.translate(destinationCenterX, destinationCenterY);
  context.rotate((state.placement.rotationDeg || 0) * Math.PI / 180);
  context.drawImage(
    preview,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    -destinationWidth / 2,
    -destinationHeight / 2,
    destinationWidth,
    destinationHeight,
  );
  context.restore();
}

function updateToneInspector(preview = null) {
  const inspector = el('tone-inspector');
  const photoStyle = selectedCutStyle() !== 'line-art';
  inspector?.toggleAttribute('hidden', !photoStyle);
  if (!photoStyle) return;
  const tonePreview = preview || currentTonePreview();
  const copy = el('tone-inspector-copy');
  if (copy) {
    copy.textContent = state.styleBusy
      ? 'Updating the interpretation; controls remain available while the preview renders.'
      : tonePreview?.provisional
        ? 'Source luminance preview. Re-render to reconstruct the exact artwork interpretation.'
        : tonePreview
          ? 'The actual tonal field used before the cut pattern.'
          : 'Adjustments remain available; render the artwork to inspect its tonal distribution.';
  }
  for (const name of ['dark', 'midtone', 'light']) {
    const value = Number(tonePreview?.statistics?.[name]);
    if (el(`tone-${name}`)) el(`tone-${name}`).textContent = Number.isFinite(value)
      ? `${Math.round(value * 100)}%`
      : '—';
  }
}

function draw() {
  const canvas = el('editor-canvas');
  const overlay = el('overlay-canvas');
  const vectorLayer = el('vector-dot-layer');
  if (!canvas || !overlay) return;
  updateTouchupHud();
  const mask = state.designMask;
  const stage = el('canvas-stage');
  if (stage) stage.dataset.view = state.view;
  const tonePreview = state.view === 'tone' ? currentTonePreview() : null;
  updateToneInspector(tonePreview);
  el('empty-state')?.toggleAttribute('hidden', Boolean(mask));
  stage?.classList.toggle('has-design', Boolean(mask));
  if (!mask) {
    if (stage) { stage.style.width = ''; stage.style.height = ''; stage.style.transform = ''; }
    clearVectorDotPreview(vectorLayer);
    clear(canvas); clear(overlay); renderRulers(); return;
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
    clearVectorDotPreview(vectorLayer);
    drawPlacedImage(context, state.source.previewCanvas, mask);
    drawOverlay(overlay, mask);
    applyTransform();
    return;
  }
  if (state.view === 'tone' && tonePreview?.canvas && state.placement) {
    clearVectorDotPreview(vectorLayer);
    drawPlacedImage(context, tonePreview.canvas, mask, '#f4f4f1');
    drawOverlay(overlay, mask);
    applyTransform();
    return;
  }
  const image = context.createImageData(mask.width, mask.height);
  const source = state.view === 'source' && state.sourceMask ? state.sourceMask : mask;
  // Kerf simulation shows what survives the cutter, which is the honest
  // preview of the finished part rather than the ideal geometry.
  // While a freehand stroke is moving, show its lightweight pre-kerf geometry.
  // Rebuilding the kerf simulation for every pointer event makes the brush lag
  // behind the cursor; the exact post-kerf result is restored on pointer-up.
  const kerf = !state.touchupLive && el('simulate-kerf')?.checked && state.kerfPreviewMask;
  const repairPreviewVisible = Boolean(
    state.repairPreviewMask && ['material', 'backlit', 'issues'].includes(state.view),
  );
  const shown = repairPreviewVisible
    ? kerf ? state.repairPreviewKerfMask : state.repairPreviewMask
    : (state.view === 'material' || state.view === 'backlit') && kerf
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
  else if (highlighted?.phase === 'thinArea') highlightedLabels = state.validation?.thinAreaZones?.labels;
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

  drawVectorDotPreview(vectorLayer, mask, {
    visible: !repairPreviewVisible && ['source', 'material', 'backlit'].includes(state.view),
    afterKerf: Boolean(kerf),
  });

  drawOverlay(overlay, mask);
  applyTransform();
}

function clearVectorDotPreview(layer) {
  if (!layer) return;
  layer.replaceChildren();
  layer.hidden = true;
}

function drawVectorDotPreview(layer, mask, { visible = true, afterKerf = false } = {}) {
  const circles = visible ? exactVectorDotHoles() : [];
  if (!layer || !circles.length) {
    clearVectorDotPreview(layer);
    return;
  }
  const currentSheet = sheet();
  const scaleX = mask.width / currentSheet.widthMm;
  const scaleY = mask.height / currentSheet.heightMm;
  const kerfExpansionMm = afterKerf
    ? kerfErosionMm(toMm(numberField('kerf', 1.2)), state.geometryInterpretation) / 2
    : 0;
  let patchPath = '';
  let circlePath = '';
  for (const circle of circles) {
    const cx = circle.cxMm * scaleX;
    const cy = circle.cyMm * scaleY;
    const rx = (circle.radiusMm + kerfExpansionMm) * scaleX;
    const ry = (circle.radiusMm + kerfExpansionMm) * scaleY;
    const patchRx = rx + 1.25;
    const patchRy = ry + 1.25;
    patchPath += `M${(cx - patchRx).toFixed(3)} ${(cy - patchRy).toFixed(3)}h${(patchRx * 2).toFixed(3)}v${(patchRy * 2).toFixed(3)}h-${(patchRx * 2).toFixed(3)}Z`;
    circlePath += `M${(cx + rx).toFixed(3)} ${cy.toFixed(3)}A${rx.toFixed(3)} ${ry.toFixed(3)} 0 1 0 ${(cx - rx).toFixed(3)} ${cy.toFixed(3)}A${rx.toFixed(3)} ${ry.toFixed(3)} 0 1 0 ${(cx + rx).toFixed(3)} ${cy.toFixed(3)}Z`;
  }
  const namespace = 'http://www.w3.org/2000/svg';
  const patch = document.createElementNS(namespace, 'path');
  const holes = document.createElementNS(namespace, 'path');
  const metal = state.view === 'backlit' ? '#141c21' : '#2a2e34';
  const removed = state.view === 'backlit' ? '#fff1be' : '#f5f4f0';
  patch.setAttribute('d', patchPath);
  patch.setAttribute('fill', metal);
  holes.setAttribute('d', circlePath);
  holes.setAttribute('fill', removed);
  layer.setAttribute('viewBox', `0 0 ${mask.width} ${mask.height}`);
  layer.setAttribute('width', String(mask.width));
  layer.setAttribute('height', String(mask.height));
  layer.replaceChildren(patch, holes);
  layer.hidden = false;
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

  if (state.tool === 'artwork' && state.placement) {
    const corners = [
      pointFromArtworkPlacement(state.placement, 0, 0),
      pointFromArtworkPlacement(state.placement, 1, 0),
      pointFromArtworkPlacement(state.placement, 1, 1),
      pointFromArtworkPlacement(state.placement, 0, 1),
    ];
    context.save();
    context.strokeStyle = '#e85f35';
    context.lineWidth = Math.max(1.5, 2 / Math.max(state.zoom, 0.1));
    context.setLineDash([8 / Math.max(state.zoom, 0.1), 5 / Math.max(state.zoom, 0.1)]);
    context.beginPath();
    context.moveTo(corners[0].x * pxPerMm, corners[0].y * (mask.height / heightMm));
    for (const corner of corners.slice(1)) {
      context.lineTo(corner.x * pxPerMm, corner.y * (mask.height / heightMm));
    }
    context.closePath();
    context.stroke();
    context.restore();
  }

  for (const bridge of state.bridges) {
    const selected = bridge === state.selectedBridge;
    const hovered = bridge === state.hoveredBridge;
    const staleAutomatic = state.automaticSupportsStale && bridge.source === 'automatic';
    const fallbackAutomatic = bridge.source === 'automatic' && bridge.fallback === true;
    const stabilizer = bridge.stabilizer === true;
    const needsReview = staleAutomatic || fallbackAutomatic;
    const startX = bridge.start.x * pxPerMm;
    const startY = bridge.start.y * (mask.height / heightMm);
    const endX = bridge.end.x * pxPerMm;
    const endY = bridge.end.y * (mask.height / heightMm);
    if (hovered && !selected) {
      context.strokeStyle = 'rgba(31, 122, 90, .28)';
      context.lineWidth = Math.max(4, bridge.width * pxPerMm + 6 / Math.max(state.zoom, 0.1));
      context.lineCap = 'round';
      context.setLineDash([]);
      context.beginPath();
      context.moveTo(startX, startY);
      context.lineTo(endX, endY);
      context.stroke();
    }
    context.strokeStyle = selected
      ? '#1f7a5a'
      : needsReview
        ? 'rgba(196, 126, 20, .8)'
        : stabilizer ? 'rgba(0, 143, 156, .72)' : 'rgba(31, 122, 90, .55)';
    context.lineWidth = Math.max(2, bridge.width * pxPerMm);
    context.lineCap = 'round';
    context.setLineDash(needsReview ? [Math.max(4, 8 / state.zoom), Math.max(3, 5 / state.zoom)] : []);
    context.beginPath();
    context.moveTo(startX, startY);
    context.lineTo(endX, endY);
    context.stroke();
    context.setLineDash([]);
  }

  if (state.supportProposal) {
    for (const bridge of state.supportProposal.bridges) {
      const startX = bridge.start.x * pxPerMm;
      const startY = bridge.start.y * (mask.height / heightMm);
      const endX = bridge.end.x * pxPerMm;
      const endY = bridge.end.y * (mask.height / heightMm);
      context.strokeStyle = bridge.fallback ? '#d6941a' : '#008f9c';
      context.lineWidth = Math.max(2, bridge.width * pxPerMm);
      context.lineCap = 'round';
      context.setLineDash([Math.max(5, 9 / state.zoom), Math.max(3, 5 / state.zoom)]);
      context.beginPath();
      context.moveTo(startX, startY);
      context.lineTo(endX, endY);
      context.stroke();
      context.setLineDash([]);
    }
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
    if (state.bridgePreview.pendingTap) {
      const x = state.bridgePreview.start.x * pxPerMm;
      const y = state.bridgePreview.start.y * (mask.height / heightMm);
      const radius = Math.max(5, 8 / Math.max(state.zoom, 0.1));
      context.fillStyle = '#f5f4f0';
      context.strokeStyle = '#1f7a5a';
      context.lineWidth = Math.max(2, 2 / Math.max(state.zoom, 0.1));
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
  }

  if (state.selectedBridge) {
    const selectedStart = {
      x: state.selectedBridge.start.x * pxPerMm,
      y: state.selectedBridge.start.y * (mask.height / heightMm),
    };
    const selectedEnd = {
      x: state.selectedBridge.end.x * pxPerMm,
      y: state.selectedBridge.end.y * (mask.height / heightMm),
    };
    context.lineCap = 'round';
    context.setLineDash([]);
    context.strokeStyle = 'rgba(255, 255, 255, .92)';
    context.lineWidth = Math.max(4, state.selectedBridge.width * pxPerMm + 8 / Math.max(state.zoom, 0.1));
    context.beginPath();
    context.moveTo(selectedStart.x, selectedStart.y);
    context.lineTo(selectedEnd.x, selectedEnd.y);
    context.stroke();
    context.strokeStyle = '#1f7a5a';
    context.lineWidth = Math.max(2, state.selectedBridge.width * pxPerMm);
    context.beginPath();
    context.moveTo(selectedStart.x, selectedStart.y);
    context.lineTo(selectedEnd.x, selectedEnd.y);
    context.stroke();
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
    const midpoint = {
      x: (state.selectedBridge.start.x + state.selectedBridge.end.x) / 2 * pxPerMm,
      y: (state.selectedBridge.start.y + state.selectedBridge.end.y) / 2 * (mask.height / heightMm),
    };
    const moveRadius = Math.max(3, 5 / Math.max(state.zoom, 0.1));
    context.fillStyle = '#1f7a5a';
    context.beginPath();
    context.arc(midpoint.x, midpoint.y, moveRadius, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = '#f5f4f0';
    context.lineWidth = Math.max(1, 1.5 / Math.max(state.zoom, 0.1));
    context.beginPath();
    context.moveTo(midpoint.x - moveRadius * 0.45, midpoint.y);
    context.lineTo(midpoint.x + moveRadius * 0.45, midpoint.y);
    context.moveTo(midpoint.x, midpoint.y - moveRadius * 0.45);
    context.lineTo(midpoint.x, midpoint.y + moveRadius * 0.45);
    context.stroke();
  }

  const selectedEdit = selectedManualEdit();
  if (selectedEdit) {
    context.save();
    context.strokeStyle = '#e85f35';
    context.lineWidth = Math.max(2, 3 / Math.max(state.zoom, 0.1));
    context.setLineDash([Math.max(4, 7 / state.zoom), Math.max(3, 4 / state.zoom)]);
    if (selectedEdit.shape === 'stroke') {
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.beginPath();
      selectedEdit.pointsMm.forEach((point, index) => {
        const x = point.x * pxPerMm;
        const y = point.y * (mask.height / heightMm);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      if (selectedEdit.pointsMm.length === 1) {
        const point = selectedEdit.pointsMm[0];
        context.arc(point.x * pxPerMm, point.y * (mask.height / heightMm),
          Math.max(3, selectedEdit.widthMm * pxPerMm / 2), 0, Math.PI * 2);
      }
      context.stroke();
    } else {
      const indices = manualEditIndices(mask, sheet(), selectedEdit);
      if (indices.length) {
        let minX = mask.width; let minY = mask.height; let maxX = 0; let maxY = 0;
        for (const index of indices) {
          const x = index % mask.width;
          const y = Math.floor(index / mask.width);
          minX = Math.min(minX, x); minY = Math.min(minY, y);
          maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
        context.strokeRect(minX, minY, Math.max(1, maxX - minX + 1), Math.max(1, maxY - minY + 1));
      }
    }
    context.restore();
  }

  if (state.touchupPreview && ['keep', 'remove', 'restore'].includes(state.tool)) {
    const preview = state.touchupPreview;
    const yPerMm = mask.height / heightMm;
    const radiusMm = preview.diameterMm / 2;
    const color = state.tool === 'keep'
      ? 'rgba(31, 122, 90, .88)'
      : state.tool === 'remove' ? 'rgba(220, 93, 48, .88)' : 'rgba(66, 88, 101, .88)';
    context.strokeStyle = color;
    context.fillStyle = state.tool === 'keep'
      ? 'rgba(31, 122, 90, .16)'
      : state.tool === 'remove' ? 'rgba(220, 93, 48, .16)' : 'rgba(66, 88, 101, .12)';
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

function renderRulerTicks(container, result, axis) {
  if (!container) return;
  const origin = axis === 'horizontal' ? container.offsetLeft : container.offsetTop;
  const fragment = document.createDocumentFragment();
  for (const tick of result.ticks) {
    const node = document.createElement('span');
    node.className = 'ruler-tick';
    node.style[axis === 'horizontal' ? 'left' : 'top'] = `${tick.positionPx - origin}px`;
    node.textContent = formatRulerValue(tick.value, result.step);
    fragment.append(node);
  }
  container.replaceChildren(fragment);
}

function renderRulers() {
  const viewport = el('canvas-viewport');
  const canvas = el('editor-canvas');
  const horizontal = el('ruler-horizontal');
  const vertical = el('ruler-vertical');
  const unit = el('ruler-unit');
  if (unit) unit.textContent = state.unit;
  if (!viewport || !canvas || !horizontal || !vertical || !state.designMask) {
    horizontal?.replaceChildren();
    vertical?.replaceChildren();
    return;
  }

  const currentSheet = sheet();
  const width = state.unit === 'in' ? currentSheet.widthMm / MM_PER_INCH : currentSheet.widthMm;
  const height = state.unit === 'in' ? currentSheet.heightMm / MM_PER_INCH : currentSheet.heightMm;
  const viewportBounds = viewport.getBoundingClientRect();
  const canvasBounds = canvas.getBoundingClientRect();
  if (canvasBounds.width <= 0 || canvasBounds.height <= 0) {
    horizontal.replaceChildren();
    vertical.replaceChildren();
    return;
  }
  const canvasLeft = canvasBounds.left - viewportBounds.left;
  const canvasTop = canvasBounds.top - viewportBounds.top;
  const horizontalStart = horizontal.offsetLeft;
  const verticalStart = vertical.offsetTop;
  const horizontalTicks = rulerTicks({
    extent: width,
    pixelsPerUnit: canvasBounds.width / width,
    offsetPx: canvasLeft,
    viewportStartPx: horizontalStart,
    viewportEndPx: horizontalStart + horizontal.clientWidth,
  });
  const verticalTicks = rulerTicks({
    extent: height,
    pixelsPerUnit: canvasBounds.height / height,
    offsetPx: canvasTop,
    viewportStartPx: verticalStart,
    viewportEndPx: verticalStart + vertical.clientHeight,
  });
  renderRulerTicks(horizontal, horizontalTicks, 'horizontal');
  renderRulerTicks(vertical, verticalTicks, 'vertical');
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
  renderRulers();
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
  const profileStatus = state.cuttingProfile.status === 'verified' ? 'Verified' : 'Provisional';
  const manufacturingSummary = `${state.cuttingProfile.name} · ${profileStatus} · ${roundUnit(numberField('kerf', 1.2))} ${state.unit} kerf · ${roundUnit(numberField('min-web', 3))} ${state.unit} gaps · ${roundUnit(numberField('min-opening', 2))} ${state.unit} openings`;
  for (const node of all('[data-manufacturing-summary]')) node.textContent = manufacturingSummary;
  const webNote = el('prekerf-web-note');
  if (webNote) {
    const finished = toMm(numberField('min-web', 3));
    const kerf = toMm(numberField('kerf', 1.2));
    webNote.textContent = isLegacyGeometryInterpretation(state.geometryInterpretation)
      ? `Legacy geometry keeps ${roundUnit(fromMm(finished + kerf))} ${state.unit} in the raster so an uncompensated ${roundUnit(fromMm(kerf))} ${state.unit} cut leaves ${roundUnit(fromMm(finished))} ${state.unit}.`
      : `Filters draw the requested ${roundUnit(fromMm(finished))} ${state.unit} finished web. Apply the ${roundUnit(fromMm(kerf))} ${state.unit} kerf once, as inside/outside compensation in CAM.`;
  }
  renderCuttingProfileStatus();
  updateGeometryContractUi();
  updateStyleGuidance();
  updateGeometryPreviewState();
}

function updateGeometryContractUi() {
  const legacy = isLegacyGeometryInterpretation(state.geometryInterpretation);
  const card = el('geometry-contract');
  if (card) card.dataset.mode = legacy ? 'legacy' : 'finished';
  if (el('geometry-contract-title')) {
    el('geometry-contract-title').textContent = legacy
      ? 'Legacy uncompensated workflow'
      : 'Finished-edge CAM workflow';
  }
  if (el('geometry-contract-copy')) {
    el('geometry-contract-copy').textContent = legacy
      ? 'This project keeps its historical kerf allowance and cut simulation. Its artwork has not been changed. Upgrade explicitly before using CAM compensation.'
      : 'Artwork and exports describe final part edges. Apply inside/outside kerf compensation once in CAM.';
  }
  el('btn-upgrade-geometry-contract')?.toggleAttribute('hidden', !legacy);
  if (el('geometry-preview-design-label')) {
    el('geometry-preview-design-label').textContent = legacy ? 'Before kerf' : 'Design contours';
  }
  if (el('geometry-preview-finished-label')) {
    el('geometry-preview-finished-label').textContent = legacy ? 'After uncompensated cut' : 'Finished part';
  }
  if (el('geometry-preview-help')) {
    el('geometry-preview-help').textContent = legacy
      ? 'Legacy projects subtract the cutter width because their stored raster predates the finished-edge CAM contract.'
      : 'With CAM compensation, the design contours are the intended finished material edges.';
  }
  if (el('export-kerf-copy')) {
    el('export-kerf-copy').textContent = legacy
      ? 'Off — this legacy geometry expects uncompensated cutter paths'
      : 'Off — apply inside/outside compensation once in CAM';
  }
  if (el('cam-contract-note')) {
    el('cam-contract-note').innerHTML = legacy
      ? '<strong>Legacy CAM setup:</strong> Do not add compensation to this export unless you first upgrade and re-render the project.'
      : '<strong>CAM setup:</strong> These contours are finished part boundaries. Apply the configured kerf once in CAM; do not cut them as uncompensated centre paths.';
  }
}

async function upgradeGeometryContract() {
  if (!isLegacyGeometryInterpretation(state.geometryInterpretation)) return;
  state.geometryInterpretation = FINISHED_BOUNDARY_CAM;
  state.lastValidatedAt = null;
  markManufacturingRepairsStale();
  markAutomaticSupportsStale();
  if (state.source) invalidateStyleRender({ useLocalPreview: state.mode === 'line-art' });
  refresh({ immediate: true });
  pushHistory();
  updateGeometryContractUi();
  toast(state.source
    ? 'Using finished edges. Re-rendering artwork; apply kerf compensation once in CAM.'
    : 'Using finished edges. Existing raster geometry was preserved; review and revalidate it before export.');
  if (state.source && !state.offline) await renderStyle();
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

function selectedPanelOrientation() {
  return document.querySelector('input[name="panelOrientation"]:checked')?.value || 'portrait';
}

function syncPanelSizePreset({ preserveCustom = false } = {}) {
  const selector = el('panel-size-preset');
  if (!selector) return;
  if (preserveCustom) {
    selector.value = 'custom';
    return;
  }
  const current = sheet();
  const toleranceMm = 0.05;
  const match = Object.entries(PANEL_SIZE_PRESETS).find(([, preset]) => (
    Math.abs(current.widthMm - preset.widthMm) <= toleranceMm &&
      Math.abs(current.heightMm - preset.heightMm) <= toleranceMm
  ) || (
    Math.abs(current.widthMm - preset.heightMm) <= toleranceMm &&
      Math.abs(current.heightMm - preset.widthMm) <= toleranceMm
  ));
  selector.value = match?.[0] ?? 'custom';
}

function applyPanelSizePreset(value) {
  const preset = PANEL_SIZE_PRESETS[value];
  if (!preset) return false;
  const oriented = orientSheet(preset, selectedPanelOrientation());
  el('panel-width').value = roundUnit(fromMm(oriented.widthMm));
  el('panel-height').value = roundUnit(fromMm(oriented.heightMm));
  reflectPanelOrientation(selectedPanelOrientation());
  return true;
}

function updateExportReadiness() {
  const card = el('export-readiness');
  const hasGeometry = Boolean(state.designMask);
  const ready = currentGeometryIsValidated();
  const advisoryLocations = ready ? countValidationLocations(state.validation, 'warning') : 0;
  if (card) {
    card.dataset.state = ready ? 'ready' : hasGeometry ? 'draft' : 'blocked';
    const profileCopy = state.cuttingProfile.status === 'verified'
      ? `Verified profile revision ${state.cuttingProfile.revision} carries recorded shop evidence.`
      : `Profile revision ${state.cuttingProfile.revision} is provisional; confirm it before cutting.`;
    card.querySelector('span').innerHTML = ready
      ? `<strong>Ready for CAM review</strong><small>No blocking geometry issues found${advisoryLocations ? `; review ${advisoryLocations} advisory ${advisoryLocations === 1 ? 'location' : 'locations'}` : ' or advisories'}. ${profileCopy} PNG has no watermark.</small>`
      : hasGeometry
        ? '<strong>Draft preview available</strong><small>PNG includes a validation watermark. Run all checks to enable SVG and DXF.</small>'
        : '<strong>Artwork required</strong><small>Import or create artwork before exporting a preview.</small>';
  }
  for (const id of ['btn-export-svg', 'btn-export-dxf']) {
    el(id)?.toggleAttribute('disabled', !ready);
  }
  const pngButton = el('btn-export-png');
  pngButton?.toggleAttribute('disabled', !hasGeometry);
  const pngDescription = pngButton?.querySelector('small');
  if (pngDescription) {
    pngDescription.textContent = ready
      ? 'Validated full-resolution preview · no watermark'
      : hasGeometry
        ? 'Draft preview · validation watermark included'
        : 'Available after artwork is created';
  }
  all('[data-next-stage="export"]').forEach((button) => button.toggleAttribute('disabled', !hasGeometry));
}

/* ---------------------------------------------------------------- history */

function snapshot() {
  rememberStyleSettings();
  return JSON.stringify({
    geometryInterpretation: state.geometryInterpretation,
    cuttingProfile: cuttingProfileFromControls(),
    controls: readControls(),
    styleSettings: cloneStyleSettings(state.styleSettings),
    bridges: state.bridges,
    painted: { keep: [...state.painted.keep], remove: [...state.painted.remove] },
    manualEdits: state.manualEdits,
    manufacturingRepairs: {
      keep: [...state.manufacturingRepairs.keep],
      remove: [...state.manufacturingRepairs.remove],
      enabled: state.manufacturingRepairs.enabled,
      stale: state.manufacturingRepairs.stale,
      summary: state.manufacturingRepairs.summary,
    },
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
    if (node.closest('#cutting-profile-details')) continue;
    if (node.id === 'project-name' || node.id.startsWith('selected-bridge-') ||
        node.id.startsWith('manual-edit-')) continue;
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
  for (const [id, value] of Object.entries({
    'artwork-scale': '100',
    'artwork-rotation': '0',
    'artwork-offset-x': '0',
    'artwork-offset-y': '0',
  })) {
    if (!Object.hasOwn(controls, id)) migratedControls[id] = value;
  }
  if (!Object.hasOwn(controls, 'support-follow-features')) {
    migratedControls['support-follow-features'] = true;
  }
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
  syncPanelSizePreset({ preserveCustom: controls['panel-size-preset'] === 'custom' });
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
  state.geometryInterpretation = data.geometryInterpretation ?? FINISHED_BOUNDARY_CAM;
  state.styleSettings = cloneStyleSettings(data.styleSettings);
  applyControls(data.controls);
  syncCuttingProfileControls(data.cuttingProfile ?? createCuttingProfile());
  state.bridges = cloneBridges(data.bridges);
  state.supportProposal = null;
  state.supportTapStart = null;
  state.bridgePreview = null;
  state.painted = { keep: new Set(data.painted.keep), remove: new Set(data.painted.remove) };
  state.manualEdits = normalizeManualEdits(data.manualEdits);
  state.selectedManualEditId = null;
  state.manufacturingRepairs = {
    keep: new Set(data.manufacturingRepairs?.keep ?? []),
    remove: new Set(data.manufacturingRepairs?.remove ?? []),
    enabled: data.manufacturingRepairs?.enabled !== false,
    stale: data.manufacturingRepairs?.stale === true,
    summary: data.manufacturingRepairs?.summary ?? null,
  };
  state.selectedBridge = null;
  if (state.source) {
    invalidateStyleRender({
      useLocalPreview: state.mode === 'line-art' || previousStyle !== selectedCutStyle(),
    });
  }
  refresh({ immediate: true, preserveManufacturingRepairs: true });
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
  for (const id of ['btn-undo', 'btn-undo-mobile']) {
    el(id)?.toggleAttribute('disabled', state.undo.length === 0);
  }
  for (const id of ['btn-redo', 'btn-redo-mobile']) {
    el(id)?.toggleAttribute('disabled', state.redo.length === 0);
  }
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
  resetAutomaticSyncRetry();
  state.dirty = true;
  dirtyGeneration += 1;
  setSaveState('saving', state.isDraft ? 'Saving recoverable draft…' : 'Saving…');
  updateProjectPersistenceUi();
  scheduleSave();
}

let localSaveTimer = null;
let serverSyncTimer = null;
let localSaveInFlight = null;
let serverSyncInFlight = null;
let lastSavedRecord = null;
let dirtyGeneration = 0;
let saveStateToken = 0;
let automaticSyncRetry = null;

function renderSaveState(kind, label, pendingCount = 0) {
  const badge = el('save-state');
  const text = el('save-state-label');
  if (badge && text) {
    badge.dataset.state = kind;
    text.textContent = label;
    badge.title = label;
  }
  const mobile = el('btn-sync-mobile');
  if (mobile) {
    mobile.dataset.state = kind;
    mobile.title = label;
    mobile.setAttribute('aria-label', state.isDraft
      ? `Save draft to Projects. ${label}`
      : `Sync projects. ${label}`);
  }
  const mobileLabel = el('sync-action-label');
  if (mobileLabel) mobileLabel.textContent = state.isDraft ? 'Save' : 'Sync';
  const count = el('sync-pending-count');
  if (count) {
    count.hidden = pendingCount < 1;
    count.textContent = pendingCount > 99 ? '99+' : String(pendingCount || '');
  }
}

function updateProjectPersistenceUi() {
  const canSave = state.isDraft && Boolean(state.sourceMask);
  const saveButton = el('btn-save-project');
  if (saveButton) saveButton.hidden = !canSave;
}

function setSaveState(kind, label, pendingCount = 0) {
  saveStateToken += 1;
  renderSaveState(kind, label, pendingCount);
}

function savedAtLabel(value = new Date()) {
  return `Saved to server at ${new Intl.DateTimeFormat(undefined, {
    hour: '2-digit', minute: '2-digit',
  }).format(value)}`;
}

function retryDelayLabel(delayMs) {
  if (delayMs >= 60_000) return `${Math.ceil(delayMs / 60_000)} min`;
  return `${Math.max(1, Math.ceil(delayMs / 1_000))} sec`;
}

async function setPendingSaveState({ retryDelayMs = null, exhausted = false } = {}) {
  const token = ++saveStateToken;
  let pendingCount = 0;
  try {
    pendingCount = await pendingProjectSyncCount();
  } catch (error) {
    console.warn('Could not count pending project changes:', error);
  }
  if (token !== saveStateToken) return pendingCount;
  const noun = pendingCount === 1 ? 'project' : 'projects';
  const waiting = pendingCount
    ? `${pendingCount} ${noun} waiting to sync`
    : retryDelayMs !== null ? 'Server unavailable' : 'Saved locally — waiting for server';
  if (!navigator.onLine) {
    renderSaveState('offline', pendingCount ? `Offline · ${waiting}` : 'Offline · saved locally', pendingCount);
  } else if (exhausted) {
    renderSaveState(
      'error',
      pendingCount ? `${pendingCount} ${noun} not synced — Tap Sync` : 'Server unavailable — Tap Sync',
      pendingCount,
    );
  } else if (retryDelayMs !== null) {
    renderSaveState('queued', `${waiting} · retry in ${retryDelayLabel(retryDelayMs)}`, pendingCount);
  } else {
    renderSaveState('queued', waiting, pendingCount);
  }
  return pendingCount;
}

function reportStorageFailure(error, { projectCached = false } = {}) {
  if (!isStorageQuotaError(error)) return false;
  setSaveState(
    'error',
    projectCached
      ? 'Device storage full — sync queue needs space'
      : 'Device storage full — latest edit not cached',
  );
  toast(projectCached
    ? 'The project is cached, but its server queue needs more device space. Free space, then tap Sync.'
    : 'The latest edit is still open but could not be cached. Free device space, then tap Sync before closing Kerfloom.');
  return true;
}

function syncRetryController() {
  if (!automaticSyncRetry) {
    automaticSyncRetry = createSyncRetryController({
      canRun: () => navigator.onLine && document.visibilityState !== 'hidden',
      onRetry: () => syncWorkspaceProjects({ announce: false }),
      onState: ({ status, delayMs }) => {
        if (status === 'scheduled') void setPendingSaveState({ retryDelayMs: delayMs });
        else if (status === 'exhausted') void setPendingSaveState({ exhausted: true });
        else void setPendingSaveState();
      },
    });
  }
  return automaticSyncRetry;
}

function scheduleAutomaticSyncRetry() {
  return syncRetryController().schedule();
}

function pauseAutomaticSyncRetry() {
  return automaticSyncRetry?.pause();
}

function resetAutomaticSyncRetry() {
  return automaticSyncRetry?.reset();
}

async function syncStoredProject(record) {
  if (record?.localDraft === true) return { status: 'draft', projectId: record.id };
  let result;
  try {
    result = await syncProject(record);
  } catch (error) {
    console.error('Server project synchronization failed:', error);
    if (reportStorageFailure(error, { projectCached: true })) return { status: 'storage-full', error };
    if (isRetryableSyncError(error)) {
      await setPendingSaveState();
      scheduleAutomaticSyncRetry();
      return { status: 'retrying', error };
    }
    throw error;
  }
  if (record.id === state.projectId) {
    const activeId = result.projectId || record.id;
    const current = await loadProject(activeId);
    if (current) {
      if (activeId !== record.id) {
        state.projectId = activeId;
        state.isDraft = false;
        state.conflictOriginId = current.conflictOriginId || record.id;
        state.name = result.name || current.name;
        state.createdAt = current.createdAt;
        el('project-name').value = state.name;
        await setLastProject(activeId);
        if (result.message) toast(result.message);
      }
      state.serverRevision = Number(current.serverRevision) || 0;
      lastSavedRecord = current;
    }
    const pendingCount = await pendingProjectSyncCount();
    if (state.dirty || current?.localSyncPending || pendingCount) {
      await setPendingSaveState();
      if (result.status === 'queued' || result.status === 'conflict-queued') {
        scheduleAutomaticSyncRetry();
      }
    } else if (result.status === 'synced' || result.status === 'conflict') {
      resetAutomaticSyncRetry();
      setSaveState('saved', savedAtLabel(new Date(current?.serverSyncedAt || Date.now())));
    }
  }
  return result;
}

function scheduleLocalSave(delay = LOCAL_SAVE_DELAY_MS) {
  clearTimeout(localSaveTimer);
  localSaveTimer = setTimeout(() => void persistLocally(), delay);
}

function scheduleServerSync(delay = SERVER_SYNC_DELAY_MS) {
  clearTimeout(serverSyncTimer);
  serverSyncTimer = setTimeout(() => void syncPendingSave(), delay);
}

function scheduleSave() {
  scheduleLocalSave();
  if (!state.isDraft) scheduleServerSync();
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
      maximumCantileverMm: toMm(numberField('max-cantilever', 250)),
      geometryInterpretation: state.geometryInterpretation,
      profile: cuttingProfileFromControls(),
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
      vectorDots: state.vectorDots,
      painted: { keep: [...state.painted.keep], remove: [...state.painted.remove] },
      manualEdits: state.manualEdits,
      manufacturingRepairs: {
        keep: [...state.manufacturingRepairs.keep],
        remove: [...state.manufacturingRepairs.remove],
        enabled: state.manufacturingRepairs.enabled,
        stale: state.manufacturingRepairs.stale,
        summary: state.manufacturingRepairs.summary,
      },
      candidates: state.candidates,
      selectedCandidateId: state.selectedCandidateId,
      automaticSupportsStale: state.automaticSupportsStale,
      projectSummary: {
        thumbnail: projectMaskThumbnail(state.designMask, sheet()),
        cutStyle: selectedCutStyle(),
        status: !state.designMask
          ? 'draft'
          : state.validated && state.validatedRevision === state.revision
            ? 'ready'
            : 'needs-validation',
        lastValidatedAt: state.lastValidatedAt,
        lastExportedAt: state.lastExportedAt,
      },
    },
    createdAt: state.createdAt,
  });
}

async function persistLocally() {
  clearTimeout(localSaveTimer);
  localSaveTimer = null;
  if (!state.sourceMask) return null;
  if (localSaveInFlight) {
    await localSaveInFlight.catch(() => null);
    if (!state.dirty) return lastSavedRecord;
  }
  if (!state.dirty) return lastSavedRecord || (state.projectId ? loadProject(state.projectId) : null);
  const generation = dirtyGeneration;
  const operation = (async () => {
    const record = {
      ...projectFromState(),
      id: state.isDraft ? LOCAL_DRAFT_PROJECT_ID : state.projectId,
      localDraft: state.isDraft,
      localSource: state.source?.file ?? null,
      serverRevision: state.serverRevision,
      conflictOriginId: state.conflictOriginId,
    };
    let saved = await saveProject(record);
    state.projectId = saved.id;
    state.createdAt = saved.createdAt;
    lastSavedRecord = saved;
    if (generation === dirtyGeneration) {
      state.dirty = false;
      if (state.isDraft) setSaveState('draft', 'Draft saved on this device · Save to Projects');
      else await setPendingSaveState();
    } else {
      scheduleLocalSave();
    }
    if (!state.isDraft) {
      try {
        await queueProjectSync(saved);
      } catch (error) {
        console.error('Could not queue the locally saved project for synchronization:', error);
        if (!reportStorageFailure(error, { projectCached: true })) {
          setSaveState('error', 'Saved locally — Sync queue needs attention');
        }
      }
    }
    return saved;
  })();
  localSaveInFlight = operation;
  try {
    return await operation;
  } catch (error) {
    console.error(error);
    state.dirty = true;
    if (!reportStorageFailure(error)) {
      setSaveState('error', 'Local cache failed — Retry');
      toast('Could not cache this project. Your current work remains open.');
    }
    return null;
  } finally {
    if (localSaveInFlight === operation) localSaveInFlight = null;
  }
}

async function flushPendingLocalSave() {
  clearTimeout(localSaveTimer);
  localSaveTimer = null;
  if (localSaveInFlight) await localSaveInFlight.catch(() => null);
  if (state.dirty) return persistLocally();
  return lastSavedRecord || (state.projectId ? loadProject(state.projectId) : null);
}

async function syncPendingSave() {
  clearTimeout(serverSyncTimer);
  serverSyncTimer = null;
  if (!state.sourceMask) return null;
  if (serverSyncInFlight) {
    await serverSyncInFlight.catch(() => null);
    if (state.dirty || (state.projectId && await hasPendingProjectSync(state.projectId))) {
      scheduleServerSync();
    }
    return lastSavedRecord;
  }
  const operation = (async () => {
    const locallySaved = await flushPendingLocalSave();
    if (!locallySaved?.id) return null;
    if (locallySaved.localDraft === true || state.isDraft) {
      setSaveState('draft', 'Draft saved on this device · Save to Projects');
      return locallySaved;
    }
    let current = await loadProject(locallySaved.id) || locallySaved;
    if (current.localSyncPending && !await hasPendingProjectSync(current.id)) {
      await queueProjectSync(current);
    }
    const result = await flushQueuedProjectSync(current.id);
    const activeId = result.projectId || current.id;
    current = await loadProject(activeId) || current;
    if (activeId !== state.projectId && result.name) {
      state.projectId = activeId;
      state.isDraft = false;
      state.conflictOriginId = current.conflictOriginId || locallySaved.id;
      state.name = result.name || current.name;
      state.createdAt = current.createdAt;
      el('project-name').value = state.name;
      await setLastProject(activeId);
      if (result.message) toast(result.message);
    }
    state.serverRevision = Number(current.serverRevision) || state.serverRevision || 0;
    lastSavedRecord = current;
    const stillPending = state.dirty || current.localSyncPending || await hasPendingProjectSync(current.id);
    if (stillPending) {
      await setPendingSaveState();
      // A superseded upload means a newer local generation is already queued;
      // follow it promptly. Transient failures use the bounded retry policy.
      if (state.dirty || result.status === 'superseded') scheduleServerSync();
      else if (result.status === 'queued' || result.status === 'conflict-queued') {
        scheduleAutomaticSyncRetry();
      }
    } else if (result.status === 'synced' || result.status === 'conflict') {
      const pendingCount = await pendingProjectSyncCount();
      if (pendingCount) {
        await setPendingSaveState();
        scheduleAutomaticSyncRetry();
      } else {
        resetAutomaticSyncRetry();
        setSaveState('saved', savedAtLabel(new Date(current.serverSyncedAt || Date.now())));
      }
    }
    return current;
  })();
  serverSyncInFlight = operation;
  try {
    return await operation;
  } catch (error) {
    console.error('Server project synchronization failed:', error);
    if (reportStorageFailure(error, { projectCached: true })) {
      pauseAutomaticSyncRetry();
    } else if (error.code === 'workspace_changed') {
      pauseAutomaticSyncRetry();
      setSaveState('error', 'Workspace changed — Reload');
      toast('This browser tab belongs to the previous workspace. Reload before synchronizing.');
    } else if (isRetryableSyncError(error)) {
      await setPendingSaveState();
      scheduleAutomaticSyncRetry();
    } else {
      pauseAutomaticSyncRetry();
      setSaveState('error', 'Saved locally — Server sync failed');
    }
    return null;
  } finally {
    if (serverSyncInFlight === operation) serverSyncInFlight = null;
  }
}

async function persist() {
  const locallySaved = await flushPendingLocalSave();
  if (!locallySaved) return null;
  if (locallySaved.localDraft === true || state.isDraft) return locallySaved;
  await syncPendingSave();
  return state.projectId ? loadProject(state.projectId) : locallySaved;
}

async function flushPendingSave() {
  await persist();
  return !state.dirty;
}

let workspaceSyncInFlight = null;
async function syncWorkspaceProjects({ announce = false } = {}) {
  if (workspaceSyncInFlight) return workspaceSyncInFlight;
  if (!navigator.onLine) {
    state.offline = true;
    pauseAutomaticSyncRetry();
    await setPendingSaveState();
    return { status: 'offline' };
  }
  state.offline = false;
  const operation = (async () => {
    setSaveState('saving', 'Syncing projects…');
    const activeProjectId = state.projectId;
    const activeServerRevision = state.serverRevision;
    if (state.dirty) {
      const locallySaved = await flushPendingLocalSave();
      if (!locallySaved || state.dirty) return { status: 'local-save-failed' };
    }
    const result = await synchronizeProjectLibrary(({ completed, total, message }) => {
      if (announce || total > 1) {
        setSaveState('saving', total
          ? `Syncing projects ${Math.min(completed + 1, total)}/${total}…`
          : message || 'Syncing projects…');
      }
    });
    const activeRemap = result.remapped?.find((entry) => entry.fromProjectId === activeProjectId);
    if (activeRemap && state.projectId === activeProjectId) {
      const remappedProject = await loadProject(activeRemap.toProjectId);
      if (remappedProject) {
        state.projectId = remappedProject.id;
        state.isDraft = false;
        state.conflictOriginId = remappedProject.conflictOriginId || activeProjectId;
        state.name = remappedProject.name;
        state.createdAt = remappedProject.createdAt;
        state.serverRevision = Number(remappedProject.serverRevision) || 0;
        lastSavedRecord = remappedProject;
        el('project-name').value = state.name;
        await setLastProject(remappedProject.id);
      }
    }
    const current = state.projectId ? await loadProject(state.projectId) : null;
    if (current?.serverRevision) {
      const changedElsewhere = activeProjectId === state.projectId &&
        activeServerRevision > 0 && current.serverRevision > activeServerRevision;
      if (changedElsewhere && state.sourceMask && !state.dirty) {
        await loadProjectState(current);
        pushHistory();
        toast('This project was updated from another device.');
      } else {
        state.serverRevision = current.serverRevision;
        lastSavedRecord = current;
      }
    }

    const attention = (result.failures || []).filter((failure) => !failure.retryable);
    if (attention.length) {
      pauseAutomaticSyncRetry();
      const activeIds = new Set([activeProjectId, state.projectId].filter(Boolean));
      const activeFailure = attention.find((failure) => activeIds.has(failure.projectId));
      const activePending = Boolean(
        state.dirty || current?.localSyncPending || (state.projectId && await hasPendingProjectSync(state.projectId))
      );
      const first = activeFailure || attention[0];
      const shortName = String(first.name || 'Project').slice(0, 28);
      const shortReason = String(first.message || 'Sync failed').slice(0, 52);
      const pendingCount = await pendingProjectSyncCount();
      if (activeFailure || activePending) {
        setSaveState('error', `Current project not synced · ${shortReason}`, pendingCount);
      } else {
        setSaveState(
          'warning',
          `Saved · “${shortName}” needs sync attention`,
          pendingCount,
        );
      }
      if (announce) {
        toast(activeFailure || activePending
          ? `Could not sync the current project: ${first.message}`
          : `Your current project is saved. Could not ${first.phase} “${shortName}”: ${first.message}`);
      }
    } else if (result.queued) {
      await setPendingSaveState();
      scheduleAutomaticSyncRetry();
    } else {
      resetAutomaticSyncRetry();
      if (current?.serverRevision) {
        setSaveState('saved', savedAtLabel(new Date(current.serverSyncedAt || Date.now())));
      }
    }

    if (!attention.length && !result.queued && result.deleted?.includes(activeProjectId) && state.sourceMask) {
      pauseAutomaticSyncRetry();
      setSaveState('error', 'Deleted on another device — edit to save a copy');
      toast('This open project was deleted on another device. A new edit will be preserved as a separate copy.');
    } else if (!attention.length && !result.queued && !state.sourceMask) {
      setSaveState('saved', 'Server workspace synchronized');
    }
    if (result.conflicts) {
      toast(`${result.conflicts} edit conflict saved as ${result.conflicts === 1 ? 'a separate project' : 'separate projects'}.`);
    }
    if (state.isDraft && state.sourceMask) {
      setSaveState('draft', 'Draft saved on this device · Save to Projects');
    }
    return result;
  })();
  workspaceSyncInFlight = operation;
  try {
    return await operation;
  } catch (error) {
    console.error('Workspace synchronization failed:', error);
    if (reportStorageFailure(error, { projectCached: true })) {
      pauseAutomaticSyncRetry();
      return { status: 'storage-full', error };
    }
    if (error.code === 'workspace_changed') {
      pauseAutomaticSyncRetry();
      setSaveState('error', 'Workspace changed — Reload');
      if (announce) toast('This browser tab belongs to the previous workspace. Reload before synchronizing.');
      return { status: 'workspace-changed', error };
    }
    if (isRetryableSyncError(error)) {
      await setPendingSaveState();
      const retry = scheduleAutomaticSyncRetry();
      if (announce) toast(retry.status === 'exhausted'
        ? 'Projects remain cached. Tap Sync to try the server again.'
        : 'Projects remain cached and will retry automatically.');
      return { status: retry.status === 'exhausted' ? 'error' : 'retrying', error };
    }
    pauseAutomaticSyncRetry();
    setSaveState('error', 'Server sync failed — Tap Sync');
    if (announce) toast('Projects remain safely cached. Tap Sync after reviewing the connection.');
    return { status: 'error', error };
  } finally {
    if (workspaceSyncInFlight === operation) workspaceSyncInFlight = null;
  }
}

async function saveDraftAsProject() {
  if (!state.isDraft || !state.sourceMask) return null;
  const draft = await flushPendingLocalSave();
  if (!draft) return null;
  setSaveState('saving', 'Adding project to your server workspace…');
  let saved;
  try {
    saved = await promoteLocalDraft(draft);
  } catch (error) {
    console.error('Could not promote the local draft:', error);
    if (!reportStorageFailure(error, { projectCached: true })) {
      setSaveState('draft', 'Draft saved on this device · Save to Projects');
      toast('The draft is safe on this device, but could not be added to Projects yet.');
    }
    return null;
  }
  state.projectId = saved.id;
  state.isDraft = false;
  state.conflictOriginId = null;
  state.createdAt = saved.createdAt;
  state.serverRevision = 0;
  lastSavedRecord = saved;
  updateProjectPersistenceUi();
  try {
    const result = await syncStoredProject(saved);
    if (result.status === 'synced') toast(`“${state.name}” was added to Projects.`);
    else toast(`“${state.name}” was added to Projects and will sync when the server is available.`);
  } catch (error) {
    console.error('The new project could not be synchronized:', error);
    await setPendingSaveState({ exhausted: true });
    toast(`“${state.name}” was added to Projects and is safe on this device, but the server needs attention.`);
  }
  return saved;
}

async function manuallySyncProjects() {
  if (state.isDraft && state.sourceMask) {
    await saveDraftAsProject();
    return;
  }
  resetAutomaticSyncRetry();
  setSaveState('saving', 'Syncing projects…');
  const result = await syncWorkspaceProjects({ announce: true });
  if (result.status === 'offline') {
    toast('You are offline. Changes are safely queued and will sync when connected.');
  } else if (result.status === 'queued') {
    toast(`${result.queued} ${result.queued === 1 ? 'change is' : 'changes are'} waiting for the server.`);
  } else if (result.status === 'retrying') {
    toast('The server is not reachable yet. Kerfloom will retry automatically.');
  } else if (result.status === 'partial') {
    // syncWorkspaceProjects already names the affected project and whether the
    // open project itself is safe; avoid replacing that useful detail here.
  } else if (result.status === 'synced' && !result.conflicts) {
    toast('All projects are saved to the server.');
  }
}

async function createRecoveryPoint(label) {
  if (!state.sourceMask) return false;
  try {
    if (!await flushPendingSave() || !state.projectId || state.isDraft) return false;
    const project = await loadProject(state.projectId);
    if (!project) return false;
    await saveCheckpoint(project, label);
    await syncStoredProject(project);
    return true;
  } catch (error) {
    console.warn('Could not create a local recovery point:', error);
    return false;
  }
}

/* ------------------------------------------------------- project library */

let projectLibraryView = 'active';
let projectLibraryRows = [];
let renameProjectId = null;
let versionProjectId = null;
let versionRows = [];
let sharingProject = null;
let receivedShare = null;
let deviceManagerInvite = null;
let projectThumbnailRender = 0;
let duplicateConflictGroups = [];
const projectThumbnailCache = new Map();

function projectStatus(record) {
  return record.editor?.projectSummary?.status ??
    (record.raster?.sourceMask ? 'needs-validation' : 'draft');
}

function projectStatusLabel(status) {
  return {
    draft: 'Draft',
    'needs-validation': 'Needs validation',
    ready: 'Geometry checks passed',
  }[status] ?? 'Draft';
}

function formatProjectDate(value) {
  if (!value) return 'Unknown date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(date);
}

function formatStorage(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function projectFilename(record) {
  const style = record.editor?.projectSummary?.cutStyle ?? record.editor?.controls?.cutStyle ?? 'line-art';
  return buildExportFilename({
    projectName: record.name,
    sheet: record.sheet,
    styleName: CUT_STYLE_NAMES[style] || style,
    includeFrame: record.frame?.enabled !== false,
    purpose: 'editable',
    extension: 'stencil.json',
    timestamp: new Date(),
  });
}

function projectAction(label, action, { primary = false } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.projectAction = action;
  button.textContent = label;
  if (primary) button.dataset.primary = 'true';
  return button;
}

function projectThumbnailKey(record) {
  return `${record.id}:${record.updatedAt ?? ''}`;
}

function projectThumbnail(record) {
  return projectThumbnailCache.get(projectThumbnailKey(record)) ??
    record.editor?.projectSummary?.thumbnail ?? null;
}

function isConflictProject(record) {
  return Boolean(record?.conflictOriginId) || /(?:^|\s)\(conflict\s/i.test(record?.name || '');
}

async function projectContentSignature(record) {
  const { projectSummary: _projectSummary, ...editor } = record.editor || {};
  let sourceDigest = null;
  if (record.localSource instanceof Blob) {
    const bytes = await record.localSource.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    sourceDigest = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
  }
  const canonical = JSON.stringify({
    sheet: record.sheet,
    conversion: record.conversion,
    frame: record.frame,
    manufacturing: record.manufacturing,
    structure: record.structure,
    source: record.source,
    sourceDigest,
    raster: record.raster,
    bridges: record.bridges,
    editor,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function findDuplicateConflictGroups(records) {
  const groups = new Map();
  for (const record of records.filter(isConflictProject)) {
    const signature = await projectContentSignature(record);
    const group = groups.get(signature) || [];
    group.push(record);
    groups.set(signature, group);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function duplicateConflictRows() {
  return duplicateConflictGroups.flatMap((group) => {
    const keeper = group.find((record) => record.id === state.projectId) || group[0];
    return group.filter((record) => record.id !== keeper.id);
  });
}

function renderProjectCardPreview(preview, record, thumbnail = projectThumbnail(record)) {
  preview.replaceChildren();
  if (thumbnail) {
    const image = document.createElement('img');
    image.src = thumbnail;
    image.alt = `${record.name} artwork preview`;
    preview.append(image);
    return;
  }
  preview.innerHTML = '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M7 14h14l4 5h16v21H7z"></path><path d="M7 14V9h14l4 5"></path></svg>';
}

async function hydrateProjectThumbnails(records, renderToken) {
  for (const record of records) {
    if (renderToken !== projectThumbnailRender) return;
    const thumbnailKey = projectThumbnailKey(record);
    if (projectThumbnailCache.has(thumbnailKey)) continue;
    // Rebuild saved thumbnails from the sheet mask so old projects also use
    // their physical panel proportions. Yield between projects to keep the
    // library responsive when many previews need their first render.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (renderToken !== projectThumbnailRender) return;
    const thumbnail = encodedProjectMaskThumbnail(
      record.raster?.sourceMask ?? record.raster?.baseMask,
      record.sheet,
    );
    if (!thumbnail) continue;
    projectThumbnailCache.set(thumbnailKey, thumbnail);
    const card = all('#project-list [data-project-id]')
      .find((node) => node.dataset.projectId === record.id);
    const preview = card?.querySelector('.project-card-preview');
    if (preview) renderProjectCardPreview(preview, record, thumbnail);
  }
}

function buildProjectCard(record) {
  const article = document.createElement('article');
  article.className = 'project-card';
  article.dataset.projectId = record.id;
  article.dataset.current = String(record.id === state.projectId);
  article.setAttribute('role', 'listitem');

  const preview = document.createElement('div');
  preview.className = 'project-card-preview';
  renderProjectCardPreview(preview, record);

  const body = document.createElement('div');
  body.className = 'project-card-body';
  const titleRow = document.createElement('div');
  titleRow.className = 'project-card-title-row';
  const title = document.createElement('h3');
  title.className = 'project-card-title';
  title.textContent = record.name;
  title.title = record.name;
  titleRow.append(title);
  if (record.id === state.projectId) {
    const current = document.createElement('span');
    current.className = 'project-card-current';
    current.textContent = 'Open';
    titleRow.append(current);
  }

  const meta = document.createElement('div');
  meta.className = 'project-card-meta';
  const style = record.editor?.projectSummary?.cutStyle ?? record.editor?.controls?.cutStyle ?? 'line-art';
  const sourceSize = record.localSource instanceof Blob ? formatStorage(record.localSource.size) : '';
  for (const value of [
    formatProjectDate(record.updatedAt),
    `${record.sheet.widthMm} × ${record.sheet.heightMm} mm`,
    CUT_STYLE_NAMES[style] || style,
    sourceSize
      ? `${record.serverRevision ? 'Source on server' : 'Source queued'} · ${sourceSize}`
      : 'Processed geometry only',
  ]) {
    const span = document.createElement('span');
    span.textContent = value;
    meta.append(span);
  }

  const statusValue = projectStatus(record);
  const status = document.createElement('span');
  status.className = 'project-status';
  status.dataset.status = statusValue;
  status.textContent = projectStatusLabel(statusValue);

  const actions = document.createElement('div');
  actions.className = 'project-card-actions';
  if (projectLibraryView === 'trash') {
    actions.append(
      projectAction('Restore', 'restore', { primary: true }),
      projectAction('Delete forever', 'delete'),
    );
  } else {
    actions.append(
      projectAction(record.id === state.projectId ? 'Continue' : 'Open', 'open', { primary: true }),
      projectAction('Rename', 'rename'),
      projectAction('Duplicate', 'duplicate'),
      projectAction('Share', 'share'),
      projectAction('Download', 'download'),
      projectAction(`Versions${record.checkpointCount ? ` · ${record.checkpointCount}` : ''}`, 'versions'),
      projectAction('Trash', 'trash'),
    );
  }
  body.append(titleRow, meta, status, actions);
  article.append(preview, body);
  return article;
}

function renderProjectLibrary() {
  const renderToken = ++projectThumbnailRender;
  const query = el('project-search')?.value.trim().toLocaleLowerCase() ?? '';
  const statusFilter = projectLibraryView === 'trash'
    ? 'all'
    : el('project-status-filter')?.value ?? 'all';
  const rows = projectLibraryRows.filter((record) => (
    (!query || record.name.toLocaleLowerCase().includes(query)) &&
    (statusFilter === 'all' || projectStatus(record) === statusFilter)
  ));
  const list = el('project-list');
  list.hidden = rows.length === 0;
  list?.replaceChildren(...rows.map(buildProjectCard));
  const empty = el('project-library-empty');
  empty.hidden = rows.length > 0;
  if (!rows.length) {
    empty.querySelector('strong').textContent = projectLibraryView === 'trash'
      ? 'Trash is empty'
      : query ? 'No matching projects' : 'No projects yet';
    empty.querySelector('span').textContent = projectLibraryView === 'trash'
      ? 'Projects moved to Trash will remain recoverable here.'
      : query ? 'Try another name or status.' : 'Import an image to create your first project.';
  }
  el('project-library-result').textContent = `${rows.length} ${rows.length === 1 ? 'project' : 'projects'}`;
  void hydrateProjectThumbnails(rows, renderToken);
}

async function refreshProjectLibrary() {
  const [active, trash, legacy, draft] = await Promise.all([
    listProjects(),
    listProjects({ trashed: true }),
    legacyProjectSummary(),
    loadProject(LOCAL_DRAFT_PROJECT_ID),
  ]);
  duplicateConflictGroups = await findDuplicateConflictGroups(active);
  el('project-count-active').textContent = String(active.length);
  el('project-count-trash').textContent = String(trash.length);
  const baseRows = projectLibraryView === 'trash' ? trash : active;
  projectLibraryRows = await Promise.all(baseRows.map(async (record) => ({
    ...record,
    checkpointCount: (await listCheckpoints(record.id)).length,
  })));
  for (const tab of all('[data-project-view]')) {
    const selected = tab.dataset.projectView === projectLibraryView;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  el('project-list')?.setAttribute('aria-labelledby', `project-tab-${projectLibraryView}`);
  if (el('project-status-filter')) el('project-status-filter').disabled = projectLibraryView === 'trash';
  const queued = await pendingProjectSyncCount();
  el('project-storage-summary').textContent = queued
    ? `${queued} ${queued === 1 ? 'change' : 'changes'} waiting to sync`
    : navigator.onLine ? 'Encrypted server storage · synchronized' : 'Offline cache · synchronized';
  const draftNotice = el('project-library-draft');
  draftNotice.hidden = !draft?.sourceMask && !draft?.raster?.sourceMask;
  if (!draftNotice.hidden) {
    el('project-library-draft-detail').textContent = `“${draft.name || 'Untitled panel'}” is safe on this device, but is not in Projects or on the server yet.`;
  }
  const duplicateRows = duplicateConflictRows();
  const cleanupNotice = el('project-library-cleanup');
  cleanupNotice.hidden = projectLibraryView === 'trash' || duplicateRows.length === 0;
  if (!cleanupNotice.hidden) {
    el('project-library-cleanup-detail').textContent = `${duplicateRows.length} ${duplicateRows.length === 1 ? 'copy has' : 'copies have'} the same source, geometry, and editable settings and can be moved to Trash safely.`;
  }
  const legacyNotice = el('project-library-legacy');
  legacyNotice.hidden = legacy.count === 0;
  if (legacy.count) {
    el('project-library-legacy-detail').textContent = `${legacy.count} ${legacy.count === 1 ? 'project is' : 'projects are'} quarantined from the older device-wide cache. Import only if they belong in this workspace.`;
  }
  renderProjectLibrary();
}

async function cleanDuplicateConflictProjects() {
  const duplicates = duplicateConflictRows();
  if (!duplicates.length) {
    await refreshProjectLibrary();
    toast('No identical conflict copies were found.');
    return;
  }
  if (!await confirmAction(
    'Move identical conflict copies to Trash?',
    `${duplicates.length} ${duplicates.length === 1 ? 'duplicate' : 'duplicates'} will be moved to Trash. One complete copy from each identical group will remain in Projects.`,
    'Move to Trash',
  )) return;
  for (const record of duplicates) {
    const trashed = await trashProject(record.id);
    if (trashed) {
      try {
        await syncStoredProject(trashed);
      } catch (error) {
        console.warn(`The trashed duplicate “${record.name}” is queued for later synchronization.`, error);
      }
    }
  }
  await refreshProjectLibrary();
  toast(`${duplicates.length} identical conflict ${duplicates.length === 1 ? 'copy was' : 'copies were'} moved to Trash.`);
}

async function openProjectLibrary({ flush = true } = {}) {
  if (flush && !await flushPendingSave()) return;
  try {
    if (navigator.onLine) await syncWorkspaceProjects();
    await refreshProjectLibrary();
    const dialog = el('project-library-dialog');
    if (!dialog?.open) {
      dialog.returnValue = '';
      dialog.showModal();
    }
    requestAnimationFrame(() => el('project-search')?.focus());
  } catch (error) {
    console.error(error);
    toast('The project library could not be opened.');
  }
}

function closeProjectLibrary() {
  const dialog = el('project-library-dialog');
  if (dialog?.open) dialog.close();
}

function deviceInviteLink(invite) {
  if (invite?.url) return invite.url;
  const url = new URL('/', location.origin);
  url.hash = `invite=${encodeURIComponent(invite?.code || '')}`;
  return url.toString();
}

function renderDeviceAccess({ devices = [], invites = [], current_device_id: currentDeviceId } = {}) {
  const activeDevices = devices.filter((device) => !device.revoked);
  const count = el('linked-device-count');
  if (count) count.textContent = activeDevices.length ? String(activeDevices.length) : '';
  const status = el('device-manager-status');
  if (status) {
    status.dataset.tone = 'success';
    status.textContent = `${activeDevices.length} linked ${activeDevices.length === 1 ? 'device' : 'devices'} can access this workspace.`;
  }

  const list = el('device-list');
  list?.replaceChildren(...devices.map((device) => {
    const item = document.createElement('li');
    item.dataset.deviceId = device.id;
    const copy = document.createElement('div');
    copy.className = 'device-list-copy';
    const title = document.createElement('strong');
    title.textContent = device.label;
    if (device.id === currentDeviceId) {
      const badge = document.createElement('span');
      badge.className = 'device-badge';
      badge.textContent = 'This device';
      title.append(' ', badge);
    } else if (device.revoked) {
      const badge = document.createElement('span');
      badge.className = 'device-badge';
      badge.textContent = 'Disconnected';
      title.append(' ', badge);
    }
    const detail = document.createElement('span');
    detail.textContent = device.revoked
      ? `Access revoked · last connected ${formatProjectDate(device.last_seen)}`
      : `Last connected ${formatProjectDate(device.last_seen)} · linked ${formatProjectDate(device.created_at)}`;
    copy.append(title, detail);
    item.append(copy);
    if (device.id !== currentDeviceId && !device.revoked) {
      const actions = document.createElement('div');
      actions.className = 'device-list-actions';
      const disconnect = document.createElement('button');
      disconnect.type = 'button';
      disconnect.dataset.deviceAction = 'disconnect';
      disconnect.dataset.deviceId = device.id;
      disconnect.dataset.deviceLabel = device.label;
      disconnect.textContent = 'Disconnect';
      disconnect.title = `Disconnect ${device.label} from this workspace`;
      actions.append(disconnect);
      item.append(actions);
    }
    return item;
  }));

  const pendingSection = el('pending-device-invites-section');
  const pendingList = el('pending-device-invites');
  if (pendingSection) pendingSection.hidden = invites.length === 0;
  pendingList?.replaceChildren(...invites.map((invite) => {
    const item = document.createElement('li');
    const copy = document.createElement('div');
    copy.className = 'pending-device-invite-copy';
    const title = document.createElement('strong');
    title.textContent = invite.label;
    const detail = document.createElement('span');
    detail.textContent = `Unused · expires ${formatProjectDate(invite.expires_at)}`;
    copy.append(title, detail);
    const actions = document.createElement('div');
    actions.className = 'pending-device-invite-actions';
    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.dataset.inviteAction = 'copy';
    copyButton.dataset.inviteLink = deviceInviteLink(invite);
    copyButton.textContent = 'Copy';
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.dataset.inviteAction = 'cancel';
    cancelButton.dataset.inviteId = String(invite.id);
    cancelButton.textContent = 'Cancel link';
    actions.append(copyButton, cancelButton);
    item.append(copy, actions);
    return item;
  }));
}

async function refreshDeviceAccess() {
  const result = await requestWorkspaceJson('/api/workspace/devices');
  renderDeviceAccess(result);
  return result;
}

async function openDeviceManager() {
  if (state.offline || !navigator.onLine) {
    toast('Connect to the server to manage linked devices.');
    return;
  }
  closeProjectLibrary();
  deviceManagerInvite = null;
  el('device-invite-result').hidden = true;
  el('device-invite-progress').hidden = true;
  const status = el('device-manager-status');
  status.dataset.tone = 'neutral';
  status.textContent = 'Loading linked devices…';
  const dialog = el('device-manager-dialog');
  dialog.returnValue = '';
  dialog.showModal();
  try {
    await refreshDeviceAccess();
    requestAnimationFrame(() => el('device-invite-label')?.focus());
  } catch (error) {
    console.error(error);
    status.dataset.tone = 'danger';
    status.textContent = error.message || 'Linked devices could not be loaded.';
  }
}

async function createDeviceInvite() {
  const labelInput = el('device-invite-label');
  const label = labelInput?.value.trim() || '';
  const progress = el('device-invite-progress');
  if (!label) {
    progress.hidden = false;
    progress.dataset.tone = 'danger';
    progress.textContent = 'Name the phone or computer you are linking.';
    labelInput?.focus();
    return;
  }
  const button = el('btn-create-device-invite');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  progress.hidden = false;
  progress.dataset.tone = 'neutral';
  progress.textContent = 'Creating a private one-time invitation…';
  try {
    const invite = await requestWorkspaceJson('/api/workspace/device-invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    });
    deviceManagerInvite = { ...invite, link: deviceInviteLink(invite) };
    const result = el('device-invite-result');
    const qr = el('device-invite-qr');
    const qrWrap = qr.closest('.device-invite-qr-wrap');
    qrWrap.hidden = !invite.qr_data_url;
    if (invite.qr_data_url) qr.src = invite.qr_data_url;
    el('device-invite-expiry').textContent = `Expires ${formatProjectDate(invite.expires_at)} · works once`;
    el('device-invite-code').textContent = invite.code;
    el('device-invite-link').value = deviceManagerInvite.link;
    el('btn-share-device-invite').hidden = typeof navigator.share !== 'function';
    result.hidden = false;
    progress.hidden = true;
    labelInput.value = '';
    await refreshDeviceAccess();
    result.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    toast('One-time device link created.');
  } catch (error) {
    console.error(error);
    progress.dataset.tone = 'danger';
    progress.textContent = error.message || 'The device invitation could not be created.';
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

async function disconnectWorkspaceDevice(button) {
  if (button.dataset.confirm !== 'true') {
    for (const other of all('[data-device-action="disconnect"]')) {
      other.dataset.confirm = 'false';
      other.textContent = 'Disconnect';
    }
    button.dataset.confirm = 'true';
    button.textContent = 'Confirm disconnect';
    button.focus();
    return;
  }
  button.disabled = true;
  try {
    await requestWorkspaceJson(`/api/workspace/devices/${encodeURIComponent(button.dataset.deviceId)}/revoke`, {
      method: 'POST',
    });
    await refreshDeviceAccess();
    toast(`“${button.dataset.deviceLabel}” can no longer access this workspace.`);
  } catch (error) {
    console.error(error);
    toast(error.message || 'That device could not be disconnected.');
    button.disabled = false;
  }
}

async function handlePendingDeviceInvite(button) {
  if (button.dataset.inviteAction === 'copy') {
    await copyText(button.dataset.inviteLink);
    toast('One-time device link copied.');
    return;
  }
  if (button.dataset.inviteAction !== 'cancel') return;
  button.disabled = true;
  try {
    await requestWorkspaceJson(`/api/workspace/device-invites/${encodeURIComponent(button.dataset.inviteId)}`, {
      method: 'DELETE',
    });
    if (String(deviceManagerInvite?.id) === button.dataset.inviteId) {
      deviceManagerInvite = null;
      el('device-invite-result').hidden = true;
    }
    await refreshDeviceAccess();
    toast('Unused device invitation cancelled.');
  } catch (error) {
    console.error(error);
    toast(error.message || 'The invitation could not be cancelled.');
    button.disabled = false;
  }
}

async function openStoredProject(id) {
  if (id === state.projectId) {
    closeProjectLibrary();
    return;
  }
  if (!await flushPendingSave()) return;
  const project = await loadProject(id);
  if (!project || project.trashedAt) {
    toast('That project is no longer available.');
    await refreshProjectLibrary();
    return;
  }
  styleAbort?.abort();
  await loadProjectState(project);
  await setLastProject(project.id);
  state.dirty = false;
  if (project.localSyncPending || !project.serverRevision) {
    await setPendingSaveState();
  } else {
    setSaveState('saved', savedAtLabel(new Date(project.serverSyncedAt || project.updatedAt)));
  }
  closeProjectLibrary();
  pushHistory();
  toast(`Opened “${project.name}”.`);
}

async function beginRenameProject(record) {
  renameProjectId = record.id;
  closeProjectLibrary();
  el('rename-project-input').value = record.name;
  const dialog = el('rename-project-dialog');
  dialog.returnValue = '';
  dialog.showModal();
  requestAnimationFrame(() => el('rename-project-input')?.select());
}

async function showProjectVersions(record) {
  versionProjectId = record.id;
  versionRows = await listCheckpoints(record.id);
  closeProjectLibrary();
  el('version-dialog-title').textContent = `Recovery points · ${record.name}`;
  const list = el('version-list');
  list.replaceChildren();
  if (!versionRows.length) {
    const item = document.createElement('li');
    item.textContent = 'No recovery points yet. Validate, repair, generate supports, or export to create one.';
    list.append(item);
  } else {
    for (const checkpoint of versionRows) {
      const item = document.createElement('li');
      item.dataset.checkpointId = checkpoint.id;
      const copy = document.createElement('div');
      const label = document.createElement('strong');
      label.textContent = checkpoint.label;
      const date = document.createElement('span');
      date.textContent = formatProjectDate(checkpoint.createdAt);
      copy.append(label, date);
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.dataset.checkpointAction = 'restore';
      restore.textContent = 'Restore';
      item.append(copy, restore);
      list.append(item);
    }
  }
  el('version-dialog').returnValue = '';
  el('version-dialog').showModal();
}

async function startNewProject() {
  closeProjectLibrary();
  const recoverableDraft = await loadProject(LOCAL_DRAFT_PROJECT_ID);
  if ((state.sourceMask || recoverableDraft) && !await confirmAction(
    'Start a new panel?',
    state.isDraft || recoverableDraft
      ? 'The current recoverable draft will be replaced. Save it to Projects first if you want to keep it.'
      : 'The current project is saved before the new panel opens.',
    'Start new',
  )) return;
  if (!await flushPendingSave()) return;
  styleAbort?.abort();
  if (state.isDraft || recoverableDraft) await deleteProject(LOCAL_DRAFT_PROJECT_ID);
  await clearLastProject();
  location.reload();
}

async function handleProjectAction(action, record) {
  if (action === 'open') {
    await openStoredProject(record.id);
    return;
  }
  if (action === 'rename') {
    await beginRenameProject(record);
    return;
  }
  if (action === 'duplicate') {
    const names = new Set((await listProjects()).map((row) => row.name));
    let name = `${record.name} copy`;
    let suffix = 2;
    while (names.has(name)) name = `${record.name} copy ${suffix++}`;
    const { checkpointCount: _checkpointCount, ...original } = record;
    const duplicate = await saveProject({
      ...original,
      id: null,
      serverRevision: 0,
      serverSyncedAt: null,
      serverSha256: null,
      name,
      createdAt: null,
      updatedAt: null,
      trashedAt: null,
    }, { makeCurrent: false });
    await syncStoredProject(duplicate);
    await refreshProjectLibrary();
    toast(`Duplicated as “${name}”.`);
    return;
  }
  if (action === 'download') {
    downloadText(projectFilename(record), serializeProject(record, { pretty: true }));
    toast('Portable project downloaded without the source photograph.');
    return;
  }
  if (action === 'share') {
    await openShareProject(record);
    return;
  }
  if (action === 'versions') {
    await showProjectVersions(record);
    return;
  }
  if (action === 'restore') {
    const restored = await restoreProject(record.id);
    await syncStoredProject(restored);
    projectLibraryView = 'active';
    await refreshProjectLibrary();
    toast(`Restored “${record.name}”.`);
    return;
  }
  if (action === 'trash') {
    closeProjectLibrary();
    if (!await confirmAction(
      'Move project to Trash?',
      `“${record.name}” can be restored later from the Projects library.`,
      'Move to Trash',
    )) {
      await openProjectLibrary({ flush: false });
      return;
    }
    if (record.id === state.projectId && !await flushPendingSave()) return;
    const trashed = await trashProject(record.id);
    await syncStoredProject(trashed);
    if (record.id === state.projectId) {
      location.reload();
      return;
    }
    await openProjectLibrary({ flush: false });
    toast(`Moved “${record.name}” to Trash.`);
    return;
  }
  if (action === 'delete') {
    closeProjectLibrary();
    if (!await confirmAction(
      'Delete project forever?',
      `“${record.name}” and its recovery points will be permanently removed from this server workspace and every linked device.`,
      'Delete forever',
    )) {
      await openProjectLibrary({ flush: false });
      return;
    }
    const deletion = await deleteServerProject(record);
    if (deletion.status === 'conflict') {
      await refreshProjectLibrary();
      toast(deletion.message);
      return;
    }
    if (deletion.status === 'superseded') {
      await refreshProjectLibrary();
      toast('A newer local edit is waiting to sync, so it was preserved instead of being silently deleted.');
      return;
    }
    await deleteProject(record.id);
    await openProjectLibrary({ flush: false });
    toast(`Deleted “${record.name}”.`);
  }
}

/* --------------------------------------------------------- project sharing */

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read a local artefact'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new TypeError('Invalid shared artefact');
  }
  const separator = dataUrl.indexOf(',');
  if (separator < 0 || !dataUrl.slice(0, separator).includes(';base64')) {
    throw new TypeError('Unsupported shared artefact encoding');
  }
  const mimeType = dataUrl.slice(5, separator).split(';')[0] || 'application/octet-stream';
  const decoded = atob(dataUrl.slice(separator + 1));
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

async function requestShareJson(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Sharing request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function requestWorkspaceJson(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Workspace request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function buildShareBundle(record) {
  return buildProjectBundle(record);
}

function shareLink(id, token) {
  const url = new URL(`/share/${encodeURIComponent(id)}`, location.origin);
  url.hash = `share-key=${encodeURIComponent(token)}`;
  return url.toString();
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
}

async function renderShareHistory() {
  const list = el('share-history');
  const empty = el('share-history-empty');
  if (!list || !empty || !sharingProject) return;
  try {
    const result = await requestShareJson('/api/shares');
    const rows = (result.shares || []).filter((share) => (
      share.direction === 'sent' && share.clientProjectId === sharingProject.id
    ));
    list.replaceChildren();
    empty.hidden = rows.length > 0;
    for (const share of rows) {
      const item = document.createElement('li');
      const copy = document.createElement('div');
      const heading = document.createElement('strong');
      heading.textContent = share.status === 'active'
        ? share.claimed ? 'Claimed share' : 'Active share'
        : `${share.status[0].toUpperCase()}${share.status.slice(1)} share`;
      const detail = document.createElement('span');
      detail.textContent = `${formatStorage(share.sizeBytes)} · expires ${formatProjectDate(share.expiresAt)}`;
      copy.append(heading, detail);
      const actions = document.createElement('div');
      if (share.status === 'active') {
        const token = await loadShareSecret(share.id);
        if (token) {
          const copyButton = document.createElement('button');
          copyButton.type = 'button';
          copyButton.dataset.shareAction = 'copy';
          copyButton.dataset.shareId = share.id;
          copyButton.dataset.shareToken = token;
          copyButton.textContent = 'Copy link';
          actions.append(copyButton);
        }
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.dataset.shareAction = 'revoke';
        revoke.dataset.shareId = share.id;
        revoke.textContent = 'Revoke';
        actions.append(revoke);
      }
      item.append(copy, actions);
      list.append(item);
    }
  } catch (error) {
    console.error(error);
    list.replaceChildren();
    empty.hidden = false;
    empty.textContent = 'Existing server shares could not be loaded.';
  }
}

async function openShareProject(record) {
  if (state.offline) {
    toast('Connect to the server before sharing a project.');
    return;
  }
  sharingProject = record;
  closeProjectLibrary();
  el('share-project-title').textContent = `Share “${record.name}”`;
  el('share-source-summary').textContent = record.localSource instanceof Blob
    ? `Original source · ${formatStorage(record.localSource.size)}`
    : 'No original source is stored for this project';
  const [checkpoints, artifacts] = await Promise.all([
    listCheckpoints(record.id),
    listArtifacts(record.id),
  ]);
  el('share-checkpoint-summary').textContent = `${checkpoints.length} recovery ${checkpoints.length === 1 ? 'point' : 'points'}`;
  el('share-artifact-summary').textContent = `${artifacts.length} retained export ${artifacts.length === 1 ? 'artefact' : 'artefacts'}`;
  el('share-result').hidden = true;
  el('share-progress').hidden = true;
  el('btn-create-share').disabled = false;
  const dialog = el('share-project-dialog');
  dialog.returnValue = '';
  dialog.showModal();
  await renderShareHistory();
}

async function createServerShare() {
  if (!sharingProject) return;
  state.shareBusy = true;
  const button = el('btn-create-share');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  el('share-progress').hidden = false;
  el('share-progress').textContent = 'Packaging the editable project and every stored artefact…';
  try {
    const bundle = await buildShareBundle(sharingProject);
    const payload = new Blob([JSON.stringify(bundle)], {
      type: 'application/vnd.stencil-cnc.share+json',
    });
    el('share-progress').textContent = `Uploading ${formatStorage(payload.size)} as an encrypted snapshot…`;
    const expiresDays = Number(el('share-expiry')?.value || 30);
    const share = await requestShareJson(`/api/shares?expiresDays=${expiresDays}`, {
      method: 'POST',
      body: payload,
    });
    await saveShareSecret(share.id, share.token);
    const link = shareLink(share.id, share.token);
    el('share-link').value = link;
    el('share-result-detail').textContent = `Expires ${formatProjectDate(share.expiresAt)} · one invited recipient device`;
    el('share-result').hidden = false;
    el('share-progress').hidden = true;
    await renderShareHistory();
    toast('Private project link created.');
  } catch (error) {
    console.error(error);
    el('share-progress').textContent = error.message || 'The project could not be shared.';
    toast(error.message || 'The project could not be shared.');
  } finally {
    state.shareBusy = false;
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

function sharedLocation() {
  const match = location.pathname.match(
    /^\/share\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/i,
  );
  if (!match) return null;
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get('share-key');
  return token ? { id: match[1], token } : null;
}

async function offerSharedProject() {
  const locationShare = sharedLocation();
  if (!locationShare) return;
  if (state.offline) {
    toast('Reconnect to open this server-hosted project share.');
    return;
  }
  try {
    const metadata = await requestShareJson(`/api/shares/${encodeURIComponent(locationShare.id)}/claim`, {
      method: 'POST',
      headers: { 'X-Share-Token': locationShare.token },
    });
    receivedShare = { ...locationShare, metadata };
    el('received-share-title').textContent = metadata.name;
    el('received-share-meta').textContent = [
      metadata.ownerLabel ? `Shared by ${metadata.ownerLabel}` : null,
      metadata.sheet ? `${metadata.sheet.widthMm} × ${metadata.sheet.heightMm} mm` : null,
      metadata.cutStyle ? CUT_STYLE_NAMES[metadata.cutStyle] || metadata.cutStyle : null,
      formatStorage(metadata.sizeBytes),
      metadata.hasSource ? 'original included' : 'processed geometry only',
      `${metadata.checkpointCount || 0} recovery points`,
      `${metadata.artifactCount || 0} exports`,
      `expires ${formatProjectDate(metadata.expiresAt)}`,
    ].filter(Boolean).join(' · ');
    const preview = el('received-share-preview');
    preview.hidden = !metadata.thumbnail;
    if (metadata.thumbnail) preview.src = metadata.thumbnail;
    el('received-share-dialog').showModal();
  } catch (error) {
    console.error(error);
    toast(error.message || 'This project share could not be opened.');
  }
}

async function importReceivedShare() {
  if (!receivedShare) return;
  state.shareBusy = true;
  const button = el('btn-import-shared-project');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  let saved = null;
  try {
    const response = await fetch(`/api/shares/${encodeURIComponent(receivedShare.id)}/bundle`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-Share-Token': receivedShare.token },
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'The shared project package could not be downloaded.');
    }
    const bundle = await response.json();
    if (bundle.schema !== SHARE_BUNDLE_SCHEMA || bundle.version !== SHARE_BUNDLE_VERSION) {
      throw new Error('This shared project uses an unsupported package format.');
    }
    const project = deserializeProject(JSON.stringify(bundle.project));
    const localSource = bundle.source?.dataUrl ? dataUrlToBlob(bundle.source.dataUrl) : null;
    saved = await saveProject({
      ...project,
      id: null,
      createdAt: null,
      updatedAt: null,
      localSource,
      sharedFrom: {
        shareId: receivedShare.id,
        ownerLabel: receivedShare.metadata.ownerLabel,
        importedAt: new Date().toISOString(),
      },
    });
    for (const checkpoint of (bundle.checkpoints || []).slice(0, 10)) {
      await importCheckpoint(saved.id, checkpoint);
    }
    for (const artifact of (bundle.artifacts || []).slice(0, 30)) {
      await importArtifact(saved.id, {
        ...artifact,
        blob: dataUrlToBlob(artifact.dataUrl),
      });
    }
    const syncResult = await syncStoredProject(saved);
    const syncedProjectId = syncResult.projectId || saved.id;
    saved = await loadProject(syncedProjectId) || saved;
    styleAbort?.abort();
    await loadProjectState(saved);
    await setLastProject(saved.id);
    state.dirty = false;
    el('received-share-dialog').close('imported');
    receivedShare = null;
    history.replaceState({}, document.title, '/');
    pushHistory();
    toast(['synced', 'conflict'].includes(syncResult.status)
      ? 'Shared project imported as a complete editable server project.'
      : 'Shared project imported and cached on this device; server synchronization is pending.');
  } catch (error) {
    console.error(error);
    if (saved?.id) await deleteProject(saved.id).catch(() => {});
    toast(error.message || 'The shared project could not be imported.');
  } finally {
    state.shareBusy = false;
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

/* ----------------------------------------------------------------- import */

function setSourceRecipeAvailability(available) {
  for (const node of all('#polarity input, #style-controls input, #style-controls button, #tone-inspector input, #tone-inspector button')) {
    node.disabled = !available;
  }
  if (available) reflectModeControls();
  if (!available) setStyleStatus('Processed geometry restored. Re-import the photograph to re-render its style.');
}

function applyCanonicalProjectControls(project) {
  el('measurement-unit').value = 'mm';
  state.unit = 'mm';
  state.geometryInterpretation = project.manufacturing.geometryInterpretation ?? FINISHED_BOUNDARY_CAM;
  state.cuttingProfileRevisionCounter = project.manufacturing.profile.revision;
  syncCuttingProfileControls(project.manufacturing.profile);
  el('panel-width').value = project.sheet.widthMm;
  el('panel-height').value = project.sheet.heightMm;
  reflectPanelOrientation();
  syncPanelSizePreset();
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

async function decodeTonePreview(payload) {
  if (!payload?.data || payload.mimeType !== 'image/png') return null;
  const binary = atob(payload.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: payload.mimeType }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return canvas;
}

async function loadProjectState(project, { imported = false } = {}) {
  project = upgradeProjectRecord(project);
  state.styleSettings = cloneStyleSettings(project.editor?.styleSettings);
  applyCanonicalProjectControls(project);
  if (project.editor?.controls) applyControls(project.editor.controls);
  else {
    resetArtworkTransformControls();
    state.activeStyle = selectedCutStyle();
    rememberStyleSettings(state.activeStyle);
  }
  // Profile dimensions are canonical millimetres and are deliberately not
  // duplicated in the display-unit control snapshot. Reapply them after the
  // saved measurement unit is known so an inch project cannot reinterpret a
  // 2 mm stock thickness as 2 inches.
  syncCuttingProfileControls(project.manufacturing.profile);
  state.projectId = imported ? null : project.id;
  state.isDraft = imported || project.localDraft === true;
  state.conflictOriginId = imported ? null : project.conflictOriginId || null;
  state.serverRevision = imported ? 0 : Number(project.serverRevision) || 0;
  state.createdAt = imported ? null : project.createdAt;
  state.name = project.name || 'Untitled panel';
  state.lastValidatedAt = project.editor?.projectSummary?.lastValidatedAt ?? null;
  state.lastExportedAt = project.editor?.projectSummary?.lastExportedAt ?? null;
  state.dirty = false;
  el('project-name').value = state.name;
  state.source = null;
  state.styleMask = null;
  state.styleMaskFor = null;
  state.styleMaskFresh = false;
  state.vectorDots = normalizeVectorDots(project.editor?.vectorDots);
  state.placedVectorDots = [];
  state.tonePreviewCanvas = null;
  state.tonePreviewFor = null;
  state.toneStatistics = null;
  state.lineToneCache = null;
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
  state.supportProposal = null;
  state.supportTapStart = null;
  state.bridgePreview = null;
  state.automaticSupportsStale = project.editor?.automaticSupportsStale === true;
  state.candidates = project.editor?.candidates ?? [];
  state.selectedCandidateId = project.editor?.selectedCandidateId ?? null;
  state.painted = {
    keep: new Set(project.editor?.painted?.keep ?? []),
    remove: new Set(project.editor?.painted?.remove ?? []),
  };
  state.manualEdits = normalizeManualEdits(project.editor?.manualEdits);
  state.selectedManualEditId = null;
  state.manufacturingRepairs = {
    keep: new Set(project.editor?.manufacturingRepairs?.keep ?? []),
    remove: new Set(project.editor?.manufacturingRepairs?.remove ?? []),
    enabled: project.editor?.manufacturingRepairs?.enabled !== false,
    stale: project.editor?.manufacturingRepairs?.stale === true,
    summary: project.editor?.manufacturingRepairs?.summary ?? null,
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
    ? `${state.source.originalWidth} × ${state.source.originalHeight} · encrypted server copy available`
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
  updateManufacturingRepairState();
  renderCandidates();
  renderManualEditManager();
  selectBridge(null);
  resetHistory();
  updateProjectPersistenceUi();
  if (state.isDraft) {
    setSaveState('draft', imported
      ? 'Imported as a recoverable draft · Save to Projects'
      : 'Draft saved on this device · Save to Projects');
  } else if (project.localSyncPending || !project.serverRevision) {
    await setPendingSaveState();
  } else {
    setSaveState('saved', savedAtLabel(new Date(project.serverSyncedAt ?? project.updatedAt ?? Date.now())));
  }
  if (state.source && state.mode === 'line-art' && !state.offline) void renderStyle();
}

async function importProjectFile(file) {
  try {
    const project = deserializeProject(await file.text());
    await loadProjectState(project, { imported: true });
    pushHistory();
    markDirty();
    toast('Editable Kerfloom project opened as a new local copy.');
  } catch (error) {
    console.error(error);
    toast('That Kerfloom project could not be read.');
  }
}

function resetManualStyleForNewImage() {
  const currentStyle = selectedCutStyle();
  if (!MANUAL_ONLY_STYLES.has(currentStyle)) return false;
  closeToolOptions();
  const lineArt = document.querySelector('input[name="cutStyle"][value="line-art"]');
  if (lineArt) lineArt.checked = true;
  activateStyleSettings('line-art');
  state.mode = 'line-art';
  setTool('pan');
  reflectModeControls();
  return true;
}

async function importFile(file) {
  if (!file) return;
  if (!await flushPendingSave()) return;
  if (file.name.toLowerCase().endsWith('.stencil.json') || file.type === 'application/json') {
    await importProjectFile(file);
    return;
  }
  if (/\.(?:heic|heif)$/i.test(file.name) || /image\/(?:heic|heif)/i.test(file.type)) {
    toast('HEIC/HEIF import is not supported in this browser build. Convert the image to JPG or PNG first.');
    return;
  }
  if (!file.type.startsWith('image/')) { toast('That file is not an image.'); return; }
  if (file.size > 30 * 1024 * 1024) { toast('Images must be 30 MB or smaller.'); return; }
  try {
    state.source = await decodeSourceFile(file, file.name);
    state.projectId = null;
    state.geometryInterpretation = FINISHED_BOUNDARY_CAM;
    state.createdAt = null;
    state.baseMask = null;
    state.styleMask = null;
    state.styleMaskFor = null;
    state.styleMaskFresh = false;
    state.vectorDots = null;
    state.placedVectorDots = [];
    state.tonePreviewCanvas = null;
    state.tonePreviewFor = null;
    state.toneStatistics = null;
    state.lineToneCache = null;
    state.contentBounds = null;
    state.contentSourceSize = null;
    state.painted = { keep: new Set(), remove: new Set() };
    state.manualEdits = [];
    state.selectedManualEditId = null;
    state.paintedFor = null;
    resetManufacturingRepairs();
    state.bridges = [];
    state.supportProposal = null;
    state.supportTapStart = null;
    state.bridgePreview = null;
    state.automaticSupportsStale = false;
    state.candidates = [];
    state.selectedCandidateId = null;
    state.selectedBridge = null;
    renderManualEditManager();
    resetArtworkTransformControls();
    state.validation = null;
    resetManualStyleForNewImage();
    resetHistory();
    state.lastValidatedAt = null;
    state.lastExportedAt = null;
    state.name = file.name.replace(/\.[^.]+$/, '').trim() || 'Untitled panel';
    el('project-name').value = state.name;
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
      syncPanelSizePreset({ preserveCustom: true });
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
  flux: 'Flow engraving',
  silueta: 'Silhouette',
  contururi: 'Contour bands',
  raze: 'Radial cuts',
  ornament: 'Ornamental symmetry',
  lamele: 'Slats',
  hasura: 'Hatch',
  puncte: 'Variable dots',
};

function cloneBridges(bridges = state.bridges) {
  return bridges.map((bridge) => ({
    ...bridge,
    width: Math.max(PLASMA_MIN_WEB_MM, Number(bridge.width) || PLASMA_MIN_WEB_MM),
    start: { ...bridge.start },
    end: { ...bridge.end },
  }));
}

function drawMaskThumbnail(sourceWidth, sourceHeight, metalAt) {
  if (!sourceWidth || !sourceHeight) return null;
  const maximumWidth = 260;
  const maximumHeight = 150;
  const scale = Math.min(maximumWidth / sourceWidth, maximumHeight / sourceHeight, 1);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const image = context.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor(y / height * sourceHeight));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor(x / width * sourceWidth));
      const metal = metalAt(sourceY * sourceWidth + sourceX);
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

function maskThumbnail(mask) {
  if (!mask) return null;
  return drawMaskThumbnail(mask.width, mask.height, (index) => mask.data[index] === RETAINED);
}

function drawProjectThumbnail(sourceWidth, sourceHeight, metalAt, panel) {
  if (!sourceWidth || !sourceHeight) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 260;
  canvas.height = 150;
  const context = canvas.getContext('2d');
  if (!context) return null;

  const panelWidth = Number(panel?.widthMm);
  const panelHeight = Number(panel?.heightMm);
  const panelAspect = panelWidth > 0 && panelHeight > 0
    ? panelWidth / panelHeight
    : sourceWidth / sourceHeight;
  const availableWidth = canvas.width - 20;
  const availableHeight = canvas.height - 14;
  let drawWidth = availableWidth;
  let drawHeight = Math.round(drawWidth / panelAspect);
  if (drawHeight > availableHeight) {
    drawHeight = availableHeight;
    drawWidth = Math.round(drawHeight * panelAspect);
  }
  drawWidth = Math.max(1, drawWidth);
  drawHeight = Math.max(1, drawHeight);
  const left = Math.floor((canvas.width - drawWidth) / 2);
  const top = Math.floor((canvas.height - drawHeight) / 2);
  const image = context.createImageData(canvas.width, canvas.height);

  for (let y = 0; y < drawHeight; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor(y / drawHeight * sourceHeight));
    for (let x = 0; x < drawWidth; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor(x / drawWidth * sourceWidth));
      const offset = ((top + y) * canvas.width + left + x) * 4;
      const value = metalAt(sourceY * sourceWidth + sourceX) ? 42 : 245;
      image.data[offset] = value;
      image.data[offset + 1] = value === 42 ? 46 : 244;
      image.data[offset + 2] = value === 42 ? 49 : 240;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  context.strokeStyle = '#aeb8b5';
  context.lineWidth = 1;
  context.strokeRect(left + 0.5, top + 0.5, Math.max(0, drawWidth - 1), Math.max(0, drawHeight - 1));
  return canvas.toDataURL('image/png');
}

function projectMaskThumbnail(mask, panel) {
  if (!mask) return null;
  return drawProjectThumbnail(
    mask.width,
    mask.height,
    (index) => mask.data[index] === RETAINED,
    panel,
  );
}

function encodedProjectMaskThumbnail(encoded, panel) {
  if (!encoded || encoded.encoding !== 'rle-u1' || !Number.isInteger(encoded.width) ||
      !Number.isInteger(encoded.height) || !Array.isArray(encoded.runs) || !encoded.runs.length) return null;
  let runIndex = 0;
  let runEnd = encoded.runs[0];
  let value = encoded.startsWith;
  return drawProjectThumbnail(encoded.width, encoded.height, (sourceIndex) => {
    while (sourceIndex >= runEnd && runIndex + 1 < encoded.runs.length) {
      runIndex += 1;
      runEnd += encoded.runs[runIndex];
      value = value === 1 ? 0 : 1;
    }
    return value === RETAINED;
  }, panel);
}

function candidateName(style) {
  const label = CUT_STYLE_NAMES[style] || 'Candidate';
  const count = state.candidates.filter((candidate) => candidate.controls?.cutStyle === style).length;
  return `${label} ${count + 1}`;
}

function candidatePayloadIsComplete(candidate) {
  return candidate?.payloadVersion === CANDIDATE_PAYLOAD_VERSION &&
    candidate.manufacturingRepairs !== null &&
    Boolean(candidate.geometry?.designFingerprint);
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
  rememberStyleSettings(style);
  const candidate = {
    payloadVersion: CANDIDATE_PAYLOAD_VERSION,
    id: crypto.randomUUID(),
    name: candidateName(style),
    createdAt: new Date().toISOString(),
    controls: readControls(),
    styleSettings: cloneStyleSettings(state.styleSettings),
    vectorDots: state.vectorDots,
    baseMask: encodeMask(state.baseMask),
    painted: { keep: [...state.painted.keep], remove: [...state.painted.remove] },
    manualEdits: state.manualEdits,
    paintedFor: state.paintedFor,
    manufacturingRepairs: {
      keep: [...state.manufacturingRepairs.keep],
      remove: [...state.manufacturingRepairs.remove],
      enabled: state.manufacturingRepairs.enabled,
      stale: state.manufacturingRepairs.stale,
      summary: state.manufacturingRepairs.summary
        ? JSON.parse(JSON.stringify(state.manufacturingRepairs.summary))
        : null,
    },
    bridges: cloneBridges(),
    geometry: {
      sourceRasterKey: state.sourceMask ? `${state.sourceMask.width}x${state.sourceMask.height}` : null,
      designFingerprint: maskFingerprint(state.designMask),
    },
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
  const completePayload = candidatePayloadIsComplete(candidate);
  if (completePayload) state.styleSettings = cloneStyleSettings(candidate.styleSettings);
  applyControls(candidate.controls);
  state.baseMask = decodeMask(candidate.baseMask);
  state.vectorDots = normalizeVectorDots(candidate.vectorDots);
  state.placedVectorDots = [];
  state.sourceMask = null;
  state.tonePreviewCanvas = null;
  state.tonePreviewFor = null;
  state.toneStatistics = null;
  state.lineToneCache = null;
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
  state.manualEdits = normalizeManualEdits(candidate.manualEdits);
  state.selectedManualEditId = null;
  state.paintedFor = candidate.paintedFor ?? candidate.geometry?.sourceRasterKey ?? null;
  if (completePayload) {
    state.manufacturingRepairs = {
      keep: new Set(candidate.manufacturingRepairs.keep ?? []),
      remove: new Set(candidate.manufacturingRepairs.remove ?? []),
      enabled: candidate.manufacturingRepairs.enabled !== false,
      stale: candidate.manufacturingRepairs.stale === true,
      summary: candidate.manufacturingRepairs.summary ?? null,
    };
  } else {
    resetManufacturingRepairs();
  }
  state.bridges = cloneBridges(candidate.bridges ?? []);
  state.supportProposal = null;
  state.supportTapStart = null;
  state.bridgePreview = null;
  state.selectedBridge = null;
  state.automaticSupportsStale = candidate.automaticSupportsStale === true;
  refresh({ immediate: true, preserveManufacturingRepairs: completePayload });
  state.selectedCandidateId = candidate.id;
  state.automaticSupportsStale = candidate.automaticSupportsStale === true;
  const expectedFingerprint = candidate.geometry?.designFingerprint ?? null;
  const actualFingerprint = state.designMask ? maskFingerprint(state.designMask) : null;
  const exact = completePayload && expectedFingerprint && expectedFingerprint === actualFingerprint;
  updateRangeOutputs();
  updateReadouts();
  updateAutomaticSupportState();
  updateManufacturingRepairState();
  renderCandidates();
  renderManualEditManager();
  setStyleStatus(exact
    ? `${candidate.name} restored exactly. Revalidate before export.`
    : completePayload
      ? `${candidate.name} restored, but its saved geometry signature differs. Review it before export.`
      : `${candidate.name} is a legacy candidate saved before repair layers were captured. Review it before export.`);
  setView('material');
  setStage('prepare');
  fitToView();
  pushHistory();
  toast(exact
    ? `${candidate.name} restored exactly. Run validation before export.`
    : `${candidate.name} restored as an editable recipe; review the result before export.`);
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
    const snapshotLabel = candidatePayloadIsComplete(candidate) ? 'complete snapshot' : 'legacy recipe';
    return `<li class="candidate-item${candidate.id === state.selectedCandidateId ? ' is-selected' : ''}" data-candidate-id="${escapeAttribute(candidate.id)}">
      <button class="candidate-restore" type="button" data-candidate-action="restore" aria-label="Restore ${escapeAttribute(candidate.name)}">
        ${thumbnail ? `<img src="${escapeAttribute(thumbnail)}" alt="">` : ''}
      </button>
      <div class="candidate-body">
        <input class="candidate-name" value="${escapeAttribute(candidate.name)}" maxlength="60" aria-label="Candidate name">
        <small class="candidate-meta">${escapeHtml(style)} · ${escapeHtml(when)} · ${snapshotLabel}${candidate.automaticSupportsStale ? ' · supports need review' : ''}</small>
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

function manufacturingRepairCount() {
  return state.manufacturingRepairs.keep.size + state.manufacturingRepairs.remove.size;
}

function resetManufacturingRepairs() {
  state.manufacturingRepairs = {
    keep: new Set(),
    remove: new Set(),
    enabled: true,
    stale: false,
    summary: null,
  };
  updateManufacturingRepairState();
}

function markManufacturingRepairsStale() {
  if (!manufacturingRepairCount() || state.manufacturingRepairs.stale) return false;
  state.manufacturingRepairs.stale = true;
  state.manufacturingRepairs.enabled = false;
  updateManufacturingRepairState();
  return true;
}

function updateManufacturingRepairState() {
  const status = el('repair-layer-status');
  if (!status) return;
  const count = manufacturingRepairCount();
  status.hidden = count === 0;
  if (count === 0) return;
  const stale = state.manufacturingRepairs.stale;
  const enabled = state.manufacturingRepairs.enabled && !stale;
  el('repair-layer-title').textContent = stale
    ? 'Repair layer needs regeneration'
    : enabled ? 'Manufacturing repair layer active' : 'Manufacturing repair layer hidden';
  const manualOverrideCount = Number(state.manufacturingRepairs.summary?.manualOverrideCount) || 0;
  el('repair-layer-detail').textContent = stale
    ? 'Artwork or machine settings changed. The old repairs are hidden so they cannot alter the new geometry.'
    : `${count.toLocaleString()} generated raster edits ${enabled ? 'remain active' : 'are currently hidden'} · separate from manual painting.${
      manualOverrideCount > 0
        ? ` ${manualOverrideCount.toLocaleString()} conflicting ${manualOverrideCount === 1 ? 'edit has' : 'edits have'} yielded to manual work.`
        : ''
    }`;
  const toggle = el('btn-toggle-repair-layer');
  if (toggle) {
    toggle.hidden = stale;
    toggle.textContent = enabled ? 'Hide' : 'Show';
  }
}

function toggleManufacturingRepairLayer() {
  if (!manufacturingRepairCount() || state.manufacturingRepairs.stale) return;
  state.manufacturingRepairs.enabled = !state.manufacturingRepairs.enabled;
  refresh({ immediate: true, preserveManufacturingRepairs: true });
  updateManufacturingRepairState();
  pushHistory();
}

function clearManufacturingRepairLayer() {
  if (!manufacturingRepairCount()) return;
  resetManufacturingRepairs();
  refresh({ immediate: true, preserveManufacturingRepairs: true });
  pushHistory();
  toast('Manufacturing repair layer removed. Manual edits were preserved.');
}

function supportLabel(bridge) {
  const styleName = CUT_STYLE_NAMES[bridge.strategy] || 'Artwork';
  if (bridge.source !== 'automatic') {
    return { title: 'Manual support', reason: 'Placed or edited by you.' };
  }
  if (bridge.stabilizer) {
    return {
      title: bridge.followsFeatures ? 'Feature-following stabilizer' : 'Slat stabilizer',
      reason: bridge.followsFeatures
        ? 'Moved into a darker feature band while preserving the span target.'
        : 'Limits the unsupported span between neighbouring slats.',
    };
  }
  if (bridge.fallback) {
    return {
      title: 'Shortest-path fallback',
      reason: 'The aesthetic search could not keep this required connection, so the shortest structural route was used.',
    };
  }
  if (bridge.redundant) {
    return {
      title: 'Secure backup support',
      reason: `Adds separated ${styleName.toLowerCase()}-aware redundancy.`,
    };
  }
  return {
    title: bridge.followsFeatures ? 'Feature-following smart support' : `${styleName}-aware smart support`,
    reason: bridge.followsFeatures
      ? 'Prefers dark, locally aligned artwork where the required connection still works.'
      : 'Uses the active style direction while preserving the required connection.',
  };
}

function renderSupportList() {
  const list = el('support-list');
  if (!list) return;
  const fragment = document.createDocumentFragment();
  state.bridges.forEach((bridge, index) => {
    const metrics = bridgeMetrics(bridge);
    const label = supportLabel(bridge);
    const item = document.createElement('li');
    item.className = 'support-list-item';
    item.classList.toggle('is-selected', bridge === state.selectedBridge);
    item.dataset.supportIndex = String(index);

    const select = document.createElement('button');
    select.className = 'support-list-select';
    select.type = 'button';
    select.dataset.supportAction = 'select';
    select.dataset.supportIndex = String(index);
    select.setAttribute('aria-pressed', String(bridge === state.selectedBridge));
    const title = document.createElement('strong');
    title.textContent = `${index + 1}. ${label.title}`;
    const detail = document.createElement('small');
    detail.textContent = `${roundUnit(fromMm(metrics.lengthMm))} ${state.unit} · ${Math.round(metrics.angleDeg)}°`;
    const reason = document.createElement('small');
    reason.className = 'support-list-reason';
    reason.textContent = label.reason;
    select.append(title, detail, reason);

    const locate = document.createElement('button');
    locate.className = 'support-list-action';
    locate.type = 'button';
    locate.dataset.supportAction = 'locate';
    locate.dataset.supportIndex = String(index);
    locate.textContent = 'Locate';
    locate.setAttribute('aria-label', `Locate support ${index + 1}`);

    const remove = document.createElement('button');
    remove.className = 'support-list-action is-danger';
    remove.type = 'button';
    remove.dataset.supportAction = 'delete';
    remove.dataset.supportIndex = String(index);
    remove.textContent = 'Delete';
    remove.setAttribute('aria-label', `Delete support ${index + 1}`);
    item.append(select, locate, remove);
    fragment.append(item);
  });
  list.replaceChildren(fragment);
  if (el('support-list-count')) el('support-list-count').textContent = String(state.bridges.length);
  el('support-list-empty')?.toggleAttribute('hidden', state.bridges.length > 0);
  for (const id of ['btn-previous-support', 'btn-next-support']) {
    el(id)?.toggleAttribute('disabled', state.bridges.length === 0);
  }
}

function locateBridge(bridge, { focusCanvas = true } = {}) {
  if (!bridge || !state.designMask) return false;
  setStage('support');
  setTool('support');
  selectBridge(bridge);
  const viewport = el('canvas-viewport');
  const canvas = el('editor-canvas');
  if (!viewport || !canvas) return false;
  const currentSheet = sheet();
  const midpoint = {
    x: (bridge.start.x + bridge.end.x) / 2 / currentSheet.widthMm * canvas.width,
    y: (bridge.start.y + bridge.end.y) / 2 / currentSheet.heightMm * canvas.height,
  };
  state.pan = {
    x: viewport.clientWidth / 2 - midpoint.x * state.zoom,
    y: viewport.clientHeight / 2 - midpoint.y * state.zoom,
  };
  applyTransform();
  if (focusCanvas) viewport.focus({ preventScroll: true });
  return true;
}

function selectAdjacentBridge(direction) {
  if (!state.bridges.length) return false;
  const current = state.bridges.indexOf(state.selectedBridge);
  const base = current < 0 ? (direction > 0 ? -1 : 0) : current;
  const index = (base + direction + state.bridges.length) % state.bridges.length;
  return locateBridge(state.bridges[index]);
}

function supportPlanSignature() {
  const manual = state.bridges
    .filter((bridge) => bridge.source !== 'automatic')
    .map((bridge) => ({
      start: bridge.start,
      end: bridge.end,
      width: bridge.width,
      enabled: bridge.enabled !== false,
    }));
  return JSON.stringify({
    source: state.sourceMask ? maskFingerprint(state.sourceMask) : null,
    sheet: sheet(),
    frame: frameConfig(),
    manual,
    geometryInterpretation: state.geometryInterpretation,
    kerfMm: toMm(numberField('kerf', 1.2)),
    minimumWebMm: toMm(numberField('min-web', 3)),
    bridgeWidthMm: toMm(numberField('bridge-width', 6)),
    strategy: numberField('bridge-count', 2),
    protectFaces: el('protect-faces')?.checked !== false,
    followFeatures: el('support-follow-features')?.checked === true,
    stabilizeSlats: el('stabilize-slats')?.checked === true,
    maximumUnsupportedSpanMm: toMm(numberField('max-cantilever', 250)),
    organic: numberField('stabilizer-organic', 75),
  });
}

function renderSupportProposal() {
  const proposal = state.supportProposal;
  const panel = el('support-proposal');
  panel?.toggleAttribute('hidden', !proposal);
  if (!proposal) return;
  el('support-proposal-summary').textContent = proposal.summary;
  el('support-proposal-connectivity').textContent = `${proposal.initialComponentCount} → ${proposal.finalComponentCount}`;
  el('support-proposal-count').textContent = String(proposal.bridges.length);
  el('support-proposal-fallbacks').textContent = String(proposal.fallbackCount);
  el('support-proposal-reason').textContent = proposal.reason;
  el('btn-accept-support-proposal')?.toggleAttribute('disabled', proposal.bridges.length === 0);
}

function clearSupportProposal({ redraw = true } = {}) {
  if (!state.supportProposal) return false;
  state.supportProposal = null;
  updateAutomaticSupportState();
  if (redraw) draw();
  return true;
}

function markAutomaticSupportsStale() {
  clearSupportProposal({ redraw: false });
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
  if (action) action.textContent = state.supportProposal
    ? 'Refresh smart-support proposal'
    : stale
      ? 'Update smart supports'
      : count ? 'Recalculate smart supports' : 'Suggest smart bridges';
  el('btn-clear-auto-bridges')?.toggleAttribute('disabled', count === 0);
  const counter = el('automatic-support-count');
  if (counter) counter.textContent = count ? String(count) : '';
  renderSupportList();
  renderSupportProposal();
}

function sourcePointOnSheet(normalizedX, normalizedY) {
  const placement = state.placement;
  const bounds = state.contentBounds;
  const sourceSize = state.contentSourceSize;
  if (!placement || !bounds || !sourceSize) return null;
  const sourceX = normalizedX * Math.max(0, sourceSize.width - 1);
  const sourceY = normalizedY * Math.max(0, sourceSize.height - 1);
  return pointFromArtworkPlacement(
    placement,
    (sourceX - bounds.x) / Math.max(1, bounds.width),
    (sourceY - bounds.y) / Math.max(1, bounds.height),
  );
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
      artworkTransform: artworkTransform(),
    },
  );
  const croppedWidthMm = rendered.widthMm * bounds.width / Math.max(1, sourceSize.width);
  if (!(croppedWidthMm > 0)) return 1;
  return state.placement.widthMm / croppedWidthMm;
}

/**
 * Builds two local-only views of the source photograph for bridge planning.
 * `detailAt` protects important portrait detail. `featureAt` does the inverse
 * aesthetic job: it tells the planner where added metal will disappear into a
 * dark eyebrow, hair mass, fold, or shadow, and which way that feature runs.
 */
function bridgeImageSamplers() {
  const protectDetail = el('protect-faces')?.checked === true;
  const followFeatures = el('support-follow-features')?.checked === true;
  if ((!protectDetail && !followFeatures) || !state.source?.imageData || !state.placement) {
    return { detailAt: null, featureAt: null, fallbackDetailAt: null };
  }
  const { width, height, data } = state.source.imageData;
  // Keep photographic guidance deliberately smaller than the uploaded image.
  // Phone photos are commonly 9-20 MP; duplicating one into a Float32Array can
  // add 40-80 MB just as the component planner allocates its own large rasters.
  // A bounded analysis raster is ample for choosing a bridge location and
  // feature direction, while preventing memory pressure from aborting support
  // planning before any structural work has begun.
  const analysisMaximumDimension = 768;
  const analysisScale = Math.min(1, analysisMaximumDimension / Math.max(width, height));
  const analysisWidth = Math.max(1, Math.round(width * analysisScale));
  const analysisHeight = Math.max(1, Math.round(height * analysisScale));
  const analysisLuminance = new Float32Array(analysisWidth * analysisHeight);
  // Relative percentiles make "dark" mean dark within this photograph, while
  // ignoring a few clipped black or white pixels that would distort the range.
  const histogram = new Uint32Array(256);
  for (let analysisY = 0; analysisY < analysisHeight; analysisY += 1) {
    const sourceY = analysisHeight === 1
      ? 0
      : Math.round(analysisY / (analysisHeight - 1) * (height - 1));
    for (let analysisX = 0; analysisX < analysisWidth; analysisX += 1) {
      const sourceX = analysisWidth === 1
        ? 0
        : Math.round(analysisX / (analysisWidth - 1) * (width - 1));
      const sourceOffset = (sourceY * width + sourceX) * 4;
      const alpha = data[sourceOffset + 3] / 255;
      const value = (0.2126 * data[sourceOffset] + 0.7152 * data[sourceOffset + 1]
        + 0.0722 * data[sourceOffset + 2]) * alpha + 255 * (1 - alpha);
      analysisLuminance[analysisY * analysisWidth + analysisX] = value;
      histogram[Math.round(value)] += 1;
    }
  }
  const sourceLuminance = (x, y) => analysisLuminance[
    Math.max(0, Math.min(analysisHeight - 1, y)) * analysisWidth
      + Math.max(0, Math.min(analysisWidth - 1, x))
  ];
  const percentile = (ratio) => {
    const target = analysisLuminance.length * ratio;
    let total = 0;
    for (let value = 0; value < histogram.length; value += 1) {
      total += histogram[value];
      if (total >= target) return value;
    }
    return 255;
  };
  const darkPoint = percentile(0.05);
  const lightPoint = Math.max(darkPoint + 24, percentile(0.95));
  const toneRange = lightPoint - darkPoint;
  const placement = { ...state.placement };
  const bounds = state.contentBounds ? { ...state.contentBounds } : null;
  const sourceSize = state.contentSourceSize ? { ...state.contentSourceSize } : null;

  const sampleSource = ({ x, y }) => {
    if (!bounds || !sourceSize) return null;
    const local = pointToArtworkPlacement(placement, { x, y });
    if (local.x < 0 || local.y < 0 || local.x > 1 || local.y > 1) return null;
    const localX = local.x;
    const localY = local.y;
    const fullX = (bounds.x + localX * bounds.width) / Math.max(1, sourceSize.width);
    const fullY = (bounds.y + localY * bounds.height) / Math.max(1, sourceSize.height);
    const imageX = Math.max(0, Math.min(analysisWidth - 1,
      Math.round(fullX * (analysisWidth - 1))));
    const imageY = Math.max(0, Math.min(analysisHeight - 1,
      Math.round(fullY * (analysisHeight - 1))));
    const center = sourceLuminance(imageX, imageY);
    const gx = sourceLuminance(imageX + 1, imageY) - sourceLuminance(imageX - 1, imageY);
    const gy = sourceLuminance(imageX, imageY + 1) - sourceLuminance(imageX, imageY - 1);
    const lightness = Math.max(0, Math.min(1, (center - darkPoint) / toneRange));
    const strength = Math.max(0, Math.min(1, Math.hypot(gx, gy) / Math.max(32, toneRange * 0.55)));
    const dx = (fullX - 0.5) / 0.42;
    const dy = (fullY - 0.43) / 0.48;
    const portraitFocus = Math.max(0, 1 - Math.hypot(dx, dy));
    // Protect light central face tissue separately from dark hair. Edge
    // strength alone cannot make that distinction: an eyebrow and a cheek
    // boundary are both detailed, but only the former can conceal a tie.
    const faceX = (fullX - 0.5) / 0.35;
    const faceY = (fullY - 0.43) / 0.34;
    const faceInterior = Math.max(0, 1 - Math.hypot(faceX, faceY));
    const lightSkinLikelihood = Math.max(0, Math.min(1, (lightness - 0.30) / 0.42));
    const portraitRisk = faceInterior * lightSkinLikelihood;
    return {
      lightness,
      strength,
      tangentAngleDeg: Math.atan2(gy, gx) * 180 / Math.PI + 90 + (placement.rotationDeg || 0),
      portraitFocus,
      portraitRisk,
    };
  };

  const detailAt = protectDetail ? (point) => {
    const sample = sampleSource(point);
    return sample ? Math.min(1, Math.max(sample.strength, sample.portraitFocus * 0.55)) : 0;
  } : null;
  return {
    // Feature samples already carry their own detail value, so do not sample
    // the photograph twice for every candidate. Retain the standalone sampler
    // only for the feature-free retry.
    detailAt: followFeatures ? null : detailAt,
    fallbackDetailAt: detailAt,
    featureAt: followFeatures ? (point) => {
      const sample = sampleSource(point);
      // Outside the visible source there is no image feature to hide in.
      if (!sample) return { lightness: 1, strength: 0, tangentAngleDeg: 0, detail: 0 };
      return {
        ...sample,
        detail: protectDetail ? Math.min(1, Math.max(sample.strength, sample.portraitFocus * 0.55)) : 0,
        portraitRisk: protectDetail ? sample.portraitRisk : 0,
      };
    } : null,
  };
}

function smartBridgeStrategy({ sampleImage = true } = {}) {
  const style = selectedCutStyle();
  const level = Math.max(1, Math.min(3, Number(el('bridge-count')?.value || 2)));
  const imageSamplers = sampleImage
    ? bridgeImageSamplers()
    : { detailAt: null, featureAt: null, fallbackDetailAt: null };
  const strategy = {
    mode: 'smart',
    kind: style,
    level,
    detailAt: imageSamplers.detailAt,
    featureAt: imageSamplers.featureAt,
    fallbackDetailAt: imageSamplers.fallbackDetailAt,
  };
  // A tie across parallel retained bars is their normal. It reads as one of
  // the pattern's own rungs, like the supplied diagonal-slat reference.
  if (style === 'lamele') {
    const barAngleDeg = numberField('style-slat-angle', -55) + artworkTransform().rotationDeg;
    strategy.preferredAngleDeg = barAngleDeg + 90;
    strategy.barAngleDeg = barAngleDeg;
    strategy.slatPitchMm = toMm(numberField('style-pitch', 38)) * placedStyleScale();
    strategy.organicVariation = numberField('stabilizer-organic', 75) / 100;
    if (el('stabilize-slats')?.checked !== false) {
      strategy.maximumUnsupportedSpanMm = toMm(numberField('max-cantilever', 250));
    }
  } else if (style === 'hasura') {
    strategy.preferredAngleDeg = numberField('style-angle', 30) + artworkTransform().rotationDeg + 90;
  } else if (style === 'flux') {
    strategy.preferredAngleDeg = numberField('style-flow-angle', -15) + artworkTransform().rotationDeg + 90;
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
  toast(el('support-follow-features')?.checked
    ? 'Planning supports in dark, feature-aligned areas where structure allows…'
    : 'Planning the smallest style-aware support network…');
  // Let the pending state paint before the component graph occupies the main
  // thread. The planner remains entirely local to the browser.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const kerfMm = toMm(numberField('kerf', 1.2));
  const minimumWebMm = Math.max(PLASMA_MIN_WEB_MM, toMm(numberField('min-web', 3)));
  const requestedWidthMm = Math.max(PLASMA_MIN_WEB_MM, toMm(numberField('bridge-width', 6)));
  const widthMm = Math.max(
    requestedWidthMm,
    rasterWebWidthMm(minimumWebMm, kerfMm, state.geometryInterpretation),
  );
  if (widthMm > requestedWidthMm + 1e-9) {
    el('bridge-width').value = roundUnit(fromMm(widthMm));
    updateRangeOutputs();
    toast(`Raised bridge width to ${el('bridge-width').value} ${state.unit} to meet the finished-web requirement.`);
  }
  try {
    const manual = state.bridges.filter((bridge) => bridge.source !== 'automatic');
    const base = buildDesignMask(state.sourceMask, {
      sheet: sheet(), frame: frameConfig(), bridges: manual,
    });
    const planningConfig = {
      sheet: sheet(),
      widthMm,
      anchorMask: base.frameMask,
      anchorBoundary: false,
      requireSingleComponent: true,
      minimumWebMm,
      kerfMm,
      geometryInterpretation: state.geometryInterpretation,
      maxPasses: 4,
    };
    let strategy;
    let usedImageFallback = false;
    try {
      strategy = smartBridgeStrategy();
    } catch (imageError) {
      // Feature guidance is optional. A large or unusual source image must
      // never prevent the geometry-only support planner from running.
      console.warn('Could not prepare image guidance for smart supports; using structural placement.', imageError);
      strategy = smartBridgeStrategy({ sampleImage: false });
      usedImageFallback = true;
    }
    const planWith = (candidateStrategy) => suggestKerfAwareBridges(base.mask, {
      ...planningConfig,
      strategy: candidateStrategy,
    });
    let plan;
    try {
      plan = planWith(strategy);
    } catch (featureError) {
      if (!strategy.featureAt) throw featureError;
      // A failing photographic callback should only weaken the aesthetic
      // guidance, never cancel the structural repair. First retain facial
      // detail avoidance; if that sampler also fails, use geometry alone.
      console.warn('Feature-following support scoring failed; retrying without it.', featureError);
      try {
        plan = planWith({
          ...strategy,
          featureAt: null,
          detailAt: strategy.fallbackDetailAt,
        });
      } catch (detailError) {
        console.warn('Image-aware support scoring failed; retrying structurally.', detailError);
        plan = planWith(smartBridgeStrategy({ sampleImage: false }));
      }
      usedImageFallback = true;
    }
    const suggested = plan.bridges;
    const proposedDesign = buildDesignMask(state.sourceMask, {
      sheet: sheet(), frame: frameConfig(), bridges: [...manual, ...suggested],
    });
    const supportSimulation = validateDesign(proposedDesign.mask, {
      sheet: sheet(),
      kerfMm,
      minimumWebMm: 0,
      minimumOpeningMm: 0,
      geometryInterpretation: state.geometryInterpretation,
      anchorBoundary: false,
      requireAnchored: false,
      requireSingleComponent: true,
    });
    const finishedConnected = supportSimulation.postKerf.componentCount === 1;
    const fallbackCount = suggested.filter((bridge) => bridge.fallback).length;
    const redundantCount = suggested.filter((bridge) => bridge.redundant).length;
    const stabilizerCount = suggested.filter((bridge) => bridge.stabilizer).length;
    const connectorCount = suggested.length - stabilizerCount;
    const additions = [
      connectorCount ? `${connectorCount} connectivity ${connectorCount === 1 ? 'bridge' : 'bridges'}` : '',
      stabilizerCount ? `${stabilizerCount} staggered slat ${stabilizerCount === 1 ? 'stabilizer' : 'stabilizers'}` : '',
    ].filter(Boolean).join(' and ');
    const repairSummary = plan.initialComponentCount > 1
      ? ` Finished-geometry pieces: ${plan.initialComponentCount} → ${plan.finalComponentCount} in ${plan.passes} ${plan.passes === 1 ? 'pass' : 'passes'}.`
      : '';
    const fallbackNotice = usedImageFallback
      ? ' Image guidance was unavailable, so structural placement was used.'
      : '';
    const resultMessage = suggested.length
      ? `Would add ${additions}${redundantCount ? ` (${redundantCount} redundant)` : ''}${fallbackCount ? ` · ${fallbackCount} shortest-path fallback` : ''}.${repairSummary}${finishedConnected ? ' The connectivity check finds one finished piece.' : ' Some finished geometry would still be separate.'}`
      : finishedConnected
        ? 'Everything is already one connected finished piece.'
        : 'No automatic support plan passed the connectivity check; reduce detail or add a manual support.';
    if (!suggested.length) {
      clearSupportProposal();
      toast(`${resultMessage}${fallbackNotice}`);
      return;
    }
    const reasons = [];
    if (fallbackCount) reasons.push(`${fallbackCount} required shortest-path ${fallbackCount === 1 ? 'fallback is' : 'fallbacks are'} shown in orange`);
    if (usedImageFallback) reasons.push('image guidance was unavailable, so structural placement was used');
    if (!finishedConnected) reasons.push('the proposal does not yet connect every finished piece');
    if (!reasons.length) reasons.push('all proposed supports passed the requested feature and connectivity planning pass');
    state.supportProposal = {
      bridges: suggested,
      signature: supportPlanSignature(),
      initialComponentCount: plan.initialComponentCount,
      finalComponentCount: plan.finalComponentCount,
      fallbackCount,
      redundantCount,
      stabilizerCount,
      finishedConnected,
      summary: `${resultMessage}${fallbackNotice}`,
      reason: `${reasons.join('; ')}. Existing supports remain unchanged until you accept.`,
    };
    selectBridge(null);
    updateAutomaticSupportState();
    draw();
    toast(`Smart-support proposal ready: ${suggested.length} ${suggested.length === 1 ? 'support' : 'supports'} to review.`);
  } catch (error) {
    console.error(error);
    const reason = error instanceof Error && error.message
      ? ` ${error.message}`
      : '';
    toast(`Support planning failed before changing the geometry.${reason}`);
  } finally {
    button?.removeAttribute('aria-busy');
    if (button) button.disabled = false;
    updateAutomaticSupportState();
  }
}

async function acceptSupportProposal() {
  const proposal = state.supportProposal;
  if (!proposal) return false;
  if (proposal.signature !== supportPlanSignature()) {
    clearSupportProposal();
    updateAutomaticSupportState();
    toast('The artwork or support settings changed. Generate a fresh proposal before applying it.');
    return false;
  }
  const manual = state.bridges.filter((bridge) => bridge.source !== 'automatic');
  const count = proposal.bridges.length;
  const finishedConnected = proposal.finishedConnected;
  state.bridges = [...manual, ...proposal.bridges];
  state.supportProposal = null;
  state.automaticSupportsStale = false;
  selectBridge(null);
  refresh({ immediate: true, rebuildSourceMask: false });
  pushHistory();
  toast(`Applied ${count} smart ${count === 1 ? 'support' : 'supports'} as one undoable action.${finishedConnected ? ' The finished geometry is connected.' : ' Validate to review the remaining separation.'}`);
  await createRecoveryPoint('Smart supports accepted');
  return true;
}

function discardSupportProposal() {
  if (!clearSupportProposal()) return false;
  updateAutomaticSupportState();
  toast('Smart-support proposal discarded. Existing supports were not changed.');
  return true;
}

function selectBridge(bridge) {
  state.supportTapStart = null;
  state.bridgePreview = null;
  state.selectedBridge = bridge;
  el('bridge-selection').hidden = !bridge;
  el('bridge-selection-empty').hidden = Boolean(bridge);
  if (bridge) {
    syncSelectedBridgeControls();
  }
  updateAutomaticSupportState();
  draw();
}

function bridgeMetrics(bridge) {
  const dx = bridge.end.x - bridge.start.x;
  const dy = bridge.end.y - bridge.start.y;
  let angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
  if (angleDeg > 180) angleDeg -= 360;
  if (angleDeg <= -180) angleDeg += 360;
  return { lengthMm: Math.hypot(dx, dy), angleDeg };
}

function syncSelectedBridgeControls({ renderList = true } = {}) {
  const bridge = state.selectedBridge;
  if (!bridge) return;
  const metrics = bridgeMetrics(bridge);
  const center = {
    x: (bridge.start.x + bridge.end.x) / 2,
    y: (bridge.start.y + bridge.end.y) / 2,
  };
  bridge.lengthMm = metrics.lengthMm;
  if (el('selected-bridge-width')) el('selected-bridge-width').value = roundUnit(fromMm(bridge.width));
  if (el('selected-bridge-length')) {
    el('selected-bridge-length').min = roundUnit(fromMm(1));
    el('selected-bridge-length').value = roundUnit(fromMm(metrics.lengthMm));
  }
  if (el('selected-bridge-angle')) el('selected-bridge-angle').value = Math.round(metrics.angleDeg * 10) / 10;
  if (el('selected-bridge-center-x')) {
    el('selected-bridge-center-x').max = roundUnit(fromMm(sheet().widthMm));
    el('selected-bridge-center-x').value = roundUnit(fromMm(center.x));
  }
  if (el('selected-bridge-center-y')) {
    el('selected-bridge-center-y').max = roundUnit(fromMm(sheet().heightMm));
    el('selected-bridge-center-y').value = roundUnit(fromMm(center.y));
  }
  const metadata = el('bridge-selection-meta');
  if (metadata) {
    const length = ` · ${roundUnit(fromMm(metrics.lengthMm))} ${state.unit} long`;
    const styleName = CUT_STYLE_NAMES[bridge.strategy] || 'Artwork';
    if (bridge.source !== 'automatic') metadata.textContent = `Manual support${length}`;
    else if (bridge.stabilizer) metadata.textContent = `${bridge.followsFeatures ? 'Feature-following slat stabilizer' : 'Slat stabilizer'} · ${roundUnit(fromMm(bridge.targetSpanMm || toMm(numberField('max-cantilever', 250))))} ${state.unit} target span${length}`;
    else if (bridge.fallback) metadata.textContent = `Shortest-path fallback${length} · review its placement`;
    else if (bridge.redundant) metadata.textContent = `${styleName}-aware secure redundancy${length}`;
    else metadata.textContent = `${bridge.followsFeatures ? 'Feature-following' : `${styleName}-aware`} smart support${length}`;
  }
  if (renderList) renderSupportList();
}

function setBridgeGeometry(bridge, { lengthMm, angleDeg }) {
  if (!bridge) return;
  const current = bridgeMetrics(bridge);
  const requestedLength = Number.isFinite(lengthMm) ? Math.max(1, lengthMm) : current.lengthMm;
  const requestedAngle = Number.isFinite(angleDeg) ? angleDeg : current.angleDeg;
  const radians = requestedAngle * Math.PI / 180;
  const direction = { x: Math.cos(radians), y: Math.sin(radians) };
  const currentSheet = sheet();
  const maximumLength = Math.min(
    Math.abs(direction.x) > 1e-9 ? currentSheet.widthMm / Math.abs(direction.x) : Infinity,
    Math.abs(direction.y) > 1e-9 ? currentSheet.heightMm / Math.abs(direction.y) : Infinity,
  );
  const fittedLength = Math.min(requestedLength, maximumLength);
  const center = {
    x: (bridge.start.x + bridge.end.x) / 2,
    y: (bridge.start.y + bridge.end.y) / 2,
  };
  const half = fittedLength / 2;
  let start = { x: center.x - direction.x * half, y: center.y - direction.y * half };
  let end = { x: center.x + direction.x * half, y: center.y + direction.y * half };
  const minimumX = Math.min(start.x, end.x);
  const maximumX = Math.max(start.x, end.x);
  const minimumY = Math.min(start.y, end.y);
  const maximumY = Math.max(start.y, end.y);
  const shiftX = minimumX < 0 ? -minimumX : maximumX > currentSheet.widthMm ? currentSheet.widthMm - maximumX : 0;
  const shiftY = minimumY < 0 ? -minimumY : maximumY > currentSheet.heightMm ? currentSheet.heightMm - maximumY : 0;
  start = { x: start.x + shiftX, y: start.y + shiftY };
  end = { x: end.x + shiftX, y: end.y + shiftY };
  bridge.start = start;
  bridge.end = end;
  bridge.lengthMm = fittedLength;
}

function translateBridge(bridge, requestedDx, requestedDy) {
  if (!bridge) return;
  const currentSheet = sheet();
  const dx = Math.max(-Math.min(bridge.start.x, bridge.end.x), Math.min(
    currentSheet.widthMm - Math.max(bridge.start.x, bridge.end.x), requestedDx,
  ));
  const dy = Math.max(-Math.min(bridge.start.y, bridge.end.y), Math.min(
    currentSheet.heightMm - Math.max(bridge.start.y, bridge.end.y), requestedDy,
  ));
  bridge.start = { x: bridge.start.x + dx, y: bridge.start.y + dy };
  bridge.end = { x: bridge.end.x + dx, y: bridge.end.y + dy };
}

function setBridgeCenter(bridge, { xMm, yMm }) {
  if (!bridge) return;
  const center = {
    x: (bridge.start.x + bridge.end.x) / 2,
    y: (bridge.start.y + bridge.end.y) / 2,
  };
  translateBridge(
    bridge,
    Number.isFinite(xMm) ? xMm - center.x : 0,
    Number.isFinite(yMm) ? yMm - center.y : 0,
  );
}

function deleteSelectedBridge() {
  const bridge = state.selectedBridge;
  if (!bridge) return false;
  clearSupportProposal();
  const reviewAnchor = captureManualValidationReview();
  state.bridges = state.bridges.filter((candidate) => candidate !== bridge);
  if (state.hoveredBridge === bridge) state.hoveredBridge = null;
  selectBridge(null);
  refresh({ immediate: true, rebuildSourceMask: false, manualGeometryEdit: true });
  pushHistory();
  scheduleManualValidationReview(reviewAnchor);
  toast('Support deleted.');
  return true;
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
    rasterWebWidthMm(
      toMm(numberField('min-web', 3)),
      toMm(numberField('kerf', 1.2)),
      state.geometryInterpretation,
    ),
  );
}

function safeBridgeWidthMm(value = toMm(numberField('bridge-width', 6))) {
  return Math.max(Number.isFinite(value) ? value : 0, requiredBridgeWidthMm());
}

function preferredManualSupportAngle(start, end) {
  if (el('support-follow-style')?.checked !== true) return null;
  const style = selectedCutStyle();
  const rotationDeg = artworkTransform().rotationDeg;
  if (style === 'lamele') return numberField('style-slat-angle', -55) + rotationDeg + 90;
  if (style === 'hasura') return numberField('style-angle', 30) + rotationDeg + 90;
  if (style === 'flux') return numberField('style-flow-angle', -15) + rotationDeg + 90;
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

function manualSupportPoint(point, start = null, { followDirection = true } = {}) {
  const currentSheet = sheet();
  const raw = {
    x: Math.max(0, Math.min(currentSheet.widthMm, point.x)),
    y: Math.max(0, Math.min(currentSheet.heightMm, point.y)),
  };
  const maximumDistance = Math.max(20, safeBridgeWidthMm() * 3);
  if (!start) return nearestRetainedPoint(raw, maximumDistance);
  const aligned = followDirection ? constrainSupportEndpoint(start, raw) : raw;
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
  clearSupportProposal();
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
  const screenToleranceMm = sheet().widthMm / canvasWidth * (event.pointerType === 'touch' ? 24 : 14);
  let nearest = null;
  let nearestDistance = Infinity;
  for (let index = state.bridges.length - 1; index >= 0; index -= 1) {
    const bridge = state.bridges[index];
    const distance = distanceToSegment(
      { x: point.mmX, y: point.mmY }, bridge.start, bridge.end,
    );
    const tolerance = Math.max(bridge.width / 2, screenToleranceMm);
    if (distance <= tolerance && distance < nearestDistance) {
      nearest = bridge;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function bridgeHandleAtPointer(event) {
  const bridge = state.selectedBridge;
  if (!bridge || !state.designMask) return null;
  const point = pointerToMm(event);
  if (!point.inside) return null;
  const canvasWidth = Math.max(1, el('editor-canvas').getBoundingClientRect().width);
  const toleranceMm = sheet().widthMm / canvasWidth * (event.pointerType === 'touch' ? 26 : 15);
  const cursor = { x: point.mmX, y: point.mmY };
  if (Math.hypot(cursor.x - bridge.start.x, cursor.y - bridge.start.y) <= toleranceMm) return 'start';
  if (Math.hypot(cursor.x - bridge.end.x, cursor.y - bridge.end.y) <= toleranceMm) return 'end';
  const midpoint = {
    x: (bridge.start.x + bridge.end.x) / 2,
    y: (bridge.start.y + bridge.end.y) / 2,
  };
  if (Math.hypot(cursor.x - midpoint.x, cursor.y - midpoint.y) <= toleranceMm) return 'move';
  return null;
}

/* ----------------------------------------------------------------- export */

function pngBlob(mask, { draft = false, exactCircleHoles = [] } = {}) {
  const raster = maskToRgba(mask);
  const scale = exactCircleHoles.length ? Math.min(2, 5200 / Math.max(raster.width, raster.height)) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(raster.width * scale));
  canvas.height = Math.max(1, Math.round(raster.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas rendering is unavailable');
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = raster.width;
  sourceCanvas.height = raster.height;
  const sourceContext = sourceCanvas.getContext('2d');
  if (!sourceContext) throw new Error('Canvas rendering is unavailable');
  const image = sourceContext.createImageData(raster.width, raster.height);
  image.data.set(raster.data);
  sourceContext.putImageData(image, 0, 0);
  context.imageSmoothingEnabled = false;
  context.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
  if (exactCircleHoles.length) {
    const currentSheet = sheet();
    const scaleX = canvas.width / currentSheet.widthMm;
    const scaleY = canvas.height / currentSheet.heightMm;
    context.fillStyle = '#2a2e34';
    for (const circle of exactCircleHoles) {
      const cx = circle.cxMm * scaleX;
      const cy = circle.cyMm * scaleY;
      const rx = circle.radiusMm * scaleX;
      const ry = circle.radiusMm * scaleY;
      context.fillRect(cx - rx - scale, cy - ry - scale, rx * 2 + scale * 2, ry * 2 + scale * 2);
    }
    context.fillStyle = '#f5f4f0';
    for (const circle of exactCircleHoles) {
      context.beginPath();
      context.ellipse(
        circle.cxMm * scaleX,
        circle.cyMm * scaleY,
        circle.radiusMm * scaleX,
        circle.radiusMm * scaleY,
        0, 0, Math.PI * 2,
      );
      context.fill();
    }
  }
  if (draft) drawDraftWatermark(context, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('The browser could not encode the PNG'));
    }, 'image/png');
  });
}

async function exportGeometry(kind) {
  if (!state.designMask) {
    toast('Import or create artwork before exporting.');
    return;
  }
  const validated = currentGeometryIsValidated();
  if (kind !== 'png' && !validated) {
    toast('Run the checks again before exporting cutting geometry.');
    return;
  }
  const draft = kind === 'png' && !validated;
  // Cutting exports validate and download the same transformed mask. Draft
  // PNG is the deliberate exception: it may show unsafe work, so the file is
  // visibly watermarked and cannot be mistaken for released cut geometry.
  const mask = geometryForExport();
  const vectorCircleHoles = availableVectorDotHoles();
  const previewCircleHoles = exactVectorDotHoles();
  try {
    const units = el('export-units')?.value === 'in' ? 'in' : 'mm';
    let blob;
    let filename;
    if (kind === 'svg') {
      filename = exportFilename('svg');
      blob = new Blob([exportSvg(mask, sheet(), { title: state.name, units, exactCircleHoles: vectorCircleHoles })], { type: 'image/svg+xml' });
    } else if (kind === 'dxf') {
      filename = exportFilename('dxf');
      blob = new Blob([exportDxf(mask, sheet(), { units, exactCircleHoles: vectorCircleHoles })], { type: 'application/dxf' });
    } else if (kind === 'png') {
      filename = exportFilename('png', undefined, { draft });
      blob = await pngBlob(mask, { draft, exactCircleHoles: previewCircleHoles });
    } else {
      throw new Error(`Unsupported export format: ${kind}`);
    }
    downloadBlob(filename, blob);
    state.lastExportedAt = new Date().toISOString();
    markDirty();
    await createRecoveryPoint(draft ? 'Draft PNG exported' : `${kind.toUpperCase()} exported`);
    if (state.projectId && !state.isDraft) {
      try {
        await saveArtifact(state.projectId, {
          filename,
          kind,
          mimeType: blob.type,
          blob,
          profileSnapshot: cuttingProfileFromControls(),
        });
        const withArtifact = await loadProject(state.projectId);
        if (withArtifact) await syncStoredProject(withArtifact);
      } catch (artifactError) {
        console.warn('The downloaded export could not be retained with the server project:', artifactError);
      }
    }
    toast(draft
      ? 'Draft PNG written with a validation watermark.'
      : `${kind.toUpperCase()} written.`);
  } catch (error) {
    console.error(error);
    toast(`The ${kind.toUpperCase()} could not be written.`);
  }
}

function exportFilename(kind, timestamp = state.exportTimestamp ?? new Date(), { draft = false } = {}) {
  const style = selectedCutStyle();
  const projectFile = kind === 'project';
  return buildExportFilename({
    projectName: state.name,
    sheet: sheet(),
    styleName: CUT_STYLE_NAMES[style] || style,
    includeFrame: projectFile ? frameConfig().enabled : el('export-frame')?.checked !== false,
    purpose: projectFile ? 'editable' : kind === 'png' ? draft ? 'draft-preview' : 'preview' : 'cut',
    extension: projectFile ? 'stencil.json' : kind,
    timestamp,
  });
}

/* ------------------------------------------------------------------ chrome */

const MOBILE_WORKSPACE_QUERY = '(max-width: 720px)';
let mobileSheet = null;
let mobileSheetReturnFocus = null;
let tabKeyboardNavigation = false;

function mobileWorkspaceActive() {
  return window.matchMedia?.(MOBILE_WORKSPACE_QUERY).matches === true;
}

function syncMobileWorkspaceLayout() {
  const mobile = mobileWorkspaceActive();
  const controls = el('stage-controls-pane');
  const review = el('review-pane');
  if (!mobile) {
    mobileSheet = null;
    controls?.classList.remove('is-mobile-open');
    review?.classList.remove('is-mobile-open');
    if (controls) controls.inert = false;
    if (review) review.inert = false;
    el('mobile-sheet-backdrop')?.setAttribute('hidden', '');
    el('btn-mobile-controls')?.setAttribute('aria-expanded', 'false');
    el('btn-mobile-review')?.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('mobile-sheet-open');
    return;
  }
  if (controls) controls.inert = mobileSheet !== 'controls';
  if (review) review.inert = mobileSheet !== 'review';
}

function closeMobileSheet({ returnFocus = false } = {}) {
  const trigger = mobileSheetReturnFocus;
  const focusedInSheet = el('stage-controls-pane')?.contains(document.activeElement)
    || el('review-pane')?.contains(document.activeElement);
  mobileSheet = null;
  mobileSheetReturnFocus = null;
  el('stage-controls-pane')?.classList.remove('is-mobile-open');
  el('review-pane')?.classList.remove('is-mobile-open');
  el('btn-mobile-controls')?.setAttribute('aria-expanded', 'false');
  el('btn-mobile-review')?.setAttribute('aria-expanded', 'false');
  el('mobile-sheet-backdrop')?.setAttribute('hidden', '');
  document.body.classList.remove('mobile-sheet-open');
  syncMobileWorkspaceLayout();
  if (returnFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
  else if (focusedInSheet) el('canvas-viewport')?.focus({ preventScroll: true });
}

function openMobileSheet(kind) {
  if (!mobileWorkspaceActive() || !['controls', 'review'].includes(kind)) return;
  closeToolOptions();
  const controls = el('stage-controls-pane');
  const review = el('review-pane');
  mobileSheet = kind;
  mobileSheetReturnFocus = el(kind === 'controls' ? 'btn-mobile-controls' : 'btn-mobile-review');
  controls?.classList.toggle('is-mobile-open', kind === 'controls');
  review?.classList.toggle('is-mobile-open', kind === 'review');
  el('btn-mobile-controls')?.setAttribute('aria-expanded', String(kind === 'controls'));
  el('btn-mobile-review')?.setAttribute('aria-expanded', String(kind === 'review'));
  el('mobile-sheet-backdrop')?.removeAttribute('hidden');
  document.body.classList.add('mobile-sheet-open');
  syncMobileWorkspaceLayout();
  requestAnimationFrame(() => {
    el(kind === 'controls' ? 'btn-close-mobile-controls' : 'btn-close-mobile-review')
      ?.focus({ preventScroll: true });
  });
}

function wireTabKeyboard(tabList, selector = '[role="tab"]') {
  if (!tabList) return;
  tabList.addEventListener('keydown', (event) => {
    const tabs = [...tabList.querySelectorAll(selector)].filter((tab) => !tab.disabled && !tab.hidden);
    const currentIndex = tabs.indexOf(event.target.closest?.(selector));
    if (currentIndex < 0) return;
    const nextIndex = tabIndexForKey(event.key, currentIndex, tabs.length);
    if (nextIndex === null) return;
    event.preventDefault();
    tabKeyboardNavigation = true;
    try {
      tabs[nextIndex].click();
    } finally {
      tabKeyboardNavigation = false;
    }
    tabs[nextIndex].focus({ preventScroll: true });
  });
}

function setStage(stage) {
  const previousStage = state.stage;
  state.stage = stage;
  const order = ['prepare', 'panel', 'support', 'validate', 'export'];
  for (const name of order) {
    const tab = el(`stage-${name}`);
    const panel = el(`panel-${name}`);
    const active = name === stage;
    tab?.setAttribute('aria-selected', String(active));
    if (tab) tab.tabIndex = active ? 0 : -1;
    tab?.classList.toggle('is-active', active);
    panel?.toggleAttribute('hidden', !active);
    panel?.classList.toggle('is-active', active);
  }
  el('current-step-number').textContent = String(order.indexOf(stage) + 1);
  el('current-stage-title').textContent = el(`stage-${stage}`)?.dataset.title
    || el(`stage-${stage}`)?.textContent.trim() || stage;
  const mobileLabel = el('mobile-controls-stage');
  if (mobileLabel) mobileLabel.textContent = el(`stage-${stage}`)?.querySelector('.stage-label')?.textContent || stage;
  setSidePanel(stage === 'prepare' || stage === 'panel' ? 'candidates' : 'issues');
  if (previousStage !== stage && mobileWorkspaceActive()) closeMobileSheet();
}

function setView(view) {
  if (view === 'original' && !state.source) {
    toast('The original image is not available in this project file.');
    return;
  }
  if (view === 'tone' && !currentTonePreview()) {
    toast(state.source ? 'The updated tone interpretation is still rendering.' : 'The source image is not available.');
    return;
  }
  state.view = view;
  for (const name of ['original', 'tone', 'source', 'material', 'backlit', 'issues']) {
    const button = el(`view-${name}`);
    button?.setAttribute('aria-pressed', String(name === view));
    button?.classList.toggle('is-selected', name === view);
  }
  el('tool-problems')?.setAttribute('aria-pressed', String(view === 'issues'));
  el('tool-problems')?.classList.toggle('is-selected', view === 'issues');
  draw();
}

function revealToneControls() {
  setStage('prepare');
  if (mobileWorkspaceActive()) openMobileSheet('controls');
  const adjustments = el('tone-adjustments');
  if (adjustments) adjustments.open = true;
  requestAnimationFrame(() => {
    el('tone-inspector')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

function updateViewAvailability() {
  const original = el('view-original');
  if (original) original.disabled = !state.source;
  const tone = el('view-tone');
  const tonePreview = currentTonePreview();
  const toneReady = Boolean(tonePreview);
  if (tone) {
    tone.disabled = !toneReady;
    tone.title = !toneReady
      ? 'Import an image to inspect its tone'
      : tonePreview.provisional
        ? 'Source luminance preview; re-render for the exact interpretation'
        : 'Tone interpretation';
  }
  if (!state.source && state.view === 'original') { setView('material'); return; }
  if (!toneReady && state.view === 'tone') { setView(state.source ? 'original' : 'material'); return; }
  updateToneInspector();
}

function setSidePanel(panel) {
  state.sidePanel = panel === 'issues' ? 'issues' : 'candidates';
  for (const name of ['candidates', 'issues']) {
    const selected = name === state.sidePanel;
    el(`side-${name}`)?.setAttribute('aria-selected', String(selected));
    if (el(`side-${name}`)) el(`side-${name}`).tabIndex = selected ? 0 : -1;
    el(`side-${name}`)?.classList.toggle('is-selected', selected);
    el(name === 'candidates' ? 'candidate-side-panel' : 'issues-side-panel')
      ?.toggleAttribute('hidden', !selected);
  }
  const mobileLabel = el('mobile-review-label');
  if (mobileLabel) mobileLabel.textContent = state.sidePanel === 'issues' ? 'Problems' : 'Candidates';
}

function setTool(tool) {
  if (!['pan', 'artwork', 'keep', 'remove', 'restore', 'touchup-select', 'support'].includes(tool)) return;
  state.supportTapStart = null;
  if (tool !== 'support' && state.selectedBridge) selectBridge(null);
  if (tool !== 'touchup-select') state.selectedManualEditId = null;
  state.tool = tool;
  state.touchupPreview = null;
  state.drawingBridge = tool === 'support';
  state.bridgePreview = null;
  state.hoveredBridge = null;
  syncToolRailState();
  const painting = ['keep', 'remove', 'restore'].includes(tool);
  const manualEditing = painting || tool === 'touchup-select';
  el('touchup-options')?.toggleAttribute('hidden', !painting);
  el('touchup-empty')?.toggleAttribute('hidden', manualEditing);
  if (painting) updateTouchupControls();
  renderManualEditManager();
  el('btn-position-artwork')?.setAttribute('aria-pressed', String(tool === 'artwork'));
  const viewport = el('canvas-viewport');
  if (viewport) {
    viewport.dataset.activeTool = tool;
    viewport.style.cursor = tool === 'pan' ? 'grab' : tool === 'artwork' ? 'move' : 'crosshair';
  }
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
  openToolOptions('support');
  toast('Support tool active. Drag between two pieces, or tap a start and end point.');
}

function activateIconStencil() {
  setStage('prepare');
  const option = document.querySelector('input[name="cutStyle"][value="icoana"]');
  if (!option) return;
  setTool('pan');
  if (!option.checked) option.click();
  else reflectModeControls();
  openToolOptions('icon');
  toast('Icon style applied. Adjust its stencil and halo settings beside the Tools bar.');
}

function activateTouchupTool(tool) {
  if (!['keep', 'remove', 'restore', 'touchup-select'].includes(tool)) return;
  setStage('prepare');
  setTool(tool);
  openToolOptions(tool);
}

const TOOL_OPTION_CONFIG = Object.freeze({
  icon: Object.freeze({
    title: 'Icon stencil',
    kind: 'Filter settings',
    nodes: Object.freeze(['style-icon', 'style-photo-common', 'style-status']),
    actions: Object.freeze(['btn-restyle']),
  }),
  keep: Object.freeze({
    title: 'Add material',
    kind: 'Tool settings',
    nodes: Object.freeze(['touchup-tool-settings']),
    actions: Object.freeze([]),
  }),
  remove: Object.freeze({
    title: 'Remove material',
    kind: 'Tool settings',
    nodes: Object.freeze(['touchup-tool-settings']),
    actions: Object.freeze([]),
  }),
  restore: Object.freeze({
    title: 'Restore artwork',
    kind: 'Tool settings',
    nodes: Object.freeze(['touchup-tool-settings']),
    actions: Object.freeze([]),
  }),
  'touchup-select': Object.freeze({
    title: 'Edit manual strokes',
    kind: 'Manual edit layer',
    nodes: Object.freeze(['touchup-tool-settings']),
    actions: Object.freeze([]),
  }),
  support: Object.freeze({
    title: 'Add support',
    kind: 'Tool settings',
    nodes: Object.freeze(['support-tool-settings']),
    actions: Object.freeze([]),
  }),
});

function toolButtonId(kind) {
  return kind === 'icon' ? 'tool-icon-stencil' : `tool-${kind}`;
}

function syncToolRailState() {
  const active = toolOptionsKind === 'icon' ? 'icon' : state.tool;
  for (const kind of ['pan', 'icon', 'keep', 'remove', 'restore', 'touchup-select', 'support']) {
    const button = el(toolButtonId(kind));
    const selected = kind === active;
    button?.setAttribute('aria-pressed', String(selected));
    button?.classList.toggle('is-selected', selected);
  }
  el('btn-position-artwork')?.setAttribute('aria-pressed', String(state.tool === 'artwork'));
}

function moveToolOptionNode(id, destination) {
  const node = el(id);
  if (node && destination) destination.append(node);
}

function restoreToolOptionNode(id) {
  const node = el(id);
  const home = el(`${id}-home`);
  if (node && home) home.after(node);
}

function openToolOptions(kind) {
  const config = TOOL_OPTION_CONFIG[kind];
  const panel = el('tool-options-panel');
  const actions = el('tool-options-actions');
  const content = el('tool-options-content');
  if (!config || !panel || !actions || !content) return;
  closeMobileSheet();
  if (toolOptionsKind && toolOptionsKind !== kind) closeToolOptions();
  toolOptionsKind = kind;
  el('tool-options-title').textContent = config.title;
  el('tool-options-kind').textContent = config.kind;
  for (const id of [...config.actions].reverse()) {
    const node = el(id);
    if (node) actions.prepend(node);
  }
  for (const id of config.nodes) {
    moveToolOptionNode(id, content);
  }
  panel.hidden = false;
  for (const optionKind of Object.keys(TOOL_OPTION_CONFIG)) {
    el(toolButtonId(optionKind))?.setAttribute('aria-expanded', String(optionKind === kind));
  }
  syncToolRailState();
}

function closeToolOptions({ returnFocus = false } = {}) {
  if (!toolOptionsKind) return;
  const closingKind = toolOptionsKind;
  const config = TOOL_OPTION_CONFIG[closingKind];
  for (const id of [...config.actions, ...config.nodes]) {
    restoreToolOptionNode(id);
  }
  el('tool-options-panel')?.setAttribute('hidden', '');
  for (const optionKind of Object.keys(TOOL_OPTION_CONFIG)) {
    el(toolButtonId(optionKind))?.setAttribute('aria-expanded', 'false');
  }
  toolOptionsKind = null;
  syncToolRailState();
  if (returnFocus) el(toolButtonId(closingKind))?.focus();
}

function touchupMode() {
  return document.querySelector('input[name="touchupMode"]:checked')?.value || 'freehand';
}

function touchupMinimumMm() {
  if (state.tool === 'restore') return state.unit === 'in' ? 0.254 : 0.1;
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
  const restore = state.tool === 'restore';
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
  if (label) label.innerHTML = `${restore ? 'Restore width' : remove ? 'Cut width' : 'Material width'} <small>${mode === 'region' ? 'Not used for a whole region' : 'Physical size on the panel'}</small>`;
  const hint = el('touchup-hint');
  if (!hint) return;
  if (mode === 'straight') hint.textContent = `Drag between two points for a precise ${restore ? 'restored strip' : remove ? 'cut' : 'material strip'}.`;
  else if (mode === 'region') hint.textContent = `Click a connected ${restore ? 'area to reveal the generated artwork' : remove ? 'metal piece to remove it' : 'opening to fill it'}.`;
  else hint.textContent = `Drag a continuous ${roundUnit(fromMm(touchupSizeMm()))} ${state.unit} physical-width stroke.`;
  updateTouchupHud();
}

function touchupOperation(tool = state.tool) {
  if (tool === 'keep' || tool === 'remove' || tool === 'restore') return tool;
  return null;
}

function manualEditLabel(edit) {
  if (edit.operation === 'keep') return 'Add material';
  if (edit.operation === 'remove') return 'Remove material';
  return 'Restore artwork';
}

function selectedManualEdit() {
  return state.manualEdits.find((edit) => edit.id === state.selectedManualEditId) ?? null;
}

function updateTouchupHud(message = null) {
  const hud = el('touchup-hud');
  const operation = touchupOperation();
  if (!hud) return;
  hud.hidden = !operation || !state.designMask;
  if (!operation) return;
  hud.dataset.operation = operation;
  el('touchup-hud-operation').textContent = manualEditLabel({ operation });
  el('touchup-hud-size').textContent = touchupMode() === 'region'
    ? 'Whole region'
    : `${roundUnit(fromMm(touchupSizeMm()))} ${state.unit}`;
  el('touchup-hud-hint').textContent = message || 'Physical width · checked after release';
}

function renderManualEditManager() {
  const list = el('manual-edit-list');
  if (!list) return;
  el('manual-edit-count').textContent = String(state.manualEdits.length);
  el('manual-edit-empty')?.toggleAttribute('hidden', state.manualEdits.length > 0);
  list.innerHTML = state.manualEdits.slice().reverse().map((edit, reverseIndex) => {
    const index = state.manualEdits.length - reverseIndex;
    const detail = edit.shape === 'stroke'
      ? `${roundUnit(fromMm(edit.widthMm))} ${state.unit}`
      : 'Region';
    return `<button class="manual-edit-row" type="button" role="option" data-manual-edit-id="${escapeHtml(edit.id)}" data-operation="${edit.operation}" data-enabled="${edit.enabled !== false}" aria-selected="${edit.id === state.selectedManualEditId}"><i aria-hidden="true"></i><strong>${index}. ${manualEditLabel(edit)}</strong><small>${detail}</small></button>`;
  }).join('');
  const selected = selectedManualEdit();
  const inspector = el('manual-edit-inspector');
  inspector?.toggleAttribute('hidden', !selected);
  if (!selected) return;
  el('manual-edit-operation').value = selected.operation;
  el('manual-edit-enabled').checked = selected.enabled !== false;
  const width = el('manual-edit-width');
  width.disabled = selected.shape !== 'stroke';
  width.value = selected.shape === 'stroke' ? String(roundUnit(fromMm(selected.widthMm))) : '';
  width.min = state.unit === 'in' ? '0.01' : '0.1';
  width.max = String(roundUnit(fromMm(250)));
  width.step = state.unit === 'in' ? '0.01' : '0.5';
}

function selectManualEdit(edit) {
  state.selectedManualEditId = edit?.id ?? null;
  renderManualEditManager();
  draw();
}

function retireManualEditRepairConflicts(edit) {
  if (!state.sourceMask || !edit || edit.enabled === false || edit.operation === 'restore') return;
  const desired = edit.operation === 'keep' ? RETAINED : REMOVED;
  for (const index of manualEditIndices(state.sourceMask, sheet(), edit)) {
    retireConflictingRepairEdit(state.manufacturingRepairs, index, desired);
  }
}

function updateSelectedManualEdit(patch) {
  const index = state.manualEdits.findIndex((edit) => edit.id === state.selectedManualEditId);
  if (index < 0) return false;
  const next = normalizeManualEdit({ ...state.manualEdits[index], ...patch }, index);
  if (JSON.stringify(next) === JSON.stringify(state.manualEdits[index])) return false;
  state.manualEdits[index] = next;
  retireManualEditRepairConflicts(state.manualEdits[index]);
  refresh({ immediate: true, manualGeometryEdit: true });
  renderManualEditManager();
  pushHistory();
  return true;
}

function deleteSelectedManualEdit() {
  const index = state.manualEdits.findIndex((edit) => edit.id === state.selectedManualEditId);
  if (index < 0) return false;
  state.manualEdits.splice(index, 1);
  state.selectedManualEditId = null;
  refresh({ immediate: true, manualGeometryEdit: true });
  renderManualEditManager();
  pushHistory();
  toast('Manual edit deleted. Later edits were preserved.');
  return true;
}

function announce(message, { urgent = false } = {}) {
  const target = el(urgent ? 'accessible-alert' : 'accessible-status');
  if (!target) return;
  // Keep a stable live-region node and refresh only its text so repeated
  // results are announced without disappearing with the visual toast.
  target.textContent = '';
  requestAnimationFrame(() => { target.textContent = message; });
}

function toast(message, { urgent = /(?:failed|could not|cannot|error|invalid|unavailable)/i.test(message) } = {}) {
  announce(message, { urgent });
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
  dialog.returnValue = '';
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

function maskPointToMm(point) {
  if (!state.sourceMask) return { x: 0, y: 0 };
  const currentSheet = sheet();
  return {
    x: point.x / state.sourceMask.width * currentSheet.widthMm,
    y: point.y / state.sourceMask.height * currentSheet.heightMm,
  };
}

function mmPointToMask(point) {
  if (!state.sourceMask) return { x: 0, y: 0 };
  const currentSheet = sheet();
  return {
    x: point.x / currentSheet.widthMm * state.sourceMask.width,
    y: point.y / currentSheet.heightMm * state.sourceMask.height,
  };
}

function smoothTouchupPoint(previousMm, rawMm) {
  const smoothing = Math.max(0, Math.min(0.85, numberField('touchup-smoothing', 35) / 100));
  if (!previousMm || smoothing <= 0) return rawMm;
  return {
    x: previousMm.x * smoothing + rawMm.x * (1 - smoothing),
    y: previousMm.y * smoothing + rawMm.y * (1 - smoothing),
  };
}

function constrainTouchupPoint(startMm, pointMm, enabled) {
  if (!enabled || !startMm) return pointMm;
  const dx = pointMm.x - startMm.x;
  const dy = pointMm.y - startMm.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= Number.EPSILON) return pointMm;
  const increment = Math.PI / 12;
  const angle = Math.round(Math.atan2(dy, dx) / increment) * increment;
  return { x: startMm.x + Math.cos(angle) * distance, y: startMm.y + Math.sin(angle) * distance };
}

function currentManualPainted() {
  if (!state.sourceMask) return { keep: new Set(), remove: new Set() };
  return rasterizeManualEdits(state.sourceMask, sheet(), {
    legacy: state.painted,
    edits: state.manualEdits,
  });
}

function touchupRegion(point) {
  if (!state.sourceMask) return { indices: [], truncated: false };
  const maximum = Math.min(50000, Math.floor(state.sourceMask.data.length * 0.15));
  return connectedRegionIndices(state.sourceMask, point, { maximumPixels: Math.max(1, maximum) });
}

function makeManualStroke(operation, widthMm, pointsMm) {
  return normalizeManualEdit({
    id: crypto.randomUUID(),
    operation,
    shape: 'stroke',
    enabled: true,
    widthMm,
    pointsMm,
    createdAt: new Date().toISOString(),
  });
}

function makeManualRegion(operation, indices) {
  return normalizeManualEdit({
    id: crypto.randomUUID(),
    operation,
    shape: 'region',
    enabled: true,
    rasterKey: state.sourceMask ? `${state.sourceMask.width}x${state.sourceMask.height}` : '1x1',
    indices,
    createdAt: new Date().toISOString(),
  });
}

function manualEditAtPointer(event) {
  if (!state.sourceMask) return null;
  const point = pointerToMm(event);
  if (!point.inside) return null;
  const canvasWidth = Math.max(1, el('editor-canvas').getBoundingClientRect().width);
  const toleranceMm = sheet().widthMm / canvasWidth * (event.pointerType === 'touch' ? 24 : 12);
  const cursor = { x: point.mmX, y: point.mmY };
  for (let index = state.manualEdits.length - 1; index >= 0; index -= 1) {
    const edit = state.manualEdits[index];
    if (edit.enabled === false) continue;
    if (edit.shape === 'stroke') {
      if (edit.pointsMm.length === 1) {
        if (Math.hypot(cursor.x - edit.pointsMm[0].x, cursor.y - edit.pointsMm[0].y) <=
            Math.max(edit.widthMm / 2, toleranceMm)) return edit;
      } else {
        for (let pointIndex = 1; pointIndex < edit.pointsMm.length; pointIndex += 1) {
          if (distanceToSegment(cursor, edit.pointsMm[pointIndex - 1], edit.pointsMm[pointIndex]) <=
              Math.max(edit.widthMm / 2, toleranceMm)) return edit;
        }
      }
    } else {
      const rasterPoint = pointerToMask(event);
      const rasterIndex = Math.floor(rasterPoint.y) * state.sourceMask.width + Math.floor(rasterPoint.x);
      if (manualEditIndices(state.sourceMask, sheet(), edit).includes(rasterIndex)) return edit;
    }
  }
  return null;
}

function paintIndex(index, { liveStructureMask = null } = {}) {
  if (!state.sourceMask || index < 0 || index >= state.sourceMask.data.length) return false;
  const desired = state.tool === 'keep' ? RETAINED : REMOVED;
  const repairConflictRetired = retireConflictingRepairEdit(
    state.manufacturingRepairs,
    index,
    desired,
  );
  const target = state.tool === 'keep' ? state.painted.keep : state.painted.remove;
  const other = state.tool === 'keep' ? state.painted.remove : state.painted.keep;
  const intentChanged = !target.has(index) || other.has(index);
  if (intentChanged) {
    target.add(index);
    other.delete(index);
  }
  if (!intentChanged && !repairConflictRetired) return false;
  if (liveStructureMask) {
    state.sourceMask.data[index] = desired;
    if (state.designMask) {
      // Frames and supports remain retained even when the artwork beneath them
      // is removed, matching the full design rebuild performed on release.
      state.designMask.data[index] = desired === RETAINED || liveStructureMask.data[index] === RETAINED
        ? RETAINED
        : REMOVED;
    }
  }
  return true;
}

function paintDisc(point, diameterMm = touchupSizeMm(), { liveStructureMask = null } = {}) {
  if (!state.sourceMask) return false;
  let changed = false;
  for (const index of physicalDiscIndices(state.sourceMask, point, diameterMm, sheet())) {
    changed = paintIndex(index, { liveStructureMask }) || changed;
  }
  return changed;
}

function touchupFootprintIntersectsMask(point, diameterMm = touchupSizeMm()) {
  if (!state.sourceMask) return false;
  return physicalDiscIndices(state.sourceMask, point, diameterMm, sheet()).length > 0;
}

function paintSegment(start, end, { liveStructureMask = null, diameterMm = touchupSizeMm() } = {}) {
  if (!state.sourceMask) return false;
  let changed = false;
  for (const index of physicalStrokeIndices(state.sourceMask, start, end, diameterMm, sheet())) {
    changed = paintIndex(index, { liveStructureMask }) || changed;
  }
  return changed;
}

function touchupStructureMask() {
  if (!state.sourceMask) return null;
  const emptyArtwork = {
    width: state.sourceMask.width,
    height: state.sourceMask.height,
    data: new Uint8Array(state.sourceMask.data.length),
  };
  return buildDesignMask(emptyArtwork, {
    sheet: sheet(),
    frame: frameConfig(),
    bridges: state.bridges.filter((bridge) => bridge.enabled !== false),
  }).mask;
}

function reportTouchupResult() {
  if (el('touchup-safety')?.checked !== true || !state.analysis) return;
  const loose = Math.max(0, state.analysis.componentCount - 1);
  if (loose > 0) {
    toast(state.validationPending
      ? `Edit leaves ${loose} loose ${loose === 1 ? 'piece' : 'pieces'}; rechecking the complete issue queue now.`
      : `Edit leaves ${loose} loose ${loose === 1 ? 'piece' : 'pieces'}. They are highlighted in Problems.`);
    setSidePanel('issues');
  } else {
    toast(state.validationPending
      ? 'Edit keeps the panel connected; rechecking opening and gap limits now.'
      : 'Edit keeps the panel connected. Run validation for hole and gap checks.');
  }
}

let styleTimer = null;

const HELP_STAGE_SECTIONS = Object.freeze({
  prepare: 'prepare',
  panel: 'panel',
  support: 'support',
  validate: 'validate',
  export: 'export',
});
let activeHelpSection = 'start';
let helpReturnFocus = null;

function helpSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function renderHelp() {
  const query = helpSearchText(el('help-search')?.value);
  const terms = query.split(/\s+/).filter(Boolean);
  const sections = all('[data-help-section]');
  const matches = [];

  for (const section of sections) {
    const text = section.dataset.helpSearchText || helpSearchText(section.textContent);
    section.dataset.helpSearchText = text;
    const match = terms.every((term) => text.includes(term));
    const visible = terms.length ? match : section.dataset.helpSection === activeHelpSection;
    section.hidden = !visible;
    if (match) matches.push(section.dataset.helpSection);
  }

  for (const button of all('[data-help-target]')) {
    const selected = button.dataset.helpTarget === activeHelpSection && !terms.length;
    button.setAttribute('aria-current', selected ? 'page' : 'false');
    button.hidden = Boolean(terms.length && !matches.includes(button.dataset.helpTarget));
  }

  const status = el('help-search-status');
  if (status) {
    status.textContent = terms.length
      ? `${matches.length} matching ${matches.length === 1 ? 'topic' : 'topics'}`
      : `Browse ${sections.length} topics`;
  }
  const empty = el('help-no-results');
  if (empty) empty.hidden = matches.length > 0;
  if (el('help-content')) el('help-content').scrollTop = 0;
}

function selectHelpSection(sectionName, { focusHeading = false } = {}) {
  const target = el(`help-section-${sectionName}`) ? sectionName : 'start';
  activeHelpSection = target;
  if (el('help-search')) el('help-search').value = '';
  renderHelp();
  if (focusHeading) el(`help-section-${target}`)?.querySelector('h3')?.focus({ preventScroll: true });
}

function closeHelp() {
  const dialog = el('help-dialog');
  if (dialog?.open) dialog.close();
}

function openHelp(sectionName = 'start') {
  const dialog = el('help-dialog');
  if (!dialog) return;
  helpReturnFocus = document.activeElement;
  selectHelpSection(sectionName);
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => el('help-search')?.focus({ preventScroll: true }));
}

function wire() {
  // --- stages
  wireTabKeyboard(document.querySelector('.workflow-nav [role="tablist"]'));
  wireTabKeyboard(document.querySelector('.side-rail-tabs'));
  wireTabKeyboard(document.querySelector('.project-library-tabs'));
  for (const name of ['prepare', 'panel', 'support', 'validate', 'export']) {
    el(`stage-${name}`)?.addEventListener('click', () => {
      setStage(name);
      if (mobileWorkspaceActive() && !tabKeyboardNavigation) openMobileSheet('controls');
    });
  }
  for (const button of all('.stage-next')) {
    button.addEventListener('click', () => setStage(button.dataset.nextStage));
  }
  for (const button of all('[data-edit-manufacturing]')) {
    button.addEventListener('click', () => {
      setStage('panel');
      if (mobileWorkspaceActive()) openMobileSheet('controls');
      requestAnimationFrame(() => {
        el('manufacturing-settings')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        el('kerf')?.focus({ preventScroll: true });
      });
    });
  }
  el('btn-stage-help')?.addEventListener('click', () => openHelp(HELP_STAGE_SECTIONS[state.stage] || 'start'));
  el('btn-help')?.addEventListener('click', () => openHelp('start'));
  el('btn-close-help')?.addEventListener('click', closeHelp);
  el('btn-help-back')?.addEventListener('click', closeHelp);
  el('help-search')?.addEventListener('input', renderHelp);
  el('help-nav')?.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-help-target]');
    if (button) selectHelpSection(button.dataset.helpTarget, { focusHeading: true });
  });
  el('help-dialog')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeHelp();
  });
  el('help-dialog')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeHelp();
  });
  el('help-dialog')?.addEventListener('close', () => {
    const returnTarget = helpReturnFocus;
    helpReturnFocus = null;
    if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
  });
  el('btn-mobile-controls')?.addEventListener('click', () => openMobileSheet('controls'));
  el('btn-mobile-review')?.addEventListener('click', () => openMobileSheet('review'));
  el('btn-close-mobile-controls')?.addEventListener('click', () => closeMobileSheet({ returnFocus: true }));
  el('btn-close-mobile-review')?.addEventListener('click', () => closeMobileSheet({ returnFocus: true }));
  el('mobile-sheet-backdrop')?.addEventListener('click', () => closeMobileSheet({ returnFocus: true }));

  // --- import
  el('style-picker-trigger')?.addEventListener('click', openStylePicker);
  el('btn-close-style-picker')?.addEventListener('click', () => closeStylePicker({ returnFocus: true }));
  el('style-picker-dialog')?.addEventListener('close', () => {
    el('style-picker-trigger')?.setAttribute('aria-expanded', 'false');
  });
  el('style-picker-dialog')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeStylePicker({ returnFocus: true });
    if (event.target.matches?.('input[name="cutStyle"]') && event.target.checked) {
      closeStylePicker({ returnFocus: true });
    }
  });
  window.addEventListener('resize', positionStylePicker);

  el('file-input')?.addEventListener('change', (event) => importFile(event.target.files?.[0]));
  el('btn-empty-import')?.addEventListener('click', () => {
    if (mobileWorkspaceActive()) openMobileSheet('controls');
    requestAnimationFrame(() => el('file-input')?.click());
  });
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
    state.vectorDots = null; state.placedVectorDots = [];
    state.tonePreviewCanvas = null; state.tonePreviewFor = null;
    state.toneStatistics = null; state.lineToneCache = null;
    state.sourceMask = null; state.designMask = null; state.frameMask = null; state.kerfPreviewMask = null;
    state.placement = null; state.contentBounds = null; state.contentSourceSize = null;
    state.painted = { keep: new Set(), remove: new Set() };
    state.manualEdits = [];
    state.selectedManualEditId = null;
    resetManufacturingRepairs();
    state.paintedFor = null; state.bridges = []; state.automaticSupportsStale = false;
    state.supportProposal = null; state.supportTapStart = null; state.bridgePreview = null;
    state.candidates = []; state.selectedCandidateId = null; state.validation = null;
    renderManualEditManager();
    state.lastValidatedAt = null; state.lastExportedAt = null;
    state.geometryInterpretation = FINISHED_BOUNDARY_CAM;
    state.projectId = null; state.createdAt = null; state.dirty = false;
    await clearLastProject();
    setSaveState('saved', 'No artwork');
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

  let artworkRefreshFrame = null;
  const scheduleArtworkTransformPreview = () => {
    if (artworkRefreshFrame !== null) return;
    artworkRefreshFrame = requestAnimationFrame(() => {
      artworkRefreshFrame = null;
      refresh({ immediate: true, reanalyse: false });
    });
  };
  const finishArtworkTransform = () => {
    if (artworkRefreshFrame !== null) {
      cancelAnimationFrame(artworkRefreshFrame);
      artworkRefreshFrame = null;
    }
    refresh({ immediate: true });
    pushHistory();
  };

  // --- treatment, panel, and constraints
  el('btn-upgrade-geometry-contract')?.addEventListener('click', () => void upgradeGeometryContract());
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
      if (id === 'panel-width' || id === 'panel-height') {
        reflectPanelOrientation();
        syncPanelSizePreset({ preserveCustom: true });
      }
      updateRangeOutputs();
      restyle();
      refresh();
    });
    el(id)?.addEventListener('change', pushHistory);
  }
  el('panel-size-preset')?.addEventListener('change', (event) => {
    if (!applyPanelSizePreset(event.target.value)) {
      markDirty();
      pushHistory();
      return;
    }
    updateRangeOutputs();
    restyle();
    refresh({ immediate: true });
    pushHistory();
  });
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
  for (const id of ['artwork-scale', 'artwork-rotation', 'artwork-offset-x', 'artwork-offset-y']) {
    el(id)?.addEventListener('input', () => {
      updateRangeOutputs();
      if (id === 'artwork-scale') restyle();
      scheduleArtworkTransformPreview();
    });
    el(id)?.addEventListener('change', finishArtworkTransform);
  }
  el('btn-reset-artwork-transform')?.addEventListener('click', () => {
    const previousScale = numberField('artwork-scale', 100);
    resetArtworkTransformControls();
    if (previousScale !== 100) restyle();
    finishArtworkTransform();
    toast('Artwork position, rotation, and zoom reset.');
  });
  el('btn-position-artwork')?.addEventListener('click', () => {
    if (!state.sourceMask && !state.baseMask) { toast('Import artwork first.'); return; }
    const activate = state.tool !== 'artwork';
    closeToolOptions();
    selectBridge(null);
    setStage('panel');
    setTool(activate ? 'artwork' : 'pan');
    if (activate) toast('Drag on the panel to position the artwork.');
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
      syncStylePicker();
      closeStylePicker({ returnFocus: true });
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
    'style-dot-pitch', 'style-dot-max', 'style-dot-angle', 'style-dot-cutoff',
    'style-row-pitch', 'style-cell', 'style-tone-brightness', 'style-tone-contrast',
    'style-gain', 'style-smooth', 'style-curve',
    'style-line-detail', 'style-line-width', 'style-wood-spacing', 'style-wood-length',
    'style-flow-pitch', 'style-flow-width', 'style-flow-angle', 'style-flow-follow',
    'style-flow-smooth', 'style-flow-cutoff',
    'style-graphic-balance', 'style-graphic-detail', 'style-graphic-simplify',
    'style-silhouette-smooth', 'style-contour-levels', 'style-contour-width',
    'style-ray-count', 'style-ray-cell', 'style-ray-hub', 'style-ray-center-auto', 'style-ray-center-x', 'style-ray-center-y', 'style-ray-cutoff', 'style-ornament-detail',
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
  el('btn-apply-style-guidance')?.addEventListener('click', () => {
    const recommendation = applyStyleGuidance();
    restyle();
    pushHistory();
    toast(`${CUT_STYLE_NAMES[recommendation.style] || 'Style'} now starts from this panel and cutting profile.`);
  });
  el('btn-open-tone-adjustments')?.addEventListener('click', () => {
    setView('tone');
    if (state.view === 'tone') revealToneControls();
  });
  el('btn-reset-tone-adjustments')?.addEventListener('click', () => {
    const defaults = styleDefaults(selectedCutStyle());
    for (const id of ['style-tone-brightness', 'style-tone-contrast', 'style-gain', 'style-smooth']) {
      if (el(id)) el(id).value = defaults[id];
    }
    rememberStyleSettings();
    updateRangeOutputs();
    restyle();
    pushHistory();
  });
  el('btn-reset-photo-interpretation')?.addEventListener('click', () => {
    const defaults = styleDefaults(selectedCutStyle());
    for (const id of ['style-tone-brightness', 'style-tone-contrast',
      'style-gain', 'style-smooth', 'style-cutout', 'style-clothes']) {
      const node = el(id);
      if (!node) continue;
      if (node.type === 'checkbox') node.checked = defaults[id] === true;
      else node.value = defaults[id];
    }
    rememberStyleSettings();
    updateRangeOutputs();
    restyle();
    pushHistory();
  });

  for (const id of ['kerf', 'min-web', 'min-opening']) {
    el(id)?.addEventListener('input', () => {
      const adjusted = enforcePlasmaLimits();
      presentConstraintAdjustments(adjusted);
      markCuttingProfileSourceAsCustom();
      updateWorkingCuttingProfile();
      updateTouchupControls();
      updateStyleGuidance();
      restyle();
      refresh();
    });
    el(id)?.addEventListener('change', () => {
      commitCuttingProfileRevision({ affectsGeometryLimits: true });
    });
  }
  el('manufacturing-profile')?.addEventListener('change', (event) => {
    if (event.target.value === 'general-plasma') applyGeneralPlasmaProfile();
    else el('cutting-profile-details')?.setAttribute('open', '');
  });
  for (const id of [
    'cutting-profile-name', 'cutting-profile-process', 'cutting-profile-material', 'cutting-profile-grade',
    'cutting-profile-thickness', 'cutting-profile-machine', 'cutting-profile-consumable',
    'cutting-profile-provenance', 'cutting-profile-evidence', 'cutting-profile-verified-by',
  ]) {
    el(id)?.addEventListener('input', () => {
      markCuttingProfileSourceAsCustom();
      updateWorkingCuttingProfile({ invalidate: true });
      updateReadouts();
      markDirty();
    });
    el(id)?.addEventListener('change', () => commitCuttingProfileRevision());
  }
  el('btn-verify-cutting-profile')?.addEventListener('click', verifyCuttingProfile);
  el('btn-unverify-cutting-profile')?.addEventListener('click', returnCuttingProfileToProvisional);
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
      'artwork-offset-x', 'artwork-offset-y',
      'cutting-profile-thickness',
      'bridge-width', 'selected-bridge-width', 'selected-bridge-length',
      'selected-bridge-center-x', 'selected-bridge-center-y',
      'touchup-size', 'manual-edit-width', 'kerf', 'min-web', 'min-opening', 'max-cantilever', 'curve-tolerance',
      'style-pitch', 'style-row-pitch', 'style-cell', 'style-line-width',
      'style-graphic-simplify', 'style-icon-line-width', 'style-icon-simplify',
      'style-wood-spacing', 'style-wood-length', 'style-silhouette-smooth',
      'style-flow-pitch', 'style-flow-width', 'style-flow-smooth',
      'style-contour-width', 'style-ray-cell', 'style-ray-hub', 'style-ornament-width',
      'style-dot-pitch', 'style-dot-max']) {
      const node = el(id);
      if (!node || node.value === '') continue;
      const mm = previous === 'in' ? Number(node.value) * MM_PER_INCH : Number(node.value);
      node.value = state.unit === 'in' ? Math.round(mm / MM_PER_INCH * 1000) / 1000 : Math.round(mm * 10) / 10;
    }
    enforcePlasmaLimits();
    syncSelectedBridgeControls();
    renderSupportList();
    updateTouchupControls();
    renderManualEditManager();
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
      syncPanelSizePreset({ preserveCustom: true });
      restyle();
      refresh({ immediate: true });
      pushHistory();
    }
  });

  // --- tools and view
  el('tool-pan')?.addEventListener('click', () => {
    closeToolOptions();
    setTool('pan');
  });
  for (const name of ['keep', 'remove', 'restore', 'touchup-select']) {
    el(`tool-${name}`)?.addEventListener('click', () => activateTouchupTool(name));
  }
  el('tool-support')?.addEventListener('click', activateSupportTool);
  el('tool-icon-stencil')?.addEventListener('click', activateIconStencil);
  el('btn-close-tool-options')?.addEventListener('click', () => closeToolOptions({ returnFocus: true }));
  el('tool-problems')?.addEventListener('click', () => {
    closeToolOptions();
    setStage('validate');
    setSidePanel('issues');
    setView('issues');
    if (mobileWorkspaceActive()) openMobileSheet('review');
    if (!state.validation) toast('Run all checks to locate manufacturing problems.');
  });
  for (const node of all('input[name="touchupMode"]')) {
    node.addEventListener('change', () => { updateTouchupControls(); draw(); pushHistory(); });
  }
  el('touchup-size')?.addEventListener('input', () => { updateTouchupControls(); draw(); });
  el('touchup-size')?.addEventListener('change', pushHistory);
  el('touchup-safety')?.addEventListener('change', pushHistory);
  el('touchup-smoothing')?.addEventListener('input', () => {
    el('touchup-smoothing-value').textContent = `${Math.round(numberField('touchup-smoothing', 35))}%`;
  });
  el('touchup-smoothing')?.addEventListener('change', pushHistory);
  el('manual-edit-list')?.addEventListener('click', (event) => {
    const row = event.target.closest('[data-manual-edit-id]');
    if (!row) return;
    setTool('touchup-select');
    openToolOptions('touchup-select');
    selectManualEdit(state.manualEdits.find((edit) => edit.id === row.dataset.manualEditId));
  });
  el('manual-edit-operation')?.addEventListener('change', (event) => {
    updateSelectedManualEdit({ operation: event.target.value });
  });
  el('manual-edit-enabled')?.addEventListener('change', (event) => {
    updateSelectedManualEdit({ enabled: event.target.checked });
  });
  el('manual-edit-width')?.addEventListener('change', (event) => {
    const widthMm = toMm(Number(event.target.value));
    if (Number.isFinite(widthMm) && widthMm > 0) updateSelectedManualEdit({ widthMm });
    else renderManualEditManager();
  });
  el('btn-delete-manual-edit')?.addEventListener('click', deleteSelectedManualEdit);
  for (const name of ['original', 'tone', 'source', 'material', 'backlit', 'issues']) {
    el(`view-${name}`)?.addEventListener('click', () => {
      setView(name);
      if (name === 'tone' && state.view === 'tone') revealToneControls();
    });
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
  const supportPlanChanged = () => {
    clearSupportProposal();
    markAutomaticSupportsStale();
    pushHistory();
  };
  el('bridge-count')?.addEventListener('change', supportPlanChanged);
  el('protect-faces')?.addEventListener('change', supportPlanChanged);
  el('support-follow-features')?.addEventListener('change', supportPlanChanged);
  el('support-snap')?.addEventListener('change', pushHistory);
  el('support-follow-style')?.addEventListener('change', pushHistory);
  el('stabilize-slats')?.addEventListener('change', () => {
    updateSlatStabilizerControls();
    supportPlanChanged();
  });
  el('max-cantilever')?.addEventListener('input', () => {
    updateSlatStabilizerControls();
    markCuttingProfileSourceAsCustom();
    updateWorkingCuttingProfile();
    renderCuttingProfileStatus();
  });
  el('max-cantilever')?.addEventListener('change', () => {
    markAutomaticSupportsStale();
    commitCuttingProfileRevision();
  });
  el('stabilizer-organic')?.addEventListener('input', updateRangeOutputs);
  el('stabilizer-organic')?.addEventListener('change', supportPlanChanged);
  el('bridge-width')?.addEventListener('input', () => {
    clearSupportProposal();
    const adjusted = enforcePlasmaLimits();
    presentConstraintAdjustments(adjusted);
    markCuttingProfileSourceAsCustom();
    updateWorkingCuttingProfile();
    renderCuttingProfileStatus();
  });
  el('bridge-width')?.addEventListener('change', () => {
    markAutomaticSupportsStale();
    commitCuttingProfileRevision();
  });
  el('btn-auto-bridge')?.addEventListener('click', autoBridge);
  el('btn-accept-support-proposal')?.addEventListener('click', () => void acceptSupportProposal());
  el('btn-discard-support-proposal')?.addEventListener('click', discardSupportProposal);
  el('btn-add-bridge')?.addEventListener('click', activateSupportTool);
  el('btn-clear-auto-bridges')?.addEventListener('click', () => {
    clearSupportProposal();
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
  el('btn-delete-bridge')?.addEventListener('click', deleteSelectedBridge);
  el('selected-bridge-width')?.addEventListener('change', (event) => {
    if (!state.selectedBridge) return;
    clearSupportProposal();
    const reviewAnchor = captureManualValidationReview();
    promoteBridgeToManual(state.selectedBridge);
    state.selectedBridge.width = safeBridgeWidthMm(toMm(Number(event.target.value)));
    event.target.value = roundUnit(fromMm(state.selectedBridge.width));
    refresh({ immediate: true, rebuildSourceMask: false, manualGeometryEdit: true });
    pushHistory();
    scheduleManualValidationReview(reviewAnchor);
  });
  el('selected-bridge-length')?.addEventListener('change', (event) => {
    if (!state.selectedBridge) return;
    clearSupportProposal();
    const reviewAnchor = captureManualValidationReview();
    promoteBridgeToManual(state.selectedBridge);
    setBridgeGeometry(state.selectedBridge, { lengthMm: toMm(Number(event.target.value)) });
    syncSelectedBridgeControls();
    refresh({ immediate: true, rebuildSourceMask: false, manualGeometryEdit: true });
    pushHistory();
    scheduleManualValidationReview(reviewAnchor);
  });
  el('selected-bridge-angle')?.addEventListener('change', (event) => {
    if (!state.selectedBridge) return;
    clearSupportProposal();
    const reviewAnchor = captureManualValidationReview();
    promoteBridgeToManual(state.selectedBridge);
    setBridgeGeometry(state.selectedBridge, { angleDeg: Number(event.target.value) });
    syncSelectedBridgeControls();
    refresh({ immediate: true, rebuildSourceMask: false, manualGeometryEdit: true });
    pushHistory();
    scheduleManualValidationReview(reviewAnchor);
  });
  for (const [id, axis] of [['selected-bridge-center-x', 'x'], ['selected-bridge-center-y', 'y']]) {
    el(id)?.addEventListener('change', (event) => {
      if (!state.selectedBridge) return;
      clearSupportProposal();
      const reviewAnchor = captureManualValidationReview();
      promoteBridgeToManual(state.selectedBridge);
      setBridgeCenter(state.selectedBridge, { [`${axis}Mm`]: toMm(Number(event.target.value)) });
      syncSelectedBridgeControls();
      refresh({ immediate: true, rebuildSourceMask: false, manualGeometryEdit: true });
      pushHistory();
      scheduleManualValidationReview(reviewAnchor);
    });
  }
  el('btn-previous-support')?.addEventListener('click', () => selectAdjacentBridge(-1));
  el('btn-next-support')?.addEventListener('click', () => selectAdjacentBridge(1));
  el('support-list')?.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-support-action]');
    if (!button) return;
    const bridge = state.bridges[Number(button.dataset.supportIndex)];
    if (!bridge) return;
    const action = button.dataset.supportAction;
    if (action === 'select') {
      setStage('support');
      setTool('support');
      selectBridge(bridge);
      el('canvas-viewport')?.focus({ preventScroll: true });
    } else if (action === 'locate') {
      locateBridge(bridge);
    } else if (action === 'delete') {
      setStage('support');
      setTool('support');
      selectBridge(bridge);
      deleteSelectedBridge();
    }
  });

  // --- validation and export
  el('btn-validate')?.addEventListener('click', runValidation);
  el('btn-validate-sidebar')?.addEventListener('click', runValidation);
  el('btn-preview-repairs')?.addEventListener('click', () => void buildRepairPreview({ mode: 'errors' }));
  el('btn-preview-warning-repairs')?.addEventListener('click', () => void buildRepairPreview({ mode: 'warnings' }));
  for (const node of all('input[name="openingRepairStrategy"]')) {
    node.addEventListener('change', () => {
      const kind = state.repairPlan?.kind ?? 'manufacturing';
      el('repair-strategy-description').textContent = REPAIR_STRATEGY_COPY[kind][selectedRepairStrategy()];
      if (state.repairPlan) void buildRepairPreview({ focus: false, mode: state.repairPlan.mode });
    });
  }
  el('repair-safety')?.addEventListener('change', () => {
    if (state.repairPlan) void buildRepairPreview({ focus: false, mode: state.repairPlan.mode });
  });
  for (const id of ['repair-category-slivers', 'repair-category-gaps', 'repair-category-webs']) {
    el(id)?.addEventListener('change', () => {
      if (state.repairPlan?.mode === 'errors') void buildRepairPreview({ focus: false, mode: 'errors' });
    });
  }
  el('btn-repair-next')?.addEventListener('click', () => focusRepairItem(state.repairItemIndex + 1));
  for (const button of all('[data-repair-action]')) {
    button.addEventListener('click', () => overrideRepairAction(button.dataset.repairAction));
  }
  el('btn-discard-repairs')?.addEventListener('click', discardRepairPreview);
  el('btn-apply-repairs')?.addEventListener('click', () => void applyRepairPlan());
  el('btn-undo-repair')?.addEventListener('click', undoLastRepair);
  el('btn-toggle-repair-layer')?.addEventListener('click', toggleManufacturingRepairLayer);
  el('btn-clear-repair-layer')?.addEventListener('click', clearManufacturingRepairLayer);
  el('btn-export-svg')?.addEventListener('click', () => exportGeometry('svg'));
  el('btn-export-dxf')?.addEventListener('click', () => exportGeometry('dxf'));
  el('btn-export-png')?.addEventListener('click', () => exportGeometry('png'));
  el('btn-download-project')?.addEventListener('click', async () => {
    if (!state.sourceMask) { toast('Import an image first.'); return; }
    await persist();
    downloadText(exportFilename('project', new Date()), serializeProject(projectFromState(), { pretty: true }));
    toast('Portable project downloaded without the source photograph.');
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
  for (const id of ['btn-undo', 'btn-undo-mobile']) el(id)?.addEventListener('click', undo);
  for (const id of ['btn-redo', 'btn-redo-mobile']) el(id)?.addEventListener('click', redo);
  el('btn-new-project')?.addEventListener('click', () => void startNewProject());
  el('btn-library-new-project')?.addEventListener('click', () => void startNewProject());
  el('btn-save-project')?.addEventListener('click', () => void saveDraftAsProject());
  el('btn-save-draft')?.addEventListener('click', async () => {
    await saveDraftAsProject();
    await refreshProjectLibrary();
  });
  el('btn-continue-draft')?.addEventListener('click', async () => {
    const draft = await loadProject(LOCAL_DRAFT_PROJECT_ID);
    if (!draft) {
      await refreshProjectLibrary();
      return;
    }
    await loadProjectState(draft);
    closeProjectLibrary();
  });
  el('btn-clean-conflicts')?.addEventListener('click', () => void cleanDuplicateConflictProjects());
  for (const id of ['save-state', 'btn-sync-mobile']) {
    el(id)?.addEventListener('click', () => void manuallySyncProjects());
  }
  for (const id of ['btn-projects', 'btn-projects-mobile']) {
    el(id)?.addEventListener('click', () => void openProjectLibrary());
  }
  el('btn-manage-devices')?.addEventListener('click', () => void openDeviceManager());
  el('btn-close-projects')?.addEventListener('click', closeProjectLibrary);
  el('project-library-dialog')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeProjectLibrary();
  });
  el('project-search')?.addEventListener('input', renderProjectLibrary);
  el('project-status-filter')?.addEventListener('change', renderProjectLibrary);
  el('btn-create-device-invite')?.addEventListener('click', () => void createDeviceInvite());
  el('device-invite-label')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void createDeviceInvite();
    }
  });
  el('btn-copy-device-invite')?.addEventListener('click', async () => {
    if (!deviceManagerInvite?.link) return;
    await copyText(deviceManagerInvite.link);
    toast('One-time device link copied.');
  });
  el('btn-share-device-invite')?.addEventListener('click', async () => {
    if (!deviceManagerInvite?.link || typeof navigator.share !== 'function') return;
    try {
      await navigator.share({
        title: 'Link a device to Kerfloom',
        text: `Open this one-time link to join my Kerfloom workspace as “${deviceManagerInvite.label || 'Linked device'}”.`,
        url: deviceManagerInvite.link,
      });
    } catch (error) {
      if (error?.name !== 'AbortError') toast('The device link could not be shared. You can copy it instead.');
    }
  });
  el('device-list')?.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-device-action="disconnect"]');
    if (button) void disconnectWorkspaceDevice(button);
  });
  el('pending-device-invites')?.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-invite-action]');
    if (button) void handlePendingDeviceInvite(button);
  });
  el('device-manager-dialog')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  el('device-manager-dialog')?.addEventListener('close', () => {
    deviceManagerInvite = null;
    void openProjectLibrary({ flush: false });
  });
  el('btn-import-legacy-projects')?.addEventListener('click', async () => {
    const legacy = await legacyProjectSummary();
    if (!legacy.count) {
      await refreshProjectLibrary();
      return;
    }
    closeProjectLibrary();
    const destination = state.device?.label || 'this server workspace';
    if (!await confirmAction(
      'Import legacy browser projects?',
      `${legacy.count} ${legacy.count === 1 ? 'project' : 'projects'} will be copied into “${destination}” and then synchronized. The quarantined originals will remain untouched.`,
      'Import copies',
    )) {
      await openProjectLibrary({ flush: false });
      return;
    }
    try {
      const imported = await importLegacyProjects();
      for (const project of imported) await syncStoredProject(project);
      await openProjectLibrary({ flush: false });
      toast(`${imported.length} legacy ${imported.length === 1 ? 'project was' : 'projects were'} imported as new copies.`);
    } catch (error) {
      console.error('Legacy project import failed:', error);
      await openProjectLibrary({ flush: false });
      toast('Legacy projects remain quarantined. The import could not be completed.');
    }
  });
  for (const tab of all('[data-project-view]')) {
    tab.addEventListener('click', async () => {
      projectLibraryView = tab.dataset.projectView;
      await refreshProjectLibrary();
    });
  }
  el('project-list')?.addEventListener('dblclick', (event) => {
    if (event.target.closest?.('button')) return;
    const card = event.target.closest?.('[data-project-id]');
    if (card && projectLibraryView === 'active') void openStoredProject(card.dataset.projectId);
  });
  el('project-list')?.addEventListener('click', async (event) => {
    const button = event.target.closest?.('[data-project-action]');
    const card = event.target.closest?.('[data-project-id]');
    if (!button || !card) return;
    const record = projectLibraryRows.find((row) => row.id === card.dataset.projectId);
    if (!record) return;
    try {
      await handleProjectAction(button.dataset.projectAction, record);
    } catch (error) {
      console.error(error);
      toast('That project action could not be completed. Your current work was not changed.');
      await openProjectLibrary({ flush: false });
    }
  });
  el('btn-create-share')?.addEventListener('click', () => void createServerShare());
  el('btn-copy-share-link')?.addEventListener('click', async () => {
    const value = el('share-link')?.value;
    if (!value) return;
    await copyText(value);
    toast('Private project link copied.');
  });
  el('share-history')?.addEventListener('click', async (event) => {
    const button = event.target.closest?.('[data-share-action]');
    if (!button) return;
    if (button.dataset.shareAction === 'copy') {
      await copyText(shareLink(button.dataset.shareId, button.dataset.shareToken));
      toast('Private project link copied.');
      return;
    }
    if (button.dataset.shareAction === 'revoke') {
      button.disabled = true;
      try {
        await requestShareJson(`/api/shares/${encodeURIComponent(button.dataset.shareId)}`, {
          method: 'DELETE',
        });
        await deleteShareSecret(button.dataset.shareId);
        await renderShareHistory();
        toast('Project share revoked. Imported copies are unaffected.');
      } catch (error) {
        console.error(error);
        toast(error.message || 'The project share could not be revoked.');
        button.disabled = false;
      }
    }
  });
  el('share-project-dialog')?.addEventListener('close', () => {
    if (!sharingProject) return;
    sharingProject = null;
    void openProjectLibrary({ flush: false });
  });
  el('share-project-dialog')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  el('btn-import-shared-project')?.addEventListener('click', () => void importReceivedShare());
  el('received-share-dialog')?.addEventListener('close', (event) => {
    if (event.currentTarget.returnValue !== 'imported') {
      receivedShare = null;
      history.replaceState({}, document.title, '/');
    }
  });
  el('rename-project-dialog')?.addEventListener('close', async (event) => {
    const id = renameProjectId;
    renameProjectId = null;
    if (event.currentTarget.returnValue === 'confirm' && id) {
      const name = el('rename-project-input').value.trim();
      if (name) {
        const renamed = await updateProject(id, { name });
        await syncStoredProject(renamed);
        if (id === state.projectId) {
          state.name = name;
          el('project-name').value = name;
        }
        toast(`Renamed project to “${name}”.`);
      } else {
        toast('Project names cannot be empty.');
      }
    }
    await openProjectLibrary({ flush: false });
  });
  el('version-dialog')?.addEventListener('close', () => {
    if (!versionProjectId) return;
    versionProjectId = null;
    void openProjectLibrary({ flush: false });
  });
  el('version-list')?.addEventListener('click', async (event) => {
    const button = event.target.closest?.('[data-checkpoint-action="restore"]');
    const item = event.target.closest?.('[data-checkpoint-id]');
    if (!button || !item || !versionProjectId) return;
    const checkpoint = versionRows.find((row) => row.id === item.dataset.checkpointId);
    const projectId = versionProjectId;
    versionProjectId = null;
    el('version-dialog').close();
    const current = await loadProject(projectId);
    if (!checkpoint || !current) return;
    if (!await confirmAction(
      'Restore this recovery point?',
      'The current project state remains protected by autosave and newer recovery points.',
      'Restore',
    )) {
      await openProjectLibrary({ flush: false });
      return;
    }
    try {
      await saveCheckpoint(current, 'Before recovery restore');
    } catch (error) {
      console.error(error);
      toast('The current state could not be protected, so the recovery point was not restored.');
      await openProjectLibrary({ flush: false });
      return;
    }
    const restored = await saveProject({
      ...checkpoint.project,
      id: current.id,
      name: current.name,
      createdAt: current.createdAt,
      localSource: current.localSource ?? null,
      trashedAt: null,
      serverRevision: current.serverRevision || 0,
    });
    await syncStoredProject(restored);
    styleAbort?.abort();
    await loadProjectState(restored);
    const syncedRestore = await loadProject(restored.id) || restored;
    state.serverRevision = Number(syncedRestore.serverRevision) || 0;
    if (syncedRestore.localSyncPending || !syncedRestore.serverRevision) {
      await setPendingSaveState();
    } else {
      setSaveState('saved', savedAtLabel(new Date(syncedRestore.serverSyncedAt || Date.now())));
    }
    pushHistory();
    toast(`Restored “${checkpoint.label}”.`);
  });
  el('project-name')?.addEventListener('input', (event) => {
    state.name = event.target.textContent?.trim() || event.target.value?.trim() || 'Untitled panel';
    markDirty();
  });

  // --- canvas
  const viewport = el('canvas-viewport');
  let panning = null;
  let draggingArtwork = null;
  let drawingFrom = null;
  let drawingReviewAnchor = null;
  let drawingSupportGesture = null;
  let draggingBridge = null;
  let draggingManualEdit = null;
  let touchupStroke = null;
  let touchupDrawFrame = null;
  let activeCanvasPointerId = null;
  let temporaryPan = null;

  const scheduleLiveTouchupDraw = () => {
    if (touchupDrawFrame !== null) return;
    touchupDrawFrame = requestAnimationFrame(() => {
      touchupDrawFrame = null;
      draw();
    });
  };

  const cancelLiveTouchupDraw = () => {
    if (touchupDrawFrame === null) return;
    cancelAnimationFrame(touchupDrawFrame);
    touchupDrawFrame = null;
  };

  const beginBridgeDrag = (event, bridge, mode) => {
    const point = pointerToMm(event);
    clearSupportProposal();
    selectBridge(bridge);
    state.hoveredBridge = bridge;
    draggingBridge = {
      mode,
      bridge,
      origin: { x: point.mmX, y: point.mmY },
      start: { ...bridge.start },
      end: { ...bridge.end },
      reviewAnchor: captureManualValidationReview(),
    };
    activeCanvasPointerId = event.pointerId;
    viewport.setPointerCapture(event.pointerId);
    viewport.style.cursor = mode === 'move' ? 'move' : 'crosshair';
  };

  viewport?.addEventListener('pointerdown', (event) => {
    if (event.isPrimary === false || activeCanvasPointerId !== null
      || (event.pointerType === 'mouse' && event.button !== 0)) return;
    viewport.focus({ preventScroll: true });
    const { x, y, inside } = pointerToMask(event);
    if (state.tool === 'artwork' && state.placement && inside) {
      const point = pointerToMm(event);
      const transform = artworkTransform();
      draggingArtwork = {
        origin: { x: point.mmX, y: point.mmY },
        offsetXMm: transform.offsetXMm,
        offsetYMm: transform.offsetYMm,
      };
      activeCanvasPointerId = event.pointerId;
      viewport.setPointerCapture(event.pointerId);
      viewport.style.cursor = 'grabbing';
      return;
    }
    if (state.tool === 'touchup-select') {
      const hit = manualEditAtPointer(event);
      selectManualEdit(hit);
      if (hit?.shape === 'stroke') {
        const point = pointerToMm(event);
        draggingManualEdit = {
          id: hit.id,
          origin: { x: point.mmX, y: point.mmY },
          original: normalizeManualEdit(hit),
          moved: false,
          reviewAnchor: captureManualValidationReview(),
        };
        activeCanvasPointerId = event.pointerId;
        viewport.setPointerCapture(event.pointerId);
        viewport.style.cursor = 'move';
      }
      return;
    }
    if (state.drawingBridge && inside) {
      const handle = bridgeHandleAtPointer(event);
      const hit = handle && state.selectedBridge ? state.selectedBridge : bridgeAtPointer(event);
      if (hit) {
        beginBridgeDrag(event, hit, handle || 'move');
        return;
      }
      const point = pointerToMm(event);
      const pendingStart = state.supportTapStart;
      drawingFrom = pendingStart || manualSupportPoint({ x: point.mmX, y: point.mmY });
      drawingReviewAnchor = captureManualValidationReview();
      const end = pendingStart
        ? manualSupportPoint({ x: point.mmX, y: point.mmY }, drawingFrom)
        : drawingFrom;
      drawingSupportGesture = {
        fromPending: Boolean(pendingStart),
        moved: false,
        pointer: { x: event.clientX, y: event.clientY },
      };
      state.supportTapStart = null;
      state.bridgePreview = { start: drawingFrom, end, width: safeBridgeWidthMm() };
      activeCanvasPointerId = event.pointerId;
      viewport.setPointerCapture(event.pointerId);
      draw();
      return;
    }
    if (['keep', 'remove', 'restore'].includes(state.tool)) {
      const mode = touchupMode();
      // Region selection needs a cell under the pointer. Brush gestures only
      // need their physical footprint to overlap the sheet, so edge work still
      // applies when the cursor centre is just outside the drawing.
      const canStart = mode === 'region'
        ? inside
        : touchupFootprintIntersectsMask({ x, y });
      if (!canStart) return;
      const operation = touchupOperation();
      const liveStructureMask = mode === 'freehand' && operation !== 'restore'
        ? touchupStructureMask() : null;
      const region = mode === 'region' ? touchupRegion({ x, y }) : null;
      if (region?.truncated) {
        toast('That region is too large for a touch-up. Adjust the filter instead.');
        return;
      }
      const legacyPainted = {
        keep: new Set(state.painted.keep),
        remove: new Set(state.painted.remove),
      };
      const pointMm = maskPointToMm({ x, y });
      let changed = false;
      if (mode === 'region') {
        if (operation === 'restore') {
          const painted = currentManualPainted();
          changed = region.indices.some((index) => painted.keep.has(index) || painted.remove.has(index));
        } else {
          for (const index of region.indices) changed = paintIndex(index) || changed;
        }
      } else if (mode === 'freehand' && operation !== 'restore') {
        changed = paintDisc({ x, y }, touchupSizeMm(), { liveStructureMask });
      }
      touchupStroke = {
        operation,
        mode,
        start: { x, y },
        last: { x, y },
        startMm: pointMm,
        lastMm: pointMm,
        pointsMm: [pointMm],
        widthMm: touchupSizeMm(),
        regionIndices: region?.indices ?? null,
        legacyPainted,
        liveStructureMask,
        reviewAnchor: captureManualValidationReview(),
        changed,
      };
      state.touchupLive = mode === 'freehand' && operation !== 'restore';
      state.touchupPreview = mode === 'straight'
        ? { mode: 'straight', start: { x, y }, end: { x, y }, diameterMm: touchupSizeMm() }
        : { mode: 'cursor', point: { x, y }, diameterMm: touchupSizeMm() };
      activeCanvasPointerId = event.pointerId;
      viewport.setPointerCapture(event.pointerId);
      if (touchupStroke.changed && mode === 'freehand') scheduleLiveTouchupDraw();
      else if (touchupStroke.changed && operation !== 'restore') refresh({ reanalyse: false, manualGeometryEdit: true });
      else draw();
      return;
    }
    state.hoveredBridge = null;
    if (state.selectedBridge) selectBridge(null);
    panning = { x: event.clientX - state.pan.x, y: event.clientY - state.pan.y };
    activeCanvasPointerId = event.pointerId;
    viewport.setPointerCapture(event.pointerId);
    viewport.style.cursor = 'grabbing';
  });

  viewport?.addEventListener('pointermove', (event) => {
    if (activeCanvasPointerId !== null && event.pointerId !== activeCanvasPointerId) return;
    if (activeCanvasPointerId === null && event.isPrimary === false) return;
    const { x, y, inside, mmX, mmY } = pointerToMm(event);
    if (inside && state.designMask) {
      el('pointer-position').textContent = state.unit === 'in'
        ? `x ${(mmX / MM_PER_INCH).toFixed(2)}  y ${(mmY / MM_PER_INCH).toFixed(2)}`
        : `x ${Math.round(mmX)}  y ${Math.round(mmY)}`;
    }
    if (draggingArtwork) {
      setArtworkOffset(
        draggingArtwork.offsetXMm + mmX - draggingArtwork.origin.x,
        draggingArtwork.offsetYMm + mmY - draggingArtwork.origin.y,
      );
      scheduleArtworkTransformPreview();
    } else if (draggingManualEdit) {
      const index = state.manualEdits.findIndex((edit) => edit.id === draggingManualEdit.id);
      const deltaX = mmX - draggingManualEdit.origin.x;
      const deltaY = mmY - draggingManualEdit.origin.y;
      if (index >= 0 && (draggingManualEdit.moved || Math.hypot(deltaX, deltaY) > 0.05)) {
        draggingManualEdit.moved = true;
        state.manualEdits[index] = translateManualEdit(
          draggingManualEdit.original,
          deltaX,
          deltaY,
        );
        draw();
      }
    } else if (drawingFrom) {
      if (!inside) return;
      if (drawingSupportGesture && Math.hypot(
        event.clientX - drawingSupportGesture.pointer.x,
        event.clientY - drawingSupportGesture.pointer.y,
      ) >= 5) drawingSupportGesture.moved = true;
      const end = manualSupportPoint({ x: mmX, y: mmY }, drawingFrom);
      state.bridgePreview = { start: drawingFrom, end, width: safeBridgeWidthMm() };
      draw();
    } else if (touchupStroke) {
      if (touchupStroke.mode === 'freehand') {
        let pointMm = smoothTouchupPoint(touchupStroke.lastMm, { x: mmX, y: mmY });
        pointMm = constrainTouchupPoint(touchupStroke.startMm, pointMm, event.shiftKey);
        const rasterPoint = mmPointToMask(pointMm);
        if (touchupStroke.operation !== 'restore') {
          touchupStroke.changed = paintSegment(touchupStroke.last, rasterPoint, {
            liveStructureMask: touchupStroke.liveStructureMask,
            diameterMm: touchupStroke.widthMm,
          }) || touchupStroke.changed;
        }
        if (touchupStroke.pointsMm.length < 20000 &&
            Math.hypot(pointMm.x - touchupStroke.lastMm.x, pointMm.y - touchupStroke.lastMm.y) > 0.05) {
          touchupStroke.pointsMm.push(pointMm);
        }
        touchupStroke.last = rasterPoint;
        touchupStroke.lastMm = pointMm;
        state.touchupPreview = { mode: 'cursor', point: rasterPoint, diameterMm: touchupStroke.widthMm };
        scheduleLiveTouchupDraw();
      } else if (touchupStroke.mode === 'straight') {
        const pointMm = constrainTouchupPoint(touchupStroke.startMm, { x: mmX, y: mmY }, event.shiftKey);
        const rasterPoint = mmPointToMask(pointMm);
        touchupStroke.last = rasterPoint;
        touchupStroke.lastMm = pointMm;
        state.touchupPreview = {
          mode: 'straight', start: touchupStroke.start, end: rasterPoint, diameterMm: touchupStroke.widthMm,
        };
        draw();
      }
    } else if (draggingBridge) {
      promoteBridgeToManual(draggingBridge.bridge);
      draggingBridge.bridge.width = safeBridgeWidthMm(draggingBridge.bridge.width);
      if (draggingBridge.mode === 'start' || draggingBridge.mode === 'end') {
        const other = draggingBridge.mode === 'start' ? draggingBridge.bridge.end : draggingBridge.bridge.start;
        const endpoint = manualSupportPoint(
          { x: mmX, y: mmY },
          other,
          { followDirection: false },
        );
        draggingBridge.bridge[draggingBridge.mode] = endpoint;
      } else {
        draggingBridge.bridge.start = { ...draggingBridge.start };
        draggingBridge.bridge.end = { ...draggingBridge.end };
        translateBridge(
          draggingBridge.bridge,
          mmX - draggingBridge.origin.x,
          mmY - draggingBridge.origin.y,
        );
      }
      draggingBridge.bridge.lengthMm = Math.hypot(
        draggingBridge.bridge.end.x - draggingBridge.bridge.start.x,
        draggingBridge.bridge.end.y - draggingBridge.bridge.start.y,
      );
      syncSelectedBridgeControls({ renderList: false });
      refresh({ immediate: true, reanalyse: false, rebuildSourceMask: false, manualGeometryEdit: true });
    } else if (panning) {
      state.pan = { x: event.clientX - panning.x, y: event.clientY - panning.y };
      applyTransform();
    } else if (['keep', 'remove', 'restore'].includes(state.tool)) {
      // The stencil centre may sit outside the sheet while its physical disc
      // still overlaps the edge. Keeping the raw point makes edge work precise
      // instead of freezing the cursor at the drawing boundary.
      state.touchupPreview = { mode: 'cursor', point: { x, y }, diameterMm: touchupSizeMm() };
      draw();
    } else {
      const handle = state.tool === 'support' ? bridgeHandleAtPointer(event) : null;
      const hovered = state.tool === 'support'
        ? handle && state.selectedBridge ? state.selectedBridge : bridgeAtPointer(event)
        : null;
      const changed = hovered !== state.hoveredBridge;
      state.hoveredBridge = hovered;
      viewport.style.cursor = handle ? (handle === 'move' ? 'move' : 'crosshair')
        : hovered ? 'move'
          : state.tool === 'pan' ? 'grab' : state.tool === 'artwork' ? 'move' : 'crosshair';
      if (changed) draw();
    }
  });

  viewport?.addEventListener('pointerup', (event) => {
    if (activeCanvasPointerId !== null && event.pointerId !== activeCanvasPointerId) return;
    const releasePoint = pointerToMask(event);
    const inside = releasePoint.inside;
    if (draggingArtwork) {
      draggingArtwork = null;
      finishArtworkTransform();
    }
    if (draggingManualEdit) {
      const reviewAnchor = draggingManualEdit.reviewAnchor;
      const moved = draggingManualEdit.moved;
      if (moved) retireManualEditRepairConflicts(selectedManualEdit());
      draggingManualEdit = null;
      renderManualEditManager();
      if (moved) {
        refresh({ immediate: true, manualGeometryEdit: true });
        pushHistory();
        scheduleManualValidationReview(reviewAnchor);
      } else {
        draw();
      }
    }
    if (draggingBridge) {
      const reviewAnchor = draggingBridge.reviewAnchor;
      draggingBridge.bridge.lengthMm = Math.hypot(
        draggingBridge.bridge.end.x - draggingBridge.bridge.start.x,
        draggingBridge.bridge.end.y - draggingBridge.bridge.start.y,
      );
      selectBridge(draggingBridge.bridge);
      draggingBridge = null;
      refresh({ immediate: true, rebuildSourceMask: false, manualGeometryEdit: true });
      pushHistory();
      scheduleManualValidationReview(reviewAnchor);
    }
    if (drawingFrom) {
      const end = state.bridgePreview?.end;
      const lengthMm = end ? Math.hypot(end.x - drawingFrom.x, end.y - drawingFrom.y) : 0;
      const completesSupport = inside && end && lengthMm > Number.EPSILON &&
        (drawingSupportGesture?.fromPending || drawingSupportGesture?.moved);
      if (completesSupport) {
        clearSupportProposal();
        const bridge = {
          id: `manual-${Date.now()}`, type: 'capsule', enabled: true, units: 'mm',
          start: drawingFrom, end,
          width: safeBridgeWidthMm(),
          lengthMm,
          source: 'manual',
        };
        state.bridges.push(bridge);
        refresh({ immediate: true, rebuildSourceMask: false, manualGeometryEdit: true });
        selectBridge(bridge);
        pushHistory();
        scheduleManualValidationReview(drawingReviewAnchor);
        toast('Support added. Drag either endpoint handle to refine it.');
      } else if (!drawingSupportGesture?.fromPending && inside && !drawingSupportGesture?.moved) {
        state.supportTapStart = { ...drawingFrom };
        state.bridgePreview = {
          start: state.supportTapStart,
          end: state.supportTapStart,
          width: safeBridgeWidthMm(),
          pendingTap: true,
        };
        toast('Support start set. Tap the end point, or press Escape to cancel.');
      } else if (drawingSupportGesture?.fromPending) {
        state.supportTapStart = { ...drawingFrom };
        state.bridgePreview = {
          start: state.supportTapStart,
          end: state.supportTapStart,
          width: safeBridgeWidthMm(),
          pendingTap: true,
        };
      }
      drawingFrom = null;
      drawingReviewAnchor = null;
      drawingSupportGesture = null;
      state.drawingBridge = state.tool === 'support';
      if (!state.supportTapStart) state.bridgePreview = null;
      draw();
    }
    if (touchupStroke) {
      const reviewAnchor = touchupStroke.reviewAnchor;
      let edit = null;
      if (touchupStroke.mode === 'straight') {
        const rawMm = maskPointToMm(releasePoint);
        const pointMm = constrainTouchupPoint(touchupStroke.startMm, rawMm, event.shiftKey);
        const rasterPoint = mmPointToMask(pointMm);
        touchupStroke.last = rasterPoint;
        touchupStroke.lastMm = pointMm;
        if (touchupStroke.operation !== 'restore') {
          touchupStroke.changed = paintSegment(touchupStroke.start, rasterPoint, {
            diameterMm: touchupStroke.widthMm,
          }) || touchupStroke.changed;
        }
        edit = makeManualStroke(touchupStroke.operation, touchupStroke.widthMm, [touchupStroke.startMm, pointMm]);
      } else if (touchupStroke.mode === 'freehand') {
        const pointMm = constrainTouchupPoint(
          touchupStroke.startMm,
          maskPointToMm(releasePoint),
          event.shiftKey,
        );
        const rasterPoint = mmPointToMask(pointMm);
        if (touchupStroke.operation !== 'restore') {
          touchupStroke.changed = paintSegment(touchupStroke.last, rasterPoint, {
            liveStructureMask: touchupStroke.liveStructureMask,
            diameterMm: touchupStroke.widthMm,
          }) || touchupStroke.changed;
        }
        if (touchupStroke.pointsMm.length < 20000 &&
            Math.hypot(pointMm.x - touchupStroke.lastMm.x, pointMm.y - touchupStroke.lastMm.y) > 0.05) {
          touchupStroke.pointsMm.push(pointMm);
        }
        edit = makeManualStroke(touchupStroke.operation, touchupStroke.widthMm, touchupStroke.pointsMm);
      } else {
        edit = makeManualRegion(touchupStroke.operation, touchupStroke.regionIndices ?? []);
      }
      state.painted = touchupStroke.legacyPainted;
      if (touchupStroke.operation === 'restore' && edit) {
        const painted = currentManualPainted();
        touchupStroke.changed = manualEditIndices(state.sourceMask, sheet(), edit)
          .some((index) => painted.keep.has(index) || painted.remove.has(index));
      }
      const changed = touchupStroke.changed && Boolean(edit);
      if (changed) {
        state.manualEdits.push(edit);
        retireManualEditRepairConflicts(edit);
      }
      touchupStroke = null;
      state.touchupLive = false;
      cancelLiveTouchupDraw();
      state.touchupPreview = {
        mode: 'cursor', point: releasePoint, diameterMm: touchupSizeMm(),
      };
      if (changed) {
        refresh({ immediate: true, manualGeometryEdit: true });
        renderManualEditManager();
        pushHistory();
        scheduleManualValidationReview(reviewAnchor);
        updateTouchupHud('Saved as an editable operation');
        reportTouchupResult();
      } else {
        draw();
        updateTouchupHud('Nothing under this gesture changed');
      }
    }
    panning = null;
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    activeCanvasPointerId = null;
    viewport.style.cursor = state.tool === 'pan' ? 'grab' : state.tool === 'artwork' ? 'move' : 'crosshair';
  });

  viewport?.addEventListener('pointerleave', () => {
    if (touchupStroke || drawingFrom || draggingBridge || draggingArtwork || draggingManualEdit) return;
    state.touchupPreview = null;
    state.hoveredBridge = null;
    draw();
  });

  viewport?.addEventListener('pointercancel', (event) => {
    if (activeCanvasPointerId !== null && event.pointerId !== activeCanvasPointerId) return;
    const painted = touchupStroke?.changed === true;
    const movedBridge = Boolean(draggingBridge);
    const movedArtwork = Boolean(draggingArtwork);
    const reviewAnchor = touchupStroke?.reviewAnchor ?? draggingBridge?.reviewAnchor ??
      draggingManualEdit?.reviewAnchor ?? drawingReviewAnchor;
    if (touchupStroke?.legacyPainted) state.painted = touchupStroke.legacyPainted;
    if (draggingManualEdit) {
      const index = state.manualEdits.findIndex((edit) => edit.id === draggingManualEdit.id);
      if (index >= 0) state.manualEdits[index] = draggingManualEdit.original;
    }
    touchupStroke = null;
    state.touchupLive = false;
    cancelLiveTouchupDraw();
    drawingFrom = null;
    drawingReviewAnchor = null;
    drawingSupportGesture = null;
    draggingBridge = null;
    draggingManualEdit = null;
    draggingArtwork = null;
    panning = null;
    state.drawingBridge = state.tool === 'support';
    state.supportTapStart = null;
    state.bridgePreview = null;
    state.touchupPreview = null;
    state.hoveredBridge = null;
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    activeCanvasPointerId = null;
    if (painted) {
      refresh({ immediate: true, manualGeometryEdit: true });
      renderManualEditManager();
    } else if (movedBridge) {
      refresh({ immediate: true, rebuildSourceMask: false, manualGeometryEdit: true });
      pushHistory();
      scheduleManualValidationReview(reviewAnchor);
    } else if (movedArtwork) {
      finishArtworkTransform();
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
  for (const id of ['btn-fit', 'btn-fit-toolbar']) el(id)?.addEventListener('click', fitToView);

  document.addEventListener('keydown', (event) => {
    const viewport = el('canvas-viewport');
    const editableTarget = isEditableShortcutTarget(event.target);
    const canvasContext = isCanvasShortcutTarget(event.target, viewport);
    if (event.metaKey || event.ctrlKey) {
      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (state.isDraft) void saveDraftAsProject();
        else void flushPendingSave();
        return;
      }
      // A field's browser-native undo history always wins. Project history is
      // only available while the drawing surface owns keyboard focus.
      if (editableTarget || !canvasContext) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) { event.preventDefault(); undo(); }
      if (key === 'y' || (key === 'z' && event.shiftKey)) { event.preventDefault(); redo(); }
      return;
    }
    if (event.altKey || editableTarget) return;
    if (event.code === 'Space' && canvasContext && !temporaryPan && activeCanvasPointerId === null) {
      event.preventDefault();
      temporaryPan = { tool: state.tool, selectedManualEditId: state.selectedManualEditId };
      state.tool = 'pan';
      state.touchupPreview = null;
      syncToolRailState();
      viewport.dataset.activeTool = 'pan';
      viewport.style.cursor = 'grab';
      updateTouchupHud();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (clearIssueHighlight()) viewport.focus({ preventScroll: true });
      else if (state.supportTapStart) {
        state.supportTapStart = null;
        state.bridgePreview = null;
        draw();
      }
      else if (state.selectedBridge) selectBridge(null);
      else if (state.selectedManualEditId) selectManualEdit(null);
      else if (toolOptionsKind) closeToolOptions({ returnFocus: true });
      else if (mobileSheet) closeMobileSheet({ returnFocus: true });
      else setTool('pan');
      return;
    }
    if (!canvasContext) return;
    if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedManualEditId) {
      event.preventDefault();
      deleteSelectedManualEdit();
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedBridge) {
      event.preventDefault();
      deleteSelectedBridge();
      return;
    }
    if (state.selectedBridge && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const reviewAnchor = captureManualValidationReview();
      const distanceMm = event.shiftKey ? 10 : 1;
      const movement = {
        ArrowLeft: [-distanceMm, 0],
        ArrowRight: [distanceMm, 0],
        ArrowUp: [0, -distanceMm],
        ArrowDown: [0, distanceMm],
      }[event.key];
      clearSupportProposal();
      promoteBridgeToManual(state.selectedBridge);
      translateBridge(state.selectedBridge, movement[0], movement[1]);
      syncSelectedBridgeControls();
      refresh({ immediate: true, reanalyse: false, rebuildSourceMask: false, manualGeometryEdit: true });
      pushHistory();
      scheduleManualValidationReview(reviewAnchor);
      return;
    }
    if (state.selectedManualEditId && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      const edit = selectedManualEdit();
      if (edit?.shape === 'stroke') {
        event.preventDefault();
        const distanceMm = event.shiftKey ? 10 : 1;
        const movement = {
          ArrowLeft: [-distanceMm, 0],
          ArrowRight: [distanceMm, 0],
          ArrowUp: [0, -distanceMm],
          ArrowDown: [0, distanceMm],
        }[event.key];
        const moved = translateManualEdit(edit, movement[0], movement[1]);
        updateSelectedManualEdit({ pointsMm: moved.pointsMm });
        return;
      }
    }
    if (state.tool === 'artwork' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const distanceMm = event.shiftKey ? 10 : 1;
      const movement = {
        ArrowLeft: [-distanceMm, 0],
        ArrowRight: [distanceMm, 0],
        ArrowUp: [0, -distanceMm],
        ArrowDown: [0, distanceMm],
      }[event.key];
      const transform = artworkTransform();
      setArtworkOffset(
        transform.offsetXMm + movement[0],
        transform.offsetYMm + movement[1],
      );
      finishArtworkTransform();
      return;
    }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomAt(state.zoom * 1.35); }
    if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomAt(state.zoom / 1.35); }
    if (event.key === '0') { event.preventDefault(); zoomAt(1); }
    if (event.key === 'f' || event.key === 'F') { event.preventDefault(); fitToView(); }
    if (event.key === 'i' || event.key === 'I') { event.preventDefault(); activateIconStencil(); }
    if (event.key === 'k' || event.key === 'K') { event.preventDefault(); activateTouchupTool('keep'); }
    if (event.key === 'r' || event.key === 'R') { event.preventDefault(); activateTouchupTool('remove'); }
    if (event.key === 'e' || event.key === 'E') { event.preventDefault(); activateTouchupTool('restore'); }
    if (event.key === 'v' || event.key === 'V') { event.preventDefault(); activateTouchupTool('touchup-select'); }
    if ((event.key === 'x' || event.key === 'X') && ['keep', 'remove'].includes(state.tool)) {
      event.preventDefault();
      activateTouchupTool(state.tool === 'keep' ? 'remove' : 'keep');
    }
    if ((event.key === '[' || event.key === ']') && touchupOperation()) {
      event.preventDefault();
      const size = el('touchup-size');
      const stepMm = event.shiftKey ? 5 : 1;
      const nextMm = Math.max(touchupMinimumMm(), Math.min(250,
        touchupSizeMm() + (event.key === ']' ? stepMm : -stepMm)));
      size.value = String(roundUnit(fromMm(nextMm)));
      updateTouchupControls();
      draw();
    }
    if ((event.key === 'p' || event.key === 'P') && state.bridges.length) {
      event.preventDefault();
      selectAdjacentBridge(-1);
    }
    if ((event.key === 'n' || event.key === 'N') && state.bridges.length) {
      event.preventDefault();
      selectAdjacentBridge(1);
    }
    if ((event.key === 'b' || event.key === 'B') && state.designMask) {
      event.preventDefault();
      setStage('support');
      el('btn-add-bridge')?.click();
    }
  });

  document.addEventListener('keyup', (event) => {
    if (event.code !== 'Space' || !temporaryPan) return;
    state.tool = temporaryPan.tool;
    state.selectedManualEditId = temporaryPan.selectedManualEditId;
    temporaryPan = null;
    syncToolRailState();
    viewport.dataset.activeTool = state.tool;
    viewport.style.cursor = state.tool === 'pan' ? 'grab' : state.tool === 'artwork' ? 'move' : 'crosshair';
    renderManualEditManager();
    updateTouchupHud();
    draw();
  });

  window.addEventListener('beforeunload', (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  const flushLocalForLifecycle = () => {
    pauseAutomaticSyncRetry();
    if (!state.dirty && !localSaveTimer) return;
    void flushPendingLocalSave();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushLocalForLifecycle();
    } else if (navigator.onLine && state.projectId) {
      void syncWorkspaceProjects({ announce: false });
    }
  });
  window.addEventListener('pagehide', flushLocalForLifecycle);
}

function updateRangeOutputs() {
  const set = (id, text) => { const node = el(id); if (node) node.textContent = text; };
  const signed = (value) => value > 0 ? `+${value}` : String(value);
  set('threshold-value', `${numberField('threshold', 50)}%`);
  set('contrast-value', String(numberField('contrast', 0)));
  set('blur-value', `${numberField('blur', 0)} px`);
  set('despeckle-value', `${numberField('despeckle', 0)} px²`);
  set('touchup-smoothing-value', `${Math.round(numberField('touchup-smoothing', 35))}%`);
  set('artwork-scale-value', `${Math.round(numberField('artwork-scale', 100))}%`);
  set('artwork-rotation-value', `${Math.round(numberField('artwork-rotation', 0))}°`);
  const secure = Number(el('bridge-count')?.value || 2);
  set('bridge-count-value', ['Minimal', 'Aesthetic', 'Secure'][secure - 1] ?? 'Aesthetic');
  set('stabilizer-organic-value', `${numberField('stabilizer-organic', 75)}%`);
  set('style-tone-brightness-value', signed(numberField('style-tone-brightness', 0)));
  set('style-tone-contrast-value', signed(numberField('style-tone-contrast', 0)));
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
  set('style-dot-cutoff-value', `${numberField('style-dot-cutoff', 42)}%`);
  set('style-flow-follow-value', `${numberField('style-flow-follow', 72)}%`);
  set('style-flow-cutoff-value', `${numberField('style-flow-cutoff', 16)}%`);
  set('style-ornament-detail-value', `${numberField('style-ornament-detail', 40)}%`);
}

/* -------------------------------------------------------------------- entry */

export async function startEditor({ device, offline = false } = {}) {
  state.device = device;
  state.offline = offline || !navigator.onLine;

  wire();
  syncMobileWorkspaceLayout();
  syncCuttingProfileControls();
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

  // Reopen the complete local copy first so a slow mobile connection never
  // blocks the editor. Server reconciliation continues safely in the background.
  let reopenedFromCache = false;
  try {
    const previous = await loadLastProject();
    if (previous?.raster?.sourceMask) {
      await loadProjectState(previous);
      reopenedFromCache = true;
      toast('Reopened your last saved panel.');
    } else {
      setSaveState('saved', 'No artwork');
    }
  } catch (error) {
    console.error(error);
    setSaveState('error', 'Could not open cached project');
  }

  await offerSharedProject();

  // Legacy origin-wide projects remain quarantined and can only be copied in
  // through the explicit Projects-library action. If this linked device has no
  // local project yet, open the newest server project after the background pull.
  if (!state.offline) {
    void syncWorkspaceProjects({ announce: false }).then(async (result) => {
      if (reopenedFromCache || result?.status !== 'synced' || state.sourceMask || state.shareBusy) return;
      const syncedProject = await loadLastProject();
      if (!syncedProject?.raster?.sourceMask || state.sourceMask) return;
      await loadProjectState(syncedProject);
      pushHistory();
      toast('Opened your latest server project.');
    }).catch((error) => console.error('Could not open the synchronized project:', error));
  }

  pushHistory();
  window.stencilCncIsBusy = () => Boolean(
    state.dirty || state.styleBusy || state.shareBusy || workspaceSyncInFlight ||
    localSaveInFlight || serverSyncInFlight || rebuildTimer || localSaveTimer || serverSyncTimer || styleTimer,
  );
  window.addEventListener('resize', () => {
    syncMobileWorkspaceLayout();
    fitToView();
  });
  window.addEventListener('offline', () => {
    state.offline = true;
    pauseAutomaticSyncRetry();
    if (state.projectId) void setPendingSaveState();
  });
  window.addEventListener('online', () => {
    state.offline = false;
    resetAutomaticSyncRetry();
    void syncWorkspaceProjects({ announce: true });
  });
}
