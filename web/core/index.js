export {
  REMOVED,
  RETAINED,
  assertDimensions,
  assertMask,
  assertSameSize,
  assertSheet,
  cloneMask,
  countRetained,
  createMask,
  getMaskValue,
  maskFromBinary,
  maskFromImageData,
  pixelSizeMm,
  setMaskValue,
  unionMasks,
} from "./mask.js";
export { applyRectangularFrame, createRectangularFrameMask } from "./frame.js";
export {
  calculateArtworkPlacement,
  orientSheet,
  placeMaskOnSheet,
  pointFromArtworkPlacement,
  pointToArtworkPlacement,
  trimMaskToContent,
} from "./placement.js";
export { averageTone, toneFromImageData } from "./tone.js";
export { applySubjectMask, subjectMask } from "./subject.js";
export { slatMask } from "./styles/slats.js";
export { hatchMask } from "./styles/hatch.js";
export { analyzeConnectivity, findUnsupportedComponents } from "./connectivity.js";
export { applyCapsuleBridge, applyCapsuleBridges, validateBridge } from "./bridges.js";
export { connectedRegionIndices, physicalDiscIndices, physicalStrokeIndices } from "./editing.js";
export {
  MANUAL_EDIT_OPERATIONS,
  MANUAL_EDIT_SHAPES,
  manualEditIndices,
  normalizeManualEdit,
  normalizeManualEdits,
  rasterizeManualEdits,
  translateManualEdit,
} from "./manual-edits.js";
export {
  applySmallOpeningRepairPlan,
  mergeRepairLayerEdits,
  planCutGapRepairs,
  planLoosePieceRepairs,
  planManufacturingRepairs,
  planSmallOpeningRepairs,
  setSmallOpeningRepairAction,
} from "./repairs.js";
export { suggestBridges, suggestKerfAwareBridges, suggestSlatStabilizers } from "./suggestions.js";
export { dilateMaskPhysical, erodeMaskPhysical } from "./morphology.js";
export {
  FINISHED_BOUNDARY_CAM,
  GEOMETRY_INTERPRETATIONS,
  LEGACY_UNCOMPENSATED_CENTERLINE,
  isLegacyGeometryInterpretation,
  kerfErosionMm,
  normalizeGeometryInterpretation,
  rasterWebWidthMm,
  requiredOpeningMm,
} from "./geometry-contract.js";
export { countValidationLocations, issueLocationCount, validateDesign } from "./validation.js";
export { nextIssueReviewTarget } from "./issue-review.js";
export { zoomAroundPoint } from "./viewport.js";
export {
  CUTTING_PROFILE_SCHEMA,
  CUTTING_PROFILE_VERSION,
  createCuttingProfile,
  cuttingProfileVerificationProblems,
  legacyCuttingProfile,
  normalizeCuttingProfile,
} from "./cutting-profile.js";
export { formatRulerValue, rulerStep, rulerTicks } from "./rulers.js";
export { isCanvasShortcutTarget, isEditableShortcutTarget } from "./shortcuts.js";
export { contrastRatio, tabIndexForKey } from "./accessibility.js";
export { recommendStyleSettings } from "./style-guidance.js";
export { exportSvg, maskToSvg, traceMaskContours } from "./svg.js";
export { exportDxf, maskToDxf } from "./dxf.js";
export { DRAFT_WATERMARK_LABEL, drawDraftWatermark, maskToRgba } from "./png.js";
export { buildExportFilename, filenamePart, filenameTimestamp } from "./filenames.js";
export {
  PROJECT_SCHEMA,
  PROJECT_VERSION,
  createProject,
  decodeMask,
  deserializeProject,
  encodeMask,
  migrateProject,
  normalizeProject,
  projectWithSourceMask,
  serializeProject,
  upgradeProjectRecord,
} from "./project.js";
export { buildDesignMask, buildProjectDesign, validateProject } from "./pipeline.js";
export { reconcileProjectAcknowledgement } from "./sync-state.js";
export {
  createSyncRetryController,
  isRetryableSyncError,
  isStorageQuotaError,
  SYNC_RETRY_DELAYS_MS,
} from "./sync-policy.js";
export {
  CANDIDATE_PAYLOAD_VERSION,
  applyRasterLayers,
  maskFingerprint,
  retireConflictingRepairEdit,
} from "./candidates.js";
export { normalizeVectorDots, placeVectorDots, separateCircleContours } from "./vector-dots.js";
