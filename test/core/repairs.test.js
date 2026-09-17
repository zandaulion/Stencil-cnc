import test from "node:test";
import assert from "node:assert/strict";

import {
  RETAINED,
  applySmallOpeningRepairPlan,
  createMask,
  mergeRepairLayerEdits,
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

test("a warning pass composes with the existing error-repair layer", () => {
  const repaired = maskFromAscii(["#.#."]);
  const warningResult = maskFromAscii(["####"]);
  const combined = mergeRepairLayerEdits(repaired, warningResult, {
    keep: new Set([2]),
    remove: new Set([1]),
  });

  assert.deepEqual([...combined.keep].sort((a, b) => a - b), [2, 3]);
  assert.deepEqual([...combined.remove], []);
});

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

test("cut-gap repair never closes portrait-spanning slat channels", () => {
  const width = 17;
  const height = 30;
  const mask = createMask(width, height, true);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      if (x % 3 !== 0) mask.data[y * width + x] = 0;
    }
  }
  const sheet = { widthMm: width, heightMm: height };
  const validation = validateDesign(mask, {
    sheet,
    minimumOpeningMm: 0,
    minimumWebMm: 2,
    requireAnchored: false,
    requireSingleComponent: true,
  });
  const plan = planCutGapRepairs(mask, validation, {
    sheet,
    strategy: "durable",
    targetGapMm: 2.4,
    targetOpeningMm: 1,
  });

  assert.ok(plan.protectedClosureCount > 0);
  assert.equal(plan.counts.close, 0);
  assert.ok(plan.items.every((item) => item.closureProtected && !item.availableActions.close));
});

test("slat gap repair uniformly thickens a small deficient web without closing its channels", () => {
  const width = 52;
  const height = 30;
  const mask = createMask(width, height, true);
  for (let y = 1; y < height - 1; y += 1) {
    for (const [start, end] of [[2, 13], [21, 32], [40, 50]]) {
      for (let x = start; x <= end; x += 1) mask.data[y * width + x] = 0;
    }
  }
  const sheet = { widthMm: width / 3, heightMm: height / 3 };
  const validation = validateDesign(mask, {
    sheet,
    minimumOpeningMm: 2,
    minimumWebMm: 3,
    requireAnchored: false,
    requireSingleComponent: true,
  });
  const beforeGap = validation.errors.find((issue) => issue.code === "MIN_CUT_GAP");
  assert.equal(beforeGap.details.finishedGapMm.toFixed(2), "2.33");

  const plan = planCutGapRepairs(mask, validation, {
    sheet,
    strategy: "balanced",
    targetGapMm: 3,
    targetOpeningMm: 2,
    widenMode: "component-shell",
  });
  const repaired = applySmallOpeningRepairPlan(mask, plan);
  const checked = validateDesign(repaired, {
    sheet,
    minimumOpeningMm: 2,
    minimumWebMm: 3,
    requireAnchored: false,
    requireSingleComponent: true,
  });

  assert.ok(plan.items.every((item) => item.widenMode === "component-shell"));
  assert.ok(!checked.errors.some((issue) => issue.code === "MIN_CUT_GAP"));
  assert.ok(!checked.errors.some((issue) => issue.code === "MIN_OPENING_UNCUTTABLE"));
  assert.ok(repaired.data.some((value) => value === 0));
});

test("small-opening repair never closes a long narrow artwork channel", () => {
  const width = 9;
  const height = 30;
  const mask = createMask(width, height, true);
  for (let y = 1; y < height - 1; y += 1) mask.data[y * width + 4] = 0;
  const sheet = { widthMm: width, heightMm: height };
  const validation = validateDesign(mask, {
    sheet,
    minimumOpeningMm: 2,
    minimumWebMm: 2,
    requireAnchored: false,
    requireSingleComponent: true,
  });
  const plan = planSmallOpeningRepairs(mask, validation, {
    sheet,
    strategy: "durable",
    targetOpeningMm: 2.4,
    minimumWebMm: 2.4,
  });

  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].closureProtected, true);
  assert.equal(plan.items[0].availableActions.close, false);
  assert.notEqual(plan.items[0].action, "close");
});

test("balanced manufacturing repair does not escalate slat gaps into destructive closures", () => {
  const width = 17;
  const height = 30;
  const mask = createMask(width, height, true);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      if (x % 3 !== 0) mask.data[y * width + x] = 0;
    }
  }
  const plan = planManufacturingRepairs(mask, {
    sheet: { widthMm: width, heightMm: height },
    kerfMm: 0,
    minimumWebMm: 2,
    minimumOpeningMm: 0,
    targetWebMm: 2.4,
    targetOpeningMm: 1,
    strategy: "balanced",
    categories: { slivers: false, gaps: true, webs: false },
    bridgeWidthMm: 2.4,
    bridgeStrategy: { mode: "smart", kind: "lamele", level: 2 },
    maximumBridges: 20,
  });

  assert.equal(plan.counts.close, 0);
  assert.deepEqual([...plan.mask.data], [...mask.data]);
  assert.match(plan.outcome.notes[0], /Protected \d+ long slat cuts from whole-cut closure/);
});

