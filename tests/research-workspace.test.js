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

test('canonical sourceKeys support claim citations', () => {
  const url = 'https://example.com/paper';
  const state = createResearchWorkspaceState({ evidence: {
    sources: [{ url }], findings: [{ summary: 'A keyed finding', sourceKeys: ['url:' + url] }]
  } });
  assert.deepEqual(state.evidenceLedger[0].sourceKeys, ['url:' + url]);
  assert.equal(state.status, 'evidence-backed');
});

test('an unrelated source does not make uncited findings evidence-backed', () => {
  const state = createResearchWorkspaceState({ evidence: {
    sources: [{ url: 'https://example.com/paper' }], findings: ['An uncited assertion']
  } });
  assert.equal(state.status, 'needs-evidence');
  assert.equal(state.coverage.uncitedEvidenceCount, 1);
});

test('new uncited sources cannot evict metadata supporting retained findings', () => {
  const url = 'https://example.com/original';
  const first = createResearchWorkspaceState({ evidence: {
    sources: [{ url, title: 'Original paper', provider: 'Journal' }],
    findings: [{ summary: 'Original claim', sources: [{ url }] }]
  } });
  const next = createResearchWorkspaceState({ prior: first, evidence: {
    sources: Array.from({ length: 40 }, (_, i) => ({ url: 'https://example.com/new/' + i }))
  } });
  assert.equal(next.sourceCount, 40);
  assert.equal(next.sourceSet.find(source => source.url === url)?.title, 'Original paper');
  for (const finding of next.evidenceLedger) {
    assert.ok(finding.sourceKeys.every(key => next.sourceSet.some(source => source.key === key)));
  }
});

test('source overflow reports incomplete provenance and can recover when a source returns', () => {
  const prior = createResearchWorkspaceState({ evidence: {
    sources: Array.from({ length: 40 }, (_, i) => ({ url: 'https://example.com/' + i })),
    findings: Array.from({ length: 40 }, (_, i) => ({ summary: 'Claim ' + i, sources: [{ url: 'https://example.com/' + i }] }))
  } });
  const next = createResearchWorkspaceState({ prior, evidence: {
    sources: [{ url: 'https://example.com/new' }],
    findings: [{ summary: 'New claim', sources: [{ url: 'https://example.com/new' }] }]
  } });
  assert.equal(next.sourceCount, 40);
  assert.equal(next.status, 'needs-evidence');
  assert.equal(next.coverage.incompleteProvenanceCount, 1);
  const incomplete = next.evidenceLedger.find(item => item.missingSourceKeys?.length);
  assert.ok(incomplete);
  assert.equal(incomplete.sourceKeys.length, 0);
  const recovered = createResearchWorkspaceState({ prior: next, evidence: {
    sources: [{ url: incomplete.missingSourceKeys[0].slice(4) }],
    findings: [{ summary: 'New claim', sources: [{ url: 'https://example.com/39' }] }]
  } });
  assert.equal(recovered.status, 'evidence-backed');
  assert.ok(recovered.evidenceLedger.every(item => item.sourceKeys.length > 0));
});

test('unknown claim source keys are reported instead of accepted as provenance', () => {
  const state = createResearchWorkspaceState({ evidence: {
    sources: [{ url: 'https://example.com/known' }],
    findings: [{ summary: 'Unsupported claim', sourceKeys: ['url:https://example.com/absent'] }]
  } });
  assert.equal(state.status, 'needs-evidence');
  assert.equal(state.coverage.incompleteProvenanceCount, 1);
  assert.deepEqual(state.evidenceLedger[0].sourceKeys, []);
});

test('cited incoming sources are selected before the source collection cap', () => {
  const state = createResearchWorkspaceState({ evidence: {
    sources: Array.from({ length: 41 }, (_, i) => ({ url: 'https://example.com/' + i })),
    findings: [{ summary: 'Cited last source', sourceKeys: ['url:https://example.com/40'] }]
  } });
  assert.equal(state.sourceCount, 40);
  assert.ok(state.sourceSet.some(source => source.url === 'https://example.com/40'));
  assert.equal(state.status, 'evidence-backed');
});

test('citation overflow cannot establish complete provenance', () => {
  const sources = Array.from({ length: 12 }, (_, i) => ({ url: 'https://example.com/' + i }));
  const state = createResearchWorkspaceState({ evidence: {
    sources, findings: [{ summary: 'Many citations', sourceKeys: [
      ...sources.map(source => 'url:' + source.url), 'url:https://example.com/absent'
    ] }]
  } });
  assert.equal(state.status, 'needs-evidence');
  assert.equal(state.evidenceLedger[0].sourceKeys.length, 12);
  assert.equal(state.evidenceLedger[0].sourceReferenceOverflow, true);
  assert.equal(state.coverage.incompleteProvenanceCount, 1);
  assert.equal(createResearchWorkspaceState({ prior: state }).status, 'needs-evidence');
});
