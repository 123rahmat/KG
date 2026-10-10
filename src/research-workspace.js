/**
 * Research Workspace continuity and evidence ledger.
 *
 * Research is an evidence-first operating envelope of the same adaptive core.
 * The workspace stores bounded provenance and research continuity, never hidden
 * model reasoning or unbounded source payloads.
 */
import crypto from 'node:crypto';

export const RESEARCH_WORKSPACE_VERSION = 1;
export const RESEARCH_WORKSPACE_LIMITS = Object.freeze({
  maxSources: 40,
  maxEvidence: 80,
  maxQuestions: 30,
  maxConflicts: 20,
  maxHistory: 20,
  maxText: 1200
});

const text = value => String(value ?? '').trim();

function clip(value, max = RESEARCH_WORKSPACE_LIMITS.maxText) {
  const raw = text(value);
  return raw.length > max ? raw.slice(0, max) + '…' : raw;
}

function normalizeQuestion(value) {
  return text(value).replace(/\s+/g, ' ').toLowerCase();
}

export function researchQuestionFingerprint(question = '', goal = '') {
  const basis = normalizeQuestion(question) || normalizeQuestion(goal);
  if (!basis) return null;
  return crypto.createHash('sha256').update(basis, 'utf8').digest('hex').slice(0, 24);
}

function normalizeUrl(value) {
  const raw = text(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.toString();
  } catch {
    return raw.slice(0, 2000);
  }
}

function sourceKey(source, index = 0) {
  // Persisted ledgers already contain canonical keys. Recomputing a key from
  // partial URL/title metadata can orphan citations in later project turns.
  const persisted = text(source?.key);
  if (/^(?:url|meta|doi|id):\\S{1,1996}$/.test(persisted)) return persisted;
  const url = normalizeUrl(source?.url ?? source?.href ?? (typeof source === 'string' ? source : ''));
  if (url) return `url:${url}`;
  const title = clip(source?.title ?? source?.name ?? (typeof source === 'string' ? source : ''), 500);
  const provider = clip(source?.provider ?? source?.publisher ?? source?.domain ?? '', 120);
  return title || provider
    ? `meta:${provider.toLowerCase()}:${title.toLowerCase()}`
    : `unknown:${index}`;
}

export function normalizeResearchSource(source, index = 0) {
  if (typeof source === 'string') {
    const url = normalizeUrl(source);
    return {
      key: sourceKey(source, index),
      url: url || null,
      title: null,
      provider: null,
      publishedAt: null,
      accessedAt: null
    };
  }
  if (!source || typeof source !== 'object') return null;
  const url = normalizeUrl(source.url ?? source.href);
  const title = clip(source.title ?? source.name, 500);
  const provider = clip(source.provider ?? source.publisher ?? source.domain, 120);
  const key = sourceKey(source, index);
  if (!key || key.startsWith('unknown:')) return null;
  return {
    key,
    url: url || null,
    title: title || null,
    provider: provider || null,
    publishedAt: clip(source.publishedAt ?? source.published_at, 80) || null,
    accessedAt: clip(source.accessedAt ?? source.accessed_at ?? source.retrievedAt ?? source.retrieved_at, 80) || null
  };
}

export function normalizeResearchSources(input = [], { limit = RESEARCH_WORKSPACE_LIMITS.maxSources } = {}) {
  const source = Array.isArray(input) ? input : [];
  const out = [];
  const seen = new Set();
  for (const [index, item] of source.entries()) {
    const normalized = normalizeResearchSource(item, index);
    if (!normalized || seen.has(normalized.key)) continue;
    seen.add(normalized.key);
    out.push(normalized);
  }
  return out.slice(0, Number.isFinite(limit) ? Math.max(0, limit) : RESEARCH_WORKSPACE_LIMITS.maxSources);
}

function sourceInputs(evidence, citations, toolLog) {
  const all = [
    ...(Array.isArray(citations) ? citations : []),
    ...(Array.isArray(evidence?.sources) ? evidence.sources : []),
    ...(Array.isArray(evidence?.citations) ? evidence.citations : []),
    ...(Array.isArray(toolLog) ? toolLog.flatMap(item => [
      ...(Array.isArray(item?.sources) ? item.sources : []),
      ...(Array.isArray(item?.citations) ? item.citations : [])
    ]) : [])
  ];
  // The authoritative input may contain more than the model-context preview.
  // Bound this per turn independently from the 40-source presentation limit.
  return normalizeResearchSources(all, { limit: 2000 });
}

