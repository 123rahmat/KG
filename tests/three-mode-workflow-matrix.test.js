/**
 * Representative, cross-module workflow checks for all three independent UI
 * workspaces. These are deterministic integration/policy tests, NOT live model,
 * browser, actual container, provider, or external-search execution.
 *
 * Full production validation additionally requires the existing PostgreSQL,
 * browser, sandbox, security and live-evaluation suites.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalChatTaskProfile } from '../src/normal-chat-task-profile.js';
import { workspaceComputePolicy, buildModeControllerContract } from '../src/mode-controllers.js';
import { evidenceNextTaskGate } from '../src/evidence-next-task-gate.js';
import { buildProjectIndex } from '../src/project-index.js';
import { compileCodeContext } from '../src/context-compiler.js';
import {
  appendOpenWorldWork, recordOpenWorldOutcome, openWorldFrontier
} from '../src/open-world-task-graph.js';
import { createResearchWorkspaceState, normalizeResearchSources } from '../src/research-workspace.js';
import { workspaceProgressPanel } from '../public/work-progress-panels.js';
import { liveWorkFocus } from '../public/live-work-focus.js';
import { parseFlowDiagram } from '../public/flow-diagram.js';

const task = (type, status = 'running', evidence = {}) => ({
  id: 'active', type, status, evidence, purpose: 'Work on the requested outcome'
});
const run = (surface, active, extra = {}) => ({
  id: 'matrix-run', state: 'running', next: 'active',
  surface, tasks: [active], adaptation: {}, ...extra
});
const requirements = status => ({
  items: [{ required: true, status }]
});

test('NormalChat: direct, educational, business, file and visual workflows', async t => {
  await t.test('small daily request remains direct with one model and no extra panel', () => {
    const profile = normalChatTaskProfile({ goal: 'Hello!' });
    const compute = workspaceComputePolicy({ surface: 'normal-chat', complexity: 0.01 });
    const focus = liveWorkFocus(run('normal-chat', task('respond')), { workspace: 'normal-chat' });
    assert.equal(profile.reasoningDepth, 'direct');
    assert.equal(profile.presentation.mode, 'conversational');
    assert.equal(compute.maxParallel, 1);
    assert.equal(compute.recommendedAgents, 1);
    assert.equal(focus.showDetails, false);
  });
  await t.test('hard educational reasoning remains in NormalChat and requests a worked explanation', () => {
    const profile = normalChatTaskProfile({ goal: 'Prove a difficult algebra theorem step by step' });
    const controller = buildModeControllerContract({
      surface: 'normal-chat',
      situation: { goal: 'Prove a difficult algebra theorem step by step' },
      complexity: 0.92, uncertainty: 0.7
    });
    assert.equal(profile.domain, 'education');
    assert.equal(profile.reasoningDepth, 'deep');
    assert.equal(profile.presentation.showWorkedExample, true);
    assert.equal(controller.mode, 'normal-chat');
    assert.equal(profile.suggestedTransition, null);
  });
  await t.test('business comparison can offer a table without opening Code', () => {
    const profile = normalChatTaskProfile({
      goal: 'Compare business plan pricing alternatives and cash flow'
    });
    assert.equal(profile.domain, 'business-planning');
    assert.equal(profile.presentation.showTableWhenUseful, true);
    assert.equal(profile.workspace, 'normal-chat');
  });
  await t.test('multiple attachments choose a file-workflow but do not grant tools', () => {
    const profile = normalChatTaskProfile({
      goal: 'Edit and compare these documents', attachments: [
        { name: 'policy.pdf' }, { name: 'budget.xlsx' }
      ]
    });
    const state = run('normal-chat', task('respond'), {
      adaptation: { attachments: [{ name: 'policy.pdf' }, { name: 'budget.xlsx' }] }
    });
    const focus = liveWorkFocus(state);
    assert.equal(profile.presentation.mode, 'file-workflow');
    assert.equal(profile.serverAuthorityRequired, true);
    assert.equal(profile.toolPolicy, 'just-in-time-authorized-only');
    assert.equal(focus.surface, 'files');
    assert.ok(focus.showDetails);
  });
  await t.test('visual requests enable visuals only when useful; safe linear diagrams render', () => {
    const profile = normalChatTaskProfile({ goal: 'Draw a diagram of a learning process' });
    assert.equal(profile.presentation.showVisualWhenUseful, true);
    assert.deepEqual(parseFlowDiagram('Choose topic -> Learn -> Practice -> Check'), [
      'Choose topic', 'Learn', 'Practice', 'Check'
    ]);
    assert.equal(parseFlowDiagram('flowchart LR\nA --> B'), null);
  });
  await t.test('high-stakes NormalChat retains verification and serialized execution', () => {
    const profile = normalChatTaskProfile({ goal: 'Advise on this situation', risk: 'critical' });
    const compute = workspaceComputePolicy({
      surface: 'normal-chat', risk: 'critical', complexity: 1, independentWork: 1
    });
    assert.equal(profile.verification, 'check-observable-claims-and-artifacts');
    assert.equal(compute.maxParallel, 1);
  });
});

test('Code: project context, revision safety, sandbox visibility and terminal boundaries', async t => {
  await t.test('changed minified source is never dropped despite tiny context', () => {
    const files = [
      { path: 'src/other.js', content: 'export const old = 1;\n' + 'x'.repeat(6000) },
      { path: 'src/critical.js', content: 'export const critical = 2;\n' + 'y'.repeat(6000) }
    ];
    const pack = compileCodeContext({
      files, index: buildProjectIndex(files), changedPaths: ['src/critical.js'],
      goal: 'Fix critical code', task: { id: 'build-code', type: 'code' },
      maxChars: 4000, maxFiles: 2
    });
    const critical = pack.files.find(file => file.path === 'src/critical.js');
    assert.ok(critical, 'critical edit must be present');
    assert.match(critical.content, /critical = 2/);
    assert.ok(pack.budget.usedChars <= pack.budget.maxChars);
    assert.ok(pack.files.length <= 2);
  });
  await t.test('incremental graph enforces authorized capabilities, dependencies and revisions', () => {
    let graph = appendOpenWorldWork({}, { id: 'inspect' });
    assert.throws(() => appendOpenWorldWork(graph, {
      id: 'edit', requires: ['code-write'], dependsOn: ['inspect']
    }), /unauthorized/);
    graph = appendOpenWorldWork(graph, {
      id: 'edit', requires: ['code-write'], dependsOn: ['inspect']
    }, { authorizedCapabilities: ['code-write'], expectedRevision: graph.revision });
    graph = appendOpenWorldWork(graph, { id: 'verify', dependsOn: ['edit'] });
    assert.deepEqual(openWorldFrontier(graph).ready, ['inspect']);
    graph = recordOpenWorldOutcome(graph, 'inspect');
    assert.deepEqual(openWorldFrontier(graph).ready, ['edit']);
    graph = recordOpenWorldOutcome(graph, 'edit');
    graph = recordOpenWorldOutcome(graph, 'verify');
    graph = recordOpenWorldOutcome(graph, 'edit', { changed: true });
    assert.equal(graph.nodes.find(node => node.id === 'verify').status, 'stale');
    assert.equal(graph.nodes.find(node => node.id === 'inspect').status, 'complete');
  });
  await t.test('sandbox is an execution target, not a fabricated result or command', () => {
    const state = run('code', task('tool', 'pending', {
      executionTarget: 'general-ai-sandbox'
    }), { state: 'queued' });
    const focus = liveWorkFocus(state, { workspace: 'code' });
    assert.equal(focus.status, 'Up next');
    assert.equal(focus.surface, 'sandbox');
    assert.ok(focus.activity.some(item => item.label === 'Selected execution target'));
    assert.ok(!focus.activity.some(item => /passed|finished/i.test(item.label)));
  });
  await t.test('terminal affordance requires explicit task need, Code mode and editor rights', () => {
    const current = task('code');
    current.purpose = 'Debug runtime failure in the terminal';
    const state = run('code', current);
    const allowed = { workspace: 'code', connectedGitHub: true, canOpenTerminal: true };
    assert.equal(liveWorkFocus(state, allowed).allowTerminal, true);
    assert.equal(liveWorkFocus(state, { ...allowed, canOpenTerminal: false }).allowTerminal, false);
    assert.equal(liveWorkFocus(state, { ...allowed, offline: true }).allowTerminal, false);
    assert.equal(liveWorkFocus(state, { ...allowed, workspace: 'normal-chat' }).allowTerminal, false);
    current.purpose = 'Explain this code in normal language';
    assert.equal(liveWorkFocus(state, allowed).allowTerminal, false);
  });
  await t.test('high-risk Code work serializes even when branches can be parallel', () => {
    const parallel = workspaceComputePolicy({
      surface: 'code', complexity: .9, independentWork: .9
    });
    const risk = workspaceComputePolicy({
      surface: 'code', complexity: .9, independentWork: .9, risk: 'high-impact'
    });
    assert.ok(parallel.maxParallel > 1);
    assert.equal(risk.maxParallel, 1);
    assert.equal(risk.qualityFloor, 'verified-before-completion');
  });
  await t.test('reassessed code changes require observed work and an unfinished requirement', () => {
    const sourceTask = { type: 'reassess' };
    const proposal = { type: 'code' };
    const record = { id: 'test-code', type: 'code', status: 'failed', evidence: {
      result: { exitCode: 1, stderr: 'test failed' }
    } };
    assert.equal(evidenceNextTaskGate({
      sourceTask, tasks: [record], proposal, requirements: requirements('partially-satisfied')
    }).allowed, true);
    assert.equal(evidenceNextTaskGate({
      sourceTask, tasks: [record], proposal, requirements: requirements('satisfied')
    }).allowed, false);
    assert.equal(evidenceNextTaskGate({
      sourceTask, tasks: [], proposal, requirements: requirements('partially-satisfied')
    }).allowed, false);
  });
});

test('Research: bounded, attributable evidence and adaptive next actions', async t => {
  await t.test('research uses a different context and verification policy', () => {
    const chat = workspaceComputePolicy({ surface: 'normal-chat' });
    const research = workspaceComputePolicy({ surface: 'research', complexity: .8, independentWork: .8 });
    assert.equal(research.workspace, 'research');
    assert.notEqual(research.contextBudget, chat.contextBudget);
    assert.match(research.verificationBudget, /provenance/);
    assert.ok(research.maxParallel > 1);
  });
  await t.test('sources deduplicate by canonical URL without pretending they were fetched', () => {
    const sources = normalizeResearchSources([
      { url: 'https://example.com/paper#abstract', title: 'Primary paper' },
      { url: 'https://example.com/paper', title: 'Repeated citation' },
      { title: 'Unlinked report', provider: 'Archive' }
    ]);
    assert.equal(sources.length, 2);
    assert.equal(sources[0].url, 'https://example.com/paper');
  });
  await t.test('evidence gaps keep investigation open and save source context', () => {
    const research = createResearchWorkspaceState({
      goal: 'Study battery recycling',
      evidence: {
        findings: [{ id: 'claim-1', summary: 'Material recovered.' }],
        sources: [{ url: 'https://example.com/study', title: 'Source' }],
        evidenceGaps: ['Regional cost study is missing']
      }
    });
    assert.equal(research.sourceCount, 1);
    assert.equal(research.evidenceCount, 1);
    assert.equal(research.status, 'needs-evidence');
    assert.equal(research.unresolvedQuestions.length, 1);
  });
  await t.test('contradictory findings trigger resolution rather than false completeness', () => {
    const research = createResearchWorkspaceState({
      goal: 'Review policy findings',
      evidence: {
        findings: [{ id: 'claim-1', summary: 'An outcome is uncertain' }],
        sources: [{ url: 'https://example.com/claim', title: 'Evidence' }],
        conflicts: ['Sources disagree']
      }
    });
    assert.equal(research.status, 'needs-resolution');
    assert.equal(research.conflicts.length, 1);
  });
  await t.test('a follow-up retains source history without mixing separate conversations', () => {
    const first = createResearchWorkspaceState({
      goal: 'Initial research', conversationId: 'research-conversation', runId: 'run-a',
      evidence: { sources: [{ url: 'https://example.com/one', title: 'Source one' }] }
    });
    const next = createResearchWorkspaceState({
      goal: 'Continue this analysis', conversationId: 'research-conversation',
      runId: 'run-b', prior: first,
      evidence: { sources: [{ url: 'https://example.com/two', title: 'Source two' }] }
    });
    assert.equal(next.id, first.id);
    assert.equal(next.sourceCount, 2);
    assert.equal(next.lineage.mode, 'continued');
  });
  await t.test('research UI displays recorded sources and no fabricated live tool', () => {
    const state = run('research', task('investigate', 'running'), {
      adaptation: { researchWorkspace: { sourceCount: 2, evidenceCount: 1 } }
    });
    const focus = liveWorkFocus(state, { workspace: 'research' });
    const panel = workspaceProgressPanel(state, 'research');
    assert.equal(focus.surface, 'research');
    assert.ok(!focus.line.includes('file.read'));
    assert.ok(panel.cards.some(item => item.label === 'Sources recorded' && item.value === '2'));
  });
  await t.test('new research steps require evidence and a real unmet requirement', () => {
    const sourceTask = { type: 'reassess' };
    const proposal = { type: 'investigate' };
    const tasks = [{ id: 'retrieve', type: 'investigate', status: 'complete',
      evidence: { sources: [{ url: 'https://example.com' }] } }];
    assert.equal(evidenceNextTaskGate({
      sourceTask, tasks, proposal, requirements: requirements('partially-satisfied')
    }).allowed, true);
    assert.equal(evidenceNextTaskGate({
      sourceTask, tasks, proposal, requirements: requirements('satisfied')
    }).allowed, false);
    assert.equal(evidenceNextTaskGate({
      sourceTask, tasks, proposal, requirements: requirements('partially-satisfied'),
      budgetAllows: false
    }).allowed, false);
  });
});

test('Shared invariants: all modes avoid unsupported extra work and keep verification gates', async t => {
  for (const surface of ['normal-chat', 'code', 'research']) {
    await t.test(surface + ': no further work from model confidence alone', () => {
      const sourceTask = { type: 'reassess' };
      const proposal = { type: 'investigate' };
      const unsupported = { type: 'investigate', status: 'complete',
        evidence: { confidence: 0.99, thoughts: 'more work would help' } };
      assert.equal(evidenceNextTaskGate({
        sourceTask, tasks: [unsupported], proposal,
        requirements: requirements('partially-satisfied')
      }).allowed, false);
      assert.equal(evidenceNextTaskGate({
        sourceTask, tasks: [unsupported], proposal: { type: 'verify' },
        requirements: requirements('partially-satisfied')
      }).allowed, true);
      const conserved = workspaceComputePolicy({
        surface, complexity: 1, independentWork: 1,
        remainingBudgetRatio: .05, verificationRequired: true
      });
      assert.equal(conserved.maxParallel, 1);
      assert.equal(conserved.recommendedAgents, 1);
      assert.equal(conserved.qualityFloor, 'verified-before-completion');
    });
  }
});
