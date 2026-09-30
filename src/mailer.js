/**
 * Outgoing email: the account the service sends from, and sending.
 *
 * A platform administrator sets the account (usually their own mailbox, over
 * SMTP) from Settings; it lives in one database row. The password is
 * encrypted with OBJECT_ENCRYPTION_KEY and never leaves this module: views
 * only say whether one is set.
 *
 * With no account set, development prints each message to the server log so
 * sign-in still works locally; production refuses to pretend it sent mail.
 */

import nodemailer from 'nodemailer';
import { encryptObject, decryptObject } from './object-crypto.js';
import { normalizeEmail } from './identity.js';

const text = value => String(value ?? '').trim();

// The key-derivation scope for the mail password. PostgreSQL text cannot hold
// NUL, so no workspace id can ever equal it and share its derived key.
const SECRET_SCOPE = '\u0000mail-settings';
const SECURITY = ['tls', 'starttls', 'none'];

export class MailError extends Error {
  constructor(message, { status = 400, code = 'mail' } = {}) {
    super(message);
    this.name = 'MailError';
    this.status = status;
    this.code = code;
    // Every mail error is something the admin or the person can act on.
    this.expose = true;
  }
}

function defaultTransport(settings) {
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.security === 'tls',
    requireTLS: settings.security === 'starttls',
    ignoreTLS: settings.security === 'none',
    auth: settings.username ? { user: settings.username, pass: settings.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000
  });
}

/**
 * Printing sign-in emails to the log is a local-development convenience only.
 * A server that has a real public address never does it, even if NODE_ENV
 * was left unset: anyone who can read its logs could sign in as anyone.
 */
function logFallbackAllowed(config) {
  if (config.production) return false;
  if (!config.publicUrl) return true;
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.publicUrl).hostname);
  } catch {
    return false;
  }
}

export class Mailer {
  constructor({ pool, config, logger, transportFactory = defaultTransport }) {
    this.pool = pool;
    this.config = config;
    this.logger = logger;
    // Tests swap this for an in-memory outbox.
    this.transportFactory = transportFactory;
  }