function normalizeEvidenceItem(item, sourcesByKey) {
  if (typeof item === 'string') {
    const summary = clip(item);
    return summary ? { id: null, summary, sourceKeys: [] } : null;
  }
  if (!item || typeof item !== 'object') return null;
  const summary = clip(item.summary ?? item.finding ?? item.text ?? item.claim);
  if (!summary) return null;
  const rawSources = Array.isArray(item.sources) ? item.sources : [];
  // Saved ledger references are ALREADY keys (url:/meta:), not URLs to
  // normalize a second time. Keep only references present in this source set.
  const directKeys = Array.isArray(item.sourceKeys) ? item.sourceKeys
    .filter(key => typeof key==='string' && sourcesByKey.has(key)) : [];
  const fromSources = normalizeResearchSources(rawSources)
    .map(source => source.key).filter(key => sourcesByKey.has(key));
  const sourceKeys = [...new Set([...directKeys,...fromSources])].slice(0,12);
  const id = text(item.id) || null;
  return { id, summary, sourceKeys };
}

function normalizeEvidence(evidence, sources) {
  const sourcesByKey = new Map(sources.map(source => [source.key, source]));
  const candidates = [
    ...(Array.isArray(evidence?.findings) ? evidence.findings : []),
    ...(Array.isArray(evidence?.claims) ? evidence.claims : []),
    ...(text(evidence?.findings) ? [evidence.findings] : [])
  ];
  const out = [];
  const seen = new Set();
  for (const item of candidates) {
    const normalized = normalizeEvidenceItem(item, sourcesByKey);
    if (!normalized) continue;
    const key = normalized.id ? `id:${normalized.id}` : `summary:${normalized.summary.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out.slice(0, RESEARCH_WORKSPACE_LIMITS.maxEvidence);
}

function stringList(...values) {
  const out = [];
  const seen = new Set();
  for (const value of values.flatMap(item => Array.isArray(item) ? item : [item])) {
    const normalized = clip(value, 600);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function priorState(value) {
  return value && typeof value === 'object' && Number(value.version) === RESEARCH_WORKSPACE_VERSION
    ? value
    : null;
}

export function createResearchWorkspaceState({
  goal = '',
  question = '',
  prior = null,
  runId = null,
  conversationId = null,
  evidence = null,
  citations = [],
  toolLog = []
} = {}) {
  const previous = priorState(prior);
  const activeQuestion = clip(question || goal, 600) || 'Research question not yet defined';
  const fingerprint = researchQuestionFingerprint(activeQuestion, goal);
  const currentSources = sourceInputs(evidence, citations, toolLog);
  const previousSources = normalizeResearchSources(previous?.sourceSet ?? []);
  // Preserve metadata of sources cited by continuing claims before filling
  // the bounded model preview with unreferenced new discoveries.
  const sourceMap = new Map();
  for (const source of [...currentSources, ...previousSources]) {
    if (!sourceMap.has(source.key)) sourceMap.set(source.key, source);
  }
  const previousEvidence = Array.isArray(previous?.evidenceLedger) ? previous.evidenceLedger : [];
  const newItems = [
    ...(Array.isArray(evidence?.findings) ? evidence.findings : []),
    ...(Array.isArray(evidence?.claims) ? evidence.claims : [])
  ];
  const requestedRefs = [...newItems, ...previousEvidence].flatMap(item => [
    ...(Array.isArray(item?.sourceKeys) ? item.sourceKeys.filter(key => typeof key === 'string') : []),
    ...normalizeResearchSources(item?.sources, { limit: 100 }).map(source => source.key)
  ]);
  const selectedKeys = [...new Set([
    ...requestedRefs,
    ...currentSources.map(source => source.key),
    ...previousSources.map(source => source.key)
  ])].filter(key => sourceMap.has(key)).slice(0, RESEARCH_WORKSPACE_LIMITS.maxSources);
  const sourceSet = selectedKeys.map(key => sourceMap.get(key));
  const selectedSourceKeys = new Set(selectedKeys);
  const sourceKeys = new Set(currentSources.map(source => source.key));
  const currentEvidence = normalizeEvidence(evidence, sourceSet);
  const evidenceMap = new Map();
  for (const item of [...currentEvidence, ...previousEvidence]) {
    const key = item?.id ? `id:${item.id}` : `summary:${text(item?.summary).toLowerCase()}`;
    if (key==='summary:') continue;
    const older=evidenceMap.get(key);
    if (!older) evidenceMap.set(key,item);
    else evidenceMap.set(key,{
      ...older,
      // A newer finding wins, but older, actually recorded source links
      // remain traceable when a duplicate arrives without citations.
      sourceKeys:[...new Set([...(older.sourceKeys??[]),...(item.sourceKeys??[])])]
        .filter(sourceKey => sourceMap.has(sourceKey)).slice(0,12)
    });
  }
  // The bounded preview must not report dangling links as evidence. The
  // durable source store planned for ResearchEngine will hold all records;
  // until then, visibly mark references that cannot fit in this projection.
  const droppedReferences = new Set(requestedRefs.filter(key => !selectedSourceKeys.has(key)));
  const evidenceLedger = [...evidenceMap.values()]
    .slice(0, RESEARCH_WORKSPACE_LIMITS.maxEvidence)
    .map(item => {
      const sourceKeys = [...new Set(item.sourceKeys ?? [])].filter(key => {
        if (selectedSourceKeys.has(key)) return true;
        droppedReferences.add(key);
        return false;
      });
      return { ...item, sourceKeys };
    });
  const linkedClaims = evidenceLedger.filter(item => item.sourceKeys.length > 0).length;
  const unlinkedClaims = evidenceLedger.length - linkedClaims;
  // Carry forward still-open questions, but allow new observed evidence to
  // close an old gap. Without explicit resolution, the evidence ledger can
  // remain stuck in "needs-evidence" forever after that gap is addressed.
  // Model prose alone never silently removes an unknown; a structured
  // resolution signal must be recorded in this run's evidence.
  const resolvedQuestions = new Set(stringList(
    evidence?.resolvedQuestions, evidence?.resolvedEvidenceGaps
  ).map(normalizeQuestion));
  const resolvedConflicts = new Set(stringList(
    evidence?.resolvedConflicts
  ).map(normalizeQuestion));
  const gaps = stringList(
    evidence?.evidenceGaps,
    evidence?.unresolvedQuestions,
    evidence?.openQuestions,
    previous?.unresolvedQuestions,
    ...(droppedReferences.size ? [`${droppedReferences.size} source reference(s) are outside the bounded evidence view; recheck provenance`] : [])
  ).filter(item => !resolvedQuestions.has(normalizeQuestion(item)));
  const conflicts = stringList(evidence?.conflicts, previous?.conflicts)
    .filter(item => !resolvedConflicts.has(normalizeQuestion(item)));
  const historyEntry = {
    runId: text(runId) || null,
    question: activeQuestion,
    questionFingerprint: fingerprint,
    sourceCount: currentSources.length,
    evidenceCount: currentEvidence.length
  };
  const history = [
    ...(Array.isArray(previous?.history) ? previous.history : []),
    historyEntry
  ].slice(-RESEARCH_WORKSPACE_LIMITS.maxHistory);
  const workspaceId = previous?.id
    || crypto.createHash('sha256')
      .update(text(conversationId)).update('\0')
      .update(activeQuestion).digest('hex').slice(0, 24);
  const status = conflicts.length
    ? 'needs-resolution'
    : gaps.length || sourceSet.length === 0 || unlinkedClaims > 0
      ? 'needs-evidence'
      : evidenceLedger.length
        ? 'evidence-backed'
        : 'collecting';

  return Object.freeze({
    version: RESEARCH_WORKSPACE_VERSION,
    id: workspaceId,
    conversationId: text(conversationId) || previous?.conversationId || null,
    rootQuestion: previous?.rootQuestion || activeQuestion,
    rootQuestionFingerprint: previous?.rootQuestionFingerprint || fingerprint,
    activeQuestion,
    activeQuestionFingerprint: fingerprint,
    lineage: previous
      ? { mode: 'continued', parentId: previous.id }
      : { mode: 'new', parentId: null },
    sourceSet,
    sourceCount: sourceSet.length,
    currentTurnSourceKeys: [...sourceKeys].filter(key => selectedSourceKeys.has(key)).slice(0, RESEARCH_WORKSPACE_LIMITS.maxSources),
    evidenceLedger,
    evidenceCount: evidenceLedger.length,
    unresolvedQuestions: gaps.slice(0, RESEARCH_WORKSPACE_LIMITS.maxQuestions),
    conflicts: conflicts.slice(0, RESEARCH_WORKSPACE_LIMITS.maxConflicts),
    coverage: {
      currentTurnSources: currentSources.length,
      currentTurnEvidence: currentEvidence.length,
      provenancePresent: currentSources.length > 0,
      linkedClaims,
      unlinkedClaims,
      droppedSourceReferences: droppedReferences.size,
      // A link is not a verified passage or an experimental receipt.
      verifiedClaims: 0,
      hasEvidence: evidenceLedger.length > 0
    },
    status,
    history,
    lastRunId: text(runId) || previous?.lastRunId || null,
    updatedAt: new Date().toISOString()
  });
}

export function updateResearchWorkspaceState(previous, options = {}) {
  return createResearchWorkspaceState({ ...options, prior: previous });
}
