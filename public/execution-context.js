/** Bind in-memory continuation to the current server-owned execution request. */
export function executionContextKey(run, { principalId, workspaceId } = {}) {
  const task = run?.tasks?.find(item => item.id === run.next);
  const challenge = task?.metadata?.executionChallenge;
  const round = (run?.adaptation?.codeRepairs ?? []).filter(item => Number(item.attempt) === Number(run?.attempt)).length;
  return JSON.stringify([run?.id, run?.next, run?.attempt, round, principalId, workspaceId,
    challenge?.executionId, challenge?.nonceHash, challenge?.payloadDigest, challenge?.expiresAt]);
}

export function executionContextCurrent(context, run, scope) {
  const challenge = run?.tasks?.find(item => item.id === run.next)?.metadata?.executionChallenge;
  return context === executionContextKey(run, scope)
    && (!challenge?.expiresAt || Date.parse(challenge.expiresAt) > Date.now());
}
