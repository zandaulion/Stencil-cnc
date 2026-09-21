import { pointToArtworkPlacement } from "./placement.js";

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Converts a photograph into a bounded, serializable luminance field. The
 * source pixels stay out of support/repair diagnostics and do not need to be
 * copied into the geometry Worker.
 */
export function createFeatureGuidance(imageData, {
  placement,
  bounds,
  sourceSize,
  protectDetail = false,
  followFeatures = false,
  maximumDimension = 768,
} = {}) {
  if ((!protectDetail && !followFeatures) || !imageData || !placement || !bounds || !sourceSize) return null;
  const { width, height, data } = imageData;
  if (!(width > 0 && height > 0) || !data || data.length < width * height * 4) return null;
  const scale = Math.min(1, maximumDimension / Math.max(width, height));
  const analysisWidth = Math.max(1, Math.round(width * scale));
  const analysisHeight = Math.max(1, Math.round(height * scale));
  const luminance = new Float32Array(analysisWidth * analysisHeight);
  const histogram = new Uint32Array(256);

  for (let y = 0; y < analysisHeight; y += 1) {
    const sourceY = analysisHeight === 1 ? 0 : Math.round(y / (analysisHeight - 1) * (height - 1));
    for (let x = 0; x < analysisWidth; x += 1) {
      const sourceX = analysisWidth === 1 ? 0 : Math.round(x / (analysisWidth - 1) * (width - 1));
      const offset = (sourceY * width + sourceX) * 4;
      const alpha = data[offset + 3] / 255;
      const value = (0.2126 * data[offset] + 0.7152 * data[offset + 1]
        + 0.0722 * data[offset + 2]) * alpha + 255 * (1 - alpha);
      luminance[y * analysisWidth + x] = value;
      histogram[Math.round(value)] += 1;
    }
  }

  const percentile = (ratio) => {
    const target = luminance.length * ratio;
    let total = 0;
    for (let value = 0; value < histogram.length; value += 1) {
      total += histogram[value];
      if (total >= target) return value;
    }
    return 255;
  };
  const darkPoint = percentile(0.05);
  const lightPoint = Math.max(darkPoint + 24, percentile(0.95));
  return {
    version: 1,
    width: analysisWidth,
    height: analysisHeight,
    luminance,
    darkPoint,
    lightPoint,
    placement: { ...placement },
    bounds: { ...bounds },
    sourceSize: { ...sourceSize },
    protectDetail: Boolean(protectDetail),
    followFeatures: Boolean(followFeatures),
  };
}

export function bridgeSamplersFromGuidance(guidance) {
  if (!guidance) return { detailAt: null, featureAt: null, fallbackDetailAt: null };
  const {
    width, height, luminance, darkPoint, lightPoint,
    placement, bounds, sourceSize, protectDetail, followFeatures,
  } = guidance;
  const toneRange = Math.max(1, lightPoint - darkPoint);
  const sourceLuminance = (x, y) => luminance[
    clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)
  ];
  const sampleSource = ({ x, y }) => {
    const local = pointToArtworkPlacement(placement, { x, y });
    if (local.x < 0 || local.y < 0 || local.x > 1 || local.y > 1) return null;
    const fullX = (bounds.x + local.x * bounds.width) / Math.max(1, sourceSize.width);
    const fullY = (bounds.y + local.y * bounds.height) / Math.max(1, sourceSize.height);
    const imageX = clamp(Math.round(fullX * (width - 1)), 0, width - 1);
    const imageY = clamp(Math.round(fullY * (height - 1)), 0, height - 1);
    const center = sourceLuminance(imageX, imageY);
    const gx = sourceLuminance(imageX + 1, imageY) - sourceLuminance(imageX - 1, imageY);
    const gy = sourceLuminance(imageX, imageY + 1) - sourceLuminance(imageX, imageY - 1);
    const lightness = clamp((center - darkPoint) / toneRange, 0, 1);
    const strength = clamp(Math.hypot(gx, gy) / Math.max(32, toneRange * 0.55), 0, 1);
    const portraitFocus = Math.max(0, 1 - Math.hypot((fullX - 0.5) / 0.42, (fullY - 0.43) / 0.48));
    const faceInterior = Math.max(0, 1 - Math.hypot((fullX - 0.5) / 0.35, (fullY - 0.43) / 0.34));
    const lightSkinLikelihood = clamp((lightness - 0.30) / 0.42, 0, 1);
    return {
      lightness,
      strength,
      tangentAngleDeg: Math.atan2(gy, gx) * 180 / Math.PI + 90 + (placement.rotationDeg || 0),
      portraitFocus,
      portraitRisk: faceInterior * lightSkinLikelihood,
    };
  };
  const detailAt = protectDetail ? (point) => {
    const sample = sampleSource(point);
    return sample ? Math.min(1, Math.max(sample.strength, sample.portraitFocus * 0.55)) : 0;
  } : null;
  return {
    detailAt: followFeatures ? null : detailAt,
    fallbackDetailAt: detailAt,
    featureAt: followFeatures ? (point) => {
      const sample = sampleSource(point);
      if (!sample) return { lightness: 1, strength: 0, tangentAngleDeg: 0, detail: 0, portraitRisk: 0 };
      return {
        ...sample,
        detail: protectDetail ? Math.min(1, Math.max(sample.strength, sample.portraitFocus * 0.55)) : 0,
        portraitRisk: protectDetail ? sample.portraitRisk : 0,
      };
    } : null,
  };
}

export function materializeBridgeStrategy(strategy) {
  if (!strategy?.featureGuidance) return strategy;
  return {
    ...strategy,
    ...bridgeSamplersFromGuidance(strategy.featureGuidance),
    featureGuidance: undefined,
  };
}
