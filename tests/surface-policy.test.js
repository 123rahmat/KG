import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySurfaceBoundary,
  normalChatAllowsTask,
  surfaceRuntimePolicy,
  SURFACE_WORKSPACE_CONTRACTS,
  SURFACE_INTELLIGENCE_PROFILES,
  surfaceIntelligenceProfile
} from '../src/surface-policy.js';
import { resolveAdaptiveContext } from '../src/adaptive.js';

test('normal chat stays on the shared adaptive intelligence', () => {
  const decision = classifySurfaceBoundary('Explain this diagram step by step.', {
    attachments: [{ name: 'diagram.png' }],
    flags: { file: true },
    actions: ['answer']
  });
  assert.equal(decision.surface, 'normal-chat');
  assert.equal(decision.redirect, false);
  assert.equal(surfaceRuntimePolicy('normal-chat').maxDepth, 'adaptive');
  assert.equal(surfaceRuntimePolicy('normal-chat').heavyAutonomy, 'adaptive');
});

test('explicit coding work is routed out of normal chat', () => {
  const decision = classifySurfaceBoundary('Debug this GitHub repository and fix the failing tests.', {
    activeSurface: 'normal-chat',
    flags: { code: true },
    actions: ['answer', 'transform']
  });
  assert.equal(decision.surface, 'code');
  assert.equal(decision.redirect, true);
  assert.equal(normalChatAllowsTask({ goal: 'Debug this GitHub repository and fix the failing tests.' }).allowed, false);
});

test('deep research is routed out of normal chat', () => {
  const decision = classifySurfaceBoundary('Do a comprehensive literature review with sources and citations.', {
    activeSurface: 'normal-chat',
    flags: { research: true },
    actions: ['answer', 'investigate']
  });
  assert.equal(decision.surface, 'research');
  assert.equal(decision.redirect, true);
});

test('code explanation remains normal chat while code work routes out', () => {
  const decision = classifySurfaceBoundary('Explain this code step by step.', {
    activeSurface: 'normal-chat', flags: { code: true }, actions: ['answer']
  });
  assert.equal(decision.surface, 'normal-chat');
  assert.equal(decision.redirect, false);
});

test('medium analysis remains normal chat', () => {
  const decision = classifySurfaceBoundary('Compare these two explanations and tell me which is easier for a beginner.', {
    activeSurface: 'normal-chat',
    flags: {},
    actions: ['answer']
  });
  assert.equal(decision.surface, 'normal-chat');
  assert.equal(decision.complexity, 'adaptive');
});


test('each workspace exposes a distinct operating contract over the same intelligence', () => {
  assert.equal(SURFACE_WORKSPACE_CONTRACTS['normal-chat'].mode, 'conversation-first');
  assert.equal(SURFACE_WORKSPACE_CONTRACTS.code.mode, 'repository-engineering');
  assert.equal(SURFACE_WORKSPACE_CONTRACTS.research.mode, 'evidence-first-investigation');
  assert.equal(SURFACE_WORKSPACE_CONTRACTS.code.agentPolicy.includes('immutable revision'), true);
  assert.equal(SURFACE_WORKSPACE_CONTRACTS.research.verificationPolicy.includes('observed facts'), true);
});

test('active workspace context is preserved and compound work exposes only the supporting workspace', () => {
  const code = classifySurfaceBoundary('Explain this function and fix the repository tests.', {
    activeSurface: 'code',
    flags: { code: true },
    actions: ['answer', 'transform']
  });
  assert.equal(code.surface, 'code');
  assert.equal(code.redirect, false);

  const adaptive = resolveAdaptiveContext('Research the current dependency release and then update the repository.', {
    activeSurface: 'code',
    attachedCode: true,
    files: [{ name: 'package.json' }],
    attachments: [{ name: 'package.json' }]
  });
  assert.equal(adaptive.primarySurface, 'code');
  assert.ok(adaptive.adaptiveSnapshot.resourcePlan.selected.surfaces.includes('code'));
  assert.ok(adaptive.adaptiveSnapshot.resourcePlan.selected.surfaces.includes('research'));
});


