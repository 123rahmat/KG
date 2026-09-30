/**
 * How a stored run is read back: the public run shape, list summaries,
 * paging cursors, and the normalized understanding a model returned.
 */

import { nextTask } from './core.js';
import { RunError } from './run-error.js';
import { adaptiveBudgetStatus } from './adaptive-control.js';
import { planBrief } from './plan-brief.js';
import { gradedCriteria } from './requirements.js';

const text = value => String(value ?? '').trim();

export const isEmpty = value =>
  value === null
  || value === undefined
  || (typeof value === 'string' && !value.trim())
  || (Array.isArray(value) && value.length === 0)
  || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

export function present(run, tasks) {
  const view = {
    id: run.id,
    workspaceId: run.workspace_id,
    principalId: run.principal_id,
    goal: run.goal,
    surface: run.surface,
    state: run.state,
    // Runs created before the direct workflow existed all used the full one.
    workflow: run.adaptation?.workflow ?? 'full',
    visibility: run.visibility ?? 'private',
    conversationId: run.conversation_id ?? null,
    intent: run.intent,
    capabilities: run.capabilities,
    governance: run.governance,
    adaptation: run.adaptation ?? {},
    situation: run.situation ?? {},
    requirements: run.adaptation?.workflow === 'direct'
      ? { version: 1, items: [], overallProgress: 100, completedCount: 0, requiredCount: 0, unresolvedCount: 0, blockedCount: 0, completionReady: true, nextRequirementId: null }
      : (run.requirements ?? { version: 1, items: [], overallProgress: 0, completionReady: false }),
    privacy: run.adaptation?.privacy ?? null,
    attempt: run.attempt,
    maxAttempts: run.max_attempts,
    tokensUsed: Number(run.tokens_used),
    maxTokens: run.max_tokens === null ? null : Number(run.max_tokens),
    tasks,
    next: nextTask(tasks)?.id ?? null,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    completedAt: run.completed_at,
    adaptiveBudget: adaptiveBudgetStatus(tasks, run.adaptation?.resourcePlan ?? {}),
    // What the check must cover, as the server grades it.
    verificationCriteria: gradedCriteria(run.requirements, run.situation)
  };
  return { ...view, brief: planBrief(view) };
}

export const summarize = row => ({
  id: row.id,
  goal: row.goal,
  surface: row.surface,
  state: row.state,
  visibility: row.visibility ?? 'private',
  conversationId: row.conversation_id ?? null,
  intent: row.intent,
  attempt: row.attempt,
  maxAttempts: row.max_attempts,
  tokensUsed: Number(row.tokens_used),
  maxTokens: row.max_tokens === null ? null : Number(row.max_tokens),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at
});

// The cursor carries PostgreSQL's full microsecond timestamp. A JS Date
// would truncate to milliseconds and skip rows created in the same one.
export const encodeCursor = row =>
  Buffer.from(JSON.stringify({ c: row.cursor_at, i: row.id })).toString('base64url');

export function decodeCursor(cursor) {
  if (!text(cursor)) return null;
  let decoded = null;
  try {
    decoded = JSON.parse(Buffer.from(text(cursor), 'base64url').toString('utf8'));
  } catch {}
  const { c, i } = decoded && typeof decoded === 'object' ? decoded : {};
  // The cursor is client input; a malformed one is the caller's error, and
  // must never reach the database as an unparseable timestamp.
  if (typeof c !== 'string' || typeof i !== 'string' || !i || Number.isNaN(Date.parse(c))) {
    throw new RunError('Invalid pagination cursor', { status: 400, code: 'invalid-cursor' });
  }
  return { createdAt: c, id: i };
}


export function normalizeUnderstanding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const strings = key => Array.isArray(value[key])
    ? [...new Set(value[key].map(text).filter(Boolean))].slice(0, 32)
    : [];
  return {
    needsInvestigation: value.needsInvestigation === true,
    needsCapabilityDiscovery: value.needsCapabilityDiscovery === true,
    unknownSituation: value.unknownSituation === true,
    physical: value.physical === true,
    highImpact: value.highImpact === true,
    dataClasses: strings('dataClasses'),
    successCriteria: strings('successCriteria'),
    constraints: strings('constraints'),
    inputs: strings('inputs'),
    outputs: strings('outputs'),
    unknowns: strings('unknowns'),
    requiredEvidence: strings('requiredEvidence'),
    questions: strings('questions'),
    reasoningNotes: strings('reasoningNotes'),
    candidateCapabilities: Array.isArray(value.candidateCapabilities)
      ? value.candidateCapabilities.slice(0, 24)
      : []
  };
}
