import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, jsonResponse } from './helpers.js';

const MODEL_FIXTURE = { AI_PROVIDER: 'fixture', AI_MODEL: 'fixture-model' };
const reply = text => jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 2, output_tokens: 2 } });
// The task request is the first user message of the the model request.
const requestOf = options => {
  try { return JSON.parse(JSON.parse(options.body).messages?.[0]?.content ?? '{}'); } catch { return {}; }
};

test('a follow-up in a chat is planned and answered with the earlier turns', () => {
  const seen = [];
  return withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const first = await call('POST', '/api/runs', {
      ...auth, body: { goal: 'What is the capital of France?', conversationId: 'chat-12345678', privacyConsent: { modelProvider: true } }
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.conversationId, 'chat-12345678');
    await call('POST', `/api/runs/${first.body.id}/execute`, { ...auth, body: {} });

    // One word would be too thin alone; in a chat it is a follow-up.
    const followUp = await call('POST', '/api/runs', {
      ...auth, body: { goal: 'Why?', conversationId: 'chat-12345678', privacyConsent: { modelProvider: true } }
    });
    assert.equal(followUp.status, 201);
    assert.deepEqual(followUp.body.adaptation.conversation, [{ user: 'What is the capital of France?', assistant: 'Paris.' }]);
    await call('POST', `/api/runs/${followUp.body.id}/execute`, { ...auth, body: {} });
    const sent = seen.find(request => request.goal === 'Why?' && request.task?.type === 'respond');
    assert.deepEqual(sent.conversation, [{ user: 'What is the capital of France?', assistant: 'Paris.' }]);

    // Too little on its own is asked about; inside a chat it continues it.
    const alone = await call('POST', '/api/runs', { ...auth, body: { goal: 'Help.' } });
    assert.equal(alone.status, 400);
    assert.equal(alone.body.code, 'needs-input');
    const inChat = await call('POST', '/api/runs', { ...auth, body: { goal: 'Help.', conversationId: 'chat-12345678' } });
    assert.equal(inChat.status, 201);
  }, {
    env: MODEL_FIXTURE,
    fetchImpl: async (_url, options) => {
      const request = requestOf(options);
      seen.push(request);
      return reply(request.goal === 'Why?' ? 'It has been the seat of government for centuries.' : 'Paris.');
    }
  });
});

test('conversation ids are validated', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const bad = await call('POST', '/api/runs', { token, workspace, body: { goal: 'Explain recursion.', conversationId: "x'; DROP" } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'invalid-conversation');
  }));

test('another person cannot pull private turns into their chat', () =>
  withServer(async ({ call, seed }) => {
    const owner = await seed({ workspace: 'team', role: 'editor', name: 'Owner' });
    const other = await seed({ workspace: 'team', role: 'editor', name: 'Other' });
    const first = await call('POST', '/api/runs', {
      token: owner.token, workspace: 'team', body: { goal: 'Summarise my private salary notes.', conversationId: 'shared-guess-1' }
    });
    await call('POST', `/api/runs/${first.body.id}/advance`, {
      token: owner.token, workspace: 'team', body: { taskId: 'respond', evidence: { text: 'Private answer.' } }
    });
    const probe = await call('POST', '/api/runs', {
      token: other.token, workspace: 'team', body: { goal: 'What did we say before?', conversationId: 'shared-guess-1' }
    });
    assert.equal(probe.status, 201);
    assert.equal(probe.body.adaptation.conversation, undefined);
    const listed = await call('GET', '/api/conversations/shared-guess-1', { token: other.token, workspace: 'team' });
    assert.ok(listed.body.runs.every(run => run.goal !== 'Summarise my private salary notes.'));
  }));

