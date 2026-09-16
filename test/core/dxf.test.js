import test from "node:test";
import assert from "node:assert/strict";

import { exportDxf } from "../../web/core/index.js";
import { maskFromAscii } from "./fixtures.js";

function valuesAfterGroup(dxf, groupCode) {
  const lines = dxf.trimEnd().split("\n");
  const values = [];
  for (let index = 0; index < lines.length - 1; index += 2) {
    if (lines[index] === String(groupCode)) values.push(lines[index + 1]);
  }
  return values;
}

test("DXF export emits a closed true-scale LWPOLYLINE in millimetres", () => {
  const mask = maskFromAscii([
    "##",
    "##",
  ]);
  const first = exportDxf(mask, { widthMm: 20, heightMm: 10 }, { title: "Tăiere\nA" });
  const second = exportDxf(mask, { widthMm: 20, heightMm: 10 }, { title: "Tăiere\nA" });

  assert.equal(first, second);
  assert.match(first, /\n9\n\$INSUNITS\n70\n4\n/);
  assert.match(first, /\n0\nLWPOLYLINE\n/);
  assert.match(first, /\n90\n4\n70\n1\n/);
  assert.match(first, /Kerfloom: Taiere A/);
  assert.deepEqual(valuesAfterGroup(first, 10).slice(-4), ["0", "20", "20", "0"]);
  assert.deepEqual(valuesAfterGroup(first, 20).slice(-4), ["10", "10", "0", "0"]);
  assert.match(first, /\n0\nEOF\n$/);
});

test("DXF preserves holes as separate closed contours and supports inches", () => {
  const ring = maskFromAscii([
    "###",
    "#.#",
    "###",
  ]);
  const dxf = exportDxf(ring, { widthMm: 25.4, heightMm: 25.4 }, { units: "in" });

  assert.equal((dxf.match(/\n0\nLWPOLYLINE\n/g) ?? []).length, 2);
  assert.match(dxf, /\n9\n\$INSUNITS\n70\n1\n/);
  assert.match(dxf, /\n9\n\$EXTMAX\n10\n1\n20\n1\n30\n0\n/);
});

test("DXF emits exact CIRCLE entities for matched Variable Dot holes", () => {
  const mask = maskFromAscii([
    "#####",
    "#...#",
    "#...#",
    "#...#",
    "#####",
  ]);
  const dxf = exportDxf(mask, { widthMm: 5, heightMm: 5 }, {
    exactCircleHoles: [{ cxMm: 2.5, cyMm: 2.5, radiusMm: 1.5 }],
  });

  assert.equal((dxf.match(/\n0\nLWPOLYLINE\n/g) ?? []).length, 1);
  assert.equal((dxf.match(/\n0\nCIRCLE\n/g) ?? []).length, 1);
  assert.match(dxf, /\n40\n1\.5\n/);
});
