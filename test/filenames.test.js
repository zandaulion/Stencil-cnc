import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExportFilename,
  filenamePart,
  filenameTimestamp,
} from '../web/core/filenames.js';

test('related exports receive descriptive, sortable names', () => {
  const timestamp = new Date(2026, 8, 15, 16, 20, 5);
  const common = {
    projectName: 'Maria Portrait',
    sheet: { widthMm: 297, heightMm: 420 },
    styleName: 'Slats',
    includeFrame: true,
    timestamp,
  };

  assert.equal(
    buildExportFilename({ ...common, purpose: 'cut', extension: 'dxf' }),
    'maria-portrait_297x420mm_slats_frame_cut_2026-09-15-162005.dxf',
  );
  assert.equal(
    buildExportFilename({ ...common, purpose: 'preview', extension: 'png' }),
    'maria-portrait_297x420mm_slats_frame_preview_2026-09-15-162005.png',
  );
});

test('filename parts are portable and preserve useful Romanian words', () => {
  assert.equal(filenamePart('Șablon Înger / versiunea 2'), 'sablon-inger-versiunea-2');
  assert.equal(filenamePart(''), 'file');
});

test('custom dimensions and editable projects use unambiguous tokens', () => {
  assert.equal(
    buildExportFilename({
      projectName: 'Panou nord',
      sheet: { widthMm: 297.5, heightMm: 420.25 },
      styleName: 'Variable dots',
      includeFrame: false,
      purpose: 'editable',
      extension: 'stencil.json',
      timestamp: new Date(2026, 0, 2, 3, 4, 5),
    }),
    'panou-nord_297p5x420p25mm_variable-dots_no-frame_editable_2026-01-02-030405.stencil.json',
  );
});

test('timestamp rejects invalid dates', () => {
  assert.throws(() => filenameTimestamp(new Date('invalid')), /valid export date/);
});
