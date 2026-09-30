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
export async function backfillSensitiveData(pool, { billingKey = null, personalDataKey = null, logger = null } = {}) {
  if (billingKey) {
    for (;;) {
      const { rows } = await pool.query(
        `SELECT workspace_id, billing_email, company_name, tax_id, country, address,
                stripe_customer_id, stripe_subscription_id
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
          const privateData = {
            billingEmail: String(row.billing_email ?? ''),
            companyName: String(row.company_name ?? ''),
            taxId: String(row.tax_id ?? ''),
            country: String(row.country ?? ''),
            address: String(row.address ?? ''),
            stripeCustomerId: row.stripe_customer_id ? String(row.stripe_customer_id) : null,
            stripeSubscriptionId: row.stripe_subscription_id ? String(row.stripe_subscription_id) : null
          };
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
              WHERE workspace_id = $1
                AND (billing_encryption_version = 0 OR billing_private_enc IS NULL)`,
            [row.workspace_id, encryptJson(billingKey, 'workspace-billing-v1', privateData)]
          );
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

  if (personalDataKey) {
    for (;;) {
      const { rows } = await pool.query(
        `SELECT id, content, normalized
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
          await client.query(
            `UPDATE memories
                SET content_enc = $2,
                    normalized_digest = $3,
                    encryption_version = 1,
                    content = '',
                    normalized = ''
              WHERE id = $1
                AND (encryption_version = 0 OR content_enc IS NULL OR normalized_digest IS NULL)`,
            [
              row.id,
              encryptField(personalDataKey, 'memory-content-v1', row.content),
              keyedDigest(personalDataKey, 'memory-lookup-v1', row.normalized)
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
      logger?.info('encrypted memory data batch', { count: rows.length });
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
    )
  ]);
  const billing = Number(checks[0].rows[0]?.count ?? 0);
  const memories = Number(checks[1].rows[0]?.count ?? 0);
  if (billing || memories) {
    throw new Error('Sensitive application data is not fully encrypted: ' + JSON.stringify({ billing, memories }));
  }
  return { billing, memories };
}
