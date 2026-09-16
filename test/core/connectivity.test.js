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

test("8-connectivity groups diagonal raster cells into one cut path", () => {
  const mask = maskFromAscii([
    "#..",
    ".#.",
    "...",
  ]);
  const result = analyzeConnectivity(mask, { connectivity: 8 });

  assert.equal(result.connectivity, 8);
  assert.equal(result.componentCount, 1);
  assert.equal(result.components[0].pixelCount, 2);
});

test("connectivity rejects unsupported neighbourhoods", () => {
  const mask = maskFromAscii(["#"]);
  assert.throws(() => analyzeConnectivity(mask, { connectivity: 6 }), /4 or 8/);
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

test("main-versus-detached components remain distinct from external anchor support", () => {
  const mask = maskFromAscii(["##..##"]);
  const unanchored = analyzeConnectivity(mask, { anchorBoundary: false });

  assert.equal(unanchored.islandCount, 2);
  assert.equal(unanchored.mainComponent.id, 1);
  assert.equal(unanchored.mainComponent.pixelCount, 2);
  assert.deepEqual(unanchored.detachedComponents.map((component) => component.id), [2]);

  const anchored = analyzeConnectivity(mask, { anchorBoundary: true });
  assert.equal(anchored.islandCount, 0);
  assert.equal(anchored.mainComponent.id, 1);
  assert.deepEqual(anchored.detachedComponents.map((component) => component.id), [2]);
});
