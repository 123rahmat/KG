import test from 'node:test';
import assert from 'node:assert/strict';
import { normalChatTaskProfile } from '../src/normal-chat-task-profile.js';
import { classifySurfaceBoundary } from '../src/surface-policy.js';
import { buildModeControllerContract } from '../src/mode-controllers.js';
import { workspaceCapabilities } from '../public/normal-chat-capabilities.js';
import { planGoal } from '../src/core.js';
import { resolveAdaptiveContext } from '../src/adaptive.js';

test('everyday chat, teaching, business strategy and mathematical reasoning remain in Normal Chat', () => {
  for (const goal of [
    'What is the weather today in my city?',
    'Check the latest news and explain what happened',
    'Compare current laptop prices for my budget',
    'Teach me Python programming step by step',
    'Explain what a systematic literature review means to a student',
    'Solve a difficult differential equation and verify the steps',
    'Build a business plan for an API-based startup',
    'Prepare an education course plan and learning roadmap',
    'Explain how an existing GitHub application works',
    'Draft a five-year business model with revenue assumptions'
  ]) {
    const boundary = classifySurfaceBoundary(goal, {
      activeSurface: 'normal-chat',
      actions: ['answer', 'create'],
      flags: { code: true, research: true }
    });
    assert.equal(boundary.surface,'normal-chat',goal);
    assert.equal(boundary.redirect,false,goal);
  }
});

test('everyday Normal Chat retains multi-file document work and optional sandbox', () => {
  const files = [{name:'report.docx'},{name:'budget.xlsx'},{name:'source.pdf'}];
  const boundary = classifySurfaceBoundary('Edit and compare my Word, Excel and PDF files',{
    activeSurface:'normal-chat',attachments:files, actions:['answer','transform']
  });
  assert.equal(boundary.surface,'normal-chat');
  const cap = workspaceCapabilities({goal:'Edit and compare my Word, Excel and PDF files',attachments:files});
  assert.equal(cap.fileCount,3);
  assert.equal(cap.multiFile,true);
  assert.equal(cap.suggestedWorkspace,null);
  assert.equal(cap.sandboxReady,false);
});

test('real software engineering and evidence-heavy thesis work retain dedicated controls', () => {
  for(const [goal,surface] of [
    ['Fix the GitHub repository and run its regression tests','code'],
    ['Build a complete frontend and backend application','code'],
    ['Write a systematic literature review with citations','research'],
    ['Research battery recycling and compare credible sources','research'],
    ['Write a dissertation based on peer-reviewed studies','research']
  ]) {
    assert.equal(classifySurfaceBoundary(goal,{activeSurface:'normal-chat',
      actions:['answer','investigate','create','transform']}).surface,surface,goal);
  }
  for (const [surface,goal] of [
    ['code','Why did these tests fail?'],
    ['research','Summarize the strongest findings so far']
  ]) {
    assert.equal(classifySurfaceBoundary(goal,{activeSurface:surface}).surface,surface);
  }
});

test('Normal Chat escalates reasoning depth without routing or recruiting automatically', () => {
  for (const [goal,domain,depth] of [
    ['Hello, how are you?','everyday','direct'],
    ['Teach algebra to a high-school student','education','focused'],
    ['Prove a difficult mathematical theorem step-by-step','education','deep'],
    ['Develop a marketing plan for a startup','business-planning','focused'],
    ['Build a financial forecast with sensitivity analysis','business-planning','deep']
  ]) {
    const p = normalChatTaskProfile({goal});
    assert.equal(p.workspace,'normal-chat');
    assert.equal(p.domain,domain,goal);
    assert.equal(p.reasoningDepth,depth,goal);
    assert.equal(p.toolPolicy,'just-in-time-authorized-only');
    assert.equal(p.agentPolicy,'single-primary-model-no-specialist-recruitment');
    assert.equal(p.suggestedTransition,null);
    assert.equal(p.serverAuthorityRequired,true);
  }
});

test('situation risk and file transformations strengthen verification, not privileges', () => {
  const doc = normalChatTaskProfile({goal:'Edit these files',attachments:[{name:'a.pdf'}]});
  assert.equal(doc.domain,'file-work');
  assert.equal(doc.verification,'check-observable-claims-and-artifacts');
  const risk = normalChatTaskProfile({goal:'Advise on a situation',risk:'high'});
  assert.equal(risk.verification,'check-observable-claims-and-artifacts');
  const tough = normalChatTaskProfile({goal:'Explain gravity',complexity:.9,uncertainty:.8});
  assert.equal(tough.reasoningDepth,'deep');
  assert.equal(tough.domain,'education');
});

