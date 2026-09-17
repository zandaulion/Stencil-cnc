import { assertMask, createMask } from "./mask.js";
import { validateBridge } from "./bridges.js";
import { CANDIDATE_PAYLOAD_VERSION } from "./candidates.js";
import { normalizeVectorDots } from "./vector-dots.js";
import { createCuttingProfile, legacyCuttingProfile, normalizeCuttingProfile } from "./cutting-profile.js";
import {
  FINISHED_BOUNDARY_CAM,
  LEGACY_UNCOMPENSATED_CENTERLINE,
  normalizeGeometryInterpretation,
} from "./geometry-contract.js";

export const PROJECT_SCHEMA = "stencil-cnc.project";
export const PROJECT_VERSION = 5;

/**
 * @typedef {object} StencilProject
 * @property {'stencil-cnc.project'} schema
 * @property {5} version
 * @property {string | null} id
 * @property {string} name
 * @property {'mm'} units
 * @property {{widthMm:number,heightMm:number}} sheet
 * @property {{mode:'line-art'|'photograph',threshold:number,invert:boolean,backgroundLuminance:number}} conversion
 * @property {{enabled:boolean,thicknessMm:number|object,insetMm:number|object,sides:{top:boolean,right:boolean,bottom:boolean,left:boolean}}} frame
 * @property {{kerfMm:number,minimumWebMm:number,minimumOpeningMm:number,maximumCantileverMm:number|null,geometryInterpretation:'finished-boundary-cam-v1'|'legacy-uncompensated-centerline-v1',profile:object}} manufacturing
 * @property {{mode:'single-sheet'}} structure
 * @property {{kind:'none'|'image',name:string|null,mimeType:string|null,widthPx:number|null,heightPx:number|null,imageDataUrl:string|null}} source
 * @property {{sourceMask:EncodedMask|null,baseMask:EncodedMask|null}} raster
 * @property {Array<object>} bridges
 * @property {{controls:Record<string,unknown>,styleSettings:Record<string,Record<string,unknown>>,vectorDots:object|null,painted:{keep:number[],remove:number[]},manufacturingRepairs:{keep:number[],remove:number[],enabled:boolean,stale:boolean,summary:object|null},candidates:Array<object>,selectedCandidateId:string|null,automaticSupportsStale:boolean,projectSummary:{thumbnail:string|null,cutStyle:string,status:'draft'|'needs-validation'|'ready',lastValidatedAt:string|null,lastExportedAt:string|null}}|null} editor
 * @property {string|null} createdAt
 * @property {string|null} updatedAt
 */

/**
 * @typedef {{encoding:'rle-u1',width:number,height:number,startsWith:0|1,runs:number[]}} EncodedMask
 */

const DEFAULT_PROJECT = Object.freeze({
  schema: PROJECT_SCHEMA,
  version: PROJECT_VERSION,
  id: null,
  name: "Untitled stencil",
  units: "mm",
  sheet: { widthMm: 1250, heightMm: 2500 },
  conversion: { mode: "line-art", threshold: 128, invert: false, backgroundLuminance: 255 },
  frame: {
    enabled: true,
    thicknessMm: 12,
    insetMm: 0,
    sides: { top: true, right: true, bottom: true, left: true },
  },
  manufacturing: {
    kerfMm: 1.2,
    minimumWebMm: 3,
    minimumOpeningMm: 2,
    maximumCantileverMm: 250,
    geometryInterpretation: FINISHED_BOUNDARY_CAM,
    profile: createCuttingProfile(),
  },
  structure: { mode: "single-sheet" },
  source: {
    kind: "none",
    name: null,
    mimeType: null,
    widthPx: null,
    heightPx: null,
    imageDataUrl: null,
  },
  raster: { sourceMask: null, baseMask: null },
  bridges: [],
  editor: null,
  createdAt: null,
  updatedAt: null,
});

