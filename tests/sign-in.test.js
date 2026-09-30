import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from './helpers.js';
import { Mailer } from '../src/mailer.js';

/** Swap the mail transport for an in-memory outbox. */
function captureMail(app) {
  const outbox = [];
  const logins = [];
  app.locals.mailer.transportFactory = settings => {
    logins.push(settings);
    return { sendMail: async message => { outbox.push(message); } };
  };
  return { outbox, logins };
}

const tokenFrom = message => new URL(message.text.match(/https?:\/\/\S+/)[0]).searchParams.get('signin');
const cookieFrom = response => response.headers.get('set-cookie')?.split(';')[0] ?? '';

async function makePlatformAdmin(pool, principalId) {
  await pool.query('UPDATE principals SET platform_admin = true WHERE id = $1', [principalId]);
}

const MAIL = { host: 'smtp.example.com', port: 587, security: 'starttls', username: 'owner@example.com', password: 'app-password-123', fromName: 'Kindgleam' };

test('email sign-in: a link signs up a new person once, with their own workspace', () =>
  withServer(async ({ app, call, seed, pool }) => {
    const admin = await seed({ workspace: 'ops' });
    await makePlatformAdmin(pool, admin.principal.id);
    const { outbox, logins } = captureMail(app);

    const saved = await call('PUT', '/api/admin/mail', { token: admin.token, body: MAIL });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.mail.passwordSet, true);
    assert.equal(JSON.stringify(saved.body).includes(MAIL.password), false, 'the password is never sent back');
    const stored = (await pool.query('SELECT password_enc FROM mail_settings')).rows[0].password_enc;
    assert.ok(stored && !stored.includes(MAIL.password), 'the password is stored encrypted');

    const options = await call('GET', '/api/sign-in/options');
    assert.deepEqual(options.body, { email: true, signUp: true, accessKey: true });

    const sent = await call('POST', '/api/sign-in/email', { body: { email: '  New.Person@Example.com ' } });
    assert.equal(sent.status, 202);
    assert.equal(sent.body.email, 'new.person@example.com');
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].to, 'new.person@example.com');
    assert.equal(logins[0].password, MAIL.password, 'the stored password decrypts for sending');
    const token = tokenFrom(outbox[0]);
    assert.ok(token);
    const linkRow = (await pool.query('SELECT id FROM login_links')).rows[0];
    assert.notEqual(linkRow.id, token, 'only a hash of the link is stored');

    assert.equal((await call('POST', '/api/sign-in/email/verify', { body: { token: 'x'.repeat(43) } })).status, 401);

    const verified = await call('POST', '/api/sign-in/email/verify', { body: { token } });
    assert.equal(verified.status, 200);
    const cookie = cookieFrom(verified);
    assert.match(cookie, /=/);
    const me = await call('GET', '/api/me', { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.equal(me.body.principal.email, 'new.person@example.com');
    assert.equal(me.body.principal.platformAdmin, false, 'signing up never grants platform admin');
    assert.equal(me.body.workspaces.length, 1);
    assert.equal(me.body.workspaces[0].role, 'admin');

    const again = await call('POST', '/api/sign-in/email/verify', { body: { token } });
    assert.equal(again.status, 401, 'a link works once');

    // A second link for the same address signs into the same account.
    await call('POST', '/api/sign-in/email', { body: { email: 'new.person@example.com' } });
    const second = await call('POST', '/api/sign-in/email/verify', { body: { token: tokenFrom(outbox[1]) } });
    assert.equal(second.body.principal.id, me.body.principal.id);
    const workspaces = await pool.query('SELECT count(*)::int AS n FROM memberships WHERE principal_id = $1', [me.body.principal.id]);
    assert.equal(workspaces.rows[0].n, 1);

    // The new person cannot touch the mail account.
    assert.equal((await call('GET', '/api/admin/mail', { headers: { cookie } })).status, 403);
  }));

test('email sign-in: links expire, and one address cannot be flooded', () =>
  withServer(async ({ app, call, seed, pool }) => {
    const admin = await seed({ workspace: 'ops' });
    await makePlatformAdmin(pool, admin.principal.id);
    const { outbox } = captureMail(app);
    await call('PUT', '/api/admin/mail', { token: admin.token, body: MAIL });

    for (let i = 0; i < 5; i += 1) {
      const response = await call('POST', '/api/sign-in/email', { body: { email: 'target@example.com' } });
      assert.equal(response.status, 202, 'the answer never changes');
    }
    assert.equal(outbox.length, 3, 'at most three links per address per 15 minutes');

    await pool.query(`UPDATE login_links SET expires_at = now() - interval '1 minute'`);
    const expired = await call('POST', '/api/sign-in/email/verify', { body: { token: tokenFrom(outbox[0]) } });
    assert.equal(expired.status, 401);
    assert.match(expired.body.error, /expired/);

    assert.equal((await call('POST', '/api/sign-in/email', { body: { email: 'not-an-email' } })).status, 400);
  }));

