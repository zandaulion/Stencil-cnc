import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeConnectivity,
  applyCapsuleBridge,
  countRetained,
  createProject,
  createMask,
  encodeMask,
  validateDesign,
  validateProject,
} from "../../web/core/index.js";
import { maskFromAscii, narrowBridgeFixture } from "./fixtures.js";

test("a manual capsule bridge joins components with finite raster width", () => {
  const source = maskFromAscii([
    ".......",
    "#.....#",
    ".......",
  ]);
  const anchor = createMask(7, 3);
  anchor.data[7] = 1;
  const before = analyzeConnectivity(source, { anchorMask: anchor });
  assert.equal(before.islandCount, 1);

  const bridged = applyCapsuleBridge(source, {
    start: { x: 0.5, y: 1.5 },
    end: { x: 6.5, y: 1.5 },
    width: 1,
    units: "px",
  });
  assert.equal(countRetained(bridged), 7);
  assert.equal(analyzeConnectivity(bridged, { anchorMask: anchor }).islandCount, 0);
});

test("post-kerf validation finds a bridge that becomes disconnected", () => {
  const mask = narrowBridgeFixture();
  const validation = validateDesign(mask, {
    sheet: { widthMm: 15, heightMm: 15 },
    kerfMm: 1,
    minimumWebMm: 0,
  });

  assert.equal(validation.initial.islandCount, 0);
  assert.ok(validation.postKerf.islandCount > 0);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((entry) => entry.code === "KERF_UNSUPPORTED_COMPONENT"));
});

test("minimum-web simulation warns about a narrow structural neck", () => {
  const mask = narrowBridgeFixture();
  const validation = validateDesign(mask, {
    sheet: { widthMm: 15, heightMm: 15 },
    kerfMm: 0,
    minimumWebMm: 2,
  });

  assert.equal(validation.initial.allSupported, true);
  assert.equal(validation.valid, true);
  assert.ok(validation.warnings.some((entry) => entry.code === "MIN_WEB_DISCONNECT"));
  assert.ok(validation.metrics.thinPixelCount > 0);
});

test("cuts closer than the configured plasma gap block export", () => {
  const tooClose = maskFromAscii([
    "###########",
    "#...##...##",
    "#...##...##",
    "#...##...##",
    "###########",
  ]);
  const safe = maskFromAscii([
    "############",
    "#...###...##",
    "#...###...##",
    "#...###...##",
    "############",
  ]);
  const config = {
    sheet: { widthMm: 11, heightMm: 5 },
    minimumWebMm: 3,
    requireAnchored: false,
  };

  const blocked = validateDesign(tooClose, config);
  assert.equal(blocked.valid, false);
  assert.ok(blocked.errors.some((entry) => entry.code === "MIN_CUT_GAP"));

  const accepted = validateDesign(safe, { ...config, sheet: { widthMm: 12, heightMm: 5 } });
  assert.ok(!accepted.errors.some((entry) => entry.code === "MIN_CUT_GAP"));
});

test("one-piece validation rejects separate components even when both touch a boundary", () => {
  const mask = maskFromAscii(["#.#"]);
  const validation = validateDesign(mask, {
    sheet: { widthMm: 3, heightMm: 1 },
    anchorBoundary: true,
    requireSingleComponent: true,
  });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((entry) => entry.code === "DISCONNECTED_RETAINED_MATERIAL"));
  const selectable = validation.errors.find((entry) => entry.code === "DISCONNECTED_RETAINED_MATERIAL");
  assert.equal(typeof selectable.details.componentId, "number");
  assert.equal(typeof selectable.details.bounds.minX, "number");
  assert.equal(typeof selectable.details.bounds.maxY, "number");
});

test("minimum-opening validation rejects a removed region too small for the cutter", () => {
  const mask = maskFromAscii([
    "#####",
    "#####",
    "##.##",
    "#####",
    "#####",
  ]);
  const validation = validateDesign(mask, {
    sheet: { widthMm: 5, heightMm: 5 },
    minimumOpeningMm: 2,
    requireAnchored: false,
    requireSingleComponent: true,
  });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((entry) => entry.code === "MIN_OPENING_UNCUTTABLE"));
});

test("project validation carries the plasma minimum opening into the pipeline", () => {
  const mask = maskFromAscii([
    "#####",
    "#####",
    "##.##",
    "#####",
    "#####",
  ]);
  const project = createProject({
    sheet: { widthMm: 5, heightMm: 5 },
    frame: { enabled: false },
    raster: { sourceMask: encodeMask(mask) },
  });

  const { validation } = validateProject(project);
  assert.equal(project.manufacturing.minimumOpeningMm, 2);
  assert.ok(validation.errors.some((entry) => entry.code === "MIN_OPENING_UNCUTTABLE"));
});
