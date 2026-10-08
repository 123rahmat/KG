import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiFromStandIn, jsonResponse } from './helpers.js';
import { answerWithTools, toolCatalog, toolPrompt, useTool, parseToolCall, registerTools } from '../src/toolbox.js';
import { loadConfig } from '../src/config.js';
import { xlsx, docx } from './document-fixtures.js';

const config = loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d', AI_PROVIDER: 'google', GOOGLE_CLOUD_PROJECT: 'test-project', VERTEX_ACCESS_TOKEN: 'test-token', AI_MODEL: 'gemini-3.8-flash' });

/** Attached files served from memory, the way objects.read returns them. */
function filesContext(files) {
  const store = new Map(files.map((file, index) => [`obj${index}`, file]));
  return {
    scope: { workspaceId: 'ws', principalId: 'p1' },
    attachments: files.map((file, index) => ({ id: `obj${index}`, name: file.name, format: file.format, readable: true })),
    objects: { read: async (_scope, id) => ({ metadata: { name: store.get(id).name, contentType: '', digest: `d${id}` }, content: store.get(id).content }) }
  };
}

/** A model that answers from a script: each reply in turn, recording what it was sent. */
function scripted(replies, sent) {
  let index = 0;
  return geminiFromStandIn(async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return jsonResponse({ output_text: replies[Math.min(index++, replies.length - 1)], usage: { input_tokens: 10, output_tokens: 5 } });
  });
}

test('the catalog says which tools are ready and what the others need', () => {
  const none = toolCatalog({ config });
  assert.equal(none.find(tool => tool.name === 'file.read').ready, false);
  assert.equal(none.find(tool => tool.name === 'file.read').needs, 'files');
  assert.equal(none.find(tool => tool.name === 'math.evaluate').ready, true);
  const withFiles = toolCatalog({ config, ...filesContext([{ name: 'a.csv', format: 'csv', content: Buffer.from('x\n1') }]) });
  assert.equal(withFiles.find(tool => tool.name === 'data.analyze').ready, true);
  const offline = toolCatalog({ config: { ...config, tools: { webAccess: false } } });
  assert.match(offline.find(tool => tool.name === 'web.fetch').reason, /turned off/);
});

test('the AI is shown how to call only the tools it can use now', () => {
  const listed = ctx => JSON.parse(toolPrompt(ctx).split('Available tools:\n')[1]);
  const none = listed({ config });
  const fileRead = none.find(tool => tool.name === 'file.read');
  assert.equal(fileRead.input, undefined, 'a tool that is not ready has no input format to follow');
  assert.equal(fileRead.needs, 'files', 'but the AI can still say what it needs');
  assert.ok(none.find(tool => tool.name === 'math.evaluate').input);
  const withFiles = listed({ config, ...filesContext([{ name: 'a.csv', format: 'csv', content: Buffer.from('x\n1') }]) });
  assert.ok(withFiles.find(tool => tool.name === 'file.read').input);
});

test('the AI reads a file and analyses a table before answering', async () => {
  const sent = [];
  const ctx = { config, ...filesContext([
    { name: 'loads.xlsx', format: 'xlsx', content: xlsx('Loads', [['Room', 'Watts'], ['Kitchen', 3000], ['Hall', 200]]) },
    { name: 'spec.docx', format: 'docx', content: docx(['Supply is 230 V']) }
  ]) };
  const answer = await answerWithTools([{ role: 'system', content: 'You help.' }, { role: 'user', content: 'Total load?' }], ctx, {
    config,
    fetchImpl: scripted([
      '{"tool":"data.analyze","input":{"file":"loads"},"why":"sum the watts"}',
      '{"tool":"file.read","input":{"file":"spec.docx"}}',
      '{"tool":"math.evaluate","input":{"expression":"3200 / 230"}}',
      'The total is 3200 W, about 13.9 A at 230 V.'
    ], sent)
  });
  assert.equal(answer.text, 'The total is 3200 W, about 13.9 A at 230 V.');
  assert.deepEqual(answer.toolLog.map(item => [item.tool, item.outcome]), [['data.analyze', 'ok'], ['file.read', 'ok'], ['math.evaluate', 'ok']]);
  assert.deepEqual(answer.usage, { inputTokens: 40, outputTokens: 20 });
  assert.match(sent[0].input[0].content, /^You help\.\n\nTOOLS\./, 'the tool list joins the system prompt');
  const results = sent.at(-1).input.filter(message => message.role === 'user').map(message => message.content);
  assert.match(results[1], /"name":"Watts","count":2,"empty":0,"type":"number","min":200,"max":3000/);
  assert.match(results[2], /Supply is 230 V/);
  assert.match(results[3], /"value":13\.91/);
});

