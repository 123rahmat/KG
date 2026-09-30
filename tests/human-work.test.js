import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, advanceTo, codeWritten } from './helpers.js';

// Runners configured, so plans include real code steps.
const RUNNERS = { SANDBOX_RUNNER_URL: 'https://code-runner.test', RUNNER_TOKEN: 'r'.repeat(40) };

test('a person can complete research with their own findings, recorded as human work', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace, principal } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', {
      ...auth, body: { goal: 'Research the latest evidence about an unfamiliar topic.' }
    });
    const reached = await advanceTo(call, auth, run.id, { until: 'investigate' });
    assert.equal(reached.next, 'investigate');

    const empty = await call('POST', `/api/runs/${run.id}/advance`, {
      ...auth, body: { taskId: 'investigate', evidence: { humanProvided: true, findings: '  ' } }
    });
    assert.equal(empty.status, 409);
    assert.equal(empty.body.code, 'execution-required');

    const done = await call('POST', `/api/runs/${run.id}/advance`, {
      ...auth,
      body: {
        taskId: 'investigate',
        summary: 'Read two reviews.',
        evidence: {
          humanProvided: true,
          findings: 'Two recent reviews agree on the main effect.',
          sources: ['https://example.org/review-1', ''],
          // A client cannot claim execution or forge provenance.
          provenance: { source: 'runner', executed: true },
          executionReceipt: { executed: true }
        }
      }
    });
    assert.equal(done.status, 200);
    const task = done.body.tasks.find(item => item.id === 'investigate');
    assert.equal(task.status, 'complete');
    assert.equal(task.evidence.findings, 'Two recent reviews agree on the main effect.');
    assert.deepEqual(task.evidence.sources, ['https://example.org/review-1']);
    assert.equal(task.evidence.provenance.source, 'human');
    assert.equal(task.evidence.provenance.executed, false);
    assert.equal(task.evidence.provenance.actor, principal.id);
    assert.equal(task.evidence.executionReceipt, undefined);
    assert.ok(done.body.next && done.body.next !== 'investigate', 'the work goes on from the findings');
  }));

test('code can never be completed with human findings; it must really run', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', {
      ...auth, body: { goal: 'Refactor this Python module.' }
    });
    const ready = await codeWritten(call, auth, run.id, { source: 'print(1)', tests: '' });
    assert.equal(ready.next, 'test-code');
    const claimed = await call('POST', `/api/runs/${run.id}/advance`, {
      ...auth, body: { taskId: 'test-code', evidence: { humanProvided: true, findings: 'I ran it and it passed.' } }
    });
    assert.equal(claimed.status, 409);
    assert.equal(claimed.body.code, 'execution-required');
  }, { env: RUNNERS }));
