/**
 * Everything that leaves this process: reasoning models and execution runners.
 *
 * Both are optional. The rule the whole system rests on is enforced here — an
 * unconfigured or failed dependency returns an explicit record saying nothing
 * ran. It never returns a fabricated result, and nothing downstream may report
 * reasoning, execution or verification that one of these calls did not return.
 */

import { MODEL_CATALOG, resolveConfiguredModel } from './model-catalog.js';
import { vertexAccessToken } from './vertex-auth.js';

const text = value => String(value ?? '').trim();

export const MODEL_TIMEOUT_MS = 45_000;
/** How long one call may spend moving through backup models. */
export const MODEL_CASCADE_MS = 120_000;
export const RUNNER_TIMEOUT_MS = 60_000;
/** The sandbox may install libraries (up to 3 min) and then run (up to 2 min). */
export const SANDBOX_TIMEOUT_MS = 330_000;
/** Transient classes worth one more attempt; everything else fails fast. */
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * A message may carry images ({ mediaType, data: base64 }) for the model to
 * look at. Each provider takes them in its own shape; text stays first.
 */
const imagesOf = message => (Array.isArray(message.images) ? message.images.filter(image => image?.data && image?.mediaType) : []);

const geminiContents = messages => {
  // Gemini 3.8 Flash rejects empty turns and histories ending in a prefilled
  // model turn. Keep prior assistant turns as context, but always stop at the
  // latest user turn before sending the request.
  const usable = messages
    .filter(message => message?.role !== 'system')
    .filter(message => text(message?.content) || imagesOf(message).length);
  while (usable.at(-1)?.role === 'assistant') usable.pop();
  return usable.map(message => {
    const images = imagesOf(message);
    const parts = [
      ...images.map(image => ({
        inline_data: { mime_type: image.mediaType, data: image.data }
      })),
      ...(text(message.content) ? [{ text: message.content }] : [])
    ];
    return {
      role: message.role === 'assistant' ? 'model' : 'user',
      parts
    };
  });
};

const geminiSystemInstruction = messages => {
  const system = messages
    .filter(message => message.role === 'system')
    .map(message => text(message.content))
    .filter(Boolean)
    .join('\n\n');
  return system ? { parts: [{ text: system }] } : undefined;
};

const PROVIDERS = {
  google: {
    defaultModel: 'gemini-3.8-flash',
    build: (credential, model, messages, { webSearch = false, maxOutputTokens = null, effort = null, json = false, project = null, location = 'global' } = {}) => {
      const generationConfig = {
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
        ...(json && !webSearch ? { responseMimeType: 'application/json' } : {}),
        ...(effort ? { thinkingConfig: { thinkingLevel: String(effort).toUpperCase() } } : {})
      };
      const body = {
        ...(geminiSystemInstruction(messages) ? { systemInstruction: geminiSystemInstruction(messages) } : {}),
        contents: geminiContents(messages),
        ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
        ...(webSearch ? { tools: [{ googleSearch: {} }] } : {})
      };
      if (project) {
        const host = location === 'global' ? 'aiplatform.googleapis.com' : location + '-aiplatform.googleapis.com';
        return { url: 'https://' + host + '/v1/projects/' + encodeURIComponent(project) + '/locations/' + encodeURIComponent(location) + '/publishers/google/models/' + encodeURIComponent(model) + ':generateContent', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + credential }, body };
      }
      return { url: 'https://aiplatform.googleapis.com/v1/publishers/google/models/' + encodeURIComponent(model) + ':generateContent', headers: { 'content-type': 'application/json', 'x-goog-api-key': credential }, body };
    },
    parse: data => {
      const candidate = data.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      const outputText = parts.filter(part => typeof part.text === 'string').map(part => part.text).join('');
      const metadata = candidate?.groundingMetadata ?? {};
      const citations = [...new Map((metadata.groundingChunks ?? []).map(chunk => chunk?.web).filter(web => web?.uri).map(web => [web.uri, { url: text(web.uri), title: text(web.title) }])).values()];
      const usageMetadata = data.usageMetadata;
      const promptTokens = Number(usageMetadata?.promptTokenCount ?? 0);
      const outputTokens = usageMetadata?.totalTokenCount != null ? Math.max(0, Number(usageMetadata.totalTokenCount) - promptTokens) : Number(usageMetadata?.candidatesTokenCount ?? 0);
      const usage = usageMetadata ? { inputTokens: promptTokens, outputTokens, ...(usageMetadata.thoughtsTokenCount != null ? { thoughtsTokens: Number(usageMetadata.thoughtsTokenCount) } : {}) } : null;
      const finishReason = text(candidate?.finishReason).toUpperCase();
      const declined = Boolean(data.promptFeedback?.blockReason) || ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'].includes(finishReason);
      const incompleteReasons = new Set(['MAX_TOKENS', 'RECITATION', 'MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL']);
      return { text: outputText, citations, incomplete: declined ? 'refusal' : incompleteReasons.has(finishReason) ? finishReason.toLowerCase() : null, paused: false, content: Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [], usage };
    }
  }
};
export const MODEL_DEFAULTS = Object.freeze(Object.fromEntries(MODEL_CATALOG.map(item => [item.provider, item.model])));
export const SUPPORTED_PROVIDERS = Object.freeze(Object.keys(PROVIDERS));

