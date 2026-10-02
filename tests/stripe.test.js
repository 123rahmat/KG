import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, jsonResponse } from './helpers.js';
import { verifyWebhook, signWebhook, formEncode } from '../src/stripe.js';
import { loadConfig } from '../src/config.js';

const WEBHOOK_SECRET = 'whsec_testsecret';
const PLANS = [
  { id: 'pro', name: 'Pro', priceId: 'price_pro123', price: '$20 / month', fourHourTokens: 5000, weeklyTokens: 50000, features: ['More AI use'] },
  { id: 'team', name: 'Team', priceId: 'price_team123', price: '$60 / month', fourHourTokens: 20000, weeklyTokens: 200000 },
  { id: 'enterprise', name: 'Enterprise', contactUrl: 'mailto:sales@example.com', price: 'Custom', features: ['Single sign-on'] }
];
const STRIPE_ENV = {
  STRIPE_SECRET_KEY: 'sk_test_abc123',
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  PUBLIC_URL: 'https://ai.example.com',
  STRIPE_PLANS: JSON.stringify(PLANS),
  USAGE_LIMIT_4H_TOKENS: '100',
  USAGE_LIMIT_WEEKLY_TOKENS: '1000'
};

/** A stand-in Stripe API that records every call. */
function fakeStripe(calls, subscriptions = {}) {
  return async (url, options = {}) => {
    const { pathname } = new URL(url);
    const form = new URLSearchParams(options.body ?? '');
    calls.push({ method: options.method, path: pathname, form, headers: options.headers });
    if (pathname === '/v1/customers') return jsonResponse({ id: 'cus_123' });
    if (pathname === '/v1/checkout/sessions') return jsonResponse({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
    if (pathname === '/v1/billing_portal/sessions') return jsonResponse({ id: 'bps_1', url: 'https://billing.stripe.com/p/session/bps_1' });
    if (pathname.startsWith('/v1/subscriptions/')) return jsonResponse(subscriptions[pathname.split('/').pop()]);
    return jsonResponse({ error: { message: 'Not found' } }, 404);
  };
}

const subscription = (workspace, { id = 'sub_1', status = 'active', price = 'price_pro123', customer = 'cus_123', cancel = false } = {}) => ({
  id, object: 'subscription', status, customer, cancel_at_period_end: cancel,
  metadata: { workspace_id: workspace },
  items: { data: [{ price: { id: price }, current_period_end: 1_900_000_000 }] }
});
const event = (id, type, object, created = Math.floor(Date.now() / 1000)) => ({ id, type, created, data: { object } });

async function deliver(base, payload, { secret = WEBHOOK_SECRET, timestamp } = {}) {
  const body = JSON.stringify(payload);
  const response = await fetch(base + '/api/stripe/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'stripe-signature': signWebhook(body, secret, timestamp) },
    body
  });
  return { status: response.status, body: await response.json() };
}

test('webhook signatures are checked, and nested params are form-encoded the way Stripe expects', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'x' });
  assert.equal(verifyWebhook(body, signWebhook(body, WEBHOOK_SECRET), WEBHOOK_SECRET).id, 'evt_1');
  assert.throws(() => verifyWebhook(body.replace('evt_1', 'evt_2'), signWebhook(body, WEBHOOK_SECRET), WEBHOOK_SECRET), error => error.code === 'stripe-signature-invalid');
  assert.throws(() => verifyWebhook(body, signWebhook(body, 'whsec_other'), WEBHOOK_SECRET), error => error.code === 'stripe-signature-invalid');
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.throws(() => verifyWebhook(body, signWebhook(body, WEBHOOK_SECRET, old), WEBHOOK_SECRET), error => error.code === 'stripe-signature-expired');
  assert.throws(() => verifyWebhook(body, 'nonsense', WEBHOOK_SECRET), error => error.code === 'stripe-signature-invalid');

  const encoded = formEncode({ line_items: [{ price: 'price_1', quantity: 1 }], metadata: { workspace_id: 'ws' }, skip: undefined });
  assert.equal(encoded.get('line_items[0][price]'), 'price_1');
  assert.equal(encoded.get('line_items[0][quantity]'), '1');
  assert.equal(encoded.get('metadata[workspace_id]'), 'ws');
  assert.equal(encoded.has('skip'), false);
});

