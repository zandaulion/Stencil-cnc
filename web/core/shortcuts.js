const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * Native editing controls own their undo/redo history. Project shortcuts must
 * never intercept keystrokes while a value, project name, or rich-text field
 * is being edited.
 */
export function isEditableShortcutTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (EDITABLE_TAGS.has(String(target.tagName || '').toUpperCase())) return true;
  if (target.isContentEditable) return true;
  if (typeof target.closest !== 'function') return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
}

/**
 * Single-key editing commands only belong to the focused drawing surface.
 * This prevents keys such as R, I, or Backspace from changing a project while
 * the operator is navigating the rest of the application.
 */
export function isCanvasShortcutTarget(target, viewport) {
  if (!target || !viewport) return false;
  if (target === viewport) return true;
  return typeof viewport.contains === 'function' && viewport.contains(target);
}
