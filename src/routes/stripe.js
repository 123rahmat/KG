/**
 * Stripe routes: Checkout for a plan, the customer portal, and the webhook
 * that is the only source of truth for a workspace's subscription.
 *
 * A browser can start a Checkout or open the portal, but it can never mark a
 * workspace as paid: only a webhook signed with STRIPE_WEBHOOK_SECRET does.
 */

import express from 'express';
import { runDbScope, transaction } from '../db.js';
import { stripeRequest, verifyWebhook, subscriptionState, StripeError, ACTIVE_STATUSES } from '../stripe.js';
import { encryptJson, decryptJson } from '../data-protection.js';

const text = value => String(value ?? '').trim();
export const STRIPE_WEBHOOK_PATH = '/api/stripe/webhook';
const WORKSPACE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'customer.subscription.paused', 'customer.subscription.resumed'
]);

const scopeFor = workspaceId => ({ principalId: '', workspaceId, organizationId: '', jurisdiction: '', role: 'billing-webhook' });

/** Write a subscription's state to its workspace. */
async function saveSubscription(client, workspaceId, state, { customerId = null, billingKey, eventCreated = 0, eventId = null } = {}) {
  const { rows: [existing] } = await client.query(
    'SELECT billing_private_enc FROM workspace_billing WHERE workspace_id = $1 FOR UPDATE',
    [workspaceId]
  );
  const privateBilling = existing?.billing_private_enc && billingKey
    ? decryptJson(billingKey, 'workspace-billing-v1', existing.billing_private_enc)
    : {};
  privateBilling.stripeCustomerId = customerId || state.customerId || privateBilling.stripeCustomerId || null;
  privateBilling.stripeSubscriptionId = state.subscriptionId || null;
  if (Number.isFinite(Number(eventCreated)) && Number(eventCreated) > 0) {
    privateBilling.stripeLastEventCreated = Number(eventCreated);
    privateBilling.stripeLastEventId = text(eventId) || privateBilling.stripeLastEventId || null;
  }
  const encoded = billingKey ? encryptJson(billingKey, 'workspace-billing-v1', privateBilling) : null;
  await client.query(
    `INSERT INTO workspace_billing
      (workspace_id, billing_email, company_name, tax_id, country, address, stripe_customer_id, stripe_subscription_id, billing_private_enc, billing_encryption_version,
       subscription_status, plan_id, current_period_end, cancel_at_period_end, stripe_synced_at)
     VALUES ($1, '', '', '', '', '', NULL, NULL, $2, 1, $3, $4, $5, $6, now())
     ON CONFLICT (workspace_id) DO UPDATE SET
       billing_private_enc = EXCLUDED.billing_private_enc,
       billing_encryption_version = 1,
       billing_email = '', company_name = '', tax_id = '', country = '', address = '',
       stripe_customer_id = NULL, stripe_subscription_id = NULL,
       subscription_status = EXCLUDED.subscription_status,
       plan_id = EXCLUDED.plan_id,
       current_period_end = EXCLUDED.current_period_end,
       cancel_at_period_end = EXCLUDED.cancel_at_period_end,
       stripe_synced_at = now()`,
    [workspaceId, encoded, state.status, state.planId, state.currentPeriodEnd, state.cancelAtPeriodEnd]
  );
}

