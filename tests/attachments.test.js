import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, jsonResponse } from './helpers.js';
import { docx, pdf, png } from './document-fixtures.js';

const MODEL_FIXTURE = { AI_PROVIDER: 'fixture', AI_MODEL: 'fixture-model' };
const reply = text => jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 2, output_tokens: 2 } });
// The task request is the first user message: a string, or, when images are
// attached, content blocks with the images first and the text last.
const requestOfBody = body => {
  const content = body?.messages?.[0]?.content;
  try { return JSON.parse(Array.isArray(content) ? content.find(block => block.type === 'text').text : content ?? '{}'); } catch { return {}; }
};
const requestOf = options => requestOfBody(JSON.parse(options.body));
const upload = (call, auth, { name, contentType, content, visibility = 'private' }) => call('POST', '/api/objects', {
  ...auth,
  body: { name, type: 'attachment', contentType, content: Buffer.from(content).toString('base64'), encoding: 'base64', visibility }
});

test('the AI reads the text of a file attached to a message', () => {
  const seen = [];
  return withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const file = await upload(call, auth, { name: 'notes.txt', contentType: 'text/plain', content: 'Meeting moved to Friday at 10.' });
    assert.equal(file.status, 201);

    // Two words alone would be too thin; with a file they are a real request.
    const run = await call('POST', '/api/runs', {
      ...auth, body: { goal: 'Summarise this.', attachments: [file.body.id], privacyConsent: { modelProvider: true } }
    });
    assert.equal(run.status, 201);
    assert.equal(run.body.adaptation.attachments[0].readable, true);
    assert.ok(!run.body.tasks.some(task => task.id === 'artifact-work'), 'a readable file needs no file tool');

    await call('POST', `/api/runs/${run.body.id}/execute`, { ...auth, body: {} });
    const sent = seen.find(request => request.task?.type === 'respond');
    assert.equal(sent.attachments[0].name, 'notes.txt');
    assert.equal(sent.attachments[0].text, 'Meeting moved to Friday at 10.');
  }, { env: MODEL_FIXTURE, fetchImpl: async (_url, options) => { seen.push(requestOf(options)); return reply('The meeting is on Friday at 10.'); } });
});

test('Word and PDF files are read as text, and images are shown to the model', () => {
  const bodies = [];
  return withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const word = await upload(call, auth, { name: 'pump.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: docx(['Pump flow 40 L/min']) });
    const report = await upload(call, auth, { name: 'calc.pdf', contentType: 'application/pdf', content: pdf(['Beam span 5 m']) });
    const photo = await upload(call, auth, { name: 'panel.png', contentType: 'image/png', content: png });
    const run = await call('POST', '/api/runs', {
      ...auth, body: { goal: 'Check these against each other.', attachments: [word.body.id, report.body.id, photo.body.id], privacyConsent: { modelProvider: true } }
    });
    assert.equal(run.status, 201);
    assert.deepEqual(run.body.adaptation.attachments.map(file => [file.format, file.readable]), [['docx', true], ['pdf', true], ['image', true]]);

    await call('POST', `/api/runs/${run.body.id}/execute`, { ...auth, body: {} });
    // Every AI step sees the files; the first one here is understanding the request.
    const body = bodies.find(item => requestOfBody(item).task);
    const sent = requestOfBody(body);
    assert.equal(sent.attachments[0].text, 'Pump flow 40 L/min');
    // The model is told to honour the situation's governance, and receives it.
    assert.match(body.system, /Follow every entry in adaptation\.governance\.restrictions/);
    assert.ok(sent.adaptation.governance, 'the governance record travels with the task');
    assert.match(sent.attachments[1].text, /Page 1\nBeam span 5 m/);
    assert.equal(sent.attachments[2].kind, 'image');
    const parts = body.messages[0].content;
    assert.ok(Array.isArray(parts), 'the user message carries the image');
    // the model takes images before the text they belong with.
    assert.equal(parts[0].type, 'image');
    assert.deepEqual([parts[0].source.type, parts[0].source.media_type], ['base64', 'image/png']);
    assert.ok(parts[0].source.data.length > 0);
    assert.equal(parts.at(-1).type, 'text');
  }, { env: MODEL_FIXTURE, fetchImpl: async (_url, options) => { bodies.push(JSON.parse(options.body)); return reply('Consistent.'); } });
});

test('a file that cannot be read is listed, not read', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const archive = await upload(call, auth, { name: 'backup.bin', contentType: 'application/octet-stream', content: '\u0000\u0001binary' });
    const run = await call('POST', '/api/runs', { ...auth, body: { goal: 'What is in this backup file?', attachments: [archive.body.id] } });
    assert.equal(run.status, 201);
    assert.equal(run.body.adaptation.attachments[0].readable, false);
    assert.ok(run.body.situation.artifacts.includes('backup.bin'));
  }));

test('someone else’s private file cannot be attached', () =>
  withServer(async ({ call, seed }) => {
    const owner = await seed({ workspace: 'team', role: 'editor', name: 'Owner' });
    const other = await seed({ workspace: 'team', role: 'editor', name: 'Other' });
    const secret = await upload(call, { token: owner.token, workspace: 'team' }, { name: 'salary.txt', contentType: 'text/plain', content: 'private' });
    const attempt = await call('POST', '/api/runs', {
      token: other.token, workspace: 'team', body: { goal: 'Summarise this file.', attachments: [secret.body.id] }
    });
    assert.equal(attempt.status, 400);
    assert.equal(attempt.body.code, 'attachment-not-found');

    const tooMany = await call('POST', '/api/runs', {
      token: owner.token, workspace: 'team', body: { goal: 'Summarise these.', attachments: Array(11).fill(secret.body.id) }
    });
    assert.equal(tooMany.body.code, 'too-many-attachments');
  }));

test('a later change is laid over a project: replaced, added and deleted files', async () => {
  const { withOverlay } = await import('../src/attachments.js');
  const files = [{ path: 'a.py', content: 'old' }, { path: 'b.py', content: 'keep' }, { path: 'c.py', content: 'gone' }];
  const merged = withOverlay(files, [{ path: 'a.py', content: 'new' }, { path: 'd.py', content: 'added' }, { path: 'c.py', content: null }]);
  assert.deepEqual(merged.map(file => [file.path, file.content]), [['a.py', 'new'], ['b.py', 'keep'], ['d.py', 'added']]);
  assert.equal(withOverlay(files, null), files);
});
