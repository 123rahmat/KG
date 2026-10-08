/**
 * Principals, API keys, sessions, workspaces and roles.
 *
 * Every request that reaches a resource route carries a principal resolved
 * here. Scope is never taken from the request body: a caller states which
 * workspace it means, and this module decides whether that caller is a member
 * of it and with what role. Ownership is stamped from the authenticated
 * principal, so it cannot be forged.
 */

import crypto from 'node:crypto';
import { runDbScope, transaction } from './db.js';
import { syncWorkspaceAiEntitlements } from './account-entitlements.js';

/** Roles, least to most capable. A role implies every role below it. */
export const ROLES = Object.freeze(['viewer', 'editor', 'admin']);
const RANK = Object.freeze(Object.fromEntries(ROLES.map((role, index) => [role, index])));

export const KEY_PREFIX = 'kg';
// Keys issued under the earlier product name keep working.
const LEGACY_KEY_PREFIXES = ['pai'];
/**
 * Token separator. It must be outside the base64url alphabet
 * (A-Z a-z 0-9 - _), or a random id containing "_" splits into the wrong
 * number of parts and the key fails to parse — intermittently, for roughly
 * one key in three.
 */
const SEPARATOR = '.';

const text = value => String(value ?? '').trim();
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

/** Wrong sign-in code guesses allowed per address before its codes stop working. */
export const CODE_ATTEMPTS = 5;
// A code is salted with its link's id, so equal codes never share a hash.
const codeHash = (linkId, code) => sha256(`${linkId}:${code}`);
// 48 bits of a hash of the link's secret, as 8 digits (the modulo bias is
// under one in a million).
const codeFromToken = token => String(parseInt(sha256(`kindgleam-code:${token}`).slice(0, 12), 16) % 100_000_000).padStart(8, '0');

/** A lower-cased email address, or '' when it is not a plausible one. */
export function normalizeEmail(value) {
  const address = text(value).toLowerCase();
  return address.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) ? address : '';
}

