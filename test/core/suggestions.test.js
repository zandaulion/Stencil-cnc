import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeConnectivity,
  applyCapsuleBridges,
  createMask,
  erodeMaskPhysical,
  suggestBridges,
} from "../../web/core/index.js";
import { maskFromAscii } from "./fixtures.js";

test("automatic suggestions deterministically bridge an island to supported material", () => {
  const mask = maskFromAscii([
    "#######",
    "#.....#",
    "#..#..#",
    "#.....#",
    "#######",
  ]);
  const config = { sheet: { widthMm: 7, heightMm: 5 }, widthMm: 1 };
  const first = suggestBridges(mask, config);
  const second = suggestBridges(mask, config);

  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].start, { x: 3.5, y: 2.5 });
  assert.deepEqual(first[0].end, { x: 3.5, y: 0.5 });
  assert.equal(first[0].lengthMm, 2);

  const bridged = applyCapsuleBridges(mask, first, config.sheet);
  assert.equal(analyzeConnectivity(bridged).islandCount, 0);
});

test("explicit anchors are honoured and alternatives are bounded per island", () => {
  const mask = maskFromAscii([
    ".###.....",
    ".........",
    ".....###.",
    ".....###.",
    ".........",
  ]);
  const anchorMask = createMask(mask.width, mask.height);
  anchorMask.data[1] = 1;
  const suggestions = suggestBridges(mask, {
    sheet: { widthMm: 9, heightMm: 5 },
    anchorMask,
    widthMm: 2,
    maxPerIsland: 2,
  });

  assert.equal(suggestions.length, 2);
  assert.ok(suggestions.every((bridge) => bridge.islandComponentId === 2));
  assert.deepEqual(suggestions.map((bridge) => bridge.rank), [1, 2]);
  assert.ok(suggestions[0].lengthMm <= suggestions[1].lengthMm);
});

test("no suggestions are emitted when everything is already supported", () => {
  const mask = maskFromAscii(["###"]);
  assert.deepEqual(suggestBridges(mask, {
    sheet: { widthMm: 3, heightMm: 1 },
    widthMm: 1,
  }), []);
});

test("one-piece suggestions join components even when every component touches a boundary", () => {
  const mask = maskFromAscii(["#...#"]);
  const suggestions = suggestBridges(mask, {
    sheet: { widthMm: 5, heightMm: 1 },
    widthMm: 1,
    anchorBoundary: true,
    requireSingleComponent: true,
  });

  assert.equal(suggestions.length, 1);
  const joined = applyCapsuleBridges(mask, suggestions, { widthMm: 5, heightMm: 1 });
  assert.equal(analyzeConnectivity(joined).componentCount, 1);
});

test("smart suggestions build one global neighbour tree instead of wiring every island to the root", () => {
  const mask = maskFromAscii(["#...#...#"]);
  const anchorMask = createMask(mask.width, mask.height);
  anchorMask.data[0] = 1;
  const suggestions = suggestBridges(mask, {
    sheet: { widthMm: 9, heightMm: 1 },
    anchorMask,
    anchorBoundary: false,
    requireSingleComponent: true,
    widthMm: 1,
    strategy: { mode: "smart", kind: "line-art", level: 2 },
  });

  assert.equal(suggestions.length, 2);
  assert.deepEqual(suggestions.map((bridge) => bridge.componentIds), [[1, 2], [2, 3]]);
  assert.ok(suggestions.every((bridge) => bridge.fallback === false));
  const joined = applyCapsuleBridges(mask, suggestions, { widthMm: 9, heightMm: 1 });
  assert.equal(analyzeConnectivity(joined, { anchorMask, anchorBoundary: false }).componentCount, 1);
});

test("the aesthetic strategy moves an equal-length tie away from protected detail", () => {
  const mask = createMask(7, 9);
  for (let y = 0; y < mask.height; y += 1) {
    mask.data[y * mask.width] = 1;
    mask.data[y * mask.width + 6] = 1;
  }
  const anchorMask = createMask(mask.width, mask.height);
  anchorMask.data[0] = 1;
  const suggestions = suggestBridges(mask, {
    sheet: { widthMm: 7, heightMm: 9 },
    anchorMask,
    widthMm: 1,
    requireSingleComponent: true,
    strategy: {
      mode: "smart",
      kind: "lamele",
      level: 2,
      preferredAngleDeg: 0,
      detailAt: ({ y }) => y < 4 ? 1 : 0,
    },
  });

  assert.equal(suggestions.length, 1);
  assert.ok(suggestions[0].start.y >= 4, "the tie should move below protected detail");
  assert.equal(suggestions[0].angleErrorDeg, 0);
  assert.equal(suggestions[0].detailPenalty, 0);
});

test("smart bridge width includes material lost to kerf", () => {
  const mask = maskFromAscii(["#...#"]);
  const suggestions = suggestBridges(mask, {
    sheet: { widthMm: 5, heightMm: 1 },
    widthMm: 1,
    minimumWebMm: 2,
    kerfMm: 1,
    requireSingleComponent: true,
    strategy: { mode: "smart", kind: "generic", level: 1 },
  });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].width, 3);
});

test("a smart bridge retains the requested full web after kerf", () => {
  const mask = createMask(21, 11);
  for (let y = 2; y <= 8; y += 1) {
    for (let x = 1; x <= 5; x += 1) mask.data[y * mask.width + x] = 1;
    for (let x = 15; x <= 19; x += 1) mask.data[y * mask.width + x] = 1;
  }
  const sheet = { widthMm: 21, heightMm: 11 };
  const suggestions = suggestBridges(mask, {
    sheet,
    widthMm: 1,
    minimumWebMm: 3,
    kerfMm: 2,
    requireSingleComponent: true,
    strategy: { mode: "smart", kind: "lamele", level: 2, preferredAngleDeg: 0 },
  });
  const bridged = applyCapsuleBridges(mask, suggestions, sheet);
  const afterKerf = erodeMaskPhysical(bridged, 1, sheet);

  assert.equal(suggestions[0].width, 5);
  assert.equal(analyzeConnectivity(afterKerf).componentCount, 1);
});

test("the secure strategy adds a separated backup tie", () => {
  const mask = createMask(9, 13);
  for (let y = 0; y < mask.height; y += 1) {
    mask.data[y * mask.width + 1] = 1;
    mask.data[y * mask.width + 7] = 1;
  }
  const suggestions = suggestBridges(mask, {
    sheet: { widthMm: 9, heightMm: 13 },
    widthMm: 1,
    requireSingleComponent: true,
    strategy: { mode: "smart", kind: "lamele", level: 3, preferredAngleDeg: 0 },
  });

  assert.equal(suggestions.length, 2);
  assert.equal(suggestions.filter((bridge) => bridge.redundant).length, 1);
  assert.notEqual(suggestions[0].start.y, suggestions[1].start.y);
});
