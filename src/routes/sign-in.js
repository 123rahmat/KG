/**
 * Email sign-in: a one-time link instead of a password, and the outgoing mail
 * account a platform administrator sets from Settings.
 *
 * The public half is registered before authentication (nobody is signed in
 * yet); the admin half after it.
 */

import { runDbScope } from '../db.js';
import { AuthError, normalizeEmail } from '../identity.js';
import { signInMessage } from '../mailer.js';
import { text } from '../http/context.js';
import { rateLimiter, clientNetwork } from '../http/rate-limit.js';

export const LINK_MINUTES = 15;
// Links one address may be sent per window, so the form cannot be used to
// flood someone's inbox.
const LINKS_PER_ADDRESS = 3;
// Links one network address may ask for per hour. Every new account gets a
// free AI allowance, so scripted sign-ups from one machine are capped.
const LINKS_PER_IP_HOUR = 20;

const unscoped = principalId => ({ principalId, workspaceId: '', organizationId: '', jurisdiction: '', role: '' });

/**
 * Where links point: PUBLIC_URL. Without it, only a local development server
 * may use the address it was reached at. Anywhere else the Host header is the
 * sender's to choose, and a link built from it would take a real sign-in
 * email, and its token, to someone else's site.
 */
function publicBase(config, req) {
  if (config.publicUrl) return config.publicUrl;
  if (config.production) return null;
  const host = String(req.hostname ?? '').toLowerCase();
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) return null;
  return `${req.protocol}://${req.get('host')}`;
}

export function registerSignInRoutes(app, { config, identity, mailer, audit, metrics, pool, route, startBrowserSession }) {
  const limiter = name => rateLimiter({ name, windowMs: 60_000, max: 10, metrics, pool, store: config.limits.rateStore });

  // What the sign-in page offers. Public by design: booleans only.
  app.get('/api/sign-in/options', route(async (req, res) => {
    const email = Boolean(publicBase(config, req)) && await mailer.canSend();
    res.json({ email, signUp: config.signUp, accessKey: true });
  }));

  app.post('/api/sign-in/email', limiter('sign-in-email'), route(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) throw new AuthError('Enter a valid email address', { status: 400, code: 'bad-email' });
    const base = publicBase(config, req);
    if (!base || !await mailer.canSend()) {
      throw new AuthError('Email sign-in is not set up on this server yet. Use an access key.', { status: 409, code: 'email-unavailable' });
    }
    // The same answer whether or not the address has an account or has
    // reached its limit, so the form does not reveal who uses the service.
    const accepted = () => res.status(202).json({ sent: true, email, expiresInMinutes: LINK_MINUTES });

    if (await identity.recentLoginLinksFromIp(clientNetwork(req.ip), { minutes: 60 }) >= LINKS_PER_IP_HOUR) {
      metrics.increment('sign_in_links_throttled_total', { reason: 'ip' });
      throw new AuthError('Too many sign-in requests from this network. Try again in an hour.', { status: 429, code: 'sign-in-throttled' });
    }
    if (await identity.recentLoginLinks(email, { minutes: LINK_MINUTES }) >= LINKS_PER_ADDRESS) {
      metrics.increment('sign_in_links_throttled_total');
      return accepted();
    }
    if (!config.signUp) {
      const known = await pool.query('SELECT 1 FROM principals WHERE email = $1 AND disabled_at IS NULL', [email]);
      if (!known.rows[0]) return accepted();
    }
    const deliver = async () => {
      const { token } = await identity.issueLoginLink(email, { minutes: LINK_MINUTES, ip: clientNetwork(req.ip) });
      const link = `${base}/?signin=${encodeURIComponent(token)}`;
      await mailer.send({ to: email, ...signInMessage({ link, minutes: LINK_MINUTES }) });
      metrics.increment('sign_in_links_sent_total');
      await audit.record({ principalId: null, action: 'sign-in.link-sent', outcome: 'allowed', requestId: req.requestId, ip: req.ip });
    };
    if (config.signUp) {
      // Every address gets an email, so waiting reveals nothing and a mail
      // failure can be reported to the person.
      await deliver();
      return accepted();
    }
    // Only existing accounts get one: answer before sending, so the time the
    // answer takes cannot tell an attacker which addresses have accounts.
    accepted();
    deliver().catch(error => req.log?.error('sign-in email failed', { error: error.message, code: error.code }));
  }));

  /** Sign in the owner of a verified address, creating the account if allowed. */
  async function finishSignIn(email, req, res) {
    const principal = await identity.principalForEmail(email, {
      signUp: config.signUp,
      maxBytes: config.limits.workspaceBytes,
      maxObjects: config.limits.workspaceObjects
    });
    return runDbScope(unscoped(principal.id), async () => {
      const { expiresAt } = await startBrowserSession(res, principal, req);
      res.json({ principal: { id: principal.id, name: principal.name, kind: principal.kind }, expiresAt });
    });
  }

  // The link opens the app, which shows the link's 8-digit code to type on
  // the device that asked to sign in. Showing it spends nothing.
  app.post('/api/sign-in/email/link-code', limiter('sign-in-link-code'), route(async (req, res) => {
    const { code, email, expiresAt } = await identity.loginCodeForLink(req.body?.token);
    res.json({ code, email, expiresAt });
  }));

  // Or the person signs in right here, on the device that opened the link. A plain GET never signs anyone in, so mail scanners that open
  // every link cannot spend it.
  app.post('/api/sign-in/email/verify', limiter('sign-in-verify'), route(async (req, res) => {
    const email = await identity.redeemLoginLink(req.body?.token);
    return finishSignIn(email, req, res);
  }));

  // The 8-digit code from the link page, typed on the device signing in.
  app.post('/api/sign-in/email/code', limiter('sign-in-code'), route(async (req, res) => {
    const email = await identity.redeemLoginCode(req.body?.email, req.body?.code);
    return finishSignIn(email, req, res);
  }));
}

export function registerMailAdminRoutes(app, { mailer, audit, route }) {
  const requirePlatformAdmin = req => {
    if (!req.principal?.platformAdmin) {
      throw new AuthError('Only a platform administrator can manage email sending', { status: 403, code: 'platform-admin-required' });
    }
  };

  app.get('/api/admin/mail', route(async (req, res) => {
    requirePlatformAdmin(req);
    res.json({ mail: await mailer.view() });
  }));

  app.put('/api/admin/mail', route(async (req, res) => {
    requirePlatformAdmin(req);
    const mail = await mailer.save(req.body ?? {}, { principalId: req.principal.id });
    await audit.record({ principalId: req.principal.id, action: 'mail.settings.update', outcome: 'allowed', requestId: req.requestId, ip: req.ip });
    res.json({ mail });
  }));

  app.post('/api/admin/mail/test', route(async (req, res) => {
    requirePlatformAdmin(req);
    const to = normalizeEmail(req.body?.to) || normalizeEmail(req.principal.email);
    if (!to) throw new AuthError('Enter an address to send the test to', { status: 400, code: 'bad-email' });
    const result = await mailer.send({
      to,
      subject: 'Kindgleam test email',
      text: 'This is a test from Kindgleam. Email sending works, so sign-in links will arrive.'
    });
    res.json({ ...result, to: text(to) });
  }));
}
