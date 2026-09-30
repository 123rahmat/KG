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


test('public landing is a single-screen product surface with sign-in actions separate from the form', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<section class="landing" id="landing"/);
  assert.match(html, /id="landingSignIn"/);
  assert.match(html, /id="landingSignInPrimary"/);
  const landing = html.match(/<section class="landing" id="landing"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.doesNotMatch(landing, /id="emailSignin"|id="signin"|type="password"/);
  assert.match(css, /\.landing \{[^}]*min-height: 100vh/);
  assert.match(css, /\.landing-main \{[^}]*align-content: center/);
});

test('production response style rules prohibit casual filler', () => {
  const reasoning = fs.readFileSync(new URL('../src/reasoning-context.js', import.meta.url), 'utf8');
  assert.match(reasoning, /professional language appropriate for a real production assistant/);
  assert.match(reasoning, /Do not use cheerleading, filler, hype/);
  assert.match(reasoning, /Avoid stock openings/);
});
