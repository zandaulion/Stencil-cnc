import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const html = fs.readFileSync(path.join(projectRoot, 'web/index.html'), 'utf8');
const editor = fs.readFileSync(path.join(projectRoot, 'web/editor.js'), 'utf8');
const css = fs.readFileSync(path.join(projectRoot, 'web/app.css'), 'utf8');

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

test('validated final geometry can be exported as a shareable PNG', () => {
  assert.match(html, /id="btn-export-png"[^>]*disabled/);
  assert.match(html, /Full-resolution black-and-white preview/);
  assert.match(editor, /\['btn-export-svg', 'btn-export-dxf', 'btn-export-png'\]/);
  assert.match(editor, /const mask = geometryForExport\(\)/);
  assert.match(editor, /downloadBlob\(`\$\{name\}\.png`, await pngBlob\(mask\)\)/);
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
    'repair-category-gaps', 'repair-category-webs', 'repair-layer-status',
    'btn-toggle-repair-layer', 'btn-clear-repair-layer',
  ]) assert.match(html, new RegExp(`id="${id}"`), id);
  for (const strategy of ['preserve', 'balanced', 'durable']) {
    assert.match(html, new RegExp(`name="openingRepairStrategy"[^>]*value="${strategy}"`), strategy);
  }
  for (const action of ['close', 'enlarge', 'merge']) {
    assert.match(html, new RegExp(`data-repair-action="${action}"`), action);
  }
  assert.match(editor, /planSmallOpeningRepairs\(candidate, validation/);
  assert.match(editor, /planCutGapRepairs\(candidate, validation/);
  assert.match(editor, /planLoosePieceRepairs\(candidate, validation/);
  assert.match(editor, /targetMinimumWebConnectivity: true/);
  assert.match(editor, /manufacturingRepairs: \{/);
  assert.match(editor, /state\.repairPreviewBaseMask/);
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

test('freehand material tools paint continuously but commit as one gesture', () => {
  assert.match(editor, /state\.touchupLive = mode === 'freehand'/);
  assert.match(editor, /scheduleLiveTouchupDraw\(\)/);
  assert.match(editor, /requestAnimationFrame\(\(\) => \{/);
  assert.match(editor, /paintSegment\(touchupStroke\.last, \{ x, y \}, \{/);
  assert.match(editor, /liveStructureMask: touchupStroke\.liveStructureMask/);
  assert.match(editor, /const kerf = !state\.touchupLive/);
  assert.match(editor, /state\.touchupLive = false;[\s\S]*?refresh\(\{ immediate: true \}\);[\s\S]*?pushHistory\(\)/);
});

test('Tools remains available beside the canvas and becomes a mobile bottom bar', () => {
  const css = fs.readFileSync(path.join(projectRoot, 'web/app.css'), 'utf8');
  assert.match(html, /id="tools-rail"[^>]*aria-labelledby="tools-title"/);
  assert.match(html, /id="tools-title">Tools</);
  for (const id of ['tool-pan', 'tool-icon-stencil', 'tool-keep', 'tool-remove', 'tool-support', 'tool-problems', 'btn-fit']) {
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
  assert.match(editor, /function smartBridgeStrategy\(\)/);
  assert.match(editor, /strategy\.preferredAngleDeg = barAngleDeg \+ 90/);
  assert.match(editor, /strategy: smartBridgeStrategy\(\)/);
  assert.match(editor, /minimumWebMm,\s*kerfMm,/);
  assert.match(html, /id="bridge-selection-meta"/);
  assert.match(editor, /bridge\.fallback === true/);
  assert.match(editor, /Safe shortest-path fallback/);
  assert.match(editor, /Planning smart supports/);
  assert.match(editor, /suggestKerfAwareBridges\(base\.mask/);
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

test('radial cuts automatically conceal their complete solid hub', () => {
  assert.match(html, /id="style-ray-center-auto"[^>]*type="checkbox" checked/);
  assert.match(html, /id="style-ray-center-x"[^>]*value="25" disabled/);
  assert.match(html, /id="style-ray-center-y"[^>]*value="50" disabled/);
  assert.match(editor, /form\.set\('centru_raze_automat'/);
  assert.match(editor, /radial\.matchedMetal/);
  assert.match(editor, /25% \/ 50% fallback/);
});

test('application markup has no duplicate element ids', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  assert.equal(duplicate, undefined, `duplicate id: ${duplicate}`);
});
