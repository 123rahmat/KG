import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentHandoff, peerHandoffsFor } from '../src/agent-peer-handoffs.js';
import { agentMessages } from '../src/multi-agent.js';

test('bounded, directed handoffs carry no authority or verified evidence', () => {
  const msg = createAgentHandoff({
    runId:'run-1',taskId:'step-1',from:'researcher',to:'analyst',
    type:'finding',summary:'Provisional evidence gap'
  });
  assert.equal(msg.from,'researcher');
  assert.equal(msg.to,'analyst');
  assert.equal(msg.trust,'untrusted-advisory');
  assert.equal(msg.authorizesTools,false);
  assert.equal(msg.verified,false);
  assert.equal(Object.isFrozen(msg),true);
});
test('messages without valid same-task routing are discarded', () => {
  assert.equal(createAgentHandoff({runId:'x',taskId:'y',from:'critic',to:'critic',summary:'self'}),null);
  assert.equal(createAgentHandoff({runId:'',taskId:'y',from:'critic',to:'analyst',summary:'test'}),null);
  assert.equal(createAgentHandoff({runId:'x',taskId:'y',from:'critic',to:'analyst',summary:''}),null);
});
test('cross-wave handoff is only from independent completed findings', () => {
  const messages = peerHandoffsFor({
    runId:'run',taskId:'task',toRole:'analyst',
    findings:[
      {role:'researcher',summary:'Check whether the sources are current.',recommendation:'investigate'},
      {role:'analyst',summary:'my own work'},
      {role:'critic',summary:'Potentially unsafe assumption',recommendation:'stop'}
    ]
  });
  assert.deepEqual(messages.map(x=>x.from),['researcher','critic']);
  assert.equal(messages[1].type,'risk');
  assert.ok(messages.every(m=>m.to==='analyst' && m.authorizesTools===false));
});
test('do not leak subsystem scope, absent or failed findings into generic panels', () => {
  const messages=peerHandoffsFor({
    runId:'run',taskId:'task',toRole:'communicator',
    findings:[
      {role:'architect',summary:'Project private material',subsystemId:'auth'},
      {role:'tester',summary:'Task failed',status:'failed'},
      {role:'analyst',summary:'Eligible general result'}
    ]
  });
  assert.equal(messages.length,1);
  assert.equal(messages[0].from,'analyst');
});
test('bounded handoffs cannot flood model context', () => {
  const msgs=peerHandoffsFor({runId:'r',taskId:'t',toRole:'integrator',maxMessages:100,
    findings:Array.from({length:20},(_,i)=>({role:'role-'+i,summary:'a'.repeat(2000)}))
  });
  assert.equal(msgs.length,4);
  assert.ok(msgs.every(m=>m.summary.length<=480));
});
test('handoffs are injected into existing prompt as data, not system authority', () => {
  const handoff=createAgentHandoff({runId:'r',taskId:'t',from:'researcher',to:'communicator',summary:'Unverified context'});
  const messages=agentMessages('communicator',{goal:'Summarize the material',peerHandoffs:[handoff]});
  const payload=JSON.parse(messages[1].content);
  assert.equal(payload.peerHandoffs[0].verified,false);
  assert.equal(payload.peerHandoffs[0].to,'communicator');
  assert.match(payload.peerHandoffPolicy,/grant no tools/);
});