/** Registered before the JSON parser: the signature covers the raw bytes. */
export function registerStripeWebhook(app, { config, pool, audit, logger, metrics, fetchImpl, route }) {
  app.post(STRIPE_WEBHOOK_PATH, express.raw({ type: '*/*', limit: '1mb' }), route(async (req, res) => {
    if (!config.stripe) return res.status(404).json({ error: 'Stripe is not set up on this site.', code: 'stripe-not-configured' });
    let event;
    try {
      event = verifyWebhook(req.body, req.get('stripe-signature'), config.stripe.webhookSecret);
    } catch (error) {
      metrics?.increment('stripe_webhooks_total', { outcome: 'rejected' });
      return res.status(error.status ?? 400).json({ error: error.message, code: error.code });
    }
    const object = event?.data?.object ?? {};
    const workspaceId = text(object.metadata?.workspace_id || object.client_reference_id);
    // Events for other products on the same Stripe account are acknowledged
    // and ignored: Stripe stops resending what gets a 2xx.
    if (!WORKSPACE_ID.test(workspaceId) || !(SUBSCRIPTION_EVENTS.has(event.type) || event.type === 'checkout.session.completed')) {
      metrics?.increment('stripe_webhooks_total', { outcome: 'ignored' });
      return res.json({ received: true, ignored: true });
    }

    // A checkout only names the subscription; its state comes from Stripe.
    let subscription = SUBSCRIPTION_EVENTS.has(event.type) ? object : null;
    if (event.type === 'checkout.session.completed') {
      if (object.mode !== 'subscription' || !object.subscription) return res.json({ received: true, ignored: true });
      subscription = typeof object.subscription === 'object'
        ? object.subscription
        : await stripeRequest(config.stripe, fetchImpl, 'GET', `/v1/subscriptions/${encodeURIComponent(object.subscription)}`);
    }
    const state = subscriptionState(subscription, config.stripe.plans);

    // No person is signed in here; the workspace is only this event's own.
    // A workspace that does not exist fails the foreign key below.
    const applied = await runDbScope(scopeFor(workspaceId), () => transaction(pool, async client => {
      const { rowCount } = await client.query(
        'INSERT INTO stripe_events (id, type, workspace_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
        [text(event.id), text(event.type), workspaceId]
      );
      if (!rowCount) return 'duplicate';
      // The workspace's own customer only: a subscription for another customer
      // cannot take over a workspace that already pays through Stripe.
      const { rows: [current] } = await client.query('SELECT billing_private_enc FROM workspace_billing WHERE workspace_id = $1 FOR UPDATE', [workspaceId]);
      const currentBilling = current?.billing_private_enc
        ? decryptJson(config.security.billingEncryptionKey, 'workspace-billing-v1', current.billing_private_enc)
        : {};
      if (currentBilling.stripeCustomerId && state.customerId && currentBilling.stripeCustomerId !== state.customerId) return 'customer-mismatch';
      const eventCreated = Number(event.created);
      if (
        Number.isFinite(eventCreated)
        && eventCreated > 0
        && Number(currentBilling.stripeLastEventCreated || 0) > eventCreated
      ) return 'stale-event';
      // Events can arrive out of order: an old subscription's update must not
      // overwrite a newer one, unless the old one is the one that ended.
      if (currentBilling.stripeSubscriptionId && state.subscriptionId && currentBilling.stripeSubscriptionId !== state.subscriptionId
          && !ACTIVE_STATUSES.includes(state.status)) return 'stale-subscription';
      await saveSubscription(client, workspaceId, state, {
        customerId: text(object.customer) || null,
        billingKey: config.security.billingEncryptionKey,
        eventCreated: Number(event.created),
        eventId: event.id
      });
      await audit?.record({
        principalId: null, workspaceId, action: 'billing.subscription', target: state.subscriptionId || workspaceId,
        outcome: 'allowed', critical: true, detail: { event: event.type, status: state.status, plan: state.planId, eventId: event.id }
      }, client);
      return 'applied';
    })).catch(error => {
      if (error?.code === '23503') return 'unknown-workspace';
      throw error;
    });
    metrics?.increment('stripe_webhooks_total', { outcome: applied });
    if (applied === 'customer-mismatch' || applied === 'unknown-workspace') logger?.warn('stripe webhook not applied', { outcome: applied, event: event.type, workspaceId });
    res.json({ received: true, outcome: applied });
  }));
}

