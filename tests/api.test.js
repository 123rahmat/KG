import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, jsonResponse, advanceTo, codeWritten } from './helpers.js';

// Runners configured, so plans include real code steps.
const RUNNERS = { SANDBOX_RUNNER_URL: 'https://code-runner.test', RUNNER_TOKEN: 'r'.repeat(40) };

const modelReply = (textValue, usage = { inputTokens: 10, outputTokens: 5 }, groundingMetadata = undefined) =>
  jsonResponse({
    candidates: [{
      content: { parts: [{ text: textValue }] },
      finishReason: 'STOP',
      ...(groundingMetadata ? { groundingMetadata } : {})
    }],
    usageMetadata: {
      promptTokenCount: Number(usage.inputTokens ?? usage.input_tokens ?? 0),
      candidatesTokenCount: Number(usage.outputTokens ?? usage.output_tokens ?? 0),
      totalTokenCount: Number(usage.inputTokens ?? usage.input_tokens ?? 0) + Number(usage.outputTokens ?? usage.output_tokens ?? 0)
    }
  });

const GROK = { AI_PROVIDER: 'xai', AI_API_KEY: 'test-key', AI_MODEL: 'grok-4.7' };
const requestFrom = body => {
  const system = body.systemInstruction?.parts?.filter(part => typeof part?.text === 'string').map(part => part.text).join('\n') ?? '';
  const contents = Array.isArray(body.contents) ? body.contents : [];
  const users = contents
    .filter(item => item?.role === 'user')
    .flatMap(item => Array.isArray(item?.parts) ? item.parts : [])
    .map(part => typeof part?.text === 'string' ? part.text : '')
    .reverse();
  let request = {};
  for (const text of users) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && parsed.task) {
        request = parsed;
        break;
      }
    } catch {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          const parsed = JSON.parse(text.slice(start, end + 1));
          if (parsed && typeof parsed === 'object' && parsed.task) {
            request = parsed;
            break;
          }
        } catch { /* plain-text model turn */ }
      }
    }
  }
  return { system, contents, request };
};
const CHAT_CLASSIFICATION = {
  actions: ['answer'],
  signals: {
    research: false, file: false, code: false, creation: false,
    invention: false, uncertainty: false, physical: false, highImpact: false
  },
  unknownSituation: false,
  confidence: 0.9
};
// The classifier's instructions are the system instruction; the goal is the user message.
const isClassification = options => requestFrom(JSON.parse(options.body)).system.startsWith('Classify the goal');

/** A passing verdict that checks every success criterion the run currently has. */
async function passingVerdict(call, auth, runId) {
  const current = await call('GET', `/api/runs/${runId}`, auth);
  return {
    verdict: {
      verdict: 'pass',
      criteria: current.body.situation.successCriteria.map(criterion => ({ criterion, met: true, reason: 'checked' })),
      problems: [],
      summary: 'All criteria met.'
    }
  };
}

/**
 * Reach the external code-execution stage: approve, record the generated
 * code artifact for build-code, and checkpoint it, so `test-code` is next.
 */
async function reachTestCode(call, auth, runId) {
  const run = await codeWritten(call, auth, runId, { source: 'print(2 + 2)', tests: '' });
  assert.equal(run.next, 'test-code');
}

/**
 * Walk a run through discovery: understanding says a new capability is
 * needed, and the discovery step reports `capabilities`. Returns the run.
 */
async function discover(call, auth, runId, capabilities) {
  const understood = await call('POST', `/api/runs/${runId}/advance`, {
    ...auth, body: { taskId: 'understand', summary: 'understand', evidence: { structured: { needsCapabilityDiscovery: true } } }
  });
  assert.equal(understood.status, 200);
  assert.equal(understood.body.next, 'discover-capabilities');
  const found = await call('POST', `/api/runs/${runId}/advance`, {
    ...auth, body: { taskId: 'discover-capabilities', summary: 'discovered', evidence: { structured: { capabilities } } }
  });
  assert.equal(found.status, 200);
  return found.body;
}

/* ------------------------------------------------------------- platform */

test('liveness stays up even when the database does not', () =>
  withServer(async ({ call, appPool }) => {
    await appPool.end();
    const health = await call('GET', '/api/health');
    assert.equal(health.status, 200);
    // Readiness is the probe that must fail, so an orchestrator stops routing
    // traffic here without also killing an otherwise healthy process.
    const ready = await call('GET', '/api/ready');
    assert.equal(ready.status, 503);
    assert.equal(ready.body.database, 'unavailable');
  }));

test('readiness reports what is actually configured', () =>
  withServer(async ({ call }) => {
    const { body } = await call('GET', '/api/ready');
    assert.equal(body.ok, true);
    assert.deepEqual(body.reasoning, { configured: false });
    assert.equal(body.runners.tools, false);
    assert.equal(body.runners.sandbox, false);
    assert.equal('professorCloudSimulation' in body.runners, false, 'no simulation runner exists');
    assert.equal(body.runners.localAgent, false);
  }));

test('configuration is validated before anything starts', async () => {
  const { loadConfig } = await import('../src/config.js');
  assert.throws(() => loadConfig({}), /DATABASE_URL is required/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'mysql://x/y' }), /must be a postgres/);
  assert.throws(
    () => loadConfig({ DATABASE_URL: 'postgres://x/y', AI_PROVIDER: 'nope', AI_API_KEY: 'k' }),
    /AI_PROVIDER must be one of/
  );
  assert.throws(
    () => loadConfig({ DATABASE_URL: 'postgres://x/y', NODE_ENV: 'production', COOKIE_SECURE: 'false' }),
    /COOKIE_SECURE=false in production/
  );
});

test('unknown API paths are JSON, not the single page app', () =>
  withServer(async ({ call, seed }) => {
    const { token } = await seed();
    const unknown = await call('GET', '/api/nope', { token });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 'no-route');

    const page = await call('GET', '/some/deep/link');
    assert.equal(page.status, 200);
    assert.match(page.body, /<!doctype html>/i);
  }));

