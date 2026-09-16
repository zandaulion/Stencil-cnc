import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeConnectivity,
  applyCapsuleBridge,
  countValidationLocations,
  countRetained,
  createProject,
  createMask,
  encodeMask,
  validateDesign,
  validateProject,
} from "../../web/core/index.js";
import { maskFromAscii, narrowBridgeFixture } from "./fixtures.js";

function physicalDumbbell(scale = 1) {
  const width = 16 * scale;
  const height = 9 * scale;
  const mask = createMask(width, height);
  const retain = (minX, maxX, minY, maxY) => {
    for (let y = minY * scale; y < maxY * scale; y += 1) {
      for (let x = minX * scale; x < maxX * scale; x += 1) {
        mask.data[y * width + x] = 1;
      }
    }
  };
  retain(1, 7, 1, 8);
  retain(9, 15, 1, 8);
  retain(7, 9, 4, 5);
  return mask;
}

function diagonalBlocks(scale = 1) {
  const size = 4 * scale;
  const mask = createMask(size, size);
  for (let y = 0; y < 2 * scale; y += 1) {
    for (let x = 0; x < 2 * scale; x += 1) mask.data[y * size + x] = 1;
  }
  for (let y = 2 * scale; y < size; y += 1) {
    for (let x = 2 * scale; x < size; x += 1) mask.data[y * size + x] = 1;
  }
  return mask;
}

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
  const narrowWeb = validation.warnings.find((entry) => entry.code === "MIN_WEB_DISCONNECT");
  assert.ok(narrowWeb);
  assert.equal(narrowWeb.details.componentCount, narrowWeb.details.locations.length);
  assert.match(narrowWeb.message, /relies on connections narrower than 2 mm/);
  assert.ok(validation.metrics.thinPixelCount > 0);
  const thinZones = validation.warnings.find((entry) => entry.code === "MIN_WEB_THIN_AREAS");
  assert.ok(thinZones.details.componentCount > 0);
  assert.equal(thinZones.details.componentCount, thinZones.details.locations.length);
  assert.equal(validation.thinAreaZones.groupedBy, "postKerfComponent");
});

test("a solid unanchored panel has no invented minimum-web disconnection", () => {
  const mask = createMask(100, 100, 1);
  const validation = validateDesign(mask, {
    sheet: { widthMm: 100, heightMm: 100 },
    kerfMm: 1.2,
    minimumWebMm: 3,
    minimumOpeningMm: 2,
    anchorBoundary: false,
    requireAnchored: false,
    requireSingleComponent: true,
  });

  assert.equal(validation.valid, true);
  assert.equal(validation.minimumWebCore.componentCount, 1);
  assert.equal(validation.metrics.thinPixelCount, 0);
  assert.ok(!validation.warnings.some((entry) => entry.code === "MIN_WEB_DISCONNECT"));
});

test("unanchored single-piece validation still finds cores split by a narrow neck", () => {
  const mask = narrowBridgeFixture();
  const validation = validateDesign(mask, {
    sheet: { widthMm: 15, heightMm: 15 },
    kerfMm: 0,
    minimumWebMm: 2,
    anchorBoundary: false,
    requireAnchored: false,
    requireSingleComponent: true,
  });

  assert.equal(validation.valid, true);
  assert.ok(validation.minimumWebCore.componentCount > 1);
  assert.ok(validation.warnings.some((entry) => entry.code === "MIN_WEB_DISCONNECT"));
});

