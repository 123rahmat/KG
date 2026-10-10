import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from './helpers.js';

/**
 * The feature switch is server-owned. These tests use a real isolated
 * PostgreSQL + API route fixture, not just a mocked text classifier.
 * Historical read must survive; no unsupported domain may start/advance.
 */
test('KG_CODING_ONLY enforces project, request, task owner and revision through API', async () => {
  await withServer(async ({ call, seed, pool }) => {
    const { token, workspace, principal } = await seed({ role:'admin' });
    const auth = {token,workspace};
    const contract = await call('GET','/api/adaptive-contract',auth);
    assert.equal(contract.status,200);
    assert.equal(contract.body.product.codingOnly,true);
    assert.deepEqual(contract.body.product.supportedWorkspaces,['code']);

    const created = await call('POST','/api/projects',{...auth,
      body:{name:'Engineering workspace',defaultSurface:'code'}});
    assert.equal(created.status,201,JSON.stringify(created.body));
    const projectId=created.body.project.id;

    for(const defaultSurface of ['research','normal-chat']){
      const rejected=await call('POST','/api/projects',{...auth,
        body:{name:'Rejected project',defaultSurface}});
      assert.equal(rejected.status,422,JSON.stringify(rejected.body));
      assert.equal(rejected.body.code,'code-only-project-required');
    }
    const researchPlan=await call('POST','/api/plan',{...auth,body:{
      goal:'Write an academic research paper and thesis',
      projectId, activeSurface:'code'
    }});
    assert.equal(researchPlan.status,422,JSON.stringify(researchPlan.body));
    assert.equal(researchPlan.body.code,'code-only-task-required');
    const offTopic=await call('POST','/api/runs',{...auth,body:{
      goal:'Book a restaurant reservation', projectId, activeSurface:'code'
    }});
    assert.equal(offTopic.status,422);
    assert.equal(offTopic.body.code,'control-out-of-scope');
    const wrongSurface=await call('POST','/api/runs',{...auth,body:{
      goal:'Implement Python unit tests',projectId,activeSurface:'research'
    }});
    assert.equal(wrongSurface.status,409);
    assert.equal(wrongSurface.body.code,'control-surface-mismatch');
    const preflightCount=await pool.query(
      'SELECT COUNT(*)::int AS n FROM runs WHERE principal_id=$1',[principal.id]);
    assert.equal(preflightCount.rows[0].n,0);

    const legal=await call('POST','/api/runs',{...auth,body:{
      goal:'Implement a Python API endpoint and add rate limiting, and run regression tests without deleting existing routes',
      projectId,activeSurface:'code'
    }});
    assert.equal(legal.status,201,JSON.stringify(legal.body));
    assert.equal(legal.body.surface,'code');
    assert.equal(legal.body.adaptation.controlEngineId,'coding');
    const persistedCoverage=await pool.query('SELECT requirements, adaptation FROM runs WHERE id=$1',[legal.body.id]);
    const userNeeds=persistedCoverage.rows[0].adaptation?.codingUserNeeds;
    const checklist=persistedCoverage.rows[0].requirements?.items
      ?.filter(item=>item.explicitCoverage===true) ?? [];
    assert.ok(userNeeds?.explicitCriteria?.length>=3,'server persists explicit user requests');
    assert.ok(checklist.some(item=>item.requirement==='without deleting existing routes'));
    assert.ok(checklist.every(item=>item.status!=='satisfied'),'creation cannot pretend the user need was verified');
    const persisted=await pool.query(
      'SELECT project_id,surface,control_engine_id FROM runs WHERE id=$1',[legal.body.id]);
    assert.deepEqual(
      [persisted.rows[0].project_id,persisted.rows[0].surface,persisted.rows[0].control_engine_id],
      [projectId,'code','coding']
    );
    // The project revision is immutable for this run. A later project
    // update must force a fresh authorized revision before execution.
    const changed=await call('PATCH',`/api/projects/${projectId}`,{
      ...auth,body:{currentRevision:'repo-revision-v2'}});
    assert.equal(changed.status,200,JSON.stringify(changed.body));
    const stale=await call('POST',`/api/runs/${legal.body.id}/execute`,{
      ...auth,body:{}});
    assert.equal(stale.status,409,JSON.stringify(stale.body));
    assert.equal(stale.body.code,'control-stale-revision');
    // Even after rejection the original work and ownership stay intact.
    const after=await pool.query(
      'SELECT project_id,surface,control_engine_id FROM runs WHERE id=$1',[legal.body.id]);
    assert.deepEqual(after.rows,persisted.rows);
  },{env:{KG_CODING_ONLY:'true',CODING_RESEARCH_ONLY:'false',MULTI_AGENT_MODE:'off'}});
});

