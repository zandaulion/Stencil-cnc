import test from "node:test";
import assert from "node:assert/strict";

import {
  RETAINED,
  applySmallOpeningRepairPlan,
  createMask,
  planCutGapRepairs,
  planLoosePieceRepairs,
  planManufacturingRepairs,
  planSmallOpeningRepairs,
  setSmallOpeningRepairAction,
  validateDesign,
} from "../../web/core/index.js";
import { maskFromAscii } from "./fixtures.js";

function validate(mask, sheet = { widthMm: mask.width, heightMm: mask.height }) {
  return validateDesign(mask, {
    sheet,
    minimumOpeningMm: 2,
    minimumWebMm: 3,
    requireAnchored: false,
    requireSingleComponent: true,
  });
}

test("durable small-opening repair closes isolated specks in one batch", () => {
  const mask = maskFromAscii([
    "#########",
    "##.###.##",
    "#########",
    "####.####",
    "#########",
  ]);
  const validation = validate(mask);
  const plan = planSmallOpeningRepairs(mask, validation, {
    sheet: { widthMm: 9, heightMm: 5 },
    strategy: "durable",
    targetOpeningMm: 2.4,
    minimumWebMm: 3.4,
  });

  assert.equal(plan.items.length, 3);
  assert.equal(plan.counts.close, 3);
  const repaired = applySmallOpeningRepairPlan(mask, plan);
  assert.ok(repaired.data.every((value) => value === RETAINED));
  assert.ok(!validate(repaired).errors.some((issue) => issue.code === "MIN_OPENING_UNCUTTABLE"));
});

test("preserve-detail repair enlarges a meaningful opening past the machine floor", () => {
  const mask = maskFromAscii([
    "#########",
    "#########",
    "####.####",
    "#########",
    "#########",
    "#########",
    "#########",
    "#########",
    "#########",
  ]);
  const sheet = { widthMm: 9, heightMm: 9 };
  const plan = planSmallOpeningRepairs(mask, validate(mask, sheet), {
    sheet,
    strategy: "preserve",
    targetOpeningMm: 2.4,
    minimumWebMm: 0,
  });

  assert.equal(plan.items[0].action, "enlarge");
  const repaired = applySmallOpeningRepairPlan(mask, plan);
  assert.ok(!validate(repaired, sheet).errors.some((issue) => issue.code === "MIN_OPENING_UNCUTTABLE"));
});

test("an occurrence override can be applied to all geometrically similar openings", () => {
  const mask = maskFromAscii([
    "#########",
    "##.###.##",
    "#########",
  ]);
  const plan = planSmallOpeningRepairs(mask, validate(mask), {
    sheet: { widthMm: 9, heightMm: 3 },
    strategy: "durable",
    targetOpeningMm: 2.4,
    minimumWebMm: 0,
  });

  assert.equal(setSmallOpeningRepairAction(plan, plan.items[0].id, "enlarge", { similar: true }), true);
  assert.equal(plan.counts.enlarge, 2);
  assert.ok(plan.items.every((item) => item.action === "enlarge"));
});

test("protected structural pixels are never carved by an enlargement", () => {
  const mask = maskFromAscii([
    "#####",
    "#####",
    "##.##",
    "#####",
    "#####",
  ]);
  const protectedMask = createMask(5, 5);
  protectedMask.data[2 * 5 + 3] = RETAINED;
  const plan = planSmallOpeningRepairs(mask, validate(mask), {
    sheet: { widthMm: 5, heightMm: 5 },
    strategy: "preserve",
    targetOpeningMm: 2.4,
    minimumWebMm: 0,
    protectedMask,
  });
  const repaired = applySmallOpeningRepairPlan(mask, plan);

  assert.equal(repaired.data[2 * 5 + 3], RETAINED);
});

test("balanced close-cut repair widens every reported gap in one batch", () => {
  const mask = maskFromAscii([
    "#################",
    "#...##...##...###",
    "#################",
  ]);
  const sheet = { widthMm: 17, heightMm: 3 };
  const validation = validateDesign(mask, {
    sheet,
    minimumOpeningMm: 0,
    minimumWebMm: 3,
    requireAnchored: false,
  });
  const plan = planCutGapRepairs(mask, validation, {
    sheet,
    strategy: "balanced",
    targetGapMm: 3.4,
    targetOpeningMm: 2.4,
  });

  assert.equal(plan.items.length, 2);
  assert.equal(plan.counts.enlarge, 2);
  const repaired = applySmallOpeningRepairPlan(mask, plan);
  const checked = validateDesign(repaired, {
    sheet,
    minimumOpeningMm: 0,
    minimumWebMm: 3,
    requireAnchored: false,
  });
  assert.ok(!checked.errors.some((issue) => issue.code === "MIN_CUT_GAP"));
});

test("durable close-cut repair closes the smaller conflicting cut", () => {
  const mask = maskFromAscii([
    "############",
    "#..##.....##",
    "############",
  ]);
  const sheet = { widthMm: 12, heightMm: 3 };
  const validation = validateDesign(mask, {
    sheet,
    minimumOpeningMm: 0,
    minimumWebMm: 3,
    requireAnchored: false,
  });
  const plan = planCutGapRepairs(mask, validation, {
    sheet,
    strategy: "durable",
    targetGapMm: 3.4,
    targetOpeningMm: 2.4,
  });

  assert.equal(plan.items.length, 1);
  assert.equal(plan.counts.close, 1);
  const repaired = applySmallOpeningRepairPlan(mask, plan);
  assert.equal(repaired.data[1 * mask.width + 1], RETAINED);
  assert.equal(repaired.data[1 * mask.width + 2], RETAINED);
});

