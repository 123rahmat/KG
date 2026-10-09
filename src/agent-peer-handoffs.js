/**
 * Scoped cross-wave specialist handoffs.
 * Peer findings are always untrusted advisory data, never permission or proof.
 * Handoffs are created only from completed, parsed findings in the parent run.
 */
const ALLOWED_TYPES = new Set(['finding','risk','question','contract','test-result','blocker']);
const bounded = (value,n) => String(value ?? '').trim().slice(0,n);
export function createAgentHandoff({runId,taskId,from,to,type='finding',summary='',scope='current-task'}={}) {
  const message = {
    runId:bounded(runId,120), taskId:bounded(taskId,120),
    from:bounded(from,90), to:bounded(to,90),
    type:ALLOWED_TYPES.has(type) ? type : 'finding',
    summary:bounded(summary,480),
    scope:bounded(scope,120), trust:'untrusted-advisory',
    authorizesTools:false, verified:false
  };
  if (!message.runId || !message.taskId || !message.from || !message.to ||
      message.from === message.to || !message.summary || !message.scope) return null;
  return Object.freeze(message);
}
/** Only prior wave results for the SAME server-owned run/task are eligible. */
export function peerHandoffsFor({runId,taskId,toRole,findings=[],maxMessages=3,scope='current-task'}={}) {
  const recipient = bounded(toRole,90);
  if (!recipient || !bounded(runId,120) || !bounded(taskId,120)) return [];
  const limit = Math.max(0,Math.min(4,Math.floor(Number(maxMessages) || 0)));
  const unique = new Set();
  const out = [];
  for (const item of [...(Array.isArray(findings) ? findings : [])].reverse()) {
    if (out.length >= limit) break;
    if (!item || (item.status && item.status !== 'complete') ||
        (item.runId && bounded(item.runId,120) !== bounded(runId,120)) ||
        (item.taskId && bounded(item.taskId,120) !== bounded(taskId,120)) ||
        (item.verified === false && item.summary == null)) continue;
    // Subsystem-local findings cannot leak to general panels.
    if (item.subsystemId || item.projectRevision || item.externalScope) continue;
    const source = bounded(item.role,90);
    if (!source || source === recipient || unique.has(source)) continue;
    const recommendation = bounded(item.recommendation,30).toLowerCase();
    const type = recommendation === 'stop' || recommendation === 'revise' ? 'risk' : 'finding';
    const message = createAgentHandoff({
      runId,taskId,from:source,to:recipient,type,
      summary:item.summary,scope
    });
    if (!message) continue;
    unique.add(source);
    out.push(message);
  }
  return out.reverse();
}
