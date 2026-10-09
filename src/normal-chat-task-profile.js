/**
 * Everyday Normal Chat task profile.
 * Advisory only: never grants tools, execution, memory, or workspace changes.
 */
const text = value => String(value ?? '').trim();
const clamp = value => Math.min(1, Math.max(0,
  Number.isFinite(Number(value)) ? Number(value) : 0));
const TEACH = /\b(?:teach|lesson|homework|school|student|study|curriculum|course|exam|tutor|learn|educat\w*|explain|practice|quiz|revision|math(?:ematics|ematical)?|theorem|algebra|calculus|geometry|physics|chemistry|history|biology)\b/i;
const BUSINESS = /\b(?:business plan|startup|strategy|market analysis|marketing plan|pricing strategy|revenue|break-even|forecast|business model|product launch|customer research|investment case|financial plan|cash flow|sales plan|entrepreneur\w*)\b/i;
const FILE_WORK = /\b(?:file|files|document|documents|spreadsheet|pdf|word|excel|powerpoint|slides|report|attachment|csv|docx|xlsx|pptx|preview|rewrite|edit|transform|merge|convert)\b/i;
const VISUAL = /\b(?:visuals?|visuali[sz](?:e|ation)|diagram|infographic|flowchart|chart|graph|illustration|render|dashboard|mockup|logo|poster|image|images)\b/i;
const HARD_REASONING = /\b(?:prove|proof|derive|derivation|multi[- ]step|step[- ]by[- ]step|complex reasoning|deep (?:think|thinking|reasoning)|challenging|difficult|optimi[sz]e|trade[- ]offs?|scenario analys\w*|sensitivity analys\w*|differential equation|calculate and verify|root cause|evaluate alternatives)\b/i;
const MULTIFILE = /\b(?:multiple|several|across|all|batch|many|combined|compare|reconcile|consistent|simultaneous)\b/i;
const COMPARISON = /\b(?:compare|comparison|versus|vs\.?|trade[- ]offs?|alternatives?|options?|pros and cons|decision matrix|scenario)\b/i;
const PROCEDURE = /\b(?:teach|tutor|solve|calculate|step[- ]by[- ]step|worked example|practice|deriv(?:e|ation)|prove|proof)\b/i;
const RISK = /^(?:critical|high|high-impact|physical|regulated)$/i;

export function normalChatTaskProfile({
  goal = '', attachments = [], complexity = 0, uncertainty = 0,
  risk = 'medium', verificationRequired = false
} = {}) {
  const question = text(goal).slice(0, 3000);
  const files = Array.isArray(attachments) ? attachments : [];
  const fileIntent = files.length > 0 || FILE_WORK.test(question);
  const visualIntent = VISUAL.test(question);
  const complexFileWork = fileIntent && (files.length > 1 || MULTIFILE.test(question));
  const domain = fileIntent ? 'file-work'
    : visualIntent ? 'visual-creation'
      : BUSINESS.test(question) ? 'business-planning'
        : TEACH.test(question) ? 'education'
          : HARD_REASONING.test(question) ? 'reasoning' : 'everyday';
  const depthScore = Math.max(clamp(complexity), clamp(uncertainty) * .85,
    HARD_REASONING.test(question) ? .78 : 0,
    complexFileWork ? .42 : 0);
  const reasoningDepth = depthScore >= .7 ? 'deep'
    : depthScore >= .3 || domain !== 'everyday' ? 'focused' : 'direct';
  // These are display suggestions, never tool instructions or hidden reasoning traces.
  const presentation = Object.freeze({
    mode: complexFileWork ? 'file-workflow'
      : visualIntent ? 'visual-first'
        : COMPARISON.test(question) ? 'comparison'
          : domain === 'education' && PROCEDURE.test(question) ? 'worked-example'
            : 'conversational',
    showTableWhenUseful: COMPARISON.test(question),
    showWorkedExample: domain === 'education' && PROCEDURE.test(question),
    showFileProgress: fileIntent,
    showVisualWhenUseful: visualIntent,
    allowDeepReasoning: reasoningDepth === 'deep'
  });
  const verify = verificationRequired || RISK.test(text(risk))
    || fileIntent || visualIntent
    || /\b(?:calculate|forecast|prove|citation|fact[- ]check)\b/i.test(question);
  const priorities = fileIntent
    ? ['current-request','selected-attachments','active-conversation',
      ...(complexFileWork ? ['cross-file-consistency'] : []),
      ...(visualIntent ? ['rendered-preview'] : []), 'artifact-integrity']
    : visualIntent
      ? ['current-request','visual-requirements','active-conversation','rendered-preview']
      : domain === 'education'
        ? ['current-request','learner-goal','active-conversation','worked-examples']
        : domain === 'business-planning'
          ? ['current-request','assumptions-and-constraints','active-conversation','scenario-evidence']
          : ['current-request','active-conversation','material-evidence'];
  return Object.freeze({
    workspace: 'normal-chat', domain, reasoningDepth, presentation,
    contextPriorities: Object.freeze(priorities),
    verification: verify ? 'check-observable-claims-and-artifacts' : 'sufficient-and-clear',
    toolPolicy: 'just-in-time-authorized-only',
    agentPolicy: 'single-primary-model-no-specialist-recruitment',
    suggestedTransition: null,
    serverAuthorityRequired: true
  });
}
