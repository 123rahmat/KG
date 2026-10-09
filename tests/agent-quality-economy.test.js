import test from 'node:test';
import assert from 'node:assert/strict';
import { agentWaveEconomy,optionalAgentStopDecision } from '../src/agent-quality-economy.js';
const finding=(summary,more={})=>({
 summary,confidence:.96,recommendation:'proceed',risks:[],unknowns:[],actions:[],...more
});

test('telemetry counts incremental advisory novelty but never grants verification',()=>{
 const before=[finding('Analyze first subsystem',{actions:['Improve API contract']})];
 const wave=[finding('Analyze second subsystem',{actions:['Run schema migration checks']}),
  finding('Analyze second subsystem',{actions:['Run schema migration checks']})];
 const metrics=agentWaveEconomy({before,after:[...before,...wave],wave,
  tokens:1200,elapsedMs:280,modelCalls:2});
 assert.equal(metrics.newDistinctAdvisoryNeeds,1);
 assert.equal(metrics.newDistinctAdvisorySummaries,1);
 assert.equal(metrics.duplicateAdvisorySummaries,1);
 assert.equal(metrics.advisoryDuplicationRatio,.5);
 assert.equal(metrics.tokensPerAdvisoryFinding,600);
 assert.equal(metrics.verifiedResults,0);
 assert.equal(metrics.verificationStatus,'unverified-advisory');
 assert.equal(metrics.modelCalls,2);
});

test('only repeated redundant, low-risk optional advice may stop additional recruitment',()=>{
 const prior=[finding('Same self-reported answer')];
 const next=[finding('Same self-reported answer')];
 const a=agentWaveEconomy({before:prior,after:[...prior,...next],wave:next});
 const b=agentWaveEconomy({before:[...prior,...next],after:[...prior,...next,...next],wave:next});
 assert.equal(a.valueObserved,false);
 const result=optionalAgentStopDecision({report:b,previousReports:[a],risk:'low'});
 assert.equal(result.stop,true);
 assert.equal(result.verifiedByThisPolicy,false);
 assert.equal(optionalAgentStopDecision({report:b,previousReports:[a],risk:'critical'}).stop,false);
 assert.equal(optionalAgentStopDecision({report:b,previousReports:[a],failedRoles:1}).stop,false);
 assert.equal(optionalAgentStopDecision({report:b,previousReports:[a],acceptanceSatisfied:true}).stop,true);
});

test('unknowns and contradictory results prevent redundant-advice optimization',()=>{
 const before=[finding('Needs checking',{unknowns:['Unproven claim']})];
 const repeated=[finding('Needs checking',{unknowns:['Unproven claim']})];
 const report=agentWaveEconomy({before,after:[...before,...repeated],wave:repeated});
 assert.equal(report.outstandingUnknowns,1);
 assert.equal(optionalAgentStopDecision({report,previousReports:[report]}).stop,false);
 const contradictory=agentWaveEconomy({before,after:[...before,
   finding('Stop until verified',{recommendation:'stop'})],
   wave:[finding('Stop until verified',{recommendation:'stop'})]});
 assert.equal(contradictory.opinionDisagreement,true);
});
