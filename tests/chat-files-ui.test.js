import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url),'utf8');
const css = readFileSync(new URL('../public/app.css', import.meta.url),'utf8');
const behavior = readFileSync(new URL('../public/chat-files-panel.js', import.meta.url),'utf8');
const attachmentCode = readFileSync(new URL('../public/app-attachments.js',import.meta.url),'utf8');

test('every chat has exactly two top-level accessible sliding tabs', () => {
  assert.match(html, /id="chatViewSwitch" role="tablist"/);
  assert.match(html, /id="chatViewMessages" role="tab"[\s\S]*?aria-selected="true"/);
  assert.match(html, /id="chatViewFiles" role="tab"[\s\S]*?aria-selected="false"/);
  assert.match(html, /id="chatFilesPanel" class="chat-files-panel" role="tabpanel"/);
  assert.equal((html.match(/id="chatViewFiles"/g) ?? []).length,1);
  assert.ok(html.indexOf('id="chatViewSwitch"') < html.indexOf('id="thread"'),
    'switch is before chat messages');
  assert.match(css, /chat-view-switch\[data-view="files"\] \.chat-view-thumb.*translateX/);
  assert.match(css, /prefers-reduced-motion/);
});

test('switch is keyboard-operable and resets when changing conversations', () => {
  assert.match(behavior, /ArrowLeft.*ArrowRight.*Home.*End/);
  assert.match(behavior, /setAttribute\('aria-selected'/);
  assert.match(behavior, /resetChatView\(\)/);
  assert.match(attachmentCode, /resetChatView\(\)/);
  assert.match(attachmentCode, /notifyChatFilesChanged\(\)/);
});

test('browser requests only scoped per-conversation files, never global Objects list', () => {
  assert.match(behavior, /\/api\/conversations\//);
  assert.doesNotMatch(behavior, /\/api\/objects\?limit/);
  assert.match(behavior, /ticket !== activeRequest/);
  assert.match(behavior, /state\.workspaceId !== workspace/);
  assert.match(behavior, /previewButton/);
  assert.match(behavior, /Download/);
});

test('files pane is hidden when viewing chat, and composer preserved on return', () => {
  assert.match(css, /chat\[data-chat-view="files"\] #thread/);
  assert.match(css, /chat\[data-chat-view="files"\] #composer/);
  assert.match(css, /chat-files-panel\[hidden\]/);
});
