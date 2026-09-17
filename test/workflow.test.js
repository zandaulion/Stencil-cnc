import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const html = fs.readFileSync(path.join(projectRoot, 'web/index.html'), 'utf8');
const editor = fs.readFileSync(path.join(projectRoot, 'web/editor.js'), 'utf8');
const css = fs.readFileSync(path.join(projectRoot, 'web/app.css'), 'utf8');
const storage = fs.readFileSync(path.join(projectRoot, 'web/storage.js'), 'utf8');
const manifest = fs.readFileSync(path.join(projectRoot, 'web/manifest.webmanifest'), 'utf8');
const projectSync = fs.readFileSync(path.join(projectRoot, 'web/project-sync.js'), 'utf8');
const png = fs.readFileSync(path.join(projectRoot, 'web/core/png.js'), 'utf8');

test('Kerfloom is the public brand while project compatibility remains stable', () => {
  assert.match(html, /<title>Kerfloom — Art that holds together<\/title>/);
  assert.match(html, /Kerfloom by Zandaulion/);
  assert.match(html, /<strong>Kerfloom<\/strong>/);
  assert.match(manifest, /"name": "Kerfloom"/);
  assert.match(html, /rel="icon" href="\/icons\/kerfloom-48\.png"/);
  assert.match(manifest, /"src": "\/icons\/kerfloom-48\.png"/);
  assert.match(manifest, /"src": "\/icons\/kerfloom-256\.png"/);
  assert.match(manifest, /"src": "\/icons\/kerfloom-maskable-512\.png"/);
  assert.doesNotMatch(manifest, /"type": "image\/svg\+xml"/);
  assert.match(projectSync, /export const PROJECT_BUNDLE_SCHEMA = 'stencil-cnc\.share-bundle'/);
  assert.match(storage, /const LEGACY_DB_NAME = 'stencil-cnc'/);
  assert.match(storage, /const WORKSPACE_DB_PREFIX = 'stencil-cnc-workspace:';/);
  assert.match(storage, /export function configureStorageWorkspace/);
  assert.match(html, /Legacy browser projects available/);
  assert.match(editor, /permanently removed from this server workspace and every linked device/);
});

