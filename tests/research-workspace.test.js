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

test('explicitly resolved questions and conflicts do not remain open forever', () => {
  const prior = createResearchWorkspaceState({
    goal: 'Evaluate a study', evidence: {
      sources: [{ url: 'https://example.org/study' }],
      findings: ['Initial hypothesis'],
      evidenceGaps: ['Check sample size'],
      conflicts: ['Inconsistent methods']
    }
  });
  assert.equal(prior.status, 'needs-resolution');
  const next = createResearchWorkspaceState({
    goal: 'Evaluate a study', prior,
    evidence: {
      findings: ['The sample size and method conflict were checked'],
      resolvedQuestions: [' check sample size '],
      resolvedConflicts: ['inconsistent METHODS']
    }
  });
  assert.deepEqual(next.unresolvedQuestions, []);
  assert.deepEqual(next.conflicts, []);
  assert.equal(next.status, 'needs-evidence', 'unlinked claims cannot be marked evidence-backed merely because some sources exist');
  assert.equal(next.sourceCount, 1);
});
test('unsubstantiated disappearance of a gap does not count as resolution', () => {
  const first = createResearchWorkspaceState({ goal: 'Long research', evidence: { evidenceGaps: ['Find a source'] } });
  const next = createResearchWorkspaceState({ goal: 'Long research', prior: first, evidence: {} });
  assert.deepEqual(next.unresolvedQuestions, ['Find a source']);
  assert.equal(next.status, 'needs-evidence');
});

test('saved research source keys remain valid when repeated evidence arrives',()=>{
  const first=createResearchWorkspaceState({
    goal:'Study battery aging',evidence:{
      sources:[{url:'https://journal.example/study#results',title:'Source'}],
      findings:[{id:'claim-a',summary:'The outcome depends on temperature',
        sources:[{url:'https://journal.example/study'}]}]
    }
  });
  assert.equal(first.evidenceLedger[0].sourceKeys.length,1);
  const key=first.evidenceLedger[0].sourceKeys[0];
  const next=createResearchWorkspaceState({goal:'Study battery aging',prior:first,
    evidence:{findings:[{id:'claim-a',summary:'Revised observation after checking',
      sourceKeys:[key]}]}});
  assert.equal(next.evidenceCount,1);
  assert.equal(next.evidenceLedger[0].summary,'Revised observation after checking');
  assert.deepEqual(next.evidenceLedger[0].sourceKeys,[key]);
  const noRefs=createResearchWorkspaceState({goal:'Study battery aging',prior:next,
    evidence:{findings:[{id:'claim-a',summary:'Latest statement without new references'}]}});
  assert.deepEqual(noRefs.evidenceLedger[0].sourceKeys,[key],
    'deduplicating the newer claim does not silently erase recorded provenance');
  assert.equal(noRefs.coverage.currentTurnSources,0);
});

test('canonical source keys survive stored metadata normalization', () => {
  const key = 'url:https://example.org/study';
  const state = createResearchWorkspaceState({
    goal: 'Compare papers',
    evidence: { sources: [{ key, url: 'https://example.org/study', title: 'Paper' }],
      claims: [{ id: 'claim', summary: 'Hypothesis only', sourceKeys: [key] }] }
  });
  assert.deepEqual(state.evidenceLedger[0].sourceKeys, [key]);
  assert.equal(state.coverage.linkedClaims, 1);
  assert.equal(state.coverage.verifiedClaims, 0, 'a URL is not a verified inspected passage');
});

test('40 new sources do not orphan an older cited source', () => {
  const key = 'url:https://example.org/older';
  const first = createResearchWorkspaceState({
    goal: 'Long literature review',
    evidence: {
      sources: [{ url: 'https://example.org/older', title: 'Original inspected source' }],
      claims: [{ id: 'claim-original', summary: 'Earlier claim', sourceKeys: [key] }]
    }
  });
  const next = createResearchWorkspaceState({
    prior: first, goal: 'Extend literature review',
    evidence: { sources: Array.from({ length: 40 }, (_, i) =>
      ({ url: `https://example.org/new-${i}`, title: `New source ${i}` })) }
  });
  assert.equal(next.sourceCount, 40);
  assert.ok(next.sourceSet.some(source => source.key === key));
  assert.deepEqual(next.evidenceLedger[0].sourceKeys, [key]);
  assert.ok(next.evidenceLedger.every(claim => claim.sourceKeys.every(ref =>
    next.sourceSet.some(source => source.key === ref))));
  assert.equal(next.coverage.unlinkedClaims, 0);
});

test('missing or evicted citation keys are explicit gaps, never verified evidence', () => {
  const state = createResearchWorkspaceState({
    goal: 'Check trial evidence',
    evidence: {
      sources: [{ url: 'https://example.org/unrelated' }],
      claims: [{ id: 'c1', summary: 'Unsupported claim',
        sourceKeys: ['url:https://example.org/missing'] }]
    }
  });
  assert.deepEqual(state.evidenceLedger[0].sourceKeys, []);
  assert.equal(state.coverage.unlinkedClaims, 1);
  assert.equal(state.coverage.droppedSourceReferences, 1);
  assert.equal(state.status, 'needs-evidence');
  assert.ok(state.unresolvedQuestions.some(gap => gap.includes('source reference')));
});
