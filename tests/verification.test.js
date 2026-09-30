import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceSources, unretrievedLinks, dependsOnOutsideFacts, groundedCheckDecision, verificationBrief, groundVerdict } from '../src/verification.js';
import { normalizeVerdict, GENERIC_CRITERION } from '../src/reasoning-context.js';
import { withServer, jsonResponse } from './helpers.js';

const researched = {
  goal: 'What is the current UK VAT rate?',
  tasks: [
    { id: 'investigate', type: 'investigate', status: 'complete', evidence: { text: 'VAT is 20%.', citations: [{ url: 'https://www.gov.uk/vat-rates', title: 'VAT rates' }] } },
    { id: 'deliver', type: 'deliver', status: 'complete', evidence: { text: 'It is 20% (https://www.gov.uk/vat-rates/). See also https://made-up.example/vat.', citations: [{ url: 'https://www.gov.uk/vat-rates#standard', title: 'dup' }] } },
    { id: 'verify', type: 'verify', status: 'ready' }
  ],
  adaptation: { governance: { status: 'ready' } }
};

test('sources are collected once per page, and invented links are singled out', () => {
  const sources = evidenceSources(researched.tasks);
  assert.deepEqual(sources, [{ url: 'https://www.gov.uk/vat-rates', title: 'VAT rates', taskId: 'investigate' }]);
  assert.deepEqual(unretrievedLinks(researched.tasks, sources), ['https://made-up.example/vat']);
  // A link the person gave is theirs, not an invented source.
  const brief = verificationBrief({ ...researched, goal: 'Check https://made-up.example/vat for me' }, { grounded: true });
  assert.deepEqual(brief.unretrievedLinks, []);
});

test('the verifier searches the web only when the work rests on outside facts and research is permitted', () => {
  const chat = { tasks: [{ id: 'respond', type: 'respond', status: 'complete', evidence: { text: 'Hello!' } }] };
  assert.equal(dependsOnOutsideFacts(chat), false);
  assert.equal(groundedCheckDecision(chat).grounded, false);

  assert.equal(groundedCheckDecision(researched).grounded, true);
  assert.equal(groundedCheckDecision(researched, { webAccess: false }).reason, 'web-access-off');
  assert.equal(groundedCheckDecision(researched, { researchAllowed: false }).reason, 'research-policy-denied');
  const noJurisdiction = { ...researched, adaptation: { governance: { status: 'review', jurisdiction: { reviewRequired: true } } } };
  assert.equal(groundedCheckDecision(noJurisdiction).reason, 'governance-restricts-research');

  // Searching during the answer also makes the work depend on the web.
  const searched = { tasks: [{ id: 'respond', type: 'respond', status: 'complete', evidence: { text: 'x', tools: [{ tool: 'web.search', outcome: 'ok' }] } }] };
  assert.equal(dependsOnOutsideFacts(searched), true);
});

test('invention work is verified against the invention method', () => {
  const invention = { tasks: [{ id: 'prototype', type: 'prototype', status: 'complete', metadata: { inventionLoop: true }, evidence: { text: 'Three concepts…' } }] };
  assert.equal(verificationBrief(invention, { grounded: false }).invention, true);
  assert.equal('invention' in verificationBrief(researched, { grounded: false }), false);
});

test('an unsupported claim or an unconfirmed invented link fails a pass', () => {
  const brief = verificationBrief(researched, { grounded: true });
  const raw = {
    verdict: 'pass',
    criteria: [{ criterion: 'States the rate', met: true }],
    problems: [],
    claims: [{ claim: 'VAT is 20%', supported: true, source: 'https://www.gov.uk/vat-rates' }, { claim: 'Food is taxed at 5%', supported: false, note: 'Most food is zero-rated' }]
  };
  const verdict = groundVerdict(normalizeVerdict(raw, ['States the rate']), raw, { brief, grounded: true, checkedSources: [{ url: 'https://www.hmrc.gov.uk/x', title: 'HMRC' }] });
  assert.equal(verdict.verdict, 'fail');
  assert.ok(verdict.problems.includes('Unsupported claim: Food is taxed at 5% (Most food is zero-rated)'));
  assert.ok(verdict.problems.some(problem => problem.includes('https://made-up.example/vat')));
  assert.equal(verdict.grounding.checkedAgainstWeb, true);
  assert.deepEqual(verdict.grounding.sources.map(item => item.url), ['https://www.gov.uk/vat-rates', 'https://www.hmrc.gov.uk/x']);

  // Supported claims and a confirmed link keep the pass.
  const clean = { ...raw, claims: [raw.claims[0]], confirmedLinks: ['https://made-up.example/vat'] };
  assert.equal(groundVerdict(normalizeVerdict(clean, ['States the rate']), clean, { brief, grounded: true }).verdict, 'pass');
});