test('every response carries a request id, and malformed JSON is a 400', () =>
  withServer(async ({ call, seed, base }) => {
    const { token } = await seed();
    const ok = await call('GET', '/api/me', { token });
    assert.match(ok.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);

    const bad = await fetch(`${base}/api/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{not json'
    });
    assert.equal(bad.status, 400);
    assert.equal((await call('GET', '/api/health')).status, 200, 'still serving');
  }));

/* -------------------------------------------------------------- workflow */

test('planning previews a goal without creating or executing anything', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: plan } = await call('POST', '/api/plan', {
      token, workspace, body: { goal: 'Simulate a pendulum.' }
    });
    assert.equal(plan.surface, 'code', 'a simulation is a code project');
    assert.ok(plan.tasks.every(task => task.status === 'pending'));

    const { body: runs } = await call('GET', '/api/runs', { token, workspace });
    assert.equal(runs.runs.length, 0, 'a preview is not a run');
  }));

test('a run persists, survives a reload, and lists newest first', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const first = await call('POST', '/api/runs', { token, workspace, body: { goal: 'Explain recursion.' } });
    const second = await call('POST', '/api/runs', { token, workspace, body: { goal: 'Simulate a pendulum.' } });
    assert.equal(first.status, 201);

    const reloaded = await call('GET', `/api/runs/${first.body.id}`, { token, workspace });
    assert.equal(reloaded.body.goal, 'Explain recursion.');
    // A plain question takes the direct workflow: answer, then verify.
    assert.equal(reloaded.body.next, 'respond');

    const { body: list } = await call('GET', '/api/runs', { token, workspace });
    assert.deepEqual(list.runs.map(run => run.id), [second.body.id, first.body.id]);
  }));

test('run listing pages with a cursor', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    for (let i = 0; i < 5; i += 1) {
      await call('POST', '/api/runs', { token, workspace, body: { goal: `Explain topic ${i}.` } });
    }
    const first = await call('GET', '/api/runs?limit=2', { token, workspace });
    assert.equal(first.body.runs.length, 2);
    assert.ok(first.body.nextCursor);

    const second = await call('GET', `/api/runs?limit=2&cursor=${first.body.nextCursor}`, { token, workspace });
    assert.equal(second.body.runs.length, 2);
    const overlap = second.body.runs.filter(run => first.body.runs.some(other => other.id === run.id));
    assert.equal(overlap.length, 0, 'pages must not repeat rows');
  }));

test('execution drives the model and records what it returned', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token, workspace, body: { goal: 'Explain recursion.', privacyConsent: { modelProvider: true } }
    });

    const executed = await call('POST', `/api/runs/${run.id}/execute`, { token, workspace, body: {} });
    assert.equal(executed.body.execution.executed, true);
    assert.equal(executed.body.execution.provider, 'google');

    const answered = executed.body.run.tasks.find(task => task.id === 'respond');
    assert.equal(answered.status, 'complete');
    assert.equal(answered.evidence.text, 'a real answer');
    // Tokens the provider actually reported are accumulated, including the
    // classification call made at creation; nothing is estimated.
    assert.equal(run.adaptation.classification.source, 'model');
    assert.equal(executed.body.run.tokensUsed, 4 + 15);
  }, {
    env: GROK,
    fetchImpl: async (_url, options) => isClassification(options)
      ? modelReply(JSON.stringify(CHAT_CLASSIFICATION), { input_tokens: 3, output_tokens: 1 })
      : modelReply('a real answer')
  }));

test('a configured model does not receive run content without consent', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token, workspace, body: { goal: 'Explain recursion.' }
    });
    const executed = await call('POST', `/api/runs/${run.id}/execute`, { token, workspace, body: {} });
    assert.equal(executed.status, 200);
    assert.equal(executed.body.execution.executed, false);
    assert.equal(executed.body.execution.status, 'consent-required');
    assert.equal(executed.body.run.tasks.find(task => task.id === 'respond').status, 'pending');
  }, {
    env: GROK,
    fetchImpl: async () => { throw new Error('the provider must not be called without consent'); }
  }));

test('with no model configured the task stays pending and says nothing ran', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token, workspace, body: { goal: 'Explain recursion.' }
    });
    const executed = await call('POST', `/api/runs/${run.id}/execute`, { token, workspace, body: {} });

    assert.equal(executed.status, 200);
    assert.equal(executed.body.execution.executed, false);
    assert.equal(executed.body.execution.status, 'not-configured');
    // A deployment gap must not burn an attempt or record a fake result.
    assert.equal(executed.body.run.tasks.find(task => task.id === 'respond').status, 'pending');
    assert.equal(executed.body.run.attempt, 1);
  }));

test('code goals go to the code runner, and an unreachable runner records nothing', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token, workspace, body: { goal: 'Refactor this Python module.' }
    });
    await reachTestCode(call, { token, workspace }, run.id);
    const executed = await call('POST', `/api/runs/${run.id}/execute`, { token, workspace, body: { executionTarget: 'general-ai-sandbox', approved: true } });
    assert.equal(executed.body.execution.executed, false);
    assert.equal(executed.body.execution.status, 'unreachable');
    assert.equal(executed.body.run.tasks.find(task => task.id === 'test-code').status, 'pending');
  }, {
    env: { SANDBOX_RUNNER_URL: 'http://code.invalid' },
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); }
  }));

test('Code Workspace is GitHub-only and keeps revision-bound write-back gates', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };

    const local = await call('POST', '/api/workspace/sources/local', {
      ...auth,
      body: { name: 'legacy-local', files: [{ path: 'src/app.js', content: 'one' }], write: true }
    });
    assert.equal(local.status, 404);

    const github = await call('POST', '/api/workspace/sources/github', {
      ...auth,
      body: { token: 'github-token', owner: 'demo', repo: 'app', ref: 'main', write: true }
    });
    assert.equal(github.status, 201);
    const source = github.body.source;
    assert.equal(source.kind, 'github');
    assert.equal(source.permissions.write, true);

    const reviewed = await call('POST', `/api/workspace/sources/${source.id}/review`, {
      ...auth,
      body: {
        expectedCommitSha: source.metadata.commitSha,
        changes: [{
          path: source.metadata.manifest[0].path,
          content: 'replacement',
          beforeDigest: source.metadata.manifest[0].digest
        }]
      }
    });
    assert.equal(reviewed.status, 200);
    assert.ok(reviewed.body.review.digest);
    assert.equal(reviewed.body.review.sourceRevision, source.metadata.commitSha);

    const stale = await call('POST', `/api/workspace/sources/${source.id}/review`, {
      ...auth,
      body: {
        expectedCommitSha: 'stale-revision',
        changes: [{
          path: source.metadata.manifest[0].path,
          content: 'replacement',
          beforeDigest: source.metadata.manifest[0].digest
        }]
      }
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'stale-github-revision');
  }, {
    fetchImpl: async (url) => {
      const value = String(url);
      if (value.endsWith('/repos/demo/app')) {
        return new Response(JSON.stringify({
          id: 1, full_name: 'demo/app', default_branch: 'main', private: true,
          html_url: 'https://github.com/demo/app', owner: { login: 'demo' }, name: 'app'
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (value.includes('/commits/main')) {
        return new Response(JSON.stringify({ sha: 'base123', commit: { tree: { sha: 'tree123' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (value.includes('/git/trees/base123?recursive=1')) {
        return new Response(JSON.stringify({
          truncated: false,
          tree: [{ type: 'blob', path: 'src/app.js', size: 1, sha: 'blob123' }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (value.includes('/git/blobs/blob123')) {
        return new Response(JSON.stringify({
          encoding: 'base64', content: Buffer.from('one').toString('base64')
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('unexpected GitHub request');
    }
  }));

test('research searches the web with the AI provider, reads what it found, and keeps the sources', () => {
  const calls = [];
  return withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token,
      workspace,
      body: { goal: 'Research the latest evidence about an unfamiliar topic.' }
    });

    await advanceTo(call, { token, workspace }, run.id, { until: 'investigate' });

    const current = await call('GET', '/api/runs/' + run.id, { token, workspace });
    assert.equal(current.body.next, 'investigate');

    const result = await call('POST', '/api/runs/' + run.id + '/execute', {
      token,
      workspace,
      body: { approved: true }
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.execution.executed, true);
    assert.equal(result.body.execution.text, 'Current research result, from example.com.');
    assert.equal(result.body.execution.citations[0].url, 'https://example.com/source');
    const research = result.body.run.tasks.find(task => task.id === 'investigate');
    // The sources and the tools used stay with the research, so the chat can show them.
    assert.equal(research.evidence.citations[0].url, 'https://example.com/source');
    assert.deepEqual(research.evidence.tools.map(item => [item.tool, item.outcome]), [['web.search', 'ok']]);
    assert.equal(research.status, 'complete');
    // Only the search itself used the provider's web search tool.
    assert.deepEqual(calls.map(body => Boolean(body.tools)), [false, false, true, false]);
  }, {
    env: GROK,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      const requestText = body.contents?.flatMap(item => item.parts ?? []).map(part => part.text ?? '').join('\n') ?? '';
      // The adaptive control plane is a real model participant before the
      // main executor. Keep its response separate so the research fixture
      // tests the actual tool-call -> grounded search -> synthesis sequence.
      if (requestText.includes('"controlTask"')) {
        return modelReply(JSON.stringify({
          status: 'ready',
          summary: 'Use the current research step.',
          toolsToUse: ['web.search'],
          toolsToAdd: [],
          toolsToRemove: [],
          dependencies: ['public-web'],
          data: { needed: true, sources: ['public-web'], handling: 'Public research only.' },
          terminalNeeded: false,
          testsNeeded: false,
          approvals: []
        }));
      }
      if (body.tools) {
        assert.ok(body.tools?.length, 'the search call asks for web search');
        return modelReply(
          'The newest study (2026) reports X.',
          { inputTokens: 12, outputTokens: 18 },
          { groundingChunks: [{ web: { uri: 'https://example.com/source', title: 'Example source' } }] }
        );
      }
      if (requestText.includes('"Tool result for web.search"')) {
        return modelReply('Current research result, from example.com.', { inputTokens: 5, outputTokens: 5 });
      }
      if (requestText.includes('"task":{"id":"investigate"')) {
        return modelReply('{"tool":"web.search","input":{"query":"latest evidence unfamiliar topic"}}');
      }
      return modelReply('Current research result, from example.com.', { inputTokens: 5, outputTokens: 5 });
    }
  });
});

test('verifying researched work checks its facts on the web, and an unsupported claim fails it', () => {
  const verifyCalls = [];
  return withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Research the latest evidence about an unfamiliar topic.', privacyConsent: { modelProvider: true } } });
    await advanceTo(call, auth, run.id, { until: 'investigate' });
    const researched = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: { approved: true } });
    assert.equal(researched.status, 200);
    // Record the remaining steps up to the check.
    for (let current = researched.body.run; current.next !== 'verify'; ) {
      const step = await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId: current.next, evidence: { recorded: true } } });
      assert.equal(step.status, 200, current.next);
      current = step.body.run ?? step.body;
    }

    const checked = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: { approved: true } });
    assert.equal(checked.status, 200);
    // The verifier searched the web itself and was told which sources the work rests on.
    assert.equal(verifyCalls.length, 1);
    assert.ok(verifyCalls[0].tools?.length, 'the verifier searches the web');
    const brief = requestFrom(verifyCalls[0]).request.verification;
    assert.equal(brief.groundedCheck, true);
    assert.deepEqual(brief.sources.map(item => item.url), ['https://example.com/source']);
    assert.deepEqual(brief.unretrievedLinks, ['https://invented.example/paper']);

    const verify = checked.body.run.tasks.find(task => task.id === 'verify');
    assert.equal(verify.status, 'failed');
    const verdict = verify.evidence.verdict;
    assert.equal(verdict.verdict, 'fail');
    assert.ok(verdict.problems.some(problem => problem.startsWith('Unsupported claim: The study found a 90% effect')));
    assert.ok(verdict.problems.some(problem => problem.includes('https://invented.example/paper')));
    assert.equal(verdict.grounding.checkedAgainstWeb, true);
    assert.deepEqual(verdict.grounding.sources.map(item => item.url), ['https://example.com/source', 'https://journal.example/study']);
  }, {
    env: GROK,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const { contents, request } = requestFrom(body);
      if (request.task?.type === 'verify') {
        verifyCalls.push(body);
        return modelReply(
          JSON.stringify({
            verdict: 'pass',
            criteria: (request.situation?.successCriteria ?? []).map(criterion => ({ criterion, met: true })),
            problems: [],
            claims: [{ claim: 'The study found a 90% effect', supported: false, note: 'The study reports 9%' }]
          }),
          { inputTokens: 8, outputTokens: 8 },
          { groundingChunks: [{ web: { uri: 'https://journal.example/study', title: 'The study' } }] }
        );
      }
      if (body.tools) {
        return modelReply(
          'The newest study reports X.',
          { inputTokens: 5, outputTokens: 5 },
          { groundingChunks: [{ web: { uri: 'https://example.com/source', title: 'Example source' } }] }
        );
      }
      if (request.task?.type === 'investigate' && !contents.some(message => message.role === 'model')) {
        return modelReply('{"tool":"web.search","input":{"query":"latest evidence"}}');
      }
      return modelReply('The study found a 90% effect (https://invented.example/paper).');
    }
  });
});

test('adaptive investigation uses the configured generic tool runner and explicit approval', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token,
      workspace,
      body: { goal: 'Research the latest evidence about an unfamiliar topic.' }
    });

    await advanceTo(call, { token, workspace }, run.id, { until: 'investigate' });

    const current = await call('GET', '/api/runs/' + run.id, { token, workspace });
    assert.equal(current.body.next, 'investigate');

    const blocked = await call('POST', '/api/runs/' + run.id + '/execute', {
      token, workspace, body: {}
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'execution-approval-required');

    const executed = await call('POST', '/api/runs/' + run.id + '/execute', {
      token,
      workspace,
      body: { approved: true }
    });
    assert.equal(executed.status, 200);
    assert.equal(executed.body.execution.executed, true);
    assert.equal(executed.body.execution.status, 'completed');
    // The research is recorded; the work goes on to its next step.
    assert.equal(executed.body.run.tasks.find(task => task.id === 'investigate').status, 'complete');
    assert.ok(executed.body.run.next && executed.body.run.next !== 'investigate');
  }, {
    env: {
      TOOL_RUNNER_URL: 'https://tool-runner.invalid',
      RUNNER_TOKEN: 'test-runner-token-123456789012345678901234567890'
    },
    fetchImpl: async (_url, options) => {
      assert.match(options.headers.authorization, /^Bearer /);
      return jsonResponse({
        executed: true,
        status: 'completed',
        evidence: [{ source: 'test', title: 'evidence' }]
      });
    }
  }));

test('a failing runner is reported as failed, never as a result', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token, workspace, body: { goal: 'Refactor this Python module.' }
    });
    await reachTestCode(call, { token, workspace }, run.id);
    const executed = await call('POST', `/api/runs/${run.id}/execute`, { token, workspace, body: { executionTarget: 'general-ai-sandbox', approved: true } });
    assert.equal(executed.body.execution.status, 'failed');
    assert.equal(executed.body.execution.code, 500);
  }, {
    env: { SANDBOX_RUNNER_URL: 'http://code.invalid' },
    fetchImpl: async () => jsonResponse({ error: 'boom' }, 500)
  }));

test('approval and iterate refuse to execute themselves', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed({
      policies: { workspace: { id: 'w', requireHumanApproval: true } }
    });
    const { body: run } = await call('POST', '/api/runs', {
      token, workspace, body: { goal: 'Explain recursion.' }
    });
    const waiting = await advanceTo(call, { token, workspace }, run.id, { until: 'approval', approve: false });
    assert.equal(waiting.tasks.find(task => task.id === waiting.next).type, 'approval');
    const blocked = await call('POST', `/api/runs/${run.id}/execute`, { token, workspace, body: {} });
    assert.equal(blocked.status, 409);
    // A system that auto-approves its own gate has no gate.
    assert.equal(blocked.body.code, 'awaiting-approval');

    const approval = await call('POST', `/api/runs/${run.id}/advance`, { token, workspace, body: { taskId: waiting.next, approved: true, summary: 'approved by Ada' } });
    assert.equal(approval.status, 200);
    const now = await call('GET', `/api/runs/${run.id}`, { token, workspace });
    assert.ok(now.body.next && now.body.next !== waiting.next, 'the approved work goes on');
  }));

test('workspace administrators can manage enterprise governance without touching platform policy', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const set = await call('POST', '/api/governance', {
      token, workspace,
      body: { layer: 'workspace', policy: { maxTokens: 1234, requireHumanApproval: true } }
    });
    assert.equal(set.status, 200);
    assert.equal(set.body.layer, 'workspace');

    const get = await call('GET', '/api/governance?layer=workspace', { token, workspace });
    assert.equal(get.status, 200);
    assert.equal(get.body.policy.maxTokens, 1234);

    const forbidden = await call('POST', '/api/governance', {
      token, workspace,
      body: { layer: 'platform', policy: { deniedCapabilities: ['code-execution'] } }
    });
    assert.equal(forbidden.status, 403);
  }));

test('an enterprise administrator can manage its organization policy', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed({
      workspace: 'enterprise-ws',
      organizationType: 'enterprise'
    });
    const set = await call('POST', '/api/governance', {
      token, workspace,
      body: { layer: 'organization', policy: { requireHumanApproval: true } }
    });
    assert.equal(set.status, 200);

    const response = await call('GET', '/api/governance?layer=organization', { token, workspace });
    assert.equal(response.status, 200);
    assert.equal(response.body.policy.requireHumanApproval, true);
  }));

test('a policy-blocked run refuses to execute and names the capability', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed({
      policies: { workspace: { id: 'w', deniedCapabilities: ['code-execution'] } }
    });
    const { body: run } = await call('POST', '/api/runs', {
      token, workspace,
      body: { goal: 'Write and run a Python script.' }
    });
    assert.equal(run.state, 'blocked');
    const attempt = await call('POST', `/api/runs/${run.id}/execute`, { token, workspace, body: {} });
    assert.equal(attempt.status, 409);
    assert.match(attempt.body.error, /code-execution/);
  }, { env: RUNNERS }));

test('iterate starts a new attempt and the budget eventually stops it', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Write a short report on recursion.' } });

    // Work up to the check, fail it, and decide to replan.
    const failAndReplan = async () => {
      const checking = await advanceTo(call, auth, run.id, { until: 'verify' });
      const criteria = checking.situation.successCriteria;
      const failed = await call('POST', `/api/runs/${run.id}/advance`, {
        ...auth, body: { taskId: checking.next, status: 'failed', evidence: { verdict: { verdict: 'fail', criteria: criteria.map(criterion => ({ criterion, met: false, reason: 'not yet' })), problems: ['incomplete'], summary: 'Not done.' } } }
      });
      assert.equal(failed.status, 200);
      // A run at its attempt ceiling becomes terminal immediately; otherwise
      // the workflow inserts the explicit iterate decision.
      if (failed.body.state === 'exhausted') return failed;
      assert.equal(failed.body.next, 'iterate');
      assert.equal(failed.body.tasks.find(task => task.id === failed.body.next)?.type, 'iterate');
      return call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId: failed.body.next, replan: true } });
    };

    const again = await failAndReplan();
    assert.equal(again.body.attempt, 2);
    assert.equal(again.body.state, 'understand');
    assert.deepEqual(again.body.tasks.map(task => [task.id, task.status]), [['understand', 'pending']], 'the next attempt grows again from understanding');

    // maxAttempts is 2 here, so the next replan is refused rather than looping.
    const exhausted = await failAndReplan();
    assert.equal(exhausted.body.state, 'exhausted');

    const after = await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId: 'understand' } });
    assert.equal(after.status, 409);
    assert.equal(after.body.code, 'run-terminal');
  }, { env: { MAX_RUN_ATTEMPTS: '2' } }));

test('finishing without a replan completes the run', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Write a short report on recursion.' } });
    const checking = await advanceTo(call, auth, run.id, { until: 'verify' });
    const verified = await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId: checking.next, evidence: await passingVerdict(call, auth, run.id) } });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.tasks.find(task => task.id === verified.body.next).type, 'deliver');
    const done = await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId: verified.body.next, summary: 'Delivered.' } });

    assert.equal(done.body.state, 'complete');
    assert.ok(done.body.completedAt);
  }));


/* ------------------------------------------------------------------ prefs */

test('account preferences are isolated and writable, and the built-in simulation API is gone', () =>
  withServer(async ({ call, seed }) => {
    const first = await seed({ workspace: 'pref-ws', name: 'First' });
    const second = await seed({ workspace: 'pref-ws', name: 'Second' });

    const pref = await call('PATCH', '/api/preferences', {
      token: first.token, body: { voiceInput: true, voiceLanguage: 'ur-PK', offlineQueue: true, simulationMode: 'continuous' }
    });
    assert.equal(pref.status, 200);
    assert.equal(pref.body.settings.voiceLanguage, 'ur-PK');
    assert.equal(pref.body.settings.simulationMode, undefined, 'settings of the removed simulation tab are not stored');

    const otherPref = await call('GET', '/api/preferences', { token: second.token });
    assert.deepEqual(otherPref.body.settings, {});

    const built = await call('POST', '/api/simulation/build', {
      token: first.token, workspace: first.workspace, body: { goal: 'Simulate an electrical motor.' }
    });
    assert.equal(built.status, 404);
    assert.equal(built.body.code, 'no-route');
  }));

/* --------------------------------------------------------------- objects */

test('objects round-trip and identical bytes are stored once', () =>
  withServer(async ({ call, seed, pool }) => {
    const { token, workspace } = await seed();
    const first = await call('POST', '/api/objects', {
      token, workspace, body: { name: 'a.txt', type: 'document', content: 'hello' }
    });
    const second = await call('POST', '/api/objects', {
      token, workspace, body: { name: 'b.txt', type: 'document', content: 'hello' }
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.digest, second.body.digest);
    assert.notEqual(first.body.id, second.body.id);

    const { rows } = await pool.query('SELECT ref_count FROM blobs WHERE digest = $1', [first.body.digest]);
    assert.equal(rows[0].ref_count, 2);

    // Deleting one keeps the other's content intact.
    await call('DELETE', `/api/objects/${first.body.id}`, { token, workspace });
    const still = await call('GET', `/api/objects/${second.body.id}/content`, { token, workspace });
    assert.equal(still.body, 'hello');

    await call('DELETE', `/api/objects/${second.body.id}`, { token, workspace });
    const after = await pool.query('SELECT COUNT(*)::int AS n FROM blobs');
    assert.equal(after.rows[0].n, 0, 'the last reference releases the bytes');
  }));

test('base64 content round-trips and invalid base64 is refused', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const encoded = Buffer.from('binary payload').toString('base64');
    const { body: object } = await call('POST', '/api/objects', {
      token, workspace, body: { name: 'bin', content: encoded, encoding: 'base64' }
    });
    const read = await call('GET', `/api/objects/${object.id}/content`, { token, workspace });
    assert.equal(read.body, 'binary payload');

    const bad = await call('POST', '/api/objects', {
      token, workspace, body: { name: 'bad', content: 'not!!valid!!base64', encoding: 'base64' }
    });
    assert.equal(bad.status, 400);
  }));

test('quotas are enforced per workspace', () =>
  withServer(async ({ call, seed, pool }) => {
    const { token, workspace } = await seed();
    await pool.query('UPDATE workspaces SET max_objects = 2, max_bytes = 40 WHERE id = $1', [workspace]);

    assert.equal((await call('POST', '/api/objects', { token, workspace, body: { content: 'a' } })).status, 201);
    assert.equal((await call('POST', '/api/objects', { token, workspace, body: { content: 'b' } })).status, 201);

    const overCount = await call('POST', '/api/objects', { token, workspace, body: { content: 'c' } });
    assert.equal(overCount.status, 413);
    assert.equal(overCount.body.code, 'quota-exceeded');
  }));

test('an object larger than the per-object limit is refused', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const response = await call('POST', '/api/objects', {
      token, workspace, body: { content: 'x'.repeat(2000) }
    });
    assert.equal(response.status, 413);
  }, { env: { MAX_OBJECT_BYTES: '1024', MAX_REQUEST_BYTES: '4096' } }));

test('usage reflects what is stored', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    await call('POST', '/api/objects', { token, workspace, body: { content: 'hello' } });
    const { body: usage } = await call('GET', '/api/objects/usage', { token, workspace });
    assert.equal(usage.objects, 1);
    assert.equal(usage.bytes, 5);
  }));

/* ----------------------------------------------------- idempotency, audit */

test('a retried POST with the same idempotency key does the work once', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const body = { goal: 'Explain recursion.' };
    const headers = { 'idempotency-key': 'abc-123' };

    const first = await call('POST', '/api/runs', { token, workspace, body, headers });
    const retry = await call('POST', '/api/runs', { token, workspace, body, headers });

    assert.equal(first.status, 201);
    assert.equal(retry.body.id, first.body.id, 'the same run comes back');
    assert.equal(retry.headers.get('idempotent-replay'), 'true');
    assert.equal((await call('GET', '/api/runs', { token, workspace })).body.runs.length, 1);

    // Reusing the key for a different body is a conflict, not a silent replay.
    const different = await call('POST', '/api/runs', {
      token, workspace, headers, body: { goal: 'Something else entirely.' }
    });
    assert.equal(different.status, 409);
    assert.equal(different.body.code, 'idempotency-mismatch');
  }));

test('the audit trail records allowed and denied actions alike', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token, workspace, body: { goal: 'Explain recursion.' }
    });
    await call('POST', `/api/runs/${run.id}/advance`, {
      token, workspace, body: { taskId: 'verify', evidence: 'forged' }
    });

    const { body: audit } = await call('GET', '/api/audit', { token, workspace });
    const actions = audit.entries.map(entry => `${entry.action}:${entry.outcome}`);
    assert.ok(actions.includes('run.create:allowed'));
    assert.ok(actions.includes('run.advance:denied'), 'the refused attempt is recorded too');
  }));

test('metrics are exported in Prometheus format', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    await call('GET', '/api/runs', { token, workspace });
    const { body, headers } = await call('GET', '/api/metrics', { token });
    assert.match(headers.get('content-type'), /text\/plain/);
    assert.match(body, /http_requests_total\{/);
    assert.match(body, /http_request_duration_ms_bucket\{/);
    // The series docs/ops/prometheus-alerts.yml alerts on are really exported.
    assert.match(body, /db_pool_connections\{state="waiting"\} \d+/);
    assert.match(body, /db_pool_connections\{state="total"\} \d+/);
  }));

test('the rate limiter answers with 429 and a retry hint', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    let limited = null;
    for (let i = 0; i < 12 && !limited; i += 1) {
      const response = await call('GET', '/api/runs', { token, workspace });
      if (response.status === 429) limited = response;
    }
    assert.ok(limited, 'the limiter must engage');
    assert.equal(limited.body.code, 'rate-limited');
    assert.ok(Number(limited.headers.get('retry-after')) >= 0);
  }, { env: { RATE_MAX: '5' } }));

test('object content is encrypted at rest and digests are workspace-scoped', () =>
  withServer(async ({ call, seed, pool }) => {
    const acme = await seed({ workspace: 'acme' });
    const other = await seed({ workspace: 'other' });

    const first = await call('POST', '/api/objects', {
      token: acme.token,
      workspace: 'acme',
      body: { name: 'secret.txt', content: 'sensitive payload' }
    });
    const second = await call('POST', '/api/objects', {
      token: other.token,
      workspace: 'other',
      body: { name: 'secret.txt', content: 'sensitive payload' }
    });

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.body.digest, second.body.digest);

    const raw = await pool.query(
      'SELECT bytes, encryption_version FROM blobs WHERE digest = $1',
      [first.body.digest]
    );
    assert.equal(raw.rows[0].encryption_version, 1);
    assert.notEqual(raw.rows[0].bytes.toString('utf8'), 'sensitive payload');

    const read = await call('GET', '/api/objects/' + first.body.id + '/content', {
      token: acme.token,
      workspace: 'acme'
    });
    assert.equal(read.body, 'sensitive payload');
  }));

test('managed sandbox execution must return an explicit execution receipt', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token,
      workspace,
      body: { goal: 'Build and run this Python program in the sandbox.' }
    });

    await reachTestCode(call, { token, workspace }, run.id);

    const executed = await call('POST', '/api/runs/' + run.id + '/execute', {
      token,
      workspace,
      body: {
        executionTarget: 'general-ai-sandbox',
        approved: true,
        payload: { language: 'python', source: 'print(2 + 2)' }
      }
    });

    assert.equal(executed.status, 200);
    assert.equal(executed.body.execution.executed, true);
    assert.equal(executed.body.run.tasks.find(task => task.id === 'test-code').status, 'complete');
    // Tested code is reassessed, then checked.
    assert.equal(executed.body.run.tasks.find(task => task.id === executed.body.run.next).type, 'reassess');
  }, {
    env: {
      SANDBOX_RUNNER_URL: 'https://sandbox-runner.invalid',
      RUNNER_TOKEN: 'test-runner-token-123456789012345678901234567890'
    },
    fetchImpl: async (_url, options) => {
      assert.match(options.headers.authorization, /^Bearer /);
      return jsonResponse({
        executed: true,
        status: 'completed',
        exitCode: 0,
        stdout: '4',
        stderr: ''
      });
    }
  }));

test('managed runner success without executed=true is rejected as a fake success', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token,
      workspace,
      body: { goal: 'Build and run this Python program in the sandbox.' }
    });

    await reachTestCode(call, { token, workspace }, run.id);

    const result = await call('POST', '/api/runs/' + run.id + '/execute', {
      token,
      workspace,
      body: { executionTarget: 'general-ai-sandbox', approved: true }
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.execution.executed, false);
    assert.equal(result.body.execution.status, 'invalid-runner-receipt');
    assert.equal(result.body.run.next, 'test-code');
  }, {
    env: { SANDBOX_RUNNER_URL: 'https://sandbox-runner.invalid' },
    fetchImpl: async () => jsonResponse({ status: 'completed' })
  }));

test('security profile exposes the enforced PA-ONE-X invariants without secrets', () =>
  withServer(async ({ call }) => {
    const response = await call('GET', '/api/security/profile');
    assert.equal(response.status, 200);
    assert.equal(response.body.model, 'PA-ONE-X');
    assert.equal(response.body.failClosed, true);
    assert.ok(response.body.invariants.includes('authenticated-execution-receipts'));
    assert.ok(response.body.algorithms.includes('AES-256-GCM'));
  }));

test('malformed infrastructure headers are rejected before routing', () =>
  withServer(async ({ call }) => {
    const response = await call('GET', '/api/health', {
      headers: { 'x-real-ip': 'forged' }
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid-proxy-metadata');
  }));

test('invalid trusted request ids are replaced at ingress', () =>
  withServer(async ({ call }) => {
    const response = await call('GET', '/api/health', {
      headers: { 'x-request-id': 'not valid spaces' }
    });
    assert.match(response.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  }));

test('audit history is immutable at the database layer', () =>
  withServer(async ({ call, seed, pool }) => {
    const { token, workspace } = await seed();
    // Only state changes are audited; create a run to produce a record.
    const created = await call('POST', '/api/runs', { token, workspace, body: { goal: 'Explain recursion.' } });
    assert.equal(created.status, 201);
    const result = await pool.query('SELECT id FROM audit_log WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1', [workspace]);
    assert.ok(result.rows[0]);
    await assert.rejects(
      pool.query('UPDATE audit_log SET outcome = $1 WHERE id = $2', ['tampered', result.rows[0].id]),
      /audit_log is append-only/
    );
  }));

test('understand can discover hidden novelty and expand the server-owned graph', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token,
      workspace,
      body: { goal: 'Create a device for an unusual environment.', privacyConsent: { modelProvider: true } }
    });

    // The workflow starts from understanding and grows from what it finds.
    assert.deepEqual(run.tasks.map(task => task.id), ['understand']);

    const executed = await call('POST', '/api/runs/' + run.id + '/execute', { token, workspace, body: {} });
    assert.equal(executed.status, 200);
    assert.equal(executed.body.execution.executed, true);

    // Understanding found that evidence is needed: research is added behind an approval.
    const expanded = executed.body.run;
    const gate = expanded.tasks.find(task => task.id === expanded.next);
    assert.equal(gate.type, 'approval');
    assert.equal(gate.metadata.approvalFor.type, 'investigate');
    const approved = await call('POST', '/api/runs/' + run.id + '/advance', { token, workspace, body: { taskId: gate.id, approved: true } });
    assert.equal(approved.status, 200);
    const afterApproval = await call('GET', '/api/runs/' + run.id, { token, workspace });
    assert.equal(afterApproval.body.tasks.find(task => task.id === afterApproval.body.next).type, 'investigate');
  }, {
    env: {
      AI_PROVIDER: 'xai',
      AI_API_KEY: 'test-key',
      AI_MODEL: 'grok-4.7'
    },
    fetchImpl: async () => modelReply(JSON.stringify({
      needsInvestigation: true,
      needsCapabilityDiscovery: true,
      unknownSituation: true,
      physical: true,
      highImpact: false,
      dataClasses: ['user-content'],
      successCriteria: ['produce a viable concept'],
      questions: [],
      candidateCapabilities: [{ id: 'environmental-device-analysis' }]
    }))
  }));

test('governance follows discovery: a high-impact capability found mid-run tightens it and is audited', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const created = await call('POST', '/api/runs', {
      token, workspace,
      body: { goal: 'Invent an unfamiliar tool for an unknown process.', privacyConsent: { modelProvider: true } }
    });
    assert.equal(created.status, 201);
    const run = created.body;
    const before = run.adaptation.governance;
    assert.ok(before, 'planning records situation governance');

    await discover(call, { token, workspace }, run.id, [{
      id: 'dosing-controller',
      purpose: 'Adjust a chemical dose automatically.',
      executionModes: ['tool'],
      risk: 'high',
      physical: true,
      highImpact: true,
      sideEffects: true
    }]);

    const { body: after } = await call('GET', '/api/runs/' + run.id, { token, workspace });
    const governance = after.adaptation.governance;
    assert.equal(governance.risk, 'high-impact');
    assert.equal(governance.status, 'review', 'high-impact work without a jurisdiction needs review');
    assert.ok(governance.execution.sideEffects.includes('dosing-controller'));
    assert.equal(governance.verification.humanCertificationRequired, true);
    assert.ok(governance.reevaluations >= 1);

    const { body: audit } = await call('GET', '/api/audit', { token, workspace });
    const escalation = audit.entries.find(entry => entry.action === 'run.governance.escalate');
    assert.ok(escalation, 'the escalation is audited');
    assert.equal(escalation.detail.to, 'review');
    assert.deepEqual(escalation.detail.capabilities, ['dosing-controller']);
  }));

test('discovered capability is persisted as a candidate and requires approval before dynamic execution', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const created = await call('POST', '/api/runs', { ...auth, body: { goal: 'Invent an unfamiliar tool for an unknown process.' } });
    assert.equal(created.status, 201);
    const run = created.body;

    const found = await discover(call, auth, run.id, [{
      id: 'unusual-tool', purpose: 'Perform a missing operation.', inputs: ['input'], outputs: ['result'],
      executionModes: ['tool'], risk: 'high', verification: { humanReviewRequired: true }
    }]);
    const specs = await call('GET', '/api/capability-specs', auth);
    assert.equal(specs.status, 200);
    assert.equal(specs.body.capabilities[0].status, 'candidate');

    // The person approves using it; the next step is the governed tool.
    const approveRun = await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId: found.next, approved: true, summary: 'approved execution' } });
    assert.equal(approveRun.status, 200);
    const tool = approveRun.body.tasks.find(task => task.id === approveRun.body.next);
    assert.equal(tool.type, 'tool');
    assert.deepEqual(tool.metadata.capabilitySpecs.map(spec => spec.id), ['unusual-tool']);

    // Until an administrator approves the capability itself, it does not run.
    const execute = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: { approved: true } });
    assert.equal(execute.status, 409);
    assert.equal(execute.body.code, 'capability-approval-required');

    const approved = await call('POST', '/api/capability-specs/unusual-tool/approve', { ...auth, body: {} });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, 'approved');
  }));

test('capability registry is isolated by workspace', () =>
  withServer(async ({ call, seed }) => {
    const first = await seed({ workspace: 'one' });
    const second = await seed({ workspace: 'two' });

    const firstCreate = await call('POST', '/api/runs', {
      token: first.token,
      workspace: first.workspace,
      body: { goal: 'Invent an unfamiliar capability for a new task.' }
    });
    assert.equal(firstCreate.status, 201);

    const secondList = await call('GET', '/api/capability-specs', {
      token: second.token,
      workspace: second.workspace
    });
    assert.equal(secondList.status, 200);
    assert.deepEqual(secondList.body.capabilities, []);
  }));

test('a malformed pagination cursor is a client error, not a database error', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const bad = Buffer.from(JSON.stringify({ c: 'not-a-date', i: 'x' })).toString('base64url');
    for (const path of ['/api/runs', '/api/objects']) {
      for (const cursor of [bad, 'garbage']) {
        const response = await call('GET', `${path}?cursor=${cursor}`, { token, workspace });
        assert.equal(response.status, 400, path);
        assert.equal(response.body.code, 'invalid-cursor', path);
      }
    }
  }));

test('paging never skips rows created within the same millisecond', () =>
  withServer(async ({ call, seed, pool }) => {
    const { token, workspace } = await seed();
    for (let i = 0; i < 4; i += 1) {
      const created = await call('POST', '/api/runs', { token, workspace, body: { goal: `Explain topic ${i}.` } });
      assert.equal(created.status, 201);
    }
    // Same millisecond, distinct microseconds: exactly what a JS Date
    // cursor would truncate away.
    await pool.query(
      `UPDATE runs SET created_at = timestamptz '2026-01-01 00:00:00.123000+00'
         + (random() * 900)::int * interval '1 microsecond'
        WHERE workspace_id = $1`,
      [workspace]
    );

    const seen = [];
    let cursor = null;
    do {
      const page = await call('GET', `/api/runs?limit=1${cursor ? `&cursor=${cursor}` : ''}`, { token, workspace });
      assert.equal(page.status, 200);
      seen.push(...page.body.runs.map(run => run.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    assert.equal(seen.length, 4);
    assert.equal(new Set(seen).size, 4);
  }));

test('unexpected errors never expose driver codes or row data', () =>
  withServer(async ({ call, seed, appPool: pool, logger }) => {
    const { token, workspace } = await seed();
    const query = pool.query.bind(pool);
    pool.query = (sql, ...rest) => {
      if (typeof sql === 'string' && sql.includes('FROM runs')) {
        const error = new Error('duplicate key value violates unique constraint "runs_pkey"');
        error.code = '23505';
        error.detail = 'Key (id)=(secret-row-id) already exists.';
        return Promise.reject(error);
      }
      return query(sql, ...rest);
    };
    const response = await call('GET', '/api/runs', { token, workspace });
    pool.query = query;

    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'internal');
    assert.equal(response.body.detail, undefined);
    assert.ok(!JSON.stringify(response.body).includes('secret-row-id'));
    assert.ok(response.body.requestId);
    assert.ok(logger.lines.some(line => line.requestId === response.body.requestId));
  }));

test('a declared data-class allow-list still fails closed for model reasoning', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed({
      policies: { platform: { id: 'p', allowedDataClasses: ['public-web'] } }
    });
    const { body: run } = await call('POST', '/api/runs', {
      token, workspace, body: { goal: 'Explain recursion.', privacyConsent: { modelProvider: true } }
    });
    const executed = await call('POST', `/api/runs/${run.id}/execute`, { token, workspace, body: {} });
    // Fail-closed allow-lists block it at the governance gate, before any
    // model call: the fetch below throws if the provider is ever reached.
    assert.equal(executed.status, 422);
    assert.equal(executed.body.code, 'situation-governance-blocked');
    assert.match(executed.body.error, /does not allow a required data class/);
  }, {
    env: GROK,
    fetchImpl: async () => { throw new Error('the provider must not be called when policy denies the data'); }
  }));

test('a declined model answer leaves the task pending and records nothing', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token, workspace, body: { goal: 'Explain recursion.', privacyConsent: { modelProvider: true } }
    });
    const executed = await call('POST', `/api/runs/${run.id}/execute`, { token, workspace, body: {} });
    assert.equal(executed.status, 200);
    assert.equal(executed.body.execution.executed, false);
    assert.equal(executed.body.execution.status, 'model-declined');
    const answered = executed.body.run.tasks.find(task => task.id === 'respond');
    assert.equal(answered.status, 'pending');
    assert.equal(answered.evidence, null);
  }, {
    env: { AI_PROVIDER: 'xai', AI_API_KEY: 'test-key' },
    fetchImpl: async () => jsonResponse({
      promptFeedback: { blockReason: 'SAFETY' },
      candidates: [],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 0, totalTokenCount: 3 }
    })
  }));

/* --------------------------------------------------- goal classification */

test('with consent, the model classification replaces misleading keywords', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    // Keywords read "figure out" as an unknown domain and "rise" as nothing;
    // the model reads an ordinary question.
    const goal = 'Figure out why my sourdough starter is not rising.';
    const keywordPlan = await call('POST', '/api/plan', { token, workspace, body: { goal } });
    assert.equal(keywordPlan.body.adaptation.classification.source, 'keywords');
    assert.equal(keywordPlan.body.adaptation.classification.reason, 'model-processing-not-permitted');
    assert.ok(keywordPlan.body.capabilities.required.includes('capability-discovery'));

    const modelPlan = await call('POST', '/api/plan', {
      token, workspace, body: { goal, privacyConsent: { modelProvider: true } }
    });
    assert.equal(modelPlan.body.adaptation.classification.source, 'model');
    assert.equal(modelPlan.body.intent.kind, 'chat');
    assert.ok(!modelPlan.body.capabilities.required.includes('capability-discovery'));
    assert.deepEqual(modelPlan.body.adaptation.surfaces, ['chat']);
  }, {
    env: GROK,
    fetchImpl: async (_url, options) => {
      assert.ok(isClassification(options), 'only the classifier may be called while planning');
      return modelReply(JSON.stringify(CHAT_CLASSIFICATION));
    }
  }));

test('the model cannot lower a risk the keyword rules detected', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const plan = await call('POST', '/api/plan', {
      token, workspace,
      body: { goal: 'Explain this patient diagnosis.', privacyConsent: { modelProvider: true }, jurisdiction: 'EU' }
    });
    assert.equal(plan.body.adaptation.classification.source, 'model');
    assert.equal(plan.body.adaptation.highImpactContext, true);
    assert.equal(plan.body.execution.approvalRequired, true);
  }, {
    env: GROK,
    fetchImpl: async () => modelReply(JSON.stringify(CHAT_CLASSIFICATION))
  }));

test('malformed or partial classifier output falls back to keywords', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const plan = await call('POST', '/api/plan', {
      token, workspace, body: { goal: 'Explain recursion.', privacyConsent: { modelProvider: true } }
    });
    assert.equal(plan.body.adaptation.classification.source, 'keywords');
    assert.equal(plan.body.adaptation.classification.reason, 'model-output-invalid');
    assert.equal(plan.body.intent.kind, 'chat');
  }, {
    env: GROK,
    // Unknown action and a missing signal: rejected as a whole, not trusted in part.
    fetchImpl: async () => modelReply(JSON.stringify({ ...CHAT_CLASSIFICATION, actions: ['answer', 'launch-missiles'] }))
  }));

test('governance that denies the model keeps classification on keywords', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed({
      policies: { platform: { id: 'p', deniedModels: ['*'] } }
    });
    const plan = await call('POST', '/api/plan', {
      token, workspace, body: { goal: 'Explain recursion.', privacyConsent: { modelProvider: true } }
    });
    assert.equal(plan.body.adaptation.classification.source, 'keywords');
    assert.equal(plan.body.adaptation.classification.reason, 'model-processing-not-permitted');
  }, {
    env: GROK,
    fetchImpl: async () => { throw new Error('a denied model must not be called'); }
  }));

test('a direct question is answered and verified in two steps, then completes', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token, workspace, body: { goal: 'Explain recursion.', privacyConsent: { modelProvider: true } }
    });
    assert.equal(run.workflow, 'direct');

    const answered = await call('POST', `/api/runs/${run.id}/execute`, { token, workspace, body: {} });
    assert.equal(answered.body.run.next, 'verify');
    const verified = await call('POST', `/api/runs/${run.id}/execute`, { token, workspace, body: {} });
    assert.equal(verified.body.run.state, 'complete');
    assert.equal(verified.body.run.tasks.find(task => task.id === 'respond').evidence.text, 'A function that calls itself.');
  }, {
    env: GROK,
    fetchImpl: async (_url, options) => {
      if (isClassification(options)) return modelReply(JSON.stringify(CHAT_CLASSIFICATION));
      const request = requestFrom(JSON.parse(options.body)).request;
      return modelReply(request.task.id === 'respond'
        ? 'A function that calls itself.'
        : JSON.stringify({
            verdict: 'pass',
            criteria: request.situation.successCriteria.map(criterion => ({ criterion, met: true, reason: 'defines recursion' })),
            problems: [],
            summary: 'Correct.'
          }));
    }
  }));

test('a capability found on reassessment is governed like any other, and two never collide', () =>
  withServer(async ({ call, seed, pool }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Invent an unfamiliar tool for an unknown process.' } });
    const capability = id => [{ id, purpose: 'Review.', executionModes: ['tool'], risk: 'medium' }];

    // The first capability: approval, then its governed tool step.
    const found = await discover(call, auth, run.id, capability('first-review'));
    const firstGate = found.next;
    const approved = await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId: firstGate, approved: true } });
    const firstTool = approved.body.next;
    assert.equal(approved.body.tasks.find(task => task.id === firstTool).type, 'tool');

    // Stand in for the tool having run, and for a reassessment the model
    // proposed after it; this test is about what the reassessment adds.
    await pool.query("UPDATE run_tasks SET status = 'complete', evidence = '{\"recorded\":true}' WHERE run_id = $1 AND id = $2", [run.id, firstTool]);
    await pool.query(
      `INSERT INTO run_tasks (run_id, id, position, type, status, depends_on, requires, purpose, metadata)
       VALUES ($1, 'reassess', 100, 'reassess', 'pending', $2::jsonb, '["reasoning"]'::jsonb, 'Reassess the situation.', '{}'::jsonb)`,
      [run.id, JSON.stringify([firstTool])]
    );
    const reassessed = await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId: 'reassess', evidence: { structured: { capabilities: capability('second-review') } } } });
    assert.equal(reassessed.status, 200);
    const secondGate = reassessed.body.tasks.find(task => task.id === reassessed.body.next);
    assert.equal(secondGate.type, 'approval', 'a second capability needs its own approval');
    assert.notEqual(secondGate.id, firstGate);
    const second = await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId: secondGate.id, approved: true } });
    const secondTool = second.body.tasks.find(task => task.id === second.body.next);
    assert.equal(secondTool.type, 'tool');
    assert.notEqual(secondTool.id, firstTool);
    assert.deepEqual(secondTool.metadata.capabilitySpecs.map(spec => spec.id), ['second-review']);
  }));

test('readiness reports 503 while the process drains for shutdown, and health stays up', () =>
  withServer(async ({ call, app }) => {
    assert.equal((await call('GET', '/api/ready')).status, 200);
    app.locals.draining = true;
    const draining = await call('GET', '/api/ready');
    assert.equal(draining.status, 503);
    assert.equal(draining.body.draining, true);
    assert.equal((await call('GET', '/api/health')).status, 200, 'liveness is unaffected, so the process is not killed early');
  }));

test('with METRICS_TOKEN, monitoring can read metrics even while the database is down', () =>
  withServer(async ({ call, appPool }) => {
    const token = 'm'.repeat(40);
    const page = await call('GET', '/api/metrics', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(page.status, 200);
    assert.match(page.body, /readiness_failures_total 0/, 'alerted counters exist from the start');
    assert.match(page.body, /rate_limit_store_errors_total 0/);

    await appPool.end(); // the application's database connections are gone
    const during = await call('GET', '/api/metrics', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(during.status, 200, 'the scrape does not need the database');
    assert.match(during.body, /db_pool_connections\{state="total"\}/);
  }, { env: { METRICS_TOKEN: 'm'.repeat(40) } }));

test('a wrong metrics token gets no bypass', () =>
  withServer(async ({ call }) => {
    const wrong = await call('GET', '/api/metrics', { headers: { authorization: `Bearer ${'x'.repeat(40)}` } });
    assert.equal(wrong.status, 401);
  }, { env: { METRICS_TOKEN: 'm'.repeat(40) } }));
