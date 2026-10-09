import test from 'node:test';
import assert from 'node:assert/strict';
import { compileOpenWorldSpecialistBrief, openWorldResearchPriority } from '../src/open-world-specialist-bridge.js';
import { agentMessages, rolesFor } from '../src/multi-agent.js';

const unfamiliar = {
  unknownSituation:true, investigationNeeded:true,
  externalData:{hasExternalDataNeed:true},
  unknowns:['Are primary sources available?']
};
const candidate = {
  id:'unfamiliar-spectroscopy',name:'Niche spectroscopy interpretation',
  purpose:'Read unfamiliar measurement artifacts', tools:['untrusted-tool'],
  status:'approved', implementation:{kind:'exec'}
};

test('known everyday requests do not trigger an expensive speculative specialist', () => {
  assert.equal(compileOpenWorldSpecialistBrief({
    goal:'Write a friendly thank-you message',surface:'normal-chat',
    situation:{unknownSituation:false}
  }),null);
  assert.equal(openWorldResearchPriority({
    situation:{unknownSituation:false},capabilities:{discovered:[]}
  },{id:'respond',type:'respond'}),false);
});

test('any unfamiliar domain gets a temporary expertise focus without inventing a permanent agent', () => {
  const result=compileOpenWorldSpecialistBrief({
    surface:'research',role:'researcher',
    goal:'Evaluate an unfamiliar olivine-composite thermomechanical measurement',
    situation:unfamiliar,task:{id:'investigate'}
  });
  assert.equal(result.kind,'ephemeral-task-specialization');
  assert.equal(result.surface,'research');
  assert.equal(result.mode,'external-evidence-gap');
  assert.equal(result.parentRole,'researcher');
  assert.equal(result.authorization.maySpawnAgents,false);
  assert.equal(result.authorization.mayBrowseUnapprovedSources,false);
  assert.equal(result.authorization.mayExpandBudget,false);
  assert.equal(result.evidence.sourcesVerified,false);
  assert.equal(Object.isFrozen(result),true);
});

test('model-discovered capabilities stay unapproved candidates, never execution grants', () => {
  const brief=compileOpenWorldSpecialistBrief({
    surface:'code',role:'architect',goal:'Integrate an unfamiliar instrument SDK',
    discoveredCapabilities:[candidate,candidate,null,'run shell',{}, {id:'new-widget',name:'Widget'}],
    situation:{unknownSituation:false}
  });
  assert.equal(brief.mode,'candidate-capability-gap');
  assert.equal(brief.candidateCapabilities.length,2);
  assert.deepEqual(brief.candidateCapabilities.map(x=>x.executionAuthorized),[false,false]);
  assert.ok(brief.candidateCapabilities.every(x=>x.status==='candidate-unverified'));
  assert.equal(brief.authorization.mayUseNewTools,false);
});

test('unknown needs are bounded and do not accept an arbitrary untrusted array', () => {
  const brief=compileOpenWorldSpecialistBrief({
    goal:'Solve a niche problem',situation:{unknownSituation:true,
      unknowns:Array.from({length:40},(_,i)=>'question '+i)},
    discoveredCapabilities:Array.from({length:12},(_,i)=>({id:'candidate'+i,name:'X'.repeat(1000)}))
  });
  assert.equal(brief.candidateCapabilities.length,3);
  assert.equal(brief.unknownQuestions.length,3);
  assert.ok(brief.candidateCapabilities.every(x=>x.name.length<=110));
  assert.equal(compileOpenWorldSpecialistBrief({goal:'',situation:unfamiliar}),null);
});

test('research priority activates only for unknown investigative stages', () => {
  const run={situation:unfamiliar,capabilities:{discovered:[candidate]}};
  assert.equal(openWorldResearchPriority(run,{id:'discover-capabilities',type:'step'}),true);
  assert.equal(openWorldResearchPriority(run,{id:'plan',type:'plan'}),true);
  assert.equal(openWorldResearchPriority(run,{id:'build-code',type:'code'}),false);
  assert.equal(openWorldResearchPriority(run,{id:'verify',type:'verify'}),false);
});

test('real model prompt receives scoped brief using the same authorized model call', () => {
  const messages=agentMessages('researcher',{
    goal:'Research unfamiliar olivine ceramic material properties',
    task:{id:'investigate',type:'investigate'},
    situation:unfamiliar,discoveredCapabilities:[candidate],
    evidenceSoFar:[{title:'Unverified forum post'}],
    specialistSurface:'research'
  });
  assert.equal(messages.length,2);
  const payload=JSON.parse(messages[1].content);
  assert.equal(payload.openWorldAssignment.mode,'candidate-capability-gap');
  assert.equal(payload.openWorldAssignment.authorization.mayBrowseUnapprovedSources,false);
  assert.equal(payload.openWorldAssignment.evidence.sourcesVerified,false);
  assert.match(messages[0].content,/temporary, task-scoped focus/);
});

test('known requests preserve the existing simple path and specialist selection', () => {
  const msgs=agentMessages('communicator',{
    goal:'Draft a friendly email',situation:{unknownSituation:false}
  });
  assert.equal(JSON.parse(msgs[1].content).openWorldAssignment,null);
  const result=rolesFor({
    situation:{risk:'low'},adaptation:{scale:'small'},tasks:[],attempt:1
  },{id:'respond',type:'respond'});
  assert.equal(result.decision.enabled,false);
});