test('chats are listed once each and load in order', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    for (const goal of ['Explain recursion simply.', 'Give an example in Python.']) {
      await call('POST', '/api/runs', { ...auth, body: { goal, conversationId: 'chat-aaaaaaaa' } });
    }
    const single = await call('POST', '/api/runs', { ...auth, body: { goal: 'Explain gravity simply.' } });

    const { body } = await call('GET', '/api/conversations', auth);
    const chat = body.conversations.find(item => item.id === 'chat-aaaaaaaa');
    assert.equal(chat.title, 'Explain recursion simply.');
    assert.equal(body.conversations.filter(item => item.id === 'chat-aaaaaaaa').length, 1);
    assert.ok(body.conversations.some(item => item.id === single.body.id && item.single));

    const loaded = await call('GET', '/api/conversations/chat-aaaaaaaa', auth);
    assert.deepEqual(loaded.body.runs.map(run => run.goal), ['Explain recursion simply.', 'Give an example in Python.']);
    const old = await call('GET', `/api/conversations/${single.body.id}`, auth);
    assert.equal(old.body.runs.length, 1);
    assert.equal((await call('GET', '/api/conversations/chat-nothere', auth)).status, 404);
  }));

test('a person deletes their own chat, with its steps and actions; nobody else can', () =>
  withServer(async ({ call, seed, pool }) => {
    const me = await seed();
    const auth = { token: me.token, workspace: me.workspace };
    const first = await call('POST', '/api/runs', { ...auth, body: { goal: 'What is the capital of France?', conversationId: 'chat-deleteme1', visibility: 'workspace', privacyConsent: { modelProvider: true } } });
    await call('POST', `/api/runs/${first.body.id}/execute`, { ...auth, body: {} });
    await call('POST', '/api/runs', { ...auth, body: { goal: 'And of Spain?', conversationId: 'chat-deleteme1', visibility: 'workspace', privacyConsent: { modelProvider: true } } });
    await call('POST', '/api/memories', { ...auth, body: { content: 'Plans a trip to Europe' } });

    const other = await seed({ name: 'Other', role: 'editor' });
    assert.equal((await call('GET', '/api/conversations/chat-deleteme1', { token: other.token, workspace: me.workspace })).status, 200, 'shared, so they can read it');
    assert.equal((await call('DELETE', '/api/conversations/chat-deleteme1', { token: other.token, workspace: me.workspace })).status, 404, 'but not delete it');

    const deleted = await call('DELETE', '/api/conversations/chat-deleteme1', auth);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.deleted, 2);
    assert.equal((await call('GET', '/api/conversations/chat-deleteme1', auth)).status, 404);
    const { rows: [left] } = await pool.query('SELECT count(*)::int AS n FROM run_tasks WHERE run_id = $1', [first.body.id]);
    assert.equal(left.n, 0, 'its steps are gone too');
    assert.equal((await call('GET', '/api/memories', auth)).body.memories.length, 1, 'memories are managed separately');
    assert.equal((await call('DELETE', '/api/conversations/chat-deleteme1', auth)).status, 404);
  }, { env: MODEL_FIXTURE, fetchImpl: async () => reply('Paris.') }));

test('a chat long enough to fill the recent window still lists every newest chat', () =>
  withServer(async ({ call, seed, pool }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    // An older, separate chat, then one very long chat updated after it.
    await call('POST', '/api/runs', { ...auth, body: { goal: 'Explain how photosynthesis works.', conversationId: 'chat-older000' } });
    const { body: first } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Explain how a heat pump works, simply.', conversationId: 'chat-long0000' } });
    // 60 more turns in the long chat: more than the window read for a page of 2 (2 × 20).
    await pool.query(
      `INSERT INTO runs (id, conversation_id, created_at, updated_at, workspace_id, principal_id, goal, surface, state, intent,
                         capabilities, governance, attempt, max_attempts, tokens_used, max_tokens, completed_at, adaptation, situation, visibility)
       SELECT gen_random_uuid(), conversation_id, now() + (g || ' seconds')::interval, now() + (g || ' seconds')::interval,
              workspace_id, principal_id, 'Turn ' || g, surface, state, intent, capabilities, governance, attempt, max_attempts,
              tokens_used, max_tokens, completed_at, adaptation, situation, visibility
         FROM runs, generate_series(1, 60) g WHERE id = $1`,
      [first.id]
    );
    const { body } = await call('GET', '/api/conversations?limit=2', auth);
    assert.deepEqual(body.conversations.map(chat => chat.id), ['chat-long0000', 'chat-older000'], 'the older chat is not lost behind the long one');
    assert.equal(body.conversations[0].title, 'Explain how a heat pump works, simply.');
    assert.equal(body.conversations[0].messages, 61);
  }));
