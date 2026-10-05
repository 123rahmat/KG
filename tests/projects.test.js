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
    })());

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
    })());

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
    })());
