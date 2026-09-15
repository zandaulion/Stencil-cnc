import { assertMask, createMask } from "./mask.js";
import { validateBridge } from "./bridges.js";

export const PROJECT_SCHEMA = "stencil-cnc.project";
export const PROJECT_VERSION = 1;

/**
 * @typedef {object} StencilProject
 * @property {'stencil-cnc.project'} schema
 * @property {1} version
 * @property {string | null} id
 * @property {string} name
 * @property {'mm'} units
 * @property {{widthMm:number,heightMm:number}} sheet
 * @property {{mode:'line-art'|'photograph',threshold:number,invert:boolean,backgroundLuminance:number}} conversion
 * @property {{enabled:boolean,thicknessMm:number|object,insetMm:number|object,sides:{top:boolean,right:boolean,bottom:boolean,left:boolean}}} frame
 * @property {{kerfMm:number,minimumWebMm:number,minimumOpeningMm:number,maximumCantileverMm:number|null}} manufacturing
 * @property {{mode:'single-sheet'}} structure
 * @property {{kind:'none'|'image',name:string|null,mimeType:string|null,widthPx:number|null,heightPx:number|null,imageDataUrl:string|null}} source
 * @property {{sourceMask:EncodedMask|null,baseMask:EncodedMask|null}} raster
 * @property {Array<object>} bridges
 * @property {{controls:Record<string,unknown>,styleSettings:Record<string,Record<string,unknown>>,painted:{keep:number[],remove:number[]},manufacturingRepairs:{keep:number[],remove:number[],enabled:boolean,stale:boolean,summary:object|null},candidates:Array<object>,selectedCandidateId:string|null,automaticSupportsStale:boolean}|null} editor
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
  manufacturing: { kerfMm: 0, minimumWebMm: 3, minimumOpeningMm: 2, maximumCantileverMm: null },
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
    manufacturing: { ...DEFAULT_PROJECT.manufacturing, ...overrides.manufacturing },
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
    });
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
      kerfMm: nonNegative(input.manufacturing?.kerfMm ?? DEFAULT_PROJECT.manufacturing.kerfMm, "manufacturing.kerfMm"),
      minimumWebMm: nonNegative(input.manufacturing?.minimumWebMm ?? DEFAULT_PROJECT.manufacturing.minimumWebMm, "manufacturing.minimumWebMm"),
      minimumOpeningMm: nonNegative(
        input.manufacturing?.minimumOpeningMm ?? DEFAULT_PROJECT.manufacturing.minimumOpeningMm,
        "manufacturing.minimumOpeningMm",
      ),
      maximumCantileverMm: input.manufacturing?.maximumCantileverMm == null
        ? null
        : nonNegative(input.manufacturing.maximumCantileverMm, "manufacturing.maximumCantileverMm"),
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
    return {
      id: requiredString(candidate.id, `editor.candidates[${index}].id`),
      name: requiredString(candidate.name, `editor.candidates[${index}].name`),
      createdAt: nullableString(candidate.createdAt ?? null, `editor.candidates[${index}].createdAt`),
      controls: candidateControls,
      baseMask,
      painted: {
        keep: normalizePaint(candidate.painted?.keep),
        remove: normalizePaint(candidate.painted?.remove),
      },
      bridges: (candidate.bridges ?? []).map((bridge, bridgeIndex) => (
        normalizeProjectBridge(bridge, bridgeIndex)
      )),
      thumbnail: nullableString(candidate.thumbnail ?? null, `editor.candidates[${index}].thumbnail`),
      automaticSupportsStale: candidate.automaticSupportsStale === true,
    };
  });
  return {
    controls,
    styleSettings,
    painted: {
      keep: normalizePaint(editor.painted?.keep),
      remove: normalizePaint(editor.painted?.remove),
    },
    manufacturingRepairs: {
      keep: normalizePaint(editor.manufacturingRepairs?.keep),
      remove: normalizePaint(editor.manufacturingRepairs?.remove),
      enabled: editor.manufacturingRepairs?.enabled !== false,
      stale: editor.manufacturingRepairs?.stale === true,
      summary: editor.manufacturingRepairs?.summary &&
        typeof editor.manufacturingRepairs.summary === "object" &&
        !Array.isArray(editor.manufacturingRepairs.summary)
        ? cloneJson(editor.manufacturingRepairs.summary)
        : null,
    },
    candidates,
    selectedCandidateId: nullableString(editor.selectedCandidateId ?? null, "editor.selectedCandidateId"),
    automaticSupportsStale: editor.automaticSupportsStale === true,
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
