/**
 * Regression tests for the two failures that motivated this rebuild.
 *
 * 1. The workflow graph lived in the client, so a caller could post a graph
 *    with every dependency already complete and have the server record
 *    "verified" against no evidence.
 * 2. There was no authentication or tenancy at all: ownerId and workspaceId
 *    were read from the request body, and an unauthenticated list returned
 *    every object belonging to every tenant.
 *
 * Both are exercised here as attacks, not as happy paths.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, advanceTo, codeWritten } from './helpers.js';
import { mintKey, parseKey } from '../src/identity.js';
import { signExecutionReceipt } from '../src/execution.js';

// Runners configured, so plans include real code steps.
const RUNNERS = { SANDBOX_RUNNER_URL: 'https://code-runner.test', TOOL_RUNNER_URL: 'https://tool-runner.test', RUNNER_TOKEN: 'r'.repeat(40) };

test('the forged-graph attack cannot mark work verified', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const created = await call('POST', '/api/runs', {
      token, workspace, body: { goal: 'Explain recursion.' }
    });
    const run = created.body;

    // The old attack: send a graph asserting the dependencies are done.
    const forged = await call('POST', `/api/runs/${run.id}/advance`, {
      token, workspace,
      body: {
        taskId: 'verify',
        summary: 'All checks passed.',
        evidence: 'none whatsoever',
        // Every shape the client used to be trusted for:
        tasks: run.tasks.map(task => ({ ...task, status: 'complete' })),
        plan: { tasks: run.tasks.map(task => ({ ...task, status: 'complete' })) },
        state: 'complete',
        status: 'complete'
      }
    });

    assert.equal(forged.status, 409);
    assert.equal(forged.body.code, 'unmet-dependencies');
    // A plain question is answered directly; verify still depends on the answer.
    assert.deepEqual(forged.body.detail.unmet, ['respond']);

    // And the stored run is untouched by the attempt.
    const after = await call('GET', `/api/runs/${run.id}`, { token, workspace });
    assert.equal(after.body.tasks.find(task => task.id === 'verify').status, 'pending');
    assert.equal(after.body.state, 'respond');
  }));

test('tasks that record reality cannot complete without evidence', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    // A clarification records the person's answers; a verification records a verdict.
    const { body: vague } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Make my company website production ready.' } });
    const asking = await advanceTo(call, auth, vague.id, { until: 'clarify' });
    const bareClarify = await call('POST', `/api/runs/${vague.id}/advance`, { ...auth, body: { taskId: asking.next, summary: 'looked at it' } });
    assert.equal(bareClarify.status, 422);
    assert.equal(bareClarify.body.code, 'clarification-incomplete');

    const { body: report } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Write a short report on recursion.' } });
    const checking = await advanceTo(call, auth, report.id, { until: 'verify' });
    assert.equal(checking.tasks.find(task => task.id === checking.next).type, 'verify');
    const bareVerify = await call('POST', `/api/runs/${report.id}/advance`, { ...auth, body: { taskId: checking.next, summary: 'looked at it' } });
    assert.equal(bareVerify.status, 422);
    assert.equal(bareVerify.body.code, 'verification-not-passed');
    const after = await call('GET', `/api/runs/${report.id}`, auth);
    assert.equal(after.body.tasks.find(task => task.id === checking.next).status, 'pending');
  }));

test('every resource route refuses an unauthenticated caller', () =>
  withServer(async ({ call, seed }) => {
    const { workspace } = await seed();
    for (const [method, path] of [
      ['GET', '/api/me'], ['GET', '/api/runs'], ['POST', '/api/runs'],
      ['GET', '/api/objects'], ['POST', '/api/objects'], ['GET', '/api/audit']
    ]) {
      const response = await call(method, path, { workspace, body: method === 'POST' ? {} : undefined });
      assert.equal(response.status, 401, `${method} ${path}`);
    }
  }));

test('a tenant cannot read, write or even confirm another tenant', () =>
  withServer(async ({ call, seed }) => {
    const acme = await seed({ workspace: 'acme' });
    const other = await seed({ workspace: 'other' });

    const { body: secret } = await call('POST', '/api/objects', {
      token: acme.token, workspace: 'acme',
      body: { name: 'salaries.csv', type: 'document', content: 'CEO,2400000' }
    });

    // Listing is scoped to the caller's own workspace, never global.
    const mine = await call('GET', '/api/objects', { token: other.token, workspace: 'other' });
    assert.equal(mine.body.objects.length, 0);

    // Naming someone else's workspace is a 404, not a 403: confirming that a
    // workspace exists is itself something a stranger should not learn.
    const probe = await call('GET', '/api/objects', { token: other.token, workspace: 'acme' });
    assert.equal(probe.status, 404);

    // Knowing the object id is not enough either.
    const direct = await call('GET', `/api/objects/${secret.id}`, { token: other.token, workspace: 'other' });
    assert.equal(direct.status, 404);
    const content = await call('GET', `/api/objects/${secret.id}/content`, { token: other.token, workspace: 'other' });
    assert.equal(content.status, 404);
  }));

test('ownership is stamped from the caller, not from the request body', () =>
  withServer(async ({ call, seed }) => {
    const victim = await seed({ workspace: 'ws', name: 'Victim' });
    const attacker = await seed({ workspace: 'ws', role: 'editor', name: 'Attacker' });

    const { body: object } = await call('POST', '/api/objects', {
      token: attacker.token, workspace: 'ws',
      body: {
        name: 'planted.txt', content: 'x',
        ownerId: victim.principal.id,        // forged
        workspaceId: 'somewhere-else'        // forged
      }
    });

    assert.equal(object.ownerId, attacker.principal.id);
    assert.equal(object.workspaceId, 'ws');
  }));

test('roles are enforced per action', () =>
  withServer(async ({ call, seed }) => {
    const viewer = await seed({ workspace: 'ws', role: 'viewer' });
    const editor = await seed({ workspace: 'ws', role: 'editor' });

    assert.equal((await call('GET', '/api/runs', { token: viewer.token, workspace: 'ws' })).status, 200);

    const write = await call('POST', '/api/runs', {
      token: viewer.token, workspace: 'ws', body: { goal: 'Explain recursion.' }
    });
    assert.equal(write.status, 403);
    assert.equal(write.body.code, 'insufficient-role');

    // Audit is admin-only; an editor is not enough.
    assert.equal((await call('GET', '/api/audit', { token: editor.token, workspace: 'ws' })).status, 403);
    assert.equal((await call('POST', '/api/runs', {
      token: editor.token, workspace: 'ws', body: { goal: 'Explain recursion.' }
    })).status, 201);
  }));

test('a revoked key stops working immediately', () =>
  withServer(async ({ call, seed, identity }) => {
    const { token, workspace, keyId } = await seed();
    assert.equal((await call('GET', '/api/me', { token })).status, 200);
    await identity.revokeKey(keyId);
    const after = await call('GET', '/api/me', { token, workspace });
    assert.equal(after.status, 401);
    assert.match(after.body.error, /revoked/i);
  }));

test('API keys round-trip whatever random bytes they contain', () => {
  // The separator was "_", which is inside the base64url alphabet, so roughly
  // one key in three failed to parse — intermittently, in production.
  let failures = 0;
  for (let i = 0; i < 5000; i += 1) {
    const key = mintKey();
    const parsed = parseKey(key.token);
    if (!parsed || parsed.id !== key.id || parsed.secret !== key.secret) failures += 1;
  }
  assert.equal(failures, 0);
});

test('new keys start with kg., and keys issued with the earlier pai. prefix still sign in', () =>
  withServer(async ({ call, seed }) => {
    const { token } = await seed();
    assert.match(token, /^kg\./);
    const legacy = token.replace(/^kg\./, 'pai.');
    assert.equal((await call('GET', '/api/me', { token: legacy })).status, 200);
    assert.equal((await call('GET', '/api/me', { token: token.replace(/^kg\./, 'xx.') })).status, 401);
  }));

test('a bad key is rejected without revealing whether the id existed', () =>
  withServer(async ({ call, seed }) => {
    const { token } = await seed();
    const [, id] = token.split('.');

    const wrongSecret = await call('GET', '/api/me', { token: `kg.${id}.wrongsecretvalue` });
    const unknownId = await call('GET', '/api/me', { token: 'kg.doesnotexist.wrongsecretvalue' });

    assert.equal(wrongSecret.status, 401);
    assert.equal(unknownId.status, 401);
    assert.equal(wrongSecret.body.error, unknownId.body.error);
  }));

test('stored bytes are always served as a download, never as markup', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: object } = await call('POST', '/api/objects', {
      token, workspace,
      body: { name: 'x.html', contentType: 'text/html', content: '<script>alert(1)</script>' }
    });
    const response = await call('GET', `/api/objects/${object.id}/content`, { token, workspace });
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.equal(response.headers.get('content-disposition'), 'attachment');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }));

test('a cookie session cannot be driven cross-site', () =>
  withServer(async ({ call, seed, base }) => {
    const { token, workspace } = await seed();
    const signin = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: token })
    });
    const cookie = signin.headers.getSetCookie().find(value => value.startsWith('professor_session='));
    assert.ok(cookie.includes('HttpOnly'), 'cookie must be unreadable to script');
    assert.ok(cookie.includes('SameSite=Strict'));

    const jar = cookie.split(';')[0];
    // A GET works on the cookie alone.
    assert.equal((await call('GET', '/api/me', { headers: { cookie: jar } })).status, 200);

    // A write without the client header — what a cross-site form post looks
    // like — is refused.
    const forged = await call('POST', '/api/runs', {
      workspace, headers: { cookie: jar }, body: { goal: 'Explain recursion.' }
    });
    assert.equal(forged.status, 403);
    assert.equal(forged.body.code, 'csrf');

    const legitimate = await call('POST', '/api/runs', {
      workspace, headers: { cookie: jar, 'x-kindgleam-client': 'web' }, body: { goal: 'Explain recursion.' }
    });
    assert.equal(legitimate.status, 201);
    // Pages opened under an earlier product name still send their old header.
    for (const legacy of ['x-general-ai-client', 'x-professor-client']) {
      const earlier = await call('POST', '/api/runs', { workspace, headers: { cookie: jar, [legacy]: 'web' }, body: { goal: 'Explain recursion.' } });
      assert.equal(earlier.status, 201, legacy);
    }
  }));

test('client policy fields cannot override server-owned governance', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed({
      policies: { workspace: { id: 'w', deniedCapabilities: ['code-execution'] } }
    });

    const response = await call('POST', '/api/runs', {
      token, workspace,
      body: {
        goal: 'Write and run a Python script.',
        policies: { workspace: { deniedCapabilities: [] } }
      }
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.state, 'blocked');
    assert.deepEqual(response.body.capabilities.blocked, ['code-execution']);
  }, { env: RUNNERS }));

test('the strict content security policy leaves no inline escape hatch', () =>
  withServer(async ({ base }) => {
    const response = await fetch(`${base}/`);
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!csp.includes("'unsafe-inline'"), 'no inline scripts or styles are permitted');
  }));

test('secrets never reach the logs', () =>
  withServer(async ({ logger }) => {
    logger.error('boom', {
      apiKey: 'pai.abc.supersecret',
      authorization: 'Bearer pai.abc.supersecret',
      nested: { token: 'secret-token', content: 'user bytes', safe: 'kept' }
    });
    const line = JSON.stringify(logger.lines.at(-1));
    assert.ok(!line.includes('supersecret'));
    assert.ok(!line.includes('secret-token'));
    assert.ok(!line.includes('user bytes'));
    assert.ok(line.includes('kept'));
  }));


test('external execution cannot be claimed through manual advance', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token, workspace, body: { goal: 'Simulate a pendulum in Python.' }
    });

    // Clear the approval gate so the refusal below is about execution
    // itself, not an unmet dependency.
    const ready = await codeWritten(call, { token, workspace }, run.id);
    assert.equal(ready.next, 'test-code');

    const forged = await call('POST', `/api/runs/${run.id}/advance`, {
      token, workspace, body: { taskId: 'test-code', summary: 'tests passed' }
    });
    assert.equal(forged.status, 409);
    assert.equal(forged.body.code, 'execution-required');

    const after = await call('GET', `/api/runs/${run.id}`, { token, workspace });
    assert.equal(after.body.tasks.find(task => task.id === 'test-code').status, 'pending');
  }, { env: RUNNERS }));


test('execution approval cannot be self-approved by omitting the explicit decision', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Research the latest studies on intermittent fasting.' } });
    const waiting = await advanceTo(call, auth, run.id, { until: 'approval' });
    assert.equal(waiting.tasks.find(task => task.id === waiting.next).type, 'approval');

    const missingDecision = await call('POST', `/api/runs/${run.id}/advance`, {
      ...auth, body: { taskId: waiting.next, summary: 'approved' }
    });
    assert.equal(missingDecision.status, 422);
    assert.equal(missingDecision.body.code, 'approval-required');

    const approved = await call('POST', `/api/runs/${run.id}/advance`, {
      ...auth, body: { taskId: waiting.next, approved: true, summary: 'approved by user' }
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.tasks.find(task => task.id === waiting.next).status, 'complete');
  }, { env: RUNNERS }));

test('unsigned local execution receipts are rejected', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Run this Python code locally.' } });
    const ready = await codeWritten(call, auth, run.id);
    assert.equal(ready.next, 'test-code');

    const forged = await call('POST', `/api/runs/${run.id}/execution-result`, {
      ...auth,
      body: {
        taskId: 'test-code',
        executionTarget: 'local',
        receipt: { executed: true, status: 'completed', signature: 'fabricated' }
      }
    });
    assert.equal(forged.status, 403);
    assert.equal(forged.body.code, 'invalid-execution-receipt');
    const after = await call('GET', `/api/runs/${run.id}`, auth);
    assert.equal(after.body.tasks.find(task => task.id === 'test-code').status, 'pending');
  }, { env: RUNNERS }));


test('private runs and objects are invisible to another user in the same workspace', () =>
  withServer(async ({ call, seed }) => {
    const owner = await seed({ workspace: 'shared', role: 'editor', name: 'Owner' });
    const peer = await seed({ workspace: 'shared', role: 'editor', name: 'Peer' });

    const createdRun = await call('POST', '/api/runs', {
      token: owner.token, workspace: 'shared',
      body: { goal: 'Private planning note.' }
    });
    assert.equal(createdRun.status, 201);
    assert.equal(createdRun.body.visibility, 'private');

    const peerRuns = await call('GET', '/api/runs', {
      token: peer.token, workspace: 'shared'
    });
    assert.deepEqual(peerRuns.body.runs, []);

    const peerRun = await call('GET', '/api/runs/' + createdRun.body.id, {
      token: peer.token, workspace: 'shared'
    });
    assert.equal(peerRun.status, 404);

    const peerAdvance = await call('POST', '/api/runs/' + createdRun.body.id + '/advance', {
      token: peer.token, workspace: 'shared',
      body: { taskId: 'understand', summary: 'forged access' }
    });
    assert.equal(peerAdvance.status, 404);

    const createdObject = await call('POST', '/api/objects', {
      token: owner.token, workspace: 'shared',
      body: { name: 'private.txt', content: 'private', visibility: 'private' }
    });
    assert.equal(createdObject.status, 201);
    assert.equal(createdObject.body.visibility, 'private');

    const peerObjects = await call('GET', '/api/objects', {
      token: peer.token, workspace: 'shared'
    });
    assert.deepEqual(peerObjects.body.objects, []);

    const peerObject = await call('GET', '/api/objects/' + createdObject.body.id, {
      token: peer.token, workspace: 'shared'
    });
    assert.equal(peerObject.status, 404);

    const peerContent = await call('GET', '/api/objects/' + createdObject.body.id + '/content', {
      token: peer.token, workspace: 'shared'
    });
    assert.equal(peerContent.status, 404);
  }));

test('workspace sharing is explicit', () =>
  withServer(async ({ call, seed }) => {
    const owner = await seed({ workspace: 'shared', role: 'editor', name: 'Owner' });
    const peer = await seed({ workspace: 'shared', role: 'viewer', name: 'Peer' });

    const createdRun = await call('POST', '/api/runs', {
      token: owner.token, workspace: 'shared',
      body: { goal: 'Draft the class-shared workflow.', visibility: 'workspace' }
    });
    assert.equal(createdRun.status, 201);
    assert.equal(createdRun.body.visibility, 'workspace');

    const peerRun = await call('GET', '/api/runs/' + createdRun.body.id, {
      token: peer.token, workspace: 'shared'
    });
    assert.equal(peerRun.status, 200);
    assert.equal(peerRun.body.visibility, 'workspace');

    const createdObject = await call('POST', '/api/objects', {
      token: owner.token, workspace: 'shared',
      body: { name: 'shared.txt', content: 'shared', visibility: 'workspace' }
    });
    assert.equal(createdObject.status, 201);

    const peerObject = await call('GET', '/api/objects/' + createdObject.body.id, {
      token: peer.token, workspace: 'shared'
    });
    assert.equal(peerObject.status, 200);
  }));


test('situation identity and workspace scope come from authenticated context, not request JSON', () =>
  withServer(async ({ call, seed }) => {
    const seeded = await seed({ workspace: 'trusted', role: 'editor', name: 'Actual User' });
    const response = await call('POST', '/api/runs', {
      token: seeded.token, workspace: 'trusted',
      body: {
        goal: 'Prepare a project plan.',
        user: { id: 'forged-user', role: 'admin', email: 'other@example.com', skillLevel: 'beginner' },
        workspace: { id: 'forged-workspace', organizationType: 'enterprise', jurisdiction: 'XX' },
        skillLevel: 'beginner'
      }
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.situation.userProfile.skillLevel, 'beginner');
    assert.equal(response.body.workspaceId, 'trusted');
    assert.equal(response.body.situation.workspace.id, 'trusted');
    assert.notEqual(response.body.situation.userProfile.id, 'forged-user');
    assert.notEqual(response.body.situation.workspace.id, 'forged-workspace');
  }));

test('revoking an API key also ends browser sessions created from it', () =>
  withServer(async ({ call, seed, base, pool }) => {
    const { token, keyId, workspace } = await seed();
    const session = await fetch(base + '/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: token })
    });
    assert.equal(session.status, 200);
    const cookie = session.headers.get('set-cookie').split(';')[0];

    const before = await call('GET', '/api/runs', { workspace, headers: { cookie } });
    assert.equal(before.status, 200);

    // Revoke through the same code path the operator CLI uses.
    const { Identity } = await import('../src/identity.js');
    await new Identity(pool).revokeKey(keyId);

    const after = await call('GET', '/api/runs', { workspace, headers: { cookie } });
    assert.equal(after.status, 401);
  }));


test('server refuses to bypass a material clarification gate', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token, workspace,
      body: { goal: 'Build the best production-ready system for my company.' }
    });
    assert.equal(run.next, 'understand');

    const understood = await call('POST', `/api/runs/${run.id}/advance`, {
      token, workspace, body: { taskId: 'understand', summary: 'The goal is understood.' }
    });
    assert.equal(understood.status, 200);
    assert.equal(understood.body.next, 'clarify');

    const bypass = await call('POST', `/api/runs/${run.id}/advance`, {
      token, workspace, body: { taskId: 'adapt', summary: 'skip clarification' }
    });
    assert.equal(bypass.status, 409);
    assert.equal(bypass.body.code, 'clarification-required');

    const incomplete = await call('POST', `/api/runs/${run.id}/advance`, {
      token, workspace,
      body: {
        taskId: 'clarify',
        summary: 'Here are some notes.',
        evidence: { answers: { notes: 'still ambiguous' } }
      }
    });
    assert.equal(incomplete.status, 422);
    assert.equal(incomplete.body.code, 'clarification-incomplete');

    const clarified = await call('POST', `/api/runs/${run.id}/advance`, {
      token, workspace,
      body: {
        taskId: 'clarify',
        summary: 'Success means the deployed system passes the agreed acceptance test.',
        evidence: {
          answers: {
            successCriteria: ['The deployed system passes the agreed acceptance test.']
          },
          clarification: { acknowledged: true, humanProvided: true }
        }
      }
    });
    assert.equal(clarified.status, 200);
    // Answered, the gate opens: the work goes on to its next step.
    assert.ok(clarified.body.next && clarified.body.tasks.find(task => task.id === clarified.body.next).type !== 'clarify');
  }));

test('server verification requires a passing verdict for every success criterion', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token, workspace,
      body: {
        goal: 'Continue the draft explanation of recursion.',
        priorWork: ['draft'],
        currentState: 'draft'
      }
    });

    await advanceTo(call, { token, workspace }, run.id, { until: 'verify' });

    const rejected = await call('POST', `/api/runs/${run.id}/advance`, {
      token, workspace,
      body: {
        taskId: 'verify',
        evidence: {
          verdict: { verdict: 'pass', criteria: [], problems: [], summary: 'looks good' },
          verification: { level: 'evidence-backed', humanReviewed: false }
        }
      }
    });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.code, 'verification-criteria-incomplete');

    const current = await call('GET', `/api/runs/${run.id}`, { token, workspace });
    const liveCriteria = current.body.situation.successCriteria;
    const passed = await call('POST', `/api/runs/${run.id}/advance`, {
      token, workspace,
      body: {
        taskId: 'verify',
        evidence: {
          verdict: {
            verdict: 'pass',
            criteria: liveCriteria.map(criterion => ({ criterion, met: true, reason: 'Checked against the recorded evidence.' })),
            problems: [],
            summary: 'All criteria met.'
          },
          verification: { level: 'evidence-backed', humanReviewed: false }
        }
      }
    });
    assert.equal(passed.status, 200);
    assert.equal(passed.body.next, 'deliver');
  }));


test('replanning preserves failure lessons in the persistent situation', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token, workspace,
      body: {
        goal: 'Continue the draft explanation of recursion.',
        priorWork: ['draft'],
        currentState: 'draft'
      }
    });

    const failed = await call('POST', `/api/runs/${run.id}/advance`, {
      token, workspace,
      body: { taskId: 'understand', status: 'failed', summary: 'The first understanding pass was incomplete.' }
    });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.state, 'iterate');

    const replanned = await call('POST', `/api/runs/${run.id}/advance`, {
      token, workspace,
      body: { taskId: 'iterate', replan: true, summary: 'Rebuild the understanding from the failure.' }
    });
    assert.equal(replanned.status, 200);
    assert.equal(replanned.body.attempt, 2);
    assert.ok(replanned.body.situation.state.failedSteps.includes('understand'));
    assert.ok(replanned.body.adaptation.iterations.length >= 1);
  }));


test('arbitrary task statuses are rejected instead of being treated as completion', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token, workspace, body: { goal: 'Explain recursion.' }
    });
    const response = await call('POST', `/api/runs/${run.id}/advance`, {
      token, workspace, body: { taskId: 'respond', status: 'approved' }
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid-task-status');
  }));

test('verification cannot pass by duplicating one criterion and omitting another', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token, workspace,
      body: {
        goal: 'Continue the draft explanation of recursion.',
        priorWork: ['draft'],
        currentState: 'draft',
        successCriteria: ['includes a base case', 'stays under 200 words']
      }
    });
    await advanceTo(call, { token, workspace }, run.id, { until: 'verify' });

    const response = await call('POST', `/api/runs/${run.id}/advance`, {
      token, workspace,
      body: {
        taskId: 'verify',
        evidence: {
          verdict: {
            verdict: 'pass',
            criteria: [
              { criterion: 'includes a base case', met: true, reason: 'checked' },
              { criterion: 'includes a base case', met: true, reason: 'duplicated' }
            ],
            problems: []
          }
        }
      }
    });
    assert.equal(response.status, 422);
    assert.equal(response.body.code, 'verification-criteria-incomplete');
  }));

test('explicit workspace sharing permits editor collaboration but not viewer writes', () =>
  withServer(async ({ call, seed }) => {
    const owner = await seed({ workspace: 'collab', role: 'editor', name: 'Owner' });
    const editor = await seed({ workspace: 'collab', role: 'editor', name: 'Editor' });
    const viewer = await seed({ workspace: 'collab', role: 'viewer', name: 'Viewer' });

    const { body: run } = await call('POST', '/api/runs', {
      token: owner.token, workspace: 'collab',
      body: { goal: 'Draft the class-shared workflow.', visibility: 'workspace' }
    });
    const editorAdvance = await call('POST', `/api/runs/${run.id}/advance`, {
      token: editor.token, workspace: 'collab',
      body: { taskId: 'plan', summary: 'collaborator attempted the wrong stage' }
    });
    // A later stage does not exist until the work reaches it; it cannot be jumped to.
    assert.equal(editorAdvance.status, 404);
    assert.equal(editorAdvance.body.code, 'unknown-task');

    const validEditorAdvance = await call('POST', `/api/runs/${run.id}/advance`, {
      token: editor.token, workspace: 'collab',
      body: { taskId: 'understand', summary: 'editor advanced the shared workflow' }
    });
    assert.equal(validEditorAdvance.status, 200);
    assert.ok(validEditorAdvance.body.next);

    const viewerAdvance = await call('POST', `/api/runs/${run.id}/advance`, {
      token: viewer.token, workspace: 'collab',
      body: { taskId: validEditorAdvance.body.next, summary: 'viewer write' }
    });
    assert.equal(viewerAdvance.status, 403);
    assert.equal(viewerAdvance.body.code, 'insufficient-role');
  }));

test('completed, blocked and exhausted runs cannot be force-failed', () =>
  withServer(async ({ call, seed, pool }) => {
    const { token, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token, workspace, body: { goal: 'Explain recursion.' }
    });
    await pool.query("UPDATE runs SET state = 'complete', completed_at = now() WHERE id = $1", [run.id]);

    const response = await call('POST', `/api/runs/${run.id}/fail`, {
      token, workspace, body: { reason: 'late mutation' }
    });
    assert.equal(response.status, 404);
  }));


const challengeSecret = 's'.repeat(64);
test('local execution challenges are stored hashed and become stale across run attempts', () =>
  withServer(async ({ call, seed, pool }) => {
    const secret = challengeSecret;
    const { token, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token, workspace, body: { goal: 'Simulate a pendulum in Python.' }
    });

    assert.equal((await codeWritten(call, { token, workspace }, run.id)).next, 'test-code');

    const challenged = await call('POST', `/api/runs/${run.id}/execute`, {
      token, workspace,
      body: {
        executionTarget: 'local',
        approved: true,
        preflight: {
          cpuCores: 8,
          memoryBytes: 32 * 1024 ** 3,
          availableStorageBytes: 32 * 1024 ** 3,
          agent: { available: true, version: 'test' }
        }
      }
    });
    assert.equal(challenged.status, 200);
    const request = challenged.body.execution.request;
    assert.equal(request.executionChallenge.attempt, 1);

    const { rows: [task] } = await pool.query(
      "SELECT metadata FROM run_tasks WHERE run_id = $1 AND id = 'test-code'",
      [run.id]
    );
    assert.equal(task.metadata.executionChallenge.attempt, 1);
    assert.equal(task.metadata.executionChallenge.nonce, undefined);
    assert.match(task.metadata.executionChallenge.nonceHash, /^[0-9a-f]{64}$/);
    assert.match(task.metadata.executionChallenge.payloadDigest, /^[A-Za-z0-9_-]+$/);

    const now = new Date().toISOString();
    const receipt = {
      executed: true,
      status: 'completed',
      exitCode: 0,
      stdout: 'simulated',
      stderr: '',
      outputTruncated: false,
      startedAt: now,
      completedAt: now,
      agentVersion: 'test',
      attempt: 1,
      challengeNonce: request.executionChallenge.nonce,
      executionId: request.executionId,
      executionTarget: 'local',
      payloadDigest: request.executionChallenge.payloadDigest
    };
    receipt.signature = signExecutionReceipt(secret, {
      runId: run.id,
      taskId: 'test-code',
      taskType: 'code',
      attempt: 1,
      challengeNonce: request.executionChallenge.nonce,
      receipt
    });

    await pool.query("UPDATE runs SET attempt = 2 WHERE id = $1", [run.id]);
    const stale = await call('POST', `/api/runs/${run.id}/execution-result`, {
      token, workspace,
      body: { taskId: 'test-code', executionTarget: 'local', receipt }
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'stale-execution-receipt');

    const { rows: [after] } = await pool.query(
      "SELECT metadata FROM run_tasks WHERE run_id = $1 AND id = 'test-code'",
      [run.id]
    );
    assert.ok(after.metadata.executionChallenge, 'a stale receipt must not consume the current challenge');
  }, {
    env: {
      LOCAL_AGENT_URL: 'http://127.0.0.1:8765',
      LOCAL_AGENT_SHARED_SECRET: challengeSecret
    }
  }));

test('behind a trusted proxy, a forged X-Forwarded-For cannot dodge the login rate limit', () =>
  withServer(async ({ call }) => {
    // The proxy appends the real client address; the client controls
    // everything to its left. Each attempt forges a new left-most address.
    const statuses = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await call('POST', '/api/session', {
        body: { apiKey: 'wrong-key' },
        headers: { 'x-forwarded-for': `198.51.100.${attempt + 1}, 203.0.113.9` }
      });
      statuses.push(response.status);
    }
    assert.ok(statuses.includes(429), `attempts are limited by the real address: ${statuses.join(',')}`);
  }, { env: { TRUST_PROXY: 'true' } }));

test('a person checking the result is shown every point the check is graded on, and can pass it', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Continue the draft guide to caring for a basil plant.', priorWork: ['draft'], currentState: 'draft' } });
    // Understanding adds evidence the result must show: the graded points grow.
    await advanceTo(call, auth, run.id, { until: 'verify', evidence: { structured: { requiredEvidence: ['watering schedule stated', 'light needs stated'] } } });
    // The rest is done by a person, as someone without an AI would.
    let current = (await call('GET', `/api/runs/${run.id}`, auth)).body;
    for (let i = 0; i < 12 && current.next && current.next !== 'verify'; i += 1) {
      const task = current.tasks.find(item => item.id === current.next);
      const step = await call('POST', `/api/runs/${run.id}/advance`, {
        ...auth,
        body: task.type === 'approval' ? { taskId: task.id, approved: true } : {
          taskId: task.id, summary: 'Done by a person.',
          evidence: { humanProvided: true, findings: 'Water when the top soil is dry; six hours of sun.', text: 'Water when the top soil is dry. Give it six hours of sun.' }
        }
      });
      assert.equal(step.status, 200, `${task.id}: ${JSON.stringify(step.body).slice(0, 200)}`);
      current = (await call('GET', `/api/runs/${run.id}`, auth)).body;
    }
    assert.equal(current.next, 'verify', JSON.stringify(current.tasks.map(task => task.id + ':' + task.status)));
    const shown = current.verificationCriteria;
    assert.ok(shown.includes('watering schedule stated') && shown.includes('light needs stated'), JSON.stringify(shown));
    const passed = await call('POST', `/api/runs/${run.id}/advance`, {
      ...auth,
      body: {
        taskId: 'verify', summary: 'Checked by a person.',
        evidence: {
          verdict: { verdict: 'pass', criteria: shown.map(criterion => ({ criterion, met: true, reason: 'Checked by a person.' })), problems: [], summary: 'Checked by a person.' },
          verification: { level: 'human-certified', humanReviewed: true, method: 'A person checked the result against each point.' }
        }
      }
    });
    assert.equal(passed.status, 200, JSON.stringify(passed.body).slice(0, 300));
  }));

test('every page carries the anti-framing, no-sniff and strict content policies', () =>
  withServer(async ({ base }) => {
    const response = await fetch(base + '/?signin=secret-token');
    const header = name => response.headers.get(name) ?? '';
    assert.equal(header('x-frame-options'), 'DENY');
    assert.equal(header('x-content-type-options'), 'nosniff');
    assert.equal(header('referrer-policy'), 'no-referrer', 'a sign-in link in the address bar is never sent on as a referrer');
    const csp = header('content-security-policy');
    for (const directive of ["script-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "img-src 'self' data:"]) {
      assert.ok(csp.includes(directive), directive);
    }
    assert.equal(response.headers.get('x-powered-by'), null);
  }));

test('request bodies cannot carry prototype keys', () =>
  withServer(async ({ call, seed }) => {
    const user = await seed({ workspace: 'ws' });
    const response = await call('PATCH', '/api/preferences', {
      token: user.token,
      body: JSON.parse('{"theme":"dark","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}')
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.settings.theme, 'dark');
    assert.equal({}.polluted, undefined);
    assert.equal(Object.hasOwn(response.body.settings, '__proto__'), false);
  }));