/** @param {Partial<StencilProject> & Record<string, any>} [overrides] @returns {StencilProject} */
export function createProject(overrides = {}) {
  const manufacturing = { ...DEFAULT_PROJECT.manufacturing, ...overrides.manufacturing };
  if (!Object.hasOwn(overrides.manufacturing ?? {}, 'profile')) {
    manufacturing.profile = createCuttingProfile({
      limits: {
        kerfMm: manufacturing.kerfMm,
        minimumWebMm: manufacturing.minimumWebMm,
        minimumOpeningMm: manufacturing.minimumOpeningMm,
        supportWidthMm: manufacturing.supportWidthMm ?? 6,
        maximumUnsupportedSpanMm: manufacturing.maximumCantileverMm,
      },
    });
  }
  const candidate = {
    ...DEFAULT_PROJECT,
    ...overrides,
    schema: PROJECT_SCHEMA,
    version: PROJECT_VERSION,
    units: "mm",
    sheet: { ...DEFAULT_PROJECT.sheet, ...overrides.sheet },
    conversion: { ...DEFAULT_PROJECT.conversion, ...overrides.conversion },
    frame: {
      ...DEFAULT_PROJECT.frame,
      ...overrides.frame,
      sides: { ...DEFAULT_PROJECT.frame.sides, ...overrides.frame?.sides },
    },
    manufacturing,
    structure: { ...DEFAULT_PROJECT.structure, ...overrides.structure },
    source: { ...DEFAULT_PROJECT.source, ...overrides.source },
    raster: { ...DEFAULT_PROJECT.raster, ...overrides.raster },
    bridges: overrides.bridges ?? DEFAULT_PROJECT.bridges,
  };
  return normalizeProject(candidate);
}

/** @param {StencilProject} project @param {import('./mask.js').RasterMask} mask */
export function projectWithSourceMask(project, mask) {
  return createProject({ ...project, raster: { ...project.raster, sourceMask: encodeMask(mask) } });
}

/** @param {import('./mask.js').RasterMask} mask @returns {EncodedMask} */
export function encodeMask(mask) {
  assertMask(mask);
  const startsWith = /** @type {0|1} */ (mask.data[0] ? 1 : 0);
  const runs = [];
  let current = startsWith;
  let length = 0;
  for (const rawValue of mask.data) {
    const value = rawValue ? 1 : 0;
    if (value === current) {
      length += 1;
    } else {
      runs.push(length);
      current = value;
      length = 1;
    }
  }
  runs.push(length);
  return { encoding: "rle-u1", width: mask.width, height: mask.height, startsWith, runs };
}

/** @param {EncodedMask} encoded @returns {import('./mask.js').RasterMask} */
export function decodeMask(encoded) {
  validateEncodedMask(encoded);
  const mask = createMask(encoded.width, encoded.height);
  let value = encoded.startsWith;
  let offset = 0;
  for (const run of encoded.runs) {
    if (value === 1) mask.data.fill(1, offset, offset + run);
    offset += run;
    value = value === 1 ? 0 : 1;
  }
  return mask;
}

/** @param {StencilProject} project @param {{pretty?: boolean}} [options] */
export function serializeProject(project, options = {}) {
  const normalized = normalizeProject(project);
  return JSON.stringify(normalized, null, options.pretty === true ? 2 : 0);
}

/** @param {string} serialized @returns {StencilProject} */
export function deserializeProject(serialized) {
  if (typeof serialized !== "string") throw new TypeError("Serialized project must be a JSON string");
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new SyntaxError(`Invalid project JSON: ${error.message}`);
  }
  return normalizeProject(migrateProject(parsed));
}

/**
 * Upgrade a browser/server record without discarding fields that intentionally
 * live outside the portable project schema (source Blob, sync metadata, Trash).
 */
export function upgradeProjectRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('A project record is required');
  }
  if (record.version === PROJECT_VERSION && record.manufacturing?.profile) return record;
  return { ...record, ...deserializeProject(JSON.stringify(record)) };
}

/**
 * Explicit migration entry point. Version 0 was the pre-release flat draft;
 * retaining its migration makes future schema changes follow the same path.
 *
 * @param {Record<string, any>} input
 */
