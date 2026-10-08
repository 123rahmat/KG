/**
 * Common harness for every model/agent invocation.
 * The model may propose; the server remains the only authority for tools,
 * policy, state mutation, approvals and execution.
 */
import crypto from 'node:crypto';
import { selectSkillDescriptors, skillDisclosure, composeSkillPlan } from './skills.js';
import { buildRetrievalQuery } from './rag.js';

const text = value => String(value ?? '').trim();

export function buildHarnessContext({
  run = {}, task = {}, goal = '', capabilities = [], evidence = [],
  projectPaths = [], priorTopics = [], maxSkills = 4, learnedSkills = [],
  preferences = [], memory = [], memoryAuthorized = false, maxMemoryChars = 1200
} = {}) {
  const selected = selectSkillDescriptors(goal, {
    taskType: task.type, intent: run?.intent?.kind, capabilities, limit: maxSkills,
    learnedSkills: Array.isArray(learnedSkills) ? learnedSkills : [],
    preferences: Array.isArray(preferences) ? preferences : [], situation: run?.situation ?? null
  });
  // Prerequisites are ordered and cost-bounded before disclosure to specialists.
  const remainingSkillBudget = Math.max(0, Math.min(12,
    Number(run?.adaptiveBudget?.remaining?.skillCost ?? 8)));
  const plan = remainingSkillBudget < 1
    ? { skills: [], totalCost: 0, addedDependencies: [], skipped: [], evidence: [] }
    : composeSkillPlan(selected, { taskType: task.type,
      maxSkills: Math.max(1, Math.min(8, Number(maxSkills) || 4)),
      maxCost: remainingSkillBudget
    });
  const skills = plan.skills;
  const memories = [];
  let usedChars = 0;
  // The upstream memory store must perform workspace/principal/project checks.
  // Never interpret user-provided memory text as an instruction or permission.
  if (memoryAuthorized === true && run?.principalId && Array.isArray(memory)) {
    for (const item of memory.slice(0, 8)) {
      if (item?.principalId && item.principalId !== run.principalId) continue;
      if (item?.workspaceId && run?.workspaceId && item.workspaceId !== run.workspaceId) continue;
      const content = text(item?.content).slice(0, 450);
      if (!content || usedChars + content.length > Math.max(0, Math.min(2400, Number(maxMemoryChars) || 0))) continue;
      usedChars += content.length;
      memories.push({ kind: text(item?.kind) || 'fact', content, source: 'scoped-memory-data-not-instructions' });
    }
  }
  return {
    harnessVersion: '1',
    trace: { runId: text(run.id) || null, taskId: text(task.id) || null, invocationId: crypto.randomUUID() },
    task: {
      id: text(task.id), type: text(task.type), purpose: text(task.purpose),
      successCriteria: Array.isArray(run?.situation?.successCriteria) ? run.situation.successCriteria.slice(0, 20) : []
    },
    skills: skills.map(skillDisclosure),
    skillPlan: { totalCost: plan.totalCost, addedDependencies: plan.addedDependencies,
      skipped: plan.skipped, requiredEvidence: plan.evidence },
    memory: memories,
    retrieval: buildRetrievalQuery(goal, {
      projectPaths, skillNames: skills.map(item => item.name), priorTopics
    }),
    evidenceCount: Array.isArray(evidence) ? evidence.length : 0,
    authority: { modelCanPropose: true, modelCanAuthorize: false, modelCanGrantCapabilities: false, modelCanMutatePolicy: false }
  };
}