test('email sign-in: with sign-up off, only existing accounts get a link', () =>
  withServer(async ({ app, call, seed, pool }) => {
    const admin = await seed({ workspace: 'ops' });
    await makePlatformAdmin(pool, admin.principal.id);
    await pool.query(`UPDATE principals SET email = 'member@example.com' WHERE id = $1`, [admin.principal.id]);
    const { outbox } = captureMail(app);
    await call('PUT', '/api/admin/mail', { token: admin.token, body: MAIL });

    assert.equal((await call('POST', '/api/sign-in/email', { body: { email: 'stranger@example.com' } })).status, 202);
    // With sign-up off the answer comes before the email is sent, so its
    // timing reveals nothing; wait for delivery before looking.
    const settle = async count => { for (let i = 0; i < 50 && outbox.length < count; i += 1) await new Promise(r => setTimeout(r, 20)); };
    await settle(1);
    assert.equal(outbox.length, 0, 'strangers get the same answer and no email');
    await call('POST', '/api/sign-in/email', { body: { email: 'member@example.com' } });
    await settle(1);
    assert.equal(outbox.length, 1);
    const verified = await call('POST', '/api/sign-in/email/verify', { body: { token: tokenFrom(outbox[0]) } });
    assert.equal(verified.body.principal.id, admin.principal.id);
  }, { env: { ALLOW_SIGNUP: 'false' } }));

test('mail settings: only platform admins, a kept password, and a clear delivery error', () =>
  withServer(async ({ app, call, seed, pool }) => {
    const admin = await seed({ workspace: 'ops' });
    const member = await seed({ workspace: 'ops', role: 'admin', name: 'Workspace admin' });
    await makePlatformAdmin(pool, admin.principal.id);

    assert.equal((await call('PUT', '/api/admin/mail', { token: member.token, body: MAIL })).status, 403, 'a workspace admin is not a platform admin');
    assert.equal((await call('PUT', '/api/admin/mail', { token: admin.token, body: { ...MAIL, host: 'bad host!' } })).status, 400);

    await call('PUT', '/api/admin/mail', { token: admin.token, body: MAIL });
    const kept = await call('PUT', '/api/admin/mail', { token: admin.token, body: { ...MAIL, password: '', fromName: 'Kindgleam Team' } });
    assert.equal(kept.body.mail.passwordSet, true, 'an empty password keeps the stored one');
    assert.equal(kept.body.mail.fromName, 'Kindgleam Team');

    app.locals.mailer.transportFactory = () => ({ sendMail: async () => { const error = new Error('Invalid login'); error.code = 'EAUTH'; throw error; } });
    const failed = await call('POST', '/api/admin/mail/test', { token: admin.token, body: { to: 'owner@example.com' } });
    assert.equal(failed.status, 422);
    assert.match(failed.body.error, /username or password/);
  }));

test('mailer: production never pretends to send without an account', async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const mailer = new Mailer({ pool, config: { production: true }, logger: null });
  assert.equal(await mailer.canSend(), false);
  await assert.rejects(() => mailer.send({ to: 'a@example.com', subject: 's', text: 't' }), /not set up/);
  const dev = new Mailer({ pool, config: { production: false }, logger: { warn() {} } });
  assert.equal(await dev.canSend(), true);
  assert.deepEqual(await dev.send({ to: 'a@example.com', subject: 's', text: 't' }), { delivered: false, logged: true });
  // NODE_ENV left unset on a real server: links are never written to logs.
  const deployed = new Mailer({ pool, config: { production: false, publicUrl: 'https://app.example.com' }, logger: { warn() { throw new Error('logged a sign-in email'); } } });
  assert.equal(await deployed.canSend(), false);
  await assert.rejects(() => deployed.send({ to: 'a@example.com', subject: 's', text: 't' }), /not set up/);
});

/** Open the email's link the way the page does, and read the code it shows. */
async function codeFrom(call, message) {
  const shown = await call('POST', '/api/sign-in/email/link-code', { body: { token: tokenFrom(message) } });
  assert.equal(shown.status, 200);
  return `${shown.body.code.slice(0, 4)} ${shown.body.code.slice(4)}`;
}

