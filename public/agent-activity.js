/** Evidence-backed work / subsystem / specialist view. Display only saved run outcomes. */
const safe = (value, max = 180) => String(value ?? '').trim().slice(0, max);
const array = value => Array.isArray(value) ? value : [];
const positive = value => Number.isInteger(value) && value > 0 ? value : null;

export function agentActivitySnapshot(run) {
  const tasks = array(run?.tasks);
  const sourceTask = [...tasks].reverse().find(task => task?.evidence?.multiAgent) ?? null;
  const multi = sourceTask?.evidence?.multiAgent ?? run?.adaptation?.multiAgent ?? null;
  const allocation = multi?.allocation ?? {};
  const states = array(multi?.agentStates).length ? multi.agentStates : array(multi?.agents);
  const roles = states.filter(item => item?.role && item.role !== 'arbiter'
    && item.role !== 'integration-arbiter')
    .slice(-11).map(item => ({
      role: safe(item.role, 80),
      specialty: safe(item.specialty || item.role.replaceAll('-', ' '), 110),
      subsystemId: safe(item.subsystemId, 110),
      taskId: safe(item.taskId || sourceTask?.id, 80),
      iteration: positive(item.iteration),
      status: safe(item.status || 'recorded', 30),
      summary: safe(item.summary, 220),
      wave: Number.isInteger(item.wave) && item.wave >= 0 ? item.wave + 1 : null
    }));
  const waves = array(multi?.waves).length ? multi.waves : array(allocation.waves);
  const observedParallel = waves.some(wave => wave.parallel === true);
  const adaptations = waves
    .filter(wave => ['recruit', 'contract'].includes(wave?.specialistAdaptation?.action))
    .slice(-5).map(wave => ({
      action: wave.specialistAdaptation.action,
      reason: safe(wave.specialistAdaptation.reason, 110),
      wave: Number.isInteger(wave.index) && wave.index >= 0 ? wave.index + 1 : null
    }));
  const finalDecision = allocation?.specialistLifecycle;
  if (['recruit', 'contract'].includes(finalDecision?.action)
      && !adaptations.some(item => item.action === finalDecision.action
        && item.reason === safe(finalDecision.reason, 110))) {
    adaptations.push({
      action: finalDecision.action,
      reason: safe(finalDecision.reason, 110),
      wave: null
    });
  }

  // A subsystem appears only after an actual iteration and at least one
  // recorded specialist. The capability flags are needs, never tool receipts.
  const recordedPanels = array(allocation.subsystemPanels)
    .filter(item => positive(item?.iterations)
      && roles.some(role => role.subsystemId === item.subsystemId));
  const subsystemPlan = array(allocation?.subsystemPlan?.subsystems);
  const groups = recordedPanels.slice(-10).map(panel => {
    const scope = subsystemPlan.find(item => item?.id === panel.subsystemId);
    const members = roles.filter(role => role.subsystemId === panel.subsystemId);
    return {
      id: safe(panel.subsystemId, 110),
      label: safe(array(scope?.roots)[0] || panel.subsystemId, 110),
      status: safe(panel.status || 'recorded', 40),
      iterations: positive(panel.iterations) || 1,
      agentCount: members.length,
      members: members.map(item => item.role),
      needed: array(panel?.adaptiveWork?.activated).map(item => safe(item, 35)).filter(Boolean).slice(0, 8)
    };
  });
  // Non-Code panels and older records still get an accurate grouping if they
  // recorded subsystem IDs, without turning predicted work into a real team.
  if (!groups.length) {
    for (const id of [...new Set(roles.map(role => role.subsystemId).filter(Boolean))].slice(0, 10)) {
      const members = roles.filter(role => role.subsystemId === id);
      groups.push({ id, label: id, status: 'recorded', iterations: null,
        agentCount: members.length, members: members.map(item => item.role), needed: [] });
    }
  }

  const isLive = !['complete', 'failed', 'blocked', 'exhausted', 'iterate'].includes(run?.state);
  return {
    roles,
    groups,
    sourceTask: sourceTask ? {
      id: safe(sourceTask.id, 80),
      title: safe(sourceTask.metadata?.title || sourceTask.purpose || sourceTask.id, 120),
      status: safe(sourceTask.status, 30)
    } : null,
    completed: roles.filter(item => item.status === 'complete').length,
    active: isLive ? roles.filter(item => ['running', 'working', 'queued'].includes(item.status)) : [],
    mode: observedParallel ? 'parallel' : roles.length > 1 ? 'specialists' : 'single',
    maxParallel: Math.max(1, Number(allocation.topology?.maxParallel ?? 1) || 1),
    reason: safe(allocation.topology?.reason || multi?.decision?.reason || '', 100),
    waves: waves.length,
    observedParallel,
    adaptations
  };
}
