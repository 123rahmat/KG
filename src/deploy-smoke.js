/**
 * Post-deploy smoke check against a running deployment.
 *
 * Non-destructive: it reads health and readiness, checks the security
 * boundary, and — only when a key is given — signs in with a bearer key and
 * previews a plan, which creates and executes nothing. It never prints the
 * key or response bodies beyond the fields it checks.
 */

const text = value => String(value ?? '').trim();

export async function runDeploySmoke({ baseUrl, apiKey = '', workspace = '', fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const base = text(baseUrl).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('A base URL such as https://ai.example.com is required');
  const secure = base.startsWith('https://');
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail: text(detail) });

  const request = async (path, { method = 'GET', headers = {}, body } = {}) => {
    const response = await fetchImpl(base + path, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    });
    let json = null;
    try { json = await response.json(); } catch { /* not JSON */ }
    return { status: response.status, headers: response.headers, json };
  };
  const attempt = async (name, fn) => {
    try {
      await fn();
    } catch (error) {
      check(name, false, error.name === 'TimeoutError' ? 'timed out' : error.message);
    }
  };

  await attempt('health', async () => {
    const { status, json } = await request('/api/health');
    check('health', status === 200 && json?.ok === true, `HTTP ${status}${json?.version ? `, version ${json.version}` : ''}`);
  });

  await attempt('readiness', async () => {
    const { status, json } = await request('/api/ready');
    check('readiness', status === 200 && json?.ok === true, `HTTP ${status}, database ${json?.database ?? 'unknown'}`);
    check('reasoning-configured', json?.reasoning?.configured === true, json?.reasoning?.configured ? json.reasoning.provider : 'no reasoning provider');
  });

  await attempt('security-headers', async () => {
    const { status, headers } = await request('/');
    const missing = [
      'content-security-policy',
      'x-content-type-options',
      'referrer-policy',
      ...(secure ? ['strict-transport-security'] : [])
    ].filter(name => !headers.get(name));
    check('app-served', status === 200, `HTTP ${status}`);
    check('security-headers', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : 'present');
  });

  await attempt('auth-required', async () => {
    const { status } = await request('/api/runs');
    check('auth-required', status === 401, `unauthenticated /api/runs answered HTTP ${status}`);
  });

  if (text(apiKey)) {
    const auth = { authorization: `Bearer ${text(apiKey)}` };
    await attempt('sign-in', async () => {
      const { status, json } = await request('/api/me', { headers: auth });
      const workspaces = json?.workspaces ?? [];
      check('sign-in', status === 200 && Boolean(json?.principal?.id), `HTTP ${status}`);
      const chosen = text(workspace) || workspaces[0]?.id;
      if (status !== 200) return;
      if (!chosen) return check('plan-preview', false, 'the key has no workspace');
      const plan = await request('/api/plan', {
        method: 'POST',
        headers: { ...auth, 'x-workspace-id': chosen },
        body: { goal: 'Deployment smoke check: explain what a heat pump does.' }
      });
      const tasks = plan.json?.tasks ?? [];
      check('plan-preview', plan.status === 200 && tasks.length > 0 && tasks.every(task => task.status === 'pending'),
        `HTTP ${plan.status}, ${tasks.length} planned step(s), nothing created`);
    });
  }

  return { ok: checks.every(item => item.ok), baseUrl: base, checks };
}
