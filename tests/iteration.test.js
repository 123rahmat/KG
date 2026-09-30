/**
 * Verify, fail, learn, iterate. A failed step must never strand a run, and a
 * new attempt must know what went wrong in the last one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, jsonResponse, stepsIn, advanceTo } from './helpers.js';

/** Walk a run to its verify step by recording each earlier step by hand. */
async function walkToVerify(call, auth, run) {
  let current = (await call('GET', `/api/runs/${run.id}`, auth)).body;
  for (let i = 0; i < 12 && current.next; i += 1) {
    const task = current.tasks.find(item => item.id === current.next);
    if (task.type === 'verify') break;
    const body = task.type === 'approval'
      ? { taskId: task.id, approved: true }
      : { taskId: task.id, summary: `${task.id} done`, evidence: { text: 'Recursion is when a function calls itself.' } };
    const step = await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body });
    assert.equal(step.status, 200, task.id);
    current = step.body;
  }
  assert.equal(current.tasks.find(task => task.id === current.next)?.type, 'verify');
  return current;
}

const failVerify = (call, auth, run) => call('POST', `/api/runs/${run.id}/advance`, {
  ...auth, body: { taskId: 'verify', status: 'failed', summary: 'Missing the base case.', evidence: { problems: ['no base case explained'] } }
});

test('a failed verification leads to a decision, and a replan remembers why', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    for (const [goal, firstStep] of [['Write a short report on recursion.', 'understand'], ['Explain recursion.', 'respond']]) {
      const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal } });
      await walkToVerify(call, auth, run);

      const failed = await failVerify(call, auth, run);
      assert.equal(failed.body.state, 'iterate', goal);
      const blocked = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
      assert.equal(blocked.body.code, 'decision-required', goal);

      const replanned = await call('POST', `/api/runs/${run.id}/advance`, {
        ...auth, body: { taskId: 'iterate', replan: true, summary: 'Add the base case.' }
      });
      assert.equal(replanned.status, 200, goal);
      assert.equal(replanned.body.attempt, 2);
      assert.equal(replanned.body.state, firstStep, 'the new attempt starts at its real first step');
      assert.ok(replanned.body.tasks.every(task => task.status === 'pending'));

      const [lesson] = replanned.body.adaptation.iterations;
      assert.equal(lesson.attempt, 1);
      assert.equal(lesson.reason, 'Add the base case.');
      assert.equal(lesson.failed[0].taskId, 'verify');
      assert.match(lesson.failed[0].evidence, /no base case/);
      assert.ok(replanned.body.situation.state.failedSteps.includes('verify'), 'the situation records the failure');
      assert.equal(replanned.body.situation.phase, 'recovery');
    }
  }));

test('stopping after a failure ends the run as failed, keeping its evidence', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Explain recursion.' } });
    await walkToVerify(call, auth, run);
    await failVerify(call, auth, run);
    const stopped = await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId: 'iterate', replan: false } });
    assert.equal(stopped.body.state, 'failed');
    assert.ok(stopped.body.tasks.find(task => task.id === 'verify').evidence.problems);
  }));

test('replanning stops at the attempt budget', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Explain recursion.' } });
    await walkToVerify(call, auth, run);
    await failVerify(call, auth, run);
    const exhausted = await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId: 'iterate', replan: true } });
    assert.equal(exhausted.body.state, 'exhausted');
  }, { env: { MAX_RUN_ATTEMPTS: '1' } }));

/* ------------------------------------------ the whole loop through a model */

const pass = { verdict: 'pass', criteria: [{ criterion: 'includes a base case', met: true, reason: 'shown' }], problems: [], summary: 'Meets the criteria.' };
const fail = { verdict: 'fail', criteria: [{ criterion: 'includes a base case', met: false, reason: 'no base case' }], problems: ['no base case explained'], summary: 'Incomplete.' };
const reply = text => jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 5, output_tokens: 5 } });

