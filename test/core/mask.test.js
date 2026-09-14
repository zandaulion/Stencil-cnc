import test from "node:test";
import assert from "node:assert/strict";

import {
  RETAINED,
  applyRectangularFrame,
  countRetained,
  createMask,
  createRectangularFrameMask,
  maskFromImageData,
} from "../../web/core/index.js";
import { rgbaFixture } from "./fixtures.js";

test("RGBA thresholding produces semantic retained material and supports inversion", () => {
  const image = rgbaFixture([
    [0, 0, 0, 255],
    [255, 255, 255, 255],
    [0, 0, 0, 0],
  ]);

  assert.deepEqual([...maskFromImageData(image, { threshold: 128 }).data], [1, 0, 0]);
  assert.deepEqual([...maskFromImageData(image, { threshold: 128, invert: true }).data], [0, 1, 1]);
});

test("a rectangular frame is configurable in physical mm", () => {
  const sheet = { widthMm: 8, heightMm: 6 };
  const frame = createRectangularFrameMask(8, 6, { thicknessMm: 1 }, sheet);
  assert.equal(countRetained(frame), 24);
  assert.equal(frame.data[0], RETAINED);
  assert.equal(frame.data[2 * frame.width + 3], 0);

  const source = createMask(8, 6);
  source.data[2 * source.width + 3] = RETAINED;
  const combined = applyRectangularFrame(source, { thicknessMm: 1 }, sheet);
  assert.equal(countRetained(combined), 25);
});

test("per-side frame configuration can leave selected sides open", () => {
  const frame = createRectangularFrameMask(6, 6, {
    thicknessMm: { top: 1, right: 1, bottom: 1, left: 1 },
    sides: { right: false, bottom: false },
  }, { widthMm: 6, heightMm: 6 });

  assert.equal(frame.data[0], 1);
  assert.equal(frame.data[3 * 6], 1);
  assert.equal(frame.data[3 * 6 + 5], 0);
  assert.equal(frame.data[5 * 6 + 3], 0);
});
