/**
 * The everyday Normal Chat envelope. Classifies the current request to help
 * choose sufficient reasoning/context, not to route into another workspace.
 * Never grants tools, reads private memory or controls execution.
 */
const text = value => String(value ?? '').trim();
const clamp = value => Math.min(1, Math.max(0,
  Number.isFinite(Number(value)) ? Number(value) : 0));
const TEACH = /\b(?:teach|lesson|homework|school|student|study|curriculum|course|exam|tutor|learn|educat\w*|explain|practice|quiz|revision|math(?:ematics|ematical)?|theorem|algebra|calculus|geometry|physics|chemistry|history|biology)\b/i;
const BUSINESS = /\b(?:business plan|startup|strategy|market analysis|marketing plan|pricing strategy|revenue|break-even|forecast|business model|product launch|customer research|investment case|financial plan|cash flow|sales plan|entrepreneur\w*)\b/i;
const FILE_WORK = /\b(?:file|files|document|documents|spreadsheet|pdf|word|excel|powerpoint|slides|report|attachment|csv|docx|xlsx|pptx|preview|rewrite|edit|transform)\b/i;
const HARD_REASONING = /\b(?:prove|proof|derive|derivation|multi[- ]step|step[- ]by[- ]step|complex reasoning|challenging|difficult|optimi[sz]e|trade[- ]offs?|scenario analys\w*|sensitivity analys\w*|differential equation|calculate and verify|root cause|evaluate alternatives)\b/i;
const RISK = /^(?:critical|high|high-impact|physical|regulated)$/i;

export function normalChatTaskProfile({
  goal = '', attachments = [], complexity = 0, uncertainty = 0,
  risk = 'medium', verificationRequired = false
} = {}) {
  const question = text(goal).slice(0, 3000);
  const files = Array.isArray(attachments) ? attachments : [];
  const domain = files.length || FILE_WORK.test(question) ? 'file-work'
    : BUSINESS.test(question) ? 'business-planning'
      : TEACH.test(question) ? 'education'
        : HARD_REASONING.test(question) ? 'reasoning' : 'everyday';
  const depthScore = Math.max(clamp(complexity), clamp(uncertainty) * .85,
    HARD_REASONING.test(question) ? .78 : 0);
  const reasoningDepth = depthScore >= .7 ? 'deep'
    : depthScore >= .3 || domain !== 'everyday' ? 'focused' : 'direct';
  const verify = verificationRequired || RISK.test(text(risk))
    || domain === 'file-work' || /\b(?:calculate|forecast|prove|citation|fact[- ]check)\b/i.test(question);
  const priorities = domain === 'file-work'
    ? ['current-request','selected-attachments','active-conversation','artifact-integrity']
    : domain === 'education'
      ? ['current-request','learner-goal','active-conversation','worked-examples']
      : domain === 'business-planning'
        ? ['current-request','assumptions-and-constraints','active-conversation','scenario-evidence']
        : ['current-request','active-conversation','material-evidence'];
  return Object.freeze({
    workspace: 'normal-chat', domain, reasoningDepth,
    contextPriorities: Object.freeze(priorities),
    verification: verify ? 'check-observable-claims-and-artifacts' : 'sufficient-and-clear',
    toolPolicy: 'just-in-time-authorized-only',
    agentPolicy: 'one-model-first-recruit-only-when-useful',
    suggestedTransition: null,
    serverAuthorityRequired: true
  });
}
