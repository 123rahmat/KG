/** Request admission control. */

import net from 'node:net';

/**
 * The network a client address belongs to, for counting requests. IPv4 is
 * one address; IPv6 is its /64, because every IPv6 connection is handed at
 * least a /64 and could otherwise take a fresh address for every request
 * and never meet a limit.
 */
export function clientNetwork(ip) {
  const address = String(ip ?? '').trim().replace(/^\[|\]$/g, '');
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (net.isIPv4(address)) return address;
  if (!net.isIPv6(address)) return address.slice(0, 64);
  const [head, tail = ''] = address.toLowerCase().split('%')[0].split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const full = address.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${full.slice(0, 4).map(part => part.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * Fixed-window limiter keyed by principal once known, by IP before that, so
 * one noisy tenant cannot spend another's budget and a shared NAT does not
 * throttle everybody behind it.
 */
// `name` namespaces buckets so limiters sharing the Postgres table never
// count against each other.
export function rateLimiter({ name = 'api', windowMs, max, metrics, pool, store = 'memory', message = 'Too many requests' }) {
  const hits = new Map();

  const memoryCheck = (req, res) => {
    const now = Date.now();
    if (hits.size > 50_000) {
      for (const [key, row] of hits) if (now - row.at > windowMs) hits.delete(key);
    }
    const key = `${name}:${req.principal?.id ?? `ip:${clientNetwork(req.ip)}`}`;
    const row = hits.get(key) ?? { at: now, count: 0 };
    if (now - row.at >= windowMs) {
      row.at = Math.floor(now / windowMs) * windowMs;
      row.count = 0;
    }
    row.count += 1;
    hits.set(key, row);
    return {
      count: row.count,
      remaining: Math.max(max - row.count, 0),
      retryAfterSeconds: Math.max(0, Math.ceil((row.at + windowMs - now) / 1000))
    };
  };

  const postgresCheck = async req => {
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const key = `${name}:${req.principal?.id ?? `ip:${clientNetwork(req.ip)}`}`;
    const { rows: [row] } = await pool.query(
      `INSERT INTO rate_limit_windows (bucket_key, window_start_ms, request_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (bucket_key) DO UPDATE
         SET request_count = CASE
           WHEN rate_limit_windows.window_start_ms = EXCLUDED.window_start_ms
             THEN rate_limit_windows.request_count + 1
           ELSE 1
         END,
         window_start_ms = EXCLUDED.window_start_ms
       RETURNING window_start_ms, request_count`,
      [key, windowStart]
    );
    return {
      count: Number(row.request_count),
      remaining: Math.max(max - Number(row.request_count), 0),
      retryAfterSeconds: Math.max(
        0,
        Math.ceil((Number(row.window_start_ms) + windowMs - now) / 1000)
      )
    };
  };

  return (req, res, next) => {
    const run = store === 'postgres' ? postgresCheck(req) : memoryCheck(req, res);
    Promise.resolve(run).then(result => {
      res.set('ratelimit-limit', String(max));
      res.set('ratelimit-remaining', String(result.remaining));
      if (result.count > max) {
        metrics.increment('rate_limited_total');
        res.set('retry-after', String(result.retryAfterSeconds));
        return res.status(429).json({ error: message, code: 'rate-limited' });
      }
      return next();
    }).catch(error => {
      metrics.increment('rate_limit_store_errors_total');
      req.log?.error('rate limit store unavailable', { error });
      return res.status(503).json({
        error: 'Request admission control is temporarily unavailable',
        code: 'rate-limit-unavailable'
      });
    });
  };
}