export function migrateProject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Project must be an object");
  const version = input.version ?? 0;
  if (!Number.isInteger(version) || version < 0) throw new RangeError("Project version must be a non-negative integer");
  if (version > PROJECT_VERSION) {
    throw new RangeError(`Project version ${version} is newer than supported version ${PROJECT_VERSION}`);
  }
  let project = cloneJson(input);
  if (version === 0) {
    project = createProject({
      ...project,
      name: project.name ?? DEFAULT_PROJECT.name,
      units: "mm",
      sheet: project.sheet ?? {
        widthMm: project.widthMm ?? DEFAULT_PROJECT.sheet.widthMm,
        heightMm: project.heightMm ?? DEFAULT_PROJECT.sheet.heightMm,
      },
      conversion: {
        ...DEFAULT_PROJECT.conversion,
        ...(project.conversion ?? {
        mode: project.mode ?? "line-art",
        threshold: project.threshold ?? 128,
        invert: project.invert ?? false,
        }),
      },
      raster: project.raster ?? { sourceMask: project.sourceMask ?? null },
      manufacturing: {
        ...project.manufacturing,
        geometryInterpretation: LEGACY_UNCOMPENSATED_CENTERLINE,
      },
    });
  } else if (version === 1) {
    // Version 2 makes complete candidate snapshots part of the persistence
    // contract. Raising the outer version prevents an older offline client
    // from opening a newer project and silently dropping candidate repair
    // layers when it next serializes the project.
    project.version = 2;
  }
  if (version < 3) {
    // Versions 0–2 generated stored raster geometry with a full kerf of web
    // allowance and validated it as uncompensated cutter-centre geometry.
    // Preserve that meaning until the owner explicitly chooses the new CAM
    // contract. The bitmap is not silently narrowed or regenerated.
    project.version = PROJECT_VERSION;
    project.manufacturing = {
      ...project.manufacturing,
      geometryInterpretation: LEGACY_UNCOMPENSATED_CENTERLINE,
    };
    if (project.editor?.projectSummary) {
      project.editor.projectSummary = {
        ...project.editor.projectSummary,
        status: project.raster?.sourceMask ? "needs-validation" : "draft",
        lastValidatedAt: null,
      };
    }
  }
  if (version < 4) {
    // Version 4 preserves exact Variable Dots primitives alongside the
    // conservative validation raster. Older projects remain raster-only until
    // the style is rendered again.
    project.version = PROJECT_VERSION;
  }
  if (version < 5) {
    // Version 5 turns anonymous manufacturing numbers into a versioned,
    // provenance-bearing snapshot. Preserve every existing number exactly and
    // make no claim that an old project was verified for a particular shop.
    const storedUnit = project.editor?.controls?.['measurement-unit'] === 'in' ? 'in' : 'mm';
    const storedPhysicalControl = (id) => {
      const value = Number(project.editor?.controls?.[id]);
      if (!Number.isFinite(value) || value <= 0) return undefined;
      return storedUnit === 'in' ? value * 25.4 : value;
    };
    const legacyManufacturing = {
      ...project.manufacturing,
      supportWidthMm: storedPhysicalControl('bridge-width'),
      maximumCantileverMm:
        project.manufacturing?.maximumCantileverMm ?? storedPhysicalControl('max-cantilever'),
    };
    project.manufacturing = {
      ...project.manufacturing,
      profile: legacyCuttingProfile(legacyManufacturing),
    };
    project.version = PROJECT_VERSION;
    if (project.editor?.projectSummary) {
      project.editor.projectSummary = {
        ...project.editor.projectSummary,
        status: project.raster?.sourceMask ? 'needs-validation' : 'draft',
        lastValidatedAt: null,
      };
    }
  }
  return project;
}

