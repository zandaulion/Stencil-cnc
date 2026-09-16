import test from "node:test";
import assert from "node:assert/strict";

import {
  FINISHED_BOUNDARY_CAM,
  LEGACY_UNCOMPENSATED_CENTERLINE,
  kerfErosionMm,
  rasterWebWidthMm,
  requiredOpeningMm,
} from "../../web/core/index.js";

test("finished boundaries do not add or subtract kerf a second time", () => {
  assert.equal(rasterWebWidthMm(3, 1.2, FINISHED_BOUNDARY_CAM), 3);
  assert.equal(kerfErosionMm(1.2, FINISHED_BOUNDARY_CAM), 0);
});

test("legacy centre paths retain their complete-kerf allowance and erosion", () => {
  assert.equal(rasterWebWidthMm(3, 1.2, LEGACY_UNCOMPENSATED_CENTERLINE), 4.2);
  assert.equal(kerfErosionMm(1.2, LEGACY_UNCOMPENSATED_CENTERLINE), 1.2);
});

test("the compensated internal path must fit the stricter opening or cutter diameter", () => {
  assert.equal(requiredOpeningMm(2, 1.2), 2);
  assert.equal(requiredOpeningMm(0.8, 1.2), 1.2);
  assert.equal(requiredOpeningMm(2, 0), 2);
});
