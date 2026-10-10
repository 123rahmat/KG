import test from 'node:test';
import assert from 'node:assert/strict';
import { controlWorkflowChatView } from '../public/control-workflow-view.js';

const run = (surface, policy) => ({ surface,
  adaptation: { modeController: { workflowPolicy: policy } }
});
const coding = {
  advisoryOnly:true,controller:'coding',action:'implement',
  candidateStages:[{id:'inspect-revision'},{id:'implement'},{id:'test'},{id:'verify'}],
  compute:{modelEffort:'high',optionalAgentCeiling:3,mandatoryVerification:true},
  quality:{missingEvidence:['authenticated-test-receipt']}
};

test('Coding chat labels suggestions rather than fake execution results', () => {
  const view=controlWorkflowChatView(run('code',coding),'code');
  assert.match(view.title,/Implement/i);
  assert.match(view.suggestion,/inspect-revision.*implement.*test/);
  assert.match(view.cost,/Up to 3 optional/);
  assert.match(view.verification,/required/);
  assert.match(view.footer,/not completed work/);
});
test('Research chat uses its own policy, not Coding control state', () => {
  const policy={...coding,controller:'research',action:'investigate',compute:{
    modelEffort:'low',optionalAgentCeiling:0,mandatoryVerification:true
  }};
  const view=controlWorkflowChatView(run('research',policy),'research');
  assert.equal(view.engineLabel,'Research Control');
  assert.match(view.cost,/No optional specialist/);
  assert.equal(controlWorkflowChatView(run('code',policy),'code'),null);
});
test('workspace switching does not display another project workflow', () => {
  assert.equal(controlWorkflowChatView(run('code',coding),'research'),null);
  assert.equal(controlWorkflowChatView(run('normal-chat',coding),'normal-chat'),null);
  assert.equal(controlWorkflowChatView({surface:'code'},'code'),null);
});