test('the creative workflow exposes every preview and a candidate workspace', () => {
  for (const id of [
    'view-original', 'view-tone', 'view-source', 'view-material', 'view-backlit', 'view-issues',
    'side-candidates', 'side-issues', 'candidate-list', 'btn-save-candidate',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(editor, /const CANDIDATE_LIMIT = 8/);
  assert.match(html, /The actual tonal field used before the cut pattern/);
  assert.match(editor, /payload\.tonePreview/);
  assert.match(editor, /function drawPlacedImage/);
  assert.match(editor, /baseMask: encodeMask\(state\.baseMask\)/);
  assert.match(editor, /payloadVersion: CANDIDATE_PAYLOAD_VERSION/);
  assert.match(editor, /manufacturingRepairs: \{/);
  assert.match(editor, /designFingerprint: maskFingerprint\(state\.designMask\)/);
  assert.match(editor, /preserveManufacturingRepairs: completePayload/);
  assert.match(editor, /restored exactly\. Revalidate before export/);
  assert.match(editor, /legacy candidate saved before repair layers were captured/);
  assert.match(editor, /function restoreCandidate[\s\S]*?refresh\(\{ immediate: true, preserveManufacturingRepairs: completePayload \}\)[\s\S]*?pushHistory\(\)[\s\S]*?\n}\n\nfunction duplicateCandidate/);
  assert.match(editor, /function refresh\([\s\S]*?invalidateValidation\(/);
  assert.match(editor, /function revealToneControls\(\)[\s\S]*?setStage\('prepare'\)[\s\S]*?adjustments\.open = true[\s\S]*?scrollIntoView/);
  assert.match(editor, /name === 'tone' && state\.view === 'tone'\) revealToneControls\(\)/);
});

test('readiness, storage, sharing, and input-format copy matches actual behavior', () => {
  assert.match(html, /id="save-state"[^>]*data-state="draft"[^>]*title="Loading workspace"/);
  assert.match(html, /id="save-state-label"[^>]*>Loading workspace…</);
  assert.match(html, /Candidates are saved with the project and sync across linked devices/);
  assert.match(html, /Photographs use private server analysis; saved Projects include the source in the encrypted workspace/);
  assert.match(html, /No separate share snapshot is created until you create the link/);
  assert.match(html, /Included when stored with the project/);
  assert.match(html, /accept="image\/png,image\/jpeg,image\/webp,application\/json,\.stencil\.json"/);
  assert.match(html, /convert HEIC\/HEIF first/);
  assert.match(editor, /HEIC\/HEIF import is not supported in this browser build/);

  assert.match(html, /Configured minimum \+ 0\.4 mm target margin/);
  assert.match(html, /not a strength or cut-process certification/);
  assert.match(editor, /Ready for CAM review/);
  assert.match(editor, /advisory .*before CAM review/);
  assert.doesNotMatch(editor, /The panel holds together|Ready to cut|manufacturing-safe gap|Safe preview|Unsafe preview|safe fallback/i);

  assert.match(editor, /const syncResult = await syncStoredProject\(saved\)/);
  assert.match(editor, /const syncedProjectId = syncResult\.projectId \|\| saved\.id/);
  assert.doesNotMatch(editor, /await loadProjectState\(saved\);[\s\S]{0,180}setSaveState\('saved'/);
  assert.match(editor, /Portable project downloaded without the source photograph/);
});

test('the desktop editor stays within the viewport while side panels scroll internally', () => {
  const app = fs.readFileSync(path.join(projectRoot, 'web/app.js'), 'utf8');
  assert.match(app, /document\.body\.classList\.add\('editor-open'\)/);
  assert.match(app, /document\.body\.classList\.remove\('editor-open'\)/);
  assert.match(css, /body\.editor-open \{[\s\S]*?height: 100dvh;[\s\S]*?overflow: hidden;/);
  assert.match(css, /#app-main,\s*\.app-shell \{[\s\S]*?height: 100dvh;[\s\S]*?max-height: 100dvh;/);
  assert.match(css, /@media \(max-width: 1020px\)[\s\S]*?\.editor-layout \{[\s\S]*?grid-template-rows: minmax\(0, 1fr\);[\s\S]*?overflow: hidden;/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?body\.editor-open \{[\s\S]*?overflow: auto;/);
});

test('server-backed project management is searchable, recoverable, and offline safe', () => {
  for (const id of [
    'btn-projects', 'btn-projects-mobile', 'btn-sync-mobile', 'btn-undo-mobile', 'btn-redo-mobile',
    'project-library-dialog', 'project-search', 'project-status-filter',
    'project-list', 'project-count-active', 'project-count-trash', 'rename-project-dialog',
    'version-dialog', 'version-list', 'save-state-label', 'sync-pending-count',
    'btn-save-project', 'project-library-draft', 'btn-save-draft',
    'project-library-cleanup', 'btn-clean-conflicts',
  ]) assert.match(html, new RegExp(`id="${id}"`), id);
  for (const action of ['open', 'rename', 'duplicate', 'download', 'versions', 'trash', 'restore', 'delete']) {
    assert.match(editor, new RegExp(`projectAction\\([^\\n]+['"]${action}['"]`), action);
  }
  assert.match(editor, /async function flushPendingSave\(\)/);
  assert.match(editor, /const LOCAL_SAVE_DELAY_MS = 160/);
  assert.match(editor, /const SERVER_SYNC_DELAY_MS = 1200/);
  assert.match(editor, /setTimeout\(\(\) => void persistLocally\(\), delay\)/);
  assert.match(editor, /setTimeout\(\(\) => void syncPendingSave\(\), delay\)/);
  assert.match(editor, /visibilityState === 'hidden'[\s\S]*flushLocalForLifecycle\(\)/);
  assert.match(editor, /addEventListener\('pagehide', flushLocalForLifecycle\)/);
  assert.match(editor, /pauseAutomaticSyncRetry\(\)[\s\S]*flushPendingLocalSave\(\)/);
  assert.match(editor, /visibilityState === 'hidden'[\s\S]*syncWorkspaceProjects\(\{ announce: false \}\)/);
  assert.match(editor, /Local cache failed — Retry/);
  assert.match(editor, /Server sync failed — Tap Sync/);
  assert.match(editor, /Device storage full — latest edit not cached/);
  assert.match(editor, /createSyncRetryController/);
  assert.match(editor, /setPendingSaveState\(\{ retryDelayMs: delayMs \}\)/);
  assert.match(editor, /if \(!locallySaved \|\| state\.dirty\) return \{ status: 'local-save-failed' \}/);
  assert.match(editor, /await flushPendingSave\(\)/);
  assert.match(editor, /serializeProject\(record, \{ pretty: true \}\)/);
  assert.match(editor, /saveCheckpoint\(project, label\)/);
  assert.match(editor, /function drawProjectThumbnail\(sourceWidth, sourceHeight, metalAt, panel\)/);
  assert.match(editor, /encodedProjectMaskThumbnail\([\s\S]*record\.sheet/);
  assert.match(editor, /hydrateProjectThumbnails\(rows, renderToken\)/);
  assert.match(storage, /const CHECKPOINT_LIMIT = 10/);
  assert.match(storage, /const SYNC_STORE = 'projectSync'/);
  assert.match(storage, /export async function putProjectSync/);
  assert.match(storage, /export async function replaceProjectSyncOperation/);
  assert.match(storage, /transaction\(\[PROJECT_STORE, META_STORE\], 'readwrite'/);
  assert.match(storage, /localSyncPending: localDraft \? false : record\.localSyncPending !== false/);
  assert.match(storage, /LOCAL_DRAFT_PROJECT_ID = 'kerfloom-local-draft'/);
  assert.match(storage, /includeDraft \|\| row\.localDraft !== true/);
  assert.match(storage, /pending\.localChangeId === local\?\.localChangeId/);
  assert.match(projectSync, /export async function buildProjectBundle/);
  assert.match(projectSync, /export async function prepareProjectUpload/);
  assert.match(projectSync, /'Content-Encoding': upload\.contentEncoding/);
  assert.match(projectSync, /record\.localSyncPending && !pending\.has\(record\.id\)/);
  assert.match(projectSync, /!cached\?\.localSyncPending/);
  assert.match(projectSync, /export async function synchronizeProjectLibrary/);
  assert.match(projectSync, /project\.localSyncPending \|\| !project\.serverRevision/);
  assert.match(projectSync, /'If-Match': `"\$\{operation\.expectedRevision\}"`/);
  assert.match(projectSync, /status: 'conflict'/);
  assert.match(projectSync, /const newId = `conflict-\$\{identity\.slice\(0, 32\)\}`/);
  assert.match(projectSync, /isConflictCopyOperation/);
  assert.match(projectSync, /return rebaseConflictCopy\(active, error\.details\)/);
  assert.match(projectSync, /failures,[\s\S]*remapped,/);
  assert.match(editor, /result\.remapped\?\.find[\s\S]*state\.projectId = remappedProject\.id/);
  assert.match(editor, /activeId !== record\.id[\s\S]*await setLastProject\(activeId\)/);
  assert.match(editor, /Saved · “\$\{shortName\}” needs sync attention/);
  assert.match(projectSync, /Offline|navigator\.onLine/);
  assert.match(html, /Encrypted server workspace/);
  assert.match(editor, /Saved to server at/);
  assert.match(editor, /async function saveDraftAsProject/);
  assert.match(editor, /findDuplicateConflictGroups/);
  const editorStartup = editor.slice(editor.indexOf('export async function startEditor'));
  assert.ok(
    editorStartup.indexOf('await loadLastProject()') < editorStartup.indexOf('syncWorkspaceProjects({ announce: false })'),
    'the last local project must open before background server synchronization',
  );
  assert.match(storage, /const \{ localSource: _localSource, \.\.\.portableProject \} = project/);
  assert.match(storage, /export async function trashProject/);
  assert.match(storage, /export async function restoreProject/);
  assert.match(css, /\.project-library-dialog/);
  assert.match(css, /\.project-grid \{[\s\S]*?grid-auto-rows: max-content/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.project-library-dialog/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.mobile-projects-tool \{[\s\S]*?display: flex/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.mobile-sync-tool \{[\s\S]*?display: flex/);
  assert.match(css, /\.mobile-sync-tool\[data-state="queued"\]/);
  assert.match(css, /\.mobile-sync-tool\[data-state="offline"\]/);
  assert.match(css, /\.mobile-sync-tool\[data-state="warning"\]/);
  assert.match(editor, /\['btn-projects', 'btn-projects-mobile'\]/);
  assert.match(editor, /\['save-state', 'btn-sync-mobile'\]/);
  assert.match(editor, /\['btn-undo', 'btn-undo-mobile'\]/);
  assert.match(editor, /\['btn-redo', 'btn-redo-mobile'\]/);
});

test('server snapshots explicitly share complete projects and remain revocable', () => {
  for (const id of [
    'share-project-dialog', 'share-expiry', 'btn-create-share', 'share-link',
    'share-history', 'received-share-dialog', 'btn-import-shared-project',
  ]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(editor, /return buildProjectBundle\(record\)/);
  assert.match(projectSync, /schema: PROJECT_BUNDLE_SCHEMA[\s\S]*project: JSON\.parse\(serializeProject\(record\)\)[\s\S]*source,[\s\S]*checkpoints:[\s\S]*artifacts:/);
  assert.match(editor, /application\/vnd\.stencil-cnc\.share\+json/);
  assert.match(editor, /\/api\/shares\?expiresDays=/);
  assert.match(editor, /X-Share-Token/);
  assert.match(editor, /importReceivedShare/);
  assert.match(storage, /const ARTIFACT_STORE = 'artifacts'/);
  assert.match(storage, /export async function saveArtifact/);
  assert.match(storage, /export async function importCheckpoint/);
  assert.match(css, /\.share-project-dialog/);
});

test('PNG previews remain available before validation and are visibly marked as drafts', () => {
  assert.match(html, /id="btn-export-png"[^>]*disabled/);
  assert.match(html, /Draft previews include a validation watermark/);
  assert.match(html, /File names include the project, panel size, cut style, frame choice, purpose, and validation or preview timestamp/);
  assert.match(editor, /for \(const id of \['btn-export-svg', 'btn-export-dxf'\]\)/);
  assert.match(editor, /pngButton\?\.toggleAttribute\('disabled', !hasGeometry\)/);
  assert.match(editor, /const mask = geometryForExport\(\)/);
  assert.match(editor, /const draft = kind === 'png' && !validated/);
  assert.match(png, /KERFLOOM DRAFT · NOT VALIDATED FOR CUTTING/);
  assert.match(editor, /filename = exportFilename\('png', undefined, \{ draft \}\)[\s\S]*blob = await pngBlob\(mask, \{ draft, exactCircleHoles: previewCircleHoles \}\)[\s\S]*downloadBlob\(filename, blob\)/);
  assert.match(editor, /purpose: projectFile \? 'editable' : kind === 'png' \? draft \? 'draft-preview' : 'preview' : 'cut'/);
  assert.match(editor, /if \(kind !== 'png' && !validated\)/);
  assert.match(editor, /state\.exportTimestamp = state\.validation\.valid \? new Date\(\) : null/);
  assert.match(editor, /el\('btn-export-png'\)\?\.addEventListener\('click', \(\) => exportGeometry\('png'\)\)/);
});

test('automatic supports stay separate and advertise when artwork made them stale', () => {
  assert.match(html, /id="automatic-support-stale"/);
  assert.match(html, /id="automatic-support-action"/);
  assert.match(editor, /state\.bridges = \[\.\.\.manual, \.\.\.suggested\]/);
  assert.match(editor, /markAutomaticSupportsStale\(\)/);
  assert.match(editor, /bridge\.source === 'automatic'/);
});

test('grouped manufacturing errors retain locatable geometry', () => {
  assert.match(editor, /function activeIssueDetails\(issue\)/);
  assert.match(editor, /details\?\.locations/);
  assert.match(editor, /highlighted\?\.phase === 'opening'/);
  assert.match(editor, /Array\.isArray\(activeDetails\.points\)/);
  assert.match(editor, /issue\.details\?\.locations\?\.length/);
});

test('manufacturing errors offer a combined reversible preview with per-occurrence overrides', () => {
  for (const id of [
    'repair-panel', 'btn-preview-repairs', 'repair-safety', 'repair-preview',
    'btn-repair-next', 'repair-similar', 'btn-discard-repairs',
    'btn-apply-repairs', 'btn-undo-repair', 'repair-category-slivers',
    'repair-category-gaps', 'repair-category-webs', 'repair-error-step',
    'repair-warning-step', 'btn-preview-warning-repairs', 'repair-warning-readiness', 'repair-layer-status',
    'btn-toggle-repair-layer', 'btn-clear-repair-layer', 'repair-plan-status',
    'repair-plan-note',
  ]) assert.match(html, new RegExp(`id="${id}"`), id);
  for (const strategy of ['preserve', 'balanced', 'durable']) {
    assert.match(html, new RegExp(`name="openingRepairStrategy"[^>]*value="${strategy}"`), strategy);
  }
  for (const action of ['close', 'enlarge', 'merge']) {
    assert.match(html, new RegExp(`data-repair-action="${action}"`), action);
  }
  assert.match(editor, /planManufacturingRepairs\(mask/);
  assert.match(editor, /maximumBridges: 192/);
  assert.match(editor, /if \(mode === 'warnings'\)/);
  assert.match(editor, /warnings: false/);
  assert.ok(html.indexOf('id="repair-error-step"') < html.indexOf('id="repair-warning-step"'));
  assert.match(html, /id="btn-preview-warning-repairs"[^>]*disabled/);
  assert.match(editor, /plan\.outcome\.safeToApply/);
  assert.match(editor, /state\.repairPlan\.outcome\?\.safeToApply !== true/);
  assert.match(editor, /state\.repairItemIndex = Math\.min\(state\.repairItemIndex, plan\.items\.length - 1\)/);
  assert.match(editor, /manufacturingRepairs: \{/);
  assert.match(editor, /state\.repairPreviewBaseMask/);
  assert.match(editor, /state\.repairPreviewUsesExistingLayer/);
  assert.match(editor, /mergeRepairLayerEdits\(/);
  assert.match(editor, /setSmallOpeningRepairAction\(state\.repairPlan/);
  assert.match(editor, /await runValidation\(\)/);
  assert.match(editor, /function undoLastRepair\(\)/);
  assert.match(editor, /Repair close cuts/);
  assert.match(editor, /Remove tiny loose pieces/);
  assert.match(html, /id="repair-enlarge-label"/);
});

test('manual geometry tools use physical gestures, previews, and snapping', () => {
  for (const id of [
    'touchup-options', 'touchup-size', 'touchup-safety',
    'support-snap', 'support-follow-style',
  ]) assert.match(html, new RegExp(`id="${id}"`), id);
  for (const mode of ['freehand', 'straight', 'region']) {
    assert.match(html, new RegExp(`name="touchupMode" value="${mode}"`), mode);
  }
  assert.match(editor, /physicalStrokeIndices\(/);
  assert.match(editor, /function touchupFootprintIntersectsMask[\s\S]*?physicalDiscIndices[\s\S]*?length > 0/);
  assert.match(editor, /const canStart = mode === 'region'[\s\S]*?inside[\s\S]*?touchupFootprintIntersectsMask\(\{ x, y \}\)/);
  assert.match(editor, /connectedRegionIndices\(/);
  assert.match(editor, /state\.bridgePreview = \{ start: drawingFrom, end/);
  assert.match(editor, /function bridgeHandleAtPointer\(/);
  assert.match(editor, /function nearestRetainedPoint\(/);
  assert.match(editor, /promoteBridgeToManual\(draggingBridge\.bridge\)/);
});

test('supports are easy to select, move, resize, rotate, and delete', () => {
  for (const id of [
    'bridge-selection', 'selected-bridge-width', 'selected-bridge-length',
    'selected-bridge-angle', 'btn-delete-bridge',
  ]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /Drag the support[\s\S]*round endpoint/);
  assert.match(html, /Arrow keys move 1 mm[\s\S]*Delete removes/);
  assert.match(editor, /hoveredBridge: null/);
  assert.match(editor, /manualSupportPoint\([\s\S]*\{ followDirection: false \}/);
  assert.match(editor, /event\.pointerType === 'touch' \? 24 : 14/);
  assert.match(editor, /function setBridgeGeometry\(/);
  assert.match(editor, /function translateBridge\(/);
  assert.match(editor, /return 'move'/);
  assert.match(editor, /\(event\.key === 'Delete' \|\| event\.key === 'Backspace'\)/);
  assert.match(editor, /\['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'\]/);
  assert.match(editor, /beginBridgeDrag\(event, hit, handle \|\| 'move'\)/);
});

test('freehand material tools paint continuously but commit as one gesture', () => {
  assert.match(editor, /state\.touchupLive = mode === 'freehand'/);
  assert.match(editor, /scheduleLiveTouchupDraw\(\)/);
  assert.match(editor, /requestAnimationFrame\(\(\) => \{/);
  assert.match(editor, /paintSegment\(touchupStroke\.last, \{ x, y \}, \{/);
  assert.match(editor, /liveStructureMask: touchupStroke\.liveStructureMask/);
  assert.doesNotMatch(editor, /else if \(touchupStroke\) \{\s*if \(!inside\) return/);
  assert.match(editor, /touchupStroke\.mode === 'freehand'\) \{\s*touchupStroke\.changed = paintSegment\(touchupStroke\.last, releasePoint/);
  assert.match(editor, /const kerf = !state\.touchupLive/);
  assert.match(editor, /state\.touchupLive = false;[\s\S]*?refresh\(\{ immediate: true \}\);[\s\S]*?pushHistory\(\)/);
});

test('Tools remains available beside the canvas and becomes a mobile bottom bar', () => {
  const css = fs.readFileSync(path.join(projectRoot, 'web/app.css'), 'utf8');
  assert.match(html, /id="tools-rail"[^>]*aria-labelledby="tools-title"/);
  assert.match(html, /id="tools-title">Tools</);
  for (const id of ['btn-projects-mobile', 'tool-pan', 'tool-icon-stencil', 'tool-keep', 'tool-remove', 'tool-support', 'tool-problems', 'btn-fit']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /id="btn-fit-toolbar"[^>]*>Fit<\/button>/);
  assert.match(html, /id="tool-icon-stencil"[^>]*aria-keyshortcuts="I"/);
  assert.match(html, /id="tool-icon-stencil"[^>]*aria-label="Apply Icon stencil style and open its settings"/);
  assert.match(html, /<span>Icon style<\/span>/);
  for (const id of ['tool-icon-stencil', 'tool-keep', 'tool-remove', 'tool-support']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*aria-controls="tool-options-panel"`));
  }
  assert.match(html, /id="tool-options-panel"[^>]*hidden/);
  assert.match(editor, /function activateIconStencil\(\)[\s\S]*?value="icoana"/);
  assert.match(editor, /function activateTouchupTool\(tool\)[\s\S]*?openToolOptions\(tool\)/);
  assert.match(editor, /function openToolOptions\(kind\)/);
  assert.match(editor, /nodes: Object\.freeze\(\['touchup-tool-settings'\]\)/);
  assert.match(editor, /nodes: Object\.freeze\(\['support-tool-settings'\]\)/);
  assert.match(editor, /const active = toolOptionsKind === 'icon' \? 'icon' : state\.tool/);
  assert.match(editor, /function closeToolOptions\(\{ returnFocus = false \} = \{\}\)/);
  assert.match(editor, /el\('tool-icon-stencil'\)\?\.addEventListener\('click', activateIconStencil\)/);
  assert.match(editor, /if \(editableTarget \|\| !canvasContext\) return;/);
  assert.match(editor, /if \(!canvasContext\) return;/);
  assert.doesNotMatch(html, /class="tool-grid"/);
  assert.match(editor, /state\.drawingBridge = tool === 'support'/);
  assert.match(editor, /\['btn-fit', 'btn-fit-toolbar'\]/);
  assert.match(editor, /el\('btn-add-bridge'\)\?\.addEventListener\('click', activateSupportTool\)/);
  assert.doesNotMatch(editor, /stage !== 'prepare' && state\.tool !== 'pan'/);
  assert.match(css, /grid-template-columns: 318px 64px minmax\(480px, 1fr\) 296px/);
  assert.match(css, /\.tools-rail \{[\s\S]*?position: fixed;[\s\S]*?bottom: 0;/);
});

test('smart supports use a global filter-aware aesthetic strategy', () => {
  assert.match(html, /id="bridge-count"[^>]*value="2"/);
  assert.match(html, /id="bridge-count-value"[^>]*>Aesthetic</);
  assert.match(html, /id="protect-faces"[^>]*type="checkbox" checked/);
  assert.doesNotMatch(html, /id="protect-faces"[^>]*disabled/);
  assert.match(html, /id="support-follow-features"[^>]*type="checkbox" checked/);
  assert.match(editor, /function smartBridgeStrategy\(/);
  assert.match(editor, /function bridgeImageSamplers\(\)/);
  assert.match(editor, /const analysisMaximumDimension = 768/);
  assert.match(editor, /const portraitRisk = faceInterior \* lightSkinLikelihood/);
  assert.match(editor, /featureAt: imageSamplers\.featureAt/);
  assert.match(editor, /el\('support-follow-features'\)\?\.addEventListener\('change', supportPlanChanged\)/);
  assert.match(editor, /strategy\.preferredAngleDeg = barAngleDeg \+ 90/);
  assert.match(editor, /const planWith = \(candidateStrategy\) => suggestKerfAwareBridges/);
  assert.match(editor, /strategy: candidateStrategy/);
  assert.match(editor, /minimumWebMm,\s*kerfMm,/);
  assert.match(html, /id="bridge-selection-meta"/);
  assert.match(editor, /bridge\.fallback === true/);
  assert.match(editor, /Shortest-path fallback/);
  assert.match(editor, /Planning smart supports/);
  assert.match(editor, /suggestKerfAwareBridges\(base\.mask/);
  assert.match(editor, /Feature-following support scoring failed; retrying without it/);
  assert.match(editor, /smartBridgeStrategy\(\{ sampleImage: false \}\)/);
  assert.match(editor, /Image guidance was unavailable, so structural placement was used/);
  assert.match(editor, /Support planning failed before changing the geometry/);
  assert.match(editor, /supportSimulation\.postKerf\.componentCount === 1/);
  assert.match(html, /id="connectivity-detail"/);
  assert.match(editor, /Everything is one connected finished piece/);
  assert.match(editor, /MIN_WEB_DISCONNECT/);
  assert.match(editor, /Geometry must be repaired before export/);
});

test('slats add a configurable staggered structural stabilization pass', () => {
  assert.match(html, /id="stabilize-slats"[^>]*type="checkbox" checked/);
  assert.match(html, /id="max-cantilever"[^>]*value="250"/);
  assert.match(html, /id="stabilizer-organic"[^>]*value="75"/);
  assert.doesNotMatch(html, /id="max-cantilever"[^>]*disabled/);
  assert.match(editor, /strategy\.slatPitchMm = toMm\(numberField\('style-pitch', 38\)\) \* placedStyleScale\(\)/);
  assert.match(editor, /strategy\.maximumUnsupportedSpanMm = toMm\(numberField\('max-cantilever', 250\)\)/);
  assert.match(editor, /strategy\.organicVariation = numberField\('stabilizer-organic', 75\) \/ 100/);
  assert.match(editor, /bridge\.stabilizer/);
  assert.match(html, /Controls slat span/);
});

test('server rendering has a visible queued and in-flight progress state', () => {
  for (const id of ['render-progress', 'render-progress-title', 'render-progress-detail']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /id="render-progress"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(editor, /setRenderProgress\('queued'\)/);
  assert.match(editor, /setRenderProgress\('running', requestedStyle\)/);
  assert.match(editor, /viewport\?\.setAttribute\('aria-busy', String\(visible\)\)/);
});

test('a new editor opens on an unlinked 1250 by 2500 mm panel', () => {
  assert.match(html, /id="panel-width"[^>]*value="1250"/);
  assert.match(html, /id="panel-height"[^>]*value="2500"/);
  assert.match(html, /id="btn-link-dimensions"[^>]*aria-pressed="false"/);
  assert.match(editor, /numberField\('panel-width', 1250\)/);
  assert.match(editor, /numberField\('panel-height', 2500\)/);
  assert.match(html, /name="panelOrientation" value="portrait" checked/);
  assert.match(html, /name="panelOrientation" value="landscape"/);
  assert.match(editor, /orientSheet\(sheet\(\), node\.value\)/);
});

test('panel presets provide standard sizes and remain orientation-aware', () => {
  assert.match(html, /id="panel-size-preset"/);
  for (const [value, dimensions] of [
    ['a0', '841 × 1189'],
    ['a1', '594 × 841'],
    ['a2', '420 × 594'],
    ['a3', '297 × 420'],
    ['a4', '210 × 297'],
    ['sheet-1250-2050', '1250 × 2050'],
    ['sheet-1250-2500', '1250 × 2500'],
  ]) {
    assert.match(html, new RegExp(`value="${value}"[^>]*>[^<]*${dimensions}`), value);
  }
  assert.match(html, /value="custom">Custom/);
  assert.match(editor, /const PANEL_SIZE_PRESETS = Object\.freeze/);
  assert.match(editor, /orientSheet\(preset, selectedPanelOrientation\(\)\)/);
  assert.match(editor, /syncPanelSizePreset\(\{ preserveCustom: true \}\)/);
  assert.match(editor, /el\('panel-size-preset'\)\?\.addEventListener\('change'/);
});

test('artwork can be positioned, rotated, and zoomed as persistent geometry', () => {
  for (const id of [
    'artwork-scale', 'artwork-rotation', 'artwork-offset-x', 'artwork-offset-y',
    'btn-position-artwork', 'btn-reset-artwork-transform',
  ]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(editor, /artworkTransform: artworkTransform\(\)/);
  assert.match(editor, /pointFromArtworkPlacement\(/);
  assert.match(editor, /pointToArtworkPlacement\(/);
  assert.match(editor, /state\.tool === 'artwork'/);
  assert.match(editor, /draggingArtwork/);
  assert.match(editor, /context\.rotate\(\(state\.placement\.rotationDeg \|\| 0\)/);
});

test('versioned cutting profiles remain provisional until the shop records evidence', () => {
  assert.match(html, /value="general-plasma" selected>General plasma starting point/);
  assert.match(html, /id="cutting-profile-status"[^>]*data-status="provisional"[^>]*>Provisional/);
  for (const id of [
    'cutting-profile-name', 'cutting-profile-process', 'cutting-profile-material',
    'cutting-profile-grade', 'cutting-profile-thickness', 'cutting-profile-machine',
    'cutting-profile-consumable', 'cutting-profile-provenance', 'cutting-profile-evidence',
    'cutting-profile-verified-by', 'btn-verify-cutting-profile',
  ]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /Profile identity &amp; verification evidence/);
  assert.match(html, /Provisional profiles guide geometry but are not evidence that a setup has been tested/);
  assert.match(editor, /profile: cuttingProfileFromControls\(\)/);
  assert.match(editor, /profileSnapshot: cuttingProfileFromControls\(\)/);
  assert.match(storage, /profileSnapshot: artifact\.profileSnapshot[\s\S]*?normalizeCuttingProfile/);
  assert.match(projectSync, /profileSnapshot: artifact\.profileSnapshot \?\? null/);
  assert.match(editor, /cuttingProfileVerificationProblems\(candidate\)/);
  assert.match(editor, /state\.lastValidatedAt = null/);
  assert.match(editor, /function restore\(serialised\)[\s\S]*?applyControls\(data\.controls\);[\s\S]*?syncCuttingProfileControls\(data\.cuttingProfile/);
  assert.match(editor, /saved measurement unit is known[\s\S]*?syncCuttingProfileControls\(project\.manufacturing\.profile\)/);
  assert.match(html, /id="min-web"[^>]*min="2"[^>]*value="3"/);
  assert.match(html, /3 mm default, 2 mm lower exploration limit/);
  assert.match(html, /id="min-opening"[^>]*value="2"/);
  assert.match(editor, /const PLASMA_MIN_OPENING_MM = 2/);
  assert.match(editor, /const PLASMA_MIN_WEB_MM = 2/);
  assert.match(editor, /function enforcePlasmaLimits\(\)/);
  const prepareStart = html.indexOf('id="panel-prepare"');
  const panelStart = html.indexOf('id="panel-panel"');
  const supportStart = html.indexOf('id="panel-support"');
  const profile = html.indexOf('id="manufacturing-profile"');
  const polarity = html.indexOf('id="polarity"');
  assert.ok(polarity > prepareStart && polarity < panelStart, 'material polarity belongs in Prepare');
  assert.ok(profile > panelStart && profile < supportStart, 'plasma controls belong in Panel');
  assert.equal((html.match(/data-edit-manufacturing/g) ?? []).length, 2);
  assert.equal((html.match(/data-manufacturing-summary/g) ?? []).length, 2);
  assert.match(editor, /setStage\('panel'\)/);
  assert.match(editor, /manufacturing-settings/);
  assert.match(html, /id="bridge-width"[^>]*min="2"/);
  assert.match(html, /id="selected-bridge-width"[^>]*min="2"/);
  assert.match(editor, /form\.set\('punte_min_mm', String\(toMm\(numberField\('min-web', 3\)\)\)\)/);
  assert.match(editor, /form\.set\('kerf_mm', String\(toMm\(numberField\('kerf', 1\.2\)\)\)\)/);
  assert.match(editor, /form\.set\('interpretare_geometrie', state\.geometryInterpretation\)/);
  assert.match(editor, /form\.set\('fanta_min_mm', String\(Math\.max\(/);
  assert.match(html, /id="prekerf-web-note"/);
  assert.match(html, /id="preview-pre-kerf"[^>]*name="kerfPreview"/);
  assert.match(html, /id="simulate-kerf"[^>]*name="kerfPreview"[^>]*checked/);
  assert.match(editor, /state\.kerfPreviewMask = finishedGeometryPreview\(state\.designMask\)/);
  assert.match(html, /apply inside\/outside compensation once in CAM/i);
});

test('panel fitting uses visible generated artwork rather than empty source border', () => {
  assert.match(editor, /trimMaskToContent\(mask, visibleContentValue\(\)\)/);
  assert.match(editor, /state\.contentBounds = trimmed\.bounds/);
  assert.match(editor, /bounds\.width \/ sourceSize\.width \* preview\.width/);
  assert.match(editor, /fillLetterboxWithMetal: true/);
  assert.match(html, /id="panel-margin"[^>]*value="0"/);
  assert.match(html, /id="placement-fit-version"[^>]*value="2"/);
  assert.match(html, /fill unused axis with metal/);
  assert.match(editor, /Number\(controls\['panel-margin'\]\) === 35/);
});

test('photograph styles start from the benchmarked creative defaults', () => {
  const values = {
    'style-threshold': '50',
    'style-outline': '60',
    'style-icon-balance': '56',
    'style-icon-detail': '65',
    'style-icon-line-width': '3',
    'style-icon-simplify': '3',
    'style-icon-halo-scale': '135',
    'style-graphic-balance': '50',
    'style-graphic-detail': '70',
    'style-graphic-simplify': '1.5',
    'style-line-detail': '40',
    'style-wood-spacing': '12',
    'style-wood-length': '20',
    'style-silhouette-smooth': '8',
    'style-contour-levels': '5',
    'style-contour-width': '2.5',
    'style-ray-count': '64',
    'style-ray-center-x': '25',
    'style-ray-center-y': '50',
    'style-ray-cutoff': '12',
    'style-ornament-detail': '40',
    'style-pitch': '38',
    'style-slat-angle': '-55',
    'style-angle': '30',
    'style-row-pitch': '9',
    'style-cell': '12',
    'style-dot-pitch': '41',
    'style-dot-max': '33.8',
    'style-dot-angle': '10',
    'style-dot-cutoff': '42',
    'style-tone-brightness': '0',
    'style-tone-contrast': '0',
    'style-gain': '2.2',
    'style-smooth': '0.55',
    'style-curve': '1.4',
  };
  for (const [id, value] of Object.entries(values)) {
    assert.match(html, new RegExp(`id="${id}"[^>]*value="${value}"`), id);
  }
  assert.match(html, /id="style-cutout"[^>]*type="checkbox">/);
  assert.match(html, /id="style-clothes"[^>]*type="checkbox" checked>/);
  assert.match(html, /id="tone-adjustments"/);
  assert.match(html, /These adjustments change both the interpretation and the generated artwork/);
  assert.match(editor, /form\.set\('luminozitate_ton', String\(numberField\('style-tone-brightness', 0\)\)\)/);
  assert.match(editor, /form\.set\('contrast_ton', String\(numberField\('style-tone-contrast', 0\)\)\)/);
  assert.match(editor, /'style-tone-brightness', 'style-tone-contrast'/);
  assert.match(html, /id="style-photo-common"[\s\S]*?id="tone-inspector"[\s\S]*?id="style-curve-control"/);
  assert.match(css, /\.tone-inspector \{[\s\S]*?width: 100%;[\s\S]*?background: var\(--surface-2\)/);
  assert.doesNotMatch(css, /\.tone-inspector \{[^}]*position: absolute/);
  assert.match(editor, /const photoStyle = selectedCutStyle\(\) !== 'line-art';[\s\S]*?toggleAttribute\('hidden', !photoStyle\)/);
  assert.doesNotMatch(editor, /toggleAttribute\('hidden', state\.view !== 'tone' \|\| !preview\)/);
  assert.match(editor, /form\.set\('gamma', String\(numberField\('style-curve', 1\.4\)\)\)/);
  assert.match(html, /name="cutStyle" value="icoana"/);
  assert.match(html, /id="style-icon-halo"[^>]*type="checkbox" checked/);
  assert.match(html, /Only adds or removes the halo; it does not disable Icon stencil/);
  assert.match(editor, /const MANUAL_ONLY_STYLES = new Set\(\['icoana'\]\)/);
  assert.match(editor, /function resetManualStyleForNewImage\(\)[\s\S]*?value="line-art"[\s\S]*?state\.mode = 'line-art'/);
  assert.match(editor, /state\.validation = null;\s+resetManualStyleForNewImage\(\);\s+resetHistory\(\)/);
  assert.match(editor, /icoana: Object\.freeze\(\{/);
  assert.match(editor, /form\.set\('prag_icoana'/);
  assert.match(editor, /strategy\.preferredAngleDeg = 0/);
  assert.match(editor, /form\.set\('unghi_lamele', String\(numberField\('style-slat-angle', -55\)\)\)/);
  assert.match(editor, /lamele: Object\.freeze\(\{/);
  assert.match(editor, /'style-gain': '3'/);
  assert.match(editor, /'style-smooth': '0\.70'/);
  assert.match(editor, /'style-curve': '0\.8'/);
  assert.match(editor, /'style-cutout': true/);
  assert.match(editor, /styleSettings: cloneStyleSettings\(state\.styleSettings\)/);
  assert.match(html, /name="cutStyle" value="puncte"/);
  assert.match(html, /<strong>Variable dots<\/strong>/);
  assert.match(editor, /form\.set\('pas_puncte_mm'/);
  assert.match(editor, /form\.set\('diametru_max_puncte_mm'/);
  assert.match(editor, /puncte: Object\.freeze\(\{/);
  assert.match(editor, /puncte: Object\.freeze\(\{[\s\S]*?'style-gain': '3\.3'[\s\S]*?'style-smooth': '0\.30'[\s\S]*?'style-curve': '1\.2'[\s\S]*?'style-cutout': true[\s\S]*?'style-clothes': false/);
  assert.match(html, /name="cutStyle" value="flux"/);
  assert.match(html, /<strong>Flow engraving<\/strong>/);
  assert.match(html, /id="style-flow-follow"[^>]*value="72"/);
  assert.match(html, /id="style-flow-width"[^>]*value="7"/);
  assert.match(editor, /form\.set\('pas_flux_mm'/);
  assert.match(editor, /form\.set\('urmarire_flux'/);
  assert.match(editor, /flux: Object\.freeze\(\{[\s\S]*?'style-cutout': true[\s\S]*?'style-clothes': false/);
});

test('cut styles use a compact categorized picker on desktop and mobile', () => {
  assert.match(html, /id="style-picker-trigger"[^>]*aria-haspopup="dialog"[^>]*aria-controls="style-picker-dialog"/);
  assert.match(html, /<dialog[^>]*id="style-picker-dialog"[^>]*aria-labelledby="style-picker-title"/);
  for (const category of ['Prepared artwork', 'Portrait and stencil', 'Lines and engraving', 'Geometric patterns', 'Decorative']) {
    assert.match(html, new RegExp(`>${category}<`), category);
  }
  assert.equal((html.match(/name="cutStyle"/g) || []).length, 14);
  assert.match(editor, /function syncStylePicker\(\)/);
  assert.match(editor, /function openStylePicker\(\)/);
  assert.match(editor, /function positionStylePicker\(\)[\s\S]*?max-width: 720px/);
  assert.match(editor, /closeStylePicker\(\{ returnFocus: true \}\);[\s\S]*?activateStyleSettings/);
  assert.match(css, /\.style-picker-grid\s*\{[\s\S]*?grid-template-columns: repeat\(2/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.style-picker-dialog\s*\{[\s\S]*?inset: auto 0 0/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.style-picker-grid\s*\{[\s\S]*?grid-template-columns: 1fr/);
});

test('radial cuts expose an actual hub diameter and split rays outward', () => {
  assert.match(html, /Maximum rays <small>Rays split progressively toward the outside/);
  assert.match(html, /id="style-ray-count"[^>]*max="192"/);
  assert.match(html, /id="style-ray-hub"[^>]*value="50"/);
  assert.match(html, /id="style-ray-center-auto"[^>]*type="checkbox" checked/);
  assert.match(html, /id="style-ray-center-x"[^>]*value="25" disabled/);
  assert.match(html, /id="style-ray-center-y"[^>]*value="50" disabled/);
  assert.match(editor, /form\.set\('centru_raze_automat'/);
  assert.match(editor, /form\.set\('diametru_miez_raze_mm'/);
  assert.match(editor, /radial\.matchedMetal/);
  assert.match(editor, /25% \/ 50% fallback/);
});

test('Tone stays selectable after restoring a project without its server preview', () => {
  assert.match(html, /id="tone-inspector-copy"/);
  assert.match(editor, /const preview = lineArtTonePreview\(\);[\s\S]*?provisional: true/);
  assert.match(editor, /const tonePreview = currentTonePreview\(\);\s+const toneReady = Boolean\(tonePreview\)/);
  assert.match(editor, /Source luminance preview\. Re-render to reconstruct the exact artwork interpretation\./);
  assert.match(editor, /Source luminance preview; re-render for the exact interpretation/);
});

test('application markup has no duplicate element ids', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  assert.equal(duplicate, undefined, `duplicate id: ${duplicate}`);
});
