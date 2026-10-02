import test from 'node:test';
import assert from 'node:assert/strict';
import { codePlanApprovalRequired } from '../src/runs.js';

test('coding plan approval is required for new substantive builds', () => {
  assert.equal(codePlanApprovalRequired({
    goal: 'Build a production web application',
    adaptation: { scale: 'complex' },
    situation: { artifacts: [] }
  }), true);
});

test('coding plan approval is required when working from an existing codebase', () => {
  assert.equal(codePlanApprovalRequired({
    goal: 'Improve the application',
    adaptation: {
      scale: 'medium',
      attachments: [{ name: 'project.zip' }]
    },
    situation: { artifacts: [] }
  }), true);

  assert.equal(codePlanApprovalRequired({
    goal: 'Continue improving the existing project',
    adaptation: {
      scale: 'small',
      ownWork: true
    },
    situation: { artifacts: [] }
  }), true);
});

test('small standalone coding can remain direct when there is no existing project plan to review', () => {
  assert.equal(codePlanApprovalRequired({
    goal: 'Write a tiny helper function',
    adaptation: { scale: 'small' },
    situation: { artifacts: [] }
  }), false);
});

test('user plan choices remain structured by category', () => {
  const choices = {
    keepExisting: ['auth module', 'existing tests'],
    removeExisting: ['legacy endpoint'],
    addNew: ['rate limiting', 'regression tests'],
    changeExisting: ['replace session handling']
  };
  assert.deepEqual(Object.keys(choices), [
    'keepExisting', 'removeExisting', 'addNew', 'changeExisting'
  ]);
  assert.equal(choices.keepExisting.length, 2);
  assert.equal(choices.removeExisting[0], 'legacy endpoint');
  assert.equal(choices.addNew.includes('rate limiting'), true);
  assert.equal(choices.changeExisting.includes('replace session handling'), true);
});
