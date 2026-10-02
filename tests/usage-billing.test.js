import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, jsonResponse } from './helpers.js';

/** A provider that answers everything with 40 tokens in and 10 out. */
const provider = async () => {
  return jsonResponse({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'An answer.' }],
    usage: { input_tokens: 40, output_tokens: 10 }
  });
};
const AI = { AI_PROVIDER: 'anthropic', AI_API_KEY: 'test-key', AI_MODEL: 'claude-opus-5-5' };

async function chatStep(call, auth, conversationId) {
  const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Explain how a heat pump works in winter', conversationId, privacyConsent: { modelProvider: true } } });
  const step = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
  return { run, step };
}

test('every AI call is recorded and shows in the 4-hour and weekly windows and the chat context', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { step } = await chatStep(call, auth, 'chat-usage-0001');
    assert.equal(step.status, 200);
    assert.equal(step.body.execution.executed, true);

    const usage = await call('GET', '/api/usage?conversationId=chat-usage-0001', auth);
    assert.equal(usage.status, 200);
    const [session, week] = usage.body.windows;
    assert.equal(session.id, 'session');
    assert.equal(session.hours, 4);
    assert.equal(week.id, 'week');
    assert.ok(session.used >= 50, 'the step was recorded');
    assert.equal(session.used, week.used);
    assert.equal(session.used, session.input + session.output);
    assert.equal(session.limit, null, 'no limit is configured');
    assert.ok(usage.body.bySource.chat >= 50);
    assert.equal(usage.body.days.length, 7);
    assert.equal(usage.body.days.at(-1).tokens, week.used);
    assert.equal(usage.body.context.used, 40, 'the prompt of the latest call');
    assert.equal(usage.body.context.limit, 1_048_576, 'the Gemini catalogue window');
    assert.equal(usage.body.model.provider, 'google');

    // Another person sees only their own usage.
    const other = await seed({ name: 'Other', role: 'editor' });
    const theirs = await call('GET', '/api/usage', { token: other.token, workspace });
    assert.equal(theirs.body.windows[0].used, 0);
  }, { env: AI, fetchImpl: provider }));

test('past the 4-hour limit, AI steps wait and say when they open again', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    await chatStep(call, auth, 'chat-limit-0001');
    const usage = await call('GET', '/api/usage', auth);
    const session = usage.body.windows[0];
    assert.equal(session.limit, 100);
    assert.equal(session.exceeded, true);
    assert.ok(session.resetsAt);

    const { step } = await chatStep(call, auth, 'chat-limit-0002');
    assert.equal(step.body.execution.executed, false);
    assert.equal(step.body.execution.status, 'usage-limit-reached');
    assert.match(step.body.execution.message, /4-hour AI usage limit\. It opens again at \d\d:\d\d UTC/);

    // Work that does not use the AI still works.
    assert.equal((await call('GET', '/api/schedules', auth)).status, 200);
  }, { env: { ...AI, USAGE_LIMIT_4H_TOKENS: '100' }, fetchImpl: provider }));


async function delayedProvider() {
  await new Promise(resolve => setTimeout(resolve, 75));
  return jsonResponse({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'An answer.' }],
    usage: { input_tokens: 40, output_tokens: 10 }
  });
}


test('concurrent AI requests share one atomic usage reservation', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const first = await call('POST', '/api/runs', {
      ...auth, body: { goal: 'Concurrent one', conversationId: 'concurrent-0001' }
    });
    const second = await call('POST', '/api/runs', {
      ...auth, body: { goal: 'Concurrent two', conversationId: 'concurrent-0002' }
    });

    const [a, b] = await Promise.all([
      call('POST', `/api/runs/${first.body.id}/execute`, { ...auth, body: {} }),
      call('POST', `/api/runs/${second.body.id}/execute`, { ...auth, body: {} })
    ]);
    const statuses = [a.body.execution?.status, b.body.execution?.status].sort();
    assert.deepEqual(statuses, ['completed', 'usage-limit-reached']);
  }, { env: { ...AI, USAGE_LIMIT_4H_TOKENS: '60' }, fetchImpl: delayedProvider }));

