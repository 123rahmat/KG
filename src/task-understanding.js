/** Task understanding for native Coding and Research project chats. */
import { assessWorkDomain } from './work-domain.js';
const text = value => String(value ?? '').trim();
const IMPLEMENT = /\b(?:build|implement|fix|repair|change|edit|update|modify|integrate|create|develop|write (?:code|a program)|run tests|deploy|migrate|refactor|generate)\b/i;
const EXPLORE = /\b(?:brainstorm|ideas?|alternatives?|possible topics?|explore|compare approaches|options?|hypothes(?:is|es)|research gaps?)\b/i;
const PLAN = /\b(?:plan|roadmap|architecture|proposal|outline|milestones?|design the system|methodology|study protocol)\b/i;
const VERIFY = /\b(?:verify|validate|review|audit|check|test|reproduce|proofread|fact[- ]check)\b/i;
const LARGE = /\b(?:entire|whole|full|complete|end[- ]to[- ]end|multi[- ]file|multiple modules|from scratch|production|thesis|dissertation|systematic review|research paper|distributed system|platform)\b/i;

export function understandTask({
  request = '', projectContext = {}, conversation = [], assessment = null
} = {}) {
  const scope = assessment || assessWorkDomain({ request, projectContext, conversation });
  const goal = text(scope.supportedRequest || request).slice(0, 12000);
  const intent = VERIFY.test(goal) && !IMPLEMENT.test(goal) ? 'verify'
    : EXPLORE.test(goal) && !IMPLEMENT.test(goal) ? 'explore'
      : PLAN.test(goal) && !IMPLEMENT.test(goal) ? 'plan'
        : IMPLEMENT.test(goal) ? 'implement'
          : 'answer';
  const needsBrainstorming = intent === 'explore' || (
    /\b(?:invent|choose (?:a|the) (?:best|right) approach)\b/i.test(goal));
  const needsPlan = intent === 'plan' || (intent === 'implement' && LARGE.test(goal));
  const materialUnknowns = scope.status === 'needs-clarification'
    ? [scope.reply || 'Clarify the purpose of this task.'] : [];
  const successCriteria = scope.status === 'in-scope' || scope.status === 'mixed'
    ? [scope.domain === 'coding'
        ? (intent === 'implement'
          ? 'Deliver scoped software changes with actual recorded checks or report not run.'
          : 'Give a technically correct answer grounded in the selected project revision.')
        : 'Support material research claims with traceable sources, methods and honest gaps.']
    : [];
  return Object.freeze({
    domain: scope.domain,
    scopeStatus: scope.status,
    deliverable: goal,
    intent,
    constraints: Array.isArray(projectContext?.constraints)
      ? projectContext.constraints.filter(item => typeof item === 'string').slice(0, 20) : [],
    successCriteria,
    materialUnknowns,
    sourceRefs: Array.isArray(projectContext?.sourceRefs) ? projectContext.sourceRefs.slice(0, 30) : [],
    needsBrainstorming,
    needsPlan,
    needsClarification: scope.status === 'needs-clarification',
    authorizationRequired: intent === 'implement' && Boolean(projectContext?.externalMutation),
    rationaleCode: scope.rationaleCode
  });
}
