/**
 * Application-level protection for private fields.
 *
 * The database remains tenant-isolated with PostgreSQL RLS, while especially
 * sensitive fields are encrypted before they reach PostgreSQL. Each purpose
 * derives a separate AES-256-GCM key from its deployment master key.
 */
import crypto from 'node:crypto';

const VERSION = 'v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Sensitive data encryption key must be exactly 32 bytes');
  }
}

function purposeKey(masterKey, purpose) {
  assertKey(masterKey);
  return crypto.createHmac('sha256', masterKey).update('kindgleam:' + String(purpose)).digest();
}

export function encryptField(masterKey, purpose, value) {
  assertKey(masterKey);
  const plaintext = Buffer.from(String(value ?? ''), 'utf8');
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', purposeKey(masterKey, purpose), nonce);
  cipher.setAAD(Buffer.from(String(purpose), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, nonce.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptField(masterKey, purpose, encoded) {
  assertKey(masterKey);
  const value = String(encoded ?? '');
  const [version, nonceText, tagText, ciphertextText] = value.split('.');
  if (version !== VERSION || !nonceText || !tagText || !ciphertextText) {
    throw new Error('Invalid encrypted field');
  }
  const nonce = Buffer.from(nonceText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  const ciphertext = Buffer.from(ciphertextText, 'base64url');
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new Error('Invalid encrypted field');
  const decipher = crypto.createDecipheriv('aes-256-gcm', purposeKey(masterKey, purpose), nonce);
  decipher.setAAD(Buffer.from(String(purpose), 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function encryptJson(masterKey, purpose, value) {
  return encryptField(masterKey, purpose, JSON.stringify(value ?? {}));
}

export function decryptJson(masterKey, purpose, encoded) {
  return JSON.parse(decryptField(masterKey, purpose, encoded));
}

/**
 * Deterministic lookup token for a normalized value. It is not reversible and
 * lets the application locate an encrypted record without a plaintext index.
 */
export function keyedDigest(masterKey, purpose, value) {
  assertKey(masterKey);
  return crypto.createHmac('sha256', purposeKey(masterKey, purpose))
    .update(String(value ?? ''), 'utf8')
    .digest('hex');
}


/** Move legacy plaintext private fields into encrypted columns. */
export function decryptFieldWithKeys(keys, purpose, encoded) {
  const candidates = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
  if (!candidates.length) throw new Error('No encryption key is configured');
  let lastError = null;
  for (let index = 0; index < candidates.length; index += 1) {
    try {
      return { value: decryptField(candidates[index], purpose, encoded), keyIndex: index };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error('Encrypted field could not be authenticated with the configured key set', { cause: lastError });
}

export function decryptJsonWithKeys(keys, purpose, encoded) {
  const result = decryptFieldWithKeys(keys, purpose, encoded);
  try {
    return { value: JSON.parse(result.value), keyIndex: result.keyIndex };
  } catch {
    throw new Error('Encrypted JSON field is malformed');
  }
}

const normalizeLookup = value =>
  String(value ?? '').toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, ' ').trim();

export async function backfillSensitiveData(pool, {
  billingKey = null,
  billingPreviousKey = null,
  personalDataKey = null,
  personalDataPreviousKey = null,
  logger = null
} = {}) {
  const billingKeys = [billingKey, billingPreviousKey].filter(Boolean);
  if (billingKeys.length) {
    for (;;) {
      const { rows } = await pool.query(
        `SELECT workspace_id, billing_email, company_name, tax_id, country, address,
                stripe_customer_id, stripe_subscription_id, billing_private_enc
           FROM workspace_billing
          WHERE billing_encryption_version <> 1
             OR billing_private_enc IS NULL
             OR billing_private_enc = ''
             OR billing_email <> ''
             OR company_name <> ''
             OR tax_id <> ''
             OR country <> ''
             OR address <> ''
             OR stripe_customer_id IS NOT NULL
             OR stripe_subscription_id IS NOT NULL
          ORDER BY workspace_id
          LIMIT 200`
      );
      if (!rows.length) break;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of rows) {
          let privateBilling = {};
          let keyIndex = 0;
          if (row.billing_private_enc) {
            const decoded = decryptJsonWithKeys(billingKeys, 'workspace-billing-v1', row.billing_private_enc);
            privateBilling = decoded.value && typeof decoded.value === 'object' ? decoded.value : {};
            keyIndex = decoded.keyIndex;
          }
          privateBilling = {
            billingEmail: row.billing_email !== '' ? String(row.billing_email ?? '') : String(privateBilling.billingEmail ?? ''),
            companyName: row.company_name !== '' ? String(row.company_name ?? '') : String(privateBilling.companyName ?? ''),
            taxId: row.tax_id !== '' ? String(row.tax_id ?? '') : String(privateBilling.taxId ?? ''),
            country: row.country !== '' ? String(row.country ?? '') : String(privateBilling.country ?? ''),
            address: row.address !== '' ? String(row.address ?? '') : String(privateBilling.address ?? ''),
            stripeCustomerId: row.stripe_customer_id ? String(row.stripe_customer_id) : (privateBilling.stripeCustomerId || null),
            stripeSubscriptionId: row.stripe_subscription_id ? String(row.stripe_subscription_id) : (privateBilling.stripeSubscriptionId || null),
            stripeLastEventCreated: Number.isFinite(Number(privateBilling.stripeLastEventCreated)) ? Number(privateBilling.stripeLastEventCreated) : 0,
            stripeLastEventId: privateBilling.stripeLastEventId ? String(privateBilling.stripeLastEventId) : null
          };
          if (keyIndex !== 0 || row.billing_encryption_version !== 1 || !row.billing_private_enc
              || row.billing_email !== '' || row.company_name !== '' || row.tax_id !== '' || row.country !== ''
              || row.address !== '' || row.stripe_customer_id !== null || row.stripe_subscription_id !== null) {
            await client.query(
              `UPDATE workspace_billing
                  SET billing_private_enc = $2,
                      billing_encryption_version = 1,
                      billing_email = '',
                      company_name = '',
                      tax_id = '',
                      country = '',
                      address = '',
                      stripe_customer_id = NULL,
                      stripe_subscription_id = NULL,
                      updated_at = now()
                WHERE workspace_id = $1`,
              [row.workspace_id, encryptJson(billingKey, 'workspace-billing-v1', privateBilling)]
            );
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      logger?.info('encrypted billing data batch', { count: rows.length });
    }
  }

  const personalKeys = [personalDataKey, personalDataPreviousKey].filter(Boolean);
  if (personalKeys.length) {
    for (;;) {
      const { rows } = await pool.query(
        `SELECT id, content, normalized, content_enc, normalized_digest, encryption_version
           FROM memories
          WHERE encryption_version <> 1
             OR content_enc IS NULL
             OR content_enc = ''
             OR normalized_digest IS NULL
             OR normalized_digest = ''
             OR content <> ''
             OR normalized <> ''
          ORDER BY id
          LIMIT 200`
      );
      if (!rows.length) break;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of rows) {
          let content = String(row.content ?? '');
          let normalized = String(row.normalized ?? '');
          let keyIndex = 0;
          if (row.content_enc) {
            const decoded = decryptFieldWithKeys(personalKeys, 'memory-content-v1', row.content_enc);
            keyIndex = decoded.keyIndex;
            try {
              const packed = JSON.parse(decoded.value);
              if (packed && typeof packed === 'object' && typeof packed.content === 'string') {
                content = packed.content;
                normalized = typeof packed.normalized === 'string' ? packed.normalized : normalizeLookup(content);
              } else {
                content = decoded.value;
                normalized = normalizeLookup(content);
              }
            } catch {
              content = decoded.value;
              normalized = normalizeLookup(content);
            }
          }
          if (!content) throw new Error(`Memory ${row.id} cannot be re-encrypted because its authenticated content is empty`);
          normalized = normalized || normalizeLookup(content);
          const digest = keyedDigest(personalDataKey, 'memory-lookup-v1', normalized);
          await client.query(
            `UPDATE memories
                SET content_enc = $2,
                    normalized_digest = $3,
                    encryption_version = 1,
                    content = '',
                    normalized = ''
              WHERE id = $1`,
            [row.id, encryptJson(personalDataKey, 'memory-content-v1', { content, normalized }), digest]
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      logger?.info('encrypted memory data batch', { count: rows.length });
    }
  }

  if (personalKeys.length) {
    for (;;) {
      const { rows } = await pool.query(
        `SELECT id, note, excerpt, note_enc, excerpt_enc, encryption_version
           FROM safety_reports
          WHERE encryption_version <> 1
             OR note_enc IS NULL
             OR note_enc = ''
             OR excerpt_enc IS NULL
             OR excerpt_enc = ''
             OR note <> ''
             OR excerpt <> ''
          ORDER BY id
          LIMIT 200`
      );
      if (!rows.length) break;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of rows) {
          const note = row.note !== '' ? String(row.note) : (row.note_enc
            ? decryptFieldWithKeys(personalKeys, 'safety-report-note-v1', row.note_enc).value
            : '');
          const excerpt = row.excerpt !== '' ? String(row.excerpt) : (row.excerpt_enc
            ? decryptFieldWithKeys(personalKeys, 'safety-report-excerpt-v1', row.excerpt_enc).value
            : '');
          await client.query(
            `UPDATE safety_reports
                SET note_enc = $2,
                    excerpt_enc = $3,
                    encryption_version = 1,
                    note = '',
                    excerpt = ''
              WHERE id = $1`,
            [
              row.id,
              encryptField(personalDataKey, 'safety-report-note-v1', note),
              encryptField(personalDataKey, 'safety-report-excerpt-v1', excerpt)
            ]
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      logger?.info('encrypted feedback data batch', { count: rows.length });
    }
  }
  if (personalKeys.length) {
    for (;;) {
      const { rows } = await pool.query(
        `SELECT key, principal_id, response, response_enc, encryption_version
           FROM idempotency_keys
          WHERE state = 'complete'
            AND (
              encryption_version <> 1
              OR response_enc IS NULL
              OR response_enc = ''
              OR response <> '{}'::jsonb
            )
          ORDER BY created_at
          LIMIT 200`
      );
      if (!rows.length) break;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of rows) {
          let response = row.response ?? {};
          if (row.response_enc) {
            response = decryptJsonWithKeys(personalKeys, 'idempotency-response-v1', row.response_enc).value;
          }
          await client.query(
            `UPDATE idempotency_keys
                SET response = '{}'::jsonb,
                    response_enc = $3,
                    encryption_version = 1
              WHERE key = $1 AND principal_id = $2`,
            [row.key, row.principal_id, encryptJson(personalDataKey, 'idempotency-response-v1', response)]
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      logger?.info('encrypted idempotency replay batch', { count: rows.length });
    }
  }

  if (personalKeys.length) {
    for (;;) {
      const { rows } = await pool.query(
        `SELECT id, detail, detail_enc, detail_encryption_version
           FROM audit_log
          WHERE detail_encryption_version <> 1
             OR (detail IS NOT NULL AND detail IS NOT NULL AND detail_enc IS NULL)
          ORDER BY id
          LIMIT 200`
      );
      if (!rows.length) break;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of rows) {
          const detail = row.detail_enc
            ? decryptJsonWithKeys(personalKeys, 'audit-detail-v1', row.detail_enc).value
            : (row.detail ?? null);
          await client.query(
            `UPDATE audit_log
                SET detail = NULL,
                    detail_enc = $2,
                    detail_encryption_version = 1
              WHERE id = $1`,
            [row.id, encryptJson(personalDataKey, 'audit-detail-v1', detail)]
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      logger?.info('encrypted audit detail batch', { count: rows.length });
    }
  }
}

export async function assertSensitiveDataEncrypted(pool) {
  const checks = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS count
         FROM workspace_billing
        WHERE billing_encryption_version <> 1
           OR billing_private_enc IS NULL
           OR billing_email <> ''
           OR company_name <> ''
           OR tax_id <> ''
           OR country <> ''
           OR address <> ''
           OR stripe_customer_id IS NOT NULL
           OR stripe_subscription_id IS NOT NULL`
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count
         FROM memories
        WHERE encryption_version <> 1
           OR content_enc IS NULL
           OR normalized_digest IS NULL
           OR content <> ''
           OR normalized <> ''`
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count
         FROM safety_reports
        WHERE encryption_version <> 1
           OR note_enc IS NULL
           OR excerpt_enc IS NULL
           OR note <> ''
           OR excerpt <> ''`
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count
         FROM idempotency_keys
        WHERE state = 'complete'
          AND (
            encryption_version <> 1
            OR response_enc IS NULL
            OR response_enc = ''
            OR response <> '{}'::jsonb
          )`
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count
         FROM audit_log
        WHERE detail_encryption_version <> 1
           OR detail IS NOT NULL
           OR (detail_enc IS NULL)`
    )
  ]);
  const billing = Number(checks[0].rows[0]?.count ?? 0);
  const memories = Number(checks[1].rows[0]?.count ?? 0);
  const feedback = Number(checks[2].rows[0]?.count ?? 0);
  const idempotency = Number(checks[3].rows[0]?.count ?? 0);
  const audit = Number(checks[4].rows[0]?.count ?? 0);
  if (billing || memories || feedback || idempotency || audit) {
    throw new Error('Sensitive application data is not fully encrypted: ' + JSON.stringify({ billing, memories, feedback, idempotency, audit }));
  }
  return { billing, memories, feedback, idempotency, audit };
}
