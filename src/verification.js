/**
 * Grounded verification: what the verifier is given beyond the model's own
 * reading of the evidence, and the checks it cannot talk its way past.
 *
 * - The sources the work rests on, so claims are judged against them.
 * - Links an answer shows that no step retrieved, so invented sources are
 *   checked instead of trusted.
 * - Whether the verifier searches the live web itself to check the key
 *   facts (situation-aware: only when the work depends on outside facts and
 *   policy and governance permit research).
 * - Claims the verifier found unsupported or contradicted always fail the
 *   check, whatever verdict it wrote.
 */

import { clip } from './reasoning-context.js';

const MAX_SOURCES = 30;
const MAX_LINKS = 15;
const MAX_CLAIMS = 20;
// Tools that fetch outside facts; their use makes the work depend on them.
const WEB_TOOLS = new Set(['web.search', 'web.fetch', 'web.download']);
const URL_PATTERN = /\bhttps?:\/\/[^\s<>()[\]{}"'`]+/gi;

const normalizeUrl = value => {
  try {
    const url = new URL(String(value).replace(/[.,;:!?]+$/, ''));
    url.hash = '';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}`.toLowerCase();
  } catch {
    return null;
  }
};

/** Every source recorded on completed steps, deduplicated by URL. */
export function evidenceSources(tasks = []) {
  const found = new Map();
  const add = (item, taskId) => {
    const key = normalizeUrl(item?.url);
    if (!key || found.has(key)) return;
    found.set(key, { url: clip(String(item.url), 500), title: clip(String(item.title ?? ''), 200), taskId });
  };
  for (const task of tasks) {
    if (task.status !== 'complete' || !task.evidence) continue;
    // Pages and files the step's tools read are recorded as its citations.
    for (const item of task.evidence.citations ?? []) add(item, task.id);
  }
  return [...found.values()].slice(0, MAX_SOURCES);
}

/** Links shown in step answers that no step actually retrieved. */
export function unretrievedLinks(tasks = [], sources = [], knownUrls = []) {
  const known = new Set([...sources.map(item => item.url), ...knownUrls].map(normalizeUrl).filter(Boolean));
  const links = new Map();
  for (const task of tasks) {
    if (task.status !== 'complete' || task.type === 'verify' || typeof task.evidence?.text !== 'string') continue;
    // Links inside code being made (a website's map link, an image) are part
    // of the product, not sources the answer cites.
    if (task.type === 'code' || typeof task.evidence.structured?.source === 'string') continue;
    const prose = task.evidence.text.replace(/```[\s\S]*?```/g, ' ').replace(/\b(?:href|src|action)\s*=\s*["'][^"']*["']/gi, ' ');
    for (const match of prose.match(URL_PATTERN) ?? []) {
      const key = normalizeUrl(match);
      if (key && !known.has(key) && !links.has(key)) links.set(key, match.replace(/[.,;:!?]+$/, ''));
    }
  }
  return [...links.values()].slice(0, MAX_LINKS);
}

/** Whether the work so far rests on facts from outside the conversation. */
export function dependsOnOutsideFacts(run) {
  const tasks = run.tasks ?? [];
  if (tasks.some(task => task.type === 'investigate')) return true;
  if ((run.adaptation?.understanding?.requiredEvidence ?? []).length) return true;
  return tasks.some(task => task.status === 'complete' && (
    (task.evidence?.citations ?? []).length
    || (task.evidence?.tools ?? []).some(call => WEB_TOOLS.has(call?.tool))
  ));
}

/**
 * Decide whether the verifier checks facts against the live web. Research
 * leaves the conversation, so it follows the same rules as a research step:
 * web access on, plan policy allows research, and no open jurisdiction
 * review (research is an acting step there).
 */
export function groundedCheckDecision(run, { webAccess = true, researchAllowed = true } = {}) {
  if (!dependsOnOutsideFacts(run)) return { grounded: false, reason: 'no-outside-facts' };
  if (!webAccess) return { grounded: false, reason: 'web-access-off' };
  if (!researchAllowed) return { grounded: false, reason: 'research-policy-denied' };
  const governance = run.adaptation?.governance;
  if (governance?.status === 'blocked' || governance?.jurisdiction?.reviewRequired) {
    return { grounded: false, reason: 'governance-restricts-research' };
  }
  if (run.adaptation?.safetyAdaptive === true) return { grounded: false, reason: 'declined-request' };
  return { grounded: true, reason: 'outside-facts' };
}

/** The block the verifier receives alongside the evidence. */
export function verificationBrief(run, decision) {
  const tasks = run.tasks ?? [];
  const sources = evidenceSources(tasks);
  // Links the person gave in the goal or the chat are theirs, not invented.
  const given = [run.goal, ...(run.adaptation?.conversation ?? []).map(turn => turn?.content)]
    .flatMap(value => (typeof value === 'string' ? value.match(URL_PATTERN) ?? [] : []));
  return {
    groundedCheck: decision.grounded,
    sources,
    unretrievedLinks: unretrievedLinks(tasks, sources, given),
    requiredEvidence: (run.adaptation?.understanding?.requiredEvidence ?? []).slice(0, 10).map(item => clip(String(item), 300)),
    skillEvidenceContracts: (run.adaptation?.skillPlan?.skills ?? []).slice(0, 8).map(skill => ({
      name: skill.name,
      evidence: (skill.contract?.evidence ?? []).slice(0, 12)
    })),
    // Invention is held to its method, not only to the goal's wording.
    ...(tasks.some(task => task.metadata?.inventionLoop) ? { invention: true } : {})
  };
}

/**
 * Apply grounded checks to a normalized verdict. Claims the verifier marked
 * unsupported become problems (so the verdict fails), and the verdict
 * records whether facts were checked against the web and on which sources.
 */
export function groundVerdict(verdict, raw, { brief, grounded = false, checkedSources = [] } = {}) {
  if (!verdict) return verdict;
  const claims = Array.isArray(raw?.claims)
    ? raw.claims.slice(0, MAX_CLAIMS).filter(item => item && typeof item === 'object' && item.claim).map(item => ({
        claim: clip(String(item.claim), 300),
        supported: item.supported === true,
        ...(item.source ? { source: clip(String(item.source), 500) } : {}),
        ...(item.note ? { note: clip(String(item.note), 300) } : {})
      }))
    : [];
  const problems = [...verdict.problems];
  for (const item of claims) {
    if (!item.supported) problems.push(clip(`Unsupported claim: ${item.claim}${item.note ? ` (${item.note})` : ''}`, 500));
  }
  const confirmedLinks = new Set((Array.isArray(raw?.confirmedLinks) ? raw.confirmedLinks : []).map(normalizeUrl).filter(Boolean));
  // An unretrieved link counts against the answer only when the verifier
  // could look it up and did not confirm it.
  const unconfirmed = grounded
    ? (brief?.unretrievedLinks ?? []).filter(link => !confirmedLinks.has(normalizeUrl(link)))
    : [];
  for (const link of unconfirmed) problems.push(clip(`Cites a source that was neither retrieved nor confirmed: ${link}`, 500));
  const warnings = !grounded && brief?.unretrievedLinks?.length
    ? [`Links not retrieved or checked: ${brief.unretrievedLinks.join(', ')}`.slice(0, 500)]
    : [];
  const sources = [...new Map([...(brief?.sources ?? []), ...checkedSources].map(item => [normalizeUrl(item.url), { url: item.url, title: item.title ?? '' }])).values()]
    .filter(item => item.url)
    .slice(0, MAX_SOURCES);
  return {
    ...verdict,
    verdict: verdict.verdict === 'pass' && problems.length === 0 ? 'pass' : 'fail',
    problems: problems.slice(0, 30),
    ...(claims.length ? { claims } : {}),
    ...(warnings.length ? { warnings } : {}),
    grounding: { checkedAgainstWeb: grounded, sources }
  };
}