/**
 * Read a response body with a hard ceiling.
 *
 * `response.text()` on a hostile or broken upstream will happily buffer until
 * the process runs out of memory.
 */
async function readBounded(response, maxBytes) {
  if (!response.body) {
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
      const error = new Error(`Upstream response exceeded ${maxBytes} bytes`);
      error.code = 'ERESPONSETOOLARGE';
      throw error;
    }
    return raw;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        const error = new Error(`Upstream response exceeded ${maxBytes} bytes`);
        error.code = 'ERESPONSETOOLARGE';
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks.map(Buffer.from)).toString('utf8');
}

/**
 * Retry a transient failure. The wait is what the service asked for
 * (Retry-After, or Gemini's retryDelay) when it said, otherwise an
 * exponential backoff with jitter; a service asking for longer than
 * maxWaitMs is not waited on, so a request is never held open for minutes.
 */
async function withRetry(attempt, { retries = 1, backoffMs = 250, maxWaitMs = 10_000, sleep = wait } = {}) {
  let last;
  for (let tries = 0; tries <= retries; tries += 1) {
    let asked = null;
    try {
      const result = await attempt();
      if (!result.retryable || tries === retries) return result;
      last = result;
      asked = result.retryAfterMs ?? null;
    } catch (error) {
      // A timeout or socket error is worth one more try; a size breach is not.
      if (tries === retries || error.code === 'ERESPONSETOOLARGE') throw error;
      last = error;
    }
    const delay = asked ?? backoffMs * 2 ** tries * (0.8 + Math.random() * 0.4);
    if (delay > maxWaitMs) break;
    await sleep(delay);
  }
  if (last instanceof Error) throw last;
  return last;
}

/** How long a service asked us to wait: Retry-After (seconds or a date) or Gemini's RetryInfo. */
export function retryAfterMs(headers, raw) {
  const header = typeof headers?.get === 'function' ? headers.get('retry-after') : null;
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  const delay = String(raw ?? '').match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return delay ? Number(delay[1]) * 1000 : null;
}

const MODEL_ERRORS = {
  'model-rate-limited': 'Gemini is receiving more requests from this site than its quota allows. Nothing was recorded; try again shortly.',
  'model-not-authorized': 'The AI service did not accept this site\'s Gemini API key. Nothing was recorded; an administrator needs to check the key.',
  'model-not-found': 'The selected Gemini model is not available to this site. Nothing was recorded; an administrator can choose another model in Settings.',
  'model-unavailable': 'Gemini is temporarily unavailable. Nothing was recorded; try again in a moment.',
  'model-request-rejected': 'Gemini could not process this request. Nothing was recorded.'
};

/**
 * Gemini did not answer. Rate limits, outages and key problems are the
 * service's state, not a bug here: the person is told which one, with a
 * time to retry when the service gave one. A rejected request (400) is
 * ours to fix and is reported as a server error.
 */