export function registerStripeRoutes(app, { config, pool, audit, fetchImpl, route, scoped }) {
  const requireStripe = res => {
    if (config.stripe) return true;
    res.status(409).json({ error: 'Payments are not set up on this site.', code: 'stripe-not-configured' });
    return false;
  };
  const stripeFailure = (res, error) => {
    if (!(error instanceof StripeError)) throw error;
    return res.status(error.status).json({ error: error.message, code: error.code });
  };

  /** The workspace's Stripe customer, created on first use and remembered. */
  async function customerFor(req) {
    const { rows: [row] } = await pool.query('SELECT * FROM workspace_billing WHERE workspace_id = $1', [req.scope.workspaceId]);
    const privateBilling = row?.billing_private_enc
      ? decryptJson(config.security.billingEncryptionKey, 'workspace-billing-v1', row.billing_private_enc)
      : {};
    if (privateBilling.stripeCustomerId) return privateBilling.stripeCustomerId;
    const customer = await stripeRequest(config.stripe, fetchImpl, 'POST', '/v1/customers', {
      email: privateBilling.billingEmail || req.principal.email || undefined,
      name: privateBilling.companyName || undefined,
      metadata: { workspace_id: req.scope.workspaceId }
    }, { idempotencyKey: `customer-${req.scope.workspaceId}` });
    const encoded = encryptJson(config.security.billingEncryptionKey, 'workspace-billing-v1', { ...privateBilling, stripeCustomerId: customer.id, stripeSubscriptionId: privateBilling.stripeSubscriptionId || null });
    await pool.query(
      `INSERT INTO workspace_billing
        (workspace_id, billing_email, company_name, tax_id, country, address, stripe_customer_id, stripe_subscription_id, billing_private_enc, billing_encryption_version, updated_by, updated_at)
       VALUES ($1, '', '', '', '', '', NULL, NULL, $2, 1, $3, now())
       ON CONFLICT (workspace_id) DO UPDATE SET
         billing_private_enc = EXCLUDED.billing_private_enc, billing_encryption_version = 1,
         billing_email = '', company_name = '', tax_id = '', country = '', address = '',
         stripe_customer_id = NULL, stripe_subscription_id = NULL,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [req.scope.workspaceId, encoded, req.principal.id]
    );
    return customer.id;
  }

  app.post('/api/billing/checkout', scoped('admin'), route(async (req, res) => {
    if (!requireStripe(res)) return;
    const plan = config.stripe.plans.find(item => item.id === text(req.body?.planId));
    if (!plan) return res.status(400).json({ error: 'Choose one of the plans on offer.', code: 'billing-plan-unknown' });
    if (plan.contactUrl) return res.status(400).json({ error: `${plan.name} is arranged with our team. Contact us to set it up.`, code: 'billing-plan-contact-sales', contactUrl: plan.contactUrl });
    const { rows: [current] } = await pool.query('SELECT subscription_status FROM workspace_billing WHERE workspace_id = $1', [req.scope.workspaceId]);
    if (ACTIVE_STATUSES.includes(current?.subscription_status)) {
      return res.status(409).json({ error: 'This workspace already has a subscription. Change or cancel it in Manage payment.', code: 'billing-already-subscribed' });
    }
    try {
      const customer = await customerFor(req);
      const session = await stripeRequest(config.stripe, fetchImpl, 'POST', '/v1/checkout/sessions', {
        mode: 'subscription',
        customer,
        client_reference_id: req.scope.workspaceId,
        line_items: [{ price: plan.priceId, quantity: 1 }],
        allow_promotion_codes: 'true',
        metadata: { workspace_id: req.scope.workspaceId, plan_id: plan.id },
        subscription_data: { metadata: { workspace_id: req.scope.workspaceId, plan_id: plan.id } },
        success_url: `${config.publicUrl}/?billing=success`,
        cancel_url: `${config.publicUrl}/?billing=cancelled`
      });
      await audit?.record({ principalId: req.principal.id, workspaceId: req.scope.workspaceId, action: 'billing.checkout', target: plan.id, outcome: 'allowed', detail: { session: session.id }, requestId: req.requestId });
      res.json({ url: session.url });
    } catch (error) {
      return stripeFailure(res, error);
    }
  }));

  app.post('/api/billing/portal', scoped('admin'), route(async (req, res) => {
    if (!config.stripe) {
      if (config.billing.portalUrl) return res.json({ url: config.billing.portalUrl });
      return requireStripe(res);
    }
    try {
      const customer = await customerFor(req);
      const session = await stripeRequest(config.stripe, fetchImpl, 'POST', '/v1/billing_portal/sessions', {
        customer, return_url: `${config.publicUrl}/?billing=portal`
      });
      res.json({ url: session.url });
    } catch (error) {
      return stripeFailure(res, error);
    }
  }));
}