test('the situation shapes the work, verification judges it, and a replan learns', () => {
  const prompts = [];
  let verifications = 0;
  return withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', {
      ...auth,
      body: {
        goal: 'Explain recursion.',
        privacyConsent: { modelProvider: true },
        skillLevel: 'beginner',
        language: 'fr',
        successCriteria: ['includes a base case'],
        constraints: ['under 200 words']
      }
    });
    const execute = () => call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });

    await execute();
    const first = prompts.find(p => p.task.id === 'respond');
    assert.equal(first.situation.user.skillLevel, 'beginner');
    assert.equal(first.situation.user.language, 'fr');
    assert.equal(first.situation.presentation, 'guided');
    assert.ok(first.situation.successCriteria.includes('includes a base case'));
    assert.ok(first.situation.constraints.includes('under 200 words'));
    assert.equal(first.previousAttempts, undefined, 'nothing to learn from yet, so nothing is sent');

    const judged = await execute();
    assert.equal(judged.body.run.state, 'iterate', 'a failing verdict fails the check');
    const verify = judged.body.run.tasks.find(task => task.id === 'verify');
    assert.equal(verify.status, 'failed');
    assert.match(verify.summary, /no base case/);
    assert.ok(prompts.find(p => p.task.id === 'verify').situation.successCriteria.includes('includes a base case'),
      'the verifier judges against the success criteria');

    await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId: 'iterate', replan: true, summary: 'Add a base case.' } });
    prompts.length = 0;
    await execute();
    const second = prompts.find(p => p.task.id === 'respond');
    assert.equal(second.previousAttempts.length, 1);
    assert.ok(second.previousAttempts[0].problems.some(problem => /no base case/.test(problem)), 'the new attempt is told what failed');
    assert.equal(second.situation.phase, 'recovery');

    const done = await execute();
    assert.equal(done.body.run.state, 'complete');
    assert.equal(done.body.run.attempt, 2);
    assert.equal(done.body.run.tasks.find(task => task.id === 'verify').evidence.verdict.verdict, 'pass');
  }, {
    env: { AI_PROVIDER: 'anthropic', AI_API_KEY: 'test-key', AI_MODEL: 'claude-opus-5-5' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (String(body.system ?? '').startsWith('Classify')) return reply('{}');
      const user = body.messages.find(message => message.role === 'user')?.content ?? '{}';
      const prompt = JSON.parse(typeof user === 'string' ? user : '{}');
      prompts.push(prompt);
      if (prompt.task.id !== 'verify') return reply('La récursion : une fonction qui s\'appelle elle-même.');
      verifications += 1;
      return reply(JSON.stringify(verifications === 1 ? fail : pass));
    }
  });
});

test('an unreadable verdict records nothing', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Explain recursion.', privacyConsent: { modelProvider: true } } });
    await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
    const judged = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
    assert.equal(judged.body.execution.status, 'verification-inconclusive');
    assert.equal(judged.body.run.tasks.find(task => task.id === 'verify').status, 'pending');
  }, {
    env: { AI_PROVIDER: 'anthropic', AI_API_KEY: 'test-key', AI_MODEL: 'claude-opus-5-5' },
    fetchImpl: async () => reply('Looks fine to me.')
  }));

test('a pass that lists a problem is treated as a fail', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Explain recursion.', privacyConsent: { modelProvider: true } } });
    await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
    const judged = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
    assert.equal(judged.body.run.state, 'iterate');
  }, {
    env: { AI_PROVIDER: 'anthropic', AI_API_KEY: 'test-key', AI_MODEL: 'claude-opus-5-5' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const user = body.messages.find(message => message.role === 'user')?.content ?? '{}';
      const task = JSON.parse(typeof user === 'string' ? user : '{}').task?.id;
      return reply(task === 'verify' ? JSON.stringify({ ...pass, problems: ['one claim is unsupported'] }) : 'An answer.');
    }
  }));