test('without a live check, unretrieved links are a warning, not a failure', () => {
  const brief = verificationBrief(researched, { grounded: false });
  const raw = { verdict: 'pass', criteria: [{ criterion: 'States the rate', met: true }], problems: [] };
  const verdict = groundVerdict(normalizeVerdict(raw, ['States the rate']), raw, { brief, grounded: false });
  assert.equal(verdict.verdict, 'pass');
  assert.match(verdict.warnings[0], /made-up\.example/);
  assert.equal(verdict.grounding.checkedAgainstWeb, false);
  assert.equal(groundVerdict(null, raw, { brief }), null);
});

test('links inside code being made are not sources to check', () => {
  const tasks = [
    { id: 'build-code', type: 'code', status: 'complete', evidence: { text: '<a href="https://maps.google.com/?q=Gulberg">Map</a>', structured: { source: '<a href="https://maps.google.com/?q=Gulberg">' } } },
    { id: 'deliver', type: 'deliver', status: 'complete', evidence: { text: 'Here it is:\n```html\n<img src="https://images.example.com/a.jpg">\n```\nPrices from https://example.org/menu' } }
  ];
  assert.deepEqual(unretrievedLinks(tasks), ['https://example.org/menu']);
});

test('an overall pass covers only the generic stand-in criterion, never a stated one', () => {
  const generic = "Satisfy the user's stated outcome with evidence appropriate to the work.";
  const reply = { verdict: 'pass', criteria: [{ criterion: 'Calculate the 30th Fibonacci number', met: true, reason: 'ok' }], problems: [] };
  assert.equal(normalizeVerdict(reply, ['Calculate the 30th Fibonacci number', generic]).verdict, 'pass');
  assert.equal(normalizeVerdict(reply, ['Calculate the 30th Fibonacci number', 'Explain the method']).verdict, 'fail');
  assert.equal(normalizeVerdict({ ...reply, verdict: 'fail' }, ['Calculate the 30th Fibonacci number', generic]).verdict, 'fail');
});

test('a check is shown one list of criteria, not the understanding\'s own wording too', async () => {
  const { adaptationFor } = await import('../src/prompt-scope.js');
  const run = { workflow: 'full', adaptation: { understanding: { successCriteria: ['Calculate it correctly'], outputs: ['the number'], constraints: ['use Python'] } } };
  const forVerify = adaptationFor(run, { type: 'verify' });
  assert.equal(forVerify.understanding.successCriteria, undefined);
  assert.equal(forVerify.understanding.outputs, undefined);
  assert.deepEqual(forVerify.understanding.constraints, ['use Python']);
  assert.deepEqual(adaptationFor(run, { type: 'respond' }).understanding.successCriteria, ['Calculate it correctly']);
});

test('a criterion checked under its requirement label is still the planned criterion', () => {
  const planned = ['The calculated numeric result.', 'The number is correct'];
  const verdict = normalizeVerdict({
    verdict: 'pass',
    criteria: [
      { criterion: 'Evidence required: The calculated numeric result.', met: true, reason: 'The program printed 832040.' },
      { criterion: 'The number is correct.', met: true, reason: 'Matches F(30).' }
    ],
    problems: []
  }, planned);
  assert.equal(verdict.verdict, 'pass');
  assert.deepEqual(verdict.criteria.map(item => item.met), [true, true]);
  // A criterion that really was skipped still fails the check.
  const skipped = normalizeVerdict({ verdict: 'pass', criteria: [{ criterion: 'The number is correct', met: true }], problems: [] }, planned);
  assert.equal(skipped.verdict, 'fail');
});

test('only the check sees the stand-in criterion; the answer is not padded to prove it', () => {
  const seen = [];
  return withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: "What is Ohm's law? Two sentences.", privacyConsent: { modelProvider: true } } });
    for (let i = 0; i < 4; i += 1) {
      const step = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
      if (!step.body.run?.next) break;
    }
    const respond = seen.find(request => request.task?.type === 'respond');
    const verify = seen.find(request => request.task?.type === 'verify');
    assert.ok(respond && verify, 'both steps ran');
    assert.ok(!(respond.situation?.successCriteria ?? []).includes(GENERIC_CRITERION));
    assert.ok(verify.situation.successCriteria.includes(GENERIC_CRITERION));
  }, {
    env: { AI_PROVIDER: 'anthropic', AI_MODEL: 'claude-opus-5-5', AI_API_KEY: 'test-key' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const user = body.messages?.find(message => message.role === 'user')?.content ?? '{}';
      let request = {};
      try { request = JSON.parse(typeof user === 'string' ? user : '{}'); } catch { /* not a task */ }
      seen.push(request);
      const text = request.task?.type === 'verify'
        ? JSON.stringify({ verdict: 'pass', criteria: (request.situation?.successCriteria ?? []).map(criterion => ({ criterion, met: true })), problems: [] })
        : "Ohm's law says current is proportional to voltage. It is written V = IR.";
      return jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 2, output_tokens: 2 } });
    }
  });
});
