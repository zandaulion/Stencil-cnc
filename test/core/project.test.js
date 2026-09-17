import test from "node:test";
import assert from "node:assert/strict";

import {
  CANDIDATE_PAYLOAD_VERSION,
  FINISHED_BOUNDARY_CAM,
  LEGACY_UNCOMPENSATED_CENTERLINE,
  PROJECT_SCHEMA,
  PROJECT_VERSION,
  applyRasterLayers,
  buildDesignMask,
  createCuttingProfile,
  createProject,
  decodeMask,
  deserializeProject,
  encodeMask,
  maskFingerprint,
  projectWithSourceMask,
  serializeProject,
} from "../../web/core/index.js";
import { maskFromAscii } from "./fixtures.js";

test("a new project uses the standard CNC panel size", () => {
  const project = createProject();
  assert.deepEqual(project.sheet, { widthMm: 1250, heightMm: 2500 });
  assert.equal(project.manufacturing.geometryInterpretation, FINISHED_BOUNDARY_CAM);
  assert.equal(project.manufacturing.profile.status, 'provisional');
  assert.equal(project.manufacturing.profile.revision, 1);
  assert.equal(project.manufacturing.profile.limits.minimumWebMm, project.manufacturing.minimumWebMm);
});

test("binary masks use deterministic serializable run-length encoding", () => {
  const mask = maskFromAscii([
    "##..",
    ".###",
  ]);
  const encoded = encodeMask(mask);
  assert.deepEqual(encoded, {
    encoding: "rle-u1",
    width: 4,
    height: 2,
    startsWith: 1,
    runs: [2, 3, 3],
  });
  assert.deepEqual([...decodeMask(encoded).data], [...mask.data]);
});

test("a versioned project round-trips without typed-array leakage", () => {
  const sourceMask = maskFromAscii(["#.#"]);
  let project = createProject({
    id: "fixture",
    name: "Fixture",
    sheet: { widthMm: 300, heightMm: 100 },
    bridges: [{
      id: "bridge-1",
      type: "capsule",
      enabled: true,
      units: "mm",
      start: { x: 10, y: 20 },
      end: { x: 30, y: 20 },
      width: 4,
      source: "automatic",
      strategy: "lamele",
      componentIds: [1, 2],
      lengthMm: 20,
      addedAreaMm2: 80,
      aestheticScore: 84,
      angleErrorDeg: 2,
      detailPenalty: 0.1,
      visibilityPenalty: 0.2,
      featureAlignmentPenalty: 0.05,
      portraitPenalty: 0.4,
      followsFeatures: true,
      rank: 1,
      fallback: true,
    }],
  });
  project = projectWithSourceMask(project, sourceMask);
  const serialized = serializeProject(project);
  const restored = deserializeProject(serialized);

  assert.equal(restored.schema, PROJECT_SCHEMA);
  assert.equal(restored.version, PROJECT_VERSION);
  assert.equal(serializeProject(restored), serialized);
  assert.deepEqual([...decodeMask(restored.raster.sourceMask).data], [1, 0, 1]);
  assert.equal(restored.manufacturing.minimumOpeningMm, 2);
  assert.deepEqual(restored.bridges[0].componentIds, [1, 2]);
  assert.equal(restored.bridges[0].strategy, "lamele");
  assert.equal(restored.bridges[0].fallback, true);
  assert.equal(restored.bridges[0].visibilityPenalty, 0.2);
  assert.equal(restored.bridges[0].featureAlignmentPenalty, 0.05);
  assert.equal(restored.bridges[0].portraitPenalty, 0.4);
  assert.equal(restored.bridges[0].followsFeatures, true);
});

test("projects retain an exact cutting-profile snapshot instead of a preset name", () => {
  const profile = createCuttingProfile({
    id: null,
    name: 'Table A · S235 2 mm',
    revision: 7,
    status: 'verified',
    material: { name: 'Mild steel', grade: 'S235', thicknessMm: 2 },
    machine: { name: 'Table A', consumable: '45 A fine-cut' },
    limits: {
      kerfMm: 1.05,
      minimumWebMm: 2.6,
      minimumOpeningMm: 2.2,
      supportWidthMm: 5.5,
      maximumUnsupportedSpanMm: 220,
    },
    provenance: {
      kind: 'shop-test',
      note: 'Coupon KF-17',
      verifiedBy: 'Workshop owner',
      verifiedAt: '2026-09-17T10:00:00.000Z',
    },
  });
  const project = createProject({ manufacturing: { profile } });
  profile.limits.minimumWebMm = 99;

  const restored = deserializeProject(serializeProject(project));

  assert.equal(restored.manufacturing.profile.revision, 7);
  assert.equal(restored.manufacturing.profile.status, 'verified');
  assert.equal(restored.manufacturing.profile.limits.minimumWebMm, 2.6);
  assert.equal(restored.manufacturing.minimumWebMm, 2.6);
  assert.equal(restored.manufacturing.maximumCantileverMm, 220);
});

