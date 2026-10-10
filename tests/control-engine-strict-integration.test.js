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

    await assert.rejects(
      pool.query("UPDATE runs SET control_engine_id='research' WHERE id=$1",[legal.body.id]),
      { code:'23514' },
      'DB trigger must block changing the owning controller'
    );
    await assert.rejects(
      pool.query('UPDATE runs SET project_id=NULL WHERE id=$1',[legal.body.id]),
      { code:'23514' },
      'DB trigger must block changing project identity'
    );

    const change=await call('PATCH',`/api/projects/${codeProject}`,{...auth,body:{defaultSurface:'research'}});
    assert.equal(change.status,409);
    assert.equal(change.body.code,'control-project-immutable');

    const createResearch=await call('POST','/api/projects',{...auth,body:{name:'Paper',defaultSurface:'research'}});
    assert.equal(createResearch.status,201);
    const otherCode=await call('POST','/api/projects',{...auth,body:{
      name:'Other code project',defaultSurface:'code'
    }});
    assert.equal(otherCode.status,201);
    const conversationId='controller-test-123';
    const firstConversation=await call('POST','/api/runs',{...auth,body:{
      goal:'Explain Python module imports',projectId:codeProject,activeSurface:'code',
      conversationId
    }});
    assert.equal(firstConversation.status,201,JSON.stringify(firstConversation.body));
    const wrongProject=await call('POST','/api/runs',{...auth,body:{
      goal:'Continue this',projectId:otherCode.body.project.id,activeSurface:'code',
      conversationId
    }});
    assert.equal(wrongProject.status,422,'Without same-project history a generic follow-up must not be admitted');
    // A pre-migration (uncontrolled) run cannot silently become trusted
    // history in an otherwise authorized controller conversation.
    await pool.query(`
      INSERT INTO runs (
        id, workspace_id, principal_id, goal, surface, state,
        intent, capabilities, governance, adaptation, situation, requirements,
        project_id, visibility, attempt, max_attempts, max_tokens,
        conversation_id, control_engine_id
      )
      SELECT gen_random_uuid(), workspace_id, principal_id, goal, surface, state,
        intent, capabilities, governance, adaptation, situation, requirements,
        project_id, visibility, attempt, max_attempts, max_tokens,
        conversation_id, NULL
      FROM runs WHERE id=$1
    `,[firstConversation.body.id]);
    const ambiguousHistory=await call('POST','/api/runs',{...auth,body:{
      goal:'Continue this',projectId:codeProject,activeSurface:'code',conversationId
    }});
    assert.equal(ambiguousHistory.status,409,JSON.stringify(ambiguousHistory.body));
    assert.equal(ambiguousHistory.body.code,'control-conversation-mismatch');

    const research=await call('POST','/api/runs',{...auth,body:{
      goal:'Write a complete academic research paper with sources and methods',
      projectId:createResearch.body.project.id,activeSurface:'research'
    }});
    assert.equal(research.status,201,JSON.stringify(research.body));
    assert.equal(research.body.surface,'research');
    assert.equal(research.body.adaptation.controlEngineId,'research');
    // Active project identity is immutable for a run: a moving revision
    // must suspend task execution until a new checked run is created.
    const updated=await call('PATCH',`/api/projects/${codeProject}`,{
      ...auth,body:{currentRevision:'changed-after-run'}
    });
    assert.equal(updated.status,200,JSON.stringify(updated.body));
    const stale=await call('POST',`/api/runs/${legal.body.id}/execute`,{...auth,body:{}});
    assert.equal(stale.status,409,JSON.stringify(stale.body));
    assert.equal(stale.body.code,'control-stale-revision');

    // Database insertion must not accept a forged controller run with an
    // adaptation snapshot differing from the serialized project revision.
    await assert.rejects(pool.query(`
      INSERT INTO runs (
        id, workspace_id, principal_id, goal, surface, state,
        intent, capabilities, governance, adaptation, situation, requirements,
        project_id, visibility, attempt, max_attempts, max_tokens,
        conversation_id, control_engine_id
      )
      SELECT gen_random_uuid(), workspace_id, principal_id, goal, surface, state,
        intent, capabilities, governance, adaptation, situation, requirements,
        project_id, visibility, attempt, max_attempts, max_tokens,
        NULL, control_engine_id
      FROM runs WHERE id=$1
    `,[legal.body.id]), {code:'23514'});

    const archived=await call('POST',`/api/projects/${codeProject}/archive`,auth);
    assert.equal(archived.status,200);
    const unavailable=await call('POST',`/api/runs/${legal.body.id}/execute`,{...auth,body:{}});
    assert.equal(unavailable.status,409);
    assert.equal(unavailable.body.code,'control-project-changed');

  },{env:{CODING_RESEARCH_ONLY:'true',MULTI_AGENT_MODE:'off'}});
});
