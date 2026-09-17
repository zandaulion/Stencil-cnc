import test from "node:test";
import assert from "node:assert/strict";

import { nextIssueReviewTarget } from "../../web/core/index.js";

const bounds = (x, y) => ({ minX: x, maxX: x, minY: y, maxY: y, width: 1, height: 1 });

test("manual issue review advances to the nearest surviving location in the same group", () => {
  const openingIssue = {
    code: "MIN_OPENING_UNCUTTABLE",
    severity: "error",
    details: {
      bounds: bounds(30, 30),
      locations: [
        { bounds: bounds(80, 80) },
        { bounds: bounds(35, 32) },
      ],
    },
  };

  const target = nextIssueReviewTarget([openingIssue], {
    code: "MIN_OPENING_UNCUTTABLE",
    severity: "error",
    bounds: bounds(30, 30),
  });

  assert.equal(target.issue, openingIssue);
  assert.equal(target.locationIndex, 1);
});

test("manual issue review advances to another blocker when the selected group is resolved", () => {
  const warning = { code: "MIN_WEB_THIN_AREAS", severity: "warning", details: { bounds: bounds(2, 2) } };
  const blocker = { code: "MIN_CUT_GAP", severity: "error", details: { bounds: bounds(70, 70) } };

  const target = nextIssueReviewTarget([warning, blocker], {
    code: "MIN_OPENING_UNCUTTABLE",
    severity: "error",
    bounds: bounds(10, 10),
  });

  assert.equal(target.issue, blocker);
  assert.equal(target.locationIndex, 0);
});

test("automatic recheck does not force a selection when review had no selected issue", () => {
  const blocker = { code: "MIN_CUT_GAP", severity: "error", details: { bounds: bounds(5, 5) } };
  assert.equal(nextIssueReviewTarget([blocker], { code: null }), null);
});