export class ModelProviderError extends Error {
  constructor(provider, upstreamStatus, { retryAfterMs: after = null } = {}) {
    const code = upstreamStatus === 429 ? 'model-rate-limited'
      : [401, 403].includes(upstreamStatus) ? 'model-not-authorized'
        : upstreamStatus === 404 ? 'model-not-found'
          : upstreamStatus === 408 || upstreamStatus >= 500 ? 'model-unavailable'
            : 'model-request-rejected';
    super(MODEL_ERRORS[code]);
    this.name = 'ModelProviderError';
    this.provider = provider;
    this.code = code;
    this.upstreamStatus = upstreamStatus;
    this.status = code === 'model-request-rejected' ? 502 : 503;
    this.retryAfterSeconds = Number.isFinite(after) && after > 0 ? Math.ceil(after / 1000) : null;
    this.expose = code !== 'model-request-rejected';
  }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Failures of one model that another model may not share: its quota, an
// overload, or the model being retired. A bad key or request is the same
// for every model, so it is reported at once.
const FALLBACK_CODES = new Set(['model-rate-limited', 'model-unavailable', 'model-not-found']);
// Web-search failures a plain answer can work around.
const SEARCH_FALLBACK_CODES = new Set(['model-rate-limited', 'model-request-rejected']);
const SEARCH_TOOL_FAILURES = new Set(['malformed_function_call', 'unexpected_tool_call']);

// Models that just failed that way are passed over for a while, so each
// request does not wait on them again: as long as Gemini asked (capped),
// otherwise a minute; ten minutes for a retired model.
const resting = new Map();
const REST_MS = { 'model-rate-limited': 60_000, 'model-unavailable': 60_000, 'model-not-found': 600_000 };
const MAX_REST_MS = 600_000;
// A quick 503 is not a reason to pass a model over next time: it costs no
// wait, and the model is often back a moment later. A timeout is.
const rest = (model, error, now) => (error.code === 'model-unavailable' && error.upstreamStatus !== 408) ? null : resting.set(model, {
  until: now + Math.min(MAX_REST_MS, (error.retryAfterSeconds ?? 0) * 1000 || REST_MS[error.code]),
  code: error.code
});
const isResting = (model, now) => (resting.get(model)?.until ?? 0) > now;
const isRetired = (model, now) => isResting(model, now) && resting.get(model).code === 'model-not-found';
/** For tests: forget which models are resting. */
export const resetModelRest = () => resting.clear();

// When every model fails, the person hears the most useful reason: busy or
// out of quota (try again) before "not found", which only one model said.
const ERROR_WEIGHT = { 'model-rate-limited': 3, 'model-unavailable': 2, 'model-not-found': 1 };
// An overloaded model often answers a few seconds later.
export const OVERLOAD_PAUSE_MS = 3_000;
// A backup never moves a step up to Pro when the chosen model is not Pro:
// that is the tier a plan pays for.
const isPro = model => /-pro\b/.test(String(model));

/**
 * Call the configured reasoning model.
 * Returns null — not an empty answer — when no provider is configured.
 */
const EFFORT_ORDER = ['low', 'medium', 'high'];

/**
 * How hard the model thinks on one call. Each task asks for what it needs
 * (a quick classification little, a code fix or a verification a lot); the
 * operator's AI_EFFORT, when set, is a ceiling for cost control.
 */
export function effectiveEffort(requested, ceiling) {
  const want = EFFORT_ORDER.indexOf(requested);
  const cap = EFFORT_ORDER.indexOf(ceiling);
  if (want < 0) return cap < 0 ? null : ceiling;
  return cap < 0 ? requested : EFFORT_ORDER[Math.min(want, cap)];
}

export async function callModel(messages, {
  config, fetchImpl = fetch, sleep = wait, webSearch = false,
  timeoutMs = MODEL_TIMEOUT_MS, retries = 1, maxOutputTokens = null, modelId = null, effort = null, json = false,
  allowBackup = () => true
} = {}) {
  if (!config.ai) return null;
  const selected = resolveConfiguredModel(config, modelId || config.ai.modelId || null);
  if (!selected) return null;
  const { provider } = selected;
  const adapter = PROVIDERS[provider];
  if (!adapter) return null;
  // The chosen model first, then the operator's backups: each Gemini model
  // has its own quota, so one that is exhausted or down need not stop work.
  const backups = (config.ai.fallbackModels ?? [])
    .filter(model => model !== selected.model && (isPro(selected.model) || !isPro(model)) && allowBackup(model));
  const configured = [selected.model, ...new Set(backups)];
  const startedAt = Date.now();
  // Resting models go last, not away: when every model is resting, all are
  // still tried. A model that said it does not exist is left out while it rests.
  const live = configured.filter(model => !isRetired(model, startedAt));
  const pool = live.length ? live : configured;
  const models = pool.length > 1
    ? [...pool.filter(model => !isResting(model, startedAt)), ...pool.filter(model => isResting(model, startedAt))]
    : pool;

  const credential = selected.vertexProject ? await vertexAccessToken(config) : selected.apiKey;
  if (!credential) return null;
  const request = async (url, headers, requestBody, attempts) => {
    const outcome = await withRetry(async () => {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const raw = await readBounded(response, config.limits.responseBytes);
      return {
        retryable: !response.ok && RETRY_STATUS.has(response.status), status: response.status, raw,
        retryAfterMs: response.ok ? null : retryAfterMs(response.headers, raw)
      };
    }, { sleep, retries: attempts, backoffMs: 1000, maxWaitMs: 8000 }).catch(error => {
      // A model that does not answer in time, or a dropped connection, is the
      // model being unavailable: the next model is tried and the person is
      // told to try again, instead of the step failing as an internal error.
      if (error?.code === 'ERESPONSETOOLARGE') throw error;
      if (['TimeoutError', 'AbortError'].includes(error?.name) || error instanceof TypeError) {
        throw new ModelProviderError(provider, 408);
      }
      throw error;
    });

    if (outcome.status < 200 || outcome.status >= 300) {
      // Never echo the upstream body: providers reflect request content back,
      // and request content can carry user data.
      throw new ModelProviderError(provider, outcome.status, { retryAfterMs: outcome.retryAfterMs });
    }
    try {
      return adapter.parse(JSON.parse(outcome.raw));
    } catch {
      return { text: '', citations: [], usage: null, incomplete: 'invalid-provider-response' };
    }
  };

  // Every model once, then the ones that were only overloaded once more
  // after a short pause. Bounded, so a wide outage fails well inside a
  // background job's lease instead of the job being reclaimed and run twice.
  const attempt = async search => {
    let reported = null;
    let spare = null;
    let candidates = models;
    for (let pass = 0; pass < 2 && candidates.length; pass += 1) {
      if (pass > 0) {
        if (Date.now() - startedAt + OVERLOAD_PAUSE_MS > MODEL_CASCADE_MS) break;
        await sleep(OVERLOAD_PAUSE_MS);
      }
      const overloaded = [];
      for (const [index, candidate] of candidates.entries()) {
        const { url, headers, body } = adapter.build(credential, candidate, messages, { webSearch: search, maxOutputTokens, json, effort: effectiveEffort(effort, config.ai.effort ?? null), project: selected.vertexProject || config.ai.vertexProject || null, location: selected.vertexLocation || config.ai.vertexLocation || 'global' });
        // With another model to turn to, a failing one is not waited on.
        const alone = models.length === 1 || (pass > 0 && index === candidates.length - 1);
        try {
          const segment = await request(url, headers, body, alone ? retries : 0);
          // An empty answer or a garbled tool call (small models asked to
          // search) is worth another model's try before it is accepted.
          const hollow = SEARCH_TOOL_FAILURES.has(segment?.incomplete) || (!text(segment?.text) && segment?.incomplete !== 'refusal');
          if (hollow && index < candidates.length - 1) {
            spare ??= { segment, model: candidate };
            continue;
          }
          return { segment, model: candidate };
        } catch (error) {
          if (!(error instanceof ModelProviderError) || !FALLBACK_CODES.has(error.code)) throw error;
          // The search tool has its own, smaller quota: running out of it says
          // nothing about the model, which stays available for plain calls.
          if (configured.length > 1 && !search) rest(candidate, error, Date.now());
          if (!reported || ERROR_WEIGHT[error.code] > ERROR_WEIGHT[reported.code]) reported = error;
          if (error.code === 'model-unavailable') overloaded.push(candidate);
          if (Date.now() - startedAt > MODEL_CASCADE_MS) throw reported;
        }
      }
      // A single model has already had its retries.
      candidates = models.length > 1 ? overloaded : [];
    }
    if (spare) return spare;
    if (reported) throw reported;
    return { segment: null, model: null };
  };

  let outcome;
  let webSearchUnavailable = false;
  try {
    outcome = await attempt(webSearch);
  } catch (error) {
    // Web search out of quota or refused: answer without it, and say so,
    // rather than fail a step that no retry soon would complete.
    if (!webSearch || !(error instanceof ModelProviderError) || !SEARCH_FALLBACK_CODES.has(error.code)) throw error;
    outcome = await attempt(false);
    webSearchUnavailable = true;
  }
  // A model that cannot use the search tool (a malformed or unexpected tool
  // call) answers the same question without it.
  if (webSearch && !webSearchUnavailable && SEARCH_TOOL_FAILURES.has(outcome.segment?.incomplete)) {
    outcome = await attempt(false);
    webSearchUnavailable = true;
  } else if (!webSearch && SEARCH_TOOL_FAILURES.has(outcome.segment?.incomplete)) {
    // A garbled "tool call" when none was offered is a one-off: ask once more.
    const again = await attempt(false);
    if (!SEARCH_TOOL_FAILURES.has(again.segment?.incomplete)) outcome = again;
  }
  const { segment, model } = outcome;
  const joined = segment?.text ?? '';
  const usage = segment?.usage ?? null;
  const citations = segment?.citations ?? [];
  const incomplete = segment?.incomplete || (text(joined) ? null : 'empty-response');
  return { text: joined, citations, usage, provider, model, incomplete, ...(webSearchUnavailable ? { webSearchUnavailable: true } : {}) };
}

/**
 * Execute through an authorized external runner.
 *
 * With no runner configured the result is an explicit `not-configured` record
 * with `executed: false`, surfaced to the caller verbatim.
 */
export async function callRunner(url, payload, { config, fetchImpl = fetch, sleep = wait, timeoutMs = RUNNER_TIMEOUT_MS, token = null } = {}) {
  const endpoint = text(url);
  if (!endpoint) {
    return {
      configured: false,
      executed: false,
      status: 'not-configured',
      message: 'No execution runner is configured; nothing was executed.'
    };
  }

  const headers = { 'content-type': 'application/json' };
  const runnerToken = text(token);
  if (runnerToken) headers.authorization = `Bearer ${runnerToken}`;
  // The execution ID lets a runner deduplicate retries of the same request,
  // and binds the runner's receipt to exactly this request.
  const executionId = text(payload?.executionId);
  if (executionId) headers['x-kindgleam-execution-id'] = executionId;

  try {
    const outcome = await withRetry(async () => {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const raw = await readBounded(response, config.limits.responseBytes);
      return { retryable: RETRY_STATUS.has(response.status), status: response.status, raw };
    }, { sleep });

    let result;
    try {
      result = JSON.parse(outcome.raw);
    } catch {
      result = { output: outcome.raw };
    }

    if (outcome.status < 200 || outcome.status >= 300) {
      return { configured: true, executed: false, status: 'failed', code: outcome.status, result };
    }
    if (result?.executed === false) {
      // An explicit refusal is an honest answer: pass its reason through.
      return {
        configured: true,
        executed: false,
        status: text(result.status) || 'not-executed',
        message: text(result.message) || 'The runner did not execute the task.',
        result
      };
    }
    if (result?.executed !== true) {
      return {
        configured: true,
        executed: false,
        status: 'invalid-runner-receipt',
        message: 'Runner returned success without an explicit executed=true receipt.'
      };
    }
    if (executionId && text(result.executionId) && text(result.executionId) !== executionId) {
      return {
        configured: true,
        executed: false,
        status: 'invalid-runner-receipt',
        message: 'Runner returned a receipt for a different execution request.'
      };
    }
    const runnerStatus = text(result.status) || 'completed';
    return {
      configured: true,
      executed: true,
      status: runnerStatus,
      result,
      executionReceipt: {
        executed: true,
        status: runnerStatus,
        runner: endpoint,
        executionTarget: text(payload.executionTarget),
        ...(executionId ? { executionId } : {}),
        managed: true,
        result
      }
    };
  } catch (error) {
    // A runner we could not reach did not run anything. Say exactly that.
    return {
      configured: true,
      executed: false,
      status: 'unreachable',
      message: error.name === 'TimeoutError' ? 'Runner timed out' : 'Runner could not be reached'
    };
  }
}