test('generated code is carried into the authorized execution stage', () => {
  const runnerRequests = [];
  return withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', {
      ...auth,
      body: {
        goal: 'Build and test a Python function.',
        privacyConsent: { modelProvider: true }
      }
    });

    await advanceTo(call, auth, run.id, { until: 'code' });

    const built = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
    assert.equal(built.status, 200);
    assert.deepEqual(built.body.execution.structured, {
      language: 'python',
      source: 'print(42)',
      notes: 'generated for the approved plan'
    });

    const tested = await call('POST', `/api/runs/${run.id}/execute`, {
      ...auth, body: { approved: true }
    });
    assert.equal(tested.status, 200, JSON.stringify(tested.body).slice(0, 400));
    assert.equal(tested.body.execution.executed, true);
    assert.equal(runnerRequests.length, 1);
    assert.equal(runnerRequests[0].payload.language, 'python');
    assert.equal(runnerRequests[0].payload.source, 'print(42)');
  }, {
    env: {
      AI_PROVIDER: 'anthropic',
      AI_MODEL: 'claude-opus-5-5',
      AI_API_KEY: 'test-key',
      SANDBOX_RUNNER_URL: 'http://sandbox.test',
      RUNNER_TOKEN: 'runner-' + 'x'.repeat(31)
    },
    fetchImpl: async (url, options) => {
      // Everything but the sandbox runner is the AI provider.
      if (!String(url).startsWith('http://sandbox.test')) {
        const body = JSON.parse(options.body);
        const user = body.messages.find(message => message.role === 'user')?.content ?? '{}';
        const task = JSON.parse(typeof user === 'string' ? user : '{}').task?.id;
        if (task === 'build-code') {
          return jsonResponse({
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: JSON.stringify({
              language: 'python',
              source: 'print(42)',
              notes: 'generated for the approved plan'
            }) }],
            usage: { input_tokens: 3, output_tokens: 3 }
          });
        }
        return jsonResponse({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Done.' }],
          usage: { input_tokens: 2, output_tokens: 2 }
        });
      }
      runnerRequests.push(JSON.parse(options.body));
      return jsonResponse({
        executed: true,
        status: 'completed',
        output: { stdout: '42' }
      });
    }
  });
});


test('failing code goes back with its error output for a targeted fix, and stops when fixes stop helping', () => {
  const builds = [];
  let runs = 0;
  let passOnRun = 3;
  return withServer(async ({ call, seed, pool }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };

    async function reachCodeRun() {
      const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Build and test a Python function.', privacyConsent: { modelProvider: true } } });
      await advanceTo(call, auth, run.id, { until: 'code' });
      return run;
    }
    // build-code runs on the model; its checkpoints are recorded; then the code runs.
    async function buildAndRun(run) {
      const built = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
      assert.equal(built.status, 200);
      return call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: { approved: true, executionTarget: 'general-ai-sandbox' } });
    }

    const run = await reachCodeRun();
    // The first package came without tests and was sent back once for them.
    let result = await buildAndRun(run);
    assert.equal(builds[0].followUp, false);
    assert.equal(builds[1].followUp, true);
    assert.equal(result.body.execution.status, 'repairing');
    assert.equal(result.body.execution.repair.round, 1);
    assert.equal(result.body.execution.repair.failure.target, 'general-ai-sandbox');
    assert.equal(result.body.run.next, 'build-code');
    assert.ok(result.body.run.tasks.every(task => task.type !== 'approval' || task.status === 'complete'), 'fixing the code asks for no new approval step');

    // The fix is written from the failed code and its real error output.
    result = await buildAndRun(run);
    const repairBuild = builds.find(item => item.codeRepair && !item.followUp);
    assert.equal(repairBuild.codeRepair.round, 1);
    assert.match(repairBuild.codeRepair.failure.stderr, /AssertionError: 5 != 4/);
    assert.equal(repairBuild.codeRepair.previousCode.source, 'def add(a, b):\n    return a - b\n');
    assert.equal(result.body.execution.status, 'repairing');
    assert.equal(result.body.execution.repair.round, 2);
    assert.deepEqual(result.body.run.tasks.filter(task => task.id.startsWith('test-code')).map(task => task.id), ['test-code'],
      'the fixed code is tested in the same step, never a second one without code');

    result = await buildAndRun(run);
    assert.equal(result.body.execution.executed, true);
    assert.notEqual(result.body.execution.status, 'repairing');
    const current = await call('GET', `/api/runs/${run.id}`, auth);
    assert.equal(current.body.tasks.find(task => task.id === 'test-code').status, 'complete');
    assert.equal(current.body.attempt, 1, 'fixing the code did not start a new attempt');
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM situation_events WHERE run_id = $1 AND event_type = 'code-repair'", [run.id]);
    assert.equal(rows[0].n, 2);

    // Code that keeps failing the same way gets a fix and one more try; a
    // second fix that gets no closer ends the fixing, and the run fails as before.
    passOnRun = Infinity;
    const stubborn = await reachCodeRun();
    for (const [round, reason] of [[1, 'first-failure'], [2, 'one-more-try']]) {
      result = await buildAndRun(stubborn);
      assert.equal(result.body.execution.repair?.round, round);
      assert.equal(result.body.execution.repair?.reason, reason);
    }
    result = await buildAndRun(stubborn);
    assert.equal(result.body.execution.status, 'failed');
    assert.equal(result.body.run.state, 'iterate');
  }, {
    env: {
      AI_PROVIDER: 'anthropic', AI_MODEL: 'claude-opus-5-5', AI_API_KEY: 'test-key',
      SANDBOX_RUNNER_URL: 'http://sandbox.test', RUNNER_TOKEN: 'runner-' + 'x'.repeat(31)
    },
    fetchImpl: async (url, options) => {
      if (!String(url).startsWith('http://sandbox.test')) {
        const body = JSON.parse(options.body);
        const request = JSON.parse(body.messages[0].content);
        const reply = text => jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 2, output_tokens: 2 } });
        if (request.task?.id !== 'build-code') return reply('Done.');
        const followUp = body.messages.length > 1;
        builds.push({ followUp, codeRepair: request.codeRepair ?? null });
        const fixed = Boolean(request.codeRepair);
        return reply(JSON.stringify({
          language: 'python',
          source: fixed ? 'def add(a, b):\n    return a + b\n' : 'def add(a, b):\n    return a - b\n',
          // The first answer forgets the tests; asked again, it adds them.
          tests: followUp || fixed ? 'import unittest\nfrom main import add\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 2), 4)\n' : '',
          packages: [],
          notes: fixed ? 'add subtracted instead of adding' : 'first version'
        }));
      }
      const request = JSON.parse(options.body);
      runs += 1;
      const passed = runs >= passOnRun;
      return jsonResponse({
        executed: true,
        executionId: request.executionId,
        status: passed ? 'completed' : 'failed',
        outcome: passed ? 'completed' : 'failed',
        output: passed
          ? { status: 'completed', exitCode: 0, stdout: '', stderr: 'Ran 1 test in 0.001s\n\nOK', tested: true, testSummary: { total: 1, passed: 1, failed: 0, skipped: 0 } }
          : { status: 'failed', exitCode: 1, stdout: '', stderr: 'FAIL: test_add\nAssertionError: 5 != 4\n\nRan 1 test in 0.001s\n\nFAILED (failures=1)', tested: true, testSummary: { total: 1, passed: 0, failed: 1, skipped: 0 } }
      });
    }
  });
});

