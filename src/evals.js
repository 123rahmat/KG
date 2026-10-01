/**
 * Versioned, concurrent evaluation harness for adaptive agents.
 */
const text = value => String(value ?? '').trim();

export function defineEvalCase({ id, version = '1', goal, tags = [], expected = {}, run } = {}) {
  if (!text(id) || !text(goal) || typeof run !== 'function') throw new Error('Eval cases require id, goal and run()');
  return Object.freeze({
    id: text(id), version: text(version) || '1', goal: text(goal),
    tags: Array.isArray(tags) ? tags.slice(0, 20) : [],
    expected: expected && typeof expected === 'object' ? expected : {}, run
  });
}

export function scoreEvalResult(result, expected = {}) {
  const checks = [];
  if (Object.hasOwn(expected, 'success')) checks.push({ name: 'success', pass: Boolean(result?.success) === Boolean(expected.success) });
  for (const field of Array.isArray(expected.requiredFields) ? expected.requiredFields : []) {
    checks.push({ name: 'field:' + field, pass: Boolean(result) && Object.hasOwn(result, field) });
  }
  for (const pattern of Array.isArray(expected.forbiddenPatterns) ? expected.forbiddenPatterns : []) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i');
    checks.push({ name: 'forbidden:' + re, pass: !re.test(JSON.stringify(result ?? {})) });
  }
  if (typeof expected.predicate === 'function') checks.push({ name: 'predicate', pass: Boolean(expected.predicate(result)) });
  const passed = checks.filter(item => item.pass).length;
  return { pass: checks.length ? passed === checks.length : Boolean(result?.success),
    checks, score: checks.length ? passed / checks.length : (result?.success ? 1 : 0) };
}

export async function runEvalSuite(cases = [], { concurrency = 4, onCase = null } = {}) {
  const all = Array.isArray(cases) ? cases : [];
  const results = new Array(all.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= all.length) return;
      const item = all[index];
      const started = Date.now();
      try {
        const output = await item.run();
        results[index] = { id: item.id, version: item.version, tags: item.tags,
          elapsedMs: Date.now() - started, ...scoreEvalResult(output, item.expected) };
      } catch (error) {
        results[index] = { id: item.id, version: item.version, tags: item.tags,
          elapsedMs: Date.now() - started, pass: false, score: 0, checks: [],
          error: { name: error?.name, message: text(error?.message) } };
      }
      await onCase?.(results[index]);
    }
  }

  const count = Math.max(1, Math.min(Number(concurrency) || 4, Math.max(1, all.length)));
  await Promise.all(Array.from({ length: count }, () => worker()));
  const completed = results.filter(Boolean);
  const passed = completed.filter(item => item.pass).length;
  return { version: '1', total: completed.length, passed,
    failed: completed.length - passed,
    passRate: completed.length ? passed / completed.length : 1,
    results: completed };
}

export function regressionGate(report, { minPassRate = 1, maxFailed = 0 } = {}) {
  const passRate = Number(report?.passRate ?? 0);
  const failed = Number(report?.failed ?? 0);
  return { pass: passRate >= Number(minPassRate) && failed <= Number(maxFailed),
    passRate, failed, rule: 'A change is promotable only when its configured evaluation gate passes.' };
}
