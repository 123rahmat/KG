import test from 'node:test';
import assert from 'node:assert/strict';
import { taskSpecificSubagentNeeds } from '../src/situational-subagent-needs.js';

test('distinct long requirements do not collide on a truncated prefix',()=>{
  const items=Array.from({length:120},(_,i)=>
    'Verify independently documented visual contrast requirements for component number '+i+' including viewport constraints');
  const results=taskSpecificSubagentNeeds({situation:{successCriteria:items}});
  assert.equal(results.length,120);
  assert.equal(new Set(results.map(item=>item.id)).size,120);
  assert.ok(results.every(item=>item.authority==='read-only-advisory'));
});
test('identical criteria are de-duplicated across the sources',()=>{
  const line='Verify browser keyboard focus behavior after navigation';
  const result=taskSpecificSubagentNeeds({
    situation:{successCriteria:[line]},
    task:{metadata:{acceptanceCriteria:[line]}}
  });
  assert.equal(result.length,1);
  assert.ok(result[0].id.startsWith('task-verify-browser'));
});
