import test from 'node:test';
import assert from 'node:assert/strict';
import { admitControlEngineRequest } from '../src/control-engine-admission.js';

const req = changes => ({
  scope: { workspaceId: 'tenant-a', principalId: 'person-a' },
  principalId: 'person-a',
  projectId: 'code-project',
  activeSurface: 'code',
  goal: 'Explain how Python async await works',
  ...changes
});
const fake = (project = { id:'code-project', default_surface:'code',state:'active',current_revision:'sha1' },
              previous = []) => {
  const calls = [];
  const pool = { async query(sql, args) {
    calls.push({sql,args});
    if (sql.includes('FROM projects')) return { rows:project ? [project] : [] };
    if (sql.includes('FROM runs')) return { rows:previous };
    throw new Error('unexpected SQL');
  }};
  return {pool,calls};
};

test('authorized Coding project binds to one controller and pinned revision', async () => {
  const {pool,calls}=fake();
  const decision=await admitControlEngineRequest({pool,...req()});
  assert.equal(decision.controlEngineId,'coding');
  assert.equal(decision.projectRevision,'sha1');
  assert.equal(decision.projectId,'code-project');
  assert.equal(calls.length,1);
  assert.ok(/workspace_id/.test(calls[0].sql));
  assert.ok(/principal_id/.test(calls[0].sql));
});

test('the workspace selection or project label cannot silently switch a controller', async () => {
  const {pool}=fake();
  await assert.rejects(admitControlEngineRequest({pool,...req({activeSurface:'research'})}),{
    code:'control-surface-mismatch'
  });
  await assert.rejects(admitControlEngineRequest({pool,...req({goal:'Write a full research thesis with citations'})}),{
    code:'control-domain-mismatch'
  });
});

test('the new product rejects unrelated requests without safety strikes or provider calls', async () => {
  const {pool,calls}=fake();
  await assert.rejects(admitControlEngineRequest({pool,...req({goal:'What is the weather forecast?'})}),{
    code:'control-out-of-scope'
  });
  assert.equal(calls.length,1);
});

test('mixed requests require an explicit split, not a silent discarded request', async () => {
  const {pool}=fake();
  await assert.rejects(
    admitControlEngineRequest({pool,...req({goal:'Fix Python code and remind me tomorrow'})}),
    { code:'control-mixed-request' }
  );
});

test('only a server-authorized matching previous project turn permits short follow-up', async () => {
  const {pool}=fake(undefined,[{id:'r1',surface:'code',goal:'Fix the bug'}]);
  const admitted=await admitControlEngineRequest({pool,...req({goal:'Continue this',conversationId:'valid-conv'})});
  assert.equal(admitted.controlEngineId,'coding');
  const none=fake();
  await assert.rejects(admitControlEngineRequest({
    pool:none.pool,...req({goal:'Continue this',conversationId:'unknown'})
  }),{code:'control-clarification-required'});
});

test('legacy normal-chat projects and inaccessible projects do not admit new work', async () => {
  const old=fake({id:'historical',default_surface:'normal-chat',state:'active'});
  await assert.rejects(admitControlEngineRequest({pool:old.pool,...req({projectId:'historical'})}),{
    code:'control-historical-project'
  });
  const missing=fake(null);
  await assert.rejects(admitControlEngineRequest({pool:missing.pool,...req()}),{
    code:'control-project-not-found'
  });
});

test('no project means no costly classification or file retrieval', async () => {
  let called=false;
  const pool={async query(){called=true;throw Error('unexpected query')}};
  await assert.rejects(admitControlEngineRequest({pool,...req({projectId:''})}),{
    code:'control-project-required'
  });
  assert.equal(called,false);
});
