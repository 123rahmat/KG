import test from 'node:test';
import assert from 'node:assert/strict';
import { runInSandbox } from '../src/tool-forge.js';

test('code.run forwards sandbox-specific authorization and an execution id', async () => {
  const token = 't'.repeat(40);
  let calls = 0;
  const config = {
    runners: { sandbox: 'http://127.0.0.1:8767/v1/execute', sandboxToken: token },
    limits: { responseBytes: 1_000_000 }
  };
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(url, config.runners.sandbox);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.authorization, 'Bearer ' + token);
    const sent = JSON.parse(options.body);
    assert.equal(options.headers['x-kindgleam-execution-id'], sent.executionId);
    assert.equal(sent.payload.job.source, 'print(3200)');
    assert.equal(sent.executionTarget, 'general-ai-sandbox');
    return new Response(JSON.stringify({
      executed: true, status: 'completed', executionId: sent.executionId,
      output: { status: 'completed', exitCode: 0, stdout: '3200\n', files: [] }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await runInSandbox({ config, fetchImpl }, {
    language: 'python', source: 'print(3200)'
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'completed');
  assert.equal(result.stdout, '3200\n');
});

test('sandbox tool execution does not fabricate success from an unauthorized runner', async () => {
  const config = {
    runners: { sandbox: 'http://127.0.0.1:8767/v1/execute', sandboxToken: 't'.repeat(40) },
    limits: { responseBytes: 1_000_000 }
  };
  const result = await runInSandbox({ config,
    fetchImpl: async () => new Response(JSON.stringify({
      executed: false, status: 'unauthorized', message: 'Request denied'
    }), { status: 401 })
  }, { language: 'python', source: 'print(1)' });
  assert.match(result.error, /sandbox did not run|Request denied/i);
});
