import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { chromium } from 'playwright';

import { AuthService } from '../../server/auth.js';
import { initDatabase } from '../../server/db.js';
import { createApp } from '../../server/index.js';
import {
  CANDIDATE_PAYLOAD_VERSION,
  applyRasterLayers,
  buildDesignMask,
  createMask,
  createProject,
  encodeMask,
  maskFingerprint,
  serializeProject,
} from '../../web/core/index.js';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kerfloom-browser-'));
const database = initDatabase(new DatabaseSync(':memory:'));
const auth = new AuthService(database, {
  adminToken: 'browser-test-admin-token',
  publicBaseUrl: 'http://127.0.0.1',
});
const app = createApp({
  db: database,
  auth,
  webDir: path.join(projectRoot, 'web'),
  shareDirectory: path.join(temporaryRoot, 'shares'),
  projectDirectory: path.join(temporaryRoot, 'projects'),
  projectEncryptionKey: 'browser-test-project-key'.repeat(4),
});

let browser;
let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});

test.after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
  database.close();
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

function patternedMask(width, height, variant = 0) {
  const mask = createMask(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const stripe = variant === 0
        ? (x + Math.floor(y / 3)) % 9 < 4
        : (y + Math.floor(x / 4)) % 11 < 5;
      mask.data[y * width + x] = stripe ? 1 : 0;
    }
  }
  return mask;
}

function syntheticProject() {
  const sheet = { widthMm: 420, heightMm: 297 };
  const initialMask = patternedMask(96, 68, 0);
  const candidateMask = patternedMask(96, 68, 1);
  const candidateLayers = {
    painted: { keep: [0, 1, 2], remove: [95, 191] },
    manufacturingRepairs: {
      keep: [300, 301],
      remove: [400],
      enabled: true,
      stale: false,
      summary: { strategy: 'balanced', repairCount: 3 },
    },
  };
  const candidateSource = applyRasterLayers(candidateMask, candidateLayers);
  const candidateDesign = buildDesignMask(candidateSource, {
    sheet,
    frame: { enabled: false },
    bridges: [],
  }).mask;
  const commonControls = {
    cutStyle: 'line-art',
    threshold: '24',
    'measurement-unit': 'mm',
    'panel-width': '420',
    'panel-height': '297',
    'frame-width': '0',
    anchorEdge: [],
    'fit-artwork': false,
    'artwork-scale': '100',
    'artwork-rotation': '0',
    'artwork-offset-x': '0',
    'artwork-offset-y': '0',
  };
  return serializeProject(createProject({
    id: 'synthetic-browser-project',
    name: 'Synthetic browser fixture',
    sheet,
    frame: { enabled: false, thicknessMm: 0, sides: { top: false, right: false, bottom: false, left: false } },
    raster: { sourceMask: encodeMask(initialMask), baseMask: encodeMask(initialMask) },
    editor: {
      controls: commonControls,
      styleSettings: {},
      painted: { keep: [], remove: [] },
      manualEdits: [],
      manufacturingRepairs: { keep: [], remove: [], enabled: true, stale: false, summary: null },
      candidates: [{
        payloadVersion: CANDIDATE_PAYLOAD_VERSION,
        id: 'candidate-browser',
        name: 'Synthetic alternate',
        createdAt: '2026-09-01T12:00:00.000Z',
        controls: { ...commonControls, threshold: '72' },
        styleSettings: {},
        vectorDots: null,
        baseMask: encodeMask(candidateMask),
        painted: candidateLayers.painted,
        manualEdits: [],
        paintedFor: '96x68',
        manufacturingRepairs: candidateLayers.manufacturingRepairs,
        bridges: [],
        geometry: {
          sourceRasterKey: '96x68',
          designFingerprint: maskFingerprint(candidateDesign),
        },
        thumbnail: null,
        automaticSupportsStale: false,
      }],
      selectedCandidateId: null,
      automaticSupportsStale: false,
      projectSummary: {
        thumbnail: null,
        cutStyle: 'line-art',
        status: 'needs-validation',
        lastValidatedAt: null,
        lastExportedAt: null,
      },
    },
  }));
}

