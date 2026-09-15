import test from "node:test";
import assert from "node:assert/strict";

import {
  PROJECT_SCHEMA,
  PROJECT_VERSION,
  createProject,
  decodeMask,
  deserializeProject,
  encodeMask,
  projectWithSourceMask,
  serializeProject,
} from "../../web/core/index.js";
import { maskFromAscii } from "./fixtures.js";

test("a new project uses the standard CNC panel size", () => {
  assert.deepEqual(createProject().sheet, { widthMm: 1250, heightMm: 2500 });
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
  assert.equal(migrated.version, 1);
  assert.deepEqual(migrated.sheet, { widthMm: 200, heightMm: 120 });
  assert.equal(migrated.conversion.threshold, 90);
  assert.equal(migrated.conversion.invert, true);
  assert.equal(migrated.manufacturing.minimumOpeningMm, 2);

  assert.throws(
    () => deserializeProject(JSON.stringify({ schema: PROJECT_SCHEMA, version: PROJECT_VERSION + 1 })),
    /newer than supported/,
  );
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
  assert.equal(restored.editor.selectedCandidateId, "candidate-a");
  assert.equal(serializeProject(project).includes("private.jpg"), true);
  assert.equal(serializeProject(project).includes("localSource"), false);
});
