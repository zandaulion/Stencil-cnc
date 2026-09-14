import assert from "node:assert/strict";
import test from "node:test";

import { REMOVED, RETAINED } from "../../web/core/mask.js";
import { analyzeConnectivity } from "../../web/core/connectivity.js";
import { hatchMask } from "../../web/core/styles/hatch.js";

const SHEET = { widthMm: 200, heightMm: 200 };

function uniformTone(width, height, ink) {
  return { width, height, data: new Float32Array(width * height).fill(ink) };
}

function removedCount(mask) {
  let total = 0;
  for (const value of mask.data) if (value === REMOVED) total += 1;
  return total;
}

test("spacing with no room for both a slot and a web is refused", () => {
  const tone = uniformTone(300, 300, 0.5);
  assert.throws(
    () => hatchMask(tone, { sheet: SHEET, rowPitchMm: 1.5, minSlotMm: 1, minWebMm: 1.2 }),
    /Rows .* cannot hold/,
  );
  assert.throws(
    () => hatchMask(tone, { sheet: SHEET, cellMm: 1.5, minSlotMm: 1, minWebMm: 1.2 }),
    /Cells .* cannot hold/,
  );
});

test("a nearly black area remains solid instead of gaining an uncuttable scratch", () => {
  const mask = hatchMask(uniformTone(300, 300, 0.98), {
    sheet: SHEET, rowPitchMm: 5, cellMm: 5, minSlotMm: 2, minWebMm: 1.5,
  });
  assert.equal(removedCount(mask), 0, "nothing should be cut in a nearly black area");
});

test("lighter tone removes more material for back-lighting", () => {
  const options = { sheet: SHEET, rowPitchMm: 5, cellMm: 5, minSlotMm: 1, minWebMm: 1.5 };
  const light = removedCount(hatchMask(uniformTone(300, 300, 0), options));
  const mid = removedCount(hatchMask(uniformTone(300, 300, 0.5), options));
  assert.ok(light > mid, `white tone ${light} should cut more than mid grey ${mid}`);
  assert.ok(mid > 0, "mid grey should cut something");
});

test("the plate survives as one piece even at full light", () => {
  // The only way this style can fail structurally is a ring of slots cutting a
  // patch loose. The minimum web is what prevents it, so the worst case --
  // every stroke at maximum length -- is the one worth asserting.
  const mask = hatchMask(uniformTone(400, 400, 0), {
    sheet: SHEET, rowPitchMm: 4, cellMm: 4, minSlotMm: 1, minWebMm: 1.2,
  });
  const report = analyzeConnectivity(mask);
  const components = report.componentCount ?? report.components?.length;
  assert.equal(components, 1, "the plate must not shed islands");
});

test("the angle actually turns the strokes", () => {
  const tone = uniformTone(300, 300, 0);
  const flat = hatchMask(tone, {
    sheet: SHEET, angleDeg: 0, rowPitchMm: 6, cellMm: 6, minSlotMm: 1, minWebMm: 1.5,
  });
  const tilted = hatchMask(tone, {
    sheet: SHEET, angleDeg: 45, rowPitchMm: 6, cellMm: 6, minSlotMm: 1, minWebMm: 1.5,
  });
  let differing = 0;
  for (let index = 0; index < flat.data.length; index += 1) {
    if (flat.data[index] !== tilted.data[index]) differing += 1;
  }
  assert.ok(differing > flat.data.length * 0.05, "rotating should rearrange the slots");
});

test("inverting swaps which tone becomes a slot", () => {
  const options = { sheet: SHEET, rowPitchMm: 5, cellMm: 5, minSlotMm: 1, minWebMm: 1.5 };
  const straight = removedCount(hatchMask(uniformTone(300, 300, 0.9), options));
  const inverted = removedCount(hatchMask(uniformTone(300, 300, 0.9), { ...options, invert: true }));
  assert.ok(straight < inverted, "dark ink stays metal unless the polarity is flipped");
});

test("the plate starts whole, so untouched areas stay material", () => {
  const tone = { width: 200, height: 200, data: new Float32Array(200 * 200).fill(1) };
  // Light only in the top half; the dark lower half must stay plate.
  for (let y = 0; y < 100; y += 1) tone.data.fill(0, y * 200, y * 200 + 200);
  const mask = hatchMask(tone, {
    sheet: SHEET, rowPitchMm: 5, cellMm: 5, minSlotMm: 1, minWebMm: 1.5,
  });
  let bottomSolid = true;
  for (let y = 120; y < 200 && bottomSolid; y += 1) {
    for (let x = 0; x < 200; x += 1) {
      if (mask.data[y * 200 + x] !== RETAINED) { bottomSolid = false; break; }
    }
  }
  assert.ok(bottomSolid, "a dark area should come back as untouched plate");
});
