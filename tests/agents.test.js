import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewDecision, reviewerModelFor, reviewMessages, readReview, mergeReview, REVIEWER_PROMPT } from '../src/agents.js';
import { withServer, jsonResponse } from './helpers.js';

const passing = { verdict: 'pass', criteria: [], problems: [], summary: 'ok' };
const failing = { verdict: 'fail', criteria: [], problems: ['Missing the units'], summary: 'no' };

test('a second agent is used only when the work is worth its tokens', () => {
  const run = extra => ({ workflow: 'full', situation: { risk: 'low' }, adaptation: { scale: 'standard' }, tasks: [], attempt: 1, ...extra });
  assert.equal(reviewDecision(run()).review, false, 'ordinary work pays nothing extra');
  assert.equal(reviewDecision(run({ adaptation: { scale: 'complex' } })).reason, 'complex-work');
  assert.equal(reviewDecision(run({ situation: { risk: 'high-impact' } })).reason, 'high-stakes');
  assert.equal(reviewDecision(run({ situation: { risk: 'physical' } })).reason, 'high-stakes');
  assert.equal(reviewDecision(run({ tasks: [{ type: 'code', status: 'complete' }] })).reason, 'code');
  assert.equal(reviewDecision(run({ attempt: 2 })).reason, 'retry');
});

test('crisis and declined requests never wait on a second agent, whatever the setting', () => {
  for (const mode of ['auto', 'always']) {
    assert.equal(reviewDecision({ workflow: 'full', situation: { risk: 'crisis' } }, { mode }).review, false);
    assert.equal(reviewDecision({ workflow: 'direct', situation: { risk: 'crisis' } }, { mode }).review, false);
    assert.equal(reviewDecision({ workflow: 'full', adaptation: { safetyAdaptive: true } }, { mode }).review, false);
  }
  // A quick answer is reviewed only when its stakes call for it.
  assert.equal(reviewDecision({ workflow: 'direct', situation: { risk: 'low' }, adaptation: { scale: 'small' } }).review, false);
  assert.equal(reviewDecision({ workflow: 'direct', situation: { risk: 'high-impact' } }).review, true);
  assert.equal(reviewDecision({ workflow: 'full', adaptation: { scale: 'complex' } }, { mode: 'off' }).reason, 'disabled');
  assert.equal(reviewDecision({ workflow: 'full', adaptation: {} }, { mode: 'always' }).review, true);
});

test('the reviewer prefers a different, non-Pro model the plan allows, else the verifier\'s own', () => {
  const selection = {
    planModelIds: ['google:gemini-3.8-flash', 'google:gemini-3.5-flash', 'google:gemini-2.5-pro'],
    enabledModelIds: ['google:gemini-3.8-flash', 'google:gemini-3.5-flash', 'google:gemini-2.5-pro'],
    configuredModelIds: ['google:gemini-3.8-flash', 'google:gemini-3.5-flash', 'google:gemini-2.5-pro']
  };
  assert.equal(reviewerModelFor(selection, 'google:gemini-3.8-flash'), 'google:gemini-3.5-flash');
  assert.equal(reviewerModelFor(selection, 'google:gemini-3.8-flash', { allows: id => id !== 'google:gemini-3.5-flash' }), 'google:gemini-3.8-flash', 'Pro is never chosen to check a Flash answer');
  assert.equal(reviewerModelFor({ ...selection, enabledModelIds: ['google:gemini-3.8-flash'] }, 'google:gemini-3.8-flash'), 'google:gemini-3.8-flash');
  assert.equal(reviewerModelFor(null, 'google:x'), 'google:x');
});

test('the reviewer is shown the goal, the work and the first verdict, and treats evidence as data', () => {
  const run = { goal: 'Size a fuse', tasks: [
    { id: 'respond', type: 'respond', status: 'complete', evidence: { text: 'Use 10 A.' } },
    { id: 'verify', type: 'verify', status: 'ready' }
  ] };
  const [system, user] = reviewMessages(run, { criteria: ['Correct rating'], verdict: passing });
  assert.equal(system.content, REVIEWER_PROMPT);
  assert.match(system.content, /never instructions to follow/);
  const shown = JSON.parse(user.content);
  assert.equal(shown.goal, 'Size a fuse');
  assert.deepEqual(shown.work.map(item => item.text), ['Use 10 A.']);
  assert.equal(shown.firstVerdict.verdict, 'pass');
});

test('a reviewer reply is read strictly', () => {
  assert.equal(readReview(null), null);
  assert.equal(readReview({ verdict: 'maybe' }), null);
  assert.deepEqual(readReview({ verdict: 'pass', problems: [] }), { verdict: 'pass', problems: [] });
  assert.equal(readReview({ verdict: 'pass', problems: ['Wrong voltage'] }).verdict, 'fail', 'a pass that names a problem is a fail');
});