test('selected Code Workspace remains stable for context-dependent follow-ups', () => {
  const decision = classifySurfaceBoundary('Why did that fail?', {
    activeSurface: 'code',
    flags: {},
    actions: ['answer']
  });
  assert.equal(decision.surface, 'code');
  assert.equal(decision.transition, 'stay');
  assert.equal(decision.redirect, false);
});

test('selected Research Workspace remains stable for context-dependent follow-ups', () => {
  const decision = classifySurfaceBoundary('Summarize the strongest finding so far.', {
    activeSurface: 'research',
    flags: {},
    actions: ['answer']
  });
  assert.equal(decision.surface, 'research');
  assert.equal(decision.transition, 'stay');
  assert.equal(decision.redirect, false);
});

test('explicit cross-mode intent switches the operating workspace', () => {
  const research = classifySurfaceBoundary('Switch to Research Workspace and verify the current dependency release.', {
    activeSurface: 'code',
    flags: { research: true },
    actions: ['answer', 'investigate']
  });
  assert.equal(research.surface, 'research');
  assert.equal(research.transition, 'switch');
  assert.equal(research.redirect, true);

  const code = classifySurfaceBoundary('Open the Code Workspace and fix the failing test.', {
    activeSurface: 'research',
    flags: { code: true },
    actions: ['answer', 'transform']
  });
  assert.equal(code.surface, 'code');
  assert.equal(code.transition, 'switch');
  assert.equal(code.redirect, true);
});

test('adaptive context exposes all four public operating modes', () => {
  const context = resolveAdaptiveContext('Research the current dependency release and then update the repository.', {
    activeSurface: 'code',
    attachedCode: true,
    files: [{ name: 'package.json' }],
    attachments: [{ name: 'package.json' }]
  });
  assert.deepEqual(context.adaptiveSnapshot.modeRouting.publicModes, ['design', 'normal-chat', 'code', 'research']);
  assert.equal(context.adaptiveSnapshot.modeRouting.primary, 'code');
  assert.ok(context.adaptiveSnapshot.modeRouting.supporting.includes('research'));
});


test('ZIP workspace routing follows archive contents', () => {
  const code = classifySurfaceBoundary('Review this zip project and fix the bug.', {
    attachments: [{ name: 'project.zip', archiveKind: 'code-project' }]
  });
  assert.equal(code.surface, 'code');

  const research = classifySurfaceBoundary('Work from the supplied research archive.', {
    attachments: [{ name: 'papers.zip', archiveKind: 'research-bundle' }]
  });
  assert.equal(research.surface, 'research');

  const documents = classifySurfaceBoundary('Summarize the supplied archive.', {
    attachments: [{ name: 'documents.zip', archiveKind: 'document-bundle' }]
  });
  assert.equal(documents.surface, 'normal-chat');
});

test('neutral and mixed attachments remain in Normal Chat', () => {
  const neutral = classifySurfaceBoundary('Summarize these files for me.', {
    activeSurface: 'normal-chat',
    attachments: [
      { name: 'report.pdf', format: 'pdf' },
      { name: 'notes.docx', format: 'docx' }
    ],
    actions: ['answer']
  });
  assert.equal(neutral.surface, 'normal-chat');

  const mixed = classifySurfaceBoundary('Explain what is in this archive.', {
    activeSurface: 'normal-chat',
    attachments: [{ name: 'bundle.zip', format: 'bundle', archiveKind: 'mixed-bundle' }],
    actions: ['answer']
  });
  assert.equal(mixed.surface, 'normal-chat');
});

