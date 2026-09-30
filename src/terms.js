/**
 * Terms and age: each person confirms they are old enough and accepts the
 * terms and usage policy once per version, before they start a chat.
 */

export class TermsError extends Error {
  constructor(config) {
    super(`Before you start, please confirm you are ${config.terms.minimumAge} or older and accept the terms and usage policy.`);
    this.status = 403;
    this.code = 'terms-required';
    this.expose = true;
  }
}

export async function termsStatus(pool, config, principalId) {
  const { rows: [row] } = await pool.query(
    'SELECT accepted_at FROM terms_acceptances WHERE principal_id = $1 AND version = $2',
    [principalId, config.terms.version]
  );
  return {
    version: config.terms.version,
    minimumAge: config.terms.minimumAge,
    required: config.terms.required,
    accepted: Boolean(row) || !config.terms.required,
    acceptedAt: row?.accepted_at ?? null
  };
}

export async function acceptTerms(pool, config, principalId, { version, ageConfirmed, accept }) {
  if (version !== config.terms.version) return { error: 'These terms have changed. Reload and read the current version.', code: 'terms-version' };
  if (ageConfirmed !== true || accept !== true) return { error: `Please confirm you are ${config.terms.minimumAge} or older and accept the terms.`, code: 'terms-incomplete' };
  await pool.query(
    `INSERT INTO terms_acceptances (principal_id, version, age_confirmed) VALUES ($1, $2, true)
     ON CONFLICT (principal_id, version) DO NOTHING`,
    [principalId, config.terms.version]
  );
  return { accepted: true };
}

/** Throws TermsError unless this person accepted the current terms. */
export async function assertTermsAccepted(pool, config, principalId) {
  if (!config.terms?.required) return;
  const status = await termsStatus(pool, config, principalId);
  if (!status.accepted) throw new TermsError(config);
}
