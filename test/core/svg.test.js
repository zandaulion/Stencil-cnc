import test from "node:test";
import assert from "node:assert/strict";

import { exportSvg, traceMaskContours } from "../../web/core/index.js";
import { maskFromAscii } from "./fixtures.js";

test("SVG export has deterministic true-mm dimensions and simplified geometry", () => {
  const mask = maskFromAscii([
    "##",
    "##",
  ]);
  const first = exportSvg(mask, { widthMm: 20, heightMm: 10 }, { title: "A & B" });
  const second = exportSvg(mask, { widthMm: 20, heightMm: 10 }, { title: "A & B" });

  assert.equal(first, second);
  assert.match(first, /width="20mm" height="10mm" viewBox="0 0 20 10"/);
  assert.match(first, /<title>A &amp; B<\/title>/);
  assert.match(first, /d="M0 0L20 0L20 10L0 10Z"/);
});

test("holes and diagonal components remain separate even-odd contours", () => {
  const ring = maskFromAscii([
    "###",
    "#.#",
    "###",
  ]);
  assert.equal(traceMaskContours(ring).length, 2);
  assert.match(exportSvg(ring, { widthMm: 3, heightMm: 3 }), /fill-rule="evenodd"/);

  const diagonal = maskFromAscii([
    "#.",
    ".#",
  ]);
  assert.equal(traceMaskContours(diagonal).length, 2);
});

test("SVG export expresses both dimensions and paths in inches", () => {
  const mask = maskFromAscii(["##"]);
  const svg = exportSvg(mask, { widthMm: 50.8, heightMm: 25.4 }, { units: "in" });
  assert.match(svg, /width="2in" height="1in" viewBox="0 0 2 1"/);
  assert.match(svg, /d="M0 0L2 0L2 1L0 1Z"/);
});

test("SVG replaces a sampled Variable Dot contour with an exact circular arc", () => {
  const mask = maskFromAscii([
    "#####",
    "#...#",
    "#...#",
    "#...#",
    "#####",
  ]);
  const svg = exportSvg(mask, { widthMm: 5, heightMm: 5 }, {
    exactCircleHoles: [{ cxMm: 2.5, cyMm: 2.5, radiusMm: 1.5 }],
  });

  assert.match(svg, /A1\.5 1\.5 0 1 0/);
  assert.doesNotMatch(svg, /M1 1L4 1L4 4L1 4Z/);
});
