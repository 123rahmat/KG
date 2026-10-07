/**
 * Product surface policy.
 *
 * One adaptive intelligence core, exactly three user-facing workspaces:
 * NormalChat, Code, and Research. Files, visuals, artifacts, and tools are
 * capabilities inside those workspaces, not additional product surfaces.
 */
import { classifyAttachmentSet } from './documents.js';

const text = value => String(value ?? '').trim();
const CODE = /\b(?:code|coding|program|programming|debug|debugging|refactor|repository|repo|pull request|branch|commit|function|class|bug|stack trace|compile|test suite|unit test|typescript|javascript|python|rust|golang|java|sql|api|backend|frontend|software|app|application|website|web app|github|simulation|simulate|simulating|computational model|numerical model)\b|\b[\w-]+\.(?:py|js|mjs|cjs|ts|tsx|jsx|go|rs|java|kt|c|cc|cpp|h|hpp|cs|rb|php|swift|sql|sh|html|css|json)\b/i;
const RESEARCH_DEEP = /\b(?:research|deep research|investigate|literature review|systematic review|academic papers?|sources?|citations?|references?|evidence|state of the art|comprehensive(?:ly)?|in[- ]depth|fact[- ]check|latest|current|search the web|web search|browse|compare .*sources)\b/i;
const CURRENT_FACTS = /\b(?:latest|today|current|currently|right now|this week|live|recent|news|price|prices|rate|rates|weather|scores?)\b/i;
const CODE_PROJECT_SCOPE = /\b(?:repository|repo|codebase|project|code workspace|github|pull request|branch|commit|multi[- ]file|multiple files|whole app|whole application|service|backend|frontend|api|deployment|deploy)\b/i;
const CODE_SINGLE_SCOPE = /\b(?:function|method|class|variable|snippet|script|single file|this file|one file|small fix|small change|edit this file|fix this file|explain this code|review this code|run this script|test this file|small program|utility script)\b/i;
const EXPLICIT_CODE = /\b(?:switch|move|open|use|take me to|continue in|work in)\s+(?:the\s+)?(?:code|coding)(?:\s+workspace)?\b|\b(?:code|coding)\s+workspace\b/i;
const EXPLICIT_RESEARCH = /\b(?:switch|move|open|use|take me to|continue in|work in)\s+(?:the\s+)?research(?:\s+workspace)?\b|\b(?:research|deep research)\s+workspace\b/i;
const MEDIUM_ANALYSIS = /\b(?:explain|compare|analy[sz]e|solve|calculate|derive|show|teach|why|how|which|evaluate|recommend|suggest|summari[sz]e|interpret|design|visual|poster|logo|diagram|presentation)\b/i;

const aliases = Object.freeze({ chat:'normal-chat', visual:'normal-chat', design:'normal-chat', 'normal-chat':'normal-chat', code:'code', research:'research' });
const normalizeSurfaceId = value => aliases[text(value).toLowerCase()] ?? 'normal-chat';
const attachmentProfile = attachments => classifyAttachmentSet(Array.isArray(attachments) ? attachments : []);
const names = attachments => (Array.isArray(attachments)?attachments:[]).map(x=>text(typeof x==='string'?x:x?.name)).filter(Boolean);
const kinds = attachments => (Array.isArray(attachments)?attachments:[]).map(x=>typeof x==='object'?text(x?.archiveKind):'').filter(Boolean);

function shouldUseCodeWorkspace(value, attachments, actions=[]) {
  const profile=attachmentProfile(attachments);
  if (EXPLICIT_CODE.test(value) || profile.kind==='code' || kinds(attachments).includes('code-project')) return true;
  if (!CODE.test(value)) return false;
  if (CODE_PROJECT_SCOPE.test(value) || profile.codeFiles?.some(name=>/(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|Dockerfile|Makefile|requirements\.txt)$/i.test(name))) return true;
  if (names(attachments).length===1 || CODE_SINGLE_SCOPE.test(value)) return false;
  return actions.some(a=>['create','transform','execute'].includes(text(a).toLowerCase()));
}