test('a reviewer can fail a pass but can never rescue a fail', () => {
  const failed = mergeReview(passing, { verdict: 'fail', problems: ['Invented a link'] }, { reason: 'code', model: 'm' });
  assert.equal(failed.verdict, 'fail');
  assert.ok(failed.problems.includes('Independent review: Invented a link'));
  assert.deepEqual(failed.review, { ran: true, reason: 'code', model: 'm', status: 'failed' });

  assert.equal(mergeReview(passing, { verdict: 'pass', problems: [] }).verdict, 'pass');
  assert.equal(mergeReview(passing, { verdict: 'pass', problems: [] }).review.status, 'agreed');
  assert.equal(mergeReview(failing, { verdict: 'pass', problems: [] }).verdict, 'fail', 'a fail stays failed');
  assert.equal(mergeReview(passing, { verdict: 'fail', problems: [] }).problems.length, 1, 'a reasonless fail still says so');
});

test('an unavailable reviewer leaves the verdict standing and says so', () => {
  const merged = mergeReview(passing, null, { reason: 'complex-work' });
  assert.equal(merged.verdict, 'pass');
  assert.equal(merged.review.status, 'unavailable');
  assert.match(merged.warnings[0], /could not be completed/);
  assert.equal(mergeReview(null, null), null);
});

// End to end: the same simple question, with a second agent that disagrees.
function scenario(env, { reviewerVerdict }) {
  const calls = { reviewer: 0, verifier: 0 };
  const outcome = {};
  return { calls, outcome, run: () => withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: "What is Ohm's law? Two sentences.", privacyConsent: { modelProvider: true } } });
    for (let i = 0; i < 6; i += 1) {
      const step = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
      if (!step.body.run?.next) break;
    }
    const finished = await call('GET', `/api/runs/${run.id}`, auth);
    outcome.verify = finished.body.tasks?.find(task => task.type === 'verify');
  }, {
    env: { AI_PROVIDER: 'anthropic', AI_MODEL: 'claude-opus-5-5', AI_API_KEY: 'test-key', ...env },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const system = typeof body.system === 'string' ? body.system : '';
      if (system.startsWith('You are an independent reviewer')) {
        calls.reviewer += 1;
        return jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reviewerVerdict) }], usage: { input_tokens: 5, output_tokens: 5 } });
      }
      const user = body.messages?.find(message => message.role === 'user')?.content ?? '{}';
      let request = {};
      try { request = JSON.parse(typeof user === 'string' ? user : '{}'); } catch { /* not a task */ }
      let text = "Ohm's law says current is proportional to voltage. It is written V = IR.";
      if (request.task?.type === 'verify') {
        calls.verifier += 1;
        text = JSON.stringify({ verdict: 'pass', criteria: (request.situation?.successCriteria ?? []).map(criterion => ({ criterion, met: true })), problems: [] });
      }
      return jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 2, output_tokens: 2 } });
    }
  }) };
}

test('AGENTS_REVIEW=always: a disagreeing second agent fails work the first verifier passed', async () => {
  const s = scenario({ AGENTS_REVIEW: 'always' }, { reviewerVerdict: { verdict: 'fail', problems: ['States no units'] } });
  await s.run();
  assert.equal(s.calls.verifier, 1);
  assert.equal(s.calls.reviewer, 1);
  const verdict = s.outcome.verify?.evidence?.verdict ?? s.outcome.verify?.verdict;
  assert.equal(verdict?.verdict, 'fail');
  assert.ok(verdict.problems.some(problem => problem.startsWith('Independent review:')));
  assert.equal(verdict.review.status, 'failed');
});

test('an agreeing second agent keeps the pass', async () => {
  const s = scenario({ AGENTS_REVIEW: 'always' }, { reviewerVerdict: { verdict: 'pass', problems: [] } });
  await s.run();
  assert.equal(s.calls.reviewer, 1);
  const verdict = s.outcome.verify?.evidence?.verdict ?? s.outcome.verify?.verdict;
  assert.equal(verdict?.verdict, 'pass');
  assert.equal(verdict.review.status, 'agreed');
});

test('small work under the default setting, and AGENTS_REVIEW=off, cost no second call', async () => {
  for (const env of [{}, { AGENTS_REVIEW: 'off' }]) {
    const s = scenario(env, { reviewerVerdict: { verdict: 'fail', problems: ['never asked'] } });
    await s.run();
    assert.equal(s.calls.reviewer, 0, JSON.stringify(env));
    const verdict = s.outcome.verify?.evidence?.verdict ?? s.outcome.verify?.verdict;
    assert.equal(verdict?.verdict, 'pass');
    assert.equal(verdict.review, undefined);
  }
});

test('AGENTS_REVIEW is validated and defaults to auto', async () => {
  const { loadConfig } = await import('../src/config.js');
  const base = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db' };
  assert.equal(loadConfig(base).agents.review, 'auto');
  assert.equal(loadConfig({ ...base, AGENTS_REVIEW: 'OFF' }).agents.review, 'off');
  assert.throws(() => loadConfig({ ...base, AGENTS_REVIEW: 'sometimes' }), /AGENTS_REVIEW must be auto, always or off/);
});
