/** Action privacy and outcome recovery regression tests. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from './helpers.js';
import { RunActions } from '../src/run-actions.js';
import { runDbScope } from '../src/db.js';

test('private-run actions are not visible to another workspace member', () =>
  withServer(async ({ call, seed, pool }) => {
    const owner = await seed({ workspace: 'shared', role: 'editor', name: 'Owner' });
    const peer = await seed({ workspace: 'shared', role: 'viewer', name: 'Peer' });
    const { body: run } = await call('POST', '/api/runs', {
      token: owner.token,
      workspace: 'shared',
      body: { goal: 'Private task', privacyConsent: { modelProvider: true } }
    });
    assert.ok(run.id);
    await runDbScope(
      { principalId: owner.principal.id, workspaceId: 'shared', role: 'editor' },
      () => pool.query(
        `INSERT INTO run_actions (id,run_id,task_id,workspace_id,principal_id,tool,input,summary)
         VALUES ('act-private-test',$1,'respond','shared',$2,'memory.save','{}','private action')`,
        [run.id, owner.principal.id]
      )
    );

    const actions = new RunActions(pool);
    const ownerView = await runDbScope(
      { principalId: owner.principal.id, workspaceId: 'shared', role: 'editor' },
      () => actions.list({ principalId: owner.principal.id, workspaceId: 'shared' }, run.id)
    );
    const peerView = await runDbScope(
      { principalId: peer.principal.id, workspaceId: 'shared', role: 'viewer' },
      () => actions.list({ principalId: peer.principal.id, workspaceId: 'shared' }, run.id)
    );
    assert.equal(ownerView.length, 1);
    assert.equal(peerView.length, 0);

    const routeView = await call('GET', `/api/runs/${run.id}/actions`, {
      token: peer.token,
      workspace: 'shared'
    });
    assert.equal(routeView.status, 404);
  }));

test('expired approved actions become explicitly uncertain instead of hanging forever', () =>
  withServer(async ({ call, seed, pool }) =>
    (async () => {
      const owner = await seed({ workspace: 'shared', role: 'editor', name: 'Owner' });
      const { body: run } = await call('POST', '/api/runs', {
        token: owner.token,
        workspace: 'shared',
        body: { goal: 'Recover action outcome' }
      });
      await pool.query(
        `INSERT INTO run_actions (id,run_id,task_id,workspace_id,principal_id,tool,input,summary,status,lease_until)
         VALUES ('act-expired-test',$1,'respond','shared',$2,'memory.save','{}','expired action','running',now()-interval '1 second')`,
        [run.id, owner.principal.id]
      );
      const actions = new RunActions(pool);
      assert.equal(await actions.recoverExpired({ limit: 10 }), 1);
      const seen = await runDbScope(
        { principalId: owner.principal.id, workspaceId: 'shared', role: 'editor' },
        () => actions.list({ principalId: owner.principal.id, workspaceId: 'shared' }, run.id)
      );
      assert.equal(seen[0].status, 'uncertain');
      assert.equal(seen[0].result.code, 'execution-outcome-uncertain');
    })()
  ));