test('a tool budget of zero still executes one tool and forces a real synthesis answer', async () => {
  const sent = [];
  const answer = await answerWithTools(
    [
      { role: 'system', content: 'You help.' },
      { role: 'user', content: JSON.stringify({ goal: 'Research current facts', task: { id: 'investigate', type: 'investigate', purpose: 'Use the available search result.' } }) }
    ],
    { config },
    {
      config,
      maxRounds: 0,
      fetchImpl: scripted([
        '{"tool":"math.evaluate","input":{"expression":"1+1"}}',
        '{"tool":"math.evaluate","input":{"expression":"1+1"}}',
        'The result is 2.'
      ], sent)
    }
  );
  assert.equal(answer.text, 'The result is 2.');
  assert.equal(answer.toolLog.length, 1);
  assert.equal(answer.toolLog[0].tool, 'math.evaluate');
  assert.match(sent.at(-1).input.at(-1).content, /Available tool results/);
  assert.equal(sent.at(-1).input.at(-1).content.includes('"task":{"id":"investigate"'), false);
});

test('tools that are missing or not ready are reported, and the loop always ends with an answer', async () => {
  assert.match((await useTool('teleport', {}, { config })).error, /no tool "teleport"/);
  assert.equal((await useTool('file.read', { file: 'x' }, { config })).needs, 'files');
  const sent = [];
  const answer = await answerWithTools([{ role: 'user', content: 'Loop forever' }], { config }, {
    config, maxRounds: 2, fetchImpl: scripted(['{"tool":"math.evaluate","input":{"expression":"1+1"}}', '{"tool":"math.evaluate","input":{"expression":"1+1"}}', '{"tool":"math.evaluate","input":{"expression":"1+1"}}', 'Two.'], sent)
  });
  assert.equal(answer.text, 'Two.');
  assert.equal(answer.toolLog.length, 2);
  assert.match(sent.at(-1).input.at(-1).content, /No more tools can be used/);
  assert.equal(parseToolCall('The answer is {"tool":"x"}'), null, 'prose that mentions JSON is an answer');
});

