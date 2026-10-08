/** Browser permission, quota and scoped policy editor regressions. */
/* global document, window */
import assert from 'node:assert/strict';

export async function checkControls(browser, url) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const writes = [];
  let conflict = false;
  let heldRead = null;
  let releaseRead, signalRead;
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('landing').hidden === false);
  try {
    await page.route('**/api/**', async route => {
      const request = route.request();
      const location = new URL(request.url());
      const layer = location.searchParams.get('layer');
      const workspace = request.headers()['x-workspace-id'];
      if (location.pathname === '/api/governance' && request.method() === 'POST') {
        writes.push({ ...request.postDataJSON(), workspace });
        return route.fulfill({ status: conflict ? 409 : 200, json: conflict
          ? { code: 'policy-revision-conflict', error: 'Policy changed' } : { revision: 5 } });
      }
      if (location.pathname === '/api/governance') {
        if (heldRead && workspace === 'ws') { signalRead(); await heldRead; }
        return route.fulfill({ json: { layer, scopeId: layer === 'user' ? 'tester' : workspace, revision: 4,
          canEdit: layer === 'user', policy: { maxTokens: workspace === 'other' ? 900 : 500, deniedModels: ['blocked-model'] } } });
      }
      if (location.pathname === '/api/governance/effective') return route.fulfill({ json: { effective: { status: 'evaluated', constraints: {
        maxTokens: 500, requireHumanApproval: true, deniedTools: ['code.run'], deniedModels: [], deniedDataClasses: [], deniedCapabilities: []
      } } } });
      return route.fulfill({ json: { conversations: [] } });
    });
    await page.evaluate(async () => {
      const { state } = await import('/ui-core.js');
      const { renderUsageLimitLock } = await import('/app-account.js');
      const { loadPolicyControls, savePolicyControls } = await import('/governance-controls.js');
      const { openSettings, activateSettingsSection } = await import('/app-settings-window.js');
      const { sendMessage } = await import('/app-attachments.js');
      state.principal = { id: 'tester', name: 'Tester' }; state.role = 'viewer'; state.workspaceId = 'ws';
      state.usage = null; state.driving = null; state.busyRuns.clear();
      document.getElementById('landing').hidden = true; document.getElementById('app').hidden = false;
      window.controlsQA = { state, renderUsageLimitLock, loadPolicyControls, savePolicyControls, sendMessage };
      renderUsageLimitLock(); document.dispatchEvent(new Event('kindgleam:composer-state'));
      openSettings(); activateSettingsSection('policies');
    });
    assert.equal(await page.locator('#createRun').isDisabled(), true, 'quota refresh cannot unlock a viewer');
    assert.equal(await page.locator('#goal').isDisabled(), true);
    await page.waitForFunction(() => !document.getElementById('policySave').disabled);
    assert.equal(await page.locator('#policyTokens').inputValue(), '500');
    assert.match(await page.locator('#policyEffective').textContent(), /Human approval/);
    await page.locator('#policyTokens').fill('123');
    await page.locator('#policyDeniedTools').fill('code.run\nmcp.*');
    await page.evaluate(() => window.controlsQA.savePolicyControls());
    assert.equal(writes.length, 1);
    assert.equal(writes[0].workspace, 'ws');
    assert.equal(writes[0].expectedRevision, 4);
    assert.equal(writes[0].policy.maxTokens, 123);
    assert.deepEqual(writes[0].policy.deniedModels, ['blocked-model'], 'simple edits preserve additional constraints');
    assert.deepEqual(writes[0].policy.deniedTools, ['code.run', 'mcp.*']);
    await page.locator('#policyLayer').selectOption('organization');
    await page.waitForFunction(() => document.getElementById('policyAuthority').textContent.startsWith('Read only'));
    assert.equal(await page.locator('#policySave').isDisabled(), true);
    await page.evaluate(() => window.controlsQA.savePolicyControls());
    assert.equal(writes.length, 1, 'read-only scopes cannot write');

    await page.locator('#policyLayer').selectOption('user');
    await page.waitForFunction(() => !document.getElementById('policySave').disabled);
    conflict = true;
    await page.evaluate(() => window.controlsQA.savePolicyControls());
    assert.equal(await page.locator('#policySave').isDisabled(), true);
    assert.match(await page.locator('#policyNotice').textContent(), /Reload/);
    conflict = false;

    const readStarted = new Promise(resolve => { signalRead = resolve; });
    heldRead = new Promise(resolve => { releaseRead = resolve; });
    await page.evaluate(() => { window.oldPolicyRead = window.controlsQA.loadPolicyControls(); });
    await readStarted;
    await page.evaluate(async () => { window.controlsQA.state.workspaceId = 'other'; await window.controlsQA.loadPolicyControls(); });
    assert.equal(await page.locator('#policyTokens').inputValue(), '900');
    releaseRead(); heldRead = null;
    await page.evaluate(() => window.oldPolicyRead);
    assert.equal(await page.locator('#policyTokens').inputValue(), '900', 'old workspace reads cannot overwrite active controls');

    await page.evaluate(() => {
      const { state, renderUsageLimitLock } = window.controlsQA;
      state.role = 'editor'; state.usage = { windows: [{ exceeded: true, id: 'session', label: '4 hours' }] };
      state.driving = 'run'; renderUsageLimitLock();
    });
    assert.equal(await page.locator('#createRun').isDisabled(), false, 'an editor can stop work when the AI quota is exhausted');
    assert.equal(await page.locator('#goal').isDisabled(), true);
    assert.match(await page.locator('#usageLimitBanner').textContent(), /account/);
    await page.evaluate(() => { window.controlsQA.state.role = 'viewer'; window.controlsQA.renderUsageLimitLock(); });
    assert.equal(await page.locator('#createRun').isDisabled(), true, 'activity updates cannot grant viewer write authority');
    await page.evaluate(() => window.controlsQA.sendMessage('A viewer must not send this'));
    assert.equal(writes.length, 2);
    // A new policy revision during local execution must pause receipt acceptance
    // without executing the local task for a second time.
    const executionWrites = []; const receiptWrites = []; let localCalls = 0;
    const localRun = { id: 'local-control', conversationId: 'local-chat', goal: 'Run approved code', workflow: 'adaptive',
      state: 'code', next: 'code', attempt: 1, adaptation: {}, tasks: [{ id: 'code', type: 'code', status: 'ready', metadata: {}, dependsOn: [] }] };
    const finished = { ...localRun, state: 'complete', next: null, tasks: [{ ...localRun.tasks[0], status: 'complete' }] };
    await page.route('**/api/runs/local-control/**', async route => {
      const body = route.request().postDataJSON();
      if (new URL(route.request().url()).pathname.endsWith('/execution-result')) {
        receiptWrites.push(body);
        return route.fulfill({ status: receiptWrites.length === 1 ? 409 : 200, json: receiptWrites.length === 1
          ? { code: 'policy-approval-required', error: 'Policy changed again', detail: { policyRevision: 'second-revision' } }
          : { run: finished } });
      }
      executionWrites.push(body);
      return route.fulfill({ json: { run: localRun, execution: { status: 'local-agent-required', request: { executionId: 'one-local-call' } } } });
    });
    await page.route('**/v1/execute', async route => {
      localCalls++;
      return route.fulfill({ json: { receipt: { executed: true, executionId: 'one-local-call', result: 'done' } } });
    });
    await page.evaluate(async run => {
      const { state } = window.controlsQA; const { runStep, renderNextStep } = await import('/app.js');
      state.role = 'editor'; state.driving = null; state.usage = null; state.run = run;
      state.chat = { id: run.conversationId, runs: [run], pending: null };
      state.executionConfig = { localAgentUrl: window.location.origin + '/local-fixture', targets: [{ id: 'local' }] };
      window.controlsQA.renderNextStep = renderNextStep;
      await runStep(null, { executionTarget: 'local', approved: true, policyRevision: 'first-revision', preflight: { agent: { available: true } } }, run);
    }, localRun);
    assert.equal(localCalls, 1); assert.equal(executionWrites.length, 1);
    assert.equal(receiptWrites[0].approved, true);
    assert.equal(receiptWrites[0].policyRevision, 'first-revision');
    assert.equal(await page.evaluate(() => window.controlsQA.state.policyContinuations.get('local-control').body.executionTarget), 'local');
    await page.evaluate(() => {
      const card = window.controlsQA.renderNextStep(window.controlsQA.state.run);
      document.body.append(card); card.querySelector('button').click();
    });
    await page.waitForFunction(() => !window.controlsQA.state.executionReceipts.has('local-control'));
    assert.equal(receiptWrites.length, 2); assert.equal(receiptWrites[1].policyRevision, 'second-revision');
    assert.equal(localCalls, 1, 'policy approval must resubmit the completed receipt without repeating local execution');
    assert.equal(executionWrites.length, 1);
    await page.evaluate(async oldRun => {
      const { state } = window.controlsQA;
      const { executionContextKey } = await import('/execution-context.js');
      const { runStep } = await import('/app.js');
      const saved = { context: executionContextKey(oldRun, { principalId: state.principal.id, workspaceId: state.workspaceId }),
        body: { taskId: 'code', receipt: { attempt: 1, executionId: 'old-attempt' }, executionTarget: 'local' } };
      state.executionReceipts.set(oldRun.id, saved); state.policyContinuations.set(oldRun.id, saved); state.policyApprovals.set(oldRun.id, 'old-token');
      state.run = { ...oldRun, attempt: 2 }; state.chat.runs = [state.run];
      await runStep(null, { approved: true, policyRevision: 'old-token' }, state.run);
    }, localRun);
    assert.equal(receiptWrites.length, 2, 'an older attempt cannot keep resubmitting its receipt');
    assert.equal(await page.evaluate(() => window.controlsQA.state.executionReceipts.has('local-control') || window.controlsQA.state.policyApprovals.has('local-control')), false);
    assert.deepEqual(errors, [], 'no control-panel runtime errors');
    console.log('PASS: viewer role locks, account quota locks, editor stop control, scoped policy editing, preserved restrictions, revision conflicts, stale workspace reads, local approval/receipt continuation');
  } finally { await page.close(); }
}
