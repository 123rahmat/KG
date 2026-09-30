import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { withServer, jsonResponse } from './helpers.js';

const IMAGES = { python: process.env.SANDBOX_PYTHON_IMAGE || 'mirror.gcr.io/library/python:3.12-slim', node: process.env.SANDBOX_NODE_IMAGE || 'mirror.gcr.io/library/node:22-slim' };
const TOKEN = 't'.repeat(40);
function dockerReady() {
  try { execFileSync('docker', ['image', 'inspect', IMAGES.python], { stdio: 'ignore' }); return true; } catch { return false; }
}
const withDocker = dockerReady() ? { timeout: 300_000 } : { skip: 'no container runtime with the sandbox images here' };

/** Start the real sandbox runner on a free port. */
async function startRunner() {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ['bin/sandbox-runner.js'], {
    env: { ...process.env, RUNNER_TOKEN: TOKEN, SANDBOX_RUNNER_PORT: String(port), SANDBOX_IMAGE_PYTHON: IMAGES.python, SANDBOX_IMAGE_NODE: IMAGES.node },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { if (String(chunk).includes('listening')) resolve(); });
    child.on('exit', code => reject(new Error(`runner exited ${code}`)));
  });
  return { url: `http://127.0.0.1:${port}/v1/execute`, stop: () => child.kill() };
}

const TOOL = {
  name: 'beam-deflection',
  title: 'Beam deflection',
  description: 'Midspan deflection of a simply supported beam under a uniform load.',
  input: { w: 'load N/m', L: 'span m', E: 'Pa', I: 'm^4' },
  language: 'python',
  source: 'import json, sys\n\ndef deflection(w, L, E, I):\n    return 5 * w * L ** 4 / (384 * E * I)\n\nif __name__ == "__main__":\n    data = json.load(sys.stdin)\n    print(json.dumps({"deflection_m": deflection(**data)}))\n',
  tests: 'import unittest\nfrom main import deflection\n\nclass T(unittest.TestCase):\n    def test_known(self):\n        self.assertAlmostEqual(deflection(2000, 5, 210e9, 1.943e-5), 0.003988, places=5)\n'
};