/** Compare two hex digests without leaking their difference through timing. */
function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export class AuthError extends Error {
  constructor(message, { status = 401, code = 'unauthenticated' } = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Mint an API key.
 *
 * The returned token is `kg.<keyId>.<secret>`. Only the secret's SHA-256 is
 * stored, so a database dump cannot be replayed as credentials, and the token
 * is shown to the caller exactly once.
 */
export function mintKey() {
  const id = crypto.randomBytes(9).toString('base64url');
  const secret = crypto.randomBytes(32).toString('base64url');
  return {
    id, secret, secretHash: sha256(secret),
    token: [KEY_PREFIX, id, secret].join(SEPARATOR)
  };
}

export function parseKey(token) {
  const parts = text(token).split(SEPARATOR);
  if (parts.length !== 3 || ![KEY_PREFIX, ...LEGACY_KEY_PREFIXES].includes(parts[0])) return null;
  const [, id, secret] = parts;
  if (!id || !secret) return null;
  return { id, secret };
}

export class Identity {
  constructor(pool, { sessionHours = 12 } = {}) {
    this.pool = pool;
    this.sessionHours = sessionHours;
  }

  /* ------------------------------------------------------------ tenancy */

  async createOrganization({ id, name, type = 'personal' }) {
    const orgType = ['personal', 'enterprise'].includes(type) ? type : 'personal';
    const { rows } = await this.pool.query(
      `INSERT INTO organizations (id, name, type)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type
       RETURNING *`,
      [text(id) || crypto.randomUUID(), text(name) || 'Organization', orgType]
    );
    return rows[0];
  }

  async createWorkspace({ id, name, maxBytes, maxObjects, organizationId = null, organizationType = 'personal', jurisdiction = null }) {
    const workspaceId = text(id) || crypto.randomUUID();
    const workspaceName = text(name) || 'Workspace';
    const orgId = text(organizationId) || 'org-' + workspaceId;
    await this.createOrganization({ id: orgId, name: workspaceName, type: organizationType });
    const { rows } = await this.pool.query(
      `INSERT INTO workspaces (id, name, max_bytes, max_objects, organization_id, jurisdiction)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [workspaceId, workspaceName, maxBytes, maxObjects, orgId, text(jurisdiction) || null]
    );
    return rows[0];
  }

  async createPrincipal({ kind = 'user', name, email = null }) {
    const { rows } = await this.pool.query(
      `INSERT INTO principals (id, kind, name, email) VALUES ($1, $2, $3, $4) RETURNING *`,
      [crypto.randomUUID(), kind, text(name) || 'Unnamed', email ? text(email).toLowerCase() : null]
    );
    return rows[0];
  }

  async addMember({ workspaceId, principalId, role }) {
    if (!ROLES.includes(role)) throw new AuthError(`Unknown role "${role}"`, { status: 400, code: 'bad-role' });
    const { rows } = await this.pool.query(
      `INSERT INTO memberships (workspace_id, principal_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, principal_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING *`,
      [workspaceId, principalId, role]
    );
    await syncWorkspaceAiEntitlements(this.pool, workspaceId);
    return rows[0];
  }

  /* --------------------------------------------------------------- keys */

  async issueKey({ principalId, name = 'api key', expiresAt = null }) {
    const key = mintKey();
    await this.pool.query(
      `INSERT INTO api_keys (id, principal_id, secret_hash, name, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [key.id, principalId, key.secretHash, text(name), expiresAt]
    );
    // The only moment the plaintext token exists outside the caller's hands.
    return { id: key.id, token: key.token, name: text(name), expiresAt };
  }

  async revokeKey(keyId) {
    return transaction(this.pool, async client => {
      const { rowCount } = await client.query(
        `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
        [keyId]
      );
      await client.query(
        `UPDATE sessions SET revoked_at = now() WHERE api_key_id = $1 AND revoked_at IS NULL`,
        [keyId]
      );
      return rowCount > 0;
    });
  }

  /** Resolve an API key token to a principal, or throw AuthError. */
  async principalFromKey(token) {
    const parsed = parseKey(token);
    if (!parsed) throw new AuthError('Malformed API key');

    const { rows } = await this.pool.query(
      `SELECT k.id, k.secret_hash, k.revoked_at, k.expires_at,
              p.id AS principal_id, p.kind, p.name, p.email, p.disabled_at, p.platform_admin
         FROM api_keys k JOIN principals p ON p.id = k.principal_id
        WHERE k.id = $1`,
      [parsed.id]
    );
    const row = rows[0];

    // Hash the presented secret even when the key id is unknown, so a valid
    // id is not distinguishable from an invalid one by how long we take.
    const presented = sha256(parsed.secret);
    if (!row || !constantTimeEqual(presented, row.secret_hash)) {
      throw new AuthError('Invalid API key');
    }
    if (row.revoked_at) throw new AuthError('API key has been revoked');
    if (row.expires_at && row.expires_at <= new Date()) throw new AuthError('API key has expired');
    if (row.disabled_at) throw new AuthError('Principal is disabled');

    // Best-effort usage stamp; never fail a request because it did not write.
    this.pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => {});

    return { id: row.principal_id, kind: row.kind, name: row.name, email: row.email, platformAdmin: row.platform_admin === true, via: 'api-key', keyId: row.id };
  }

  /* ----------------------------------------------------------- sessions */

  /**
   * Exchange an API key for a browser session.
   *
   * The session id is returned raw to be set as an httpOnly cookie; only its
   * hash is stored, so the sessions table is not a set of usable credentials.
   */
  async startSession(principalId, { keyId = null } = {}) {
    const secret = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.sessionHours * 3_600_000);
    await this.pool.query(
      `INSERT INTO sessions (id, principal_id, expires_at, api_key_id) VALUES ($1, $2, $3, $4)`,
      [sha256(secret), principalId, expiresAt, keyId]
    );
    return { secret, expiresAt };
  }

  async principalFromSession(secret) {
    if (!text(secret)) throw new AuthError('No session');
    const { rows } = await this.pool.query(
      `SELECT s.expires_at, s.revoked_at, p.id, p.kind, p.name, p.email, p.disabled_at, p.platform_admin,
              s.api_key_id, k.revoked_at AS key_revoked_at, k.expires_at AS key_expires_at
         FROM sessions s
         JOIN principals p ON p.id = s.principal_id
         LEFT JOIN api_keys k ON k.id = s.api_key_id
        WHERE s.id = $1`,
      [sha256(text(secret))]
    );
    const row = rows[0];
    if (!row) throw new AuthError('Invalid session');
    if (row.revoked_at) throw new AuthError('Session has been revoked');
    if (row.expires_at <= new Date()) throw new AuthError('Session has expired');
    if (row.key_revoked_at) throw new AuthError('Session has been revoked');
    if (row.key_expires_at && row.key_expires_at <= new Date()) throw new AuthError('Session has expired');
    if (row.disabled_at) throw new AuthError('Principal is disabled');
    return { id: row.id, kind: row.kind, name: row.name, email: row.email, platformAdmin: row.platform_admin === true, via: 'session' };
  }

  /* ------------------------------------------------------ email links */

  /**
   * Mint a one-time sign-in link token for an email address.
   *
   * Like keys and sessions, only the token's SHA-256 is stored. The token is
   * handed back once, to be put in the email and nowhere else.
   */
  async issueLoginLink(email, { minutes = 15, ip = null } = {}) {
    const address = normalizeEmail(email);
    if (!address) throw new AuthError('Enter a valid email address', { status: 400, code: 'bad-email' });
    const token = crypto.randomBytes(32).toString('base64url');
    // Opening the link shows an 8-digit code, typed on the device that asked
    // to sign in. It is derived from the link's secret, so it is never stored
    // and only someone holding the link can see it.
    const code = codeFromToken(token);
    const id = sha256(token);
    const expiresAt = new Date(Date.now() + minutes * 60_000);
    await this.pool.query(
      'INSERT INTO login_links (id, email, expires_at, ip, code_hash) VALUES ($1, $2, $3, $4, $5)',
      [id, address, expiresAt, ip ? String(ip).slice(0, 64) : null, codeHash(id, code)]
    );
    return { token, code, email: address, expiresAt };
  }

  /** How many links one network address asked for recently (sign-up abuse guard). */
  async recentLoginLinksFromIp(ip, { minutes = 60 } = {}) {
    if (!text(ip)) return 0;
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n FROM login_links WHERE ip = $1 AND created_at > now() - ($2 || ' minutes')::interval`,
      [String(ip).slice(0, 64), String(minutes)]
    );
    return rows[0]?.n ?? 0;
  }

  /** How many links were sent to this address recently (mail-bombing guard). */
  async recentLoginLinks(email, { minutes = 15 } = {}) {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n FROM login_links WHERE email = $1 AND created_at > now() - ($2 || ' minutes')::interval`,
      [normalizeEmail(email), String(minutes)]
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * Spend a sign-in link: it works once, only before it expires. The update
   * is one statement, so two tabs racing the same link cannot both win.
   */
  async redeemLoginLink(token) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(text(token))) throw new AuthError('This sign-in link is not valid', { code: 'bad-link' });
    const { rows } = await this.pool.query(
      `UPDATE login_links SET used_at = now()
        WHERE id = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING email`,
      [sha256(text(token))]
    );
    if (!rows[0]) throw new AuthError('This sign-in link has expired or was already used. Ask for a new one.', { code: 'bad-link' });
    return rows[0].email;
  }

  /**
   * Show the code for a link that is still live, without spending it: the
   * link page displays it so it can be typed on the device signing in.
   */
  async loginCodeForLink(token) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(text(token))) throw new AuthError('This sign-in link is not valid', { code: 'bad-link' });
    const { rows } = await this.pool.query(
      `SELECT email, expires_at FROM login_links
        WHERE id = $1 AND used_at IS NULL AND expires_at > now() AND attempts < $2`,
      [sha256(text(token)), CODE_ATTEMPTS]
    );
    if (!rows[0]) throw new AuthError('This sign-in link has expired or was already used. Ask for a new one.', { code: 'bad-link' });
    return { code: codeFromToken(text(token)), email: rows[0].email, expiresAt: rows[0].expires_at };
  }

  /**
   * Spend a sign-in code typed by hand. It matches any of the address's live
   * links (the person may have opened an earlier email's link). Every wrong
   * guess counts against all of them, and after CODE_ATTEMPTS wrong guesses
   * they stop working, so 8 digits cannot be guessed in the time they live.
   */
  async redeemLoginCode(email, code) {
    const address = normalizeEmail(email);
    const digits = text(code).replace(/[\s-]/g, '');
    const refused = () => new AuthError('That code is not right, or it has expired. Check the email or ask for a new one.', { code: 'bad-code' });
    if (!address || !/^\d{8}$/.test(digits)) throw refused();
    // The wrong-guess count must be committed before refusing, so the
    // transaction returns the outcome and the refusal is thrown after it.
    const redeemed = await transaction(this.pool, async client => {
      const { rows } = await client.query(
        `SELECT id, code_hash, attempts FROM login_links
          WHERE email = $1 AND used_at IS NULL AND expires_at > now() AND code_hash IS NOT NULL
          ORDER BY created_at DESC FOR UPDATE`,
        [address]
      );
      const live = rows.filter(row => row.attempts < CODE_ATTEMPTS);
      const match = live.find(row => constantTimeEqual(codeHash(row.id, digits), row.code_hash));
      if (!match) {
        if (rows.length) {
          // One more wrong guess for every live link; at the limit they die.
          await client.query(
            `UPDATE login_links SET attempts = attempts + 1,
                    used_at = CASE WHEN attempts + 1 >= $2 THEN now() ELSE used_at END
              WHERE email = $1 AND used_at IS NULL AND expires_at > now()`,
            [address, CODE_ATTEMPTS]
          );
        }
        return null;
      }
      await client.query('UPDATE login_links SET used_at = now() WHERE id = $1', [match.id]);
      return address;
    });
    if (!redeemed) throw refused();
    return redeemed;
  }

  /**
   * The person an email address belongs to. With sign-up allowed, a new
   * address gets an account and a personal workspace in the same step.
   */
  async principalForEmail(email, { signUp = false, maxBytes = 0, maxObjects = 0 } = {}) {
    const address = normalizeEmail(email);
    if (!address) throw new AuthError('Enter a valid email address', { status: 400, code: 'bad-email' });
    let id = (await this.pool.query('SELECT id FROM principals WHERE email = $1', [address])).rows[0]?.id;
    if (!id) {
      if (!signUp) throw new AuthError('There is no account for this email address', { code: 'no-account' });
      id = (await this.pool.query('SELECT kg_sign_up($1, $2, $3, $4) AS id', [address, '', maxBytes, maxObjects])).rows[0].id;
    }
    const { rows } = await this.pool.query(
      'SELECT id, kind, name, email, disabled_at, platform_admin FROM principals WHERE id = $1', [id]
    );
    const row = rows[0];
    if (!row) throw new AuthError('There is no account for this email address', { code: 'no-account' });
    if (row.disabled_at) throw new AuthError('Principal is disabled');
    if (row.kind !== 'user') throw new AuthError('Service accounts sign in with an API key', { code: 'service-account' });
    return { id: row.id, kind: row.kind, name: row.name, email: row.email, platformAdmin: row.platform_admin === true, via: 'email' };
  }

  async endSession(secret) {
    if (!text(secret)) return false;
    const { rowCount } = await this.pool.query(
      `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [sha256(text(secret))]
    );
    return rowCount > 0;
  }

  /** This person's signed-in browser sessions that are still valid, newest first. */
  async listSessions(principalId, currentSecret) {
    const current = text(currentSecret) ? sha256(text(currentSecret)) : '';
    const { rows } = await this.pool.query(
      `SELECT id, created_at, expires_at FROM sessions
        WHERE principal_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 50`,
      [principalId]
    );
    // The stored id is a hash of the secret; a short prefix names it without
    // exposing anything usable.
    return rows.map(row => ({
      id: row.id.slice(0, 12), createdAt: row.created_at, expiresAt: row.expires_at, current: row.id === current
    }));
  }

  /** Sign out every other browser session of this person; the current one stays. */
  async revokeOtherSessions(principalId, currentSecret) {
    const current = text(currentSecret) ? sha256(text(currentSecret)) : '';
    const { rowCount } = await this.pool.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE principal_id = $1 AND revoked_at IS NULL AND id <> $2`,
      [principalId, current]
    );
    return rowCount;
  }

  /** Delete sessions and idempotency records that are past their usefulness. */
  async purgeExpired({ idempotencyDays = 1 } = {}) {
    return runDbScope({
      principalId: '',
      workspaceId: '',
      organizationId: '',
      jurisdiction: '',
      role: 'maintenance'
    }, () => transaction(this.pool, async client => {
      const sessions = await client.query('DELETE FROM sessions WHERE expires_at < now()');
      await client.query(`DELETE FROM login_links WHERE expires_at < now() - interval '1 day'`);
      const keys = await client.query(
        `DELETE FROM idempotency_keys WHERE created_at < now() - ($1 || ' days')::interval`,
        [String(idempotencyDays)]
      );
      return { sessions: sessions.rowCount, idempotencyKeys: keys.rowCount };
    }));
  }

  /* -------------------------------------------------------------- scope */

  async workspacesFor(principalId) {
    const { rows } = await this.pool.query(
      `SELECT w.id, w.name, w.max_bytes, w.max_objects, w.jurisdiction,
              w.organization_id, o.name AS organization_name, o.type AS organization_type, m.role,
              CASE WHEN a.principal_id IS NOT NULL THEN 'admin' ELSE NULL END AS organization_role
         FROM memberships m
         JOIN workspaces w ON w.id = m.workspace_id
         LEFT JOIN organizations o ON o.id = w.organization_id
         LEFT JOIN organization_admins a ON a.organization_id = w.organization_id AND a.principal_id = m.principal_id
        WHERE m.principal_id = $1 AND w.archived_at IS NULL
        ORDER BY w.name`,
      [principalId]
    );
    return rows;
  }

  /**
   * Authorize a principal for one workspace at one role, or throw.
   *
   * A non-member gets 404, not 403: confirming that a workspace exists is
   * itself information a stranger should not be able to probe for.
   */
  async requireAccess(principal, workspaceId, needed = 'viewer') {
    const id = text(workspaceId);
    if (!id) throw new AuthError('workspaceId is required', { status: 400, code: 'workspace-required' });

    const { rows } = await this.pool.query(
      `SELECT m.role, w.max_bytes, w.max_objects, w.name, w.jurisdiction,
              w.organization_id, o.name AS organization_name, o.type AS organization_type,
              CASE WHEN a.principal_id IS NOT NULL THEN 'admin' ELSE NULL END AS organization_role
         FROM memberships m
         JOIN workspaces w ON w.id = m.workspace_id
         LEFT JOIN organizations o ON o.id = w.organization_id
         LEFT JOIN organization_admins a ON a.organization_id = w.organization_id AND a.principal_id = m.principal_id
        WHERE m.principal_id = $1 AND m.workspace_id = $2 AND w.archived_at IS NULL`,
      [principal.id, id]
    );
    const row = rows[0];
    if (!row) throw new AuthError('Workspace not found', { status: 404, code: 'no-workspace' });

    if (!ROLES.includes(row.role) || !ROLES.includes(needed) || RANK[row.role] < RANK[needed]) {
      throw new AuthError(`This action requires the "${needed}" role; you have "${row.role}"`, {
        status: 403,
        code: 'insufficient-role'
      });
    }
    return {
      workspaceId: id,
      name: row.name,
      role: row.role,
      maxBytes: row.max_bytes,
      maxObjects: row.max_objects,
      jurisdiction: row.jurisdiction,
      organizationId: row.organization_id,
      organizationName: row.organization_name,
      organizationType: row.organization_type || 'personal',
      organizationRole: row.organization_role ?? null
    };
  }
}

export { sha256 };