test("minimum-web bottlenecks and thin-area locations stay stable across physical resolutions", () => {
  for (const scale of [1, 2, 4]) {
    const validation = validateDesign(physicalDumbbell(scale), {
      sheet: { widthMm: 16, heightMm: 9 },
      minimumWebMm: 2,
      anchorBoundary: false,
      requireAnchored: false,
      requireSingleComponent: true,
    });
    const bottleneck = validation.warnings.find((entry) => entry.code === "MIN_WEB_DISCONNECT");
    const thinArea = validation.warnings.find((entry) => entry.code === "MIN_WEB_THIN_AREAS");

    assert.equal(validation.valid, true, `scale ${scale}`);
    assert.equal(validation.minimumWebCore.componentCount, 2, `scale ${scale}`);
    assert.equal(bottleneck.details.componentCount, 1, `scale ${scale}`);
    assert.equal(bottleneck.details.locations.length, 1, `scale ${scale}`);
    assert.equal(thinArea.details.componentCount, 1, `scale ${scale}`);
    assert.equal(thinArea.details.locations.length, 1, `scale ${scale}`);
    assert.equal(countValidationLocations(validation, "warning"), 2, `scale ${scale}`);
    assert.equal(validation.thinAreaZones.groupedBy, "postKerfComponent");
  }
});

test("a design with no surviving full-width core reports one locatable structural warning", () => {
  const mask = createMask(9, 9);
  for (let y = 1; y < 8; y += 1) {
    for (let x = 3; x <= 5; x += 1) mask.data[y * mask.width + x] = 1;
  }
  const validation = validateDesign(mask, {
    sheet: { widthMm: 9, heightMm: 9 },
    minimumWebMm: 4,
    anchorBoundary: false,
    requireAnchored: false,
    requireSingleComponent: true,
  });
  const structural = validation.warnings.filter((entry) => entry.code.startsWith("MIN_WEB_"));

  assert.equal(validation.minimumWebCore.retainedPixels, 0);
  assert.equal(structural.length, 1);
  assert.equal(structural[0].code, "MIN_WEB_NO_SURVIVING_CORE");
  assert.equal(structural[0].details.phase, "thinArea");
  assert.equal(structural[0].details.componentCount, 1);
  assert.equal(structural[0].details.locations.length, 1);
  assert.equal(countValidationLocations(validation, "warning"), 1);
  assert.deepEqual(structural[0].details.bounds, {
    minX: 3, minY: 1, maxX: 5, maxY: 7, width: 3, height: 7,
  });
});

test("an explicit anchor keeps its core while a narrow-connected payload remains diagnosable", () => {
  const mask = narrowBridgeFixture();
  const anchorMask = createMask(mask.width, mask.height);
  anchorMask.data[0] = 1;
  const validation = validateDesign(mask, {
    sheet: { widthMm: 15, heightMm: 15 },
    minimumWebMm: 2,
    anchorMask,
    anchorBoundary: false,
    requireAnchored: true,
    requireSingleComponent: true,
  });
  const bottleneck = validation.warnings.find((entry) => entry.code === "MIN_WEB_DISCONNECT");

  assert.equal(validation.minimumWebCore.supportedComponents.length, 1);
  assert.equal(validation.minimumWebCore.islandCount, 1);
  assert.equal(bottleneck.details.componentCount, 1);
  assert.equal(bottleneck.details.locations[0].componentId, validation.minimumWebCore.islands[0].id);
});

test("post-kerf separation stays a grouped blocker without an external anchor", () => {
  const validation = validateDesign(narrowBridgeFixture(), {
    sheet: { widthMm: 15, heightMm: 15 },
    kerfMm: 1,
    anchorBoundary: false,
    requireAnchored: false,
    requireSingleComponent: true,
  });
  const separated = validation.errors.find((entry) => entry.code === "KERF_DISCONNECTED_RETAINED_MATERIAL");

  assert.ok(separated);
  assert.equal(separated.details.phase, "postKerf");
  assert.equal(separated.details.componentCount, validation.postKerf.componentCount - 1);
  assert.equal(separated.details.locations.length, separated.details.componentCount);
  assert.ok(separated.details.locations.every((location) => location.bounds.width > 0));
});

test("diagonal point contact remains disconnected at multiple raster resolutions", () => {
  for (const scale of [1, 2, 4]) {
    const validation = validateDesign(diagonalBlocks(scale), {
      sheet: { widthMm: 4, heightMm: 4 },
      anchorBoundary: false,
      requireAnchored: false,
      requireSingleComponent: true,
    });
    const disconnected = validation.errors.find((entry) => entry.code === "DISCONNECTED_RETAINED_MATERIAL");
    assert.equal(validation.initial.componentCount, 2, `scale ${scale}`);
    assert.equal(disconnected.details.locations.length, 1, `scale ${scale}`);
  }
});