test('three workspace controller contracts stay independent while sharing security authority', () => {
  const chat = buildModeControllerContract({surface:'normal-chat',
    situation:{goal:'Teach multi-step mathematics with examples'},
    complexity:.8,uncertainty:.5,remainingBudgetRatio:.12});
  assert.equal(chat.mode,'normal-chat');
  assert.equal(chat.everyday?.reasoningDepth,'deep');
  assert.equal(chat.everyday?.domain,'education');
  assert.equal(chat.compute.recommendedAgents,1);
  assert.equal(chat.compute.maxParallel,1);
  assert.equal(chat.decision.defaultAction,'direct');
  const code = buildModeControllerContract({surface:'code',
    situation:{goal:'Teach multi-step mathematics with examples'},complexity:.8});
  const research = buildModeControllerContract({surface:'research',
    situation:{goal:'Teach multi-step mathematics with examples'},complexity:.8});
  assert.equal(code.everyday,undefined);
  assert.equal(research.everyday,undefined);
  assert.equal(code.mode,'code');
  assert.equal(research.mode,'research');
  assert.notEqual(code.controller,research.controller);
});

test('UI and server distinguish the requested work from software or research topics', () => {
  for (const [goal, workspace] of [
    ['Teach me how to build an API with code examples', 'normal-chat'],
    ['Explain how an existing GitHub application works', 'normal-chat'],
    ['Build a business plan for an API-based startup', 'normal-chat'],
    ['Explain a systematic literature review to a student', 'normal-chat'],
    ['Research GitHub adoption using credible sources', 'research'],
    ['Research battery recycling', 'research'],
    ['Investigate deployment failure rates using peer-reviewed studies', 'research'],
    ['Research the dependency release and then update the repository', 'code'],
    ['Explain the failing GitHub tests and then fix them', 'code'],
    ['Investigate the failing repository tests and fix them', 'code'],
    ['Investigate this GitHub repository bug and implement a fix', 'code'],
    ['Research the dependency release, then update package.json', 'code'],
    ['Research the Python API and implement it', 'code'],
    ['Teach me Python and test my understanding', 'normal-chat'],
    ['Create a project plan for a community garden', 'normal-chat'],
    ['Create a customer service training plan', 'normal-chat'],
    ['Build a complete frontend and backend application', 'code']
  ]) {
    const boundary = classifySurfaceBoundary(goal, { actions: ['answer', 'create', 'transform'], flags: { code: true, research: true } });
    assert.equal(boundary.surface, workspace, goal);
    assert.equal(workspaceCapabilities({ goal }).suggestedWorkspace,
      workspace === 'normal-chat' ? null : workspace, goal);
    const plan = planGoal(goal, { activeSurface: 'normal-chat' });
    assert.equal(plan.surface, workspace === 'normal-chat' ? 'chat' : workspace, goal);
    assert.equal(plan.adaptation.modeController.mode, workspace, goal);
  }
});

test('business and educational wording does not expose a software execution affordance', () => {
  for (const goal of ['Build a business plan for an API-based startup', 'Teach me how to build an API with code examples']) {
    const capabilities = workspaceCapabilities({ goal });
    assert.equal(capabilities.showSandbox, false, goal);
    assert.equal(capabilities.suggestedWorkspace, null, goal);
  }
});

test('explicit workspace selection outranks incidental topic and attachment classification', () => {
  for (const [goal, workspace, attachments] of [
    ['Open Research Workspace and examine this GitHub repository', 'research', [{ name: 'repo.zip', archiveKind: 'code-project' }]],
    ['Open Code Workspace and implement a citation checker', 'code', [{ name: 'sources.zip', archiveKind: 'research-bundle' }]]
  ]) {
    assert.equal(classifySurfaceBoundary(goal, { attachments }).surface, workspace);
    assert.equal(workspaceCapabilities({ goal, attachments }).suggestedWorkspace, workspace);
  }
});

test('selected file context reaches the Normal Chat controller without content or privileges', () => {
  const goal = 'Improve this and explain your changes';
  const attachments = [{ name: 'draft.docx', text: 'Private document content' }];
  const context = resolveAdaptiveContext(goal, { attachedArtifacts: ['draft.docx'] });
  const plan = planGoal(goal, { attachments });
  for (const controller of [context.modeController, plan.adaptation.modeController]) {
    assert.equal(controller.mode, 'normal-chat');
    assert.equal(controller.everyday.domain, 'file-work');
    assert.ok(controller.everyday.contextPriorities.includes('selected-attachments'));
    assert.equal(controller.everyday.verification, 'check-observable-claims-and-artifacts');
    assert.equal(controller.everyday.toolPolicy, 'just-in-time-authorized-only');
    assert.equal(JSON.stringify(controller).includes('Private document content'), false);
  }
});
