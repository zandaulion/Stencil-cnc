import assert from "node:assert/strict";
import test from "node:test";

import { RETAINED } from "../../web/core/mask.js";
import { applySubjectMask, subjectMask } from "../../web/core/subject.js";

/** A coloured disc on a differently coloured ground. */
function discImage(width, height, ground, disc, radius) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - width / 2;
      const dy = y - height / 2;
      const colour = dx * dx + dy * dy <= radius * radius ? disc : ground;
      const offset = (y * width + x) * 4;
      data[offset] = colour[0]; data[offset + 1] = colour[1];
      data[offset + 2] = colour[2]; data[offset + 3] = 255;
      }
  }
  return { width, height, data };
}

test("the subject is found by colour, not by brightness", () => {
  // Same luminance, different hue: a blue ground and a brown subject, which is
  // exactly the wall-versus-hair case a greyscale method cannot see at all.
  const image = discImage(120, 120, [78, 88, 104], [104, 86, 66], 34);
  const mask = subjectMask(image, { smoothPx: 2 });
  assert.equal(mask.data[60 * 120 + 60], RETAINED, "the middle of the disc is subject");
  assert.notEqual(mask.data[4 * 120 + 4], RETAINED, "the corner is background");
});

test("strictness decides how much survives", () => {
  const image = discImage(120, 120, [70, 80, 96], [110, 92, 70], 34);
  const count = (s) => {
    let total = 0;
    for (const v of subjectMask(image, { strictness: s, smoothPx: 2 }).data) {
      if (v === RETAINED) total += 1;
    }
    return total;
  };
  assert.ok(count(-0.6) >= count(0.6), "a stricter setting must not keep more");
  assert.throws(() => subjectMask(image, { strictness: 2 }), /between -1 and 1/,
    "the range is stated, so a value outside it is a mistake worth naming");
});

test("holes inside the subject are filled, so features survive", () => {
  // Eyes and nostrils often match the background's colour. Keeping them as
  // background would hand the styles a face with gaps where the features are.
  const image = discImage(120, 120, [70, 80, 96], [110, 92, 70], 40);
  for (let y = 52; y < 60; y += 1) for (let x = 52; x < 60; x += 1) {
    const offset = (y * 120 + x) * 4;
    image.data[offset] = 70; image.data[offset + 1] = 80; image.data[offset + 2] = 96;
  }
  const mask = subjectMask(image, { smoothPx: 1 });
  assert.equal(mask.data[56 * 120 + 56], RETAINED, "an enclosed patch belongs to the subject");
});

test("masking a tone field silences the background for both polarities", () => {
  const image = discImage(60, 60, [70, 80, 96], [110, 92, 70], 18);
  const mask = subjectMask(image, { smoothPx: 1 });
  const tone = { width: 60, height: 60, data: new Float32Array(3600).fill(0.8) };
  const masked = applySubjectMask(tone, mask);
  assert.equal(masked.data[2 * 60 + 2], 0, "no ink outside the subject");
  assert.ok(masked.data[30 * 60 + 30] > 0, "ink survives inside it");
});
