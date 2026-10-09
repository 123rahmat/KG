import test from 'node:test';
import assert from 'node:assert/strict';
import * as governance from '../src/governance.js';
import { evaluatePolicy, policyAllows } from '../src/core.js';
import { useTool } from '../src/toolbox.js';
import { dataPolicyDecision } from '../src/http/policy.js';

test('workspace administration cannot confer organization policy authority', () => {
  assert.equal(typeof governance.canManagePolicy, 'function');
  assert.equal(governance.canManagePolicy('organization', { role: 'admin', organizationType: 'enterprise' }), false);
  assert.equal(governance.canManagePolicy('organization', { role: 'viewer', organizationType: 'enterprise', organizationRole: 'admin' }), true);
  assert.equal(governance.canManagePolicy('organization', { role: 'admin', organizationType: 'personal', organizationRole: 'admin' }), false);
  assert.equal(governance.canManagePolicy('workspace', { role: 'editor' }), false);
  assert.equal(governance.canManagePolicy('workspace', { role: 'admin' }), true);
  assert.equal(governance.canManagePolicy('user', { role: 'viewer' }), true);
  assert.equal(governance.canManagePolicy('platform', { role: 'admin', organizationRole: 'admin' }), false);
});

test('malformed governance constraints never reach a database mutation', async () => {
  let writes = 0;
  const store = new governance.GovernanceStore({ query: async () => { writes++; return { rows: [{}] }; } });
  for (const policy of [
    { maxTokens: -1 }, { maxTokens: 1.2 }, { maxTokens: '100' },
    { requireHumanApproval: 'false' }, { deniedModels: 'model' },
    { deniedTools: [''] }, { allowedModels: [1] }, { maxToken: 100 }
  ]) await assert.rejects(store.set({ layer: 'workspace', scopeId: 'ws', policy }), /policy|constraint|Tokens|Approval|Models|Tools/i);
  assert.equal(writes, 0);
});

test('approval identity survives JSON database key ordering without becoming a new grant', () => {
  const planned = { layer: 'workspace', id: 'policy', version: '1@2' };
  const stored = { version: '1@2', id: 'policy', layer: 'workspace' };
  assert.equal(governance.policyApprovalKey(planned), governance.policyApprovalKey(stored));
  assert.notEqual(governance.policyApprovalKey(planned), governance.policyApprovalKey({ ...stored, version: '1@3' }));
});

test('resuming a run retains original constraints while applying stricter current policy', () => {
  assert.equal(typeof governance.narrowPolicyDecision, 'function');
  const original = evaluatePolicy({ platform: {}, workspace: { deniedTools: ['web.fetch'], allowedModels: ['fast', 'careful'], maxTokens: 1000 }, task: { deniedDataClasses: ['private-code'] } });
  const current = evaluatePolicy({ platform: {}, workspace: { deniedTools: ['code.run'], allowedModels: ['careful'], maxTokens: 50, requireHumanApproval: true } });
  const combined = governance.narrowPolicyDecision(original, current);
  assert.equal(policyAllows(combined, { tool: 'web.fetch' }), false);
  assert.equal(policyAllows(combined, { tool: 'code.run' }), false);
  assert.equal(policyAllows(combined, { model: 'fast' }), false);
  assert.equal(policyAllows(combined, { model: 'careful' }), true);
  assert.equal(policyAllows(combined, { dataClass: 'private-code' }), false);
  assert.equal(combined.constraints.maxTokens, 50);
  assert.equal(combined.constraints.requireHumanApproval, true);
  assert.equal(governance.narrowPolicyDecision(combined, evaluatePolicy({ platform: {} })).constraints.maxTokens, 50);
  assert.equal(policyAllows(governance.narrowPolicyDecision(original, evaluatePolicy({ workspace: {} })), { model: 'careful' }), false);
});

test('an explicitly empty current allow-list blocks previously allowed work', () => {
  assert.equal(typeof governance.narrowPolicyDecision, 'function');
  const combined = governance.narrowPolicyDecision(evaluatePolicy({ platform: { allowedModels: ['fast'] } }), evaluatePolicy({ platform: { allowedModels: [] } }));
  assert.equal(policyAllows(combined, { model: 'fast' }), false);
});

test('wildcard allow-lists retain their semantic intersection across layers and revisions', () => {
  const original = evaluatePolicy({ platform: { allowedTools: ['*'], allowedModels: ['google:*'] } });
  const current = evaluatePolicy({ platform: { allowedTools: ['math.*'], allowedModels: ['google:gemini-3.8-flash'] }, user: { allowedTools: ['*.evaluate'] } });
  assert.equal(policyAllows(current, { tool: 'math.evaluate' }), true);
  const combined = governance.narrowPolicyDecision(original, current);
  assert.equal(policyAllows(combined, { tool: 'math.evaluate', model: 'google:gemini-3.8-flash' }), true);
  assert.equal(policyAllows(combined, { tool: 'web.evaluate' }), false);
  assert.equal(policyAllows(combined, { tool: 'math.calculate' }), false);
  assert.equal(policyAllows(combined, { model: 'google:other' }), false);
});