test('archive contents outrank the .zip extension', () => {
  const code = classifySurfaceBoundary('Fix the project in this archive.', {
    activeSurface: 'normal-chat',
    attachments: [{ name: 'anything.zip', format: 'project', archiveKind: 'code-project' }],
    actions: ['answer', 'transform', 'execute']
  });
  assert.equal(code.surface, 'code');

  const research = classifySurfaceBoundary('Use the supplied papers to answer this.', {
    activeSurface: 'normal-chat',
    attachments: [{ name: 'anything.zip', format: 'bundle', archiveKind: 'research-bundle' }],
    actions: ['answer', 'investigate']
  });
  assert.equal(research.surface, 'research');
});

test('Normal Chat remains the general adaptive mode for non-deep workspace work', () => {
  const contract = SURFACE_WORKSPACE_CONTRACTS['normal-chat'];
  assert.match(contract.objective, /general adaptive operating mode/i);
  assert.match(contract.creationPolicy, /planning|analysis|file understanding/i);
  assert.match(contract.escalationPolicy, /Research|Code/);
  assert.equal(contract.sharedIntelligence, true);
  assert.equal(contract.adaptiveAgents, true);
  assert.equal(contract.adaptiveTools, true);
  assert.equal(contract.adaptiveVerification, true);

  const decision = classifySurfaceBoundary('Help me plan a business launch and organize the work.', {
    activeSurface: 'normal-chat',
    flags: {},
    actions: ['answer', 'create']
  });
  assert.equal(decision.surface, 'normal-chat');
  assert.equal(decision.redirect, false);
});


test('Normal Chat retains adaptive depth and shared agent policy', () => {
  const runtime = surfaceRuntimePolicy('normal-chat');
  assert.equal(runtime.maxDepth, 'adaptive');
  assert.equal(runtime.heavyAutonomy, 'adaptive');
  const task = normalChatAllowsTask({ goal: 'Design a better workflow and adapt it as new constraints appear.' });
  assert.equal(task.allowed, true);
  assert.equal(task.maxDepth, 'adaptive');
  assert.equal(task.agents, 'shared-adaptive-and-justified');
});


test('Normal Chat owns bounded micro and single-file work', () => {
  const single = classifySurfaceBoundary('Fix this Python file and run its tests.', {
    activeSurface: 'normal-chat',
    flags: { code: true },
    actions: ['answer', 'transform', 'execute'],
    attachments: [{ name: 'tool.py' }]
  });
  assert.equal(single.surface, 'normal-chat');
  assert.equal(single.complexity, 'adaptive');

  const twoFiles = classifySurfaceBoundary('Fix these Python files and run the tests.', {
    activeSurface: 'normal-chat',
    flags: { code: true },
    actions: ['answer', 'transform', 'execute'],
    attachments: [{ name: 'a.py' }, { name: 'b.py' }]
  });
  assert.equal(twoFiles.surface, 'code');

  const project = classifySurfaceBoundary('Build and deploy the application.', {
    activeSurface: 'normal-chat',
    flags: { code: true },
    actions: ['answer', 'create', 'execute'],
    attachments: [{ name: 'main.py' }]
  });
  assert.equal(project.surface, 'code');
});


test('each surface has an explicit maturity profile without creating a second brain', () => {
  const normal = surfaceIntelligenceProfile('normal-chat');
  const code = surfaceIntelligenceProfile('code');
  const research = surfaceIntelligenceProfile('research');
  const design = surfaceIntelligenceProfile('design');
  assert.equal(normal.id, 'normal-chat-intelligence');
  assert.equal(code.id, 'code-intelligence');
  assert.equal(research.id, 'research-intelligence');
  assert.equal(design.id, 'design-intelligence');
  assert.equal(normal.contextStrategy, 'minimum-sufficient-context');
  assert.match(code.contextStrategy, /revision-first/i);
  assert.match(research.contextStrategy, /question-first/i);
  assert.match(code.parallelStrategy, /disjoint immutable-revision/i);
  assert.match(research.verificationStrategy, /provenance/i);
  assert.equal(design.maturity, 'deep-visual');
  assert.match(normal.costStrategy, /one strong model call/i);
  assert.deepEqual(Object.keys(SURFACE_INTELLIGENCE_PROFILES), ['design', 'normal-chat', 'code', 'research']);
});
