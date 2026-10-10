import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from './helpers.js';

test('strict Coding and Research routes prevent off-topic work before model, files and runs', async () => {
  await withServer(async ({call,seed,pool}) => {
    const {token,workspace,principal}=await seed({role:'admin'});
    const auth={token,workspace};
    const create=await call('POST','/api/projects',{...auth,body:{name:'Engineering',defaultSurface:'code'}});
    assert.equal(create.status,201,JSON.stringify(create.body));
    const codeProject=create.body.project.id;

    const legacy=await call('POST','/api/projects',{...auth,body:{name:'General',defaultSurface:'normal-chat'}});
    assert.equal(legacy.status,422);
    assert.equal(legacy.body.code,'control-project-domain-required');

    const declines=await call('POST','/api/runs',{...auth,body:{
      goal:'Book a restaurant tonight',projectId:codeProject,activeSurface:'code'
    }});
    assert.equal(declines.status,422);
    assert.equal(declines.body.code,'control-out-of-scope');

    const plan=await call('POST','/api/plan',{...auth,body:{
      goal:'Write a full academic thesis with citations',projectId:codeProject,activeSurface:'code'
    }});
    assert.equal(plan.status,409);
    assert.equal(plan.body.code,'control-domain-mismatch');

    const counts=await pool.query('SELECT COUNT(*)::int AS n FROM runs WHERE principal_id=$1',[principal.id]);
    assert.equal(counts.rows[0].n,0,'out-of-domain requests should never create a run');

    const legal=await call('POST','/api/runs',{...auth,body:{
      goal:'Explain Python async await with a short example',projectId:codeProject,activeSurface:'code'
    }});
    assert.equal(legal.status,201,JSON.stringify(legal.body));
    assert.equal(legal.body.surface,'code');
    assert.equal(legal.body.adaptation.controlEngineId,'coding');
    const persisted=await pool.query('SELECT control_engine_id,project_id,surface FROM runs WHERE id=$1',[legal.body.id]);
    assert.equal(persisted.rows[0].control_engine_id,'coding');
    assert.equal(persisted.rows[0].project_id,codeProject);

    const change=await call('PATCH',`/api/projects/${codeProject}`,{...auth,body:{defaultSurface:'research'}});
    assert.equal(change.status,409);
    assert.equal(change.body.code,'control-project-immutable');

    const createResearch=await call('POST','/api/projects',{...auth,body:{name:'Paper',defaultSurface:'research'}});
    assert.equal(createResearch.status,201);
    const research=await call('POST','/api/runs',{...auth,body:{
      goal:'Write a complete academic research paper with sources and methods',
      projectId:createResearch.body.project.id,activeSurface:'research'
    }});
    assert.equal(research.status,201,JSON.stringify(research.body));
    assert.equal(research.body.surface,'research');
    assert.equal(research.body.adaptation.controlEngineId,'research');
  },{env:{CODING_RESEARCH_ONLY:'true',MULTI_AGENT_MODE:'off'}});
});
