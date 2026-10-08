/** Gemini-family inference on Google Vertex AI plus governed execution boundaries. */
import { DEFAULT_MODEL, LIGHT_MODEL, modelDecisionForTask, resolveConfiguredModel } from './model-catalog.js';
import { AdaptiveProviderGovernor } from './adaptive-provider-governor.js';
import { decideWebSearch } from './adaptive-execution-policy.js';

const text = value => String(value ?? '').trim();
const providerGovernor = new AdaptiveProviderGovernor();
export const providerConcurrencyStats = () => providerGovernor.stats();
export const resetProviderConcurrency = () => providerGovernor.reset();

export const MODEL_TIMEOUT_MS = 45_000;
export const MODEL_CASCADE_MS = 120_000;
export const RUNNER_TIMEOUT_MS = 60_000;
export const SANDBOX_TIMEOUT_MS = 330_000;

/** Observe the durable run state so Stop also reaches calls in other workers. */
export async function withRunControl(operation, { readRun, taskId, attempt, pollMs = 1000 } = {}) {
  const controller = new AbortController();
  let closed = false;
  let timer;
  const abort = (code, message) => {
    const reason = Object.assign(new Error(message), { name: 'AbortError', code, status: 409, expose: true });
    controller.abort(reason);
  };
  const check = async () => {
    try {
      const run = await readRun();
      if (closed) return;
      if (!run || ['failed', 'complete', 'blocked', 'exhausted'].includes(run.state)) {
        abort('run-stopped', 'This run has stopped.');
      } else if (run.next !== taskId || Number(run.attempt) !== Number(attempt)) {
        abort('stale-execution', 'This execution belongs to an earlier task or attempt.');
      }
    } catch (error) {
      if (!closed) controller.abort(Object.assign(new Error('The run control state could not be checked.'), {
        name: 'AbortError', code: 'run-control-unavailable', status: 503, expose: true, cause: error
      }));
    }
  };
  const poll = async () => {
    await check();
    if (!closed && !controller.signal.aborted) timer = setTimeout(poll, Math.max(10, Number(pollMs) || 1000));
  };
  try {
    await check();
    controller.signal.throwIfAborted();
    timer = setTimeout(poll, Math.max(10, Number(pollMs) || 1000));
    const result = await operation(controller.signal);
    await check();
    controller.signal.throwIfAborted();
    return result;
  } finally {
    closed = true;
    clearTimeout(timer);
  }
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const imagesOf = message => Array.isArray(message?.images)
  ? message.images.filter(image => image?.data && image?.mediaType)
  : [];

export function estimateModelTokens(messages = [], { maxOutputTokens = 4096 } = {}) {
  const chars = (Array.isArray(messages) ? messages : []).reduce(
    (sum, message) => sum + (typeof message?.content === 'string' ? message.content.length : 0),
    0
  );
  const images = (Array.isArray(messages) ? messages : []).reduce((sum, message) => sum + imagesOf(message).length, 0);
  return Math.min(1_048_576, Math.max(256, Math.ceil(chars / 4) + images * 1024 + (Number(maxOutputTokens) > 0 ? Math.floor(Number(maxOutputTokens)) : 4096)));
}

function vertexContents(messages) {
  const source = Array.isArray(messages) ? messages : [];
  const systemText = source.filter(message => message?.role === 'system' && text(message?.content))
    .map(message => String(message.content)).join('\n\n');
  const contents = source.filter(message => message?.role !== 'system').flatMap(message => {
    const parts = [];
    // Put visual evidence before the instruction text it belongs to. This
    // preserves the attachment contract used throughout the app and avoids
    // text-only fallbacks in multimodal fixtures/clients.
    for (const image of imagesOf(message)) {
      parts.push({ inlineData: { mimeType: image.mediaType, data: image.data } });
    }
    if (text(message?.content)) parts.push({ text: String(message.content) });
    if (!parts.length) return [];
    return [{ role: message?.role === 'assistant' ? 'model' : 'user', parts }];
  });
  return { systemText, contents };
}

function vertexEndpoint({ project, location = 'global', model }) {
  const region = text(location) || 'global';
  const host = region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
}

function vertexBuild(selected, messages, {
  webSearch = false,
  maxOutputTokens = null,
  effort = null,
  json = false,
  excludedDomains = []
} = {}) {
  const { systemText, contents } = vertexContents(messages);
  const generationConfig = {
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(json ? { responseMimeType: 'application/json' } : {})
  };
  const thinking = effectiveEffort(effort, 'high');
  if (thinking) generationConfig.thinkingConfig = { thinkingLevel: thinking.toUpperCase() };
  const search = {};
  const excluded = [...new Set((Array.isArray(excludedDomains) ? excludedDomains : []).map(text).filter(Boolean))].slice(0, 20);
  if (excluded.length) search.excludeDomains = excluded;
  const body = {
    contents,
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    generationConfig,
    ...(webSearch ? { tools: [{ googleSearch: search }] } : {})
  };
  return { url: vertexEndpoint(selected), body };
}

function vertexParse(data) {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  const parts = candidates.flatMap(candidate => candidate?.content?.parts ?? []);
  const answer = parts.filter(part => typeof part?.text === 'string').map(part => part.text).join('');
  const images = parts.filter(part => part?.inlineData?.data).map(part => ({
    mediaType: text(part.inlineData.mimeType) || 'image/png',
    data: part.inlineData.data
  }));
  const citations = candidates.flatMap(candidate => candidate?.groundingMetadata?.groundingChunks ?? [])
    .map(chunk => chunk?.web)
    .filter(item => item?.uri)
    .map(item => ({ url: text(item.uri), title: text(item.title) }));
  const usage = data?.usageMetadata ?? null;
  const inputTokens = Number(usage?.promptTokenCount ?? 0);
  const outputTokens = Number(usage?.candidatesTokenCount ?? 0);
  const reasoningTokens = Number(usage?.thoughtsTokenCount ?? 0);
  const finishReason = text(candidates[0]?.finishReason).toUpperCase();
  const promptBlockReason = text(data?.promptFeedback?.blockReason).toUpperCase();
  const providerRefusal = Boolean(promptBlockReason)
    || ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(finishReason);
  return {
    text: answer,
    citations: [...new Map(citations.map(item => [item.url, item])).values()],
    images,
    content: candidates,
    usage: usage ? {
      inputTokens,
      outputTokens,
      ...(reasoningTokens ? { reasoningTokens } : {})
    } : null,
    incomplete: providerRefusal
      ? 'refusal'
      : ['MAX_TOKENS', 'RECITATION'].includes(finishReason)
        ? finishReason.toLowerCase()
        : null
  };
}

export const MODEL_DEFAULTS = Object.freeze({ google: DEFAULT_MODEL });
export const SUPPORTED_PROVIDERS = Object.freeze(['google']);

async function readBounded(response, maxBytes) {
  const raw = await response.text();
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    const error = new Error(`Upstream response exceeded ${maxBytes} bytes`);
    error.code = 'ERESPONSETOOLARGE';
    throw error;
  }
  return raw;
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const cleanup = () => signal?.removeEventListener('abort', abort);
  const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); cleanup(); reject(signal.reason); };
  signal?.addEventListener('abort', abort, { once: true });
});

