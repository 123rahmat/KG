import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORKSPACE_ENVIRONMENT_CONTRACTS,
  SURFACE_INTELLIGENCE_PROFILES,
  SURFACE_WORKSPACE_CONTRACTS,
  workspaceEnvironment,
  surfaceIntelligenceProfile
} from '../src/surface-policy.js';
import { decideAgentTopology } from '../src/adaptive-agents.js';

const workspaces = ['normal-chat', 'code', 'research'];

test('the three workspaces have complete operating-environment contracts', () => {
  assert.deepEqual(Object.keys(WORKSPACE_ENVIRONMENT_CONTRACTS), workspaces);
  assert.deepEqual(Object.keys(SURFACE_WORKSPACE_CONTRACTS), workspaces);
  assert.deepEqual(Object.keys(SURFACE_INTELLIGENCE_PROFILES), workspaces);

  for (const workspace of workspaces) {
    const environment = workspaceEnvironment(workspace);
    const profile = surfaceIntelligenceProfile(workspace);
    const contract = SURFACE_WORKSPACE_CONTRACTS[workspace];

    assert.equal(environment, WORKSPACE_ENVIRONMENT_CONTRACTS[workspace]);
    assert.equal(profile, SURFACE_INTELLIGENCE_PROFILES[workspace]);

    for (const key of ['environment', 'stateModel', 'canonicalArtifacts', 'primaryTools', 'verification', 'continuity', 'mutationBoundary', 'escalation']) {
      assert.ok(environment[key], `${workspace} environment is missing ${key}`);
    }
    for (const key of ['objective', 'contextPolicy', 'toolPolicy', 'agentPolicy', 'verificationPolicy', 'creationPolicy', 'escalationPolicy', 'uiPolicy', 'selectionPolicy']) {
      assert.equal(typeof contract[key], 'string', `${workspace} contract is missing ${key}`);
    }
    for (const key of ['maturity', 'priority', 'contextStrategy', 'planningStrategy', 'agentStrategy', 'parallelStrategy', 'verificationStrategy', 'continuityStrategy', 'costStrategy', 'qualityStrategy', 'preferredRoles']) {
      assert.ok(profile[key], `${workspace} intelligence profile is missing ${key}`);
    }
  }
});

test('workspace environments remain specialized while sharing one intelligence core', () => {
  const environments = workspaces.map(workspace => workspaceEnvironment(workspace));
  assert.equal(new Set(environments.map(item => item.environment)).size, workspaces.length);
  assert.equal(new Set(environments.map(item => item.verification)).size, workspaces.length);
  assert.equal(new Set(environments.map(item => item.mutationBoundary)).size, workspaces.length);

  assert.ok(workspaceEnvironment('normal-chat').stateModel.includes('conversation'));
  assert.ok(workspaceEnvironment('code').stateModel.includes('immutable-revision'));
  assert.ok(workspaceEnvironment('research').stateModel.includes('evidence-ledger'));

  // Visual/design work is a NormalChat capability, never a fourth workspace.
  assert.equal(workspaceEnvironment('design'), workspaceEnvironment('normal-chat'));
});

test('agent topology preserves specialization without creating separate model stacks', () => {
  const cases = [
    ['normal-chat', ['respond', 'analyze']],
    ['code', ['analyze', 'code', 'test']],
    ['research', ['research', 'analyze']]
  ];

  for (const [workspace, taskTypes] of cases) {
    const plan = decideAgentTopology({
      workspace,
      tasks: taskTypes.map((type, index) => ({ id: `${workspace}-${index}`, type })),
      scale: 'medium',
      complexity: 0.75,
      uncertainty: 0.45,
      budget: { maxAgents: 6, maxParallelAgents: 3 }
    });

    assert.equal(plan.workspace, workspace);
    assert.ok(plan.workspacePolicy);
    assert.ok(plan.agents.length >= 1);
    assert.ok(plan.agents.every(agent => agent.model === 'google:gemini-3.8-flash'));
    assert.ok(plan.maxParallel >= 1 && plan.maxParallel <= 3);
  }
});
