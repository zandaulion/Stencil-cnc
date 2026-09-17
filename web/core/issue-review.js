function boundsCentre(bounds) {
  if (!bounds) return null;
  return {
    x: (bounds.minX + bounds.maxX + 1) / 2,
    y: (bounds.minY + bounds.maxY + 1) / 2,
  };
}

function reviewLocations(issue) {
  const locations = Array.isArray(issue?.details?.locations) && issue.details.locations.length > 0
    ? issue.details.locations
    : [issue?.details];
  return locations
    .map((details, locationIndex) => ({ issue, locationIndex, bounds: details?.bounds ?? issue?.details?.bounds }))
    .filter((entry) => entry.bounds);
}

/**
 * Finds the most useful next geometry issue after a manual edit. Prefer the
 * same issue group and the nearest surviving location; if that group has been
 * resolved, advance to the first remaining blocker and then to an advisory.
 */
export function nextIssueReviewTarget(issues, anchor = null) {
  const candidates = (issues ?? []).flatMap(reviewLocations);
  if (candidates.length === 0 || !anchor?.code) return null;

  const sameCode = candidates.filter((entry) => entry.issue.code === anchor.code);
  const blockers = candidates.filter((entry) => entry.issue.severity === "error");
  const sameSeverity = candidates.filter((entry) => entry.issue.severity === anchor.severity);
  const pool = sameCode.length > 0
    ? sameCode
    : blockers.length > 0
      ? blockers
      : sameSeverity.length > 0
        ? sameSeverity
        : candidates;
  const origin = boundsCentre(anchor.bounds);
  if (!origin) return pool[0];

  return pool.reduce((nearest, candidate) => {
    const point = boundsCentre(candidate.bounds);
    const distance = (point.x - origin.x) ** 2 + (point.y - origin.y) ** 2;
    return !nearest || distance < nearest.distance
      ? { ...candidate, distance }
      : nearest;
  }, null);
}
