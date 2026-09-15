import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeConnectivity,
  applyCapsuleBridges,
  createMask,
  erodeMaskPhysical,
  suggestBridges,
  suggestKerfAwareBridges,
} from "../../web/core/index.js";
import { maskFromAscii, narrowBridgeFixture } from "./fixtures.js";

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

test("follow-features planning moves an equal bridge out of bright image areas", () => {
  const mask = createMask(7, 11);
  for (let y = 0; y < mask.height; y += 1) {
    mask.data[y * mask.width] = 1;
    mask.data[y * mask.width + 6] = 1;
  }
  const anchorMask = createMask(mask.width, mask.height);
  anchorMask.data[0] = 1;
  const suggestions = suggestBridges(mask, {
    sheet: { widthMm: 7, heightMm: 11 },
    anchorMask,
    widthMm: 1,
    requireSingleComponent: true,
    strategy: {
      mode: "smart",
      kind: "lamele",
      level: 2,
      preferredAngleDeg: 0,
      detailAt: null,
      featureAt: ({ y }) => ({
        lightness: y < 6 ? 1 : 0,
        strength: 0,
        tangentAngleDeg: 0,
      }),
    },
  });

  assert.equal(suggestions.length, 1);
  assert.ok(suggestions[0].start.y >= 6, "the bridge should hide in the dark half");
  assert.equal(suggestions[0].visibilityPenalty, 0);
  assert.equal(suggestions[0].followsFeatures, true);
});

test("follow-features planning aligns ties with a strong local feature when possible", () => {
  const mask = createMask(9, 9);
  for (let y = 0; y < mask.height; y += 1) {
    mask.data[y * mask.width] = 1;
    mask.data[y * mask.width + 8] = 1;
  }
  const anchorMask = createMask(mask.width, mask.height);
  anchorMask.data[0] = 1;
  const suggestions = suggestBridges(mask, {
    sheet: { widthMm: 9, heightMm: 9 },
    anchorMask,
    widthMm: 1,
    requireSingleComponent: true,
    strategy: {
      mode: "smart",
      kind: "generic",
      level: 2,
      featureAt: ({ y }) => ({
        lightness: 0.2,
        strength: y < 4 ? 1 : 0,
        tangentAngleDeg: y < 4 ? 90 : 0,
      }),
    },
  });

  assert.equal(suggestions.length, 1);
  assert.ok(suggestions[0].start.y >= 4, "the bridge should avoid crossing the misaligned feature");
  assert.equal(suggestions[0].featureAlignmentPenalty, 0);
});

test("follow-features planning prefers dark hair over an equally dark central face feature", () => {
  const mask = createMask(7, 11);
  for (let y = 0; y < mask.height; y += 1) {
    mask.data[y * mask.width] = 1;
    mask.data[y * mask.width + 6] = 1;
  }
  const anchorMask = createMask(mask.width, mask.height);
  anchorMask.data[0] = 1;
  const suggestions = suggestBridges(mask, {
    sheet: { widthMm: 7, heightMm: 11 },
    anchorMask,
    widthMm: 1,
    requireSingleComponent: true,
    strategy: {
      mode: "smart",
      kind: "lamele",
      level: 2,
      preferredAngleDeg: 0,
      featureAt: ({ y }) => ({
        lightness: 0.2,
        strength: 1,
        tangentAngleDeg: 0,
        portraitRisk: y >= 3 && y <= 7 ? 1 : 0,
      }),
    },
  });

  assert.equal(suggestions.length, 1);
  assert.ok(suggestions[0].start.y < 3 || suggestions[0].start.y > 7);
  assert.equal(suggestions[0].portraitPenalty, 0);
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
    strategy: {
      mode: "smart",
      kind: "lamele",
      level: 2,
      preferredAngleDeg: 0,
      detailAt: null,
      featureAt: null,
    },
  });
  const bridged = applyCapsuleBridges(mask, suggestions, sheet);
  const afterKerf = erodeMaskPhysical(bridged, 1, sheet);

  assert.equal(suggestions[0].width, 5);
  assert.equal(analyzeConnectivity(afterKerf).componentCount, 1);
});