test("draft version 0 projects migrate and future versions fail safely", () => {
  const migrated = deserializeProject(JSON.stringify({
    version: 0,
    name: "Old draft",
    widthMm: 200,
    heightMm: 120,
    threshold: 90,
    invert: true,
  }));
  assert.equal(migrated.version, PROJECT_VERSION);
  assert.deepEqual(migrated.sheet, { widthMm: 200, heightMm: 120 });
  assert.equal(migrated.conversion.threshold, 90);
  assert.equal(migrated.conversion.invert, true);
  assert.equal(migrated.manufacturing.minimumOpeningMm, 2);
  assert.equal(migrated.manufacturing.geometryInterpretation, LEGACY_UNCOMPENSATED_CENTERLINE);

  assert.throws(
    () => deserializeProject(JSON.stringify({ schema: PROJECT_SCHEMA, version: PROJECT_VERSION + 1 })),
    /newer than supported/,
  );
});

test("version 1 projects migrate without inventing candidate repair layers", () => {
  const current = createProject({
    editor: {
      controls: {},
      candidates: [{
        id: "legacy-candidate",
        name: "Legacy portrait",
        createdAt: null,
        controls: { cutStyle: "lamele" },
        baseMask: encodeMask(maskFromAscii(["#."])),
        painted: { keep: [], remove: [] },
        bridges: [],
      }],
    },
  });
  const migrated = deserializeProject(JSON.stringify({ ...current, version: 1 }));

  assert.equal(migrated.version, PROJECT_VERSION);
  assert.equal(migrated.editor.candidates[0].payloadVersion, 1);
  assert.equal(migrated.editor.candidates[0].manufacturingRepairs, null);
  assert.equal(migrated.editor.candidates[0].geometry, null);
  assert.equal(migrated.manufacturing.geometryInterpretation, LEGACY_UNCOMPENSATED_CENTERLINE);
});

test("version 2 projects preserve legacy kerf meaning and invalidate stale readiness", () => {
  const current = createProject({
    raster: { sourceMask: encodeMask(maskFromAscii(["##"])) },
    editor: {
      controls: {},
      candidates: [],
      projectSummary: {
        status: "ready",
        lastValidatedAt: "2026-09-15T10:00:00.000Z",
      },
    },
  });
  const legacy = JSON.parse(JSON.stringify(current));
  legacy.version = 2;
  delete legacy.manufacturing.geometryInterpretation;
  const migrated = deserializeProject(JSON.stringify(legacy));

  assert.equal(migrated.version, PROJECT_VERSION);
  assert.equal(migrated.manufacturing.geometryInterpretation, LEGACY_UNCOMPENSATED_CENTERLINE);
  assert.equal(migrated.editor.projectSummary.status, "needs-validation");
  assert.equal(migrated.editor.projectSummary.lastValidatedAt, null);
  assert.deepEqual([...decodeMask(migrated.raster.sourceMask).data], [1, 1]);
});

test("version 3 projects migrate as raster-only until Variable Dots are rendered again", () => {
  const legacy = createProject();
  legacy.version = 3;
  const migrated = deserializeProject(JSON.stringify(legacy));

  assert.equal(migrated.version, PROJECT_VERSION);
  assert.equal(migrated.editor, null);
});

