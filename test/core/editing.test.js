import test from "node:test";
import assert from "node:assert/strict";

import {
  connectedRegionIndices,
  createMask,
  physicalDiscIndices,
  physicalStrokeIndices,
} from "../../web/core/index.js";
import { maskFromAscii } from "./fixtures.js";

test("a physical brush remains circular in millimetres with non-square pixels", () => {
  const mask = createMask(11, 11);
  const indices = physicalDiscIndices(mask, { x: 5, y: 5 }, 4, {
    widthMm: 11,
    heightMm: 22,
  });

  assert.ok(indices.includes(5 * mask.width + 3), "two 1 mm horizontal pixels belong to the radius");
  assert.ok(indices.includes(4 * mask.width + 5), "one 2 mm vertical pixel belongs to the radius");
  assert.ok(!indices.includes(3 * mask.width + 5), "two vertical pixels exceed the physical radius");
});

test("a sparse pointer gesture produces a continuous stroke", () => {
  const mask = createMask(21, 7);
  const indices = new Set(physicalStrokeIndices(
    mask,
    { x: 2, y: 3 },
    { x: 18, y: 3 },
    2,
    { widthMm: 21, heightMm: 7 },
  ));

  for (let x = 2; x <= 18; x += 1) assert.ok(indices.has(3 * mask.width + x));
});

test("connected-region selection stops at other material and honours its cap", () => {
  const mask = maskFromAscii([
    "##..#",
    "##..#",
  ]);
  const first = connectedRegionIndices(mask, { x: 0, y: 0 });
  const limited = connectedRegionIndices(mask, { x: 2, y: 0 }, { maximumPixels: 2 });

  assert.deepEqual(first.indices.sort((a, b) => a - b), [0, 1, 5, 6]);
  assert.equal(first.truncated, false);
  assert.deepEqual(limited.indices, []);
  assert.equal(limited.truncated, true);
});
