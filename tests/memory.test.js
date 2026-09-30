import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { withServer, jsonResponse } from './helpers.js';
import { MemoryStore } from '../src/memory.js';
import { MIGRATIONS } from '../src/migrations.js';

/** Drive a chat like the app does until its answer; returns the answer step. */
async function ask(call, who, goal, conversationId = crypto.randomUUID()) {
  const run = await call('POST', '/api/runs', { ...who, body: { goal, conversationId, privacyConsent: { modelProvider: true } } });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  for (let i = 0; i < 20; i += 1) {
    const current = (await call('GET', `/api/runs/${run.body.id}`, who)).body;
    const next = current.tasks.find(task => task.id === current.next);
    if (!next) break;
    const step = next.type === 'approval'
      ? await call('POST', `/api/runs/${run.body.id}/advance`, { ...who, body: { taskId: next.id, approved: true } })
      : await call('POST', `/api/runs/${run.body.id}/execute`, { ...who, body: ['tool', 'investigate', 'code'].includes(next.type) ? { approved: true } : {} });
    assert.equal(step.status, 200, JSON.stringify(step.body).slice(0, 300));
    if (['respond', 'deliver', 'prototype'].includes(next.type)) return step.body;
  }
  throw new Error('no answer');
}

test('memory: people add, list and delete their own memories; secrets are refused', () =>
  withServer(async ({ call, seed, pool }) => {
    const me = await seed();
    const auth = { token: me.token, workspace: me.workspace };
    const added = await call('POST', '/api/memories', { ...auth, body: { content: 'Works as a site engineer in Lahore', kind: 'about' } });
    assert.equal(added.status, 201);
    assert.equal((await call('POST', '/api/memories', { ...auth, body: { content: 'works as a site engineer in lahore.' } })).status, 200, 'the same thing again is not repeated');
    const secret = await call('POST', '/api/memories', { ...auth, body: { content: 'My password is hunter2' } });
    assert.equal(secret.status, 400);
    assert.equal(secret.body.code, 'memory-secret');
    assert.equal((await call('POST', '/api/memories', { ...auth, body: { content: 'Card 4242 4242 4242 4242' } })).status, 400);

    const { rows: [stored] } = await pool.query(
      'SELECT content, normalized, content_enc, normalized_digest, encryption_version FROM memories WHERE id = $1',
      [added.body.memory.id]
    );
    assert.equal(stored.content, '');
    assert.equal(stored.normalized, '');
    assert.equal(stored.encryption_version, 1);
    assert.ok(stored.content_enc);
    assert.ok(stored.normalized_digest);
    assert.equal(stored.content_enc.includes('site engineer'), false);

    const { body } = await call('GET', '/api/memories', auth);
    assert.equal(body.crossChatMemory, false);
    assert.deepEqual(body.memories.map(item => item.content), ['Works as a site engineer in Lahore']);

    // Another member of the same workspace sees none of it and cannot delete it.
    const other = await seed({ name: 'Other', role: 'editor' });
    const theirs = { token: other.token, workspace: me.workspace };
    assert.equal((await call('GET', '/api/memories', theirs)).body.memories.length, 0);
    assert.equal((await call('DELETE', `/api/memories/${added.body.memory.id}`, theirs)).status, 404);

    assert.equal((await call('DELETE', `/api/memories/${added.body.memory.id}`, auth)).body.removed, 1);
    await call('POST', '/api/memories', { ...auth, body: { content: 'Prefers metric units' } });
    assert.equal((await call('DELETE', '/api/memories', auth)).body.removed, 1);
  }));

