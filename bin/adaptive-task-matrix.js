/** Deterministic scenario evaluation of KG's real policy/graph modules.
 * These are execution decisions, NOT model-generated answers or live Vertex calls.
 */
import { fileURLToPath } from 'node:url';
import { selectAdaptiveWorkflow } from '../src/unified-adaptive-workflow.js';
import { composeOpenWorldDecision, appendOpenWorldWork, recordOpenWorldOutcome, openWorldFrontier } from '../src/open-world-task-graph.js';

const actions = [];
function caseOf(name, userTask, input, expected) {
  const result = composeOpenWorldDecision({ goal: userTask, ...input });
  const matched = result.action === expected;
  actions.push({name, task:userTask, expected, actual:result.action, matched,
    next:result.next?.id ?? null, ready:result.frontier.ready,
    policy:'proposal-only'});
}
export function runAdaptiveTaskMatrix() {
  actions.length = 0;
  caseOf('small-talk', 'Hello!', {situation: {uncertainty:.02, complexity:.02}}, 'direct');
  caseOf('writing', 'Rewrite this email politely', {situation: {uncertainty:.05, complexity:.1}}, 'direct');
  caseOf('brainstorming', 'Brainstorm original business concepts with trade-offs', {situation: {uncertainty:.4, complexity:.55}}, 'reason');
  caseOf('translation', 'Translate user-supplied text', {situation: {uncertainty:.02, complexity:.12}}, 'direct');
  caseOf('planning', 'Create a product roadmap', {situation: {uncertainty:.4, complexity:.7}}, 'reason');
  caseOf('coding', 'Debug authentication regression', {situation:{executionRequired:true},
    graph:appendOpenWorldWork({}, {id:'inspect-tests', purpose:'Inspect failing tests'})}, 'continue-work');
  caseOf('research', 'Find and verify recent literature', {situation:{evidenceGap:true, uncertainty:.75}}, 'investigate');
  caseOf('data-analysis', 'Analyze unfamiliar sensor readings', {situation:{unresolvedQuestions:['Which data fields exist?'],uncertainty:.9}}, 'investigate');
  caseOf('image-ready', 'Produce an illustration', {situation:{executionRequired:true},
    candidates:[{id:'render',requires:['image-renderer'],expectedQualityGain:1}],
    availableCapabilities:[{id:'image-renderer'}],authorizedCapabilities:[{id:'image-renderer'}]}, 'propose-work');
  caseOf('image-unavailable', 'Edit a reference image', {situation:{executionRequired:true},
    candidates:[{id:'render',requires:['image-renderer']}],availableCapabilities:[],authorizedCapabilities:[]}, 'capability-gap');
  caseOf('document-conversion-unavailable', 'Convert a document with no converter', {situation:{executionRequired:true},
    candidates:[{id:'convert',requires:['document-converter']}],availableCapabilities:[],authorizedCapabilities:['document-converter']}, 'capability-gap');
  caseOf('unknown-domain', 'Analyze an unfamiliar sensor and revise technician instructions', {
    situation:{unresolvedQuestions:['What file format?'],uncertainty:.9}}, 'investigate');
  caseOf('approval', 'Transfer funds from the budget', {situation:{authorizationRequired:true,authorizationSatisfied:false,executionRequired:true}}, 'approval-required');
  caseOf('low-budget', 'Explore many costly external datasets', {situation:{evidenceGap:true,uncertainty:.8},remainingBudgetRatio:.02}, 'budget-gate');
  caseOf('already-running', 'Continue the build', {situation:{executionRequired:true},graph:{nodes:[{id:'build',status:'running'}]}}, 'await-work');
  caseOf('failed-tool', 'Recover a failed data conversion', {situation:{executionRequired:true},graph:{nodes:[{id:'convert',status:'failed'}]}}, 'recover');
  const graph1 = appendOpenWorldWork({}, {id:'inspect'});
  const graph2 = appendOpenWorldWork(graph1, {id:'modify',dependsOn:['inspect']});
  const graph3 = recordOpenWorldOutcome(graph2, 'inspect', {status:'complete'});
  const graph4 = recordOpenWorldOutcome(graph3, 'modify', {status:'complete'});
  const graph5 = recordOpenWorldOutcome(graph4, 'inspect', {status:'complete',changed:true});
  caseOf('changed-requirement', 'Recheck dependent code after new evidence', {
    situation:{executionRequired:true},graph:graph5}, 'continue-work');
  const blueprint = selectAdaptiveWorkflow({goal:'Build an app and verify it',
    need:{form:'code'},capabilities:[{id:'code-generation'},{id:'code-execution'}]});
  const riskGraph = appendOpenWorldWork(appendOpenWorldWork({}, {id:'safe-a'}), {id:'safe-b'});
  const risk = openWorldFrontier(riskGraph, {risk:'critical', maxParallel:5});
  return {
    kind:'deterministic-policy-simulation', modelResponsesGenerated:false,
    cases:actions.map(item=>({...item})),
    passed:actions.filter(item=>item.matched).length,total:actions.length,
    legacyPhaseListRemoved:blueprint.strategy==='incremental-open-world' && blueprint.phases.length===0,
    highRiskMaxParallel:Math.max(0,...risk.waves.map(wave=>wave.length)),
    staleNodeReady:openWorldFrontier(graph5).ready,
    conclusion:'These checks test policy and graph decisions, not live Gemini task quality.'
  };
}
if (process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  const report=runAdaptiveTaskMatrix();
  console.log(JSON.stringify(report,null,2));
  if(report.passed!==report.total || !report.legacyPhaseListRemoved || report.highRiskMaxParallel!==1) process.exitCode=1;
}
