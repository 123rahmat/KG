import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentContext } from '../src/attachments.js';

const scope = { workspaceId: 'ws-context-economy', principalId: 'owner' };
const file = (name, id = name) => ({ id, name, readable: true, format: 'text', contentType: 'text/plain' });

test('zero context budget does not read or parse irrelevant document attachments', async () => {
  let reads = 0;
  const objects = { read: async () => { reads += 1; throw new Error('must not read'); } };
  const view = await attachmentContext(objects, scope, [
    file('alpha.txt'), file('beta.pdf')
  ], { maxChars: 0, focus: 'Summarize later from targeted reads' });
  assert.equal(reads, 0);
  assert.equal(view.files.length, 2);
  assert.ok(view.files.every(item => item.truncated === true && item.readable === true));
  assert.ok(view.files.every(item => /file\.read/.test(item.more)));
});

test('credential-bearing files are blocked before document parsing', async () => {
  let reads = 0;
  const objects = { read: async () => { reads += 1; throw new Error('sensitive read attempted'); } };
  const view = await attachmentContext(objects, scope, [file('.env'), file('secrets/private-key.pem')], {
    maxChars: 5000
  });
  assert.equal(reads, 0);
  assert.equal(view.files.length, 2);
  assert.ok(view.files.every(item => item.readable === false));
  assert.ok(view.files.every(item => /sensitive/i.test(item.note)));
});

test('aborted context selection never opens a file', async () => {
  const controller = new AbortController();
  controller.abort(new Error('task-stopped'));
  const objects = { read: () => { throw new Error('unexpected read'); } };
  await assert.rejects(
    attachmentContext(objects, scope, [file('file.txt')], { signal: controller.signal }),
    /task-stopped/
  );
});
