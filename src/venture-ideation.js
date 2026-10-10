/**
 * Idea-to-product and venture strategy specialities inside the EXISTING
 * Coding/Research parent agent scheduler and server-owned workflow.
 *
 * These are cheap, deterministic task signals and advisory role vocabularies.
 * They do not create agents, provider calls, approvals or executable tools.
 */
const clean = v => String(v ?? '').trim().slice(0, 3000);
const idea = /\b(?:brainstorm|ideat(?:e|ion|ing)|ideas?|concepts?|come up with|opportunit(?:y|ies)|invent|new venture|what (?:should|could) (?:we|i) build|zero to (?:one|product)|from (?:an? )?idea)\b/i;
const business = /\b(?:business|startup|start-up|venture|entrepreneur|customer|commercial|revenue|moneti[sz]|market|saas|business model|go.to.market)\b/i;
const product = /\b(?:build|develop|create|implement|ship|launch|prototype|mvp|app|website|platform|software|product|system|service)\b/i;
const review = /\b(?:validate|assess|evaluate|feasib|challenge|compare|business plan|business model|market research|customer discovery|business strategy)\b/i;
const skip = /\b(?:just (?:build|code|make|implement|do) it|skip (?:the )?(?:ideation|brainstorm(?:ing)?|plan(?:ning)?)|without (?:a )?(?:plan|brainstorm)|no need (?:to )?(?:brainstorm|plan))\b/i;
const maintenance = /\b(?:fix|repair|debug|regression|refactor|patch|bug|lint|crash|error|broken|failing tests?)\b/i;
const explicitExploration = /\b(?:brainstorm|ideat(?:e|ion|ing)|explore (?:ideas|alternatives|concepts)|generate ideas|compare (?:ideas|concepts))\b/i;
const chosenIdea = /\b(?:my idea|our idea|this idea|this concept|my concept|already (?:have|picked|chosen|selected)|chosen idea|selected concept|validate (?:my|this|the) (?:idea|concept)|evaluate (?:my|this|the) (?:idea|concept))\b/i;
const explicitBreadth = /\b(?:brainstorm|ideat(?:e|ion|ing)|generate (?:ideas|concepts)|compare (?:several|multiple|three|3) (?:ideas|concepts)|explore (?:several|different|multiple) (?:ideas|concepts))\b/i;


export function ventureIntent({ goal = '', surface = '' } = {}) {
  const request=clean(goal);
  const workspace=String(surface).toLowerCase();
  const supported=workspace==='code'||workspace==='research';
  const signals={idea:idea.test(request),business:business.test(request),
    product:product.test(request),review:review.test(request)};
  const build=workspace==='code' && signals.product && (signals.idea || signals.business);
  const discovery=supported && !skip.test(request)
    // Names such as "idea service" or "business model module" are not a
    // request to brainstorm during an ordinary maintenance or bug-fix task.
    && (!maintenance.test(request) || explicitExploration.test(request))
    && ((signals.idea && (signals.product || signals.business || signals.review))
      || (signals.business && signals.review)
      || (signals.business && signals.product
        && /\b(?:startup|start-up|launch|new business|venture|saas|from scratch|mvp)\b/i.test(request)));
  return Object.freeze({
    enabled:discovery,
    buildAfterDiscovery:discovery && build,
    domain:workspace,
    kind:build?'idea-to-build':discovery?'venture-discovery':'none',
    signals:Object.freeze(signals),
    reason:discovery?'explicit-idea-or-business-discovery-required':'no-extra-venture-phase'
  });
}

/**
 * Choose the LEAST exploratory work that still serves the real request.
 * Unknown markets remain assumptions; this only decides ideation breadth.
 */
export function ventureExplorationPolicy({goal='',surface='',situation={}}={}) {
  const intent=ventureIntent({goal,surface});
  if(!intent.enabled)return Object.freeze({mode:'skip',minAlternatives:0,reason:'venture-phase-not-needed'});
  const request=clean(goal);
  const breadth=explicitBreadth.test(request);
  const selected=chosenIdea.test(request);
  const lowBudget=Number(situation?.resourceBudgetRatio) >= 0
    && situation?.resourceBudgetRatio != null && Number(situation.resourceBudgetRatio)<.25;
  const mode=breadth?'divergent':selected?'validate-selected':'focused';
  return Object.freeze({
    mode,minAlternatives:mode==='divergent'?3:mode==='focused'&&!lowBudget?2:1,
    reason:breadth?'user-requested-distinct-ideas'
      :selected?'respect-user-selected-concept':'focus-on-practical-options'
  });
}

