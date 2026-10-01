/**
 * Adaptive provider concurrency control.
 *
 * Protects a single process from stampeding an upstream model provider when
 * many chats, agents and verification passes run at once. It is deliberately
 * independent of authorization: it only schedules already-authorized calls.
 */
const text = value => String(value ?? '').trim();

export class ProviderConcurrencyError extends Error {
  constructor(key) {
    super('The model provider is temporarily saturated; the request was not sent.');
    this.name = 'ProviderConcurrencyError';
    this.code = 'provider-concurrency-saturated';
    this.status = 503;
    this.expose = true;
    this.key = key;
  }
}

export class AdaptiveProviderGovernor {
  constructor({
    min = 1,
    max = 4,
    initial = max,
    queueTimeoutMs = 5_000,
    now = () => Date.now(),
    onChange = null
  } = {}) {
    this.min = Math.max(1, Math.min(32, Math.floor(Number(min) || 1)));
    this.max = Math.max(this.min, Math.min(32, Math.floor(Number(max) || 4)));
    this.initial = Math.max(this.min, Math.min(this.max, Math.floor(Number(initial) || this.max)));
    this.queueTimeoutMs = Math.max(100, Math.min(60_000, Number(queueTimeoutMs) || 5_000));
    this.now = now;
    this.onChange = onChange;
    this.states = new Map();
  }

  state(key) {
    const id = text(key) || 'default';
    let state = this.states.get(id);
    if (!state) {
      state = {
        key: id,
        concurrency: this.initial,
        active: 0,
        queued: [],
        successStreak: 0,
        failureStreak: 0,
        lastLatencyMs: 0,
        lastFailureCode: null,
        lastChangeAt: 0
      };
      this.states.set(id, state);
    }
    return state;
  }

  stats(key = null) {
    const values = key ? [this.state(key)] : [...this.states.values()];
    return values.map(state => ({
      key: state.key,
      concurrency: state.concurrency,
      active: state.active,
      queued: state.queued.length,
      successStreak: state.successStreak,
      failureStreak: state.failureStreak,
      lastLatencyMs: state.lastLatencyMs,
      lastFailureCode: state.lastFailureCode
    }));
  }

  async acquire(key) {
    const state = this.state(key);
    if (state.active < state.concurrency) {
      state.active += 1;
      return () => this.release(state);
    }

    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        expiresAt: this.now() + this.queueTimeoutMs
      };
      state.queued.push(entry);
      entry.timer = setTimeout(() => {
        const index = state.queued.indexOf(entry);
        if (index >= 0) state.queued.splice(index, 1);
        reject(new ProviderConcurrencyError(state.key));
      }, this.queueTimeoutMs);
      entry.timer.unref?.();
    });
  }

  release(state) {
    state.active = Math.max(0, state.active - 1);
    while (state.queued.length && state.active < state.concurrency) {
      const next = state.queued.shift();
      clearTimeout(next.timer);
      state.active += 1;
      next.resolve(() => this.release(state));
    }
  }

  adapt(key, { ok, latencyMs = 0, code = null } = {}) {
    const state = this.state(key);
    state.lastLatencyMs = Math.max(0, Number(latencyMs) || 0);
    if (ok) {
      state.successStreak += 1;
      state.failureStreak = 0;
      state.lastFailureCode = null;
      // Grow slowly: concurrency is increased only after several healthy calls
      // with no evidence of saturation.
      if (state.successStreak >= 6 && state.lastLatencyMs <= 3_000 && state.concurrency < this.max) {
        state.concurrency += 1;
        state.successStreak = 0;
        state.lastChangeAt = this.now();
        this.onChange?.({ key: state.key, concurrency: state.concurrency, reason: 'healthy' });
        this.release(state);
      }
      return this.stats(state.key)[0];
    }

    state.failureStreak += 1;
    state.successStreak = 0;
    state.lastFailureCode = text(code) || null;
    const pressureFailure = code === 'model-rate-limited'
      || code === 'model-unavailable'
      || code === 'provider-concurrency-saturated'
      || (code === 'timeout');
    if (pressureFailure && state.failureStreak >= 1 && state.concurrency > this.min) {
      state.concurrency -= 1;
      state.lastChangeAt = this.now();
      this.onChange?.({ key: state.key, concurrency: state.concurrency, reason: 'upstream-pressure' });
      this.release(state);
    }
    return this.stats(state.key)[0];
  }

  async run(key, fn) {
    const release = await this.acquire(key);
    const started = this.now();
    try {
      const value = await fn();
      this.adapt(key, { ok: true, latencyMs: this.now() - started });
      return value;
    } catch (error) {
      const code = error?.code === 'model-rate-limited' ? 'model-rate-limited'
        : error?.code === 'model-unavailable' ? 'model-unavailable'
          : error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'timeout'
            : error?.code || null;
      this.adapt(key, { ok: false, latencyMs: this.now() - started, code });
      throw error;
    } finally {
      release();
    }
  }

  reset() {
    for (const state of this.states.values()) {
      for (const item of state.queued.splice(0)) {
        clearTimeout(item.timer);
        item.reject(new ProviderConcurrencyError(state.key));
      }
    }
    this.states.clear();
  }
}
