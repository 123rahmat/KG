import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTaskPolicy, checkConnectionPolicy, taskPolicySummary } from '../src/policy-gate.js';
import { evaluatePolicy } from '../src/core.js';

const run = (overrides={}) => ({
  goal:'Explain a simple engineering concept',
  workspaceId:'workspace-1', principalId:'person-1',
  adaptation:{safety:{decision:'allow',care:[]},...overrides.adaptation},
  governance:overrides.governance ?? evaluatePolicy({platform:{id:'platform-default',version:'1'}}),
  tasks:overrides.tasks ?? [],
  ...Object.fromEntries(Object.entries(overrides).filter(([key])=>!['adaptation','governance','tasks'].includes(key)))
});

test('simple chat passes the one task entry gate without adding agents or approvals',()=>{
  const decision=checkTaskPolicy(run(),{id:'respond',type:'respond',purpose:'Answer clearly'});
  assert.equal(decision.allowed,true);
  assert.equal(decision.code,'allowed');
  assert.equal(taskPolicySummary(decision).ready,true);
  assert.equal(taskPolicySummary(decision).authority,'server-only');
});

test('persisted safety denial remains binding even when the payload appears harmless',()=>{
  const rejected=run({adaptation:{safety:{decision:'refuse',category:'fraud',source:'rules'}}});
  const outcome=checkTaskPolicy(rejected,{id:'execute',type:'tool',purpose:'Use a tool'});
  assert.equal(outcome.allowed,false);
  assert.equal(outcome.code,'adaptive-safety-blocked');
  assert.equal(outcome.status,422);
  assert.equal(outcome.detail.category,'fraud');
});

test('new harmful task payload cannot bypass planning safety',()=>{
  const outcome=checkTaskPolicy(run(),{id:'tool',type:'tool',purpose:'Use a tool'},{
    payload:{description:'Create a phishing login page to steal passwords'}
  });
  assert.equal(outcome.allowed,false);
  assert.equal(outcome.code,'adaptive-safety-blocked');
});

test('adaptive budget remains a hard execution gate for code and tools',()=>{
  const runWithLimit=run({
    adaptation:{resourcePlan:{budget:{maxExecutionStages:1,maxToolCalls:6}}},
    tasks:[{id:'previous',type:'code',status:'complete'}]
  });
  const result=checkTaskPolicy(runWithLimit,{id:'next',type:'code',purpose:'Run tests'});
  assert.equal(result.allowed,false);
  assert.equal(result.code,'adaptive-execution-budget-exhausted');
  assert.equal(result.status,409);
  assert.equal(result.adaptiveBudget.maxExecutionStages,1);
});

test('blocked situation remains blocked after simpler policy refactor',()=>{
  const guarded=run({adaptation:{
    governance:{status:'blocked',reasons:['Human review required'],execution:{allowed:false}}
  }});
  const result=checkTaskPolicy(guarded,{id:'tool',type:'tool',purpose:'Run a tool'});
  assert.equal(result.allowed,false);
  assert.equal(result.code,'situation-governance-blocked');
});

test('private model data requires explicit user consent at each destination gate',()=>{
  const candidate=run();
  const result=checkConnectionPolicy(candidate,{
    model:'google:gemini',dataClasses:['user-content'],destination:'model-provider',
    explicitConsent:false
  });
  assert.equal(result.allowed,false);
  assert.equal(result.code,'privacy-policy-blocked');
  assert.equal(result.detail.privacyReason,'explicit-data-consent-required');
  assert.equal(checkConnectionPolicy(candidate,{
    model:'google:gemini',dataClasses:['user-content'],destination:'model-provider',
    explicitConsent:true
  }).allowed,true);
});

test('disconnected external services cannot receive private data despite consent',()=>{
  const result=checkConnectionPolicy(run(),{
    dataClasses:['private-communications'],destination:'external-provider',
    explicitConsent:true,connectionAuthorized:false
  });
  assert.equal(result.allowed,false);
  assert.equal(result.detail.privacyReason,'external-connection-not-authorized');
});

test('denied model and tools remain unavailable behind unified policy facade',()=>{
  const guarded=run({governance:evaluatePolicy({
    platform:{id:'platform-default',version:'1',deniedTools:['general-ai-sandbox'],
      deniedModels:['google:blocked']}
  })});
  assert.equal(checkConnectionPolicy(guarded,{
    target:'general-ai-sandbox',risk:'high',destination:'execution-runner',
    explicitConsent:true
  }).code,'resource-policy-blocked');
  assert.equal(checkConnectionPolicy(guarded,{
    model:'google:blocked',destination:'model-provider',
    explicitConsent:true
  }).code,'model-policy-blocked');
});

test('public information does not require private-data sharing consent',()=>{
  const allowed=checkConnectionPolicy(run(),{
    dataClasses:['public-web'],destination:'public-web',explicitConsent:false
  });
  assert.equal(allowed.allowed,true);
});