test('a tool with side effects is proposed for approval, never run by the AI', async () => {
  let ran = false;
  registerTools([{
    name: 'test.remind', title: 'Set a reminder', description: 'test', input: {}, sideEffect: true,
    ready: () => ({ ready: true }), summarize: input => `Remind at ${input.at}`, run: () => { ran = true; return { ok: true }; }
  }]);
  const proposals = [];
  const ctx = { config, propose: async action => { proposals.push(action); return { id: 'act_1' }; } };
  const result = await useTool('test.remind', { at: '09:00' }, ctx);
  assert.deepEqual([result.proposed, result.actionId, result.summary], [true, 'act_1', 'Remind at 09:00']);
  assert.equal(ran, false);
  assert.deepEqual(proposals, [{ tool: 'test.remind', input: { at: '09:00' }, summary: 'Remind at 09:00' }]);
  assert.match((await useTool('test.remind', {}, { config })).error, /needs the person's approval/);
});

test('repeated equivalent approval proposals reuse the original action and converge', async () => {
  registerTools([{
    name: 'test.converge-proposal', description: 'test', input: {}, sideEffect: true,
    ready: () => ({ ready: true }), summarize: () => 'Create action', run: () => assert.fail('must only propose')
  }]);
  const proposals = [], sent = [];
  const answer = await answerWithTools([{ role: 'user', content: 'Create the action once.' }], {
    config, propose: async action => { proposals.push(action); return { id: `action-${proposals.length}` }; }
  }, {
    config, maxRounds: 6, fetchImpl: scripted([
      JSON.stringify({ tool: 'test.converge-proposal', input: { at: '09:00', tags: ['a', 'b'] } }),
      JSON.stringify({ tool: 'test.converge-proposal', input: { at: '10:00', tags: ['a', 'b'] } }),
      JSON.stringify({ tool: 'test.converge-proposal', input: { tags: ['b', 'a'], at: '10:00' } }),
      JSON.stringify({ tool: ' test.converge-proposal ', input: { tags: ['a', 'b'], at: '09:00' } }),
      'Three actions are proposed and await approval.'
    ], sent)
  });
  assert.equal(proposals.length, 3, 'distinct values and array order are separate actions; key order is not');
  assert.equal(answer.toolLog.at(-1).actionId, 'action-1');
  assert.equal(answer.toolLog.at(-1).reused, true);
  assert.deepEqual(answer.toolLoop, { stopReason: 'repeated-proposal', modelCalls: 5, toolCalls: 3, avoidedToolCalls: 1 });
  assert.deepEqual(answer.usage, { inputTokens: 50, outputTokens: 25 });
  assert.match(sent.at(-1).input.at(-1).content, /action-1/);
});

test('two unchanged failures stop the loop, while changed failures and successful reads continue', async () => {
  let calls = 0;
  registerTools([{
    name: 'test.converge-read', description: 'test', input: {}, ready: () => ({ ready: true }),
    run: async () => { calls++; return calls === 1 ? { error: 'first failure' }
      : calls === 2 ? { error: 'changed failure' } : calls <= 4 ? { value: calls } : { error: 'unchanged failure' }; }
  }]);
  const sent = [];
  const call = '{"tool":"test.converge-read","input":{"key":"x"}}';
  const answer = await answerWithTools([{ role: 'user', content: 'Read current state.' }], { config }, {
    config, maxRounds: 8, fetchImpl: scripted([...Array(6).fill(call), 'The source is unavailable.'], sent)
  });
  assert.equal(calls, 6, 'changed failures and successful live reads do not trigger an early stop');
  assert.equal(answer.text, 'The source is unavailable.');
  assert.deepEqual(answer.toolLoop, { stopReason: 'repeated-failure', modelCalls: 7, toolCalls: 6, avoidedToolCalls: 0 });
});

test('repeated unmet prerequisites converge without spending all tool rounds', async () => {
  const sent = [];
  const call = '{"tool":"file.read","input":{"file":"missing.txt"}}';
  const answer = await answerWithTools([{ role: 'user', content: 'Read missing.txt.' }], { config }, {
    config, maxRounds: 6, fetchImpl: scripted([call, call, 'Attach missing.txt so I can read it.'], sent)
  });
  assert.equal(answer.toolLog.length, 2);
  assert.equal(answer.toolLoop.stopReason, 'repeated-failure');
  assert.equal(sent.length, 3);
});

test('a changing prerequisite explanation allows the next readiness check', async () => {
  let checks = 0, ran = 0;
  registerTools([{
    name: 'test.readiness-progress', description: 'test', input: {},
    ready: () => {
      checks++;
      // Catalog construction checks readiness once before the model loop.
      return checks >= 4 ? { ready: true } : { ready: false, needs: 'admin', reason: checks <= 2 ? 'Waiting for approval' : 'Approved, waiting for provisioning' };
    },
    run: async () => { ran++; return { value: 'ready' }; }
  }]);
  const sent = [], call = '{"tool":"test.readiness-progress","input":{}}';
  const answer = await answerWithTools([{ role: 'user', content: 'Check provisioning.' }], { config }, {
    config, maxRounds: 6, fetchImpl: scripted([call, call, call, 'Ready.'], sent)
  });
  assert.equal(ran, 1);
  assert.equal(answer.toolLoop.stopReason, 'answer');
  assert.equal(answer.toolLog.length, 3);
});

test('budget synthesis retains the exact task contract and output format', async () => {
  const sent = [];
  const payload = {
    goal: 'Calculate and report', task: { id: 'step-1', type: 'step', purpose: 'Compute required result', requirementIds: ['r1'] },
    situation: { need: { deliverable: 'JSON result', form: 'JSON' }, constraints: ['Stay on main'], successCriteria: ['Total equals 2'], requirements: [{ id: 'r1', requirement: 'Use SI units' }] },
    verification: { requiredEvidence: ['A calculated total'], groundedCheck: false },
    adaptation: { governance: { restrictions: ['No publishing'] } },
    approvedPlan: { keep: ['Keep the existing authentication boundary'], remove: ['No email delivery'], change: ['Return XML only'] },
    conversation: [{ role: 'user', content: 'FOLLOWUP-CONSTRAINT: Include the units.' }],
    rag: [{ content: 'irrelevant context'.repeat(3000) }]
  };
  const answer = await answerWithTools([{ role: 'user', content: JSON.stringify(payload) }], { config }, {
    config, maxRounds: 1, fetchImpl: scripted(['{"tool":"math.evaluate","input":{"expression":"1+1"}}', '{"result":"2","enough":true}'], sent)
  });
  assert.equal(answer.text, '{"result":"2","enough":true}');
  const final = sent.at(-1).input;
  for (const retained of ['Stay on main', 'Total equals 2', 'Use SI units', 'A calculated total', 'No publishing', 'requirementIds', 'JSON result', 'Keep the existing authentication boundary', 'No email delivery', 'Return XML only', 'FOLLOWUP-CONSTRAINT']) {
    assert.ok(final.at(-1).content.includes(retained), `${retained} survives synthesis`);
  }
  assert.doesNotMatch(final[0].content, /final natural-language answer/);
  assert.doesNotMatch(final.at(-1).content, /irrelevant context/);
  assert.equal(answer.toolLoop.stopReason, 'round-budget');
});

test('oversized synthesis instructions fail explicitly rather than dropping constraints', async () => {
  const sent = [];
  const answer = await answerWithTools([{ role: 'user', content: JSON.stringify({ goal: 'Compute 2', task: { id: 'step-1' }, situation: { constraints: ['Do not lose this.'.repeat(1000)] } }) }], { config }, {
    config, maxRounds: 1, fetchImpl: scripted(['{"tool":"math.evaluate","input":{"expression":"1+1"}}', 'Two.'], sent)
  });
  assert.equal(answer.incomplete, 'synthesis-context-over-budget');
  assert.equal(answer.text, '');
  assert.equal(sent.length, 1, 'no unconstrained synthesis request');
  assert.deepEqual(answer.usage, { inputTokens: 10, outputTokens: 5 });
});

test('synthesis retains earlier workflow evidence separately from its task contract', async () => {
  const sent = [];
  await answerWithTools([{ role: 'user', content: JSON.stringify({
    goal: 'Report the calculated total against the measured limit', task: { id: 'step-1', type: 'step' },
    evidenceSoFar: [{ taskId: 'measure', evidence: { text: 'Measured limit: 230 W', citations: [{ url: 'https://example.com/measurement' }] } }]
  }) }], { config, requiredTool: { tool: 'math.evaluate', input: { expression: '100+100' } } }, {
    config, fetchImpl: scripted(['200 W is below 230 W.'], sent)
  });
  assert.match(sent.at(-1).input.at(-1).content, /Measured limit: 230 W/);
  assert.match(sent.at(-1).input.at(-1).content, /https:\/\/example.com\/measurement/);
});

test('a pre-cancelled context prevents every model and tool call', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Stopped by user'));
  const sent = [];
  await assert.rejects(answerWithTools([{ role: 'user', content: 'Compute.' }], { config, signal: controller.signal }, {
    config, fetchImpl: scripted(['Two.'], sent)
  }), /Stopped by user/);
  assert.equal(sent.length, 0);
});

