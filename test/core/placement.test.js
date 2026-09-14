import test from "node:test";
import assert from "node:assert/strict";

import { createMask, orientSheet, placeMaskOnSheet, trimMaskToContent } from "../../web/core/index.js";
import { maskFromAscii } from "./fixtures.js";

test("artwork is contained without stretching when sheet and source aspects differ", () => {
  const source = createMask(4, 2, true);
  const { mask, placement } = placeMaskOnSheet(source, { widthMm: 100, heightMm: 100 }, {
    longEdgePx: 100,
    fitToFrame: false,
  });

  assert.equal(mask.width, 100);
  assert.equal(mask.height, 100);
  assert.deepEqual(
    [placement.xMm, placement.yMm, placement.widthMm, placement.heightMm],
    [0, 25, 100, 50],
  );
  assert.equal(mask.data[10 * mask.width + 50], 0);
  assert.equal(mask.data[50 * mask.width + 50], 1);
  assert.equal(mask.data[90 * mask.width + 50], 0);
});

test("sheet orientation swaps physical dimensions without resizing the stock", () => {
  assert.deepEqual(
    orientSheet({ widthMm: 1250, heightMm: 2500 }, "landscape"),
    { widthMm: 2500, heightMm: 1250 },
  );
  assert.deepEqual(
    orientSheet({ widthMm: 2500, heightMm: 1250 }, "portrait"),
    { widthMm: 1250, heightMm: 2500 },
  );
  assert.deepEqual(
    orientSheet({ widthMm: 2500, heightMm: 1250 }, "landscape"),
    { widthMm: 2500, heightMm: 1250 },
  );
});

test("frame and artwork margin define the safe placement area", () => {
  const source = createMask(2, 2, true);
  const { placement } = placeMaskOnSheet(source, { widthMm: 200, heightMm: 100 }, {
    longEdgePx: 200,
    marginMm: 5,
    frame: {
      enabled: true,
      thicknessMm: 10,
      sides: { top: true, right: true, bottom: true, left: true },
    },
  });

  assert.deepEqual(placement.safeArea, { xMm: 15, yMm: 15, widthMm: 170, heightMm: 70 });
  assert.equal(placement.widthMm, 70);
  assert.equal(placement.heightMm, 70);
  assert.equal(placement.xMm, 65);
  assert.equal(placement.yMm, 15);
});

test("smaller artwork is enlarged proportionally until it reaches the plate margins", () => {
  const source = createMask(50, 25, true);
  const { placement } = placeMaskOnSheet(source, { widthMm: 200, heightMm: 100 }, {
    longEdgePx: 200,
    marginMm: 10,
    frame: { enabled: false },
  });

  assert.deepEqual(placement.safeArea, { xMm: 10, yMm: 10, widthMm: 180, heightMm: 80 });
  assert.equal(placement.widthMm, 160);
  assert.equal(placement.heightMm, 80);
  assert.equal(placement.xMm, 20);
  assert.equal(placement.yMm, 10);
  assert.equal(placement.widthMm / placement.heightMm, source.width / source.height);
});

test("portrait artwork enlarges to the horizontal margins without being stretched", () => {
  const source = createMask(25, 50, true);
  const { placement } = placeMaskOnSheet(source, { widthMm: 100, heightMm: 250 }, {
    longEdgePx: 250,
    marginMm: 10,
    frame: { enabled: false },
  });

  assert.equal(placement.widthMm, 80);
  assert.equal(placement.heightMm, 160);
  assert.equal(placement.xMm, 10);
  assert.equal(placement.yMm, 45);
  assert.equal(placement.widthMm / placement.heightMm, source.width / source.height);
});

test("empty border is trimmed from retained artwork without losing visible pixels", () => {
  const source = maskFromAscii([
    ".....",
    ".##..",
    ".###.",
    ".....",
  ]);
  const { mask, bounds } = trimMaskToContent(source, 1);

  assert.deepEqual(bounds, { x: 1, y: 1, width: 3, height: 2 });
  assert.deepEqual([...mask.data], [1, 1, 0, 1, 1, 1]);
});

test("removed artwork can be trimmed when the surrounding plate is retained", () => {
  const source = maskFromAscii([
    "#####",
    "##.##",
    "#####",
  ]);
  const { mask, bounds } = trimMaskToContent(source, 0);

  assert.deepEqual(bounds, { x: 2, y: 1, width: 1, height: 1 });
  assert.deepEqual([...mask.data], [0]);
});

test("visible artwork bounds, rather than its empty canvas, drive margin fitting", () => {
  const source = maskFromAscii([
    "........",
    "...##...",
    "...##...",
    "...##...",
    "...##...",
    "...##...",
    "...##...",
    "........",
  ]);
  const { mask } = trimMaskToContent(source, 1);
  const { placement } = placeMaskOnSheet(mask, { widthMm: 100, heightMm: 200 }, {
    marginMm: 10,
    frame: { enabled: false },
  });

  assert.equal(mask.width, 2);
  assert.equal(mask.height, 6);
  assert.equal(placement.heightMm, 180);
  assert.equal(placement.yMm, 10);
  assert.equal(placement.widthMm, 60);
  assert.equal(placement.xMm, 20);
});
