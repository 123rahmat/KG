import test from 'node:test';
import assert from 'node:assert/strict';
import { taskSpecificSubagentNeeds } from '../src/situational-subagent-needs.js';
import { selectFamilySubagents, runBoundedFamilyChildProbes } from '../src/adaptive-family-subagents.js';
import { familyMainAgentMatch } from '../src/family-main-agents.js';
import { rolesFor } from '../src/multi-agent.js';

const requirements=[
  'Verify accessibility with keyboard navigation and focus restoration',
  'Verify permission denial across workspace and user boundaries',
  'Validate bad login recovery and rollback behavior',
  'Verify browser interaction states for network failure',
  'Check API contract backwards compatibility and errors',
  'Audit performance regressions on complex forms'
];
const config={surface:'code',
  goal:'Build accessible onboarding, permission-safe login and reliable UI API integration',
  role:'code-ui-engineering-lead',
  situation:{complexity:.93,uncertainty:.88,unknownSituation:true,risk:'high',
    successCriteria:requirements},
  task:{id:'build-code',type:'code',metadata:{acceptanceCriteria:[
    'Verify color contrast and assistive technology behavior',
    'Ensure authorization handles tenant boundaries'
  ]}},
  remainingBudgetRatio:0.9};

test('criteria and observed gaps generate new specialties beyond a static family inventory',()=>{
 const roles=taskSpecificSubagentNeeds({situation:{successCriteria:requirements},
   observedFindings:[{unknowns:['Investigate missing API source provenance'],status:'complete'}]});
 assert.ok(roles.length > 6);
 assert.ok(roles.every(item=>item.authority==='read-only-advisory'));
 assert.ok(roles.some(item=>item.id.startsWith('task-verify-accessibility')));
 assert.ok(roles.some(item=>item.operation==='investigate'));
 const plan=selectFamilySubagents(config);
 assert.equal(plan.family,'ui-engineering');
 assert.ok(plan.discoveredTaskSkills>=requirements.length);
 assert.ok(plan.available>8);
 assert.ok(plan.active.length>3);
 assert.ok(plan.active.some(item=>item.id.startsWith('task-')));
 assert.ok(plan.active.every(item=>item.mayInvokeTools===false&&item.maySpawnAgents===false));
 assert.equal(plan.executionPolicy.toolPermissions,'none');
});
test('size adapts to observed needs and compute budget, not a forced roster',()=>{
 const easy=selectFamilySubagents({surface:'code',goal:'Explain a UI layout',role:'code-ui-engineering-lead',
  task:{type:'respond'},situation:{uncertainty:0}});
 const complex=selectFamilySubagents(config);
 assert.ok(easy.active.length<complex.active.length);
 const scarce=selectFamilySubagents({...config,remainingBudgetRatio:0.1});
 assert.equal(scarce.active.length,1);
 assert.equal(scarce.executionPolicy.extraModelChildLimit,0);
});
test('one task can call more than two independent child probes only with parent reservation',async()=>{
 let calls=0,concurrency=0,peak=0;
 const results=await runBoundedFamilyChildProbes({...config,
   run:{id:'run-1'},modelId:'fake',usageGate:{},dataAllowed:true,
   canSpend:async()=>true,maxExtraCalls:4,maxParallel:3,
   modelCaller:async()=>{
     calls++;concurrency++;peak=Math.max(peak,concurrency);
     await Promise.resolve();concurrency--;
     return {text:JSON.stringify({summary:'Additional verification is required',confidence:0.6})};
   }
 });
 assert.equal(results.modelCalls,4);
 assert.equal(calls,4);
 assert.ok(peak>=2&&peak<=3);
 assert.equal(results.findings.length,4);
 assert.ok(results.findings.every(x=>x.status==='unverified-advisory'));
 const denied=await runBoundedFamilyChildProbes({...config,run:{id:'run-1'},
   modelId:'fake',modelCaller:async()=>{throw new Error('must not execute');},
   dataAllowed:false,maxExtraCalls:4,usageGate:{}});
 assert.equal(denied.modelCalls,0);
});
test('multiple main-agent families can match the same specialized situation',()=>{
 const goal='Prepare a systematic review with causal inference, econometrics and statistical significance';
 const scope={surface:'research',goal,task:{id:'investigate',type:'investigate'}};
 assert.ok(familyMainAgentMatch('research-systematic-review-methods-lead',scope)>.7);
 assert.ok(familyMainAgentMatch('research-causal-inference-lead',scope)>.7);
 assert.ok(familyMainAgentMatch('research-econometric-analysis-lead',scope)>.7);
 const team=rolesFor({surface:'research',goal,adaptation:{scale:'advanced'},
   situation:{risk:'ordinary',unknownSituation:true,uncertainty:.9},tasks:[]},
 {id:'investigate',type:'investigate'},{mode:'always',maxAgents:9});
 assert.ok(team.agentCount>3,team.roles.join(','));
 assert.ok(team.roles.filter(role=>role.endsWith('-lead')).length>=2,team.roles.join(','));
});
