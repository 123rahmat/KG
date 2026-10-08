/** Verify cross-workspace recommendations in the real composer. */
/* global document, window */
import assert from 'node:assert/strict';

export async function checkWorkspaceSuggestions(browser, url) {
  const page = await browser.newPage();
  const errors = [];
  let submissions = 0;
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/api/runs', async route => {
      if (route.request().method() === 'POST') submissions++;
      await route.fulfill({ status: 401, json: { error: 'Not signed in' } });
    });
    await page.goto(url);
    await page.waitForFunction(() => !document.getElementById('landing').hidden);
    await page.evaluate(async () => {
      const { state } = await import('/ui-core.js');
      const { addAttachments, renderThread } = await import('/app-attachments.js');
      document.getElementById('landing').hidden = true;
      document.getElementById('gate').hidden = true;
      document.getElementById('app').hidden = false;
      state.principal = { id: 'tester' }; state.role = 'admin'; state.workspaceId = 'ws';
      state.executionConfig = { reasoning: { configured: false }, targets: [] };
      state.chat = { id: 'switch-chat', runs: [], pending: null }; state.run = null;
      state.activeSurface = 'research';
      window.switchQA = { state, renderThread, addAttachments };
      renderThread();
      document.dispatchEvent(new Event('kindgleam:composer-state'));
    });
    const draft = page.locator('#goal');
    await draft.fill('Fix the entire GitHub repository');
    const codeButton = page.getByRole('button', { name: 'Use Code workspace', exact: true });
    await codeButton.waitFor({ timeout: 3000 });
    assert.equal(await page.getByRole('region', { name: 'Workspace suggestion' }).isVisible(), true);
    assert.equal(await page.locator('#attachList .file-chip').count(), 0, 'task-only requests need no files');
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'suggestion banner must fit the viewport');
    }
    assert.equal(await page.evaluate(() => window.switchQA.state.activeSurface), 'research', 'recommendation does not switch by itself');
    await codeButton.click();
    assert.equal(await page.evaluate(() => window.switchQA.state.activeSurface), 'code');
    assert.equal(await draft.inputValue(), 'Fix the entire GitHub repository');

    await draft.fill('Write a systematic literature review for my thesis');
    await page.evaluate(() => window.switchQA.addAttachments([new File(['paper'], 'paper.txt'), new File(['notes'], 'notes.txt')]));
    await page.locator('#attachList input[type=checkbox]').last().uncheck();
    await page.getByRole('button', { name: 'Use Research workspace', exact: true }).click();
    assert.equal(await page.evaluate(() => window.switchQA.state.activeSurface), 'research');
    assert.equal(await draft.inputValue(), 'Write a systematic literature review for my thesis');
    assert.deepEqual(await page.evaluate(() => window.switchQA.state.attachments.map(file => [file.name, window.switchQA.state.attachmentScope.has(file)])), [['paper.txt', true], ['notes.txt', false]]);
    assert.equal(await page.evaluate(() => window.switchQA.state.chat.id), 'switch-chat');

    await draft.fill('Translate this paragraph');
    await page.getByRole('button', { name: 'Use Normal Chat workspace', exact: true }).click();
    assert.equal(await page.evaluate(() => window.switchQA.state.activeSurface), 'normal-chat');
    assert.equal(await draft.inputValue(), 'Translate this paragraph');

    for (const goal of ['Teach me how to build an API with code examples', 'Build a business plan for an API-based startup', 'Explain a systematic literature review to a student']) {
      await draft.fill(goal);
      assert.equal(await page.locator('.normal-chat-switch-action').count(), 0, 'daily reasoning and tutoring stay in Normal Chat');
    }
    await draft.fill('Research GitHub adoption using credible sources');
    await page.getByRole('button', { name: 'Use Research workspace', exact: true }).waitFor({ timeout: 3000 });
    assert.equal(await codeButton.count(), 0, 'the software topic must not override research intent');
    assert.equal(await page.evaluate(() => window.switchQA.state.activeSurface), 'normal-chat');

    await page.evaluate(() => {
      const { state, renderThread, addAttachments } = window.switchQA;
      state.attachments = []; state.attachmentScope = null;
      state.activeSurface = 'research'; renderThread();
      addAttachments([new File(['a'], 'a.py'), new File(['b'], 'b.py')]);
    });
    await draft.fill('Fix and run these files');
    await codeButton.waitFor({ timeout: 3000 });
    await page.locator('#attachList input[type=checkbox]').last().uncheck();
    assert.equal(await codeButton.count(), 0, 'unchecked files must not trigger project suggestions');
    await draft.fill('Continue');
    assert.equal(await page.locator('.normal-chat-switch-action').count(), 0, 'general follow-ups preserve the current workspace');
    assert.deepEqual(await page.evaluate(() => [window.switchQA.state.chat.id, window.switchQA.state.chat.runs.length, window.switchQA.state.activeSurface]), ['switch-chat', 0, 'research']);
    await draft.fill('');
    await page.evaluate(() => {
      const { state, renderThread } = window.switchQA;
      state.attachments = []; state.attachmentScope = null;
      const completed = { id: 'past-code', goal: 'Fix this repository', surface: 'code', state: 'complete', tasks: [], adaptation: { attachments: [{ name: 'project.zip', archiveKind: 'code-project' }] } };
      state.chat.runs = [completed]; state.run = completed;
      state.activeSurface = 'research'; renderThread();
    });
    assert.equal(await codeButton.count(), 0, 'old workspace files must not suggest reversing a manual switch');
    assert.equal(submissions, 0, 'suggestions and switching must not create a run');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}