test("version 4 projects preserve manufacturing values as a legacy provisional profile", () => {
  const current = createProject({
    raster: { sourceMask: encodeMask(maskFromAscii(["#.#"])) },
    editor: {
      controls: { 'measurement-unit': 'in', 'bridge-width': '0.25' },
      candidates: [],
      projectSummary: {
        status: 'ready',
        lastValidatedAt: '2026-09-17T09:00:00.000Z',
      },
    },
  });
  const legacy = JSON.parse(JSON.stringify(current));
  legacy.version = 4;
  legacy.manufacturing = {
    kerfMm: 0.9,
    minimumWebMm: 2.4,
    minimumOpeningMm: 1.8,
    maximumCantileverMm: 180,
    geometryInterpretation: FINISHED_BOUNDARY_CAM,
  };

  const migrated = deserializeProject(JSON.stringify(legacy));

  assert.equal(migrated.version, PROJECT_VERSION);
  assert.equal(migrated.manufacturing.profile.name, 'Legacy project settings');
  assert.equal(migrated.manufacturing.profile.status, 'provisional');
  assert.equal(migrated.manufacturing.profile.provenance.kind, 'legacy-project');
  assert.equal(migrated.manufacturing.profile.limits.kerfMm, 0.9);
  assert.equal(migrated.manufacturing.profile.limits.minimumWebMm, 2.4);
  assert.equal(migrated.manufacturing.profile.limits.minimumOpeningMm, 1.8);
  assert.equal(migrated.manufacturing.profile.limits.supportWidthMm, 6.35);
  assert.equal(migrated.manufacturing.profile.limits.maximumUnsupportedSpanMm, 180);
  assert.deepEqual([...decodeMask(migrated.raster.sourceMask).data], [1, 0, 1]);
  assert.equal(migrated.editor.projectSummary.status, 'needs-validation');
  assert.equal(migrated.editor.projectSummary.lastValidatedAt, null);
});

test("portable project files never include the browser-local source photograph", () => {
  const project = {
    ...createProject(),
    localSource: new Blob(["private-photo-bytes"], { type: "image/jpeg" }),
  };
  const serialized = serializeProject(project);
  assert.doesNotMatch(serialized, /localSource|private-photo-bytes/);
});

test("manufacturing repair intent round-trips as a removable editor layer", () => {
  const project = createProject({
    editor: {
      controls: {},
      styleSettings: {},
      painted: { keep: [1], remove: [] },
      manufacturingRepairs: {
        keep: [2, 3],
        remove: [4],
        enabled: false,
        stale: true,
        summary: { strategy: "balanced", supportCount: 2 },
      },
      candidates: [],
    },
  });
  const restored = deserializeProject(serializeProject(project));

  assert.deepEqual(restored.editor.manufacturingRepairs, {
    keep: [2, 3],
    remove: [4],
    enabled: false,
    stale: true,
    summary: { strategy: "balanced", supportCount: 2 },
  });
});

test("creative candidates round-trip as processed recipes without source photographs", () => {
  const candidateMask = maskFromAscii([
    "##.",
    ".#.",
  ]);
  const project = createProject({
    name: "Candidates",
    source: { kind: "image", name: "private.jpg", widthPx: 3, heightPx: 2 },
    editor: {
      controls: { cutStyle: "grafic" },
      styleSettings: {
        lamele: { 'style-gain': '3', 'style-cutout': true, polarity: 'black-retained' },
      },
      painted: { keep: [], remove: [] },
      selectedCandidateId: "candidate-a",
      candidates: [{
        id: "candidate-a",
        name: "Graphic portrait 1",
        createdAt: "2026-09-14T00:00:00.000Z",
        controls: { cutStyle: "grafic", styleGraphicDetail: "65" },
        baseMask: encodeMask(candidateMask),
        painted: { keep: [1], remove: [4] },
        bridges: [],
        thumbnail: "data:image/png;base64,processed-only",
        automaticSupportsStale: false,
      }],
    },
  });

  const restored = deserializeProject(serializeProject(project));
  assert.equal(restored.editor.candidates.length, 1);
  assert.deepEqual(restored.editor.styleSettings.lamele, {
    'style-gain': '3', 'style-cutout': true, polarity: 'black-retained',
  });
  assert.equal(restored.editor.candidates[0].name, "Graphic portrait 1");
  assert.deepEqual(restored.editor.candidates[0].painted, { keep: [1], remove: [4] });
  assert.equal(restored.editor.candidates[0].payloadVersion, 1);
  assert.equal(restored.editor.candidates[0].manufacturingRepairs, null);
  assert.equal(restored.editor.candidates[0].geometry, null);
  assert.equal(restored.editor.selectedCandidateId, "candidate-a");
  assert.equal(serializeProject(project).includes("private.jpg"), true);
  assert.equal(serializeProject(project).includes("localSource"), false);
});