export const SURFACE_INTELLIGENCE_PROFILES=Object.freeze({
  'normal-chat':Object.freeze({
    id:'normal-chat-intelligence', maturity:'adaptive-general', priority:'speed-first, then depth',
    contextStrategy:'minimum-sufficient-context', planningStrategy:'single-next-step',
    agentStrategy:'direct-first; add specialists only when they materially improve the result',
    parallelStrategy:'parallelize independent read-only work only when latency benefit exceeds coordination cost',
    verificationStrategy:'verify when claims, files, tools, transformations or stakes justify it',
    continuityStrategy:'preserve conversation and artifact context without forced escalation',
    costStrategy:'prefer the minimum-sufficient model tier, one agent by default, and bounded context; escalate only when quality, uncertainty, verification or risk can change the outcome',
    qualityStrategy:'clarity, usefulness, correct context selection, honest uncertainty',
    preferredRoles:Object.freeze(['communicator','analyst','researcher','critic','visual-designer'])
  }),
  code:Object.freeze({
    id:'code-intelligence', maturity:'deep-engineering', priority:'correctness and safe change, with critical-path speed',
    contextStrategy:'revision-first; inspect affected files, dependencies, tests and runtime evidence before widening scope',
    planningStrategy:'adaptive dependency-aware next step; never prebuild unnecessary work',
    agentStrategy:'specialize by engineering risk only when justified',
    parallelStrategy:'parallelize independent analysis and disjoint immutable-revision lanes; serialize shared mutations',
    verificationStrategy:'diff + targeted tests/build/runtime evidence',
    continuityStrategy:'sticky project/revision continuity with explicit scope and write isolation',
    costStrategy:'keep small fixes single-agent, use efficient coordination where safe, and reserve frontier capacity for implementation, testing, review, recovery and materially difficult analysis',
    qualityStrategy:'working software, scoped changes, reproducibility, regression safety, verified repository state',
    preferredRoles:Object.freeze(['architect','implementer','test-engineer','diagnostician','debugger','security-reviewer','performance-reviewer'])
  }),
  research:Object.freeze({
    id:'research-intelligence', maturity:'deep-evidence', priority:'evidence quality and uncertainty reduction, with bounded search cost',
    contextStrategy:'question-first; expand only for evidence gaps, conflicts, freshness, or scope',
    planningStrategy:'adaptive evidence-gap-driven next step',
    agentStrategy:'use independent researchers/analysts only when source diversity or disagreement matters',
    parallelStrategy:'parallelize independent source discovery; avoid duplicate search',
    verificationStrategy:'provenance + claim-to-source checks with conflict challenge',
    continuityStrategy:'sticky question, source ledger, evidence ledger, conflicts and unresolved questions',
    costStrategy:'use efficient scoping and synthesis, reserve frontier capacity for evidence gathering and critique, avoid duplicate search, and stop when more evidence cannot change a material conclusion',
    qualityStrategy:'traceable claims, source diversity, calibrated uncertainty, conflict visibility',
    preferredRoles:Object.freeze(['researcher','analyst','critic','communicator'])
  })
});
export function surfaceIntelligenceProfile(surface='normal-chat'){return SURFACE_INTELLIGENCE_PROFILES[normalizeSurfaceId(surface)]??SURFACE_INTELLIGENCE_PROFILES['normal-chat'];}

export const WORKSPACE_ENVIRONMENT_CONTRACTS=Object.freeze({
  'normal-chat':Object.freeze({
    environment:'conversation', stateModel:['conversation','active-artifacts','authorized-memory','situation','next-action'],
    canonicalArtifacts:['messages','documents','lightweight-files','visual-previews'], primaryTools:['conversation','files','lightweight-analysis','bounded-visual-tools'],
    verification:'adaptive', continuity:'conversation-first', mutationBoundary:'active-artifact', escalation:['code','research']
  }),
  code:Object.freeze({
    environment:'software-engineering', stateModel:['repository','immutable-revision','working-set','dependencies','terminal','tests','diff','execution-evidence'],
    canonicalArtifacts:['source-files','tests','diffs','build-output','execution-receipts'], primaryTools:['repository','terminal','tests','runtime','version-control'],
    verification:'diff-tests-runtime', continuity:'project-and-revision-first', mutationBoundary:'approved-write-set-and-revision', escalation:['research','normal-chat']
  }),
  research:Object.freeze({
    environment:'evidence-investigation', stateModel:['root-question','subquestions','source-set','evidence-ledger','claims','conflicts','coverage','uncertainty'],
    canonicalArtifacts:['sources','citations','evidence-ledger','synthesis','unresolved-claims'], primaryTools:['web-search','source-fetch','document-analysis','citation-provenance'],
    verification:'claim-source-provenance', continuity:'question-and-evidence-first', mutationBoundary:'evidence-ledger', escalation:['code','normal-chat']
  })
});
export function workspaceEnvironment(surface='normal-chat'){return WORKSPACE_ENVIRONMENT_CONTRACTS[normalizeSurfaceId(surface)]??WORKSPACE_ENVIRONMENT_CONTRACTS['normal-chat'];}

