#!/usr/bin/env node
/**
 * npm run load-test -- https://host
 *
 * Drives the main workflow the way the app does, from many concurrent
 * users: preview a plan, create a run, read it, write the answer, pass the
 * check (completing the run), and list chats. Reports throughput and
 * p50/p95/p99 latency per step, and every non-2xx answer.
 *
 * It creates real runs, so point it at a staging deployment, never at
 * production data. LOAD_API_KEY and LOAD_WORKSPACE name an editor's key and
 * workspace; LOAD_USERS (default 20) and LOAD_SECONDS (default 30) set the
 * shape. The server's RATE_MAX must allow the traffic, or most answers are
 * 429 by design.
 */

const base = String(process.argv[2] || process.env.LOAD_BASE_URL || '').replace(/\/+$/, '');
const key = String(process.env.LOAD_API_KEY || '').trim();
const workspace = String(process.env.LOAD_WORKSPACE || '').trim();
const users = Number(process.env.LOAD_USERS || 20);
const seconds = Number(process.env.LOAD_SECONDS || 30);
if (!/^https?:\/\//.test(base) || !key || !workspace) {
  console.error('Usage: LOAD_API_KEY=… LOAD_WORKSPACE=… npm run load-test -- https://staging-host');
  process.exit(1);
}

const headers = { authorization: `Bearer ${key}`, 'x-workspace-id': workspace, 'content-type': 'application/json' };
const samples = new Map();
const failures = new Map();

async function step(name, method, path, body) {
  const started = performance.now();
  let status = 0;
  let json = null;
  try {
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    status = response.status;
    json = await response.json().catch(() => null);
  } catch {
    // A network error is reported as status 0 below.
  }
  const ms = performance.now() - started;
  if (!samples.has(name)) samples.set(name, []);
  samples.get(name).push(ms);
  if (status < 200 || status >= 300) {
    const label = `${name} → ${status || 'network error'}${json?.code ? ` (${json.code})` : ''}`;
    failures.set(label, (failures.get(label) ?? 0) + 1);
    return null;
  }
  return json;
}

const goals = [
  'Explain how a heat pump works, simply.',
  'Write a short email asking my manager for Friday off.',
  'Summarise the causes of inflation in three bullet points.',
  'Give me a study plan for learning basic statistics in two weeks.'
];

async function workflow(user, iteration) {
  const goal = goals[(user + iteration) % goals.length];
  await step('plan preview', 'POST', '/api/plan', { goal });
  const run = await step('create run', 'POST', '/api/runs', { goal, conversationId: `load-${user}-${iteration}-${Date.now()}` });
  if (!run?.id) return;
  const current = await step('read run', 'GET', `/api/runs/${run.id}`);
  const respond = current?.tasks?.find(task => task.id === current.next);
  if (respond) {
    await step('write answer', 'POST', `/api/runs/${run.id}/advance`, {
      taskId: respond.id, summary: 'Answered.', evidence: { humanProvided: true, text: 'A load-test answer.' }
    });
  }
  const afterAnswer = await step('read run', 'GET', `/api/runs/${run.id}`);
  const verify = afterAnswer?.tasks?.find(task => task.id === afterAnswer.next && task.type === 'verify');
  if (verify) {
    const criteria = afterAnswer.situation?.successCriteria ?? [];
    await step('pass check', 'POST', `/api/runs/${run.id}/advance`, {
      taskId: verify.id,
      summary: 'Checked by a person.',
      evidence: {
        verdict: { verdict: 'pass', criteria: criteria.map(criterion => ({ criterion, met: true, reason: 'ok' })), problems: [], summary: 'ok' },
        verification: { level: 'human-certified', humanReviewed: true, method: 'load test' }
      }
    });
  }
  await step('list chats', 'GET', '/api/conversations?limit=100');
}

const deadline = Date.now() + seconds * 1000;
const started = performance.now();
let completed = 0;
await Promise.all(Array.from({ length: users }, async (_, user) => {
  for (let iteration = 0; Date.now() < deadline; iteration += 1) {
    await workflow(user, iteration);
    completed += 1;
  }
}));
const elapsed = (performance.now() - started) / 1000;

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
console.log(`${users} users for ${elapsed.toFixed(1)} s against ${base}: ${completed} workflows (${(completed / elapsed).toFixed(1)}/s)\n`);
console.log('step              requests   req/s    p50 ms   p95 ms   p99 ms');
for (const [name, values] of samples) {
  const sorted = [...values].sort((a, b) => a - b);
  console.log(`${name.padEnd(16)} ${String(values.length).padStart(9)} ${(values.length / elapsed).toFixed(1).padStart(7)} ${percentile(sorted, 50).toFixed(0).padStart(9)} ${percentile(sorted, 95).toFixed(0).padStart(8)} ${percentile(sorted, 99).toFixed(0).padStart(8)}`);
}
if (failures.size) {
  console.log('\nnon-2xx answers:');
  for (const [label, count] of failures) console.log(`  ${count} × ${label}`);
}
process.exitCode = failures.size ? 1 : 0;
