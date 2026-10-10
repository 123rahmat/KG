import test from 'node:test';
import assert from 'node:assert/strict';
import {
  submissionProjectId,submissionWorkspaceSurface
} from '../public/conversation-submission-scope.js';

test('an existing Coding or Research chat stays bound to its original project',()=>{
  assert.equal(submissionProjectId({
    currentProjectId:'different-project',
    chatProjectId:'coding-project',hasSavedRuns:true
  }),'coding-project');
  assert.equal(submissionProjectId({
    currentProjectId:'some-project',
    chatProjectId:null,hasSavedRuns:true
  }),null,'do not silently move a projectless existing conversation');
  assert.equal(submissionProjectId({
    currentProjectId:null,chatProjectId:'research-project',hasSavedRuns:true
  }),'research-project');
});
test('a new chat intentionally uses the selected project without losing a bound fallback',()=>{
  assert.equal(submissionProjectId({
    currentProjectId:'selected-project',
    chatProjectId:'earlier-project',hasSavedRuns:false
  }),'selected-project');
  assert.equal(submissionProjectId({
    currentProjectId:null,chatProjectId:'default-project',hasSavedRuns:false
  }),'default-project');
  assert.equal(submissionProjectId({}),null);
});
test('saved conversations preserve their established Coding/Research surface',()=>{
  assert.equal(submissionWorkspaceSurface({
    chatSurface:'code',chosenSurface:'research',hasSavedRuns:true
  }),'code');
  assert.equal(submissionWorkspaceSurface({
    chatSurface:'research',chosenSurface:'code',hasSavedRuns:true
  }),'research');
  assert.equal(submissionWorkspaceSurface({
    chatSurface:'normal-chat',chosenSurface:'code',hasSavedRuns:true
  }),'normal-chat');
  assert.equal(submissionWorkspaceSurface({
    chatSurface:null,chosenSurface:'code',hasSavedRuns:false
  }),'code');
  assert.equal(submissionWorkspaceSurface({
    chatSurface:null,chosenSurface:'research',hasSavedRuns:false
  }),'research');
  assert.equal(submissionWorkspaceSurface({
    chatSurface:null,chosenSurface:'unknown',hasSavedRuns:false
  }),'normal-chat');
});
