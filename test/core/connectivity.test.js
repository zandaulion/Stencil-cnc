import test from "node:test";
import assert from "node:assert/strict";

import { analyzeConnectivity, createMask } from "../../web/core/index.js";
import { maskFromAscii } from "./fixtures.js";

test("4-connectivity rejects a diagonal point contact", () => {
  const mask = maskFromAscii([
    "#..",
    ".#.",
    "...",
  ]);
  const result = analyzeConnectivity(mask);

  assert.equal(result.connectivity, 4);
  assert.equal(result.componentCount, 2);
  assert.equal(result.islandCount, 1);
  assert.deepEqual(result.islands[0].bounds, {
    minX: 1, minY: 1, maxX: 1, maxY: 1, width: 1, height: 1,
  });
});

test("an explicit anchor mask defines support independently of the raster boundary", () => {
  const mask = maskFromAscii(["#.#"]);
  const anchor = createMask(3, 1);
  anchor.data[0] = 1;
  const result = analyzeConnectivity(mask, { anchorMask: anchor });

  assert.equal(result.componentCount, 2);
  assert.equal(result.supportedComponents.length, 1);
  assert.equal(result.islandCount, 1);
  assert.equal(result.islands[0].bounds.minX, 2);
});
