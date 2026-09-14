import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const html = fs.readFileSync(path.join(projectRoot, 'web/index.html'), 'utf8');
const editor = fs.readFileSync(path.join(projectRoot, 'web/editor.js'), 'utf8');

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

test('Tools remains available beside the canvas and becomes a mobile bottom bar', () => {
  const css = fs.readFileSync(path.join(projectRoot, 'web/app.css'), 'utf8');
  assert.match(html, /id="tools-rail"[^>]*aria-labelledby="tools-title"/);
  assert.match(html, /id="tools-title">Tools</);
  for (const id of ['tool-pan', 'tool-icon-stencil', 'tool-keep', 'tool-remove', 'tool-support', 'tool-problems', 'btn-fit']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
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
  assert.match(html, /id="panel-margin"[^>]*value="0"/);
  assert.match(html, /id="placement-fit-version"[^>]*value="2"/);
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