async function openEditor({ viewport = { width: 1280, height: 900 } } = {}) {
  const invite = auth.createInvite('Browser interaction test');
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', acceptDownloads: true });
  const page = await context.newPage();
  const unexpectedRequests = [];
  const browserErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === baseUrl) await route.continue();
    else {
      unexpectedRequests.push(url.href);
      await route.abort('blockedbyclient');
    }
  });
  await page.goto(`${baseUrl}/#invite=${encodeURIComponent(invite.code)}`);
  await page.getByLabel('Name this device').fill('K01 browser');
  await page.getByRole('button', { name: 'Open Kerfloom' }).click();
  await page.locator('#app-main').waitFor({ state: 'visible' });
  await page.waitForFunction(() => typeof window.stencilCncIsBusy === 'function');
  await page.locator('#file-input').setInputFiles({
    name: 'synthetic.stencil.json',
    mimeType: 'application/json',
    buffer: Buffer.from(syntheticProject()),
  });
  await page.locator('[data-candidate-id="candidate-browser"]').waitFor({ state: 'attached', timeout: 10_000 }).catch(async (error) => {
    const status = await page.locator('#app-status').textContent().catch(() => 'missing status');
    const notices = await page.locator('.toast').allTextContents().catch(() => []);
    const candidates = await page.locator('#candidate-list').textContent().catch(() => 'missing candidates');
    error.message += `\nApp status: ${status}\nNotices: ${notices.join(' | ')}\nCandidates: ${candidates}\nBrowser errors: ${browserErrors.join(' | ')}`;
    throw error;
  });
  return {
    context,
    page,
    unexpectedRequests,
    async close() {
      assert.deepEqual(unexpectedRequests, [], 'the isolated browser fixture must never contact an external origin');
      await context.close();
    },
  };
}

async function canvasChecksum(page) {
  return page.locator('#editor-canvas').evaluate((canvas) => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let offset = 0; offset < pixels.length; offset += 97) {
      hash ^= pixels[offset];
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash;
  });
}

test('candidate restoration applies the saved recipe and redraws its geometry', async () => {
  const fixture = await openEditor();
  try {
    const before = await canvasChecksum(fixture.page);
    assert.equal(await fixture.page.locator('#threshold').inputValue(), '24');

    await fixture.page.getByRole('button', { name: 'Restore Synthetic alternate' }).click();
    await fixture.page.locator('[data-candidate-id="candidate-browser"].is-selected').waitFor();

    assert.equal(await fixture.page.locator('#threshold').inputValue(), '72');
    assert.notEqual(await canvasChecksum(fixture.page), before, 'restoring a different mask must redraw the canvas');
    assert.match(await fixture.page.locator('#style-status').textContent(), /Synthetic alternate restored/);
  } finally {
    await fixture.close();
  }
});

test('native editable-field undo does not consume project geometry history', async () => {
  const fixture = await openEditor();
  try {
    await fixture.page.getByRole('tab', { name: /Panel/ }).click();
    const width = fixture.page.getByRole('spinbutton', { name: /^Width/ });
    await width.fill('430');
    await width.press('Tab');
    await fixture.page.locator('#btn-undo:not([disabled])').waitFor();

    const name = fixture.page.getByRole('textbox', { name: 'Project name', exact: true });
    await name.click();
    await name.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await fixture.page.keyboard.insertText('Temporary name');
    await name.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');

    assert.equal(await name.inputValue(), 'Synthetic browser fixture');
    assert.equal(await width.inputValue(), '430', 'field undo must not roll back panel geometry');
    assert.equal(await fixture.page.locator('#btn-undo').isEnabled(), true, 'project history remains available');
  } finally {
    await fixture.close();
  }
});

test('rulers retain physical values while zoom changes their screen spacing', async () => {
  const fixture = await openEditor();
  try {
    const readTicks = () => fixture.page.locator('#ruler-horizontal .ruler-tick').evaluateAll((nodes) =>
      nodes.map((node) => ({ value: node.textContent, position: Number.parseFloat(node.style.left) })));
    const before = await readTicks();
    assert.ok(before.length >= 3, 'a fitted A3 panel exposes multiple horizontal measurements');
    assert.equal(await fixture.page.locator('#ruler-unit').textContent(), 'mm');
    assert.ok(before.every((tick, index) => index === 0 || tick.position > before[index - 1].position));

    await fixture.page.getByRole('button', { name: 'Zoom in' }).click();
    const after = await readTicks();
    const shared = before.filter((tick) => after.some((next) => next.value === tick.value));
    assert.ok(shared.length >= 2, 'zoomed and fitted rulers retain comparable physical labels');
    const pair = [shared[0], shared.at(-1)];
    const beforeDistance = Math.abs(pair[1].position - pair[0].position);
    const afterByValue = new Map(after.map((tick) => [tick.value, tick.position]));
    const afterDistance = Math.abs(afterByValue.get(pair[1].value) - afterByValue.get(pair[0].value));
    assert.ok(afterDistance > beforeDistance * 1.2, 'screen spacing follows canvas zoom');
  } finally {
    await fixture.close();
  }
});