test('context cancellation after a required tool prevents final synthesis', async () => {
  const controller = new AbortController(), sent = [];
  registerTools([{
    name: 'test.cancel-synthesis', description: 'test', input: {}, ready: () => ({ ready: true }),
    run: async () => { controller.abort(new Error('Stop during tool')); return { value: 2 }; }
  }]);
  await assert.rejects(answerWithTools([{ role: 'user', content: 'Compute.' }], {
    config, signal: controller.signal, requiredTool: { tool: 'test.cancel-synthesis', input: {} }
  }, { config, fetchImpl: scripted(['Two.'], sent) }), /Stop during tool/);
  assert.equal(sent.length, 0);
});

test('the AI downloads a spreadsheet and a PDF from the web and reads them', async () => {
  const http = await import('node:http');
  const { pdf } = await import('./document-fixtures.js');
  const files = {
    '/tariffs.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsx('Tariff', [['Units', 'Rate'], ['0-100', 22], ['101-200', 32]])],
    '/standard.pdf': ['application/pdf', pdf(['Clause 4.2 minimum cover 25 mm'])]
  };
  const server = http.createServer((req, res) => {
    const file = files[req.url];
    if (!file) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': file[0] });
    res.end(file[1]);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const ctx = { config, webOptions: { isAllowed: address => address === '127.0.0.1', ports: [port] } };
  try {
    const sheet = await useTool('web.download', { url: `http://127.0.0.1:${port}/tariffs.xlsx` }, ctx);
    assert.equal(sheet.format, 'xlsx');
    assert.equal(sheet.tables[0].columns.find(column => column.name === 'Rate').max, 32);
    assert.match(sheet.sha256, /^[0-9a-f]{64}$/);
    const standard = await useTool('web.download', { url: `http://127.0.0.1:${port}/standard.pdf` }, ctx);
    assert.match(standard.text, /Clause 4\.2 minimum cover 25 mm/);
    assert.match((await useTool('web.download', { url: `http://127.0.0.1:${port}/missing.pdf` }, ctx)).error, /404/);
    // Private and internal addresses stay out of reach without the test hook.
    assert.match((await useTool('web.download', { url: `http://127.0.0.1:${port}/tariffs.xlsx` }, { config })).error, /./);
  } finally {
    server.close();
  }
});


test('the active adaptive scope hides and blocks tools that are not selected', async () => {
  const scoped = { config, allowedTools: ['math.evaluate'] };
  assert.deepEqual(toolCatalog(scoped).map(item => item.name), ['math.evaluate']);
  assert.equal((await useTool('math.evaluate', { expression: '2 + 3' }, scoped)).value, 5);
  const blocked = await useTool('web.search', { query: 'unrelated' }, scoped);
  assert.equal(blocked.code, 'tool-out-of-scope');
  assert.match(blocked.error, /outside the current adaptive scope/);
});
