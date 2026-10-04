import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESEARCH_WORKSPACE_VERSION,
  createResearchWorkspaceState,
  normalizeResearchSources,
  researchQuestionFingerprint
} from '../src/research-workspace.js';

test('research sources normalize to stable provenance keys', () => {
  const sources = normalizeResearchSources([
    { url: 'https://example.com/article#section', title: 'Article', provider: 'Example' },
    { url: 'https://example.com/article', title: 'Duplicate' },
    { title: 'Paper', provider: 'Journal' }
  ]);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].url, 'https://example.com/article');
  assert.match(sources[1].key, /^meta:/);
});

test('research question fingerprints are deterministic', () => {
  assert.equal(
    researchQuestionFingerprint('  Latest   evidence on AI  '),
    researchQuestionFingerprint('latest evidence on ai')
  );
});

test('research workspace continues with bounded sources and evidence', () => {
  const first = createResearchWorkspaceState({
    goal: 'Research battery recycling',
    conversationId: 'chat-12345678',
    runId: 'run-1',
    evidence: {
      findings: [{ id: 'claim-1', summary: 'Recycling reduces material demand.' }],
      sources: [{ url: 'https://example.com/recycling', title: 'Recycling source' }],
      evidenceGaps: ['Regional cost data']
    }
  });
  const second = createResearchWorkspaceState({
    goal: 'Now compare costs for the same topic',
    question: 'Battery recycling cost comparison',
    conversationId: 'chat-12345678',
    runId: 'run-2',
    prior: first,
    evidence: {
      findings: [{ id: 'claim-2', summary: 'Costs vary by process.' }],
      sources: [{ url: 'https://example.org/costs', title: 'Cost source' }]
    }
  });
  assert.equal(second.version, RESEARCH_WORKSPACE_VERSION);
  assert.equal(second.id, first.id);
  assert.equal(second.lineage.mode, 'continued');
  assert.equal(second.sourceCount, 2);
  assert.equal(second.evidenceCount, 2);
  assert.equal(second.currentTurnSourceKeys.length, 1);
});

test('research workspace stays bounded under repeated evidence', () => {
  const evidence = {
    findings: Array.from({ length: 120 }, (_, index) => ({ id: 'claim-' + index, summary: 'Finding ' + index })),
    sources: Array.from({ length: 90 }, (_, index) => ({ url: 'https://example.com/' + index, title: 'Source ' + index }))
  };
  const state = createResearchWorkspaceState({ goal: 'Bounded research', evidence });
  assert.equal(state.sourceCount, 40);
  assert.equal(state.evidenceCount, 80);
});