/** @param {Record<string, any>} input @returns {StencilProject} */
export function normalizeProject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Project must be an object");
  if (input.schema !== PROJECT_SCHEMA) throw new RangeError(`Unsupported project schema: ${input.schema}`);
  if (input.version !== PROJECT_VERSION) throw new RangeError(`Unsupported project version: ${input.version}`);
  if (input.units !== "mm") throw new RangeError("Project units must be 'mm'");

  const sheet = {
    widthMm: positive(input.sheet?.widthMm, "sheet.widthMm"),
    heightMm: positive(input.sheet?.heightMm, "sheet.heightMm"),
  };
  const mode = input.conversion?.mode;
  if (mode !== "line-art" && mode !== "photograph") throw new RangeError("Unsupported conversion mode");
  const threshold = range(input.conversion.threshold, 0, 255, "conversion.threshold");
  const backgroundLuminance = range(input.conversion.backgroundLuminance, 0, 255, "conversion.backgroundLuminance");
  const structureMode = input.structure?.mode;
  if (structureMode !== "single-sheet") throw new RangeError("Unsupported structure mode");

  const thicknessMm = normalizeEdgeValue(
    input.frame?.thicknessMm,
    "frame.thicknessMm",
    input.frame?.enabled !== false,
  );
  const insetMm = normalizeEdgeValue(input.frame?.insetMm, "frame.insetMm", false);
  const sides = {};
  for (const side of ["top", "right", "bottom", "left"]) sides[side] = input.frame?.sides?.[side] !== false;

  const sourceKind = input.source?.kind;
  if (sourceKind !== "none" && sourceKind !== "image") throw new RangeError("Unsupported source kind");
  const sourceMask = input.raster?.sourceMask == null ? null : cloneJson(input.raster.sourceMask);
  const baseMask = input.raster?.baseMask == null ? null : cloneJson(input.raster.baseMask);
  if (sourceMask) validateEncodedMask(sourceMask);
  if (baseMask) validateEncodedMask(baseMask);

  const bridges = (input.bridges ?? []).map((bridge, index) => normalizeProjectBridge(bridge, index));
  const profile = normalizeCuttingProfile(input.manufacturing?.profile);
  const normalized = {
    schema: PROJECT_SCHEMA,
    version: PROJECT_VERSION,
    id: nullableString(input.id, "id"),
    name: requiredString(input.name, "name"),
    units: "mm",
    sheet,
    conversion: {
      mode,
      threshold,
      invert: input.conversion.invert === true,
      backgroundLuminance,
    },
    frame: {
      enabled: input.frame?.enabled !== false,
      thicknessMm,
      insetMm,
      sides,
    },
    manufacturing: {
      kerfMm: profile.limits.kerfMm,
      minimumWebMm: profile.limits.minimumWebMm,
      minimumOpeningMm: profile.limits.minimumOpeningMm,
      maximumCantileverMm: profile.limits.maximumUnsupportedSpanMm,
      geometryInterpretation: normalizeGeometryInterpretation(
        input.manufacturing?.geometryInterpretation ?? FINISHED_BOUNDARY_CAM,
      ),
      profile,
    },
    structure: { mode: structureMode },
    source: {
      kind: sourceKind,
      name: nullableString(input.source.name, "source.name"),
      mimeType: nullableString(input.source.mimeType, "source.mimeType"),
      widthPx: nullablePositiveInteger(input.source.widthPx, "source.widthPx"),
      heightPx: nullablePositiveInteger(input.source.heightPx, "source.heightPx"),
      imageDataUrl: nullableString(input.source.imageDataUrl, "source.imageDataUrl"),
    },
    raster: { sourceMask, baseMask },
    bridges,
    editor: normalizeEditor(input.editor),
    createdAt: nullableString(input.createdAt, "createdAt"),
    updatedAt: nullableString(input.updatedAt, "updatedAt"),
  };
  return /** @type {StencilProject} */ (normalized);
}

function normalizeProjectBridge(bridge, index) {
  validateBridge(bridge);
  if ((bridge.units ?? "mm") !== "mm") throw new RangeError("Stored project bridges must use mm");
  const componentIds = Array.isArray(bridge.componentIds) && bridge.componentIds.every(
    (id) => Number.isInteger(id) && id > 0,
  ) ? [...new Set(bridge.componentIds)] : null;
  return {
    id: nullableString(bridge.id ?? null, `bridges[${index}].id`),
    type: "capsule",
    enabled: bridge.enabled !== false,
    units: "mm",
    start: { x: bridge.start.x, y: bridge.start.y },
    end: { x: bridge.end.x, y: bridge.end.y },
    width: bridge.width,
    source: bridge.source === "automatic" ? "automatic" : "manual",
    ...(typeof bridge.strategy === "string" ? { strategy: bridge.strategy } : {}),
    ...(componentIds?.length ? { componentIds } : {}),
    ...(Number.isFinite(bridge.lengthMm) ? { lengthMm: bridge.lengthMm } : {}),
    ...(Number.isFinite(bridge.addedAreaMm2) ? { addedAreaMm2: bridge.addedAreaMm2 } : {}),
    ...(Number.isFinite(bridge.aestheticScore) ? { aestheticScore: bridge.aestheticScore } : {}),
    ...(Number.isFinite(bridge.angleErrorDeg) ? { angleErrorDeg: bridge.angleErrorDeg } : {}),
    ...(Number.isFinite(bridge.detailPenalty) ? { detailPenalty: bridge.detailPenalty } : {}),
    ...(Number.isFinite(bridge.visibilityPenalty) ? { visibilityPenalty: bridge.visibilityPenalty } : {}),
    ...(Number.isFinite(bridge.featureAlignmentPenalty) ? { featureAlignmentPenalty: bridge.featureAlignmentPenalty } : {}),
    ...(Number.isFinite(bridge.portraitPenalty) ? { portraitPenalty: bridge.portraitPenalty } : {}),
    ...(bridge.followsFeatures === true ? { followsFeatures: true } : {}),
    ...(Number.isInteger(bridge.rank) && bridge.rank > 0 ? { rank: bridge.rank } : {}),
    ...(bridge.redundant === true ? { redundant: true } : {}),
    ...(bridge.fallback === true ? { fallback: true } : {}),
  };
}

