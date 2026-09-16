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
    'view-original', 'view-source', 'view-material', 'view-backlit', 'view-issues',
    'side-candidates', 'side-issues', 'candidate-list', 'btn-save-candidate',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(editor, /const CANDIDATE_LIMIT = 8/);
  assert.match(editor, /baseMask: encodeMask\(state\.baseMask\)/);
});

test('server-backed project management is searchable, recoverable, and offline safe', () => {
  for (const id of [
    'btn-projects', 'btn-projects-mobile', 'btn-sync-mobile', 'btn-undo-mobile', 'btn-redo-mobile',
    'project-library-dialog', 'project-search', 'project-status-filter',
    'project-list', 'project-count-active', 'project-count-trash', 'rename-project-dialog',
    'version-dialog', 'version-list', 'save-state-label',
  ]) assert.match(html, new RegExp(`id="${id}"`), id);
  for (const action of ['open', 'rename', 'duplicate', 'download', 'versions', 'trash', 'restore', 'delete']) {
    assert.match(editor, new RegExp(`projectAction\\([^\\n]+['"]${action}['"]`), action);
  }
  assert.match(editor, /async function flushPendingSave\(\)/);
  assert.match(editor, /Local cache failed — Retry/);
  assert.match(editor, /Server sync failed — Retry/);
  assert.match(editor, /await flushPendingSave\(\)/);
  assert.match(editor, /serializeProject\(record, \{ pretty: true \}\)/);
  assert.match(editor, /saveCheckpoint\(project, label\)/);
  assert.match(editor, /function drawProjectThumbnail\(sourceWidth, sourceHeight, metalAt, panel\)/);
  assert.match(editor, /encodedProjectMaskThumbnail\([\s\S]*record\.sheet/);
  assert.match(editor, /hydrateProjectThumbnails\(rows, renderToken\)/);
  assert.match(storage, /const CHECKPOINT_LIMIT = 10/);
  assert.match(storage, /const SYNC_STORE = 'projectSync'/);
  assert.match(storage, /export async function putProjectSync/);
  assert.match(projectSync, /export async function buildProjectBundle/);
  assert.match(projectSync, /export async function synchronizeProjectLibrary/);
  assert.match(projectSync, /'If-Match': `"\$\{operation\.expectedRevision\}"`/);
  assert.match(projectSync, /status: 'conflict'/);
  assert.match(projectSync, /Offline|navigator\.onLine/);
  assert.match(html, /Encrypted server workspace/);
  assert.match(editor, /Saved to server at/);
  assert.match(storage, /const \{ localSource: _localSource, \.\.\.portableProject \} = project/);
  assert.match(storage, /export async function trashProject/);
  assert.match(storage, /export async function restoreProject/);
  assert.match(css, /\.project-library-dialog/);
  assert.match(css, /\.project-grid \{[\s\S]*?grid-auto-rows: max-content/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.project-library-dialog/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.mobile-projects-tool \{[\s\S]*?display: flex/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.mobile-sync-tool \{[\s\S]*?display: flex/);
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

test('validated final geometry can be exported as a shareable PNG', () => {
  assert.match(html, /id="btn-export-png"[^>]*disabled/);
  assert.match(html, /Full-resolution black-and-white preview/);
  assert.match(html, /File names include the project, panel size, cut style, frame choice, purpose, and validation timestamp/);
  assert.match(editor, /\['btn-export-svg', 'btn-export-dxf', 'btn-export-png'\]/);
  assert.match(editor, /const mask = geometryForExport\(\)/);
  assert.match(editor, /filename = exportFilename\('png'\)[\s\S]*blob = await pngBlob\(mask\)[\s\S]*downloadBlob\(filename, blob\)/);
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
  assert.match(editor, /Safe shortest-path fallback/);
  assert.match(editor, /Planning smart supports/);
  assert.match(editor, /suggestKerfAwareBridges\(base\.mask/);
  assert.match(editor, /Feature-following support scoring failed; retrying without it/);
  assert.match(editor, /smartBridgeStrategy\(\{ sampleImage: false \}\)/);
  assert.match(editor, /Image guidance was unavailable, so structural placement was used/);
  assert.match(editor, /Support planning failed before changing the geometry/);
  assert.match(editor, /supportSimulation\.postKerf\.componentCount === 1/);
  assert.match(html, /id="connectivity-detail"/);
  assert.match(editor, /Everything stays connected after kerf/);
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

test('the plasma profile drives every filter with 2 mm openings and 3 mm webs', () => {
  assert.match(html, /value="plasma" selected>Plasma · 2 mm holes · 3 mm gaps/);
  assert.match(html, /id="min-web"[^>]*value="3"/);
  assert.match(html, /id="min-opening"[^>]*value="2"/);
  assert.match(editor, /const PLASMA_MIN_OPENING_MM = 2/);
  assert.match(editor, /const PLASMA_MIN_WEB_MM = 3/);
  assert.match(editor, /function enforcePlasmaLimits\(\)/);
  const prepareStart = html.indexOf('id="panel-prepare"');
  const validateStart = html.indexOf('id="panel-validate"');
  const profile = html.indexOf('id="manufacturing-profile"');
  assert.ok(profile > prepareStart && profile < validateStart, 'plasma controls belong in Prepare');
  assert.match(html, /id="bridge-width"[^>]*min="3"/);
  assert.match(html, /id="selected-bridge-width"[^>]*min="3"/);
  assert.match(editor, /form\.set\('punte_min_mm', String\(toMm\(numberField\('min-web', 3\)\)\)\)/);
  assert.match(editor, /form\.set\('kerf_mm', String\(toMm\(numberField\('kerf', 1\.2\)\)\)\)/);
  assert.match(editor, /form\.set\('fanta_min_mm', String\(Math\.max\(/);
  assert.match(html, /id="prekerf-web-note"/);
  assert.match(html, /id="preview-pre-kerf"[^>]*name="kerfPreview"/);
  assert.match(html, /id="simulate-kerf"[^>]*name="kerfPreview"[^>]*checked/);
  assert.match(editor, /state\.kerfPreviewMask = kerfMm > 0/);
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
    'style-gain': '2.2',
    'style-smooth': '0.55',
    'style-curve': '1.4',
  };
  for (const [id, value] of Object.entries(values)) {
    assert.match(html, new RegExp(`id="${id}"[^>]*value="${value}"`), id);
  }
  assert.match(html, /id="style-cutout"[^>]*type="checkbox">/);
  assert.match(html, /id="style-clothes"[^>]*type="checkbox" checked>/);
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
});

test('cut styles use a compact categorized picker on desktop and mobile', () => {
  assert.match(html, /id="style-picker-trigger"[^>]*aria-haspopup="dialog"[^>]*aria-controls="style-picker-dialog"/);
  assert.match(html, /<dialog[^>]*id="style-picker-dialog"[^>]*aria-labelledby="style-picker-title"/);
  for (const category of ['Prepared artwork', 'Portrait and stencil', 'Lines and engraving', 'Geometric patterns', 'Decorative']) {
    assert.match(html, new RegExp(`>${category}<`), category);
  }
  assert.equal((html.match(/name="cutStyle"/g) || []).length, 13);
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

test('application markup has no duplicate element ids', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  assert.equal(duplicate, undefined, `duplicate id: ${duplicate}`);
});
