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


test('workspace switching preserves chat history while visual work stays in NormalChat', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed({ role: 'admin' });
    const auth = { token, workspace };
    const conversationId = 'chat-workspace-switch-01';

    const visual = (await call('POST', '/api/runs', {
      ...auth,
      body: {
        conversationId,
        activeSurface: 'normal-chat',
        goal: 'Create a product launch visual with a simple layout.'
      }
    })).body;
    assert.equal(visual.surface, 'chat');
    assert.equal(visual.adaptation?.designWorkspace, undefined);

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
    assert.equal(code.body.adaptation?.designWorkspace, undefined);
    assert.ok(Array.isArray(code.body.adaptation?.conversation));
    assert.match(code.body.adaptation.conversation.at(-1).user, /product launch visual/i);
  }));

test('three workspace runs expose their persisted task graph on creation and after a real task transition', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const scenarios = [
      { surface: 'normal-chat', goal: 'Explain the purpose of a resistor.' },
      { surface: 'code', goal: 'Build a small Python API with tests.' },
      { surface: 'research', goal: 'Research the current battery recycling options with citations.' }
    ];
    for (const scenario of scenarios) {
      const create = await call('POST', '/api/runs', {
        ...auth, body: { goal: scenario.goal, activeSurface: scenario.surface }
      });
      assert.equal(create.status, 201, scenario.surface);
      const run = create.body;
      const graph = run.adaptation?.unifiedAdaptiveWorkflow?.taskGraph;
      assert.equal(graph?.authoritative, 'server-run-tasks', scenario.surface);
      assert.ok(graph?.nodes?.length > 0, scenario.surface);
      assert.equal(graph.total, run.tasks.length, scenario.surface);
      assert.deepEqual(graph.nodes.map(node => node.id), run.tasks.map(item => item.id));
      const current = run.tasks.find(item => item.status === 'pending');
      if (current?.type === 'understand') {
        const advance = await call('POST', `/api/runs/${run.id}/advance`, {
          ...auth, body: { taskId: 'understand', summary: 'Goal and constraints understood.',
            evidence: { structured: { goalUnderstood: true } } }
        });
        assert.equal(advance.status, 200, scenario.surface);
        const after = advance.body;
        const nextGraph = after.adaptation?.unifiedAdaptiveWorkflow?.taskGraph;
        assert.equal(nextGraph?.authoritative, 'server-run-tasks');
        assert.equal(nextGraph?.total, after.tasks.length);
        assert.ok(nextGraph.revision > graph.revision);
        const refresh = await call('GET', `/api/runs/${run.id}`, auth);
        assert.equal(refresh.status, 200);
        assert.deepEqual(refresh.body.adaptation?.unifiedAdaptiveWorkflow?.taskGraph,
          nextGraph, 'An authorized read must agree with the persisted checkpoint');
        for (const item of after.tasks) {
          const node = nextGraph.nodes.find(part => part.id === item.id);
          assert.equal(node?.status, item.status, item.id);
        }
      }
    }
  }));

test('workspace switches retain conversation but discard implicitly inherited project and controller state', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    for (const [destination, goal, explicit] of [
      ['normal-chat', 'Teach me algebra with worked examples', true],
      ['research', 'Research GitHub adoption using credible sources', false]
    ]) {
      const conversationId = `chat-state-isolation-${destination}`;
      const first = await call('POST', '/api/runs', { ...auth, body: {
        conversationId, activeSurface: 'code', goal: 'Fix the GitHub repository and run its tests',
        project: { id: 'old-repository' }, files: ['app.js'], currentState: { marker: 'old-controller-state' }
      } });
      assert.equal(first.status, 201);
      assert.ok(first.body.adaptation.projectContext.key);
      const next = await call('POST', '/api/runs', { ...auth, body: {
        conversationId, ...(explicit ? { activeSurface: destination } : {}), goal
      } });
      assert.equal(next.status, 201);
      const run = next.body;
      assert.equal(run.surface, destination === 'normal-chat' ? 'chat' : destination);
      assert.equal(run.adaptation.continuation.mode, 'workspace-switch');
      assert.equal(run.adaptation.projectContext.key, null);
      assert.equal(run.adaptation.unifiedWorkContext.situation.currentState, null);
      assert.equal(run.situation.state.current, null);
      assert.deepEqual(run.situation.state.priorWork, []);
      assert.match(run.adaptation.conversation.at(-1).user, /GitHub repository/);
      assert.equal(run.adaptation.modeController.mode, destination);
      const read = await call('GET', `/api/runs/${run.id}`, auth);
      assert.equal(read.status, 200);
      assert.equal(read.body.adaptation.unifiedWorkContext.situation.currentState, null);
    }
  }));

test('file lookup after a project change cannot resurrect another project in the same chat', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const conversationId = 'chat-historical-project-isolation';
    const upload = await call('POST', '/api/objects', { ...auth, body: {
      name: 'project-a.js', type: 'attachment', contentType: 'text/plain', content: 'console.log("project A")'
    } });
    assert.equal(upload.status, 201);
    const first = await call('POST', '/api/runs', { ...auth, body: {
      conversationId, activeSurface: 'code', project: { id: 'project-a' },
      goal: 'Fix this repository', attachments: [upload.body.id]
    } });
    assert.equal(first.status, 201);
    const second = await call('POST', '/api/runs', { ...auth, body: {
      conversationId, activeSurface: 'code', project: { id: 'project-b' },
      goal: 'Build a new API repository with tests'
    } });
    assert.equal(second.status, 201);
    const key = second.body.adaptation.projectContext.key;
    assert.notEqual(key, first.body.adaptation.projectContext.key);
    const third = await call('POST', '/api/runs', { ...auth, body: {
      conversationId, goal: 'Now add a test for this repository'
    } });
    assert.equal(third.status, 201);
    assert.equal(third.body.adaptation.projectContext.key, key);
    assert.equal(third.body.adaptation.unifiedWorkContext.identity.key, key);
    assert.equal(third.body.adaptation.attachments, undefined);
    assert.equal(third.body.adaptation.projectOverlay, undefined);
    assert.deepEqual(third.body.adaptation.unifiedWorkContext.filesystem.attachments, []);
    assert.equal(third.body.adaptation.continuation.previousRunId, second.body.id);
    assert.equal(third.body.adaptation.unifiedWorkContext.situation.currentState.runId, second.body.id);
  }));
