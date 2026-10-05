import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from './helpers.js';

test('same-chat follow-up inherits the current workspace state for incremental improvement', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const conversationId = 'chat-continuation-01';

    let response = await call('POST', '/api/runs', {
      ...auth,
      body: {
        conversationId,
        goal: 'Build a small website with a navigation bar.',
        files: ['index.html', 'app.js']
      }
    });
    assert.equal(response.status, 201);
    const first = response.body;
    assert.equal(first.adaptation?.continuation, undefined);

    response = await call('POST', `/api/runs/${first.id}/advance`, {
      ...auth,
      body: {
        taskId: 'understand',
        summary: 'The website exists and the navigation bar is the current result.',
        evidence: {
          structured: {
            project: {
              language: 'html',
              files: ['index.html', 'app.js'],
              verified: false
            },
            next: {
              type: 'step',
              title: 'Implement the navigation',
              purpose: 'Implement the requested navigation in the current website.'
            }
          }
        }
      }
    });
    assert.equal(response.status, 200);

    response = await call('POST', '/api/runs', {
      ...auth,
      body: {
        conversationId,
        goal: 'Improve the navigation bar in it without rebuilding the whole website.',
      }
    });
    assert.equal(response.status, 201);
    const followUp = response.body;

    assert.equal(followUp.adaptation?.continuation?.mode, 'incremental');
    assert.equal(followUp.adaptation?.continuation?.previousRunId, first.id);
    assert.equal(followUp.adaptation?.continuation?.currentResultAvailable, true);
    assert.ok(Array.isArray(followUp.adaptation?.conversation));
    assert.match(followUp.adaptation.conversation.at(-1).user, /Build a small website/i);
    assert.match(followUp.adaptation.conversation.at(-1).assistant, /navigation bar/i);
  }));

test('a later follow-up can inherit completed work without importing unrelated workspace data', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const conversationId = 'chat-continuation-02';

    const first = (await call('POST', '/api/runs', {
      ...auth,
      body: {
        conversationId,
        goal: 'Create and verify a small Python API.',
        files: ['app.py', 'test_app.py']
      }
    })).body;

    await call('POST', `/api/runs/${first.id}/advance`, {
      ...auth,
      body: {
        taskId: 'understand',
        summary: 'The API structure is understood.',
        evidence: {
          structured: {
            completedArtifact: {
              kind: 'project',
              files: ['app.py', 'test_app.py']
            },
            next: {
              type: 'code',
              title: 'Build the API',
              purpose: 'Build the current API implementation.'
            }
          }
        }
      }
    });

    const followUp = (await call('POST', '/api/runs', {
      ...auth,
      body: {
        conversationId,
        goal: 'Change only the API response format and keep the existing tests.'
      }
    })).body;

    assert.equal(followUp.adaptation?.continuation?.mode, 'incremental');
    assert.ok(followUp.adaptation?.conversation?.length >= 1);
    assert.match(followUp.adaptation.conversation.at(-1).user, /Create and verify a small Python API/i);
    assert.match(followUp.adaptation.conversation.at(-1).assistant, /API structure/i);
  }));


test('workspace switching preserves chat history but isolates workspace-specific state', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed({ role: 'admin' });
    const auth = { token, workspace };
    const conversationId = 'chat-workspace-switch-01';

    const design = (await call('POST', '/api/runs', {
      ...auth,
      body: {
        conversationId,
        activeSurface: 'design',
        goal: 'Create a product launch visual with a simple layout.'
      }
    })).body;

    await call('PUT', `/api/runs/${design.id}/design-state`, {
      ...auth,
      body: {
        state: {
          canvas: { width: 1000, height: 700, background: '#fff' },
          guides: { grid: 20, snap: true, showGrid: true },
          selected: 'hero',
          previewing: false,
          objects: [
            { id: 'hero', kind: 'rect', x: 10, y: 10, width: 200, height: 100, fill: '#eee', visible: true, locked: false }
          ]
        }
      }
    });

    const code = await call('POST', '/api/runs', {
      ...auth,
      body: {
        conversationId,
        activeSurface: 'code',
        goal: 'Start a new software project from scratch with a small API.'
      }
    });
    assert.equal(code.status, 201);
    assert.equal(code.body.adaptation?.continuation?.mode, 'workspace-switch');
    assert.equal(code.body.adaptation?.designWorkspace, null);
    assert.equal(code.body.adaptation?.projectOverlay, undefined);
    assert.ok(Array.isArray(code.body.adaptation?.conversation));
  }));
