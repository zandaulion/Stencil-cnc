const NICE_FACTORS = [1, 2, 2.5, 5, 10];

/** Choose a stable 1/2/5 ruler interval near the requested screen spacing. */
export function rulerStep(unitsPerPixel, targetSpacingPx = 84) {
  if (!Number.isFinite(unitsPerPixel) || unitsPerPixel <= 0 ||
      !Number.isFinite(targetSpacingPx) || targetSpacingPx <= 0) {
    throw new RangeError('Positive ruler scale and target spacing are required');
  }
  const requested = unitsPerPixel * targetSpacingPx;
  const magnitude = 10 ** Math.floor(Math.log10(requested));
  const normalized = requested / magnitude;
  const factor = NICE_FACTORS.reduce((nearest, candidate) => (
    Math.abs(Math.log(normalized / candidate)) < Math.abs(Math.log(normalized / nearest))
      ? candidate
      : nearest
  ));
  return factor * magnitude;
}

/**
 * Build physical ruler values and their positions in viewport pixels. The
 * offset and pixels-per-unit must come from the same transform as the artwork.
 */
export function rulerTicks({
  extent,
  pixelsPerUnit,
  offsetPx = 0,
  viewportStartPx = 0,
  viewportEndPx,
  targetSpacingPx = 84,
}) {
  if (!Number.isFinite(extent) || extent <= 0 ||
      !Number.isFinite(pixelsPerUnit) || pixelsPerUnit <= 0 ||
      !Number.isFinite(offsetPx) || !Number.isFinite(viewportStartPx) ||
      !Number.isFinite(viewportEndPx)) {
    throw new RangeError('Finite positive ruler dimensions and scale are required');
  }
  const step = rulerStep(1 / pixelsPerUnit, targetSpacingPx);
  if (viewportEndPx <= viewportStartPx) return { step, ticks: [] };

  const visibleStart = Math.max(0, (viewportStartPx - offsetPx) / pixelsPerUnit);
  const visibleEnd = Math.min(extent, (viewportEndPx - offsetPx) / pixelsPerUnit);
  if (visibleEnd < visibleStart) return { step, ticks: [] };

  const tolerance = step * 1e-9;
  const first = Math.max(0, Math.ceil((visibleStart - tolerance) / step) * step);
  const ticks = [];
  for (let value = first; value <= visibleEnd + tolerance; value += step) {
    const normalizedValue = Math.abs(value) < tolerance ? 0 : value;
    ticks.push({
      value: normalizedValue,
      positionPx: offsetPx + normalizedValue * pixelsPerUnit,
    });
    if (ticks.length > 10_000) throw new RangeError('Ruler generated too many ticks');
  }
  return { step, ticks };
}

export function formatRulerValue(value, step) {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return '';
  return value.toFixed(4).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
}