test('Kindgleam runs code on a file, builds a tool with tests, and reuses it after approval', withDocker, async () => {
  const runner = await startRunner();
  const toolResults = [];
  let chat = 0;
  const fetchImpl = async (url, options) => {
    // The sandbox runner is real; only the AI provider is stood in.
    if (String(url).startsWith(runner.url)) return fetch(url, options);
    const body = JSON.parse(options.body);
    const request = (() => { try { const content = body.messages?.find(message => message.role === 'user')?.content ?? '{}'; return JSON.parse(typeof content === 'string' ? content : '{}'); } catch { return {}; } })();
    const last = body.messages.at(-1);
    if (typeof last.content === 'string' && last.content.startsWith('Tool result')) toolResults.push(last.content);
    const reply = text => jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 5, output_tokens: 5 } });
    if (!request.task) return reply('ok');
    if (request.task.type === 'verify') return reply(JSON.stringify({ verdict: 'pass', criteria: (request.situation?.successCriteria ?? []).map(criterion => ({ criterion, met: true })), problems: [] }));
    if (!['respond', 'deliver', 'prototype'].includes(request.task.type)) return reply(request.task.type === 'understand' ? '{}' : 'ok');
    chat += 1;
    const turn = body.messages.filter(message => message.role === 'assistant').length;
    if (/total load/i.test(request.goal)) {
      return reply(turn === 0
        ? JSON.stringify({ tool: 'code.run', input: { language: 'python', files: ['loads.csv'], source: 'import csv\nprint(sum(float(r["watts"]) for r in csv.DictReader(open("in/loads.csv"))))' } })
        : 'The total load is 3200 W.');
    }
    if (/build a tool/i.test(request.goal)) {
      return reply(turn === 0 ? JSON.stringify({ tool: 'tool.create', input: TOOL }) : 'I built the beam deflection tool; it waits for an admin to approve it.');
    }
    return reply(turn === 0
      ? JSON.stringify({ tool: 'ws.beam-deflection', input: { w: 2000, L: 5, E: 210e9, I: 1.943e-5 } })
      : 'It deflects about 4 mm.');
  };

  try {
    await withServer(async ({ call, seed }) => {
      const admin = await seed();
      const editor = await seed({ name: 'Editor', role: 'editor' });
      const auth = { token: admin.token, workspace: admin.workspace };
      // Drive the chat like the app does, approving plan gates, until the answer.
      const ask = async (who, goal, attachments = [], visibility = 'private', adaptiveControl = undefined) => {
        const run = await call('POST', '/api/runs', { ...who, body: { goal, attachments, visibility, privacyConsent: { modelProvider: true }, ...(adaptiveControl ? { adaptiveControl } : {}) } });
        assert.equal(run.status, 201, JSON.stringify(run.body));
        for (let i = 0; i < 20; i += 1) {
          const current = (await call('GET', `/api/runs/${run.body.id}`, who)).body;
          const next = current.tasks.find(task => task.id === current.next);
          if (!next) break;
          if (next.type === 'approval') {
            await call('POST', `/api/runs/${run.body.id}/advance`, { ...who, body: { taskId: next.id, approved: true } });
            continue;
          }
          // Tool, research and code steps need the person's approval, as in the app.
          const step = await call('POST', `/api/runs/${run.body.id}/execute`, { ...who, body: ['tool', 'investigate', 'code'].includes(next.type) ? { approved: true } : {} });
          assert.equal(step.status, 200, `${next.id}: ${JSON.stringify(step.body).slice(0, 300)}`);
          if (['respond', 'deliver', 'prototype'].includes(next.type)) return { run: run.body, step: step.body };
        }
        throw new Error('The chat never reached its answer.');
      };

      // 1. Code on an attached file, in the sandbox.
      const csv = await call('POST', '/api/objects', { ...auth, body: { name: 'loads.csv', type: 'attachment', contentType: 'text/csv', content: Buffer.from('room,watts\nkitchen,3000\nhall,200\n').toString('base64'), encoding: 'base64' } });
      const total = await ask(auth, 'What is the total load in this file?', [csv.body.id]);
      assert.equal(total.step.execution.text, 'The total load is 3200 W.');
      assert.match(toolResults.at(-1), /"stdout":"3200\.0\\n"/);
      assert.deepEqual(total.step.run.tasks.find(task => task.evidence?.tools).evidence.tools.map(item => [item.tool, item.outcome]), [['code.run', 'ok']]);

      // 2. A new tool is built only when the person chose to invest in one.
      const declined = await ask(auth, 'Build a tool for beam deflection so we can reuse it.');
      assert.equal(declined.step.run.tasks.find(task => task.evidence?.tools).evidence.tools[0].outcome, 'not-ready');
      // With that choice, its tests pass in the sandbox, then it is only proposed.
      // Shared with the workspace, so another member can see the proposal.
      const built = await ask(auth, 'Build a tool for beam deflection so we can reuse it.', [], 'workspace', { capabilityInvestment: 'build-candidate' });
      assert.equal(built.step.run.tasks.find(task => task.evidence?.tools).evidence.tools[0].outcome, 'proposed');
      const { body: { actions } } = await call('GET', `/api/runs/${built.run.id}/actions`, auth);
      assert.equal(actions.length, 1);
      assert.equal(actions[0].status, 'proposed');
      assert.match(actions[0].summary, /tests passed in the sandbox/);
      assert.equal(actions[0].input.testResult.status, 'completed');
      assert.equal((await call('GET', '/api/workspace-tools', auth)).body.tools.length, 0, 'nothing is kept before approval');

      // Only an admin may add a tool to the workspace.
      const byEditor = await call('POST', `/api/runs/${built.run.id}/actions/${actions[0].id}`, { token: editor.token, workspace: editor.workspace, body: { approve: true } });
      assert.equal(byEditor.status, 403);
      const approved = await call('POST', `/api/runs/${built.run.id}/actions/${actions[0].id}`, { ...auth, body: { approve: true } });
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.equal(approved.body.action.status, 'done');
      assert.equal(approved.body.action.result.tool, 'ws.beam-deflection');
      assert.equal((await call('POST', `/api/runs/${built.run.id}/actions/${actions[0].id}`, { ...auth, body: { approve: true } })).status, 409, 'decided once');
      const tools = (await call('GET', '/api/workspace-tools', auth)).body.tools;
      assert.deepEqual(tools.map(item => [item.tool, item.version, item.tested]), [['ws.beam-deflection', 1, true]]);

      // 3. A later chat uses the tool the workspace built.
      const reuse = await ask(auth, 'How much does a 5 m steel beam with I 1.943e-5 deflect under 2 kN/m?');
      assert.equal(reuse.step.execution.text, 'It deflects about 4 mm.');
      assert.match(toolResults.at(-1), /"deflection_m":0\.00398/);

      // Retired tools are no longer offered.
      assert.equal((await call('POST', '/api/workspace-tools/beam-deflection/retire', auth)).status, 200);
      assert.equal((await call('GET', '/api/workspace-tools', auth)).body.tools[0].status, 'retired');
    }, { env: { AI_PROVIDER: 'anthropic', AI_API_KEY: 'test-key', AI_MODEL: 'claude-opus-5-5', SANDBOX_RUNNER_URL: runner.url, RUNNER_TOKEN: TOKEN }, fetchImpl });
  } finally {
    runner.stop();
  }
  assert.ok(chat > 0);
});