const roles=[
  ['venture-ideation-lead',
    'Generate genuinely different user-problem solutions, counterexamples and a testable selection.',
    'problem-reframing|divergent-concepts|nonobvious-approaches|user-value-mapping|concept-tradeoffs|selection-criteria|assumption-tracking|ethical-screening|smallest-experiment|idea-synthesis'],
  ['customer-discovery-lead',
    'Identify target users, urgent jobs, switching barriers and cheap tests of demand without inventing interviews.',
    'customer-personas-as-hypotheses|jobs-to-be-done|pain-intensity|customer-journey|interview-plan|recruitment-bias|existing-workarounds|demand-signals|assumption-register|validation-metrics'],
  ['business-model-lead',
    'Examine revenue, costs, pricing, channels and viability without fabricated market figures.',
    'value-proposition|business-model-canvas|pricing-hypotheses|unit-economics|distribution-channels|customer-acquisition-cost|lifetime-value-assumptions|cash-burn|profit-scenarios|business-risk'],
  ['market-validation-lead',
    'Compare alternatives and competitor evidence; distinguish researched facts from hypotheses.',
    'market-segmentation|competitor-mapping|substitutes|market-size-method|source-freshness|primary-evidence|differentiation|adoption-friction|opportunity-ranking|unvalidated-claims'],
  ['venture-feasibility-lead',
    'Challenge technical, ethical, regulatory, financial and execution assumptions with decisive go/no-go tests.',
    'technical-feasibility|time-budget-scope|operational-dependencies|privacy-security|legal-unknowns|failure-modes|evidence-gaps|experimentation-cost|decision-thresholds|pivot-or-stop'],
  ['product-mvp-lead',
    'Translate the selected customer problem and decision into a small testable product, scoped to approved changes.',
    'user-story-mapping|mvp-inclusions|non-goals|acceptance-tests|architecture-tradeoffs|ux-first-run|observability-metrics|implementation-phases|revision-safety|release-readiness']
];
export const VENTURE_AGENTS=Object.freeze(Object.fromEntries(roles.map(([role,purpose,skills])=>[
  role,Object.freeze({
    purpose:purpose+' Advisory only: no write, tool, launch or business-action authority.',
    bestFor:Object.freeze(['understand','step','plan','investigate','reassess','build-code','code']),
    children:Object.freeze(skills.split('|'))
  })
])));

export function ventureRolePriority({goal='',surface='',task={},run={}}={}) {
  const intent=ventureIntent({goal,surface});
  if(!intent.enabled)return Object.freeze([]);
  const discovered=(run?.tasks??[]).some(item=>item?.metadata?.ventureDiscovery===true
    && item?.status==='complete');
  const type=String(task?.type??'');
  let ranks=[];
  if(task?.metadata?.ventureDiscovery===true || task?.ventureDiscovery===true || type==='understand') {
    const policy=ventureExplorationPolicy({goal,surface,situation:run?.situation});
    ranks=policy.mode==='divergent'
      ? ['venture-ideation-lead','customer-discovery-lead','business-model-lead',
        'venture-feasibility-lead','market-validation-lead']
      : ['venture-feasibility-lead','customer-discovery-lead','market-validation-lead',
        'product-mvp-lead','business-model-lead'];
  } else if(type==='investigate') {
    ranks=['market-validation-lead','customer-discovery-lead','venture-feasibility-lead'];
  } else if(task?.metadata?.buildPlan===true || task?.buildPlan===true || type==='plan') {
    ranks=['product-mvp-lead','venture-feasibility-lead','business-model-lead'];
  } else if((task?.id==='build-code'||type==='code') && (discovered || intent.buildAfterDiscovery)) {
    ranks=['product-mvp-lead','venture-feasibility-lead'];
  } else if(type==='step'||type==='reassess') {
    ranks=['venture-feasibility-lead','customer-discovery-lead'];
  }
  return Object.freeze(ranks);
}

