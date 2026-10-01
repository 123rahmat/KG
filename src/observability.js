/**
 * Structured logging and metrics.
 *
 * Logs are one JSON object per line so they are greppable by a human and
 * ingestible by a log pipeline without a parser. Secrets never reach them:
 * every record passes through a redactor first.
 */

import crypto from 'node:crypto';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const TRACE_ID_RE = /^[0-9a-f]{32}$/i;
const SPAN_ID_RE = /^[0-9a-f]{16}$/i;

export function parseTraceparent(value) {
  const raw = String(value ?? '').trim();
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec(raw);
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return null;
  return { version: '00', traceId: match[1].toLowerCase(), parentSpanId: match[2].toLowerCase(), traceFlags: match[3].toLowerCase() };
}

export function createTraceContext(incoming = null) {
  const parent = parseTraceparent(incoming);
  const traceId = parent?.traceId ?? crypto.randomUUID().replaceAll('-', '');
  const spanId = crypto.randomBytes(8).toString('hex');
  return { traceId, spanId, parentSpanId: parent?.parentSpanId ?? null, traceFlags: parent?.traceFlags ?? '01' };
}

export function traceparentOf(context) {
  if (!context?.traceId || !context?.spanId) return null;
  if (!TRACE_ID_RE.test(context.traceId) || !SPAN_ID_RE.test(context.spanId)) return null;
  return `00-${context.traceId}-${context.spanId}-${context.traceFlags === '00' ? '00' : '01'}`;
}


/** Keys whose values are never written to a log, at any depth. */
// Exact names, plus any name that carries a secret (secretKey, webhookSecret,
// stripe-signature, x-api-key, accessToken). Token counts such as inputTokens
// end in "s" and stay readable.
const SECRET_KEYS = /^(password|secret|token|key|authorization|cookie|set-cookie|content)$|secret|password|api[-_]?key|token$|signature|credential/i;
const MAX_DEPTH = 6;
const MAX_STRING = 2_000;

function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' && value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…[${value.length} chars]`
      : value;
  }
  if (depth >= MAX_DEPTH) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redact(item, depth + 1));
  // The stack says where a production failure came from; it holds code
  // locations, not request data.
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      code: value.code,
      // Only "at …" frames: a multi-line message would otherwise continue
      // into the stack text, outside what the redactor can see.
      stack: String(value.stack ?? '').split('\n').map(line => line.trim()).filter(line => line.startsWith('at ')).slice(0, 10).join('\n') || undefined,
      ...(value.cause instanceof Error && depth < MAX_DEPTH - 1 ? { cause: redact(value.cause, depth + 1) } : {})
    };
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SECRET_KEYS.test(key) ? '[redacted]' : redact(item, depth + 1);
  }
  return output;
}

export function createLogger({ level = 'info', stream = process.stdout, now = () => new Date() } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const write = (severity, message, fields) => {
    if (LEVELS[severity] < threshold) return;
    stream.write(`${JSON.stringify({
      at: now().toISOString(),
      level: severity,
      message,
      ...redact(fields ?? {})
    })}\n`);
  };

  const logger = {
    level,
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    /** A logger that stamps every record with the same fields. */
    child: bound => ({
      ...logger,
      debug: (message, fields) => write('debug', message, { ...bound, ...fields }),
      info: (message, fields) => write('info', message, { ...bound, ...fields }),
      warn: (message, fields) => write('warn', message, { ...bound, ...fields }),
      error: (message, fields) => write('error', message, { ...bound, ...fields })
    })
  };
  return logger;
}

/**
 * Counters and latency histograms, exposed in Prometheus text format.
 * Deliberately small: enough to answer "is it up, is it slow, is it erroring"
 * without pulling in a metrics framework.
 */
export function createMetrics() {
  const counters = new Map();
  const histograms = new Map();
  // Gauges are read when scraped, so they show the state now, not a stale copy.
  const gauges = new Map();
  const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];

  /** Series are keyed by name+tags but keep both, so rendering never re-parses a key. */
  const keyOf = (name, tags) => `${name}|${JSON.stringify(tags ?? {})}`;

  const escape = value => String(value).replace(/[\\"\n]/g, '');

  const renderTags = (tags, extra) => {
    const parts = [
      ...Object.entries(tags).sort(([a], [b]) => a.localeCompare(b)),
      ...Object.entries(extra ?? {})
    ].map(([key, value]) => `${key}="${escape(value)}"`);
    return parts.length ? `{${parts.join(',')}}` : '';
  };

  return {
    increment(name, tags = {}, by = 1) {
      const key = keyOf(name, tags);
      const row = counters.get(key) ?? { name, tags, value: 0 };
      row.value += by;
      counters.set(key, row);
    },

    observe(name, tags = {}, milliseconds) {
      const key = keyOf(name, tags);
      const row = histograms.get(key)
        ?? { name, tags, count: 0, sum: 0, buckets: new Array(BUCKETS.length).fill(0) };
      row.count += 1;
      row.sum += milliseconds;
      for (let i = 0; i < BUCKETS.length; i += 1) {
        if (milliseconds <= BUCKETS[i]) row.buckets[i] += 1;
      }
      histograms.set(key, row);
    },

    /** Register a gauge read at scrape time: `read()` returns [{ tags, value }]. */
    gauge(name, read) {
      gauges.set(name, read);
    },

    /** Prometheus text exposition format. */
    render() {
      const lines = [];
      for (const [name, read] of gauges) {
        let series;
        try { series = read() ?? []; } catch { series = []; }
        for (const { tags = {}, value } of series) {
          if (Number.isFinite(value)) lines.push(`${name}${renderTags(tags)} ${value}`);
        }
      }
      for (const { name, tags, value } of counters.values()) {
        lines.push(`${name}${renderTags(tags)} ${value}`);
      }
      for (const { name, tags, count, sum, buckets } of histograms.values()) {
        // observe() already increments every bucket an observation falls into,
        // so these counts are cumulative as Prometheus requires.
        for (let i = 0; i < BUCKETS.length; i += 1) {
          lines.push(`${name}_bucket${renderTags(tags, { le: BUCKETS[i] })} ${buckets[i]}`);
        }
        lines.push(`${name}_bucket${renderTags(tags, { le: '+Inf' })} ${count}`);
        lines.push(`${name}_sum${renderTags(tags)} ${Math.round(sum)}`);
        lines.push(`${name}_count${renderTags(tags)} ${count}`);
      }
      return `${lines.join('\n')}\n`;
    },

    snapshot: () => ({
      counters: Object.fromEntries(
        [...counters.values()].map(row => [`${row.name}${renderTags(row.tags)}`, row.value])
      ),
      histograms: Object.fromEntries(
        [...histograms.values()].map(row => [
          `${row.name}${renderTags(row.tags)}`,
          { count: row.count, sumMs: Math.round(row.sum) }
        ])
      )
    })
  };
}
