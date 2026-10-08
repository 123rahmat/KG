/** Execute dependency/conflict scheduling waves in order.
 * Only independent peers within a wave may run concurrently. */
export async function executeAgentLaneWaves({ lanePlan, jobs, execute, maxParallel = 1, signal } = {}) {
  if (typeof execute !== 'function') throw new TypeError('execute is required');
  const limit = Math.max(1, Math.min(16, Math.floor(Number(maxParallel) || 1)));
  const byId = new Map();
  for (const job of jobs ?? []) {
    const id = job?.lane?.agentId;
    if (typeof id !== 'string' || !id.trim()) throw new Error('Agent job requires a lane ID');
    if (byId.has(id)) throw new Error('Duplicate agent job lane ID');
    byId.set(id, job);
  }
  // Validate the entire schedule before spending tokens on any model call.
  const scheduled = new Set();
  const waves = (lanePlan?.waves ?? []).map(wave => (wave.lanes ?? []).map(lane => {
    const id = lane?.agentId;
    if (!byId.has(id)) throw new Error('Agent lane plan references unknown work');
    if (scheduled.has(id)) throw new Error('Agent lane plan repeats scheduled work');
    scheduled.add(id);
    return byId.get(id);
  }));
  if (scheduled.size !== byId.size) throw new Error('Agent lane plan omitted scheduled work');
  const results = [];
  for (const ready of waves) {
    signal?.throwIfAborted();
    for (let offset = 0; offset < ready.length; offset += limit) {
      signal?.throwIfAborted();
      const batch = ready.slice(offset, offset + limit);
      // Drain started calls before releasing the parent on failure/cancellation;
      // usage and evidence callbacks must not outlive the run's task lifecycle.
      const settled = await Promise.allSettled(batch.map(job => Promise.resolve().then(() => execute(job))));
      signal?.throwIfAborted();
      const failure = settled.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      results.push(...settled.map(result => result.value));
    }
  }
  return results;
}
