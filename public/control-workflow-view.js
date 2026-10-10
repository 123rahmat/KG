/** Pure, truthful copy for Coding and Research project chat status. */
const t = x => String(x ?? '').trim();
const LABELS = Object.freeze({
  'clarify':'Clarify the requested work',
  'approval-required':'Approval needed before changing anything',
  'budget-gate':'Optional compute is restricted by remaining budget',
  'reuse-verified-answer':'Reuse prior verified evidence',
  'answer':'Answer the technical question',
  'plan':'Plan only the necessary dependencies',
  'implement':'Implement the scoped change',
  'investigate':'Investigate outstanding evidence',
  'brainstorm':'Explore alternative approaches',
  'resolve-evidence-conflict':'Investigate conflicting findings',
  'repair-from-evidence':'Repair after an observed failure',
  'deliver':'Prepare the verified outcome'
});

export function controlWorkflowChatView(run, selectedSurface) {
  const surface = t(run?.surface).toLowerCase();
  if (!['code','research'].includes(surface) || surface !== t(selectedSurface).toLowerCase())
    return null;
  const control = run?.adaptation?.modeController
    ?? run?.adaptation?.unifiedAdaptiveWorkflow?.modeController;
  const workflow = control?.workflowPolicy;
  if (!workflow || workflow.advisoryOnly !== true
    || workflow.controller !== (surface === 'code' ? 'coding' : 'research')) return null;
  const predictedStages = Array.isArray(workflow.candidateStages) ? workflow.candidateStages : [];
  const compute = workflow.compute ?? {};
  const quality = workflow.quality ?? {};
  const mandatory = compute.mandatoryVerification === true;
  return Object.freeze({
    engineLabel: surface === 'code' ? 'Coding Control' : 'Research Control',
    title: LABELS[t(workflow.action)] ?? 'Choose the smallest useful next step',
    suggestion: predictedStages.length
      ? 'Suggested next stages: ' + predictedStages.slice(0, 5).map(x => t(x.id)).filter(Boolean).join(' → ')
      : 'No additional workflow stages suggested',
    effort: ['low','medium','high'].includes(t(compute.modelEffort))
      ? 'Suggested reasoning: ' + t(compute.modelEffort) : 'Suggested reasoning: adaptive',
    cost: compute.optionalAgentCeiling > 0
      ? 'Up to ' + Math.min(4, Math.floor(compute.optionalAgentCeiling)) + ' optional specialists when justified'
      : 'No optional specialist calls suggested',
    verification: mandatory
      ? 'Verification is required before claiming completion'
      : 'Verification adapts to the answer and evidence',
    evidence: Array.isArray(quality.missingEvidence) && quality.missingEvidence.length
      ? quality.missingEvidence.length + ' proposed evidence check(s) not yet established'
      : 'No additional evidence gaps identified by this advisory',
    footer: 'These are policy suggestions, not completed work, verified evidence, or guaranteed model calls.'
  });
}