function normalizeEditor(editor) {
  if (editor == null) return null;
  if (!editor || typeof editor !== "object" || Array.isArray(editor)) {
    throw new TypeError("editor must be null or an object");
  }
  const controls = editor.controls && typeof editor.controls === "object" && !Array.isArray(editor.controls)
    ? cloneJson(editor.controls)
    : {};
  const styleSettings = editor.styleSettings && typeof editor.styleSettings === "object" && !Array.isArray(editor.styleSettings)
    ? cloneJson(editor.styleSettings)
    : {};
  const normalizePaint = (values) => Array.isArray(values)
    ? values.filter((value) => Number.isInteger(value) && value >= 0)
    : [];
  const normalizeRepairLayer = (input, { nullable = false } = {}) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return nullable ? null : {
        keep: [], remove: [], enabled: true, stale: false, summary: null,
      };
    }
    return {
      keep: normalizePaint(input.keep),
      remove: normalizePaint(input.remove),
      enabled: input.enabled !== false,
      stale: input.stale === true,
      summary: input.summary && typeof input.summary === "object" && !Array.isArray(input.summary)
        ? cloneJson(input.summary)
        : null,
    };
  };
  const candidateInput = editor.candidates ?? [];
  if (!Array.isArray(candidateInput)) throw new TypeError("editor.candidates must be an array");
  if (candidateInput.length > 8) throw new RangeError("editor.candidates cannot contain more than 8 entries");
  const candidates = candidateInput.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError(`editor.candidates[${index}] must be an object`);
    }
    const baseMask = candidate.baseMask == null ? null : cloneJson(candidate.baseMask);
    if (baseMask) validateEncodedMask(baseMask);
    const candidateControls = candidate.controls && typeof candidate.controls === "object" && !Array.isArray(candidate.controls)
      ? cloneJson(candidate.controls)
      : {};
    const candidateStyleSettings = candidate.styleSettings && typeof candidate.styleSettings === "object" &&
      !Array.isArray(candidate.styleSettings) ? cloneJson(candidate.styleSettings) : {};
    const payloadVersion = candidate.payloadVersion ?? 1;
    if (!Number.isInteger(payloadVersion) || payloadVersion < 1 || payloadVersion > CANDIDATE_PAYLOAD_VERSION) {
      throw new RangeError(`Unsupported editor.candidates[${index}].payloadVersion: ${payloadVersion}`);
    }
    const geometryInput = candidate.geometry && typeof candidate.geometry === "object" &&
      !Array.isArray(candidate.geometry) ? candidate.geometry : null;
    return {
      payloadVersion,
      id: requiredString(candidate.id, `editor.candidates[${index}].id`),
      name: requiredString(candidate.name, `editor.candidates[${index}].name`),
      createdAt: nullableString(candidate.createdAt ?? null, `editor.candidates[${index}].createdAt`),
      controls: candidateControls,
      styleSettings: candidateStyleSettings,
      vectorDots: normalizeVectorDots(candidate.vectorDots),
      baseMask,
      painted: {
        keep: normalizePaint(candidate.painted?.keep),
        remove: normalizePaint(candidate.painted?.remove),
      },
      paintedFor: nullableString(candidate.paintedFor ?? null, `editor.candidates[${index}].paintedFor`),
      manufacturingRepairs: normalizeRepairLayer(candidate.manufacturingRepairs, { nullable: true }),
      bridges: (candidate.bridges ?? []).map((bridge, bridgeIndex) => (
        normalizeProjectBridge(bridge, bridgeIndex)
      )),
      geometry: geometryInput ? {
        sourceRasterKey: nullableString(
          geometryInput.sourceRasterKey ?? null,
          `editor.candidates[${index}].geometry.sourceRasterKey`,
        ),
        designFingerprint: nullableString(
          geometryInput.designFingerprint ?? null,
          `editor.candidates[${index}].geometry.designFingerprint`,
        ),
      } : null,
      thumbnail: nullableString(candidate.thumbnail ?? null, `editor.candidates[${index}].thumbnail`),
      automaticSupportsStale: candidate.automaticSupportsStale === true,
    };
  });
  const summaryInput = editor.projectSummary && typeof editor.projectSummary === "object" &&
    !Array.isArray(editor.projectSummary) ? editor.projectSummary : {};
  const status = ['draft', 'needs-validation', 'ready'].includes(summaryInput.status)
    ? summaryInput.status
    : 'draft';
  return {
    controls,
    styleSettings,
    vectorDots: normalizeVectorDots(editor.vectorDots),
    painted: {
      keep: normalizePaint(editor.painted?.keep),
      remove: normalizePaint(editor.painted?.remove),
    },
    manufacturingRepairs: normalizeRepairLayer(editor.manufacturingRepairs),
    candidates,
    selectedCandidateId: nullableString(editor.selectedCandidateId ?? null, "editor.selectedCandidateId"),
    automaticSupportsStale: editor.automaticSupportsStale === true,
    projectSummary: {
      thumbnail: nullableString(summaryInput.thumbnail ?? null, "editor.projectSummary.thumbnail"),
      cutStyle: typeof summaryInput.cutStyle === 'string' && summaryInput.cutStyle.trim()
        ? summaryInput.cutStyle
        : 'line-art',
      status,
      lastValidatedAt: nullableString(summaryInput.lastValidatedAt ?? null, "editor.projectSummary.lastValidatedAt"),
      lastExportedAt: nullableString(summaryInput.lastExportedAt ?? null, "editor.projectSummary.lastExportedAt"),
    },
  };
}

