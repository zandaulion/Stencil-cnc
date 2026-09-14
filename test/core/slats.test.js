import assert from "node:assert/strict";
import test from "node:test";

import { RETAINED } from "../../web/core/mask.js";
import { toneFromImageData } from "../../web/core/tone.js";
import { slatMask } from "../../web/core/styles/slats.js";

const SHEET = { widthMm: 200, heightMm: 200 };

/** A flat grey image, so tone is uniform and widths are predictable. */
function flatImage(width, height, value) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  }
  return { width, height, data };
}

function uniformTone(width, height, ink) {
  return { width, height, data: new Float32Array(width * height).fill(ink) };
}

/** Widths of the retained runs on one row, in pixels. */
function runsOnRow(mask, y) {
  const runs = [];
  let run = 0;
  for (let x = 0; x < mask.width; x += 1) {
    if (mask.data[y * mask.width + x] === RETAINED) run += 1;
    else if (run > 0) { runs.push(run); run = 0; }
  }
  if (run > 0) runs.push(run);
  return runs;
}

test("tone reads darkness locally, not against the whole picture", () => {
  // A bright picture with one slightly darker patch. Globally the patch is
  // still brighter than mid grey, so a plain threshold calls it background --
  // which is exactly how an evenly lit face turns into one flat blob.
  const image = flatImage(64, 64, 230);
  for (let y = 24; y < 40; y += 1) {
    for (let x = 24; x < 40; x += 1) {
      const offset = (y * 64 + x) * 4;
      image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = 190;
    }
  }
  const local = toneFromImageData(image, { mode: "local", radius: 0.2 });
  const centre = local.data[32 * 64 + 32];
  const corner = local.data[2 * 64 + 2];
  assert.ok(centre > 0.6, `the darker patch should read as ink, got ${centre.toFixed(2)}`);
  assert.ok(corner < 0.55, `flat background should stay pale, got ${corner.toFixed(2)}`);
});

test("a pitch too small for both a web and a slot is refused, not squeezed", () => {
  const tone = uniformTone(400, 400, 0.5);
  assert.throws(
    () => slatMask(tone, { sheet: SHEET, pitchMm: 2, minWebMm: 1.5, minSlotMm: 1 }),
    /cannot hold/,
    "a pitch with no room must say so before the sheet is on the machine",
  );
});

test("bar width stays between the material and the tool limits", () => {
  const tone = uniformTone(400, 400, 1); // solid ink: bars want to be as wide as allowed
  const mask = slatMask(tone, {
    sheet: SHEET, pitchMm: 10, minWebMm: 2, minSlotMm: 3,
  });
  const mmPerPixel = SHEET.widthMm / 400;
  for (const run of runsOnRow(mask, 200)) {
    const widthMm = run * mmPerPixel;
    assert.ok(widthMm >= 2 - 0.05, `bar of ${widthMm.toFixed(2)} mm is under the 2 mm web`);
    assert.ok(widthMm <= 7 + 0.05, `bar of ${widthMm.toFixed(2)} mm leaves under the 3 mm slot`);
  }
});

test("light areas keep a bar rather than losing it", () => {
  // Bare sheet still gets the minimum web. A style that let bars vanish in
  // highlights would drop the frame's grip on everything below them.
  const tone = uniformTone(400, 400, 0);
  const mask = slatMask(tone, { sheet: SHEET, pitchMm: 10, minWebMm: 2, minSlotMm: 3 });
  const runs = runsOnRow(mask, 200);
  assert.equal(runs.length, 20, "one bar per pitch, even where the picture is white");
  for (const run of runs) {
    assert.ok(run * (SHEET.widthMm / 400) >= 2 - 0.05, "the minimum web survives a highlight");
  }
});

test("darker tone makes wider bars", () => {
  const wide = slatMask(uniformTone(400, 400, 0.9), {
    sheet: SHEET, pitchMm: 10, minWebMm: 2, minSlotMm: 3,
  });
  const narrow = slatMask(uniformTone(400, 400, 0.1), {
    sheet: SHEET, pitchMm: 10, minWebMm: 2, minSlotMm: 3,
  });
  const wideRun = runsOnRow(wide, 200)[0];
  const narrowRun = runsOnRow(narrow, 200)[0];
  assert.ok(wideRun > narrowRun, `dark ${wideRun}px should beat light ${narrowRun}px`);
});

test("every bar spans the full sheet, so no bar can be an island", () => {
  // The property that makes this style safe: connectivity is the frame's job
  // alone, because nothing here can float free of it.
  const tone = uniformTone(200, 200, 0.5);
  const mask = slatMask(tone, { sheet: SHEET, pitchMm: 10, minWebMm: 2, minSlotMm: 3 });
  const first = runsOnRow(mask, 0).length;
  assert.ok(first > 0, "there are bars");
  for (const y of [0, 50, 100, 199]) {
    assert.equal(runsOnRow(mask, y).length, first, `row ${y} has the same bars as the top`);
  }
});

test("horizontal slats read the picture the other way round", () => {
  const tone = { width: 200, height: 200, data: new Float32Array(200 * 200) };
  // Dark top half only.
  for (let y = 0; y < 100; y += 1) tone.data.fill(1, y * 200, y * 200 + 200);
  const mask = slatMask(tone, {
    sheet: SHEET, pitchMm: 10, minWebMm: 2, minSlotMm: 3, orientation: "horizontal",
  });
  let top = 0;
  let bottom = 0;
  for (let y = 0; y < 100; y += 1) for (let x = 0; x < 200; x += 1) {
    if (mask.data[y * 200 + x] === RETAINED) top += 1;
  }
  for (let y = 100; y < 200; y += 1) for (let x = 0; x < 200; x += 1) {
    if (mask.data[y * 200 + x] === RETAINED) bottom += 1;
  }
  assert.ok(top > bottom * 1.5, `dark half should hold more material: ${top} vs ${bottom}`);
});