test('data-class policy also governs suffix denials and public-data empty allow-lists', () => {
  const secret = { governance: evaluatePolicy({ platform: { deniedDataClasses: ['*secret'] } }) };
  assert.equal(dataPolicyDecision(secret, ['workspace-secret'], 'model-provider', { explicitConsent: true }).allowed, false);
  const empty = { governance: evaluatePolicy({ platform: { allowedDataClasses: [] } }) };
  assert.equal(dataPolicyDecision(empty, ['public-web'], 'model-provider', { explicitConsent: true }).allowed, false);
});

test('unknown workspace roles fail closed in the composer', async () => {
  const { state, canEdit } = await import('../public/ui-core.js');
  for (const role of [null, undefined, '', 'owner', 'viewer']) {
    state.role = role;
    assert.equal(canEdit(), false, String(role));
  }
  state.role = 'editor';
  assert.equal(canEdit(), true);
  state.role = 'admin';
  assert.equal(canEdit(), true);
});

test('actual tool calls obey named tool policy, including changes at their boundary', async () => {
  const ctx = { scope: { principalId: 'p1', workspaceId: 'w1' }, run: { id: 'r1', principalId: 'p1', workspaceId: 'w1', surface: 'normal-chat', governance: evaluatePolicy({ platform: {}, workspace: { deniedTools: ['math.*'] } }) } };
  const denied = await useTool('math.evaluate', { expression: '2 + 2' }, ctx);
  assert.equal(denied.code, 'policy-blocked');
  ctx.run.governance = evaluatePolicy({ platform: {} });
  ctx.beforeTool = async () => { ctx.run.governance = evaluatePolicy({ platform: { allowedTools: [] } }); };
  const changed = await useTool('math.evaluate', { expression: '2 + 2' }, ctx);
  assert.equal(changed.code, 'policy-blocked');
});

test('composer role and quota gates preserve an editor stop control', async () => {
  const ui = await import('../public/ui-core.js');
  assert.equal(typeof ui.composerControls, 'function');
  assert.deepEqual(ui.composerControls({ role: 'viewer', usageLocked: false }), { canCompose: false, sendDisabled: true });
  assert.deepEqual(ui.composerControls({ role: null, active: true }), { canCompose: false, sendDisabled: true });
  assert.deepEqual(ui.composerControls({ role: 'editor', usageLocked: true, active: true }), { canCompose: false, sendDisabled: false });
  assert.deepEqual(ui.composerControls({ role: 'admin', usageLocked: true }), { canCompose: false, sendDisabled: true });
  assert.deepEqual(ui.composerControls({ role: 'editor', sending: true }), { canCompose: true, sendDisabled: true });
  assert.deepEqual(ui.composerControls({ role: 'editor', active: true, stopping: true }), { canCompose: true, sendDisabled: true });
});
import { executionContextKey, executionContextCurrent } from '../public/execution-context.js';

test('local continuation expires on attempts, repairs, challenges and account changes', () => {
  const scope = { principalId: 'person', workspaceId: 'workspace' };
  const challenge = { executionId: 'issued', nonceHash: 'nonce', payloadDigest: 'payload', expiresAt: new Date(Date.now() + 60000).toISOString() };
  const run = { id: 'run', next: 'code', attempt: 1, tasks: [{ id: 'code', metadata: { executionChallenge: challenge } }] };
  const context = executionContextKey(run, scope);
  assert.equal(executionContextCurrent(context, run, scope), true);
  assert.equal(executionContextCurrent(context, { ...run, attempt: 2 }, scope), false);
  assert.equal(executionContextCurrent(context, { ...run, adaptation: { codeRepairs: [{ attempt: 1 }] } }, scope), false);
  assert.equal(executionContextCurrent(context, run, { ...scope, principalId: 'other' }), false);
  assert.equal(executionContextCurrent(context, run, { ...scope, workspaceId: 'other' }), false);
  assert.equal(executionContextCurrent(context, { ...run, tasks: [{ id: 'code', metadata: { executionChallenge: { ...challenge, nonceHash: 'new' } } }] }, scope), false);
  const expired = { ...run, tasks: [{ id: 'code', metadata: { executionChallenge: { ...challenge, expiresAt: new Date(Date.now() - 1000).toISOString() } } }] };
  assert.equal(executionContextCurrent(executionContextKey(expired, scope), expired, scope), false);
});
