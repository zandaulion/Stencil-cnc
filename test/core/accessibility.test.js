import assert from 'node:assert/strict';
import test from 'node:test';

import { contrastRatio, tabIndexForKey } from '../../web/core/accessibility.js';

test('primary action colours retain normal-text contrast in every state', () => {
  assert.ok(contrastRatio('#ffffff', '#a83d20') >= 4.5, 'default primary action');
  assert.ok(contrastRatio('#ffffff', '#8f3119') >= 4.5, 'hovered primary action');
  assert.ok(contrastRatio('#ffffff', '#142129') >= 4.5, 'focused outline against its fill');
});

test('tab keyboard navigation wraps and supports Home and End', () => {
  assert.equal(tabIndexForKey('ArrowRight', 4, 5), 0);
  assert.equal(tabIndexForKey('ArrowLeft', 0, 5), 4);
  assert.equal(tabIndexForKey('Home', 3, 5), 0);
  assert.equal(tabIndexForKey('End', 1, 5), 4);
  assert.equal(tabIndexForKey('ArrowDown', 1, 5), null);
  assert.equal(tabIndexForKey('ArrowDown', 1, 5, { orientation: 'vertical' }), 2);
  assert.equal(tabIndexForKey('Enter', 1, 5), null);
  assert.equal(tabIndexForKey('ArrowRight', 0, 0), null);
});
