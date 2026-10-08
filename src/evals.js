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
        const tokenCount = Number(output?.tokensUsed ?? output?.tokens ?? output?.usage?.totalTokens);
        const measuredCost = Number(output?.costUsd ?? output?.usage?.costUsd);
        results[index] = { id: item.id, version: item.version, tags: item.tags,
          elapsedMs: Date.now() - started, ...scoreEvalResult(output, item.expected),
          ...(Number.isFinite(tokenCount) && tokenCount >= 0 ? { tokensUsed: tokenCount } : {}),
          ...(Number.isFinite(measuredCost) && measuredCost >= 0 ? { costUsd: measuredCost } : {}) };
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

export function summarizeEval(report) {
  const results = Array.isArray(report?.results) ? report.results : [];
  const total = results.length;
  const passed = results.filter(item => item.pass).length;
  const elapsed = results.map(item => Number(item.elapsedMs)).filter(Number.isFinite);
  const tokens = results.map(item => Number(item.tokens ?? item.tokensUsed)).filter(Number.isFinite);
  const costs = results.map(item => Number(item.costUsd)).filter(Number.isFinite);
  const totalCostUsd = costs.reduce((sum, cost) => sum + cost, 0);
  const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  return {
    version: 1,
    total,
    passed,
    failed: total - passed,
    passRate: total ? passed / total : 1,
    averageElapsedMs: average(elapsed),
    averageTokens: average(tokens),
    totalCostUsd,
    costPerAcceptedUsd: costs.length && passed > 0 ? totalCostUsd / passed : null,
    p95ElapsedMs: elapsed.length ? elapsed.slice().sort((a, b) => a - b)[Math.min(elapsed.length - 1, Math.ceil(elapsed.length * 0.95) - 1)] : 0,
    tagged: Object.fromEntries([...new Set(results.flatMap(item => Array.isArray(item.tags) ? item.tags : []))].map(tag => {
      const subset = results.filter(item => Array.isArray(item.tags) && item.tags.includes(tag));
      return [tag, {
        total: subset.length,
        passed: subset.filter(item => item.pass).length,
        passRate: subset.length ? subset.filter(item => item.pass).length / subset.length : 1
      }];
    }))
  };
}

export function compareEvalReports(candidate, baseline) {
  const current = summarizeEval(candidate);
  const prior = summarizeEval(baseline);
  return {
    passRateDelta: current.passRate - prior.passRate,
    averageElapsedDeltaMs: current.averageElapsedMs - prior.averageElapsedMs,
    averageTokensDelta: current.averageTokens - prior.averageTokens,
    costPerAcceptedDeltaUsd: current.costPerAcceptedUsd !== null && prior.costPerAcceptedUsd !== null
      ? current.costPerAcceptedUsd - prior.costPerAcceptedUsd : null,
    failedDelta: current.failed - prior.failed,
    candidate: current,
    baseline: prior
  };
}

export function regressionGate(report, { minPassRate = 1, maxFailed = 0, maxPassRateDrop = 0, maxAverageTokenIncrease = Infinity, maxAverageElapsedIncreaseMs = Infinity, maxCostPerAcceptedIncreaseUsd = Infinity } = {}) {
  const current = summarizeEval(report);
  const baseline = Number.isFinite(Number(report?.baselinePassRate))
    ? Number(report.baselinePassRate)
    : null;
  const passRateDrop = baseline === null ? 0 : baseline - current.passRate;
  const tokenIncrease = Number(report?.baselineAverageTokens) > 0
    ? current.averageTokens - Number(report.baselineAverageTokens)
    : 0;
  const elapsedIncrease = Number(report?.baselineAverageElapsedMs) > 0
    ? current.averageElapsedMs - Number(report.baselineAverageElapsedMs)
    : 0;
  const priorCost = Number(report?.baselineCostPerAcceptedUsd);
  const costIncrease = Number.isFinite(priorCost) && priorCost > 0 && current.costPerAcceptedUsd !== null
    ? current.costPerAcceptedUsd - priorCost : 0;
  return {
    pass: current.passRate >= Number(minPassRate)
      && current.failed <= Number(maxFailed)
      && passRateDrop <= Number(maxPassRateDrop)
      && tokenIncrease <= Number(maxAverageTokenIncrease)
      && elapsedIncrease <= Number(maxAverageElapsedIncreaseMs)
      && costIncrease <= Number(maxCostPerAcceptedIncreaseUsd),
    passRate: current.passRate,
    failed: current.failed,
    baselinePassRate: baseline,
    passRateDrop,
    averageTokens: current.averageTokens,
    averageElapsedMs: current.averageElapsedMs,
    tokenIncrease,
    elapsedIncrease,
    costPerAcceptedUsd: current.costPerAcceptedUsd,
    costIncrease,
    rule: 'A change is promotable only when quality stays within the configured reliability and efficiency regression limits.'
  };
}