test('unvalidated artwork downloads a visibly watermarked draft PNG', async () => {
  const fixture = await openEditor();
  try {
    await fixture.page.getByRole('tab', { name: /Export/ }).click();
    const png = fixture.page.getByRole('button', { name: /Export PNG/ });
    assert.equal(await png.isEnabled(), true);
    assert.match(await png.textContent(), /validation watermark included/i);

    const [download] = await Promise.all([
      fixture.page.waitForEvent('download'),
      png.click(),
    ]);
    assert.match(download.suggestedFilename(), /draft-preview.*\.png$/);
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

    const colourPixels = await fixture.page.evaluate(async (base64) => {
      const raw = atob(base64);
      const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let coloured = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset] !== pixels[offset + 1] || pixels[offset + 1] !== pixels[offset + 2]) coloured += 1;
      }
      return coloured;
    }, bytes.toString('base64'));
    assert.ok(colourPixels > 0, 'the draft contains the red safety watermark, not only artwork pixels');
  } finally {
    await fixture.close();
  }
});

test('creative material points commit without forcing connectivity review', async () => {
  const fixture = await openEditor();
  try {
    await fixture.page.locator('#tool-remove').click();
    const canvas = fixture.page.locator('#editor-canvas');
    const clickKnownMaterial = async () => {
      const bounds = await canvas.boundingBox();
      assert.ok(bounds);
      await fixture.page.mouse.click(
        bounds.x + bounds.width * (45.5 / 96),
        bounds.y + bounds.height * (33.5 / 68),
      );
    };

    await clickKnownMaterial();
    await fixture.page.waitForFunction(
      (count) => document.querySelector('#manual-edit-count')?.textContent === count,
      '1',
      { timeout: 5_000 },
    );
    await fixture.page.locator('#tool-keep').click();
    await clickKnownMaterial();
    await fixture.page.waitForFunction(
      (count) => document.querySelector('#manual-edit-count')?.textContent === count,
      '2',
      { timeout: 5_000 },
    );

    assert.equal(await fixture.page.locator('#island-count').textContent(), 'Not analysed');
    assert.notEqual(await fixture.page.locator('#canvas-viewport').getAttribute('aria-busy'), 'true');
    assert.equal(await fixture.page.locator('.toast').filter({ hasText: 'Edit leaves' }).count(), 0);
  } finally {
    await fixture.close();
  }
});

test('mobile adjustment and review sheets open, close, and restore focus semantically', async () => {
  const fixture = await openEditor({ viewport: { width: 390, height: 844 } });
  try {
    const adjust = fixture.page.getByRole('button', { name: /Adjust Prepare/ });
    if (await adjust.getAttribute('aria-expanded') === 'true') {
      await fixture.page.getByRole('button', { name: 'Close stage controls' }).click();
    }
    await adjust.click();
    assert.equal(await adjust.getAttribute('aria-expanded'), 'true');
    assert.equal(await fixture.page.locator('#stage-controls-pane').evaluate((node) => node.classList.contains('is-mobile-open')), true);
    assert.equal(await fixture.page.locator('#review-pane').evaluate((node) => node.inert), true);
    await fixture.page.waitForFunction(
      () => document.activeElement?.id === 'btn-close-mobile-controls',
      null,
      { timeout: 1_000 },
    );

    await fixture.page.getByRole('button', { name: 'Close stage controls' }).click();
    assert.equal(await adjust.getAttribute('aria-expanded'), 'false');
    assert.equal(await adjust.evaluate((node) => document.activeElement === node), true);

    const review = fixture.page.getByRole('button', { name: 'Candidates', exact: true });
    await review.click();
    assert.equal(await review.getAttribute('aria-expanded'), 'true');
    assert.equal(await fixture.page.locator('#review-pane').evaluate((node) => node.classList.contains('is-mobile-open')), true);
    await fixture.page.getByRole('button', { name: 'Close project review' }).click();
    assert.equal(await review.getAttribute('aria-expanded'), 'false');
  } finally {
    await fixture.close();
  }
});
