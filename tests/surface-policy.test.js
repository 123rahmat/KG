import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySurfaceBoundary, normalChatAllowsTask, surfaceRuntimePolicy,
  SURFACE_WORKSPACE_CONTRACTS, SURFACE_INTELLIGENCE_PROFILES, surfaceIntelligenceProfile
} from '../src/surface-policy.js';
import { resolveAdaptiveContext } from '../src/adaptive.js';

test('product contract exposes exactly NormalChat, Code, and Research', () => {
  assert.deepEqual(Object.keys(SURFACE_WORKSPACE_CONTRACTS), ['normal-chat','code','research']);
  assert.deepEqual(Object.keys(SURFACE_INTELLIGENCE_PROFILES), ['normal-chat','code','research']);
  assert.equal(SURFACE_WORKSPACE_CONTRACTS['normal-chat'].mode, 'conversation-first');
  assert.equal(SURFACE_WORKSPACE_CONTRACTS.code.mode, 'repository-engineering');
  assert.equal(SURFACE_WORKSPACE_CONTRACTS.research.mode, 'evidence-first-investigation');
});

test('normal chat stays lightweight and owns files and visual/design capability', () => {
  for (const goal of ['Explain this diagram step by step.', 'Design a logo concept.', 'Create a presentation visual.']) {
    const decision = classifySurfaceBoundary(goal, { activeSurface:'normal-chat', actions:['answer','create'] });
    assert.equal(decision.surface, 'normal-chat', goal);
  }
  assert.equal(surfaceRuntimePolicy('normal-chat').maxDepth, 'adaptive');
  assert.equal(normalChatAllowsTask({goal:'Design a better workflow.'}).allowed, true);
});

test('repository and multi-file engineering route to Code while micro code can stay NormalChat', () => {
  assert.equal(classifySurfaceBoundary('Debug this GitHub repository and fix the failing tests.', {
    activeSurface:'normal-chat', flags:{code:true}, actions:['transform','execute']
  }).surface, 'code');
  assert.equal(classifySurfaceBoundary('Fix this Python file and run its test.', {
    activeSurface:'normal-chat', flags:{code:true}, actions:['transform','execute'], attachments:[{name:'tool.py'}]
  }).surface, 'normal-chat');
  assert.equal(classifySurfaceBoundary('Fix these Python files and run the tests.', {
    activeSurface:'normal-chat', flags:{code:true}, actions:['transform','execute'], attachments:[{name:'a.py'},{name:'b.py'}]
  }).surface, 'normal-chat');
  assert.equal(classifySurfaceBoundary('Refactor the complete repository project.', {
    activeSurface:'normal-chat', flags:{code:true}, actions:['transform','execute'], attachments:[{name:'a.py'},{name:'b.py'}]
  }).surface, 'code');
});

test('source-heavy/current evidence work routes to Research', () => {
  assert.equal(classifySurfaceBoundary('Do a comprehensive literature review with sources and citations.', {
    activeSurface:'normal-chat', flags:{research:true}, actions:['answer','investigate']
  }).surface, 'research');
});

test('Code and Research remain sticky for ordinary follow-ups', () => {
  assert.equal(classifySurfaceBoundary('Why did that fail?', {activeSurface:'code',actions:['answer']}).surface,'code');
  assert.equal(classifySurfaceBoundary('Summarize the strongest finding so far.', {activeSurface:'research',actions:['answer']}).surface,'research');
});

test('explicit cross-mode intent switches between Code and Research', () => {
  const research=classifySurfaceBoundary('Switch to Research Workspace and verify the current dependency release.', {
    activeSurface:'code', flags:{research:true}, actions:['investigate']
  });
  assert.equal(research.surface,'research'); assert.equal(research.transition,'switch');
  const code=classifySurfaceBoundary('Open the Code Workspace and fix the failing test.', {
    activeSurface:'research', flags:{code:true}, actions:['transform']
  });
  assert.equal(code.surface,'code'); assert.equal(code.transition,'switch');
});

test('adaptive context exposes exactly three public modes and supports compound Code plus Research', () => {
  const context=resolveAdaptiveContext('Research the current dependency release and then update the repository.', {
    activeSurface:'code', attachedCode:true, files:[{name:'package.json'}], attachedArtifacts:[{name:'package.json'}]
  });
  assert.deepEqual(Object.keys(SURFACE_WORKSPACE_CONTRACTS), ['normal-chat','code','research']);
  assert.equal(context.primarySurface,'code');
  assert.ok(context.resourcePlan.selected.surfaces.includes('research'));
  assert.ok(context.resourcePlan.selected.surfaces.every(surface => ['chat','code','research'].includes(surface)));
});

test('archive contents outrank the zip extension', () => {
  assert.equal(classifySurfaceBoundary('Fix the project in this archive.', {
    attachments:[{name:'anything.zip',format:'project',archiveKind:'code-project'}],actions:['transform','execute']
  }).surface,'code');
  assert.equal(classifySurfaceBoundary('Use the supplied papers to answer this.', {
    attachments:[{name:'papers.zip',format:'bundle',archiveKind:'research-bundle'}],actions:['investigate']
  }).surface,'research');
  assert.equal(classifySurfaceBoundary('Summarize this archive.', {
    attachments:[{name:'docs.zip',format:'bundle',archiveKind:'document-bundle'}],actions:['answer']
  }).surface,'normal-chat');
});

test('specialized maturity profiles share one intelligence while differing by work', () => {
  const normal=surfaceIntelligenceProfile('normal-chat');
  const code=surfaceIntelligenceProfile('code');
  const research=surfaceIntelligenceProfile('research');
  assert.equal(normal.id,'normal-chat-intelligence');
  assert.match(code.contextStrategy,/revision-first/i);
  assert.match(code.parallelStrategy,/disjoint immutable-revision/i);
  assert.match(research.contextStrategy,/question-first/i);
  assert.match(research.verificationStrategy,/provenance/i);
  assert.match(normal.costStrategy,/one primary model with adaptive reasoning effort/i);
});