async function withRetry(attempt, { retries = 1, backoffMs = 500, maxWaitMs = 8000, sleep = wait, signal } = {}) {
  let last;
  for (let index = 0; index <= retries; index += 1) {
    signal?.throwIfAborted();
    try {
      const result = await attempt(index);
      if (!result.retryable || index === retries) return result;
      last = result;
    } catch (error) {
      if (signal?.aborted || index === retries || (error?.expose === true && error?.status < 500 && !(error instanceof ModelProviderError)) || error?.code === 'ERESPONSETOOLARGE'
          || (error?.upstreamStatus && !RETRY_STATUS.has(error.upstreamStatus))) throw error;
      last = error;
    }
    const delay = Math.max(Number(last?.retryAfterMs) || 0, backoffMs * 2 ** index * (0.8 + Math.random() * 0.4));
    if (delay > maxWaitMs) break;
    await sleep(delay, signal);
  }
  if (last instanceof Error) throw last;
  return last;
}

export function retryAfterMs(headers, now = Date.now()) {
  const value = typeof headers?.get === 'function' ? headers.get('retry-after') : null;
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

const MODEL_ERRORS = {
  'model-rate-limited': 'Vertex AI is rate-limited; nothing was recorded.',
  'model-not-authorized': 'Google Cloud rejected the Vertex AI credentials; nothing was recorded.',
  'model-not-found': 'The selected Gemini model is not available in this Vertex AI project.',
  'model-unavailable': 'Vertex AI is temporarily unavailable; nothing was recorded.',
  'model-request-rejected': 'Vertex AI rejected the request; nothing was recorded.'
};

export class ModelProviderError extends Error {
  constructor(provider, status, { retryAfterMs: after = null } = {}) {
    const code = status === 429 ? 'model-rate-limited'
      : status === 401 || status === 403 ? 'model-not-authorized'
        : status === 404 ? 'model-not-found'
          : status === 408 || status >= 500 ? 'model-unavailable'
            : 'model-request-rejected';
    super(MODEL_ERRORS[code]);
    this.name = 'ModelProviderError';
    this.provider = provider;
    this.code = code;
    this.upstreamStatus = status;
    this.status = code === 'model-request-rejected' ? 502 : 503;
    this.retryAfterMs = after;
    this.retryAfterSeconds = after ? Math.ceil(after / 1000) : null;
    this.expose = code !== 'model-request-rejected';
  }
}

const EFFORT_ORDER = ['low', 'medium', 'high'];
export function effectiveEffort(requested, ceiling) {
  const normalize = value => String(value ?? '').toLowerCase() === 'xhigh' ? 'high' : String(value ?? '').toLowerCase();
  const wanted = normalize(requested);
  const cap = normalize(ceiling);
  const wantedIndex = EFFORT_ORDER.indexOf(wanted);
  const capIndex = EFFORT_ORDER.indexOf(cap);
  if (wantedIndex < 0) return capIndex < 0 ? 'high' : cap;
  return capIndex < 0 ? wanted : EFFORT_ORDER[Math.min(wantedIndex, capIndex)];
}

const tokenCache = new Map();
async function vertexAccessToken(selected, fetchImpl, timeoutMs, signal) {
  if (text(selected?.accessToken)) return text(selected.accessToken);
  const cacheKey = `${selected.project}:${selected.location || 'global'}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const response = await fetchImpl(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.any([AbortSignal.timeout(Math.min(timeoutMs, 5000)), ...(signal ? [signal] : [])]) }
  );
  if (!response.ok) throw new ModelProviderError('google', response.status);
  const data = await response.json();
  const token = text(data?.access_token);
  if (!token) throw new ModelProviderError('google', 401);
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + Math.max(60, Number(data?.expires_in) || 300) * 1000 });
  return token;
}

export async function callModel(messages, {
  config,
  fetchImpl = fetch,
  sleep = wait,
  webSearch = 'auto',
  imageGeneration = false,
  imageAction = 'auto',
  timeoutMs = MODEL_TIMEOUT_MS,
  retries = 1,
  maxOutputTokens = null,
  modelId = null,
  effort = null,
  json = false,
  allowBackup = () => true,
  usageGate = null,
  usageSource = 'chat',
  cacheKey = null,
  searchBudget = null,
  allowedDomains = [],
  excludedDomains = [],
  adaptiveContext = {},
  beforeCall = null,
  signal
} = {}) {
  signal?.throwIfAborted();
  if (!config?.ai) return null;

  const requested = resolveConfiguredModel(config, modelId || config.ai.modelId || null);
  if (!requested) return null;
  const routingDecision = modelDecisionForTask({
    taskType: usageSource,
    effort,
    adaptiveContext,
    configured: config.ai.models ?? [LIGHT_MODEL, DEFAULT_MODEL]
  });
  const selected = modelId
    ? requested
    : (resolveConfiguredModel(config, `google:${routingDecision.model}`) || requested);
  await beforeCall?.({ model: selected.model, modelId: `google:${selected.model}` });
  signal?.throwIfAborted();

  const modelKey = `google:${selected.model}`;
  providerGovernor.configure(modelKey, config.providerConcurrency ?? {});
  const accessToken = await vertexAccessToken(selected, fetchImpl, timeoutMs, signal);
  signal?.throwIfAborted();

  let reservation = null;
  let admittedMaxOutputTokens = Math.max(1, Math.floor(Number(maxOutputTokens) || 4096));
  if (usageGate) {
    try {
      reservation = await usageGate.reserve({
        estimatedTokens: estimateModelTokens(messages, { maxOutputTokens: admittedMaxOutputTokens }),
        usageSource
      });
      if (reservation?.estimatedTokens) {
        admittedMaxOutputTokens = Math.max(1, Math.min(admittedMaxOutputTokens, Number(reservation.estimatedTokens)));
      }
    } catch (error) {
      if (error?.code === 'usage-limit-reached') {
        return {
          text: '', citations: [], usage: null, provider: 'google', model: selected.model,
          incomplete: 'usage-limit', status: 'usage-limit-reached', message: error.message
        };
      }
      throw error;
    }
  }

  const goal = messages?.filter(message => message?.role === 'user')
    .map(message => message?.content).filter(value => typeof value === 'string').join('\n').slice(-12000) ?? '';
  const webPolicy = decideWebSearch({
    goal,
    requested: webSearch,
    research: adaptiveContext.research === true,
    requiresFreshData: adaptiveContext.requiresFreshData === true,
    evidenceRequired: adaptiveContext.evidenceRequired === true,
    externalDataRequired: adaptiveContext.externalDataRequired === true,
    risk: adaptiveContext.risk ?? 'ordinary',
    budget: searchBudget,
    priorSources: adaptiveContext.priorSources ?? [],
    allowedDomains,
    excludedDomains
  });
  // Vertex Google Search currently supports exclusion filters. If a strict
  // allow-list is required, do not bypass it with integrated grounding.
  const shouldSearch = webPolicy.shouldSearch && !(Array.isArray(allowedDomains) && allowedDomains.length);

  const doRequest = async search => withRetry(async index => {
    if (index > 0) await beforeCall?.({ model: selected.model, modelId: `google:${selected.model}` });
    return providerGovernor.run(modelKey, async () => {
      await beforeCall?.({ model: selected.model, modelId: `google:${selected.model}` });
      signal?.throwIfAborted();
      // Re-admit after queueing and on retries: a policy edit or another call
      // may have consumed the budget since the initial reservation.
      if (usageGate?.revalidate) {
        reservation = await usageGate.revalidate(reservation, {
          estimatedTokens: estimateModelTokens(messages, { maxOutputTokens: admittedMaxOutputTokens }), usageSource
        });
        if (reservation?.estimatedTokens) admittedMaxOutputTokens = Math.max(1, Math.min(admittedMaxOutputTokens, Number(reservation.estimatedTokens)));
      }
      const req = vertexBuild(selected, messages, {
        webSearch: search,
        maxOutputTokens: admittedMaxOutputTokens,
        effort: effectiveEffort(effort, config.ai.effort),
        json,
        excludedDomains
      });
      const response = await fetchImpl(req.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(req.body),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])
      });
      // The governor must observe HTTP failures before retry policy handles them.
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new ModelProviderError('google', response.status, { retryAfterMs: retryAfterMs(response.headers) });
      }
      const raw = await readBounded(response, config.limits.responseBytes);
      return {
        retryable: !response.ok && RETRY_STATUS.has(response.status),
        status: response.status,
        raw,
        retryAfterMs: retryAfterMs(response.headers)
      };
    }, { signal });
  }, { sleep, retries, backoffMs: 500, maxWaitMs: 8000, signal });

  let outcome;
  try {
    outcome = await doRequest(shouldSearch);
  } catch (error) {
    if (reservation) await usageGate?.release(reservation).catch(() => {});
    if (signal?.aborted) throw signal.reason;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || error instanceof TypeError) {
      throw new ModelProviderError('google', 408);
    }
    throw error;
  }

  if (outcome.status < 200 || outcome.status >= 300) {
    if (reservation) await usageGate?.release(reservation).catch(() => {});
    throw new ModelProviderError('google', outcome.status, { retryAfterMs: outcome.retryAfterMs });
  }

  let segment;
  let usageRecorded = false;
  let usageBudget = null;
  try {
    segment = vertexParse(JSON.parse(outcome.raw));
  } catch {
    segment = { text: '', citations: [], images: [], content: [], usage: null, incomplete: 'invalid-provider-response' };
  }

  if (reservation) {
    const usage = segment.usage ?? {};
    try {
      usageBudget = await usageGate.settle({
        reservationId: reservation.id,
        source: usageSource,
        provider: 'google',
        model: selected.model,
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        conversationId: null
      });
      usageRecorded = usageBudget?.recorded === true;
      reservation = null;
    } catch (error) {
      await usageGate.release(reservation).catch(() => {});
      throw error;
    }
  }

  return {
    text: segment.text,
    citations: segment.citations,
    images: segment.images ?? [],
    content: segment.content ?? [],
    usage: segment.usage,
    provider: 'google',
    model: selected.model,
    modelRouting: {
      tier: routingDecision.tier,
      reason: modelId ? 'explicit-model' : routingDecision.reason,
      qualityProtected: routingDecision.qualityProtected,
      budgetConstrained: routingDecision.budgetConstrained
    },
    incomplete: segment.incomplete,
    usageRecorded,
    usageBudget,
    webSearchPolicy: webPolicy,
    ...(webPolicy.shouldSearch && !shouldSearch ? { webSearchUnavailable: true } : {})
  };
}

export async function callRunner(url, payload, { config, fetchImpl = fetch, sleep = wait, timeoutMs = RUNNER_TIMEOUT_MS, token = null, signal, beforeCall = null } = {}) {
  signal?.throwIfAborted();
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
      await beforeCall?.();
      signal?.throwIfAborted();
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])
      });
      const raw = await readBounded(response, config.limits.responseBytes);
      return { retryable: RETRY_STATUS.has(response.status), status: response.status, raw };
    }, {
      sleep,
      // Runner calls can have side effects. Never retry an ambiguous POST here:
      // a timeout or dropped connection does not prove the runner did nothing.
      retries: 0,
      signal
    });

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
    if (signal?.aborted) throw signal.reason;
    if (error?.expose === true && error?.status < 500) throw error;
    // A runner we could not reach did not run anything. Say exactly that.
    return {
      configured: true,
      executed: false,
      status: 'unreachable',
      message: error.name === 'TimeoutError' ? 'Runner timed out' : 'Runner could not be reached'
    };
  }
}
