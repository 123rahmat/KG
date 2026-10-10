import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from './helpers.js';

test('Project Hub creates a project and binds new runs to it', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed({ role: 'admin' });
    const auth = { token, workspace };

    const created = await call('POST', '/api/projects', {
      ...auth,
      body: {
        name: 'Website launch',
        description: 'Product website work',
        defaultSurface: 'code',
        visibility: 'private'
      }
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.project.name, 'Website launch');
    assert.equal(created.body.project.defaultSurface, 'code');

    const run = await call('POST', '/api/runs', {
      ...auth,
      body: {
        goal: 'Fix the navigation',
        activeSurface: 'code',
        projectId: created.body.project.id
      }
    });
    assert.equal(run.status, 201, JSON.stringify(run.body));
    assert.equal(run.body.projectId, created.body.project.id);
    assert.equal(run.body.adaptation?.projectContext?.key, 'project:' + created.body.project.id);

    const conversations = await call('GET', '/api/conversations?limit=20', auth);
    assert.equal(conversations.status, 200);
    assert.equal(conversations.body.conversations[0].projectId, created.body.project.id);

    const projects = await call('GET', '/api/projects?limit=20', auth);
    assert.equal(projects.status, 200);
    assert.equal(projects.body.projects[0].id, created.body.project.id);
    assert.equal(projects.body.projects[0].conversations, 1);
  }));

test('private projects do not leak to another principal in the same workspace', () =>
  withServer(async ({ call, seed }) =>
    (async () => {
      const owner = await seed({ workspace: 'shared-ws', role: 'admin', name: 'Owner' });
      const other = await seed({ workspace: 'shared-ws', role: 'viewer', name: 'Other' });

      const created = await call('POST', '/api/projects', {
        token: owner.token, workspace: owner.workspace,
        body: { name: 'Private work', visibility: 'private' }
      });
      assert.equal(created.status, 201);

      const hidden = await call('GET', '/api/projects/' + created.body.project.id, {
        token: other.token, workspace: other.workspace
      });
      assert.equal(hidden.status, 404);
    })()));

test('workspace-visible projects are readable by viewers but write-gated by role', () =>
  withServer(async ({ call, seed }) =>
    (async () => {
      const owner = await seed({ workspace: 'shared-ws-2', role: 'admin', name: 'Owner' });
      const viewer = await seed({ workspace: 'shared-ws-2', role: 'viewer', name: 'Viewer' });

      const created = await call('POST', '/api/projects', {
        token: owner.token, workspace: owner.workspace,
        body: { name: 'Shared project', visibility: 'workspace', defaultSurface: 'research' }
      });
      assert.equal(created.status, 201);

      const visible = await call('GET', '/api/projects/' + created.body.project.id, {
        token: viewer.token, workspace: viewer.workspace
      });
      assert.equal(visible.status, 200);
      assert.equal(visible.body.project.visibility, 'workspace');

      const denied = await call('PATCH', '/api/projects/' + created.body.project.id, {
        token: viewer.token, workspace: viewer.workspace,
        body: { name: 'Should not change' }
      });
      assert.equal(denied.status, 403);
    })()));

test('runs reject a project outside the current workspace', () =>
  withServer(async ({ call, seed }) =>
    (async () => {
      const first = await seed({ workspace: 'project-ws-a', role: 'admin' });
      const second = await seed({ workspace: 'project-ws-b', role: 'admin' });

      const created = await call('POST', '/api/projects', {
        token: first.token, workspace: first.workspace,
        body: { name: 'Only in A' }
      });
      assert.equal(created.status, 201);

      const run = await call('POST', '/api/runs', {
        token: second.token, workspace: second.workspace,
        body: { goal: 'Try to use another workspace project', projectId: created.body.project.id }
      });
      assert.equal(run.status, 404);
      assert.equal(run.body.code, 'project-not-found');
    })()));

