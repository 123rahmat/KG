/**
 * Stripe, over its REST API (no SDK): Checkout for subscriptions, the
 * customer portal for cards and invoices, and signed webhooks that keep a
 * workspace's subscription in step.
 *
 * Card data never passes through this server. People pay on Stripe's pages;
 * this server only learns the outcome, from webhooks it can verify.
 */

import crypto from 'node:crypto';

export const STRIPE_API_VERSION = '2024-06-20';
const STRIPE_TIMEOUT_MS = 15_000;
/** Webhooks older than this are refused, so a captured one cannot be replayed later. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export class StripeError extends Error {
  constructor(message, { status = 502, code = 'stripe-error', stripeCode = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.stripeCode = stripeCode;
  }
}

/** Stripe's form encoding: nested objects and arrays as a[b][0]=c. */
export function formEncode(params, prefix = '', out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) value.forEach((item, index) => (item && typeof item === 'object' ? formEncode(item, `${name}[${index}]`, out) : out.append(`${name}[${index}]`, String(item))));
    else if (typeof value === 'object') formEncode(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

/** One Stripe API call. POSTs carry an idempotency key so a retry never charges twice. */
export async function stripeRequest(stripe, fetchImpl, method, path, params = null, { idempotencyKey = null } = {}) {
  const url = new URL(path, stripe.apiBase);
  const headers = { authorization: `Bearer ${stripe.secretKey}`, 'stripe-version': STRIPE_API_VERSION };
  let body;
  if (method === 'GET' && params) for (const [key, value] of formEncode(params)) url.searchParams.append(key, value);
  else if (params) {
    body = formEncode(params).toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  if (method === 'POST') headers['idempotency-key'] = idempotencyKey ?? crypto.randomUUID();
  let response;
  try {
    response = await fetchImpl(url.toString(), { method, headers, body, signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS) });
  } catch {
    throw new StripeError('Stripe could not be reached. Try again in a moment.', { status: 503, code: 'stripe-unavailable' });
  }
  let data;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const error = data?.error ?? {};
    // Stripe's own message is safe to show for card and request problems;
    // authentication problems are the operator's, not the person's.
    const operator = response.status === 401 || response.status === 403;
    throw new StripeError(operator ? 'Payments are not set up correctly on this site. An administrator needs to check the Stripe keys.' : String(error.message || 'Stripe refused the request.'), {
      status: operator ? 503 : response.status >= 500 ? 502 : 400,
      code: operator ? 'stripe-misconfigured' : 'stripe-error',
      stripeCode: String(error.code ?? error.type ?? '')
    });
  }
  return data;
}

/**
 * Verify a webhook against the Stripe-Signature header: the HMAC-SHA256 of
 * "<timestamp>.<raw body>" with the endpoint secret must match one v1
 * signature, and the timestamp must be recent. Returns the parsed event.
 */
export function verifyWebhook(rawBody, header, secret, { now = Date.now(), tolerance = WEBHOOK_TOLERANCE_SECONDS } = {}) {
  const parts = String(header ?? '').split(',').map(part => part.trim().split('='));
  const timestamp = Number(parts.find(([key]) => key === 't')?.[1]);
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value).filter(Boolean);
  if (!Number.isFinite(timestamp) || !signatures.length) throw new StripeError('Missing or malformed Stripe signature.', { status: 400, code: 'stripe-signature-invalid' });
  if (Math.abs(now / 1000 - timestamp) > tolerance) throw new StripeError('The Stripe signature is too old.', { status: 400, code: 'stripe-signature-expired' });
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(payload).digest();
  const matches = signatures.some(signature => {
    const given = Buffer.from(signature, 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
  if (!matches) throw new StripeError('The Stripe signature does not match.', { status: 400, code: 'stripe-signature-invalid' });
  try {
    return JSON.parse(payload.toString('utf8'));
  } catch {
    throw new StripeError('The Stripe event is not valid JSON.', { status: 400, code: 'stripe-event-invalid' });
  }
}

/** A signature header for a payload, as Stripe would send it (tests and local tools). */
export function signWebhook(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

/** What this app keeps from a Stripe subscription object. */
export function subscriptionState(subscription, plans) {
  const item = subscription?.items?.data?.[0];
  const priceId = item?.price?.id ?? '';
  // A price names its plan. A plan sold by your team (custom price per
  // customer) is named by the subscription's metadata, which only people
  // with access to your Stripe account can set.
  const byMetadata = plans.find(candidate => candidate.contactUrl && candidate.id === subscription?.metadata?.plan_id);
  const plan = plans.find(candidate => candidate.priceIds.includes(priceId)) ?? byMetadata;
  // Newer API versions put the period on the item; older ones on the subscription.
  const periodEnd = item?.current_period_end ?? subscription?.current_period_end ?? null;
  return {
    subscriptionId: String(subscription?.id ?? ''),
    customerId: String(typeof subscription?.customer === 'string' ? subscription.customer : subscription?.customer?.id ?? ''),
    status: String(subscription?.status ?? ''),
    planId: plan?.id ?? '',
    currentPeriodEnd: Number.isFinite(periodEnd) ? new Date(periodEnd * 1000) : null,
    cancelAtPeriodEnd: subscription?.cancel_at_period_end === true
  };
}

/** Subscriptions in these states give the plan's features and limits. */
export const ACTIVE_STATUSES = Object.freeze(['active', 'trialing', 'past_due']);