test("kerf-aware suggestions repair a neck that is connected only before cutting", () => {
  const mask = narrowBridgeFixture();
  const sheet = { widthMm: 15, heightMm: 15 };
  assert.equal(analyzeConnectivity(mask).componentCount, 1);
  assert.ok(analyzeConnectivity(erodeMaskPhysical(mask, 0.5, sheet)).componentCount > 1);

  const repair = suggestKerfAwareBridges(mask, {
    sheet,
    widthMm: 1,
    minimumWebMm: 2,
    kerfMm: 1,
    requireSingleComponent: true,
    strategy: { mode: "smart", kind: "generic", level: 2 },
  });
  const repaired = applyCapsuleBridges(mask, repair.bridges, sheet);
  const afterKerf = erodeMaskPhysical(repaired, 0.5, sheet);

  assert.ok(repair.bridges.length > 0);
  assert.equal(repair.initialComponentCount, 2);
  assert.equal(repair.finalComponentCount, 1);
  assert.equal(repair.complete, true);
  assert.ok(repair.bridges.every((bridge) => bridge.repairPhase === "postKerf"));
  assert.equal(analyzeConnectivity(afterKerf).componentCount, 1);
});

test("manufacturing repair can target full minimum-web connectivity", () => {
  const mask = narrowBridgeFixture();
  const sheet = { widthMm: 15, heightMm: 15 };
  const repair = suggestKerfAwareBridges(mask, {
    sheet,
    widthMm: 1,
    minimumWebMm: 2,
    kerfMm: 0,
    targetMinimumWebConnectivity: true,
    requireSingleComponent: true,
    strategy: { mode: "smart", kind: "generic", level: 2 },
  });
  const repaired = applyCapsuleBridges(mask, repair.bridges, sheet);
  const fullWidthCore = erodeMaskPhysical(repaired, 1, sheet);

  assert.ok(repair.initialComponentCount > 1);
  assert.ok(repair.bridges.length > 0);
  assert.equal(repair.complete, true);
  assert.equal(analyzeConnectivity(fullWidthCore).componentCount, 1);
});

