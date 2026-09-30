import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/observability.js';

const capture = () => {
  const lines = [];
  return { lines, logger: createLogger({ level: 'debug', stream: { write: line => lines.push(JSON.parse(line)) } }) };
};

test('secrets are redacted at any depth', () => {
  const { lines, logger } = capture();
  logger.info('call', {
    request: { headers: { authorization: 'Bearer abc', 'x-api-key': 'claude-key', 'set-cookie': 'sid=1' }, apiKey: 'sk-1' },
    password: 'p', accessToken: 'at-1', runnerToken: 'rt-1', usage: { inputTokens: 5, outputTokens: 3 }
  });
  const [line] = lines;
  assert.equal(line.password, '[redacted]');
  assert.equal(line.request.apiKey, '[redacted]');
  assert.equal(line.request.headers.authorization, '[redacted]');
  assert.doesNotMatch(JSON.stringify(line), /abc|sk-1|claude-key|sid=1|at-1|rt-1/);
  assert.deepEqual(line.usage, { inputTokens: 5, outputTokens: 3 }, 'token counts are not secrets');
});

test('an error is logged with where it came from and what caused it', () => {
  const { lines, logger } = capture();
  const cause = new Error('connection reset');
  logger.error('unhandled error', { error: new Error('query failed', { cause }) });
  const { error } = lines[0];
  assert.equal(error.message, 'query failed');
  assert.match(error.stack, /observability\.test\.js/, 'the stack points at the code that failed');
  assert.equal(error.cause.message, 'connection reset');
});

test('gauges are read when scraped and a failing gauge does not break the page', async () => {
  const { createMetrics } = await import('../src/observability.js');
  const metrics = createMetrics();
  let waiting = 0;
  metrics.gauge('db_pool_connections', () => [{ tags: { state: 'waiting' }, value: waiting }]);
  metrics.gauge('broken', () => { throw new Error('no pool'); });
  metrics.increment('readiness_failures_total');
  assert.match(metrics.render(), /db_pool_connections\{state="waiting"\} 0/);
  waiting = 3;
  const page = metrics.render();
  assert.match(page, /db_pool_connections\{state="waiting"\} 3/, 'the current value, not the one at registration');
  assert.match(page, /readiness_failures_total 1/);
  assert.doesNotMatch(page, /broken/);
});

test('a multi-line error message never reaches the logged stack', () => {
  const { lines, logger } = capture();
  logger.error('failed', { error: new Error('first line\nsecret-row: 1234-5678') });
  const { error } = lines[0];
  assert.doesNotMatch(error.stack, /secret-row/);
  assert.ok(error.stack.split('\n').every(line => line.startsWith('at ')));
});
