import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const text = value => String(value ?? '').trim();
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const METADATA_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
let cached = null;
const b64 = value => Buffer.from(value).toString('base64url');

function serviceAccountJwt(credentials, now = Math.floor(Date.now() / 1000)) {
  const email = text(credentials?.client_email);
  const key = text(credentials?.private_key).replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Vertex service-account credentials need client_email and private_key');
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ iss: email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const unsigned = head + '.' + body;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return unsigned + '.' + signer.sign(key, 'base64url');
}

async function serviceAccountToken(raw, fetchImpl) {
  let credentials;
  try { credentials = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON'); }
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: serviceAccountJwt(credentials)
    }).toString(),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error('Vertex OAuth token exchange failed (' + response.status + ')');
  const data = await response.json();
  if (!data.access_token) throw new Error('Vertex OAuth token exchange returned no access token');
  return { token: String(data.access_token), expiresAt: Date.now() + Math.max(30_000, Number(data.expires_in || 3600) * 1000 - 60_000) };
}

async function metadataToken(fetchImpl) {
  const response = await fetchImpl(METADATA_URL, {
    headers: { 'Metadata-Flavor': 'Google' },
    signal: AbortSignal.timeout(2_000)
  });
  if (!response.ok) throw new Error('Google Cloud metadata server returned ' + response.status);
  const data = await response.json();
  if (!data.access_token) throw new Error('Google Cloud metadata server returned no access token');
  return { token: String(data.access_token), expiresAt: Date.now() + Math.max(30_000, Number(data.expires_in || 3600) * 1000 - 60_000) };
}

export async function vertexAccessToken(config, { fetchImpl = globalThis.fetch } = {}) {
  const explicit = text(config?.ai?.vertexAccessToken);
  if (explicit) return explicit;
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const rawJson = text(config?.ai?.vertexServiceAccountJson);
  const credentialsPath = text(config?.ai?.vertexCredentialsPath);
  let issued;
  if (rawJson) issued = await serviceAccountToken(rawJson, fetchImpl);
  else if (credentialsPath) {
    let raw;
    try { raw = await readFile(credentialsPath, 'utf8'); }
    catch { throw new Error('GOOGLE_APPLICATION_CREDENTIALS could not be read'); }
    issued = await serviceAccountToken(raw, fetchImpl);
  } else issued = await metadataToken(fetchImpl);
  cached = issued;
  return issued.token;
}

export function resetVertexAuthCache() { cached = null; }