export const SURFACE_POLICY_VERSION='5';
export const SURFACE_WORKSPACE_CONTRACTS=Object.freeze({
  'normal-chat':Object.freeze({
    id:'normal-chat', label:'NormalChat', mode:'conversation-first',
    objective:'Act as the general adaptive operating mode for work that does not require the dedicated Code or Research workspace.',
    contextPolicy:'Use the active conversation plus only files, memory, images and external context that materially improve the current request.',
    toolPolicy:'Use tools just in time. Files, visuals, artifacts and lightweight creation stay capabilities here, never separate workspaces.',
    agentPolicy:'Use one executor by default and recruit advisory specialists only when independent value exceeds coordination cost.',
    verificationPolicy:'Verify claims or produced content when stakes, uncertainty, tools or user intent justify it.',
    creationPolicy:'Writing, planning, analysis, file/image understanding, visual/design work, presentations and bounded single-file code stay here.',
    escalationPolicy:'Escalate to Code for repository/project/multi-file engineering and to Research for source-heavy evidence work.',
    uiPolicy:'Keep chat central and reveal only controls, progress and permissions relevant to the current task.',
    selectionPolicy:'Default workspace; switch only to Code or Research when the task genuinely needs their durable specialized state.',
    sharedIntelligence:true, adaptiveAgents:true, adaptiveTools:true, adaptiveVerification:true
  }),
  code:Object.freeze({
    id:'code',label:'Code Workspace',mode:'repository-engineering',
    objective:'Change software safely against an exact project revision and prove the resulting state.',
    contextPolicy:'Start from the selected revision; retrieve affected files/dependencies first and expand only when evidence requires it.',
    toolPolicy:'Use repository, terminal, tests and write-back only when the current coding step requires them and the server authorizes them.',
    agentPolicy:'Use specialized coding roles only when their value exceeds coordination cost; parallel writers require disjoint immutable-revision lanes.',
    verificationPolicy:'Treat diffs, targeted tests, builds and runtime evidence as proof; expand regression coverage according to risk.',
    creationPolicy:'Edits remain inside approved scope and exact workspace state.',
    escalationPolicy:'Escalate on stale revision, scope change, missing permission, evidence conflict or new capability.',
    uiPolicy:'Keep repo/files, current revision, change scope, terminal, tests, diff, progress and write approval visible.',
    selectionPolicy:'Sticky across coding follow-ups; switch only for explicit or strongly evidenced Research/NormalChat intent.'
  }),
  research:Object.freeze({
    id:'research',label:'Research Workspace',mode:'evidence-first-investigation',
    objective:'Reduce the highest-impact unknowns and produce traceable claims from real sources.',
    contextPolicy:'Maintain a bounded source set and expand only when important claims remain unsupported or sources conflict.',
    toolPolicy:'Search/fetch only sources justified by active questions and preserve provenance.',
    agentPolicy:'Add independent researchers/analysts only when source diversity or disagreement materially improves confidence.',
    verificationPolicy:'Check important claims against observed facts and source evidence; surface conflicts instead of hiding them.',
    creationPolicy:'Synthesis, comparisons, briefs and source-backed explanations are native outputs.',
    escalationPolicy:'Escalate when evidence conflicts, freshness is unavailable, or the task becomes software modification.',
    uiPolicy:'Keep question, source set, evidence, gaps, uncertainty and citations visible without exposing hidden reasoning.',
    selectionPolicy:'Sticky across research follow-ups; switch only for explicit or strongly evidenced Code/NormalChat intent.'
  })
});
export const SURFACE_POLICY=Object.freeze({version:SURFACE_POLICY_VERSION,surfaces:Object.freeze({
  'normal-chat':{id:'normal-chat',maxDepth:'adaptive',heavyAutonomy:'adaptive',deepCode:false,deepResearch:false,sharedIntelligence:true,adaptiveAgents:true,adaptiveTools:true,adaptiveVerification:true,richMultimodal:true,lightweightCreation:true,design:true,visualCanvas:true,presentationCreation:true,contract:SURFACE_WORKSPACE_CONTRACTS['normal-chat'],intelligenceProfile:SURFACE_INTELLIGENCE_PROFILES['normal-chat']},
  code:{id:'code',maxDepth:'deep',heavyAutonomy:true,deepCode:true,deepResearch:false,richMultimodal:true,contract:SURFACE_WORKSPACE_CONTRACTS.code,intelligenceProfile:SURFACE_INTELLIGENCE_PROFILES.code},
  research:{id:'research',maxDepth:'deep',heavyAutonomy:true,deepCode:false,deepResearch:true,richMultimodal:true,contract:SURFACE_WORKSPACE_CONTRACTS.research,intelligenceProfile:SURFACE_INTELLIGENCE_PROFILES.research}
})});

