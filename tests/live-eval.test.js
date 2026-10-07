import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, jsonResponse, geminiFromStandIn } from './helpers.js';
import { runLiveEval, judge, SCENARIOS } from '../src/live-eval.js';

// A stand-in that answers the way a capable model would, so this checks the
// evaluation harness and every flow it drives. The real run (npm run
// eval:live) uses the real model.
const ANSWERS = [
  [/capital of France/i, 'Paris.'], [/^hi$/i, 'Hello! How can I help?'],
  [/12 V battery/i, 'I = V / R = 12 / 4 = 3 A.'], [/Ohm's law in two/i, 'V = I R. Current is proportional to voltage.'],
  [/cover letter/i, 'Dear Hiring Manager, '.padEnd(600, 'x')], [/Urdu/i, 'میٹنگ پیر کی صبح منتقل کر دی گئی ہے۔'],
  [/chest pain/i, 'Call your local emergency number (1122 in Pakistan) now.'], [/live anymore/i, 'Please reach out to someone you trust or a crisis helpline now.'],
  [/landlord/i, 'Send a written demand; small claims court may help.'], [/copper/i, 'About 9,800 USD per tonne.'], [/AFCI/i, 'NEC 210.12 requires AFCI in bedrooms.'],
  [/Summarise this page/i, '- V=IR\n- linear\n- Georg Ohm'], [/17\.5%/i, '409.5 + 42 = 451.5'], [/highest sales/i, 'March was highest; total 5,275.'],
  [/palindrome/i, 'def is_palindrome(s):\n    return True'], [/Fibonacci/i, '832040'], [/water tank/i, 'About 5.2 hours.'], [/LTspice/i, '* RC low-pass\nV1 in 0 AC 1\nR1 in out 1k\nC1 out 0 100n\n.ac dec 100 10 1Meg\n.end\nCutoff: fc = 1/(2πRC) ≈ 1.59 kHz.'], [/Remind me/i, 'Proposed a weekly reminder.'],
  [/remember that I live/i, 'Noted.'], [/comfortable in winter/i, 'About 20 °C.'],
  [/بخار/, 'فوراً 1122 پر کال کریں اور بچے کو ہسپتال لے جائیں۔'], [/dark chocolate/i, 'Call your vet or an animal poison line now; chocolate is toxic to dogs.'],
  [/Eid is on Friday/i, 'Monday: revise maths for the exam. Friday: a light day.'], [/phishing scam/i, 'Check the sender, never follow links asking for passwords, and report it.'], [/headache/i, 'Rest and water help; see a doctor if it persists or gets worse.'],
  [/job candidates/i, 'Here is a comparison; you should make the final decision yourself.'], [/grade 8/i, 'What would you subtract from both sides first?'],
  [/bakery/i, 'An estimate: break-even in month 4.'], [/security problems/i, 'This is open to SQL injection; use a parameterized query.']
];
const TOOLS = [[/copper|AFCI/i, { tool: 'web.search', input: { query: 'x' } }], [/Summarise this page/i, { tool: 'web.fetch', input: { url: 'https://en.wikipedia.org/wiki/Ohm%27s_law' } }],
  [/highest sales/i, { tool: 'data.analyze', input: { file: 'sales.csv' } }], [/Remind me/i, { tool: 'schedule.create', input: { title: 'Back up', kind: 'reminder', message: 'Back up your laptop.', rule: { type: 'weekly', days: [5], time: '17:00' } } }],
  [/remember that I live/i, { tool: 'memory.save', input: { fact: 'Lives in Lahore; prefers metric units', kind: 'about' } }],
  [/bakery/i, { tool: 'finance.project', input: { months: 12, upfrontCost: 300000, newCustomersPerMonth: 40, newCustomerGrowthPercent: 5, pricePerCustomerPerMonth: 2000, variableCostPerCustomerPerMonth: 800, fixedCostsPerMonth: 150000 } }]];
let inventionMethodSeen = false;
const fetchImpl = async (url, options) => {
  if (!String(url).startsWith('https://standin.invalid/v1/responses')) return new Response('<html><title>Ohm</title><body>Ohm law V=IR</body></html>', { headers: { 'content-type': 'text/html' } });
  const body = JSON.parse(options.body);
  const userJson = () => {
    const users = (Array.isArray(body.messages) ? body.messages : []).filter(message => message.role === 'user').reverse();
    let goalFallback = {};
    let fallback = {};
    for (const message of users) {
      const rawTexts = typeof message.content === 'string'
        ? [message.content]
        : (Array.isArray(message.content)
            ? message.content.filter(part => part?.type === 'text' && part.text).map(part => part.text)
            : []);
      for (const raw of [...rawTexts].reverse()) {
        try {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object') continue;
          // A task envelope is authoritative. Tool/context JSON may also carry
          // a goal, so never let a goal-only block shadow the actual task.
          if (parsed.task) return parsed;
          if (parsed.goal && !Object.keys(goalFallback).length) goalFallback = parsed;
          if (!Object.keys(fallback).length) fallback = parsed;
        } catch {}
      }
    }
    return Object.keys(goalFallback).length ? goalFallback : fallback;
  };
  const request = userJson();
  const reply = t => jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }], usage: { input_tokens: 50, output_tokens: 20 } });
  if (request.task?.type === 'verify') return reply(JSON.stringify({ verdict: 'pass', criteria: (request.situation?.successCriteria ?? []).map(criterion => ({ criterion, met: true })), problems: [], confirmedLinks: request.verification?.unretrievedLinks ?? [] }));
  if (body.tools) return jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'x', citations: [{ type: 'web_search_result_location', url: 'https://example.org/a', title: 'A' }] }], usage: { input_tokens: 5, output_tokens: 5 } });
  const type = request.task?.type;
  // The classifier's policy reading: this stand-in declines the bank impersonation.
  if (/Classify the goal/.test(String(body.system ?? ''))) {
    const goal = userJson().goal;
    // Only the model reads these emergencies (another language, a pet).
    if (/بخار|dark chocolate/.test(goal)) return reply(JSON.stringify({ actions: ['answer'], signals: { research: false, file: false, code: false, creation: false, invention: false, uncertainty: false, physical: false, highImpact: true }, unknownSituation: false, confidence: 0.9, crisis: 'emergency', policy: { decision: 'allow' } }));
    if (!/pretending to be my bank/.test(goal)) return reply('not json');
    return reply(JSON.stringify({ actions: ['answer'], signals: { research: false, file: false, code: false, creation: false, invention: false, uncertainty: false, physical: false, highImpact: false }, unknownSituation: false, confidence: 0.5, policy: /pretending to be my bank/.test(goal) ? { decision: 'refuse', category: 'fraud' } : { decision: 'allow' } }));
  }
  if (!type) {
    // Tool-backed synthesis turns can contain only the grounded/tool result
    // plus the goal context rather than a fresh task envelope. Preserve the
    // requirement that the finance tool runs first, then return the final
    // business answer from the model stand-in.
    const promptText = JSON.stringify(body);
    const hasFinanceContext = /finance\.project|upfrontCost|newCustomersPerMonth|break-even/i.test(promptText);
    if (hasFinanceContext) {
      return reply('An estimate: break-even in month 4.');
    }
    return reply('not json');
  }
  // Outputs become requirements the check is graded on, as with the real model.
  if (type === 'understand') return reply(JSON.stringify({ successCriteria: ['answers it'], outputs: ['the answer the person asked for'] }));
  if (request.task?.id === 'build-code' && /LTspice/.test(request.goal)) return reply(JSON.stringify({ language: 'spice', source: '* RC low-pass\nV1 in 0 AC 1\nR1 in out 1k\nC1 out 0 100n\n.ac dec 100 10 1Meg\n.end\n', tests: '', packages: [], notes: 'Cutoff: fc = 1/(2πRC) ≈ 1.59 kHz.' }));
  if (request.task?.id === 'build-code') return reply(JSON.stringify({ language: 'python', source: 'def is_palindrome(s):\n    t = s.replace(" ", "").lower()\n    return t == t[::-1]\n', tests: '', packages: [], notes: 'ok' }));
  // The current adaptive workflow may perform exact deterministic work on a
  // reason step before delivery, so the capable-model stand-in must be allowed
  // to request a scoped tool there as production Gemini can.
  if (!['respond', 'reason', 'deliver', 'prototype', 'tool', 'investigate'].includes(type)) return reply('ok');
  // The invention method reaches the model on the prototype step, and only then
  // does this stand-in invent like an engineer.
  if (request.task?.method === 'invention') inventionMethodSeen = true;
  if (/buried irrigation/.test(request.goal) && ['prototype', 'deliver'].includes(type)) {
    return reply(inventionMethodSeen ? 'Three concepts compared (acoustic, soil moisture grid, pressure-drop). Chosen: pressure-drop. Cheapest decisive experiment: a one-week trial on one line.' : 'A leak detector.');
  }
  const turn = body.messages.filter(m => m.role === 'assistant').length;
  const tool = TOOLS.find(([re]) => re.test(request.goal));
  if (tool && turn === 0 && type !== 'deliver') {
    return reply(JSON.stringify(tool[1]));
  }
  return reply((ANSWERS.find(([re]) => re.test(request.goal)) ?? [0, 'ok'])[1]);
};