test('KG_CODING_ONLY cannot be bypassed by enabling the old two-engine flag', async () => {
  await withServer(async ({call,seed})=>{
    const {token,workspace}=await seed({role:'admin'});
    const auth={token,workspace};
    const research=await call('POST','/api/projects',{...auth,body:{
      name:'Research attempt',defaultSurface:'research'
    }});
    assert.equal(research.status,422,JSON.stringify(research.body));
    assert.equal(research.body.code,'code-only-project-required');
    const code=await call('POST','/api/projects',{...auth,body:{
      name:'Code project',defaultSurface:'code'
    }});
    assert.equal(code.status,201,JSON.stringify(code.body));
    const plan=await call('POST','/api/plan',{...auth,body:{
      projectId:code.body.project.id,activeSurface:'code',
      goal:'Draft a complete thesis with citations'
    }});
    assert.equal(plan.status,422);
    assert.equal(plan.body.code,'code-only-task-required');
  },{env:{KG_CODING_ONLY:'true',CODING_RESEARCH_ONLY:'true',MULTI_AGENT_MODE:'off'}});
});

test('KG Code shared project view never grants edit or archive authority',async()=>{
  await withServer(async ({call,seed,pool})=>{
    const owner=await seed({role:'editor',workspace:'team'});
    const collaborator=await seed({role:'editor',workspace:'team'});
    const ownerAuth={token:owner.token,workspace:'team'};
    const guestAuth={token:collaborator.token,workspace:'team'};
    const created=await call('POST','/api/projects',{...ownerAuth,body:{
      name:'Shared coding project',defaultSurface:'code',visibility:'workspace'
    }});
    assert.equal(created.status,201,JSON.stringify(created.body));
    const id=created.body.project.id;
    const visible=await call('GET',`/api/projects/${id}`,guestAuth);
    assert.equal(visible.status,200);
    assert.equal(visible.body.project.id,id);
    const changed=await call('PATCH',`/api/projects/${id}`,{
      ...guestAuth,body:{currentRevision:'attacker-revision'}});
    assert.equal(changed.status,403,JSON.stringify(changed.body));
    assert.equal(changed.body.code,'code-project-owner-required');
    const archived=await call('POST',`/api/projects/${id}/archive`,guestAuth);
    assert.equal(archived.status,403,JSON.stringify(archived.body));
    assert.equal(archived.body.code,'code-project-owner-required');
    const persisted=await pool.query(
      'SELECT state,current_revision,principal_id FROM projects WHERE id=$1',[id]);
    assert.equal(persisted.rows[0].state,'active');
    assert.equal(persisted.rows[0].current_revision,null);
    assert.equal(persisted.rows[0].principal_id,owner.principal.id);
    const ownerChange=await call('PATCH',`/api/projects/${id}`,{
      ...ownerAuth,body:{currentRevision:'valid-owner-revision'}});
    assert.equal(ownerChange.status,200,JSON.stringify(ownerChange.body));
  },{env:{KG_CODING_ONLY:'true',MULTI_AGENT_MODE:'off'}});
});