test("kerf-aware repair stops at its explicit bridge budget", () => {
  const mask = createMask(25, 7);
  for (const x of [1, 5, 9, 13, 17, 21]) {
    for (let y = 1; y < 6; y += 1) mask.data[y * mask.width + x] = 1;
  }
  const repair = suggestKerfAwareBridges(mask, {
    sheet: { widthMm: 25, heightMm: 7 },
    widthMm: 1,
    kerfMm: 0,
    minimumWebMm: 0,
    requireSingleComponent: true,
    maximumBridges: 2,
    strategy: { mode: "smart", kind: "generic", level: 1 },
  });

  assert.equal(repair.bridges.length, 2);
  assert.equal(repair.capped, true);
  assert.equal(repair.complete, false);
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

test("connected slats receive staggered stabilizers at the requested span", () => {
  const mask = createMask(21, 21);
  const anchorMask = createMask(21, 21);
  for (const x of [1, 5, 9, 13, 17]) {
    for (let y = 0; y < mask.height; y += 1) mask.data[y * mask.width + x] = 1;
  }
  for (let x = 0; x < mask.width; x += 1) {
    mask.data[x] = 1;
    mask.data[(mask.height - 1) * mask.width + x] = 1;
    anchorMask.data[x] = 1;
    anchorMask.data[(mask.height - 1) * mask.width + x] = 1;
  }
  const config = {
    sheet: { widthMm: 21, heightMm: 21 },
    anchorMask,
    widthMm: 2,
    minimumWebMm: 1,
    kerfMm: 0,
    requireSingleComponent: true,
    strategy: {
      mode: "smart",
      kind: "lamele",
      level: 2,
      preferredAngleDeg: 0,
      barAngleDeg: 90,
      slatPitchMm: 4,
      maximumUnsupportedSpanMm: 6,
      organicVariation: 0,
      detailAt: null,
      featureAt: null,
    },
  };
  const first = suggestBridges(mask, config);
  const second = suggestBridges(mask, config);

  assert.deepEqual(first, second, "stabilizer placement must be deterministic");
  assert.ok(first.length >= 4);
  assert.ok(first.every((bridge) => bridge.stabilizer && bridge.role === "stabilizer"));
  assert.ok(first.every((bridge) => Math.abs(bridge.start.y - bridge.end.y) <= 1.1),
    "ties should be perpendicular to the vertical slats");
  const stations = [...new Set(first.map((bridge) => bridge.stationMm))].sort((a, b) => a - b);
  const supportedPositions = [1.5, ...stations, 19.5];
  for (let index = 1; index < supportedPositions.length; index += 1) {
    assert.ok(supportedPositions[index] - supportedPositions[index - 1] <= 6 + 1e-9);
  }
  for (const station of stations) {
    const endpoints = first
      .filter((bridge) => bridge.stationMm === station)
      .flatMap((bridge) => [bridge.start.x, bridge.end.x]);
    for (const slatCenter of [1.5, 5.5, 9.5, 13.5, 17.5]) {
      assert.ok(endpoints.some((x) => Math.abs(x - slatCenter) <= 1.1),
        `slat at ${slatCenter} must be braced at station ${station}`);
    }
  }
});

test("slat stabilizers also move into dark feature bands", () => {
  const mask = createMask(21, 21);
  const anchorMask = createMask(21, 21);
  for (const x of [1, 5, 9, 13, 17]) {
    for (let y = 0; y < mask.height; y += 1) mask.data[y * mask.width + x] = 1;
  }
  for (let x = 0; x < mask.width; x += 1) {
    mask.data[x] = 1;
    mask.data[(mask.height - 1) * mask.width + x] = 1;
    anchorMask.data[x] = 1;
    anchorMask.data[(mask.height - 1) * mask.width + x] = 1;
  }
  const suggestions = suggestBridges(mask, {
    sheet: { widthMm: 21, heightMm: 21 },
    anchorMask,
    widthMm: 2,
    minimumWebMm: 1,
    kerfMm: 0,
    requireSingleComponent: true,
    strategy: {
      mode: "smart",
      kind: "lamele",
      level: 2,
      preferredAngleDeg: 0,
      barAngleDeg: 90,
      slatPitchMm: 4,
      maximumUnsupportedSpanMm: 8,
      organicVariation: 1,
      featureAt: ({ y }) => ({ lightness: y < 7 ? 1 : 0, strength: 0, tangentAngleDeg: 0 }),
    },
  });

  assert.ok(suggestions.length > 0);
  assert.ok(suggestions.every((bridge) => bridge.stabilizer && bridge.followsFeatures));
  assert.ok(suggestions.every((bridge) => bridge.visibilityPenalty === 0),
    "every feasible stabilizer should avoid the bright band");
  assert.ok(suggestions.every((bridge) => bridge.stationMm >= 7));
});

test("feature-aware slats add a second sparse station rather than crossing a bright face", () => {
  const mask = createMask(21, 21);
  const anchorMask = createMask(21, 21);
  for (const x of [1, 5, 9, 13, 17]) {
    for (let y = 0; y < mask.height; y += 1) mask.data[y * mask.width + x] = 1;
  }
  for (let x = 0; x < mask.width; x += 1) {
    mask.data[x] = 1;
    mask.data[(mask.height - 1) * mask.width + x] = 1;
    anchorMask.data[x] = 1;
    anchorMask.data[(mask.height - 1) * mask.width + x] = 1;
  }
  const suggestions = suggestBridges(mask, {
    sheet: { widthMm: 21, heightMm: 21 },
    anchorMask,
    widthMm: 2,
    minimumWebMm: 1,
    kerfMm: 0,
    requireSingleComponent: true,
    strategy: {
      mode: "smart",
      kind: "lamele",
      level: 2,
      preferredAngleDeg: 0,
      barAngleDeg: 90,
      slatPitchMm: 4,
      maximumUnsupportedSpanMm: 11,
      organicVariation: 0,
      featureAt: ({ y }) => ({
        lightness: y >= 7 && y <= 14 ? 1 : 0,
        strength: 0,
        tangentAngleDeg: 0,
        portraitRisk: y >= 7 && y <= 14 ? 1 : 0,
      }),
    },
  });

  const stations = [...new Set(suggestions.map((bridge) => bridge.stationMm))];
  assert.ok(stations.length >= 2, "a second sparse row creates room to avoid the face");
  assert.ok(suggestions.every((bridge) => bridge.stationMm < 7 || bridge.stationMm > 14));
  assert.ok(suggestions.every((bridge) => bridge.portraitPenalty === 0));
  for (const slatCenter of [1.5, 5.5, 9.5, 13.5, 17.5]) {
    const positions = [1.5, 19.5, ...suggestions.flatMap((bridge) => [bridge.start, bridge.end])
      .filter((point) => Math.abs(point.x - slatCenter) <= 1.1)
      .map((point) => point.y)].sort((a, b) => a - b);
    for (let index = 1; index < positions.length; index += 1) {
      assert.ok(positions[index] - positions[index - 1] <= 11 + 1e-9,
        `slat at ${slatCenter} must still respect its maximum span`);
    }
  }
});

test("organic slat stabilizers vary independently without exceeding the span target", () => {
  const mask = createMask(31, 31);
  const anchorMask = createMask(31, 31);
  for (const x of [1, 6, 11, 16, 21, 26]) {
    for (let y = 0; y < mask.height; y += 1) mask.data[y * mask.width + x] = 1;
  }
  for (let x = 0; x < mask.width; x += 1) {
    mask.data[x] = 1;
    mask.data[(mask.height - 1) * mask.width + x] = 1;
    anchorMask.data[x] = 1;
    anchorMask.data[(mask.height - 1) * mask.width + x] = 1;
  }
  const config = {
    sheet: { widthMm: 31, heightMm: 31 },
    anchorMask,
    widthMm: 2,
    minimumWebMm: 1,
    kerfMm: 0,
    requireSingleComponent: true,
    strategy: {
      mode: "smart",
      kind: "lamele",
      level: 2,
      preferredAngleDeg: 0,
      barAngleDeg: 90,
      slatPitchMm: 5,
      maximumUnsupportedSpanMm: 8,
      organicVariation: 0.85,
    },
  };
  const first = suggestBridges(mask, config);
  const second = suggestBridges(mask, config);

  assert.deepEqual(first, second, "organic placement must remain repeatable");
  assert.ok(first.some((bridge) => Math.abs(bridge.organicOffsetMm) >= 0.5));
  const byNominalStation = Map.groupBy(first, (bridge) => bridge.nominalStationMm);
  assert.ok([...byNominalStation.values()].some((bridges) =>
    new Set(bridges.map((bridge) => bridge.stationMm)).size > 1),
  "ties at one nominal station should no longer form a rigid row");

  for (const slatCenter of [1.5, 6.5, 11.5, 16.5, 21.5, 26.5]) {
    const positions = [1.5, 29.5, ...first.flatMap((bridge) => [bridge.start, bridge.end])
      .filter((point) => Math.abs(point.x - slatCenter) <= 1.1)
      .map((point) => point.y)].sort((a, b) => a - b);
    for (let index = 1; index < positions.length; index += 1) {
      assert.ok(positions[index] - positions[index - 1] <= 8 + 1e-9,
        `slat at ${slatCenter} exceeds its target span`);
    }
  }
});