test("solid panels remain free of structural warnings at multiple raster resolutions", () => {
  for (const [width, height] of [[50, 80], [100, 160], [200, 320]]) {
    const validation = validateDesign(createMask(width, height, 1), {
      sheet: { widthMm: 100, heightMm: 160 },
      kerfMm: 1.2,
      minimumWebMm: 3,
      anchorBoundary: false,
      requireAnchored: false,
      requireSingleComponent: true,
    });
    assert.equal(validation.valid, true, `${width}x${height}`);
    assert.ok(!validation.warnings.some((entry) => entry.code.startsWith("MIN_WEB_")), `${width}x${height}`);
  }
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
  const gap = blocked.errors.find((entry) => entry.code === "MIN_CUT_GAP");
  assert.ok(gap);
  assert.equal(gap.details.phase, "cutGap");
  assert.equal(gap.details.violationCount, 1);
  assert.equal(gap.details.locations.length, 1);
  assert.equal(typeof gap.details.bounds.minX, "number");
  assert.equal(gap.details.points.length, 2);

  const accepted = validateDesign(safe, { ...config, sheet: { widthMm: 12, heightMm: 5 } });
  assert.ok(!accepted.errors.some((entry) => entry.code === "MIN_CUT_GAP"));
});

test("all close-cut component pairs are reported together and remain locatable", () => {
  const mask = maskFromAscii([
    "#################",
    "#...##...##...###",
    "#################",
  ]);
  const validation = validateDesign(mask, {
    sheet: { widthMm: 17, heightMm: 3 },
    minimumWebMm: 3,
    requireAnchored: false,
  });
  const gap = validation.errors.find((entry) => entry.code === "MIN_CUT_GAP");

  assert.ok(gap);
  assert.equal(gap.details.violationCount, 2);
  assert.equal(gap.details.locations.length, 2);
  assert.ok(gap.details.locations.every((location) => location.points.length === 2));
  assert.match(gap.message, /2 pairs of separate cuts/);
});

test("diagonally touching cut cells are one raster cut, not a zero-gap pair", () => {
  const mask = maskFromAscii([
    "#####",
    "#.###",
    "##.##",
    "#####",
  ]);
  const validation = validateDesign(mask, {
    sheet: { widthMm: 5, heightMm: 4 },
    minimumWebMm: 3,
    requireAnchored: false,
  });

  assert.equal(validation.removed.connectivity, 8);
  assert.equal(validation.removed.componentCount, 1);
  assert.ok(!validation.errors.some((entry) => entry.code === "MIN_CUT_GAP"));
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
  assert.equal(selectable.details.locations.length, 1);
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
  const opening = validation.errors.find((entry) => entry.code === "MIN_OPENING_UNCUTTABLE");
  assert.ok(opening);
  assert.equal(opening.details.phase, "opening");
  assert.equal(opening.details.locations.length, 1);
  assert.equal(typeof opening.details.bounds.minX, "number");
  assert.ok(validation.removed.components.some((component) => component.id === opening.details.componentId));
});

test("a grouped opening error retains every individual location", () => {
  const mask = maskFromAscii([
    "#######",
    "##.#.##",
    "#######",
  ]);
  const validation = validateDesign(mask, {
    sheet: { widthMm: 7, heightMm: 3 },
    minimumOpeningMm: 2,
    requireAnchored: false,
    requireSingleComponent: true,
  });
  const opening = validation.errors.find((entry) => entry.code === "MIN_OPENING_UNCUTTABLE");

  assert.equal(opening.details.componentCount, 2);
  assert.equal(opening.details.locations.length, 2);
  assert.notEqual(opening.details.locations[0].componentId, opening.details.locations[1].componentId);
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
