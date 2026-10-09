import test from 'node:test';
import assert from 'node:assert/strict';
import { compileOpenWorldSpecialistBrief, openWorldResearchPriority } from '../src/open-world-specialist-bridge.js';

const situations = [
  ['normal-chat','subject-tutor','Help understand an unfamiliar regional schooling assessment rubric'],
  ['normal-chat','analyst','Compare obscure river-basin irrigation practices under a new drought rule'],
  ['normal-chat','strategist','Plan an accessible event for a rare mobility accommodation'],
  ['code','architect','Integrate a newly introduced industrial telemetry protocol'],
  ['code','security-reviewer','Threat-model a novel smart-device pairing handshake'],
  ['code','test-engineer','Test an unfamiliar proprietary numerical extension'],
  ['research','researcher','Find evidence for an obscure marine geochemistry marker'],
  ['research','methodology-reviewer','Validate an unusual clinical sample selection methodology'],
  ['research','citation-auditor','Audit evidence behind a recently discovered manufacturing process']
];
test('wide domain matrix produces temporary scoped expertise without a new fixed agent taxonomy', () => {
  for(const [surface,role,goal] of situations) {
    const result=compileOpenWorldSpecialistBrief({
      surface,role,goal,
      situation:{unknownSituation:true,investigationNeeded:true,unknowns:['What evidence exists?']}
    });
    assert.equal(result.surface,surface,goal);
    assert.equal(result.parentRole,role,goal);
    assert.equal(result.kind,'ephemeral-task-specialization',goal);
    assert.equal(result.authorization.maySpawnAgents,false,goal);
    assert.equal(result.authorization.mayBypassApprovals,false,goal);
    assert.equal(result.status,'advisory-not-executed',goal);
  }
});
test('fresh external evidence requires the parent authorization boundary',()=>{
  const result=compileOpenWorldSpecialistBrief({
    goal:'Investigate a newly published niche materials finding',
    role:'researcher',surface:'research',
    situation:{investigationNeeded:true,externalData:{hasExternalDataNeed:true}}
  });
  assert.equal(result.mode,'external-evidence-gap');
  assert.equal(result.authorization.mayBrowseUnapprovedSources,false);
  assert.match(result.verification,/independent evidence/);
});
test('an unknown task may guide research role selection without executing unknown code',()=>{
  const run={situation:{unknownSituation:true},capabilities:{discovered:[]}};
  assert.equal(openWorldResearchPriority(run,{id:'plan',type:'plan'}),true);
  assert.equal(openWorldResearchPriority(run,{id:'build-code',type:'code'}),false);
  assert.equal(openWorldResearchPriority(run,{id:'execute-tool',type:'tool'}),false);
});
