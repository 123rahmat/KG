/** Display only persisted advisory outcomes; never infer live state from old waves. */
const safe = (value, max = 180) => String(value ?? '').trim().slice(0, max);
export function agentActivitySnapshot(run) {
  const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
  const multi = [...tasks].reverse().map(task => task?.evidence?.multiAgent).find(Boolean)
    ?? run?.adaptation?.multiAgent ?? null;
  const allocation = multi?.allocation ?? {};
  const states = Array.isArray(multi?.agentStates) ? multi.agentStates
    : Array.isArray(multi?.agents) ? multi.agents : [];
  const roles = states.filter(item => item?.role && item.role !== 'arbiter' && item.role !== 'integration-arbiter')
    .slice(-11).map(item => ({
      role: safe(item.role, 65),
      status: safe(item.status || 'recorded', 30),
      summary: safe(item.summary, 220),
      wave: Number.isInteger(item.wave) && item.wave >= 0 ? item.wave + 1 : null
    }));
  const waves = Array.isArray(multi?.waves) ? multi.waves : allocation.waves;
  const observedParallel = Array.isArray(waves) && waves.some(wave => wave.parallel === true);
  const adaptations = (Array.isArray(waves) ? waves : [])
    .filter(wave => ['recruit', 'contract'].includes(wave?.specialistAdaptation?.action))
    .slice(-5).map(wave => ({
      action: wave.specialistAdaptation.action,
      reason: safe(wave.specialistAdaptation.reason, 110),
      wave: Number.isInteger(wave.index) && wave.index >= 0 ? wave.index + 1 : null
    }));
  const isLive = !['complete', 'failed', 'blocked', 'exhausted', 'iterate'].includes(run?.state);
  return {
    roles,
    completed: roles.filter(item => item.status === 'complete').length,
    active: isLive ? roles.filter(item => ['running', 'working', 'queued'].includes(item.status)) : [],
    mode: observedParallel ? 'parallel' : roles.length > 1 ? 'specialists' : 'single',
    maxParallel: Math.max(1, Number(allocation.topology?.maxParallel ?? 1) || 1),
    reason: safe(allocation.topology?.reason || multi?.decision?.reason || '', 100),
    waves: Array.isArray(waves) ? waves.length : 0,
    observedParallel,
    adaptations
  };
}
