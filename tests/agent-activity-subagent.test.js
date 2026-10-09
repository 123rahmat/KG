import test from 'node:test';
import assert from 'node:assert/strict';
import { agentActivitySnapshot } from '../public/agent-activity.js';
import { selectFamilySubagents } from '../src/adaptive-family-subagents.js';

test('only real model-recorded child findings appear beneath their parent role',()=>{
  const run={state:'complete',tasks:[{id:'plan',type:'plan',status:'complete',
    evidence:{multiAgent:{
      agentStates:[
        {role:'frontend-engineer',status:'complete',wave:0,summary:'Scoped component behavior'},
        {role:'child:frontend-engineer:ui-testing',subagent:true,parentRole:'frontend-engineer',
          specialty:'ui testing',summary:'Proposed interaction check',
          verification:'unverified-advisory',status:'complete',wave:0}
      ],
      allocation:{waves:[{parallel:false}]}
    }}
  }]};
  const activity=agentActivitySnapshot(run);
  assert.equal(activity.roles.length,2);
  assert.equal(activity.roles[0].kind,'specialist');
  assert.equal(activity.roles[1].kind,'subagent');
  assert.equal(activity.roles[1].parentRole,'frontend-engineer');
  assert.equal(activity.roles[1].displayRole,'ui testing');
  assert.equal(activity.roles[1].verification,'unverified-advisory');
  assert.equal(activity.roles[1].summary,'Proposed interaction check');
  assert.equal(activity.active.length,0);
});

test('catalogue-only subagents never appear as executed progress',()=>{
  const p=selectFamilySubagents({surface:'code',role:'frontend-engineer',
    goal:'Create responsive UI components',situation:{complexity:.9}});
  assert.ok(p.active.length>=1);
  const activity=agentActivitySnapshot({state:'running',tasks:[{id:'plan',status:'pending'}]});
  assert.equal(activity.roles.length,0);
  assert.equal(activity.completed,0);
});
test('recorded child statuses cannot be mistaken for real test receipts',()=>{
  const activity=agentActivitySnapshot({state:'complete',tasks:[{
    id:'review',evidence:{multiAgent:{
      agentStates:[{role:'child:security-reviewer:vulnerability-review',subagent:true,
        status:'complete',summary:'Test would be needed'}]
    }}
  }]});
  assert.equal(activity.roles[0].kind,'subagent');
  assert.equal(activity.roles[0].verification,'unverified-advisory');
});