test('Stripe settings are validated: signed webhooks, a public URL, real plans, live keys in production', () => {
  const base = { DATABASE_URL: 'postgres://u:p@h:5432/d' };
  assert.throws(() => loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_abc', PUBLIC_URL: 'https://a.example', STRIPE_PLANS: JSON.stringify(PLANS) }), /STRIPE_WEBHOOK_SECRET/);
  assert.throws(() => loadConfig({ ...base, ...STRIPE_ENV, PUBLIC_URL: '' }), /PUBLIC_URL is required/);
  assert.throws(() => loadConfig({ ...base, ...STRIPE_ENV, STRIPE_PLANS: '[{"id":"x","name":"X","priceId":"nope"}]' }), /priceId/);
  assert.throws(() => loadConfig({ ...base, ...STRIPE_ENV, STRIPE_SECRET_KEY: 'pk_test_abc' }), /secret or restricted key/);
  const config = loadConfig({ ...base, ...STRIPE_ENV });
  assert.equal(config.stripe.plans[0].priceId, 'price_pro123');
  assert.equal(config.publicUrl, 'https://ai.example.com');
});

test('an admin buys a plan through Stripe Checkout; only a signed webhook makes it active', () => {
  const calls = [];
  return withServer(async ({ call, seed, base, pool }) => {
    const admin = await seed();
    const editor = await seed({ name: 'Editor', role: 'editor' });
    const auth = { token: admin.token, workspace: admin.workspace };

    const before = await call('GET', '/api/billing', auth);
    assert.deepEqual(before.body.stripe.plans.map(plan => plan.id), ['free', 'pro', 'team', 'enterprise']);
    assert.equal(before.body.plan, 'Free');
    assert.equal(before.body.stripe.plans[0].fourHourTokens, 100, 'free has the default limits');
    assert.ok(before.body.stripe.plans.every(plan => plan.priceId === undefined && plan.priceIds === undefined), 'price ids stay on the server');
    assert.equal(before.body.stripe.plans[3].contactUrl, 'mailto:sales@example.com');

    // Enterprise is arranged with sales, never bought through Checkout.
    const sales = await call('POST', '/api/billing/checkout', { ...auth, body: { planId: 'enterprise' } });
    assert.equal(sales.status, 400);
    assert.equal(sales.body.code, 'billing-plan-contact-sales');
    assert.equal(calls.length, 0);
    assert.equal(before.body.stripe.subscription, null);
    assert.deepEqual(before.body.limits, { fourHourTokens: 100, weeklyTokens: 1000 });

    assert.equal((await call('POST', '/api/billing/checkout', { token: editor.token, workspace: editor.workspace, body: { planId: 'pro' } })).status, 403);
    assert.equal((await call('POST', '/api/billing/checkout', { ...auth, body: { planId: 'gold' } })).status, 400);

    const checkout = await call('POST', '/api/billing/checkout', { ...auth, body: { planId: 'pro' } });
    assert.equal(checkout.status, 200);
    assert.equal(checkout.body.url, 'https://checkout.stripe.com/c/pay/cs_1');
    const [customer, session] = calls;
    assert.equal(customer.path, '/v1/customers');
    assert.equal(customer.form.get('metadata[workspace_id]'), admin.workspace);
    assert.equal(customer.headers['idempotency-key'], `customer-${admin.workspace}`);
    assert.equal(session.path, '/v1/checkout/sessions');
    assert.equal(session.form.get('mode'), 'subscription');
    assert.equal(session.form.get('customer'), 'cus_123');
    assert.equal(session.form.get('line_items[0][price]'), 'price_pro123');
    assert.equal(session.form.get('subscription_data[metadata][workspace_id]'), admin.workspace);
    assert.equal(session.form.get('success_url'), 'https://ai.example.com/?billing=success');
    assert.ok(session.headers.authorization.startsWith('Bearer sk_test_'));

    // Returning from Checkout proves nothing: still not subscribed.
    assert.equal((await call('GET', '/api/billing', auth)).body.stripe.subscription, null);

    // A forged webhook changes nothing.
    const forged = await deliver(base, event('evt_forged', 'customer.subscription.created', subscription(admin.workspace)), { secret: 'whsec_attacker' });
    assert.equal(forged.status, 400);

    const signed = await deliver(base, event('evt_1', 'customer.subscription.created', subscription(admin.workspace)));
    assert.equal(signed.status, 200);
    assert.equal(signed.body.outcome, 'applied');
    assert.equal((await deliver(base, event('evt_1', 'customer.subscription.created', subscription(admin.workspace)))).body.outcome, 'duplicate');

    const after = await call('GET', '/api/billing', auth);
    assert.equal(after.body.plan, 'Pro');
    const { rows: [stored] } = await pool.query(
      'SELECT stripe_customer_id, stripe_subscription_id, billing_private_enc, billing_encryption_version, billing_storage_version FROM workspace_billing WHERE workspace_id = $1',
      [admin.workspace]
    );
    assert.equal(stored.stripe_customer_id, null);
    assert.equal(stored.stripe_subscription_id, null);
    assert.equal(stored.billing_encryption_version, 1);
    assert.equal(stored.billing_storage_version, 1);
    assert.ok(stored.billing_private_enc);
    assert.equal(stored.billing_private_enc.includes('cus_123'), false);
    assert.equal(stored.billing_private_enc.includes('sub_1'), false);
    assert.equal(after.body.stripe.subscription.status, 'active');
    assert.equal(after.body.stripe.subscription.planId, 'pro');
    assert.equal(new Date(after.body.stripe.subscription.currentPeriodEnd).getTime(), 1_900_000_000_000);
    assert.deepEqual(after.body.limits, { fourHourTokens: 5000, weeklyTokens: 50000 }, 'the plan sets the limits');
    const usage = await call('GET', '/api/usage', auth);
    assert.equal(usage.body.windows[0].limit, 5000);
    assert.equal(usage.body.plan, 'Pro');
    // Members see the workspace is paid, but billing details are owned by Stripe.
    const seen = await call('GET', '/api/billing', { token: editor.token, workspace: editor.workspace });
    assert.equal(seen.body.stripe.subscription.status, 'active');
    assert.equal(Object.hasOwn(seen.body, 'details'), false);
    assert.equal(seen.body.billingAuthority, 'stripe');
    assert.equal(seen.body.billingDetailsStoredLocally, false);

    // Local billing-detail writes no longer exist; Stripe owns that data.
    assert.equal((await call('PUT', '/api/billing', { ...auth, body: { billingEmail: 'local@example.com' } })).status, 404);

    // A second checkout is refused; changes go through the portal.
    assert.equal((await call('POST', '/api/billing/checkout', { ...auth, body: { planId: 'team' } })).status, 409);
    const portal = await call('POST', '/api/billing/portal', auth);
    assert.equal(portal.body.url, 'https://billing.stripe.com/p/session/bps_1');
    assert.equal(calls.at(-1).form.get('customer'), 'cus_123');
    assert.equal(calls.at(-1).form.get('return_url'), 'https://ai.example.com/?billing=portal');

    // Another customer's subscription cannot take the workspace over.
    const other = await deliver(base, event('evt_2', 'customer.subscription.updated', subscription(admin.workspace, { customer: 'cus_other', price: 'price_team123' })));
    assert.equal(other.body.outcome, 'customer-mismatch');
    assert.equal((await call('GET', '/api/billing', auth)).body.plan, 'Pro');

    // Cancelling ends the plan: back to the default limits.
    await deliver(base, event('evt_3', 'customer.subscription.deleted', subscription(admin.workspace, { status: 'canceled' })));
    const ended = await call('GET', '/api/billing', auth);
    assert.equal(ended.body.stripe.subscription.status, 'canceled');
    assert.deepEqual(ended.body.limits, { fourHourTokens: 100, weeklyTokens: 1000 });

    // Unknown workspaces and other products' events are acknowledged, not applied.
    assert.equal((await deliver(base, event('evt_4', 'customer.subscription.created', subscription('no-such-workspace')))).body.outcome, 'unknown-workspace');
    assert.equal((await deliver(base, event('evt_5', 'invoice.paid', { id: 'in_1' }))).body.ignored, true);
  }, { env: STRIPE_ENV, fetchImpl: fakeStripe(calls) });
});

test('a completed checkout reads the subscription from Stripe before trusting it', () => {
  const calls = [];
  const subscriptions = {};
  return withServer(async ({ call, seed, base }) => {
    const admin = await seed();
    subscriptions.sub_9 = subscription(admin.workspace, { id: 'sub_9', price: 'price_team123' });
    const completed = await deliver(base, event('evt_c', 'checkout.session.completed', {
      id: 'cs_9', object: 'checkout.session', mode: 'subscription', subscription: 'sub_9', customer: 'cus_123',
      client_reference_id: admin.workspace, metadata: { workspace_id: admin.workspace }
    }));
    assert.equal(completed.body.outcome, 'applied');
    assert.equal(calls[0].path, '/v1/subscriptions/sub_9');
    assert.equal(calls[0].method, 'GET');
    const billing = await call('GET', '/api/billing', { token: admin.token, workspace: admin.workspace });
    assert.equal(billing.body.plan, 'Team');
  }, { env: STRIPE_ENV, fetchImpl: fakeStripe(calls, subscriptions) });
});

test('without Stripe, checkout says payments are not set up', () =>
  withServer(async ({ call, seed, base }) => {
    const { token, workspace } = await seed();
    const checkout = await call('POST', '/api/billing/checkout', { token, workspace, body: { planId: 'pro' } });
    assert.equal(checkout.status, 409);
    assert.equal(checkout.body.code, 'stripe-not-configured');
    const hook = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{}' });
    assert.equal(hook.status, 404);
  }));

test('an Enterprise subscription set up by sales activates from its Stripe metadata', () =>
  withServer(async ({ call, seed, base }) => {
    const admin = await seed();
    // Sales creates the subscription in Stripe with a custom price and plan_id=enterprise.
    const custom = subscription(admin.workspace, { id: 'sub_ent', price: 'price_custom_acme' });
    custom.metadata.plan_id = 'enterprise';
    assert.equal((await deliver(base, event('evt_ent', 'customer.subscription.created', custom))).body.outcome, 'applied');
    const billing = await call('GET', '/api/billing', { token: admin.token, workspace: admin.workspace });
    assert.equal(billing.body.plan, 'Enterprise');
    assert.deepEqual(billing.body.limits, { fourHourTokens: null, weeklyTokens: null }, 'no limits unless sales sets them');

    // A self-serve price cannot claim a sales-only plan through metadata.
    const other = await seed({ workspace: 'ws2' });
    const sneaky = subscription('ws2', { id: 'sub_x', price: 'price_pro123' });
    sneaky.metadata.plan_id = 'enterprise';
    await deliver(base, event('evt_x', 'customer.subscription.created', sneaky));
    assert.equal((await call('GET', '/api/billing', { token: other.token, workspace: 'ws2' })).body.plan, 'Pro');
  }, { env: STRIPE_ENV }));


test('older Stripe events cannot roll subscription state backward', () => {
  const calls = [];
  return withServer(async ({ call, seed, base }) => {
    const admin = await seed();
    const fresh = await deliver(base, event('evt_new', 'customer.subscription.updated', subscription(admin.workspace, { id: 'sub_1', status: 'active', price: 'price_team123' }), 200));
    assert.equal(fresh.body.outcome, 'applied');
    const stale = await deliver(base, event('evt_old', 'customer.subscription.updated', subscription(admin.workspace, { id: 'sub_1', status: 'canceled', price: 'price_pro123' }), 100));
    assert.equal(stale.body.outcome, 'stale-event');
    const billing = await call('GET', '/api/billing', { token: admin.token, workspace: admin.workspace });
    assert.equal(billing.body.plan, 'Team');
    assert.equal(billing.body.stripe.subscription.status, 'active');
  }, { env: STRIPE_ENV, fetchImpl: fakeStripe(calls) });
});