  async #row() {
    const { rows } = await this.pool.query('SELECT * FROM mail_settings WHERE id = $1', ['default']);
    return rows[0] ?? null;
  }

  #decrypt(value) {
    if (!value) return '';
    if (!this.config.security?.objectEncryptionKey) throw new MailError('The mail password cannot be read without OBJECT_ENCRYPTION_KEY', { status: 409, code: 'mail-key' });
    try {
      return decryptObject(this.config.security?.objectEncryptionKey, SECRET_SCOPE, Buffer.from(value, 'base64')).toString('utf8');
    } catch {
      // Authenticated encryption refused it: the key changed (rotation) or
      // the stored value was altered. Never send with a guess.
      throw new MailError('The saved mail password can no longer be read (was the encryption key changed?). Enter it again in Settings → Email sending.', { status: 409, code: 'mail-key' });
    }
  }

  /** What Settings shows: everything except the password itself. */
  async view() {
    const row = await this.#row();
    if (!row) return { configured: false, fallback: logFallbackAllowed(this.config) ? 'server-log' : 'none' };
    return {
      configured: true,
      host: row.host,
      port: row.port,
      security: row.security,
      username: row.username,
      passwordSet: Boolean(row.password_enc),
      fromName: row.from_name,
      fromEmail: row.from_email,
      updatedAt: row.updated_at
    };
  }

  /** Can this service deliver a sign-in link right now? */
  async canSend() {
    return Boolean(await this.#row()) || logFallbackAllowed(this.config);
  }

  /**
   * Save the sending account. An empty password keeps the stored one, so the
   * form never has to show it back.
   */
  async save(input, { principalId }) {
    const host = text(input?.host).toLowerCase();
    const port = Number(input?.port);
    const security = text(input?.security).toLowerCase();
    const username = text(input?.username);
    const fromEmail = normalizeEmail(input?.fromEmail || username);
    const fromName = text(input?.fromName).slice(0, 80) || 'Kindgleam';
    if (!/^[a-z0-9.-]+$/.test(host) || host.length > 253) throw new MailError('Enter the mail server name, for example smtp.gmail.com');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MailError('Enter a port between 1 and 65535');
    if (!SECURITY.includes(security)) throw new MailError('Choose SSL/TLS, STARTTLS or none');
    if (security === 'none' && this.config.production) throw new MailError('Sending mail without encryption is not allowed in production');
    if (!fromEmail) throw new MailError('Enter the email address mail is sent from');
    if (/[\r\n]/.test(fromName) || /[\r\n]/.test(username)) throw new MailError('Names cannot contain line breaks');

    const password = String(input?.password ?? '');
    let passwordEnc = null;
    if (password) {
      if (!this.config.security?.objectEncryptionKey) {
        throw new MailError('Set OBJECT_ENCRYPTION_KEY on the server before saving a mail password; it is never stored unencrypted', { status: 409, code: 'mail-key' });
      }
      passwordEnc = encryptObject(this.config.security?.objectEncryptionKey, SECRET_SCOPE, password).bytes.toString('base64');
    }
    await this.pool.query(
      `INSERT INTO mail_settings (id, host, port, security, username, password_enc, from_name, from_email, updated_by, updated_at)
       VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (id) DO UPDATE SET
         host = EXCLUDED.host, port = EXCLUDED.port, security = EXCLUDED.security,
         username = EXCLUDED.username,
         password_enc = CASE
           WHEN $5::text IS NOT NULL THEN EXCLUDED.password_enc
           WHEN EXCLUDED.username IS DISTINCT FROM mail_settings.username THEN NULL
           ELSE mail_settings.password_enc END,
         from_name = EXCLUDED.from_name, from_email = EXCLUDED.from_email,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [host, port, security, username, passwordEnc, fromName, fromEmail, principalId]
    );
    return this.view();
  }

  /** Send one message, or in development without an account, log it. */
  async send({ to, subject, text: body, html }) {
    const address = normalizeEmail(to);
    if (!address) throw new MailError('Enter a valid email address', { code: 'bad-email' });
    const row = await this.#row();
    if (!row) {
      if (!logFallbackAllowed(this.config)) throw new MailError('Email sending is not set up yet', { status: 409, code: 'mail-not-configured' });
      this.logger?.warn('mail not configured; message printed instead of sent (development only)', { to: address, subject, body });
      return { delivered: false, logged: true };
    }
    const settings = {
      host: row.host, port: row.port, security: row.security,
      username: row.username, password: this.#decrypt(row.password_enc)
    };
    const transport = this.transportFactory(settings);
    try {
      await transport.sendMail({
        from: { name: row.from_name, address: row.from_email },
        to: address, subject, text: body, html
      });
    } catch (error) {
      this.logger?.error('mail delivery failed', { error: error.message, code: error.code, responseCode: error.responseCode });
      const auth = error.code === 'EAUTH' || error.responseCode === 535;
      throw new MailError(auth
        ? 'The mail server refused the username or password'
        : 'The mail server could not be reached or refused the message', { status: 422, code: auth ? 'mail-auth' : 'mail-delivery' });
    }
    return { delivered: true };
  }
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The sign-in email: one clear button to the page with the code, the plain link, and what to do if it was not you. */
export function signInMessage({ link, minutes }) {
  const subject = 'Your Kindgleam sign-in link';
  const body = [
    'Open this link to get your Kindgleam sign-in code:',
    '',
    link,
    '',
    'Then enter the 8-digit code on the sign-in page.',
    `The link works for ${minutes} minutes.`,
    "If you didn't ask to sign in, you can ignore this email; nobody can sign in without it."
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7fb;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#15171c">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:460px;background:#ffffff;border-radius:16px;padding:32px" cellspacing="0" cellpadding="0">
<tr><td style="font-size:20px;font-weight:700;padding-bottom:12px">Sign in to Kindgleam</td></tr>
<tr><td style="font-size:15px;line-height:1.5;color:#4b5563;padding-bottom:24px">Open the link to see your 8-digit sign-in code, then enter it on the sign-in page. The link works for ${minutes} minutes.</td></tr>
<tr><td style="padding-bottom:24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#4338ca;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:10px">Get my sign-in code</a></td></tr>
<tr><td style="font-size:13px;line-height:1.5;color:#6b7280">If the button does not work, open this link:<br><a href="${escapeHtml(link)}" style="color:#4338ca;word-break:break-all">${escapeHtml(link)}</a></td></tr>
<tr><td style="font-size:13px;line-height:1.5;color:#6b7280;padding-top:18px">If you didn't ask to sign in, you can ignore this email; nobody can sign in without it.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text: body, html };
}