test("versioned candidates preserve repair layers and reproduce final geometry", () => {
  const baseMask = maskFromAscii([
    "##..",
    ".##.",
    "....",
  ]);
  const layers = {
    painted: { keep: [2], remove: [5] },
    manufacturingRepairs: {
      keep: [8, 9],
      remove: [0],
      enabled: true,
      stale: false,
      summary: { strategy: "balanced", repairCount: 3 },
    },
  };
  const bridges = [{
    id: "bridge-a",
    start: { x: 1, y: 1 },
    end: { x: 3, y: 1 },
    width: 3,
    enabled: true,
    source: "manual",
  }];
  const sheet = { widthMm: 40, heightMm: 30 };
  const visibleSource = applyRasterLayers(baseMask, layers);
  const originalDesign = buildDesignMask(visibleSource, {
    sheet,
    frame: { enabled: false },
    bridges,
  }).mask;
  const signature = maskFingerprint(originalDesign);
  const project = createProject({
    sheet,
    editor: {
      controls: {},
      candidates: [{
        payloadVersion: CANDIDATE_PAYLOAD_VERSION,
        id: "candidate-repaired",
        name: "Repaired portrait",
        createdAt: "2026-09-16T13:00:00.000Z",
        controls: { cutStyle: "lamele" },
        styleSettings: { lamele: { "style-gain": "3.2" } },
        baseMask: encodeMask(baseMask),
        painted: layers.painted,
        paintedFor: "4x3",
        manufacturingRepairs: layers.manufacturingRepairs,
        bridges,
        geometry: {
          sourceRasterKey: "4x3",
          designFingerprint: signature,
        },
        thumbnail: "data:image/png;base64,repaired",
        automaticSupportsStale: false,
      }],
    },
  });

  const candidate = deserializeProject(serializeProject(project)).editor.candidates[0];
  const restoredSource = applyRasterLayers(decodeMask(candidate.baseMask), {
    painted: candidate.painted,
    manufacturingRepairs: candidate.manufacturingRepairs,
  });
  const restoredDesign = buildDesignMask(restoredSource, {
    sheet,
    frame: { enabled: false },
    bridges: candidate.bridges,
  }).mask;

  assert.equal(candidate.payloadVersion, CANDIDATE_PAYLOAD_VERSION);
  assert.deepEqual(candidate.styleSettings, { lamele: { "style-gain": "3.2" } });
  assert.equal(candidate.paintedFor, "4x3");
  assert.deepEqual(candidate.manufacturingRepairs, layers.manufacturingRepairs);
  assert.equal(candidate.geometry.designFingerprint, signature);
  assert.deepEqual([...restoredDesign.data], [...originalDesign.data]);
  assert.equal(maskFingerprint(restoredDesign), signature);
});

test("project-library summary data round-trips with the editable project", () => {
  const project = createProject({
    editor: {
      controls: { cutStyle: 'lamele' },
      projectSummary: {
        thumbnail: 'data:image/png;base64,preview',
        cutStyle: 'lamele',
        status: 'ready',
        lastValidatedAt: '2026-09-15T10:00:00.000Z',
        lastExportedAt: '2026-09-15T10:05:00.000Z',
      },
    },
  });

  const restored = deserializeProject(serializeProject(project));
  assert.deepEqual(restored.editor.projectSummary, {
    thumbnail: 'data:image/png;base64,preview',
    cutStyle: 'lamele',
    status: 'ready',
    lastValidatedAt: '2026-09-15T10:00:00.000Z',
    lastExportedAt: '2026-09-15T10:05:00.000Z',
  });
});

test("exact Variable Dot primitives survive project and candidate round-trips", () => {
  const vectorDots = {
    version: 1,
    coordinateSpace: 'normalized-source',
    radiusSpace: 'normalized-source-width',
    circles: [[0.25, 0.5, 0.0125], [0.75, 0.5, 0.025]],
  };
  const project = createProject({
    editor: {
      controls: { cutStyle: 'puncte' },
      vectorDots,
      candidates: [{
        payloadVersion: CANDIDATE_PAYLOAD_VERSION,
        id: 'dots-candidate',
        name: 'Exact dots',
        controls: { cutStyle: 'puncte' },
        vectorDots,
      }],
    },
  });

  const restored = deserializeProject(serializeProject(project));
  assert.deepEqual(restored.editor.vectorDots, vectorDots);
  assert.deepEqual(restored.editor.candidates[0].vectorDots, vectorDots);
});
