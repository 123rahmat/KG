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
export const SKILL_LEARNING_VERSION = '2';
const SKILL_OUTCOMES = new Set(['success', 'failure', 'uncertain']);
const SKILL_SOURCES = new Set(['execution', 'feedback', 'verification', 'repair']);

const text = value => String(value ?? '').trim();
const slug = value => text(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

const BUILTIN = Object.freeze([
  { name: 'coding', description: 'Repository-aware software implementation and change planning.', tags: ['code','build','implement','refactor'], taskTypes: ['code','build-code','prototype'] },
  { name: 'debugging', description: 'Evidence-driven diagnosis, minimal repair and regression analysis.', tags: ['debug','bug','failure','diagnose'], taskTypes: ['code','build-code','reassess'] },
  { name: 'testing', description: 'Regression design, edge cases, failure tests and verification strategy.', tags: ['test','quality','regression'], taskTypes: ['code','verify-code','build-code'] },
  { name: 'security-review', description: 'Trust-boundary, authorization, secret, injection and data-flow review.', tags: ['security','privacy','auth','encryption'], taskTypes: ['code','verify-code','review-code'] },
  { name: 'research', description: 'Evidence gathering, source comparison, uncertainty tracking and synthesis.', tags: ['research','investigate','sources'], taskTypes: ['investigate','discover','respond'] },
  { name: 'data', description: 'Structured data analysis, validation, transformation and lineage.', tags: ['data','sql','analytics'], taskTypes: ['data','investigate','code'] },
  { name: 'github', description: 'Safe repository, branch, diff and review workflows with explicit write-back.', tags: ['github','git','repository','pull-request'], taskTypes: ['code','build-code','deliver'] },
  { name: 'performance', description: 'Measured latency, resource, query and concurrency optimization.', tags: ['performance','latency','scale','cache'], taskTypes: ['code','review-code','prototype'] },
  { name: 'deployment', description: 'Release, rollback, environment and production verification procedures.', tags: ['deploy','release','rollback','production'], taskTypes: ['execute','deliver','code'] }
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
    contextUncertain: Math.max(0, Number(profile?.contextUncertain ?? profile?.context_uncertain ?? 0))
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
  const scope = new Map(profiles.map(profile => [
    profile.skillName + '\\x1f' + profile.taskType,
    profile
  ]));
  return builtinSkillDescriptors()
    .map(skill => {
      let score = 0;
      const wantedTask = text(taskType).toLowerCase();
      if (skill.taskTypes.includes(wantedTask)) score += 5;
      for (const tag of skill.tags) {
        if (wanted.has(tag) || value.includes(tag) || preferenceText.includes(tag)) score += 2;
      }
      if (wantedTask === 'code' && ['coding','debugging','testing'].includes(skill.name)) score += 2;
      const exact = scope.get(skill.name + '\\x1f' + wantedTask)
        ?? scope.get(skill.name + '\\x1f');
      const general = profiles.find(profile => profile.skillName === skill.name && !profile.taskType);
      score += skillLearningAdjustment(exact ?? general);
      return { skill, score, profile: exact ?? general ?? null };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
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
        adaptive: true
      } : {
        attempts: 0,
        success: 0,
        failure: 0,
        uncertain: 0,
        confidence: 0.5,
        utility: 0,
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
              COALESCE(c.context_uncertain, 0) AS "contextUncertain"
         FROM skill_profiles p
         LEFT JOIN (
           SELECT skill_name, task_type,
                  COUNT(*) FILTER (WHERE outcome = 'success')::int AS context_success,
                  COUNT(*) FILTER (WHERE outcome = 'failure')::int AS context_failure,
                  COUNT(*) FILTER (WHERE outcome = 'uncertain')::int AS context_uncertain
             FROM skill_observations
            WHERE workspace_id = $1
              AND principal_id = $2
              AND ($4::text <> '' AND context_signature = $4)
            GROUP BY skill_name, task_type
         ) c
           ON c.skill_name = p.skill_name
          AND c.task_type = p.task_type
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
      const removedProfiles = await client.query(
        'DELETE FROM skill_profiles WHERE workspace_id = $1 AND principal_id = $2',
        [scope.workspaceId, scope.principalId]
      );
      return {
        observations: removedObservations.rowCount ?? 0,
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
  learnedSkills = [],
  skillLevel = '',
  preferences = [],
  situation = null
} = {}) {
  const selected = selectSkillDescriptors(goal, {
    taskType, intent, capabilities, limit, learnedSkills, skillLevel, preferences, situation
  });
  const loaded = [];
  for (const descriptor of selected) {
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
        learning: skill.learning ?? { attempts: 0, confidence: 0.5, utility: 0, adaptive: false },
        userAdaptation: {
          skillLevel: text(skillLevel) || null,
          preferences: Array.isArray(preferences)
            ? preferences.map(text).filter(Boolean).slice(0, 10)
            : []
        }
      });
    } catch {
      loaded.push({ ...skillDisclosure(descriptor), fullInstructionsLoaded: false });
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