export function classifySurfaceBoundary(goal,{activeSurface='',attachments=[],flags={},actions=[]}={}){
  const value=text(goal); const active=normalizeSurfaceId(activeSurface); const profile=attachmentProfile(attachments);
  const code=shouldUseCodeWorkspace(value,attachments,actions) || (flags.code===true && actions.some(a=>['create','transform','execute'].includes(text(a).toLowerCase())) && CODE_PROJECT_SCOPE.test(value));
  const research=kinds(attachments).includes('research-bundle') || profile.kind==='research' || EXPLICIT_RESEARCH.test(value)
    || (RESEARCH_DEEP.test(value) && /\b(?:research|investigat|paper|source|evidence|citation|literature|latest|current|browse|search)\w*\b/i.test(value))
    || (CURRENT_FACTS.test(value) && /\b(?:search|find|check|verify|compare|source|price|rate|news|weather|score|latest|current)\b/i.test(value))
    || (flags.research===true && /\b(?:source|evidence|latest|current|paper|literature|research|investigat)\w*\b/i.test(value));
  const requested=activeSurface||'normal-chat';
  if(code) return {requested,surface:'code',redirect:active!=='code',transition:active==='code'?'stay':'switch',reason:'coding-work-requires-code-surface',complexity:'deep-eligible',workspace:SURFACE_WORKSPACE_CONTRACTS.code,attachmentProfile:profile};
  if(research) return {requested,surface:'research',redirect:active!=='research',transition:active==='research'?'stay':'switch',reason:'deep-research-work-requires-research-surface',complexity:'deep-eligible',workspace:SURFACE_WORKSPACE_CONTRACTS.research,attachmentProfile:profile};
  if(active==='code') return {requested,surface:'code',redirect:false,transition:'stay',reason:'selected-code-workspace-stays-authoritative',complexity:'deep-eligible',workspace:SURFACE_WORKSPACE_CONTRACTS.code,attachmentProfile:profile};
  if(active==='research') return {requested,surface:'research',redirect:false,transition:'stay',reason:'selected-research-workspace-stays-authoritative',complexity:'deep-eligible',workspace:SURFACE_WORKSPACE_CONTRACTS.research,attachmentProfile:profile};
  return {requested,surface:'normal-chat',redirect:false,transition:'stay',reason:attachments.length?'adaptive-file-or-image-context':MEDIUM_ANALYSIS.test(value)?'adaptive-analysis':'adaptive-general-chat',complexity:'adaptive',workspace:SURFACE_WORKSPACE_CONTRACTS['normal-chat'],attachmentProfile:profile};
}
export function workspaceContract(surface='normal-chat'){return SURFACE_WORKSPACE_CONTRACTS[normalizeSurfaceId(surface)]??SURFACE_WORKSPACE_CONTRACTS['normal-chat'];}
export function surfaceRuntimePolicy(surface='normal-chat'){return SURFACE_POLICY.surfaces[normalizeSurfaceId(surface)]??SURFACE_POLICY.surfaces['normal-chat'];}
export function normalChatAllowsTask({goal='',taskType='',flags={},attachments=[]}={}){
  const boundary=classifySurfaceBoundary(goal,{flags,attachments});
  if(boundary.surface!=='normal-chat') return {allowed:false,boundary,reason:boundary.reason};
  return {allowed:true,boundary,taskType:text(taskType)||'respond',richMultimodal:true,maxDepth:'adaptive',lightweightCreation:true,design:true,visualCanvas:true,presentationCreation:true,agents:'shared-adaptive-and-justified'};
}