test("preserve cleanup removes one-cell loose specks but leaves larger artwork for support", () => {
  const mask = maskFromAscii([
    "#####....",
    ".........",
    "...#.....",
    "......##.",
    "......##.",
  ]);
  const sheet = { widthMm: 9, heightMm: 5 };
  const validation = validateDesign(mask, {
    sheet,
    minimumWebMm: 3,
    requireAnchored: false,
    requireSingleComponent: true,
  });
  const plan = planLoosePieceRepairs(mask, validation, {
    sheet,
    strategy: "preserve",
    minimumWebMm: 3,
  });

  assert.equal(validation.errors[0].details.locations.length, 2);
  assert.equal(plan.totalCount, 2);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.skippedCount, 1);
  const repaired = applySmallOpeningRepairPlan(mask, plan);
  assert.equal(repaired.data[2 * mask.width + 3], 0);
  assert.equal(repaired.data[3 * mask.width + 6], RETAINED);
});

test("manufacturing repair connects blockers without increasing the complete error count", () => {
  const mask = maskFromAscii([
    "####....####",
    "####....####",
    "####....####",
    "####....####",
    "####....####",
  ]);
  const plan = planManufacturingRepairs(mask, {
    sheet: { widthMm: 12, heightMm: 5 },
    kerfMm: 0,
    minimumWebMm: 0,
    minimumOpeningMm: 0,
    targetWebMm: 1,
    targetOpeningMm: 1,
    strategy: "balanced",
    categories: { slivers: false, gaps: false, webs: true },
    bridgeWidthMm: 1,
    bridgeStrategy: { mode: "smart", kind: "generic", level: 1 },
    maximumBridges: 8,
  });

  assert.ok(plan.items.length > 0);
  assert.ok(plan.supportCount > 0);
  assert.equal(plan.outcome.beforeConnectivityErrors, 1);
  assert.equal(plan.outcome.afterConnectivityErrors, 0);
  assert.ok(plan.outcome.afterErrors < plan.outcome.beforeErrors);
  assert.equal(plan.outcome.safeToApply, true);
  assert.equal(plan.outcome.complete, true);
});

test("manufacturing repair never accepts a proposal that worsens blockers", () => {
  const mask = maskFromAscii([
    "#####################",
    "#.#.#.#.#.#.#.#.#.#.#",
    "#####################",
    "#.#.#.#.#.#.#.#.#.#.#",
    "#####################",
  ]);
  const plan = planManufacturingRepairs(mask, {
    sheet: { widthMm: 21, heightMm: 5 },
    kerfMm: 0.5,
    minimumWebMm: 3,
    minimumOpeningMm: 2,
    targetWebMm: 3.4,
    targetOpeningMm: 2.4,
    strategy: "balanced",
    categories: { slivers: true, gaps: true, webs: true },
    bridgeWidthMm: 4,
    bridgeStrategy: { mode: "smart", kind: "generic", level: 2 },
    maximumBridges: 4,
  });

  assert.ok(plan.outcome.afterErrors <= plan.outcome.beforeErrors);
  assert.ok(plan.supportCount <= 4);
  assert.equal(plan.outcome.safeToApply, plan.items.length > 0 && plan.outcome.improved);
});

test("structural-warning repair is opt-in and thickens material only while validation improves", () => {
  const mask = maskFromAscii([
    ".......###.......",
    ".......###.......",
    ".......###.......",
    ".......###.......",
    ".......###.......",
    ".......###.......",
    ".......###.......",
  ]);
  const options = {
    sheet: { widthMm: 17, heightMm: 7 },
    kerfMm: 0,
    minimumWebMm: 3,
    minimumOpeningMm: 0,
    targetWebMm: 3.4,
    targetOpeningMm: 2.4,
    strategy: "balanced",
    bridgeWidthMm: 4,
    bridgeStrategy: { mode: "smart", kind: "generic", level: 2 },
  };
  const withoutWarningRepair = planManufacturingRepairs(mask, {
    ...options,
    categories: { slivers: false, gaps: false, webs: false, warnings: false },
  });
  const withWarningRepair = planManufacturingRepairs(mask, {
    ...options,
    categories: { slivers: false, gaps: false, webs: false, warnings: true },
  });

  assert.equal(withoutWarningRepair.items.length, 0);
  assert.equal(withoutWarningRepair.outcome.safeToApply, false);
  assert.ok(withWarningRepair.items.some((item) => item.category === "warning"));
  assert.equal(withWarningRepair.outcome.afterErrors, 0);
  assert.ok(withWarningRepair.outcome.afterWarnings < withWarningRepair.outcome.beforeWarnings);
  assert.ok(withWarningRepair.outcome.afterThinAreaPixels < withWarningRepair.outcome.beforeThinAreaPixels);
  assert.equal(withWarningRepair.outcome.safeToApply, true);
});
