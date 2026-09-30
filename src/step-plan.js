/**
 * Progressive adaptive-step contracts.
 *
 * There is no static plan here. The model may propose one next work item;
 * the server validates it and adds it only after the current item completes.
 * The UI can still render the steps that have actually been created.
 */

import { clip } from './reasoning-context.js';

const MAX_NEXT_STEP = 1;

const text = value => (typeof value === 'string' ? value.trim() : '');

/** Validate a proposed list of steps. */
function normalizeSteps(value, max = MAX_NEXT_STEP) {
  return (Array.isArray(value) ? value : [])
    .filter(item => item && typeof item === 'object' && text(item.purpose))
    .slice(0, max)
    .map(item => ({
      title: clip(text(item.title) || text(item.purpose), 80).replace(/…$/, ''),
      purpose: clip(text(item.purpose), 400)
    }));
}

export function normalizeNextStep(value) {
  if (!value || typeof value !== 'object') return null;
  const raw = value.next && typeof value.next === 'object'
    ? value.next
    : Array.isArray(value.revise) && value.revise.length
      ? value.revise[0]
      : null;
  if (!raw || !text(raw.purpose)) return null;
  const step = normalizeSteps([raw], 1)[0];
  if (!step) return null;
  return {
    ...step,
    ...(text(raw.type) ? { type: text(raw.type) } : {}),
    ...(text(raw.kind) ? { kind: text(raw.kind) } : {}),
    ...(text(raw.capability) ? { capability: text(raw.capability) } : {}),
    ...(Array.isArray(raw.requirementIds)
      ? { requirementIds: [...new Set(raw.requirementIds.map(text).filter(Boolean))].slice(0, 20) }
      : {}),
    ...(Array.isArray(raw.requires) ? { requires: raw.requires.filter(text) } : {}),
    ...(raw.approvalRequired === true ? { approvalRequired: true } : {}),
    ...(raw.humanInput === true ? { humanInput: true } : {}),
    ...(raw.execution === true ? { execution: true } : {})
  };
}

/** What each step is shown: the whole plan and where it stands. */
export function workPlan(tasks, currentId) {
  const steps = tasks.filter(task => task.type === 'step');
  if (!steps.length) return null;
  return {
    current: currentId,
    steps: steps.map(task => ({
      id: task.id,
      title: task.metadata?.title ?? task.purpose,
      purpose: task.purpose,
      status: task.status,
      ...(task.status === 'complete' && task.summary ? { result: clip(task.summary, 300) } : {}),
      ...(task.status === 'skipped' && task.summary ? { skipped: task.summary } : {})
    }))
  };
}

/**
 * A step's own answer: plain text, or { result, enough, next } when it
 * judges whether one more step is justified.
 */
export function readStepAnswer(raw) {
  const value = String(raw ?? '');
  let parsed = null;
  try { parsed = JSON.parse(value.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { /* plain text */ }
  // Plain text judged nothing: the step did its part and named no next one.
  if (!parsed || typeof parsed !== 'object' || typeof parsed.result !== 'string') return { text: value, enough: false, revise: null, judged: false };
  const next = normalizeNextStep(parsed);
  return {
    text: parsed.result,
    enough: parsed.enough === true,
    ...(next ? { next } : {}),
    revise: Array.isArray(parsed.revise) ? normalizeSteps(parsed.revise) : null
  };
}
