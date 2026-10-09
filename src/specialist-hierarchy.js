/**
 * Bounded, task-specific expertise inside the existing agent scheduler.
 * This module recommends second-level advisory roles; it never dispatches
 * an agent, executes a tool, grants permission, or authors a completion claim.
 */
import { specialistBudgetRatio } from './agent-topology-policy.js';
import { subsystemWorkPolicy } from './subsystem-work-policy.js';

const string = x => String(x ?? '').trim();
const unique = a => [...new Set((Array.isArray(a) ? a : []).map(string).filter(Boolean))];
const limit = (value, fallback, max) => Number.isFinite(Number(value))
  ? Math.max(1, Math.min(max, Math.floor(Number(value)))) : fallback;
const budget = n => specialistBudgetRatio(n) ?? 1;
const highRisk = risk => ['critical','high','high-impact','physical','regulated'].includes(string(risk).toLowerCase());
const CODE = Object.freeze({
  'ui-ux': ['ux-designer','frontend-engineer','test-engineer','implementer'],
  frontend: ['frontend-engineer','ux-designer','test-engineer','implementer'],
  backend: ['backend-engineer','test-engineer','security-reviewer','implementer'],
  api: ['api-engineer','backend-engineer','integration-tester','security-reviewer'],
  security: ['security-reviewer','backend-engineer','test-engineer','implementer'],
  storage: ['backend-engineer','database-engineer','performance-reviewer','test-engineer'],
  testing: ['test-engineer','integration-tester','debugger','implementer'],
  infrastructure: ['architect','devops-engineer','reliability-engineer','security-reviewer'],
  general: ['architect','implementer','test-engineer','critic']
});
const RESEARCH = Object.freeze({
  literature: ['literature-reviewer','researcher','citation-auditor'],
  methodology: ['methodology-reviewer','analyst','critic'],
  analysis: ['quantitative-analyst','analyst','methodology-reviewer'],
  citations: ['citation-auditor','researcher','critic'],
  writing: ['academic-writer','citation-auditor','critic'],
  synthesis: ['researcher','analyst','critic']
});
export function codeExpertFocus(subsystem = {}, goal = '') {
  const paths = unique([...(subsystem?.roots ?? []), ...(subsystem?.files ?? [])]).join(' ').toLowerCase();
  const objective = string(goal).toLowerCase();
  if (/(?:^|[/._-])(auth|security|identity|credential)(?:[/._-]|$)/.test(paths)) return 'security';
  if (/(?:^|[/._-])(test|tests|spec|specs|e2e|qa)(?:[/._-]|$)/.test(paths)) return 'testing';
  if (/(?:^|[/._-])(api|apis|endpoint|endpoints|graphql)(?:[/._-]|$)/.test(paths)) return 'api';
  if (/(?:^|[/._-])(database|db|schema|migration|storage)(?:[/._-]|$)/.test(paths)) return 'storage';
  if (/(?:^|[/._-])(ui|ux|design|components|views|screens)(?:[/._-]|$)/.test(paths)) return 'ui-ux';
  if (/(?:^|[/._-])(frontend|client|web|styles|css)(?:[/._-]|$)/.test(paths)) return 'frontend';
  if (/(?:^|[/._-])(backend|server|api|routes|services)(?:[/._-]|$)/.test(paths)) return 'backend';
  if (/(?:^|[/._-])(infra|deploy|docker|ci|ops)(?:[/._-]|$)/.test(paths)) return 'infrastructure';
  if (/\b(ui|ux|accessibility)\b/.test(objective) && /\b(layout|component|screen|interface)\b/.test(objective)) return 'ui-ux';
  return 'general';
}
function capRoles(roles, {remainingBudgetRatio=1, maxRoles=4} = {}) {
  const r = budget(remainingBudgetRatio);
  const width = r < .25 ? 1 : r < .45 ? 2 : limit(maxRoles,4,6);
  return unique(roles).slice(0,width);
}
export function codeSpecialistTeam(subsystem = {}, options = {}) {
  const focus = codeExpertFocus(subsystem, options.goal);
  const roles = capRoles(CODE[focus], options);
  return Object.freeze({
    kind: 'code-subsystem-specialists', depth: 2,
    subsystemId: string(subsystem?.id).slice(0,100),
    focus, roles, leadRole: roles[0] ?? null,
    scope: { roots: unique(subsystem?.roots).slice(0,8), files: unique(subsystem?.files).slice(0,30) },
    parallelEligible: !highRisk(options.risk) && options.independent === true,
    workPolicy: subsystemWorkPolicy({
      surface: 'code', focus, subsystem, goal: options.goal,
      iteration: options.iteration ?? 1, findings: options.findings,
      failure: options.failure, risk: options.risk, complexity: options.complexity,
      uncertainty: options.uncertainty,
      remainingBudgetRatio: options.remainingBudgetRatio,
      independentWork: options.independent === true
    }),
    authority: 'advisory-only', dispatch: 'parent-run-only',
    verification: 'real-diff-tests-and-server-approval'
  });
}
export function researchSpecialistTeams({goal='',researchState={},remainingBudgetRatio=1,risk='ordinary',maxTeams=5,maxRoles=3}={}) {
  const request = string(goal).toLowerCase();
  const thesis = /\b(thesis|dissertation|journal paper|academic paper|manuscript|systematic review)\b/.test(request);
  const methods = /\b(methodology|method|experiment|survey|hypothesis|research design|sampling)\b/.test(request);
  const analysis = /\b(data|statistics?|quantitative|qualitative|regression|dataset|results|analysis)\b/.test(request);
  const sourceCount = Math.max(0, Number(researchState?.sourceCount ?? 0) || 0);
  const gaps = unique(researchState?.unresolvedQuestions).slice(0,6);
  const conflicts = unique(researchState?.conflicts).slice(0,6);
  const observedEvidence = sourceCount > 0 || (Number(researchState?.evidenceCount ?? 0) > 0);
  // Create work only for observed gaps or the stated objective; a thesis
  // drafting agent cannot claim a literature review was already performed.
  const requests = [{focus:'literature', question:gaps[0] || string(goal).slice(0,220), independent:gaps.length>1}];
  if (methods) requests.push({focus:'methodology',question:'Check the study design against supplied evidence',independent:false});
  if (analysis && observedEvidence) requests.push({focus:'analysis',question:'Check observed data and uncertainty',independent:false});
  if (conflicts.length) requests.push({focus:'citations',question:'Reconcile conflicting sources',independent:false});
  if (thesis && observedEvidence) requests.push({focus:'writing',question:'Produce evidence-grounded thesis structure',independent:false});
  if (!thesis && observedEvidence && !methods && !analysis) requests.push({focus:'synthesis',question:'Synthesize verified claims',independent:false});
  const quota = budget(remainingBudgetRatio);
  const width = quota < .25 ? 1 : quota < .45 ? 2 : limit(maxTeams,5,8);
  const teams = requests.slice(0,width).map((request,i)=>{
    const roles = capRoles(RESEARCH[request.focus],{remainingBudgetRatio,maxRoles});
    return Object.freeze({
      id: request.focus+'-'+(i+1), focus:request.focus,
      question:string(request.question).slice(0,260),
      roles, leadRole:roles[0] ?? null, depth:2,
      parallelEligible: !highRisk(risk) && request.independent && quota >= .45,
      workPolicy: subsystemWorkPolicy({
        surface: 'research', focus: request.focus,
        subsystem: { id: request.focus + '-' + (i + 1) },
        goal: request.question || goal, researchState,
        remainingBudgetRatio, risk, independentWork: request.independent
      }),
      status:'candidate-not-dispatched', verifiedSources:false,
      authority:'advisory-only'
    });
  });
  return Object.freeze({kind:'research-subsystem-specialists',depth:2,
    teams, thesis, sourceCount, evidenceReady:observedEvidence,
    noSourceFabrication:true, authority:'parent-run-only'});
}
export function specialistRemit(team, role) {
  if (!team || !Array.isArray(team.roles) || !team.roles.includes(role)) return null;
  return Object.freeze({role, focus:team.focus, subsystemId:team.subsystemId ?? team.id,
    question:team.question ?? null, scope:team.scope ?? null,
    adaptiveWork:team.workPolicy ?? null,
    authority:'advisory-only', peers:'untrusted-data', maySpawnAgents:false});
}