test('a project lists distinct conversations even when one chat has many runs', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace }=await seed({role:'admin'});
    const auth={token,workspace};
    const created=await call('POST','/api/projects',{...auth,
      body:{name:'Parallel work',defaultSurface:'code',visibility:'private'}});
    assert.equal(created.status,201);
    const projectId=created.body.project.id;
    // A long Code thread used to consume the raw SQL LIMIT before another
    // Research/Code conversation could appear.
    for(let i=0;i<7;i++){
      const resp=await call('POST','/api/runs',{...auth,body:{
        goal:i?'Improve the code in iteration '+i+'.':'Start a Code Workspace dashboard project.',
        projectId,conversationId:'long-code-project-chat',activeSurface:'code'
      }});
      assert.equal(resp.status,201,JSON.stringify(resp.body));
    }
    for(const [id,goal,surface] of [
      ['separate-research-chat','Research the latest testing patterns.','research'],
      ['separate-code-chat','Fix the UI navigation regression.','code']
    ]){
      const resp=await call('POST','/api/runs',{...auth,body:{
        goal,projectId,conversationId:id,activeSurface:surface
      }});
      assert.equal(resp.status,201,JSON.stringify(resp.body));
    }
    const response=await call('GET','/api/conversations?projectId='
      +encodeURIComponent(projectId)+'&limit=3',auth);
    assert.equal(response.status,200);
    const chats=response.body.conversations;
    assert.equal(chats.length,3);
    assert.equal(new Set(chats.map(chat=>chat.id)).size,3);
    assert.ok(chats.some(chat=>chat.id==='separate-research-chat'&&chat.surface==='research'));
    assert.ok(chats.some(chat=>chat.id==='separate-code-chat'&&chat.surface==='code'));
    const long=chats.find(chat=>chat.id==='long-code-project-chat');
    assert.ok(long);
    assert.equal(long.messages,7);
    assert.equal(long.title,'Start a Code Workspace dashboard project.');
    assert.ok(chats.every(chat=>chat.projectId===projectId));
  }));

test('server filters find older Coding and Research chats beyond the most recent unfiltered page', () =>
  withServer(async ({call,seed})=>{
    const {token,workspace}=await seed({role:'admin'});
    const auth={token,workspace};
    const created=await call('POST','/api/projects',{...auth,body:{
      name:'Two concurrent domains',defaultSurface:'research',visibility:'private'
    }});
    assert.equal(created.status,201);
    const projectId=created.body.project.id;
    const samples=[
      ['r-older-chat','Research source dates for the autumn release','research'],
      ['c-middle-chat','Implement the web backend authentication','code'],
      ['c-latest-chat','Fix sidebar layout and CSS','code']
    ];
    for(const [id,goal,activeSurface] of samples){
      const res=await call('POST','/api/runs',{...auth,body:{
        conversationId:id,goal,activeSurface,projectId
      }});
      assert.equal(res.status,201,JSON.stringify(res.body));
    }
    const unfiltered=await call('GET','/api/conversations?limit=1',auth);
    assert.equal(unfiltered.status,200);
    assert.equal(unfiltered.body.conversations.length,1);
    const older=await call('GET','/api/conversations?surface=research&limit=1',auth);
    assert.equal(older.status,200);
    assert.deepEqual(older.body.conversations.map(item=>item.id),['r-older-chat']);
    const scoped=await call('GET','/api/conversations?projectId='+encodeURIComponent(projectId)
      +'&surface=code&limit=2',auth);
    assert.deepEqual(scoped.body.conversations.map(item=>item.id),['c-latest-chat','c-middle-chat']);
    const searched=await call('GET','/api/conversations?search=AUTUMN&status=working&limit=1',auth);
    assert.deepEqual(searched.body.conversations.map(item=>item.id),['r-older-chat']);
    const literal=await call('GET','/api/conversations?search=%25&limit=10',auth);
    assert.equal(literal.body.conversations.length,0,
      'percent-sign search uses literal matching, never unbounded SQL wildcards');
    const unrelated=await call('GET','/api/conversations?projectId=unrelated&surface=research',auth);
    assert.deepEqual(unrelated.body.conversations,[]);
  }));
