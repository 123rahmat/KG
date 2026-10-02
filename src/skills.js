/**
 * First-class Agent Skills.
 *
 * Skills are instructions/procedures, not permissions. Metadata is discoverable
 * cheaply; full instructions are loaded only after a skill is selected.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transaction } from './db.js';

export const SKILL_REGISTRY_VERSION = '1';
export const DEFAULT_SKILL_ROOT = path.join(fileURLToPath(new URL('../skills/', import.meta.url)));
export const MAX_SKILL_BYTES = 100_000;
export const SKILL_LEARNING_VERSION = '3';
export const SKILL_INTELLIGENCE_VERSION = '1';
const SKILL_COST = Object.freeze({ light: 1, standard: 2, heavy: 4 });
const SKILL_PHASE_SET = new Set(['inspect','discover','compare','synthesize','plan','diagnose','repair','implement','change','design','execute','transform','validate','baseline','optimize','benchmark','preflight','release','health-check','diff','writeback','regress','verify','analyze','test']);
const SKILL_OUTCOMES = new Set(['success', 'failure', 'uncertain']);
const SKILL_SOURCES = new Set(['execution', 'feedback', 'verification', 'repair']);

const text = value => String(value ?? '').trim();
const slug = value => text(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

const BUILTIN = Object.freeze([
  { name: 'coding', description: 'Repository-aware software implementation and change planning.', tags: ['code','build','implement','refactor'], taskTypes: ['code','build-code','prototype'], requiresSkills: ['testing'], evidence: ['workspace-state','changed-files','test-results','verification'], phases: ['inspect','plan','implement','test','verify'], costClass: 'standard' },
  { name: 'debugging', description: 'Evidence-driven diagnosis, minimal repair and regression analysis.', tags: ['debug','bug','failure','diagnose'], taskTypes: ['code','build-code','reassess'], requiresSkills: ['testing'], evidence: ['failure-evidence','repair-record','regression-results'], phases: ['diagnose','repair','regress','verify'], costClass: 'standard' },
  { name: 'testing', description: 'Regression design, edge cases, failure tests and verification strategy.', tags: ['test','quality','regression'], taskTypes: ['code','verify-code','build-code'], requiresSkills: [], evidence: ['test-results','coverage-or-case-summary'], phases: ['design','execute','verify'], costClass: 'light' },
  { name: 'security-review', description: 'Trust-boundary, authorization, secret, injection and data-flow review.', tags: ['security','privacy','auth','encryption'], taskTypes: ['code','verify-code','review-code'], requiresSkills: ['testing'], evidence: ['security-findings','verification'], phases: ['inspect','analyze','verify'], costClass: 'heavy' },
  { name: 'research', description: 'Evidence gathering, source comparison, uncertainty tracking and synthesis.', tags: ['research','investigate','sources'], taskTypes: ['investigate','discover','respond'], requiresSkills: [], evidence: ['sources','provenance','claim-check'], phases: ['discover','compare','synthesize','verify'], costClass: 'standard' },
  { name: 'data', description: 'Structured data analysis, validation, transformation and lineage.', tags: ['data','sql','analytics'], taskTypes: ['data','investigate','code'], requiresSkills: ['testing'], evidence: ['input-lineage','validation-results'], phases: ['inspect','transform','validate','verify'], costClass: 'standard' },
  { name: 'github', description: 'Safe repository, branch, diff and review workflows with explicit write-back.', tags: ['github','git','repository','pull-request'], taskTypes: ['code','build-code','deliver'], requiresSkills: [], evidence: ['exact-revision','diff','writeback-receipt'], phases: ['inspect','change','diff','writeback','verify'], costClass: 'standard' },
  { name: 'performance', description: 'Measured latency, resource, query and concurrency optimization.', tags: ['performance','latency','scale','cache'], taskTypes: ['code','review-code','prototype'], requiresSkills: ['testing'], evidence: ['baseline','benchmark','regression-results'], phases: ['baseline','optimize','benchmark','verify'], costClass: 'heavy' },
  { name: 'deployment', description: 'Release, rollback, environment and production verification procedures.', tags: ['deploy','release','rollback','production'], taskTypes: ['execute','deliver','code'], requiresSkills: ['testing','security-review'], evidence: ['deployment-receipt','health-check','rollback-plan'], phases: ['preflight','release','health-check','verify'], costClass: 'heavy' }
]);

const parseScalar = value => {
  const item = text(value);
  return ((item.startsWith('"') && item.endsWith('"')) || (item.startsWith("'") && item.endsWith("'")))
    ? item.slice(1, -1)
    : item;
};

function frontMatter(markdown) {
  const value = String(markdown ?? '');
  if (!value.startsWith('---')) return { meta: {}, body: value };
  const end = value.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: value };
  const raw = value.slice(3, end).replace(/^\n/, '');
  const meta = {};
  for (const line of raw.split('\n')) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2].trim();
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      meta[key] = rawValue.slice(1, -1).split(',').map(parseScalar).filter(Boolean);
    } else {
      meta[key] = parseScalar(rawValue);
    }
  }
  return { meta, body: value.slice(end + 4).replace(/^\n/, '') };
}

function descriptorFromMeta(meta, directory) {
  const name = slug(meta.name || path.basename(directory));
  const description = text(meta.description);
  if (!name || !description) throw new Error('Skill metadata requires name and description');
  return {
    name,
    description: description.slice(0, 1000),
    version: text(meta.version) || '1',
    risk: text(meta.risk) || 'ordinary',
    dataClasses: Array.isArray(meta.dataClasses) ? meta.dataClasses.slice(0, 20) : [],
    tools: Array.isArray(meta.tools) ? meta.tools.slice(0, 40) : [],
    tags: Array.isArray(meta.tags) ? meta.tags.slice(0, 30) : [],
    taskTypes: Array.isArray(meta.taskTypes) ? meta.taskTypes.slice(0, 30) : [],
    requiresSkills: Array.isArray(meta.requiresSkills) ? [...new Set(meta.requiresSkills.map(slug).filter(Boolean))].slice(0, 16) : [],
    evidence: Array.isArray(meta.evidence) ? [...new Set(meta.evidence.map(text).filter(Boolean))].slice(0, 24) : [],
    phases: Array.isArray(meta.phases) ? [...new Set(meta.phases.map(value => text(value).toLowerCase()).filter(Boolean))].slice(0, 16) : [],
    costClass: Object.hasOwn(SKILL_COST, text(meta.costClass).toLowerCase()) ? text(meta.costClass).toLowerCase() : 'standard',
    directory,
    progressiveDisclosure: true
  };
}

export function builtinSkillDescriptors() {
  return BUILTIN.map(item => ({
    ...item,
    version: '1',
    risk: item.name === 'security-review' ? 'high' : 'ordinary',
    dataClasses: [],
    tools: [],
    requiresSkills: item.requiresSkills ?? [],
    evidence: item.evidence ?? [],
    phases: item.phases ?? [],
    costClass: item.costClass ?? 'standard',
    directory: path.resolve(DEFAULT_SKILL_ROOT, item.name),
    progressiveDisclosure: true
  }));
}

export function skillContextSignature({
  taskType = '',
  intent = '',
  coding = false,
  projectWork = false,
  unknown = false,
  complexity = 0,
  scale = '',
  retrying = false,
  verification = false,
  language = ''
} = {}) {
  const complexityBand = Number(complexity) >= 0.8 ? 'high'
    : Number(complexity) >= 0.55 ? 'complex'
      : Number(complexity) >= 0.3 ? 'multi-file'
        : Number(complexity) >= 0.12 ? 'small'
          : 'single';
  return crypto.createHash('sha256').update(JSON.stringify({
    taskType: text(taskType).toLowerCase(),
    intent: text(intent).toLowerCase(),
    coding: Boolean(coding),
    projectWork: Boolean(projectWork),
    unknown: Boolean(unknown),
    complexityBand,
    scale: text(scale).toLowerCase(),
    retrying: Boolean(retrying),
    verification: Boolean(verification),
    language: text(language).toLowerCase()
  }), 'utf8').digest('hex').slice(0, 40);
}

function normalizedSkillProfile(profile) {
  const attempts = Math.max(
    0,
    Number(profile?.successCount ?? profile?.success_count ?? 0)
      + Number(profile?.failureCount ?? profile?.failure_count ?? 0)
      + Number(profile?.uncertainCount ?? profile?.uncertain_count ?? 0)
  );
  const success = Math.max(0, Number(profile?.successCount ?? profile?.success_count ?? 0));
  const failure = Math.max(0, Number(profile?.failureCount ?? profile?.failure_count ?? 0));
  const uncertain = Math.max(0, Number(profile?.uncertainCount ?? profile?.uncertain_count ?? 0));
  const confidence = Number.isFinite(Number(profile?.confidence))
    ? Math.max(0, Math.min(1, Number(profile.confidence)))
    : (success + 1) / (success + failure + 2);
  const utility = Number.isFinite(Number(profile?.utility))
    ? Math.max(-1, Math.min(1, Number(profile.utility)))
    : Number.isFinite(Number(profile?.utilityEma ?? profile?.utility_ema))
      ? Math.max(-1, Math.min(1, Number(profile.utilityEma ?? profile.utility_ema)))
      : 0;
  return {
    skillName: text(profile?.skillName ?? profile?.skill_name),
    taskType: text(profile?.taskType ?? profile?.task_type).toLowerCase(),
    attempts,
    success,
    failure,
    uncertain,
    confidence,
    utility,
    lastObservedAt: profile?.lastObservedAt ?? profile?.last_observed_at ?? null,
    contextSuccess: Math.max(0, Number(profile?.contextSuccess ?? profile?.context_success ?? 0)),
    contextFailure: Math.max(0, Number(profile?.contextFailure ?? profile?.context_failure ?? 0)),
    contextUncertain: Math.max(0, Number(profile?.contextUncertain ?? profile?.context_uncertain ?? 0)),
    failurePattern: text(profile?.failurePattern ?? profile?.failure_pattern) || null
  };
}

export function validateSkillDescriptor(skill, { registry = builtinSkillDescriptors() } = {}) {
  const errors = [];
  const name = slug(skill?.name);
  if (!name) errors.push('missing-name');
  if (!text(skill?.description)) errors.push('missing-description');
  if (!text(skill?.version)) errors.push('missing-version');
  if (!Array.isArray(skill?.taskTypes)) errors.push('task-types-not-array');
  const phases = Array.isArray(skill?.phases) ? skill.phases : [];
  const invalidPhases = phases.filter(phase => !SKILL_PHASE_SET.has(text(phase).toLowerCase()));
  if (invalidPhases.length) errors.push('invalid-phases:' + invalidPhases.join(','));
  const cost = text(skill?.costClass).toLowerCase() || 'standard';
  if (!Object.hasOwn(SKILL_COST, cost)) errors.push('invalid-cost-class');
  const dependencies = Array.isArray(skill?.requiresSkills) ? skill.requiresSkills.map(slug).filter(Boolean) : [];
  if (dependencies.includes(name)) errors.push('self-dependency');
  const known = new Set(registry.map(item => slug(item.name)));
  const unknownDeps = dependencies.filter(item => !known.has(item));
  if (unknownDeps.length) errors.push('unknown-dependencies:' + unknownDeps.join(','));
  return { valid: errors.length === 0, errors };
}

export function evaluateSkillRegistry(descriptors = builtinSkillDescriptors()) {
  const items = Array.isArray(descriptors) ? descriptors : [];
  const errors = [];
  const names = new Set();
  const graph = new Map();

  for (const skill of items) {
    const name = slug(skill?.name);
    if (names.has(name)) errors.push('duplicate:' + name);
    names.add(name);
    const dependencies = Array.isArray(skill?.requiresSkills)
      ? [...new Set(skill.requiresSkills.map(slug).filter(Boolean))]
      : [];
    graph.set(name, dependencies);
    const check = validateSkillDescriptor(skill, { registry: items });
    if (!check.valid) errors.push(...check.errors.map(error => name + ':' + error));
  }

  // A cyclic dependency graph is invalid: composition must never silently
  // drop an edge and then execute a skill without its declared prerequisite.
  const visiting = new Set();
  const visited = new Set();
  const walk = name => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      errors.push('dependency-cycle:' + name);
      return;
    }
    visiting.add(name);
    for (const dependency of graph.get(name) ?? []) {
      if (graph.has(dependency)) walk(dependency);
    }
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of graph.keys()) walk(name);

  return {
    valid: errors.length === 0,
    skillCount: items.length,
    errors: [...new Set(errors)]
  };
}

function hierarchicalSkillEvidence(profiles, skillName, taskType) {
  const wantedSkill = slug(skillName);
  const relevant = (Array.isArray(profiles) ? profiles : [])
    .map(normalizedSkillProfile)
    .filter(profile => slug(profile.skillName) === wantedSkill);
  if (!relevant.length) return null;
  const wantedTask = slug(taskType);
  const exact = relevant.find(profile => slug(profile.taskType) === wantedTask);
  const general = relevant.find(profile => !slug(profile.taskType));
  if (!exact) return general ?? relevant[0];
  if (!general) return exact;
  const exactWeight = Math.max(1, exact.attempts);
  const generalWeight = Math.max(1, general.attempts) * 0.35;
  const totalWeight = exactWeight + generalWeight;
  return { ...exact, attempts: Math.round(exactWeight + generalWeight), success: Math.round(exact.success + general.success * 0.35), failure: Math.round(exact.failure + general.failure * 0.35), uncertain: Math.round(exact.uncertain + general.uncertain * 0.35), confidence: (exact.confidence * exactWeight + general.confidence * generalWeight) / totalWeight, utility: (exact.utility * exactWeight + general.utility * generalWeight) / totalWeight, lastObservedAt: exact.lastObservedAt ?? general.lastObservedAt, failurePattern: exact.failurePattern ?? general.failurePattern };
}

export function classifySkillFailure(reason = '') {
  const value = text(reason).toLowerCase();
  if (!value) return 'unknown';
  if (/syntax|parse/.test(value)) return 'syntax';
  if (/test|assert|regression/.test(value)) return 'tests';
  if (/timeout|timed.?out|slow/.test(value)) return 'timeout';
  if (/permission|forbidden|unauthori[sz]ed|approval/.test(value)) return 'authorization';
  if (/stale|revision|conflict|concurrency/.test(value)) return 'stale-state';
  if (/security|secret|injection|privacy/.test(value)) return 'security';
  if (/provider|model|network|connector/.test(value)) return 'dependency';
  if (/verification|evidence|unsupported/.test(value)) return 'verification';
  return 'other';
}

export function skillContract(skill) {
  const source = skill && typeof skill === 'object' ? skill : {};
  const costClass = Object.hasOwn(SKILL_COST, text(source.costClass).toLowerCase()) ? text(source.costClass).toLowerCase() : 'standard';
  return { phases: Array.isArray(source.phases) && source.phases.length ? [...source.phases] : ['execute'], requiresSkills: Array.isArray(source.requiresSkills) ? [...new Set(source.requiresSkills.map(slug).filter(Boolean))] : [], evidence: Array.isArray(source.evidence) ? [...new Set(source.evidence.map(text).filter(Boolean))] : [], costClass, cost: SKILL_COST[costClass], intelligenceVersion: SKILL_INTELLIGENCE_VERSION };
}

export function composeSkillPlan(skills = [], { taskType = '', maxSkills = 8, maxCost = 12 } = {}) {
  const registry = builtinSkillDescriptors();
  const rawSeed = (Array.isArray(skills) ? skills : []).filter(item => item?.name);
  const byName = new Map([...rawSeed.map(item => [slug(item.name), item]), ...registry.map(skill => [skill.name, skill])]);
  const seed = rawSeed.map(item => ({ ...(byName.get(slug(item.name)) ?? {}), ...item })).filter(item => item?.name);
  const selected = new Map();
  const visiting = new Set();
  const add = descriptor => {
    const name = slug(descriptor?.name);
    if (!name || selected.has(name) || visiting.has(name)) return;
    visiting.add(name);
    for (const dependency of skillContract(descriptor).requiresSkills) { const required = byName.get(dependency); if (required) add(required); }
    visiting.delete(name);
    if (selected.size < Math.max(1, Math.min(12, Number(maxSkills) || 8))) selected.set(name, descriptor);
  };
  for (const skill of seed) add(skill);
  const ordered = [];
  const visited = new Set();
  const visit = descriptor => {
    const name = slug(descriptor?.name);
    if (!name || visited.has(name)) return;
    visited.add(name);
    for (const dependency of skillContract(descriptor).requiresSkills) { const dep = selected.get(dependency); if (dep) visit(dep); }
    ordered.push(descriptor);
  };
  for (const descriptor of selected.values()) visit(descriptor);
  let cost = 0;
  const final = [];
  const skipped = [];
  const seeded = new Set(seed.map(item => slug(item?.name)));
  const included = new Set();

  for (const descriptor of ordered) {
    const name = slug(descriptor.name);
    const contract = skillContract(descriptor);
    const missingDependency = contract.requiresSkills.find(dependency => !included.has(dependency));
    if (missingDependency) {
      skipped.push({ name: descriptor.name, reason: 'required-dependency-unavailable', dependency: missingDependency });
      continue;
    }
    if (cost + contract.cost > Math.max(1, Number(maxCost) || 12)) {
      skipped.push({ name: descriptor.name, reason: 'skill-cost-budget' });
      continue;
    }
    cost += contract.cost;
    included.add(name);
    final.push({
      ...descriptor,
      contract,
      order: final.length + 1,
      implicit: !seeded.has(name),
      taskType: text(taskType).toLowerCase()
    });
  }

  const selectedNames = new Set(final.map(item => slug(item.name)));
  // A selected skill can never survive composition if one of its declared
  // prerequisites was excluded by the cost/skill budget.
  const invariantViolations = final
    .filter(item => skillContract(item).requiresSkills.some(dependency => !selectedNames.has(dependency)))
    .map(item => item.name);
  if (invariantViolations.length) {
    for (const name of invariantViolations) {
      skipped.push({ name, reason: 'composition-invariant-violation' });
    }
    const kept = final.filter(item => !invariantViolations.includes(item.name));
    return {
      version: SKILL_INTELLIGENCE_VERSION,
      taskType: text(taskType).toLowerCase(),
      skills: kept.map((item, index) => ({ ...item, order: index + 1 })),
      addedDependencies: kept.filter(item => item.implicit).map(item => item.name),
      skipped,
      totalCost: kept.reduce((sum, item) => sum + item.contract.cost, 0),
      evidence: [...new Set(kept.flatMap(item => item.contract.evidence))],
      phases: [...new Set(kept.flatMap(item => item.contract.phases))]
    };
  }

  return {
    version: SKILL_INTELLIGENCE_VERSION,
    taskType: text(taskType).toLowerCase(),
    skills: final,
    addedDependencies: final.filter(item => item.implicit).map(item => item.name),
    skipped,
    totalCost: cost,
    evidence: [...new Set(final.flatMap(item => item.contract.evidence))],
    phases: [...new Set(final.flatMap(item => item.contract.phases))]
  };
}
export function skillLearningAdjustment(profile, { minimumEvidence = 2 } = {}) {
  const normalized = normalizedSkillProfile(profile);
  if (!normalized.skillName || normalized.attempts < 1) return 0;
  // Older experience remains useful, but decays so current behavior can relearn
  // instead of being permanently dominated by stale history.
  const observedAt = Date.parse(normalized.lastObservedAt ?? '');
  const ageDays = Number.isFinite(observedAt)
    ? Math.max(0, (Date.now() - observedAt) / 86_400_000)
    : 365;
  const recencyWeight = 0.35 + 0.65 * Math.exp(-ageDays / 90);
  // One-shot observations never dominate deterministic task matching.
  const evidenceWeight = Math.min(1, normalized.attempts / Math.max(1, minimumEvidence));
  const confidenceSignal = (normalized.confidence - 0.5) * 4;
  const utilitySignal = normalized.utility * 2;
  const contextAttempts = normalized.contextSuccess + normalized.contextFailure + normalized.contextUncertain;
  const contextWeight = Math.min(1, contextAttempts / Math.max(1, minimumEvidence));
  const contextConfidence = contextAttempts
    ? (normalized.contextSuccess + 1) / (normalized.contextSuccess + normalized.contextFailure + 2)
    : 0.5;
  const contextSignal = (contextConfidence - 0.5) * 2.5;
  return Math.max(-2.5, Math.min(2.5,
    ((confidenceSignal + utilitySignal) * evidenceWeight + contextSignal * contextWeight)
      * recencyWeight
  ));
}

export function selectSkillDescriptors(goal, {
  taskType = '',
  intent = '',
  capabilities = [],
  limit = 4,
  learnedSkills = [],
  skillLevel = '',
  preferences = [],
  situation = null
} = {}) {
  const value = text(goal).toLowerCase();
  const preferenceText = Array.isArray(preferences) ? preferences.map(text).join(' ').toLowerCase() : '';
  const wanted = new Set([
    ...value.split(/[^a-z0-9]+/).filter(item => item.length > 2),
    ...preferenceText.split(/[^a-z0-9]+/).filter(item => item.length > 2),
    text(intent).toLowerCase(),
    ...capabilities.map(item => text(item).toLowerCase())
  ]);
  const profiles = (Array.isArray(learnedSkills) ? learnedSkills : []).map(normalizedSkillProfile);
  return builtinSkillDescriptors()
    .map(skill => {
      let score = 0;
      const wantedTask = text(taskType).toLowerCase();
      if (skill.taskTypes.includes(wantedTask)) score += 5;
      for (const tag of skill.tags) {
        if (wanted.has(tag) || value.includes(tag) || preferenceText.includes(tag)) score += 2;
      }
      if (wantedTask === 'code' && ['coding','debugging','testing'].includes(skill.name)) score += 2;
      const learned = hierarchicalSkillEvidence(profiles, skill.name, wantedTask);
      score += skillLearningAdjustment(learned);
      if (!learned || learned.attempts < 2) score += 0.15;
      if (learned?.failurePattern) score -= 0.25;
      return { skill, score, profile: learned };
    })
    .filter(item => item.score > 0 || item.profile?.attempts > 0)
    .sort((a, b) => b.score - a.score || b.profile?.attempts - a.profile?.attempts || a.skill.name.localeCompare(b.skill.name))
    .slice(0, Math.max(1, Math.min(8, Number(limit) || 4)))
    .map(item => ({
      ...item.skill,
      learning: item.profile ? {
        attempts: item.profile.attempts,
        success: item.profile.success,
        failure: item.profile.failure,
        uncertain: item.profile.uncertain,
        confidence: item.profile.confidence,
        utility: item.profile.utility,
        contextSuccess: item.profile.contextSuccess,
        contextFailure: item.profile.contextFailure,
        contextUncertain: item.profile.contextUncertain,
        failurePattern: item.profile.failurePattern ?? null,
        adaptive: true
      } : {
        attempts: 0,
        success: 0,
        failure: 0,
        uncertain: 0,
        confidence: 0.5,
        utility: 0,
        failurePattern: null,
        adaptive: false
      },
      skillLevel: text(skillLevel) || null,
      situationAware: Boolean(situation)
    }));
}




export function summarizeSkillLearning(skills = []) {
  const items = (Array.isArray(skills) ? skills : [])
    .filter(skill => skill && typeof skill === 'object')
    .map(skill => skill.learning ?? null)
    .filter(item => item && Number(item.attempts ?? 0) > 0);
  if (!items.length) {
    return {
      enabled: true,
      experienced: false,
      skillCount: 0,
      attempts: 0,
      confidence: 0.5,
      utility: 0,
      reliability: 0.5,
      uncertainty: 0.5
    };
  }
  const weighted = items.reduce((acc, item) => {
    const weight = Math.max(1, Number(item.attempts) || 1);
    acc.weight += weight;
    acc.confidence += Math.max(0, Math.min(1, Number(item.confidence) || 0)) * weight;
    acc.utility += Math.max(-1, Math.min(1, Number(item.utility) || 0)) * weight;
    acc.attempts += Math.max(0, Number(item.attempts) || 0);
    return acc;
  }, { weight: 0, confidence: 0, utility: 0, attempts: 0 });
  const confidence = accClamp(weighted.confidence / weighted.weight, 0, 1);
  const utility = accClamp(weighted.utility / weighted.weight, -1, 1);
  return {
    enabled: true,
    experienced: true,
    skillCount: items.length,
    attempts: weighted.attempts,
    confidence,
    utility,
    reliability: accClamp((confidence * 0.75) + ((utility + 1) / 2) * 0.25, 0, 1),
    uncertainty: accClamp(1 - confidence, 0, 1)
  };
}
function accClamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function learningOutcome(value) {
  const outcome = text(value).toLowerCase();
  if (!SKILL_OUTCOMES.has(outcome)) throw new Error('Invalid skill learning outcome');
  return outcome;
}

function learningSource(value) {
  const source = text(value).toLowerCase() || 'execution';
  if (!SKILL_SOURCES.has(source)) throw new Error('Invalid skill learning source');
  return source;
}

export class SkillLearningStore {
  constructor(pool, { logger = null } = {}) {
    this.pool = pool;
    this.logger = logger;
  }

  async profiles(scope, { limit = 48, taskType = '', contextSignature = '' } = {}) {
    if (!scope?.workspaceId || !scope?.principalId) return [];
    const cap = Math.min(Math.max(Number(limit) || 48, 1), 100);
    const { rows } = await this.pool.query(
      `SELECT p.skill_name AS "skillName",
              p.task_type AS "taskType",
              p.success_count AS "successCount",
              p.failure_count AS "failureCount",
              p.uncertain_count AS "uncertainCount",
              p.confidence,
              p.utility_ema AS "utility",
              p.last_observed_at AS "lastObservedAt",
              COALESCE(c.context_success, 0) AS "contextSuccess",
              COALESCE(c.context_failure, 0) AS "contextFailure",
              COALESCE(c.context_uncertain, 0) AS "contextUncertain",
              COALESCE(pp.failure_pattern, '') AS "failurePattern"
         FROM skill_profiles p
         LEFT JOIN (
           SELECT skill_name, task_type,
                  COALESCE(SUM(success_count), 0)::int AS context_success,
                  COALESCE(SUM(failure_count), 0)::int AS context_failure,
                  COALESCE(SUM(uncertain_count), 0)::int AS context_uncertain
             FROM skill_patterns
            WHERE workspace_id = $1
              AND principal_id = $2
              AND pattern_kind = 'context-outcome'
              AND ($4::text <> '' AND context_signature = $4)
            GROUP BY skill_name, task_type
         ) c
           ON c.skill_name = p.skill_name
          AND c.task_type = p.task_type
        LEFT JOIN (
          SELECT skill_name, task_type,
                 (array_agg(pattern_key ORDER BY last_observed_at DESC))[1] AS failure_pattern
            FROM skill_patterns
           WHERE workspace_id = $1
             AND principal_id = $2
             AND pattern_kind = 'failure'
             AND ($4::text <> '' AND context_signature = $4)
           GROUP BY skill_name, task_type
        ) pp
          ON pp.skill_name = p.skill_name
         AND pp.task_type = p.task_type
        WHERE p.workspace_id = $1
          AND p.principal_id = $2
          AND ($3::text = '' OR p.task_type = $3)
        ORDER BY (p.success_count + p.failure_count + p.uncertain_count) DESC, p.last_observed_at DESC
        LIMIT $5`,
      [scope.workspaceId, scope.principalId, text(taskType).toLowerCase(), text(contextSignature), cap]
    );
    return rows.map(normalizedSkillProfile);
  }

  async clear(scope) {
    if (!scope?.workspaceId || !scope?.principalId) return { observations: 0, profiles: 0 };
    return transaction(this.pool, async client => {
      const removedObservations = await client.query(
        'DELETE FROM skill_observations WHERE workspace_id = $1 AND principal_id = $2',
        [scope.workspaceId, scope.principalId]
      );
      const removedPatterns = await client.query(
        'DELETE FROM skill_patterns WHERE workspace_id = $1 AND principal_id = $2',
        [scope.workspaceId, scope.principalId]
      );
      const removedProfiles = await client.query(
        'DELETE FROM skill_profiles WHERE workspace_id = $1 AND principal_id = $2',
        [scope.workspaceId, scope.principalId]
      );
      return {
        observations: removedObservations.rowCount ?? 0,
        patterns: removedPatterns.rowCount ?? 0,
        profiles: removedProfiles.rowCount ?? 0
      };
    });
  }

  async observe(scope, {
    runId,
    taskId,
    taskType = '',
    skillNames = [],
    outcome = 'uncertain',
    source = 'execution',
    reason = '',
    eventKey = null,
    contextSignature = '',
    utilitySignal = null
  } = {}) {
    if (!scope?.workspaceId || !scope?.principalId) return { observed: 0 };
    if (!text(runId) || !text(taskId)) return { observed: 0 };
    const normalizedOutcome = learningOutcome(outcome);
    const normalizedSource = learningSource(source);
    const names = [...new Set((Array.isArray(skillNames) ? skillNames : [])
      .map(item => text(typeof item === 'string' ? item : item?.name).toLowerCase())
      .filter(Boolean)
      .map(slug))].slice(0, 16);
    if (!names.length) return { observed: 0 };

    const signal = normalizedOutcome === 'success' ? 1 : normalizedOutcome === 'failure' ? -1 : 0;
    const utility = Number.isFinite(Number(utilitySignal))
      ? Math.max(-1, Math.min(1, Number(utilitySignal)))
      : signal;
    const event = text(eventKey) || crypto.createHash('sha256')
      .update([runId, taskId, normalizedSource, normalizedOutcome, text(reason)].join('\\x1f'), 'utf8')
      .digest('hex');

    return transaction(this.pool, async client => {
      let observed = 0;
      for (const skillName of names) {
        const inserted = await client.query(
          `INSERT INTO skill_observations
            (id, workspace_id, principal_id, run_id, task_id, skill_name, task_type,
             outcome, source, reason, signal, event_key, context_signature)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (workspace_id, principal_id, run_id, task_id, skill_name, source, event_key)
           DO NOTHING
           RETURNING id`,
          [
            crypto.randomUUID(), scope.workspaceId, scope.principalId, text(runId), text(taskId),
            skillName, text(taskType).toLowerCase(), normalizedOutcome, normalizedSource,
            text(reason).slice(0, 240), signal, event, text(contextSignature)
          ]
        );
        if (!inserted.rows.length) continue;
        if (text(contextSignature)) {
          const patternKind = normalizedOutcome === 'failure' ? 'failure' : 'context-outcome';
          const patternKey = normalizedOutcome === 'failure' ? classifySkillFailure(reason) : normalizedOutcome;
          await client.query(
            `INSERT INTO skill_patterns
              (workspace_id, principal_id, skill_name, task_type, context_signature, pattern_kind, pattern_key,
               success_count, failure_count, uncertain_count, utility_ema, last_observed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
             ON CONFLICT (workspace_id, principal_id, skill_name, task_type, context_signature, pattern_kind, pattern_key)
             DO UPDATE SET
               success_count = skill_patterns.success_count + EXCLUDED.success_count,
               failure_count = skill_patterns.failure_count + EXCLUDED.failure_count,
               uncertain_count = skill_patterns.uncertain_count + EXCLUDED.uncertain_count,
               utility_ema = LEAST(1, GREATEST(-1, skill_patterns.utility_ema * 0.8 + EXCLUDED.utility_ema * 0.2)),
               last_observed_at = now()`,
            [
              scope.workspaceId, scope.principalId, skillName, text(taskType).toLowerCase(), text(contextSignature),
              patternKind, patternKey,
              normalizedOutcome === 'success' ? 1 : 0,
              normalizedOutcome === 'failure' ? 1 : 0,
              normalizedOutcome === 'uncertain' ? 1 : 0,
              utility
            ]
          );
        }
        await client.query(
          `INSERT INTO skill_profiles
            (workspace_id, principal_id, skill_name, task_type,
             success_count, failure_count, uncertain_count, confidence, utility_ema, last_observed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
           ON CONFLICT (workspace_id, principal_id, skill_name, task_type)
           DO UPDATE SET
             success_count = skill_profiles.success_count + EXCLUDED.success_count,
             failure_count = skill_profiles.failure_count + EXCLUDED.failure_count,
             uncertain_count = skill_profiles.uncertain_count + EXCLUDED.uncertain_count,
             confidence = CASE
               WHEN (skill_profiles.success_count + skill_profiles.failure_count + EXCLUDED.success_count + EXCLUDED.failure_count) = 0
                 THEN 0.5
               ELSE (
                 skill_profiles.success_count + EXCLUDED.success_count + 1.0
               ) / (
                 skill_profiles.success_count + skill_profiles.failure_count
                 + EXCLUDED.success_count + EXCLUDED.failure_count + 2.0
               )
             END,
             utility_ema = LEAST(1, GREATEST(-1, skill_profiles.utility_ema * 0.8 + EXCLUDED.utility_ema * 0.2)),
             last_observed_at = now()`,
          [
            scope.workspaceId, scope.principalId, skillName, text(taskType).toLowerCase(),
            normalizedOutcome === 'success' ? 1 : 0,
            normalizedOutcome === 'failure' ? 1 : 0,
            normalizedOutcome === 'uncertain' ? 1 : 0,
            signal === 0 ? 0.5 : normalizedOutcome === 'success' ? 1 : 0.5,
            utility
          ]
        );
        observed += 1;
      }
      this.logger?.debug('skill learning observation recorded', {
        workspaceId: scope.workspaceId, principalId: scope.principalId,
        runId: text(runId), taskId: text(taskId), observed, source: normalizedSource
      });
      return { observed };
    });
  }
}

export function skillPlanForSelectedSkills(skills, { taskType = '', maxSkills = 8, maxCost = 12 } = {}) {
  return composeSkillPlan(skills, { taskType, maxSkills, maxCost });
}

async function walk(directory, depth, output) {
  if (depth < 0) return;
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, depth - 1, output);
    else if (entry.isFile() && entry.name === 'SKILL.md') output.push(full);
  }
}

export async function discoverSkills(root = DEFAULT_SKILL_ROOT, { maxDepth = 3 } = {}) {
  const absoluteRoot = path.resolve(root);
  const files = [];
  await walk(absoluteRoot, Math.max(0, Number(maxDepth) || 3), files);
  const descriptors = [];
  for (const file of files.sort()) {
    const raw = await fs.readFile(file, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_SKILL_BYTES) continue;
    try {
      descriptors.push(descriptorFromMeta(frontMatter(raw).meta, path.dirname(file)));
    } catch {
      // Invalid metadata is never exposed as an executable skill.
    }
  }
  return descriptors;
}

export async function loadSkill(descriptor, { maxBytes = MAX_SKILL_BYTES } = {}) {
  if (!descriptor?.directory) throw new Error('This built-in descriptor has no local implementation');
  const directory = path.resolve(descriptor.directory);
  const skillFile = path.join(directory, 'SKILL.md');
  if (!skillFile.startsWith(directory + path.sep)) throw new Error('Invalid skill path');
  const raw = await fs.readFile(skillFile, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new Error('Skill is too large');
  const parsed = frontMatter(raw);
  const normalized = descriptorFromMeta(parsed.meta, directory);
  return {
    ...normalized,
    instructions: parsed.body.trim(),
    fingerprint: crypto.createHash('sha256').update(raw, 'utf8').digest('hex')
  };
}

export async function loadSelectedSkills(goal, {
  taskType = '',
  intent = '',
  capabilities = [],
  limit = 4,
  maxInstructionChars = 6000,
  maxSkillCost = 12,
  learnedSkills = [],
  skillLevel = '',
  preferences = [],
  situation = null
} = {}) {
  const selected = selectSkillDescriptors(goal, {
    taskType, intent, capabilities, limit, learnedSkills, skillLevel, preferences, situation
  });
  const loaded = [];
  for (const planItem of selected) {
    const descriptor = planItem;
    try {
      const skill = await loadSkill(descriptor, { maxBytes: MAX_SKILL_BYTES });
      loaded.push({
        name: skill.name,
        version: skill.version,
        description: skill.description,
        tags: skill.tags,
        risk: skill.risk,
        tools: skill.tools,
        dataClasses: skill.dataClasses,
        instructions: skill.instructions.slice(0, maxInstructionChars),
        fingerprint: skill.fingerprint,
        progressiveDisclosure: true,
        contract: planItem.contract ?? skillContract(skill),
        order: planItem.order ?? null,
        implicit: planItem.implicit === true,
        learning: descriptor.learning ?? skill.learning ?? { attempts: 0, confidence: 0.5, utility: 0, adaptive: false },
        userAdaptation: {
          skillLevel: text(skillLevel) || null,
          preferences: Array.isArray(preferences)
            ? preferences.map(text).filter(Boolean).slice(0, 10)
            : []
        }
      });
    } catch {
      loaded.push({ ...skillDisclosure(descriptor), contract: planItem.contract ?? skillContract(descriptor), order: planItem.order ?? null, implicit: planItem.implicit === true, fullInstructionsLoaded: false });
    }
  }
  return loaded;
}

export function skillDisclosure(descriptor) {
  return {
    name: descriptor?.name ?? null,
    description: descriptor?.description ?? '',
    version: descriptor?.version ?? '1',
    tags: Array.isArray(descriptor?.tags) ? descriptor.tags : [],
    progressiveDisclosure: true,
    fullInstructionsLoaded: false
  };
}