export function ventureRoleScore(role,{goal='',surface='',task={},run={}}={}) {
  const ranks=ventureRolePriority({goal,surface,task,run});
  const at=ranks.indexOf(role);
  return at<0?0:Math.max(.78,1.12-at*.065);
}

export function ventureRoleAssignment(role,{
  goal='',surface='',task={},run={},remainingBudgetRatio=null
}={}) {
  const spec=VENTURE_AGENTS[role];
  if(!spec || !ventureRolePriority({goal,surface,task,run}).includes(role))return null;
  // Each agent has a broad reusable child-skill pool; admit just the lenses
  // that this exact task, acceptance set, observed uncertainty and budget
  // warrant. No per-main-agent fixed number, and no extra child model calls.
  const situation=run?.situation??{};
  const complexity=Math.max(0,Math.min(1,Number(situation.complexity)||0));
  const uncertainty=Math.max(0,Math.min(1,Number(situation.uncertainty)||0));
  const criteria=Array.isArray(situation.successCriteria)?situation.successCriteria:[];
  const needs=[goal,task?.purpose,...criteria,...(Array.isArray(situation.unknowns)
    ? situation.unknowns:[])].map(item=>typeof item==='string'?item:item?.description??'')
    .join(' ').toLowerCase().slice(0,6500);
  const tokens=new Set((needs.match(/[a-z]{4,}/g)??[]));
  const ratio=remainingBudgetRatio===null||remainingBudgetRatio===undefined
    ?1:Math.max(0,Math.min(1,Number(remainingBudgetRatio)||0));
  const pressure=Math.max(complexity,uncertainty,Math.min(.9,criteria.length*.14));
  const maxActive=ratio<.2?1:ratio<.4?2
    :Math.min(spec.children.length,Math.max(3,Math.round(3+pressure*6)));
  const scored=spec.children.map((skill,index)=>{
    const words=skill.split('-').filter(word=>word.length>3);
    const hits=words.filter(word=>tokens.has(word)||needs.includes(word)).length;
    return {skill,index,score:hits*2+(!index?1:0)};
  }).sort((a,b)=>b.score-a.score||a.index-b.index);
  const selected=scored.slice(0,maxActive).sort((a,b)=>a.index-b.index)
    .map(item=>item.skill);
  return Object.freeze({
    role,phase:(task?.ventureDiscovery||task?.metadata?.ventureDiscovery)?'explore-and-select'
      :(task?.buildPlan||task?.metadata?.buildPlan)?'plan-approved-mvp-scope':'check-current-venture-need',
    skills:Object.freeze(selected),availableSkills:spec.children.length,
    selectedSkills:selected.length,
    selectionPolicy:'task-and-budget-specific-read-only-advisory-lenses',
    responsibility:spec.purpose,
    approvalBoundary:'proposed-idea-is-not-approval-to-build-or-launch',
    evidenceBoundary:'unverified-market-numbers-and-customer-interviews-must-be-labeled'
  });
}

export function ventureDiscoveryStep({goal='',surface='',situation={}}={}) {
  const policy=ventureExplorationPolicy({goal,surface,situation});
  if(policy.mode==='skip')return null;
  const direction=policy.mode==='divergent'
    ? 'Explore at least three meaningfully different solutions, not three names for one product. Compare them against the user problem and identify a practical winner.'
    : policy.mode==='validate-selected'
      ? 'Keep the user-selected idea as the default. Test its strongest assumptions, compare a meaningful counterexample only if relevant, and do not replace the idea without user direction.'
      : 'Clarify the proposed concept and briefly compare it with one plausible alternative. Focus on validation and the smallest viable scope rather than a large speculative idea catalog.';
  return Object.freeze({
    type:'step',
    title:policy.mode==='divergent'?'Explore and test the idea':'Validate the proposed direction',
    ventureDiscovery:true,ventureMode:policy.mode,
    purpose:direction+' Identify the target user, unmet need, practical constraints, evidence versus hypotheses, business assumptions, feasibility, main risk, smallest useful validation experiment, and measurable success criteria. Recommend a lean MVP with explicit non-goals. Never invent market numbers, customer interviews, prior-art searches, verification receipts or authorization to build.'
  });
}