test('memory: each chat is isolated by default; cross-chat sharing is optional', () => {
  const seen = [];
  return withServer(async ({ call, seed }) => {
    const me = await seed();
    const auth = { token: me.token, workspace: me.workspace };
    const chatA = crypto.randomUUID();
    const chatB = crypto.randomUUID();
    const chatC = crypto.randomUUID();

    const first = await ask(call, auth, 'I am a site engineer in Lahore and I work on 230 V systems. What cable size is common for lighting circuits?', chatA);
    const savedTools = first.run.tasks.find(task => task.evidence?.tools)?.evidence.tools ?? [];
    assert.ok(savedTools.some(item => item.tool === 'memory.save' && item.outcome === 'ok'));
    assert.deepEqual((await call('GET', '/api/memories', auth)).body.memories, [], 'chat-local memory is not a global memory entry');

    const second = await ask(call, auth, 'What breaker should I use for a water heater?', chatA);
    assert.deepEqual(seen.at(-1), ['Site engineer in Lahore, works on 230 V systems'], 'the same chat remembers');
    assert.equal(second.run.tasks.find(task => task.type === 'respond').evidence.remembered, 1);

    await ask(call, auth, 'What breaker should I use for a water heater?', chatB);
    assert.equal(seen.at(-1), null, 'a different chat does not inherit memory by default');

    await call('PATCH', '/api/preferences', { ...auth, body: { crossChatMemory: true } });
    const shared = await ask(call, auth, 'What breaker should I use for a water heater?', chatB);
    assert.deepEqual(seen.at(-1), ['Site engineer in Lahore, works on 230 V systems'], 'cross-chat sharing works when enabled');
    assert.equal(shared.run.tasks.find(task => task.type === 'respond').evidence.remembered, 1);

    await call('PATCH', '/api/preferences', { ...auth, body: { crossChatMemory: false } });
    await ask(call, auth, 'I also teach at a college. What breaker should I use for a water heater?', chatC);
    assert.equal(seen.at(-1), null, 'turning cross-chat memory off immediately isolates new chats');
    const sameChat = await ask(call, auth, 'What did I say about my teaching work?', chatC);
    assert.deepEqual(seen.at(-1), ['Teaches at a college'], 'chat C still remembers its own memory with the switch off');
    assert.equal(sameChat.run.tasks.find(task => task.type === 'respond').evidence.remembered, 1);

    const other = await seed({ name: 'Other', role: 'editor' });
    await call('PATCH', '/api/preferences', { token: other.token, workspace: me.workspace, body: { crossChatMemory: true } });
    await ask(call, { token: other.token, workspace: me.workspace }, 'What did this person say about teaching?', crypto.randomUUID());
    assert.equal(seen.at(-1), null);

    assert.equal((await call('DELETE', '/api/conversations/' + chatA, auth)).status, 200);
    assert.equal((await call('GET', '/api/conversations/' + chatA, auth)).status, 404);
  }, {
    env: { AI_PROVIDER: 'anthropic', AI_API_KEY: 'test-key', AI_MODEL: 'claude-opus-5-5' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const request = (() => { try { const content = body.messages?.find(message => message.role === 'user')?.content ?? '{}'; return JSON.parse(typeof content === 'string' ? content : '{}'); } catch { return {}; } })();
      const reply = value => jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: value }], usage: { input_tokens: 3, output_tokens: 3 } });
      const type = request.task?.type;
      if (type === 'verify') return reply(JSON.stringify({ verdict: 'pass', criteria: (request.situation?.successCriteria ?? []).map(criterion => ({ criterion, met: true })), problems: [] }));
      if (type === 'understand') return reply(JSON.stringify({ successCriteria: ['answers the question'] }));
      if (!['respond', 'deliver', 'prototype', 'step'].includes(type)) return reply('ok');
      const turn = body.messages.filter(message => message.role === 'assistant').length;
      if (turn === 0) seen.push(request.remembered ?? null);
      if (turn === 0 && /site engineer|teach/.test(request.goal)) {
        return reply(JSON.stringify({ tool: 'memory.save', input: { fact: /teach/.test(request.goal) ? 'Teaches at a college' : 'Site engineer in Lahore, works on 230 V systems', kind: 'about' } }));
      }
      return reply('A 20 A breaker is typical.');
    }
  });
});

test('memory: "forget everything" forgets every chat; cross-chat recall never pushes out this chat', () =>
  withServer(async ({ call, seed, pool }) => {
    const me = await seed();
    const scope = { workspaceId: me.workspace, principalId: me.principal.id };
    const store = new MemoryStore(pool, { encryptionKey: Buffer.from('personal-key-32-bytes-long-00000') });
    const here = crypto.randomUUID();
    await store.add(scope, { content: 'The pump in this chat is a Grundfos CR 10', conversationId: here });
    // Many newer memories from other chats.
    for (let i = 0; i < 20; i += 1) {
      await store.add(scope, { content: `Other chat note number ${i} about gardening`, conversationId: crypto.randomUUID() });
    }
    const recalled = await store.recall(scope, 'what pump do I have', { conversationId: here, crossChat: true, limit: 5 });
    assert.ok(recalled.some(memory => /Grundfos/.test(memory.content)), 'this chat\'s memory is recalled');
    // Without a chat, cross-chat recall still reads the saved cross-chat memories.
    await store.add(scope, { content: 'Lives in Lahore', kind: 'about' });
    assert.ok((await store.recall(scope, 'where do I live', { crossChat: true })).some(memory => memory.content === 'Lives in Lahore'));

    const removed = (await call('DELETE', '/api/memories', { token: me.token, workspace: me.workspace })).body.removed;
    assert.equal(removed, 22);
    assert.deepEqual(await store.recall(scope, 'pump', { conversationId: here, crossChat: true }), []);
  }));

test('memory: people who had memories before cross-chat became a choice keep it on, or their old choice', () =>
  withServer(async ({ seed, pool }) => {
    const kept = await seed({ name: 'Kept' });
    const off = await seed({ name: 'Off' });
    const chose = await seed({ name: 'Chose' });
    const none = await seed({ name: 'None' });
    for (const who of [kept, off, chose]) {
      await pool.query("INSERT INTO memories (id, workspace_id, principal_id, content, normalized, kind) VALUES ($1, $2, $3, 'x', 'x', 'fact')",
        [crypto.randomUUID(), who.workspace, who.principal.id]);
    }
    await pool.query(`INSERT INTO user_preferences (principal_id, settings) VALUES ($1, '{"memory": false}'), ($2, '{"crossChatMemory": false}')`, [off.principal.id, chose.principal.id]);
    await pool.query(MIGRATIONS.find(item => item.version === 31).sql);
    const store = new MemoryStore(pool, { encryptionKey: Buffer.from('personal-key-32-bytes-long-00000') });
    assert.equal(await store.crossChatEnabled(kept.principal.id), true, 'the old default was on');
    assert.equal(await store.crossChatEnabled(off.principal.id), false, 'an old "off" stays off');
    assert.equal(await store.crossChatEnabled(chose.principal.id), false, 'a choice already made is kept');
    assert.equal(await store.crossChatEnabled(none.principal.id), false, 'new people start with it off');
  }));