function validateEncodedMask(encoded) {
  if (!encoded || encoded.encoding !== "rle-u1") throw new RangeError("Unsupported mask encoding");
  if (!Number.isInteger(encoded.width) || encoded.width <= 0 || !Number.isInteger(encoded.height) || encoded.height <= 0) {
    throw new RangeError("Encoded mask dimensions must be positive integers");
  }
  if (encoded.startsWith !== 0 && encoded.startsWith !== 1) throw new RangeError("Encoded mask startsWith must be 0 or 1");
  if (!Array.isArray(encoded.runs) || encoded.runs.length === 0 ||
      encoded.runs.some((run) => !Number.isInteger(run) || run <= 0)) {
    throw new RangeError("Encoded mask runs must be positive integers");
  }
  const length = encoded.runs.reduce((sum, run) => sum + run, 0);
  if (length !== encoded.width * encoded.height) throw new RangeError("Encoded mask runs do not match its dimensions");
}

function normalizeEdgeValue(value, name, positiveOnly) {
  if (typeof value === "number") return positiveOnly ? positive(value, name) : nonNegative(value, name);
  if (!value || typeof value !== "object") throw new TypeError(`${name} must be a number or per-side object`);
  const output = {};
  for (const side of ["top", "right", "bottom", "left"]) {
    output[side] = positiveOnly ? positive(value[side], `${name}.${side}`) : nonNegative(value[side], `${name}.${side}`);
  }
  return output;
}

function nullablePositiveInteger(value, name) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be null or a positive integer`);
  return value;
}

function nullableString(value, name) {
  if (value == null) return null;
  if (typeof value !== "string") throw new TypeError(`${name} must be null or a string`);
  return value;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

function nonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative`);
  return value;
}

function range(value, minimum, maximum, name) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
