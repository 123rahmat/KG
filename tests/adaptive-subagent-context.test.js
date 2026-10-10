import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFamilySubagents } from '../src/adaptive-family-subagents.js';
const requirements=Array.from({length:110},(_,i)=>'Check independently documented visual contrast variation for component '+i+' against requirements');
test('hard tasks retain relevant lenses without unbounded prompt expansion',()=>{
  const config={surface:'code',role:'code-ui-engineering-lead',
    goal:'Build and verify accessible UI',
    task:{id:'build-code',type:'code'},
    situation:{risk:'high',complexity:1,uncertainty:1,successCriteria:requirements},
    remainingBudgetRatio:.95};
  const large=selectFamilySubagents(config);
  assert.ok(large.discoveredTaskSkills>=100);
  assert.ok(large.contextPolicy.omittedForContext>0);
  assert.ok(large.contextPolicy.selectedChars<=large.contextPolicy.allowanceChars+500);
  assert.ok(large.active.length>3);
  const scarce=selectFamilySubagents({...config,remainingBudgetRatio:.1});
  assert.equal(scarce.active.length,1);
  assert.ok(scarce.contextPolicy.allowanceChars<large.contextPolicy.allowanceChars);
});