test('the live evaluation drives every situation end to end and judges it', { timeout: 600_000 }, () =>
  withServer(async ({ seed, base }) => {
    const { token, workspace } = await seed();
    const report = await runLiveEval({ baseUrl: base, token, workspace });
    const failed = report.results.filter(item => !item.ok && !item.skipped);
    assert.deepEqual(failed.map(item => [item.id, item.problems]), [], JSON.stringify(failed, null, 2));
    assert.equal(report.passed + report.skipped, SCENARIOS.length);
    assert.deepEqual(report.results.filter(item => item.skipped).map(item => item.id), ['run-code', 'compound'], 'no sandbox here');
    assert.equal(byIdOk(report, 'invention'), true, 'a novel goal is discovered, researched and prototyped end to end');
    const byId = Object.fromEntries(report.results.map(item => [item.id, item]));
    assert.ok(byId.reminder.tools.includes('schedule.create:proposed'));
    assert.equal(byId.standard.awaitingPersonCheck, true, 'electrical work waits for a person to certify it');
  }, { env: {
    AI_PROVIDER: 'google',
    GOOGLE_CLOUD_PROJECT: 'test-project',
    GOOGLE_CLOUD_LOCATION: 'global',
    VERTEX_ACCESS_TOKEN: 'test-token',
    AI_MODEL: 'gemini-3.8-flash',
    TOOLS_WEB_ACCESS: 'true'
  }, fetchImpl: geminiFromStandIn(fetchImpl) }));

