/**
 * Returns a zoom/pan transform that keeps one viewport point stationary.
 * Scaling around the top-left corner makes the operator chase the feature;
 * anchoring the point under the cursor makes wheel and trackpad zoom direct.
 */
export function zoomAroundPoint(transform, anchor, requestedZoom, limits = {}) {
  const minimum = limits.minimum ?? 0.05;
  const maximum = limits.maximum ?? 8;
  if (!Number.isFinite(transform?.zoom) || transform.zoom <= 0 ||
      !Number.isFinite(transform?.pan?.x) || !Number.isFinite(transform?.pan?.y)) {
    throw new TypeError('A positive zoom and finite pan are required');
  }
  if (!Number.isFinite(anchor?.x) || !Number.isFinite(anchor?.y)) {
    throw new TypeError('A finite zoom anchor is required');
  }
  if (!Number.isFinite(requestedZoom) || requestedZoom <= 0 ||
      !Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum <= 0 || maximum < minimum) {
    throw new RangeError('Zoom limits and requested zoom must be positive and ordered');
  }
  const zoom = Math.max(minimum, Math.min(requestedZoom, maximum));
  const worldX = (anchor.x - transform.pan.x) / transform.zoom;
  const worldY = (anchor.y - transform.pan.y) / transform.zoom;
  return {
    zoom,
    pan: {
      x: anchor.x - worldX * zoom,
      y: anchor.y - worldY * zoom,
    },
  };
}