test("balanced manufacturing repair resolves modest slat deficits with a material shell", () => {
  const width = 52;
  const height = 30;
  const mask = createMask(width, height, true);
  for (let y = 1; y < height - 1; y += 1) {
    for (const [start, end] of [[2, 13], [21, 32], [40, 50]]) {
      for (let x = start; x <= end; x += 1) mask.data[y * width + x] = 0;
    }
  }
  const plan = planManufacturingRepairs(mask, {
    sheet: { widthMm: width / 3, heightMm: height / 3 },
    kerfMm: 0,
    minimumWebMm: 3,
    minimumOpeningMm: 2,
    targetWebMm: 3.4,
    targetOpeningMm: 2.4,
    strategy: "balanced",
    categories: { slivers: true, gaps: true, webs: true },
    bridgeWidthMm: 3.4,
    bridgeStrategy: { mode: "smart", kind: "lamele", level: 2 },
    maximumBridges: 20,
  });

  assert.equal(plan.outcome.beforeErrors, 2);
  assert.equal(plan.outcome.afterErrors, 0);
  assert.equal(plan.outcome.complete, true);
  assert.equal(plan.counts.close, 0);
  assert.ok(plan.items.every((item) => item.action !== "close"));
  assert.ok(plan.items.some((item) => item.widenMode === "component-shell"));
  assert.match(plan.outcome.notes[0], /widened the affected channels with local material/);
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

test("manufacturing repair keeps safe opening fixes when another opening proposal is unsafe", () => {
  // This dense fixture contains two undersized cut regions. Repairing them as
  // one batch makes the complete validation result worse, while one region can
  // be repaired independently without creating any other blocker. The safe
  // repair must not be discarded with its unsafe neighbour.
  const mask = maskFromAscii([
    "############",
    "###.####..##",
    "##.##.#.####",
    "##.###.#.###",
    "###.#####..#",
    "##.#####.###",
    "#...#####.##",
    "####..##..##",
    "####.#...###",
    "#..###.#####",
    "##...#.#####",
    "############",
  ]);
  const plan = planManufacturingRepairs(mask, {
    sheet: { widthMm: 12, heightMm: 12 },
    kerfMm: 0,
    minimumWebMm: 2,
    minimumOpeningMm: 2,
    targetWebMm: 2.4,
    targetOpeningMm: 2.4,
    strategy: "balanced",
    categories: { slivers: true, gaps: false, webs: false },
    bridgeWidthMm: 2.4,
    maximumBridges: 20,
  });

  assert.equal(plan.outcome.beforeErrors, 3);
  assert.ok(plan.items.some((item) => item.category === "opening"));
  assert.equal(plan.outcome.afterErrors, 0);
  assert.equal(plan.outcome.safeToApply, true);
  assert.equal(plan.outcome.acceptedOpeningRepairs, 1);
  assert.equal(plan.outcome.remainingOpeningErrors, 0);
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

test("repair planning counts one no-core material region instead of duplicate morphology warnings", () => {
  const mask = createMask(9, 9);
  for (let y = 1; y < 8; y += 1) {
    for (let x = 3; x <= 5; x += 1) mask.data[y * mask.width + x] = RETAINED;
  }
  const plan = planManufacturingRepairs(mask, {
    sheet: { widthMm: 9, heightMm: 9 },
    kerfMm: 0,
    minimumWebMm: 4,
    minimumOpeningMm: 0,
    targetWebMm: 4.4,
    targetOpeningMm: 1,
    strategy: "balanced",
    categories: { slivers: false, gaps: false, webs: false, warnings: true },
    bridgeWidthMm: 5,
    maximumBridges: 8,
  });

  assert.equal(plan.beforeValidation.warnings.length, 1);
  assert.equal(plan.beforeValidation.warnings[0].code, "MIN_WEB_NO_SURVIVING_CORE");
  assert.equal(plan.beforeValidation.warnings[0].details.locations.length, 1);
  assert.equal(plan.outcome.beforeWarnings, 1);
  assert.equal(plan.outcome.beforeThinAreaPixels, 21);
  assert.ok(plan.outcome.notes.every((note) => !/2 structural warning/.test(note)));
});
