import test from 'node:test';
import assert from 'node:assert/strict';
import { SPECIALIST_FAMILIES } from '../src/adaptive-specialist-focus.js';
import {
  familyPlaybook,selectFamilySubagents,
  normalizeChildProbe,runBoundedFamilyChildProbes
} from '../src/adaptive-family-subagents.js';
import { agentMessages } from '../src/multi-agent.js';

const high={unknownSituation:true,uncertainty:.95,complexity:.9,risk:'high'};
const tech={surface:'research',goal:'Review a novel architecture security research and performance evidence, verify evidence',
  role:'researcher',situation:high,task:{id:'plan',type:'plan'},remainingBudgetRatio:1};
const model={text:JSON.stringify({summary:'A possible evidence gap',gaps:['Missing independent source'],
  proposedChecks:['Check a primary source'],confidence:.72}),
  usage:{inputTokens:15,outputTokens:25},provider:'mock',model:'mock',usageRecorded:false};

test('every registered family has 8 owned, nonexecuting subagent contracts',()=>{
  let families=0,children=0;
  for(const [surface,entries] of Object.entries(SPECIALIST_FAMILIES)){
    for(const family of Object.keys(entries)){
      const item=familyPlaybook(surface,family);
      assert.equal(item.children.length,8,surface+'/'+family);
      assert.ok(item.children.every(c=>c.authority==='read-only-advisory'));
      assert.ok(item.checks.length>=1);
      families++;children+=item.children.length;
    }
  }
  assert.equal(families,55);
  assert.equal(children,440);
});
test('everyday simple chat stays a single free subskill lens',()=>{
 const p=selectFamilySubagents({surface:'normal-chat',goal:'Hi',role:'communicator',
   situation:{uncertainty:0},task:{type:'respond'}});
 assert.equal(p.active.length,1);
 assert.equal(p.executionPolicy.extraModelChildAllowed,false);
 assert.equal(p.executionPolicy.extraModelChildLimit,0);
});
test('UI activates responsive, component and test lenses; never invents a screenshot result',()=>{
 const p=selectFamilySubagents({surface:'code',
  goal:'Build accessible responsive UI and test components',
  role:'frontend-engineer',situation:high,task:{type:'plan'}});
 assert.equal(p.family,'ui-engineering');
 assert.ok(p.active.length<=3);
 assert.ok(p.active.some(a=>a.id==='ui-testing'));
 assert.ok(p.peerConsultations.includes('ux-engineering'));
 assert.ok(p.peerConsultations.includes('accessibility-engineering'));
 assert.equal(p.executionPolicy.toolPermissions,'none');
 assert.equal(p.executionPolicy.parentOwnsVerification,true);
});
test('UX and security retain independent family-owned work',()=>{
 const ux=selectFamilySubagents({surface:'code',role:'ux-designer',
  goal:'Evaluate onboarding journeys and usability',situation:{complexity:.8}});
 const sec=selectFamilySubagents({surface:'code',role:'security-reviewer',
  goal:'Review authentication and authorization',situation:high,task:{type:'plan'}});
 assert.equal(ux.family,'ux-engineering');
 assert.equal(sec.family,'security-engineering');
 assert.ok(sec.active.some(x=>x.operation==='verify'));
 assert.ok(sec.peerConsultations.includes('backend-engineering'));
});
test('research can use two independent child checks when evidence justifies parallelism',()=>{
 const p=selectFamilySubagents(tech);
 assert.equal(p.family,'technology-research');
 assert.equal(p.executionPolicy.extraModelChildLimit,2);
 assert.equal(p.executionPolicy.parallelOnlyWhenIndependent,true);
 const candidates=p.active.filter(x=>x.priority==='supporting');
 assert.equal(candidates.length,2);
 assert.ok(candidates.every(x=>['investigate','verify'].includes(x.operation)));
});
test('low remaining budget suppresses extra children and narrows task scope',()=>{
 const p=selectFamilySubagents({...tech,remainingBudgetRatio:.1});
 assert.equal(p.active.length,1);
 assert.equal(p.executionPolicy.extraModelChildLimit,0);
});
test('real specialist prompts carry family instructions as data not tool authority',()=>{
 const messages=agentMessages('frontend-engineer',{
  goal:'Build accessible responsive UI and test components',
  specialistSurface:'code',situation:high,task:{type:'plan'},familyBudgetRatio:.8
 });
 const body=JSON.parse(messages[1].content);
 assert.equal(body.familySubagents.family,'ui-engineering');
 assert.ok(body.familySubagents.active.length<=3);
 assert.equal(body.familySubagents.executionPolicy.toolPermissions,'none');
 assert.match(messages[0].content,/unverified until real authorized receipts/);
});
test('no child model call when no provider reservation, no approval or policy off',async()=>{
 let calls=0;
 const runner=opts=>runBoundedFamilyChildProbes({
  ...tech,run:{id:'run-a'},modelId:'mock',modelCaller:async()=>{calls++;return model;},
  canSpend:async()=>true,maxExtraCalls:2,...opts
 });
 assert.equal((await runner({usageGate:null,dataAllowed:true})).modelCalls,0);
 assert.equal((await runner({usageGate:{},dataAllowed:false})).modelCalls,0);
 assert.equal((await runner({usageGate:{},dataAllowed:true,config:{agents:{subagents:'off'}}})).modelCalls,0);
 assert.equal((await runner({usageGate:{},dataAllowed:true,canSpend:async()=>false})).modelCalls,0);
 assert.equal(calls,0);
});
test('two read-only children may run concurrently and are recorded unverified',async()=>{
 let active=0,peak=0;
 const reported=[],recorded=[];
 const result=await runBoundedFamilyChildProbes({
  ...tech,run:{id:'run-a'},modelId:'mock',usageGate:{},dataAllowed:true,
  canSpend:async()=>true,maxParallel:2,maxExtraCalls:2,
  modelCaller:async messages=>{
    active++;peak=Math.max(peak,active);
    assert.match(messages[0].content,/read-only child subagent/);
    assert.equal(messages[1].role,'user');
    await Promise.resolve();
    active--;
    return model;
  },
  recordAgent:async x=>recorded.push(x),
  recordUsage:async(...args)=>reported.push(args)
 });
 assert.equal(result.modelCalls,2);
 assert.equal(result.findings.length,2);
 assert.equal(peak,2);
 assert.equal(reported.length,2);
 assert.equal(recorded.length,2);
 assert.ok(recorded.every(x=>x.role.startsWith('child:researcher:')));
 assert.ok(result.findings.every(x=>x.status==='unverified-advisory'
   && x.evidenceVerified===false && x.toolCallsPerformed===0));
});
test('malformed child output is unavailable, not treated as verified success',async()=>{
 const result=await runBoundedFamilyChildProbes({
  ...tech,run:{id:'run-a'},modelId:'mock',usageGate:{},dataAllowed:true,
  canSpend:async()=>true,maxExtraCalls:1,modelCaller:async()=>({text:'not json',model:'mock'})
 });
 assert.equal(result.modelCalls,1);
 assert.equal(result.findings.length,0);
 assert.equal(normalizeChildProbe({summary:'unverified'},null),null);
});