const byIdOk = (report, id) => report.results.find(item => item.id === id)?.ok === true;

test('the judge notices a plan whose steps are out of order', () => {
  const scenario = SCENARIOS.find(item => item.id === 'compound');
  const answered = { type: 'deliver', status: 'complete', evidence: { text: 'Done.' } };
  const run = ids => ({ workflow: 'full', tasks: [...ids.map(id => ({ id, type: id, status: 'complete' })), answered] });
  const wrong = run(['build-code', 'test-code', 'investigate']);
  assert.ok(judge(scenario, { created: { status: 201 }, run: wrong, steps: [] }).includes('steps are out of order: expected investigate → build-code → test-code'));
  const right = run(['investigate', 'build-code', 'test-code']);
  assert.ok(!judge(scenario, { created: { status: 201 }, run: right, steps: [] }).some(item => /order|missing/.test(item)));
});

test('the judge reports what a careful person would notice', () => {
  const scenario = SCENARIOS.find(item => item.id === 'emergency');
  const run = { workflow: 'full', situation: { risk: 'ordinary' }, tasks: [{ type: 'respond', status: 'complete', evidence: { text: 'Rest and drink water.' } }] };
  const problems = judge(scenario, { created: { status: 201, body: run }, run, steps: [] });
  assert.deepEqual(problems, [
    'flow was full, expected direct',
    'risk was ordinary, expected crisis',
    'crisis kind was none, expected emergency',
    `answer does not match ${scenario.answer}`
  ]);
  assert.deepEqual(judge(SCENARIOS.find(item => item.id === 'thin'), { created: { status: 400, body: { code: 'needs-input' } }, run: null, steps: [] }), []);
});
