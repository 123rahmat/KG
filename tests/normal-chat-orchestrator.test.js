import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalChatControlNeeds,
  runNormalChatControlPlane
} from '../src/normal-chat-orchestrator.js';

const run = extra => ({
  goal: 'Build and test a small application with the attached data.',
  situation: { successCriteria: ['works'], constraints: [] },
  adaptation: { scale: 'standard', dataClasses: ['user-content'] },
  tasks: [{ id: 'understand', type: 'understand', status: 'complete' }, { id: 'respond', type: 'respond', status: 'pending' }],
  ...extra
});

const task = {
  id: 'respond',
  type: 'respond',
  purpose: 'Analyze the attached dataset and summarize the result'
};

test('normal chat identifies the three logical agents without forcing three model calls', () => {
  const result = normalChatControlNeeds({
    run: run(),
    task,
    payload: {
      attachments: [{ name: 'data.csv', kind: 'text', format: 'csv' }],
      codeIntelligence: { project: { fileCount: 4 } },
      workspace: { projectId: 'p1' }
    }
  });
  assert.equal(result.mainExecutor, true);
  assert.equal(result.stepManager, true);
  assert.equal(result.resourceDataManager, true);
  assert.equal(result.code, true);
  assert.equal(result.data, true);
});

test('control managers run independently in parallel and cannot mutate server authority', async () => {
  const calls = [];
  const usage = [];
  let active = 0;
  let peak = 0;
  const result = await runNormalChatControlPlane({
    run: run(),
    task,
    payload: {
      attachments: [{ name: 'data.csv', kind: 'text', format: 'csv' }],
      adaptation: { resourcePlan: { selected: { tools: ['file.read'] } } },
      capabilities: { granted: ['files'] }
    },
    modelId: 'google:gemini-3.8-flash',
    config: { ai: true },
    canSpend: async () => true,
    recordUsage: async value => usage.push(value),
    modelCaller: async (messages, options) => {
      calls.push({ messages, options });
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 0));
      active -= 1;
      const isStep = messages[0].content.includes('You are the Step Manager');
      const body = isStep
        ? { status: 'ready', summary: 'Use the current step.', nextStep: 'build', dependencies: ['api'], replan: { needed: false } }
        : { status: 'ready', summary: 'Scope resources.', toolsToUse: ['file.read'], toolsToAdd: ['data.analyze'], toolsToRemove: ['web.search'], dependencies: ['api'], data: { needed: true, handling: 'Read only the attached dataset.' }, terminalNeeded: true, testsNeeded: true };
      return { text: JSON.stringify(body), provider: 'google', model: options.modelId, usage: { inputTokens: 3, outputTokens: 4 } };
    }
  });
  assert.equal(result.enabled, true);
  assert.equal(result.agents.stepManager.status, 'ready');
  assert.equal(result.agents.resourceDataManager.status, 'ready');
  assert.deepEqual(result.agents.resourceDataManager.toolsToAdd, ['data.analyze']);
  assert.deepEqual(result.agents.resourceDataManager.toolsToRemove, ['web.search']);
  assert.equal(result.agents.resourceDataManager.terminalNeeded, true);
  assert.equal(result.serverGuards.toolAllowList, true);
  assert.equal(result.serverGuards.codeMutation, true);
  assert.equal(calls.length, 2);
  assert.equal(peak, 2);
  assert.equal(usage.length, 2);
  assert.ok(calls.every(item => !item.messages[0].content.includes('tool call')));
});


test('specialist panel owns coordination when generic multi-agent work is already justified', async () => {
  const result = await runNormalChatControlPlane({
    run: run({ adaptation: { scale: 'complex' } }),
    task,
    payload: { workPlan: { steps: ['one', 'two'] } },
    modelId: 'google:gemini-3.8-flash',
    config: { ai: true },
    specialistPanelOwnsCoordination: true,
    modelCaller: async () => {
      throw new Error('manager call should be suppressed');
    }
  });
  assert.equal(result.enabled, false);
  assert.equal(result.needs.stepManager, false);
  assert.equal(result.needs.resourceDataManager, false);
});

test('dedicated coding flows skip duplicate normal-chat manager calls', async () => {
  const result = await runNormalChatControlPlane({
    run: run(),
    task,
    payload: {
      workspace: { projectId: 'p1', revisionId: 'r1' },
      subsystemPlan: { subsystems: [{ id: 's1' }] },
      codeIntelligence: { project: { fileCount: 12 } },
      attachments: [{ name: 'project.zip' }]
    },
    modelId: 'google:gemini-3.8-flash',
    config: { ai: true },
    modelCaller: async () => {
      throw new Error('duplicate manager call');
    }
  });
  assert.equal(result.enabled, true);
  assert.equal(result.dedicatedCodingFlow, true);
  assert.equal(result.agents.stepManager.status, 'not-needed');
  assert.equal(result.agents.resourceDataManager.status, 'not-needed');
});
