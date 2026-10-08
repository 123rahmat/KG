/** Real composer checks with controlled upload and run API boundaries. */
/* global document, window */
import assert from 'node:assert/strict';

export async function checkAttachments(browser, url) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById('landing').hidden === false);
    await page.evaluate(async () => {
      const { state } = await import('/ui-core.js');
      const { addAttachments, sendMessage, renderThread, flushOfflineQueue } = await import('/app-attachments.js');
      document.getElementById('landing').hidden = true;
      document.getElementById('gate').hidden = true;
      document.getElementById('app').hidden = false;
      state.principal = { id: 'tester' }; state.role = 'admin'; state.workspaceId = 'original-ws';
      state.executionConfig = { reasoning: { configured: false }, targets: [] };
      state.settings.offlineQueue = false; state.usage = null;
      state.activeProjectId = 'original-project'; state.activeSurface = 'normal-chat';
      state.workspaceSourceId = null; state.workspaceSource = null;
      state.chat = { id: 'original-chat', runs: [], pending: null, consent: true };
      window.filesQA = { state, addAttachments, sendMessage, renderThread, flushOfflineQueue, originalChat: state.chat };
      renderThread();
      addAttachments([new File(['unchecked'], 'same.txt', { type: 'text/plain' }), new File(['chosen'], 'same.txt', { type: 'text/plain' })]);
    });
    const uploads = [], runs = [], executions = [];
    let queuedRunActive = false;
    let releaseUpload, uploadStarted;
    let held = new Promise(resolve => { releaseUpload = resolve; });
    let started = new Promise(resolve => { uploadStarted = resolve; });
    await page.route('**/api/**', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (request.method() === 'POST' && pathname === '/api/objects') {
        uploads.push({ ...request.postDataJSON(), workspace: request.headers()['x-workspace-id'] });
        uploadStarted(); await held;
        await route.fulfill({ status: 201, json: { id: 'object-' + uploads.length } });
      } else if (request.method() === 'POST' && pathname === '/api/runs') {
        const body = request.postDataJSON();
        runs.push({ ...body, workspace: request.headers()['x-workspace-id'] });
        await route.fulfill({ status: 201, json: {
          id: 'run-' + runs.length, conversationId: body.conversationId, projectId: body.projectId,
          goal: body.goal, state: queuedRunActive ? 'respond' : 'complete', next: queuedRunActive ? 'respond' : null,
          workflow: 'direct', attempt: 1, tasks: queuedRunActive ? [{ id: 'respond', type: 'respond', status: 'pending', dependsOn: [], metadata: {}, evidence: {} }] : [], adaptation: {}, updatedAt: new Date().toISOString()
        } });
      } else if (pathname.includes('/execute') || pathname.includes('/advance')) {
        executions.push(request.url()); await route.fulfill({ status: 400, json: { code: 'test-unexpected-execution', error: 'Unexpected execution' } });
      } else await route.fulfill({ json: { conversations: [] } });
    });
    const checks = page.locator('#attachList input[type=checkbox]');
    await checks.nth(0).uncheck();
    assert.equal(await checks.nth(1).isChecked(), true, 'equal names retain independent selection');
    await page.evaluate(() => { window.sending = window.filesQA.sendMessage('Read the selected file.'); });
    await started;
    await checks.nth(0).check(); await checks.nth(1).uncheck();
    await page.evaluate(() => {
      window.filesQA.addAttachments([new File(['later'], 'later.txt')]);
      document.getElementById('goal').value = 'A new draft while uploading';
    });
    releaseUpload();
    await page.evaluate(() => window.sending);
    assert.deepEqual(uploads.map(file => Buffer.from(file.content, 'base64').toString()), ['chosen'], 'only the submitted selection is uploaded');
    assert.deepEqual(runs[0].attachments, ['object-1']);
    assert.deepEqual(runs[0].adaptiveControl.includeArtifacts, ['same.txt']);
    assert.deepEqual(await page.evaluate(() => window.filesQA.state.attachments.map(file => file.name)), ['same.txt', 'later.txt'], 'unchecked and newly attached files remain');
    assert.equal(await page.locator('#goal').inputValue(), 'A new draft while uploading');

    // Switch chat and workspace after admission but before an upload finishes.
    held = new Promise(resolve => { releaseUpload = resolve; });
    started = new Promise(resolve => { uploadStarted = resolve; });
    await page.evaluate(() => {
      window.filesQA.state.attachmentScope = new Set([window.filesQA.state.attachments[0]]);
      window.sending = window.filesQA.sendMessage('Keep this in the original chat.');
    });
    await started;
    await page.evaluate(() => {
      const { state, addAttachments, renderThread } = window.filesQA;
      state.chat = { id: 'new-chat', runs: [], pending: null, consent: false };
      state.workspaceId = 'new-ws'; state.activeProjectId = 'new-project'; state.activeSurface = 'research';
      state.attachments = []; state.attachmentScope = null;
      addAttachments([new File(['new chat'], 'new-chat.txt')]);
      document.getElementById('goal').value = 'New chat draft'; renderThread();
    });
    releaseUpload(); await page.evaluate(() => window.sending);
    assert.equal(runs[1].conversationId, 'original-chat'); assert.equal(runs[1].projectId, 'original-project');
    assert.equal(runs[1].workspace, 'original-ws'); assert.equal(runs[1].activeSurface, 'normal-chat');
    assert.equal(runs[1].privacyConsent.modelProvider, true);
    assert.equal(uploads[1].workspace, 'original-ws');
    assert.deepEqual(await page.evaluate(() => [window.filesQA.state.chat.runs.length, window.filesQA.originalChat.runs.length]), [0, 2]);
    assert.equal(await page.locator('#goal').inputValue(), 'New chat draft');
    assert.deepEqual(await page.evaluate(() => window.filesQA.state.attachments.map(file => file.name)), ['new-chat.txt']);

    await page.locator('#attachList input[type=checkbox]').uncheck();
    await page.evaluate(() => window.filesQA.sendMessage('Text only.'));
    assert.equal(uploads.length, 2, 'an empty selection uploads nothing');
    assert.deepEqual(runs[2].attachments, []);

    await page.evaluate(async () => {
      const { state, addAttachments, sendMessage } = window.filesQA;
      state.settings.offlineQueue = true;
      state.activeProjectId = null; state.chat.projectId = null;
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
      addAttachments([new File(['offline chosen'], 'offline.txt')]);
      await sendMessage('Queue only the checked file.');
    });
    const queued = await page.evaluate(async () => {
      const { state } = window.filesQA;
      const item = state.network.queue.at(-1);
      const { loadOfflineFiles } = await import('/app-settings.js');
      const files = await loadOfflineFiles(item);
      return { names: files.map(file => file.name), contents: await Promise.all(files.map(file => file.text())), included: item.adaptiveControl.includeArtifacts, conversation: item.conversationId };
    });
    assert.deepEqual(queued, { names: ['offline.txt'], contents: ['offline chosen'], included: ['offline.txt'], conversation: 'new-chat' });
    assert.equal(uploads.length, 2, 'offline queuing does not upload files');

    held = new Promise(resolve => { releaseUpload = resolve; });
    started = new Promise(resolve => { uploadStarted = resolve; });
    queuedRunActive = true;
    await page.evaluate(() => {
      const { state, flushOfflineQueue } = window.filesQA;
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
      state.activeProjectId = 'later-selected-project';
      window.flushingFiles = flushOfflineQueue();
    });
    await started;
    await page.evaluate(() => {
      const { state, renderThread } = window.filesQA;
      state.workspaceId = 'third-ws'; state.activeProjectId = null;
      state.chat = { id: null, runs: [], pending: null }; state.settings.offlineQueue = false;
      state.executionConfig.reasoning.configured = true; renderThread();
    });
    releaseUpload(); await page.evaluate(() => window.flushingFiles);
    assert.equal(runs[3].projectId, null, 'queued no-project choice survives a later project selection');
    assert.equal(runs[3].workspace, 'new-ws'); assert.equal(uploads[2].workspace, 'new-ws');
    assert.equal(await page.evaluate(() => window.filesQA.state.chat.runs.length), 0);
    assert.deepEqual(executions, [], 'queued work cannot execute under a different workspace');

    // A delayed GitHub sync must not install its source into a new workspace.
    let releaseSync, syncStarted;
    const heldSync = new Promise(resolve => { releaseSync = resolve; });
    const startedSync = new Promise(resolve => { syncStarted = resolve; });
    await page.route('**/api/workspace/sources/source-a/sync', async route => {
      assert.equal(route.request().headers()['x-workspace-id'], 'third-ws');
      syncStarted(); await heldSync;
      await route.fulfill({ json: { source: { id: 'source-a', kind: 'github', name: 'A' } } });
    });
    await page.evaluate(async () => {
      const { state } = window.filesQA;
      state.workspaceSourceId = 'source-a'; state.chat.workspaceSourceId = 'source-a';
      state.workspaceSource = { id: 'source-a', kind: 'github', name: 'A' };
      const { syncActiveWorkspaceSource } = await import('/workspace-sources.js');
      window.syncingSource = syncActiveWorkspaceSource();
    });
    await startedSync;
    await page.evaluate(() => {
      const { state } = window.filesQA;
      state.workspaceId = 'fourth-ws'; state.chat = { id: null, runs: [], pending: null };
      state.workspaceSource = null; state.workspaceSourceId = null;
    });
    releaseSync(); await page.evaluate(() => window.syncingSource);
    assert.equal(await page.evaluate(() => window.filesQA.state.workspaceSource), null, 'stale sync cannot overwrite the active workspace');
    assert.deepEqual(errors, [], 'attachment flows produce no browser runtime errors');
  } finally { await page.close(); }
}
