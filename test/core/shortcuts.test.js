import test from 'node:test';
import assert from 'node:assert/strict';

import { isCanvasShortcutTarget, isEditableShortcutTarget } from '../../web/core/index.js';

test('native editing controls retain their own keyboard history', () => {
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(isEditableShortcutTarget({ tagName }), true);
  }
  assert.equal(isEditableShortcutTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isEditableShortcutTarget({
    tagName: 'SPAN',
    closest: (selector) => selector.includes('contenteditable') ? {} : null,
  }), true);
  assert.equal(isEditableShortcutTarget({ tagName: 'BUTTON', closest: () => null }), false);
});

test('single-key project commands only run in the focused canvas context', () => {
  const canvas = { id: 'canvas-viewport' };
  const canvasChild = { id: 'editor-canvas' };
  const outsideButton = { id: 'rename-project' };
  const viewport = {
    contains: (target) => target === canvasChild,
  };
  assert.equal(isCanvasShortcutTarget(canvas, canvas), true);
  assert.equal(isCanvasShortcutTarget(canvasChild, viewport), true);
  assert.equal(isCanvasShortcutTarget(outsideButton, viewport), false);
  assert.equal(isCanvasShortcutTarget(null, viewport), false);
});
