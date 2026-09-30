import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
const js = ['app.js', 'app-actions.js', 'app-attachments.js', 'app-account.js']
  .map(name => fs.readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8')).join('\n');

// Found in a real browser (desktop, phone, dark): each of these made the
// page scroll sideways, hid the top of the start screen, or trapped the
// phone menu.
test('wide content scrolls inside its own box, never the page', () => {
  assert.match(css, /\.page \{[^}]*grid-template-columns: minmax\(0, 1fr\)/, 'a page grid must not grow to its widest table');
});

test('focusing the message box never scrolls the start screen away', () => {
  assert.doesNotMatch(js, /\$\('goal'\)\.focus\(\)/);
});

test('Escape closes the phone menu, one layer at a time', () => {
  assert.match(js, /Escape closes the phone menu/);
  assert.match(js, /event\.preventDefault\(\);\n\s*\}\n\s*\}\);/, 'closing the notifications uses up that Escape');
});