test('code that ran without tests of its own needs a person to certify it', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Build and test a Python function.', privacyConsent: { modelProvider: true } } });
    for (const taskId of await stepsIn(call, auth, run.id, ['understand', 'discover-capabilities', 'adapt', 'plan'])) {
      await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId, summary: taskId } });
    }
    await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId: 'approval', approved: true } });
    await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
    for (const taskId of await stepsIn(call, auth, run.id, ['observe-build-code', 'reassess-build-code'])) {
      await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId, evidence: { recorded: true } } });
    }
    const ran = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: { approved: true, executionTarget: 'general-ai-sandbox' } });
    assert.equal(ran.body.execution.status, 'completed');
    for (let current = ran.body.run; current.next !== 'verify';) {
      const step = await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId: current.next, evidence: { recorded: true } } });
      assert.equal(step.status, 200, current.next);
      current = step.body;
    }
    const checked = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
    assert.equal(checked.body.execution.status, 'human-verification-required');
    assert.match(checked.body.execution.message, /without tests/);
    assert.equal(checked.body.execution.advisoryVerdict.verdict, 'pass');
  }, {
    env: {
      AI_PROVIDER: 'anthropic', AI_MODEL: 'claude-opus-5-5', AI_API_KEY: 'test-key',
      SANDBOX_RUNNER_URL: 'http://sandbox.test', RUNNER_TOKEN: 'runner-' + 'x'.repeat(31)
    },
    fetchImpl: async (url, options) => {
      if (String(url).startsWith('http://sandbox.test')) {
        const request = JSON.parse(options.body);
        return jsonResponse({ executed: true, executionId: request.executionId, status: 'completed', outcome: 'completed', output: { status: 'completed', exitCode: 0, stdout: '4\n', stderr: '', tested: false } });
      }
      const body = JSON.parse(options.body);
      const request = JSON.parse(body.messages[0].content);
      const reply = text => jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 2, output_tokens: 2 } });
      // Even when asked, this model never writes tests.
      if (request.task?.id === 'build-code') return reply(JSON.stringify({ language: 'python', source: 'print(2 + 2)', tests: '', packages: [], notes: '' }));
      if (request.task?.type === 'verify') {
        return reply(JSON.stringify({ verdict: 'pass', criteria: (request.situation?.successCriteria ?? []).map(criterion => ({ criterion, met: true })), problems: [] }));
      }
      return reply('Done.');
    }
  }));
