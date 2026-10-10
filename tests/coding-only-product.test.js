import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProject } from '../src/projects.js';
import { admitControlEngineRequest, verifyControlledRun } from '../src/control-engine-admission.js';
import { withServer } from './helpers.js';

const scope = { workspaceId: 'workspace-a', principalId: 'owner-a' };
const request = (overrides = {}) => ({
  scope, principalId: scope.principalId,
  projectId: 'project-a', activeSurface: 'code',
  goal: 'Fix a React component and run focused tests',
  codingOnly: true, ...overrides
});
const stub = surface => {
  const calls = [];
  return {
    calls,
    pool: { async query(sql) {
      calls.push(sql);
      if (sql.includes('FROM projects')) return { rows: [{
        id: 'project-a', default_surface: surface, state: 'active', current_revision: 'commit-1'
      }] };
      if (sql.includes('FROM runs')) return { rows: [] };
      throw Error('Unexpected query');
    }}
  };
};

test('coding-only project normalization defaults to Code and rejects inactive domains', () => {
  assert.equal(normalizeProject({ name: 'Engineering' }, { codingOnly: true }).defaultSurface, 'code');
  for (const surface of ['research', 'normal-chat']) {
    assert.throws(() => normalizeProject({ name: 'Disallowed', defaultSurface: surface }, {
      codingOnly: true, codingResearchOnly: true
    }), { code: 'control-coding-only' });
  }
  assert.equal(normalizeProject({ name: 'Legacy paper', defaultSurface: 'research' }, {
    codingResearchOnly: true
  }).defaultSurface, 'research', 'legacy two-controller mode remains compatible');
});

test('coding-only admission never grants research project write authority', async () => {
  const research = stub('research');
  await assert.rejects(admitControlEngineRequest({ pool: research.pool, ...request() }), {
    code: 'control-coding-only'
  });
  assert.equal(research.calls.length, 1, 'reject before classification and history');
  const oldChat = stub('normal-chat');
  await assert.rejects(admitControlEngineRequest({ pool: oldChat.pool, ...request() }), {
    code: 'control-coding-only'
  });
  const coding = stub('code');
  const accepted = await admitControlEngineRequest({ pool: coding.pool, ...request() });
  assert.equal(accepted.controlEngineId, 'coding');
  assert.equal(accepted.projectRevision, 'commit-1');
});

test('coding-only admission rejects scholarly deliverables and unrelated topics early', async () => {
  const project = stub('code');
  await assert.rejects(admitControlEngineRequest({
    pool: project.pool, ...request({ goal: 'Write a full academic research thesis with citations' })
  }), { code: 'control-coding-only' });
  await assert.rejects(admitControlEngineRequest({
    pool: project.pool, ...request({ goal: 'What is the weather forecast?' })
  }), { code: 'control-out-of-scope' });
  await assert.rejects(admitControlEngineRequest({
    pool: project.pool, ...request({ projectId: '' })
  }), { code: 'control-project-required' });
});

test('coding-only execution gate rejects old research even when runtime metadata is forged', async () => {
  let queried = 0;
  const blocked = await verifyControlledRun({
    pool: { async query() { queried += 1; return { rows: [] }; } },
    scope, principalId: scope.principalId, codingOnly: true,
    run: {
      id: 'old-research', principalId: scope.principalId, surface: 'research',
      projectId: 'paper-project', adaptation: { controlEngineId: 'research' }
    }
  });
  assert.equal(blocked.code, 'control-historical-read-only');
  assert.equal(queried, 0);
});

test('CODING_ONLY enforces project, run and plan ownership at HTTP boundaries', async () => {
  await withServer(async ({ call, seed, pool }) => {
    const { token, workspace } = await seed({ role: 'admin' });
    const auth = { token, workspace };
    const contract = await call('GET', '/api/adaptive-contract', auth);
    assert.equal(contract.status, 200);
    assert.equal(contract.body.product.codingOnly, true);
    assert.deepEqual(contract.body.product.supportedWorkspaces, ['code']);
    for (const defaultSurface of ['research', 'normal-chat']) {
      const response = await call('POST', '/api/projects', {
        ...auth, body: { name: 'Rejected legacy', defaultSurface }
      });
      assert.equal(response.status, 422, JSON.stringify(response.body));
      assert.equal(response.body.code, 'control-coding-only');
    }
    const created = await call('POST', '/api/projects', {
      ...auth, body: { name: 'KG codebase', defaultSurface: 'code' }
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const projectId = created.body.project.id;
    const plan = await call('POST', '/api/plan', {
      ...auth, body: {
        goal: 'Write a complete scholarly research manuscript',
        projectId, activeSurface: 'code'
      }
    });
    assert.equal(plan.status, 422);
    assert.equal(plan.body.code, 'control-coding-only');
    const createdRun = await call('POST', '/api/runs', {
      ...auth, body: {
        goal: 'Fix the JavaScript validation bug and add a regression test',
        projectId, activeSurface: 'code'
      }
    });
    assert.equal(createdRun.status, 201, JSON.stringify(createdRun.body));
    assert.equal(createdRun.body.surface, 'code');
    assert.equal(createdRun.body.adaptation?.controlEngineId, 'coding');
    const saved = await pool.query('SELECT control_engine_id FROM runs WHERE id=$1', [createdRun.body.id]);
    assert.equal(saved.rows[0].control_engine_id, 'coding');
    const retarget = await call('PATCH', '/api/projects/' + projectId, {
      ...auth, body: { defaultSurface: 'research' }
    });
    assert.equal(retarget.status, 409);
    assert.equal(retarget.body.code, 'control-project-immutable');
  }, { env: { CODING_ONLY: 'true', CODING_RESEARCH_ONLY: 'true', MULTI_AGENT_MODE: 'off' } });
});
