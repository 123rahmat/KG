/**
 * Common harness for every model/agent invocation.
 * The model may propose; the server remains the only authority for tools,
 * policy, state mutation, approvals and execution.
 */
import crypto from 'node:crypto';
import { selectSkillDescriptors, skillDisclosure } from './skills.js';
import { buildRetrievalQuery } from './rag.js';

const text = value => String(value ?? '').trim();

export function buildHarnessContext({
  run = {}, task = {}, goal = '', capabilities = [], evidence = [],
  projectPaths = [], priorTopics = [], maxSkills = 4
} = {}) {
  const skills = selectSkillDescriptors(goal, {
    taskType: task.type, intent: run?.intent?.kind, capabilities, limit: maxSkills
  });
  return {
    harnessVersion: '1',
    trace: { runId: text(run.id) || null, taskId: text(task.id) || null, invocationId: crypto.randomUUID() },
    task: {
      id: text(task.id), type: text(task.type), purpose: text(task.purpose),
      successCriteria: Array.isArray(run?.situation?.successCriteria) ? run.situation.successCriteria.slice(0, 20) : []
    },
    skills: skills.map(skillDisclosure),
    retrieval: buildRetrievalQuery(goal, {
      projectPaths, skillNames: skills.map(item => item.name), priorTopics
    }),
    evidenceCount: Array.isArray(evidence) ? evidence.length : 0,
    authority: { modelCanPropose: true, modelCanAuthorize: false, modelCanGrantCapabilities: false, modelCanMutatePolicy: false }
  };
}

export function clampBudget(budget = {}, defaults = {}) {
  return {
    tokens: Math.max(1, Math.min(Number(budget.tokens ?? defaults.tokens ?? 4000), 100000)),
    steps: Math.max(1, Math.min(Number(budget.steps ?? defaults.steps ?? 8), 100)),
    seconds: Math.max(1, Math.min(Number(budget.seconds ?? defaults.seconds ?? 120), 3600)),
    spend: Math.max(0, Number(budget.spend ?? defaults.spend ?? 0) || 0)
  };
}

export function createHarnessPolicy({ risk = 'ordinary', allowedTools = [], allowedModels = [], budget = {} } = {}) {
  return Object.freeze({
    risk: text(risk) || 'ordinary',
    allowedTools: [...new Set(allowedTools.map(text).filter(Boolean))],
    allowedModels: [...new Set(allowedModels.map(text).filter(Boolean))],
    budget: clampBudget(budget)
  });
}