test('email sign-in: the link shows an 8-digit code that signs in, once', () =>
  withServer(async ({ app, call, seed, pool }) => {
    const admin = await seed({ workspace: 'ops' });
    await makePlatformAdmin(pool, admin.principal.id);
    const { outbox } = captureMail(app);
    await call('PUT', '/api/admin/mail', { token: admin.token, body: MAIL });

    await call('POST', '/api/sign-in/email', { body: { email: 'coder@example.com' } });
    assert.doesNotMatch(outbox[0].text, /\d{4} ?\d{4}/, 'the code is not in the email; the link shows it');
    const code = await codeFrom(call, outbox[0]);
    assert.match(code, /^\d{4} \d{4}$/);
    assert.equal(await codeFrom(call, outbox[0]), code, 'showing the code does not spend the link');
    const row = (await pool.query('SELECT code_hash FROM login_links')).rows[0];
    assert.ok(row.code_hash && !row.code_hash.includes(code.replace(' ', '')), 'only a hash of the code is stored');

    const signedIn = await call('POST', '/api/sign-in/email/code', { body: { email: 'Coder@Example.com', code } });
    assert.equal(signedIn.status, 200, 'spaces and letter case do not matter');
    assert.match(cookieFrom(signedIn), /=/);
    assert.equal((await call('POST', '/api/sign-in/email/code', { body: { email: 'coder@example.com', code } })).status, 401, 'a code works once');

    // The link that showed it was spent with it.
    assert.equal((await call('POST', '/api/sign-in/email/link-code', { body: { token: tokenFrom(outbox[0]) } })).status, 401);
    assert.equal((await call('POST', '/api/sign-in/email/verify', { body: { token: tokenFrom(outbox[0]) } })).status, 401);
    assert.equal((await call('POST', '/api/sign-in/email/link-code', { body: { token: 'x'.repeat(43) } })).status, 401);
  }));

test('email sign-in: five wrong codes and the codes stop working', () =>
  withServer(async ({ app, call, seed, pool }) => {
    const admin = await seed({ workspace: 'ops' });
    await makePlatformAdmin(pool, admin.principal.id);
    const { outbox } = captureMail(app);
    await call('PUT', '/api/admin/mail', { token: admin.token, body: MAIL });

    await call('POST', '/api/sign-in/email', { body: { email: 'target@example.com' } });
    const code = (await codeFrom(call, outbox[0])).replace(' ', '');
    const wrong = String((Number(code) + 1) % 100_000_000).padStart(8, '0');
    assert.equal((await call('POST', '/api/sign-in/email/code', { body: { email: 'target@example.com', code: '1234' } })).status, 401, 'too short');
    for (let i = 0; i < 5; i += 1) {
      const response = await call('POST', '/api/sign-in/email/code', { body: { email: 'target@example.com', code: wrong } });
      assert.equal(response.status, 401);
    }
    const right = await call('POST', '/api/sign-in/email/code', { body: { email: 'target@example.com', code } });
    assert.equal(right.status, 401, 'after five wrong guesses even the right code is refused');
    assert.equal((await call('POST', '/api/sign-in/email/code', { body: { email: 'nobody@example.com', code } })).status, 401);
  }));

test('email sign-in: one network address cannot mass-create accounts', () =>
  withServer(async ({ app, call, seed, pool }) => {
    const admin = await seed({ workspace: 'ops' });
    await makePlatformAdmin(pool, admin.principal.id);
    const { outbox } = captureMail(app);
    await call('PUT', '/api/admin/mail', { token: admin.token, body: MAIL });
    // Twenty links asked for from this address in the last hour.
    for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) {
      await pool.query(
        `INSERT INTO login_links (id, email, expires_at, ip)
         SELECT md5(random()::text || g::text || $1), 'bot' || g || '@example.com', now() + interval '15 minutes', $1
           FROM generate_series(1, 20) g`, [ip]);
    }
    const blocked = await call('POST', '/api/sign-in/email', { body: { email: 'bot21@example.com' } });
    assert.equal(blocked.status, 429);
    assert.equal(outbox.length, 0);
  }));

test('over HTTPS the session cookie is __Host- prefixed and Secure', () =>
  withServer(async ({ call, seed }) => {
    const user = await seed({ workspace: 'ops' });
    const response = await call('POST', '/api/session', { body: { apiKey: user.token } });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /^__Host-kg_session=/);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Strict/);
    assert.match(cookie, /; Path=\//);
    assert.doesNotMatch(cookie, /Domain=/i);
  }, { env: { COOKIE_SECURE: 'true' } }));

test('without PUBLIC_URL a forged Host header never makes a sign-in link', () =>
  withServer(async ({ app, base, seed, pool }) => {
    const admin = await seed({ workspace: 'ops' });
    await makePlatformAdmin(pool, admin.principal.id);
    const { outbox } = captureMail(app);
    const put = await fetch(base + '/api/admin/mail', { method: 'PUT', headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }, body: JSON.stringify(MAIL) });
    assert.equal(put.status, 200);
    // fetch will not send a custom Host, so the forged request is made by hand.
    const { request } = await import('node:http');
    const status = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ email: 'victim@example.com' });
      const req = request(base + '/api/sign-in/email', {
        method: 'POST', headers: { host: 'attacker.example', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
      }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(status, 409, 'no link is built from a Host the sender chose');
    assert.equal(outbox.length, 0);
    const local = await fetch(base + '/api/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'dev@example.com' }) });
    assert.equal(local.status, 202, 'a local development server still works');
  }));
