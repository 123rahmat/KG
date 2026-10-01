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

export const SKILL_REGISTRY_VERSION = '1';
export const DEFAULT_SKILL_ROOT = path.join(fileURLToPath(new URL('../skills/', import.meta.url)));
export const MAX_SKILL_BYTES = 100_000;

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

export function selectSkillDescriptors(goal, {
  taskType = '',
  intent = '',
  capabilities = [],
  limit = 4
} = {}) {
  const value = text(goal).toLowerCase();
  const wanted = new Set([
    ...value.split(/[^a-z0-9]+/).filter(item => item.length > 2),
    text(intent).toLowerCase(),
    ...capabilities.map(item => text(item).toLowerCase())
  ]);
  return builtinSkillDescriptors()
    .map(skill => {
      let score = 0;
      if (skill.taskTypes.includes(text(taskType).toLowerCase())) score += 5;
      for (const tag of skill.tags) if (wanted.has(tag) || value.includes(tag)) score += 2;
      if (text(taskType).toLowerCase() === 'code' && ['coding','debugging','testing'].includes(skill.name)) score += 2;
      return { skill, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, Math.max(1, Math.min(8, Number(limit) || 4)))
    .map(item => item.skill);
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
  maxInstructionChars = 6000
} = {}) {
  const selected = selectSkillDescriptors(goal, { taskType, intent, capabilities, limit });
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
        progressiveDisclosure: true
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
