/** Execute dependency/conflict scheduling waves in order.
 * Only independent peers within a wave may run concurrently. */
export async function executeAgentLaneWaves({ lanePlan, jobs, execute, maxParallel = 1, signal } = {}) {
  if (typeof execute !== 'function') throw new TypeError('execute is required');
  const limit = Math.max(1, Math.min(16, Math.floor(Number(maxParallel) || 1)));
  const byId = new Map((jobs ?? []).map(job => [job?.lane?.agentId, job]));
  const visited = new Set();
  const results = [];
  for (const wave of lanePlan?.waves ?? []) {
    signal?.throwIfAborted();
    const ready = (wave.lanes ?? []).map(lane => byId.get(lane.agentId))
      .filter(job => job && !visited.has(job.lane.agentId));
    for (let offset = 0; offset < ready.length; offset += limit) {
      signal?.throwIfAborted();
      const batch = ready.slice(offset, offset + limit);
      batch.forEach(job => visited.add(job.lane.agentId));
      results.push(...await Promise.all(batch.map(job => execute(job))));
      signal?.throwIfAborted();
    }
  }
  if (visited.size !== byId.size) throw new Error('Agent lane plan omitted scheduled work');
  return results;
}
