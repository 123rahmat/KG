/** Evidence-backed work / subsystem / specialist view. Display only saved run outcomes. */
const safe = (value, max = 180) => String(value ?? '').trim().slice(0, max);
const array = value => Array.isArray(value) ? value : [];
const positive = value => Number.isInteger(value) && value > 0 ? value : null;

export function agentActivitySnapshot(run) {
  const surface=String(run?.surface||run?.adaptation?.primarySurface||'').trim().toLowerCase();
  // User-facing everyday chat is not an agentic workspace. Suppress stale
  // activity inherited from older runs, not merely the recruiter itself.
  if(['normal-chat','chat','visual','design'].includes(surface)){
    return {roles:[],groups:[],sourceTask:null,completed:0,active:[],
      mode:'direct',maxParallel:1,
      reason:'direct-conversation-no-agent-recruitment',
      waves:0,observedParallel:false,adaptations:[],lifecycleChanges:[],delegationRequests:[]};
  }
  const tasks = array(run?.tasks);
  const sourceTask = [...tasks].reverse().find(task => task?.evidence?.multiAgent) ?? null;
  const multi = sourceTask?.evidence?.multiAgent ?? run?.adaptation?.multiAgent ?? null;
  const allocation = multi?.allocation ?? {};
  const selectedWhy = new Map(array(allocation?.selectionRationale?.roles)
    .filter(item => item?.role && item?.why).map(item => [item.role, safe(item.why, 230)]));
  // Only explicitly recorded agent proposals appear; never infer that tools
  // are installed, resources are allocated or terminal sessions are open.
  const admissions = new Map(array(multi?.resourceAdmissions)
    .filter(item=>item && item.executed===false)
    .slice(0,8).map(item=>[safe(item.kind,48)+':'+safe(item.parentRole,80),item]));
  const delegationRequests = array(multi?.resourceRequests ?? allocation?.resourceRequests)
    .filter(item=>item && item.status==='proposal-only' && item.ran===false)
    .slice(0,8).map(item=>{
      const kind=safe(item.kind,48);
      const parentRole=safe(item.parentRole,80);
      const admitted=admissions.get(kind+':'+parentRole);
      const state=safe(admitted?.status || item.state,65);
      return {
        kind,reason:safe(item.reason,220),
        parentRole,childId:safe(item.childId,84),
        state,
        status: state==='read-only-tool-available' ? 'Read-only tool available · not executed'
          : state==='awaiting-user-approval' ? 'Approval required · not executed'
          : state==='parent-executor-required' ? 'Parent executor required · not executed'
          : state==='parent-schedules-advisory' ? 'Specialist consultation proposed'
          : state==='manual-user-action' ? 'User-controlled terminal only'
          : admitted?.code ? 'Unavailable · '+safe(admitted.code,48) : 'Proposed · not executed'
      };
    });
  const states = array(multi?.agentStates).length ? multi.agentStates : array(multi?.agents);
  const roles = states.filter(item => item?.role && item.role !== 'arbiter'
    && item.role !== 'integration-arbiter')
    .slice(-11).map(item => ({
      role: safe(item.role, 80),
      kind: item.subagent === true || String(item.role).startsWith('child:') ? 'subagent' : 'specialist',
      parentRole: safe(item.parentRole || (String(item.role).startsWith('child:')
        ? String(item.role).split(':')[1] : ''), 80),
      displayRole: safe(String(item.role).startsWith('child:')
        ? String(item.role).split(':').slice(2).join(':').replaceAll('-', ' ')
        : String(item.role).replaceAll('-', ' '), 100),
      verification: item.subagent === true ? 'unverified-advisory' : '',
      specialty: safe(item.specialty || item.role.replaceAll('-', ' '), 110),
      selectionWhy: selectedWhy.get(item.role) || '',
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

  // Admissions and retirements are saved *selection* events at safe
  // wave boundaries; they do not prove the selected model was called.
  const lifecycleChanges = array(allocation?.recruitmentHistory)
    .filter(item => item && (
      array(item.recruitRoles).length || array(item.retireRoles).length
      || array(item.recruitSubagents).length || array(item.retireSubagents).length
    )).slice(-6).map(item => ({
      wave: Number.isInteger(item.waveIndex) && item.waveIndex>=0 ? item.waveIndex+1 : null,
      recruitedRoles: array(item.recruitRoles).slice(0,6).map(x=>safe(x,75)),
      retiredRoles: array(item.retireRoles).slice(0,6).map(x=>safe(x,75)),
      recruitedChildren: array(item.recruitSubagents).length,
      retiredChildren: array(item.retireSubagents).length,
      reason: safe(item.reason,115), status:'saved-advisory-selection'
    }));
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

  // Persisted agent records from an earlier task may still carry a "running"
  // status after the parent has advanced. Only the same currently-running
  // task can produce active-agent UI. Never animate stale or orphaned records.
  const sourceIsCurrent = sourceTask?.status === 'running'
    && (!run?.next || run.next === sourceTask.id);
  const isLive = sourceIsCurrent
    && !['complete', 'failed', 'blocked', 'exhausted', 'iterate', 'waiting'].includes(run?.state);
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
    adaptations,
    lifecycleChanges,
    delegationRequests
  };
}
