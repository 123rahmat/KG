import test from 'node:test';
import assert from 'node:assert/strict';
import { codingUserCoverage } from '../public/coding-user-coverage.js';

test('user-need coverage is absent from empty or historical runs',()=>{
  assert.equal(codingUserCoverage(null),null);
  assert.equal(codingUserCoverage({requirements:{items:[{required:true,status:'satisfied'}]}}),null);
});
test('shows explicit unmet user requirements without pretending execution passed',()=>{
  const result=codingUserCoverage({
    adaptation:{codingUserNeeds:{coverageLimited:false}},
    requirements:{items:[
      {requirement:'Add password reset',explicitCoverage:true,required:true,status:'satisfied'},
      {requirement:'Keep existing login sessions',explicitCoverage:true,required:true,status:'in-progress'},
      {requirement:'Old historic criteria',explicitCoverage:true,required:false,status:'superseded'},
      {requirement:'Nonuser criteria',status:'satisfied',required:true}
    ]}
  });
  assert.equal(result.total,2);
  assert.equal(result.checked,1);
  assert.equal(result.remaining,1);
  assert.equal(result.complete,false);
  assert.equal(result.items[1].status,'not-verified');
  assert.match(result.caveat,/not proof/);
});
test('bounded coverage warns when original user input exceeded the checklist cap',()=>{
  const items=Array.from({length:20},(_,n)=>({
    requirement:'Need '+n,explicitCoverage:true,required:true,status:'confirmed'
  }));
  const result=codingUserCoverage({requirements:{items},adaptation:{codingUserNeeds:{coverageLimited:true}}});
  assert.equal(result.total,12);
  assert.equal(result.hidden,5);
  assert.equal(result.limited,true);
});