test('billing details are for admins, never hold card numbers, and link to the payment portal', () =>
  withServer(async ({ call, seed, pool }) => {
    const admin = await seed();
    const viewer = await seed({ name: 'Viewer', role: 'viewer' });
    const asAdmin = { token: admin.token, workspace: admin.workspace };

    const empty = await call('GET', '/api/billing', asAdmin);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.plan, 'Team');
    assert.equal(empty.body.portalUrl, 'https://billing.example.com/portal');
    assert.equal(empty.body.canEdit, true);
    assert.deepEqual(empty.body.limits, { fourHourTokens: 1000, weeklyTokens: 20000 });

    const saved = await call('PUT', '/api/billing', { ...asAdmin, body: { billingEmail: 'accounts@example.com', companyName: 'Example Ltd', taxId: 'PK-1234567', country: 'Pakistan', address: 'Lahore' } });
    assert.equal(saved.status, 200);
    const read = await call('GET', '/api/billing', asAdmin);
    assert.equal(read.body.details.companyName, 'Example Ltd');
    const { rows: [stored] } = await pool.query(
      'SELECT billing_email, company_name, tax_id, country, address, stripe_customer_id, stripe_subscription_id, billing_private_enc, billing_encryption_version FROM workspace_billing WHERE workspace_id = $1',
      [admin.workspace]
    );
    assert.equal(stored.billing_email, '');
    assert.equal(stored.company_name, '');
    assert.equal(stored.tax_id, '');
    assert.equal(stored.country, '');
    assert.equal(stored.address, '');
    assert.equal(stored.stripe_customer_id, null);
    assert.equal(stored.stripe_subscription_id, null);
    assert.equal(stored.billing_encryption_version, 1);
    assert.ok(stored.billing_private_enc);
    assert.equal(stored.billing_private_enc.includes('Example Ltd'), false);
    assert.equal(stored.billing_private_enc.includes('accounts@example.com'), false);

    const card = await call('PUT', '/api/billing', { ...asAdmin, body: { address: 'Card 4242 4242 4242 4242' } });
    assert.equal(card.status, 400);
    assert.equal(card.body.code, 'billing-card-data');
    const email = await call('PUT', '/api/billing', { ...asAdmin, body: { billingEmail: 'not an email' } });
    assert.equal(email.status, 400);

    const seen = await call('GET', '/api/billing', { token: viewer.token, workspace: viewer.workspace });
    assert.equal(seen.status, 200);
    assert.equal(seen.body.details, null);
    assert.equal(seen.body.portalUrl, null);
    assert.equal(seen.body.canEdit, false);
    const denied = await call('PUT', '/api/billing', { token: viewer.token, workspace: viewer.workspace, body: { companyName: 'X' } });
    assert.equal(denied.status, 403);
  }, { env: { BILLING_PLAN_NAME: 'Team', BILLING_PORTAL_URL: 'https://billing.example.com/portal', USAGE_LIMIT_4H_TOKENS: '1000', USAGE_LIMIT_WEEKLY_TOKENS: '20000' } }));

test('a person can see their signed-in sessions and sign out everywhere else', () =>
  withServer(async ({ seed, base }) => {
    const { token } = await seed();
    const signIn = async () => {
      const response = await fetch(base + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: token }) });
      return response.headers.get('set-cookie').split(';')[0];
    };
    const first = await signIn();
    const second = await signIn();
    const list = async cookie => (await fetch(base + '/api/sessions', { headers: { cookie } })).json();
    const before = await list(second);
    assert.equal(before.sessions.length, 2);
    assert.equal(before.sessions.filter(item => item.current).length, 1);
    assert.ok(before.sessions.every(item => item.id.length === 12));

    const revoked = await (await fetch(base + '/api/sessions/revoke-others', { method: 'POST', headers: { cookie: second, 'content-type': 'application/json', 'x-kindgleam-client': 'web' }, body: '{}' })).json();
    assert.equal(revoked.revoked, 1);
    assert.equal((await fetch(base + '/api/sessions', { headers: { cookie: first } })).status, 401);
    const after = await list(second);
    assert.equal(after.sessions.length, 1);
    assert.equal(after.sessions[0].current, true);
  }));


test('usage windows are isolated to the active workspace for the same person', () =>
  withServer(async ({ call, seed, pool }) => {
    const first = await seed({ workspace: 'usage-ws-a' });
    const secondWorkspace = 'usage-ws-b';
    await pool.query(
      'INSERT INTO organizations (id, name, type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      ['org-usage-ws-b', 'usage-ws-b', 'personal']
    );
    await pool.query(
      'INSERT INTO workspaces (id, name, max_bytes, max_objects, organization_id) VALUES ($1, $2, $3, $4, $5)',
      [secondWorkspace, secondWorkspace, 1000000, 1000, 'org-usage-ws-b']
    );
    await pool.query(
      'INSERT INTO memberships (workspace_id, principal_id, role) VALUES ($1, $2, $3)',
      [secondWorkspace, first.principal.id, 'editor']
    );

    await pool.query(
      `INSERT INTO usage_events
        (principal_id, workspace_id, conversation_id, source, provider, model, input_tokens, output_tokens)
        VALUES
        ($1, $2, $3, 'chat', 'anthropic', 'claude-opus-5-5', 40, 10),
        ($1, $4, $5, 'chat', 'anthropic', 'claude-opus-5-5', 400, 100)`,
      [first.principal.id, first.workspace, 'chat-usage-wsa', secondWorkspace, 'chat-usage-wsb']
    );

    const a = await call('GET', '/api/usage?conversationId=chat-usage-wsa', { token: first.token, workspace: first.workspace });
    const b = await call('GET', '/api/usage?conversationId=chat-usage-wsb', { token: first.token, workspace: secondWorkspace });

    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body.windows[0].used, 50);
    assert.equal(b.body.windows[0].used, 500);
    assert.equal(a.body.context.used, 40);
    assert.equal(b.body.context.used, 400);
  }));
