import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from './helpers.js';

test('Design Workspace state is durable across saves and conversation follow-ups', async () => {
  await withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed({ role: 'admin' });
    const auth = { token, workspace };
    const conversationId = 'design-chat-1';

    const created = await call('POST', '/api/runs', {
      ...auth,
      body: {
        goal: 'Create a poster design for the launch.',
        activeSurface: 'design',
        conversationId
      }
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.surface, 'design');

    const state = {
      version: 1,
      canvas: { width: 1600, height: 900, background: '#ffffff' },
      guides: { grid: 8, snap: true, showGrid: true },
      selected: 'title',
      previewing: false,
      objects: [{
        id: 'title', kind: 'text', x: 64, y: 72, width: 600, height: 80,
        text: 'Launch', fontSize: 48, z: 2, rotation: 0, opacity: 1,
        visible: true, locked: false, fill: '#111111'
      }]
    };
    const saved = await call('PUT', `/api/runs/${created.body.id}/design-state`, { ...auth, body: { state } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.state.canvas.width, 1600);
    assert.equal(saved.body.state.objects[0].text, 'Launch');

    const fetched = await call('GET', `/api/runs/${created.body.id}/design-state`, auth);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.state.objects[0].id, 'title');

    const next = await call('POST', '/api/runs', {
      ...auth,
      body: {
        goal: 'Move the title lower and refine the layout.',
        activeSurface: 'design',
        conversationId
      }
    });
    assert.equal(next.status, 201, JSON.stringify(next.body));
    assert.equal(next.body.adaptation.designWorkspace.objects[0].text, 'Launch');
    assert.equal(next.body.adaptation.designWorkspace.canvas.width, 1600);

    const forbidden = await call('PUT', `/api/runs/${next.body.id}/design-state`, {
      ...auth,
      body: { state: { canvas: {}, objects: [] } }
    });
    assert.equal(forbidden.status, 200);
  });

  await withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed({ role: 'admin' });
    const auth = { token, workspace };
    const normal = await call('POST', '/api/runs', { ...auth, body: { goal: 'Explain design systems.' } });
    assert.equal(normal.status, 201);
    const refused = await call('PUT', `/api/runs/${normal.body.id}/design-state`, {
      ...auth,
      body: { state: { canvas: {}, objects: [] } }
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'not-design-workspace');
  });
});
