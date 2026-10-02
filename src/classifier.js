/**
 * Model-assisted goal classification.
 *
 * Keyword rules read words, not meaning: "transformer" looks like a request
 * to transform, "figure out why my bread won't rise" looks like an unknown
 * domain. When a model is configured and the person has consented to send
 * their goal to it, the model classifies the goal into the same small
 * vocabulary the keyword rules produce, so the planner is unchanged.
 *
 * The model's answer is untrusted input. It is validated field by field, and
 * anything malformed falls back to the keyword rules. It may raise risk
 * (physical, high impact, a crisis) but never lower what the keyword rules
 * detected.
 */

import { callModel } from './runtime.js';
import { parseJsonObject } from './structured.js';
import { policyPromptLines, normalizePolicyHint, blockedTopicsFrom } from './safety.js';

export const CLASSIFIER_ACTIONS = Object.freeze([
  'answer', 'investigate', 'create', 'transform', 'execute', 'model', 'invent', 'discover'
]);
export const CLASSIFIER_SIGNALS = Object.freeze([
  'research', 'file', 'code', 'creation', 'invention', 'uncertainty', 'physical', 'highImpact'
]);
// A crisis the model reads, in any language, that keyword rules cannot.
const CRISIS_KINDS = ['self-harm', 'emergency'];
// The shape of what the person wants back.
export const NEED_FORMS = Object.freeze(['fact', 'number', 'yes-no', 'steps', 'explanation', 'code', 'comparison', 'recommendation', 'plan', 'document', 'design', 'conversation']);
export const NEED_DEPTHS = Object.freeze(['brief', 'standard', 'thorough']);

/**
 * The person's exact need: the thing they want back, in what form and how
 * deep, and what a generic answer would add that they did not ask for.
 * Optional; anything malformed is dropped rather than guessed.
 */
export function normalizeNeed(value) {
  if (!value || typeof value !== 'object') return null;
  const deliverable = text(value.deliverable).replace(/\s+/g, ' ').slice(0, 200);
  if (!deliverable) return null;
  const exclude = Array.isArray(value.exclude) ? value.exclude.map(item => text(item).replace(/\s+/g, ' ').slice(0, 120)).filter(Boolean).slice(0, 6) : [];
  return {
    deliverable,
    ...(NEED_FORMS.includes(text(value.form)) ? { form: text(value.form) } : {}),
    ...(NEED_DEPTHS.includes(text(value.depth)) ? { depth: text(value.depth) } : {}),
    ...(exclude.length ? { exclude } : {})
  };
}
export const CLASSIFIER_TIMEOUT_MS = 20_000;

const promptFor = blockedTopics => [
  'Classify the goal below for a workflow planner. Reply with one JSON object and nothing else.',
  'Fields:',
  `- "actions": array, subset of ${JSON.stringify(CLASSIFIER_ACTIONS)}. What the person asks to have done.`,
  '  answer = explain or respond; investigate = research or gather evidence the person did not give and the work cannot be',
  '  done well without (current facts, prices, sources to cite), never when they supplied what is needed; create = build or write something new;',
  '  transform = change something existing; execute = run, test or deploy (a request to simulate something is code to write',
  '  and run); model = work out what happens over time or under what-if conditions, by reasoning or calculation;',
  '  invent = a genuinely novel mechanism; discover = the person does not yet know what is needed.',
  `- "signals": object with boolean fields ${JSON.stringify(CLASSIFIER_SIGNALS)}.`,
  '  code = software is involved (websites and apps included; a simulation, netlist or model script to write or run is code);',
  '  research = the same test as investigate; file = files, folders or zip archives the person gives or points to, not a file they want made;',
  '  physical = affects machines, hardware or the physical world; highImpact = medical, legal, financial, safety or hazardous.',
  '- "unknownSituation": boolean. True only if the goal itself is too unfamiliar or vague to plan without discovery.',
  '- "confidence": number from 0 to 1.',
  '- "crisis": "none", "self-harm" (the person may harm themselves or is in despair) or "emergency" (a medical or physical emergency',
  '  happening now to a person or an animal: poisoning, overdose, severe bleeding, trouble breathing, a very sick child, fire, gas).',
  '  Read it in any language and however it is phrased; when unsure between "none" and a crisis, choose the crisis.',
  '- "need": the person\'s exact need, so the answer gives that and nothing extra: {"deliverable": what they want back, in a few',
  `  words ("the monthly repayment", "a fixed version of their function", "whether it is safe to…"), "form": one of ${JSON.stringify(NEED_FORMS)},`,
  `  "depth": one of ${JSON.stringify(NEED_DEPTHS)} (how much they asked for, from their wording and context), "exclude": [what a generic`,
  '  answer would add that they did not ask for, e.g. "history of the topic", "alternatives", "installation steps"]}.',
  ...policyPromptLines(blockedTopics),
  'When earlierTurns are present the goal continues that chat: classify what the latest message asks in that context',
  '("now try it with thicker walls" after a calculation or program is a request to redo it with the change).',
  'Judge by meaning, not by individual words.'
].join('\n');

const text = value => String(value ?? '').trim();

/** Validate untrusted model output into classifier hints, or return null. */
export function normalizeClassification(value, { blockedTopics = [] } = {}) {
  if (!value || typeof value !== 'object') return null;
  if (!Array.isArray(value.actions) || !value.signals || typeof value.signals !== 'object') return null;
  const actions = [...new Set(value.actions.map(text))];
  if (actions.some(action => !CLASSIFIER_ACTIONS.includes(action))) return null;
  const signals = {};
  for (const name of CLASSIFIER_SIGNALS) {
    if (typeof value.signals[name] !== 'boolean') return null;
    signals[name] = value.signals[name];
  }
  if (typeof value.unknownSituation !== 'boolean') return null;
  const confidence = Number(value.confidence);
  const policy = normalizePolicyHint(value.policy, { blockedTopics });
  // Optional: an older or partial reply without it still classifies.
  const crisis = CRISIS_KINDS.includes(text(value.crisis)) ? text(value.crisis) : null;
  const need = normalizeNeed(value.need);
  return {
    actions,
    signals,
    ...(crisis ? { crisis } : {}),
    ...(need ? { need } : {}),
    unknownSituation: value.unknownSituation,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    ...(policy ? { policy } : {})
  };
}

/**
 * Classify with the configured model when that is allowed. Returns
 * { hints, source, ... } where hints is null whenever the keyword rules
 * should be used; the reason says why.
 */
export async function classifyGoal(goal, { config, fetchImpl, allowed, conversation = [], modelId = null, usageGate = null }) {
  const value = text(goal);
  if (!value) return { hints: null, source: 'keywords', reason: 'empty-goal' };
  if (!config.ai) return { hints: null, source: 'keywords', reason: 'no-model-configured' };
  if (!allowed) return { hints: null, source: 'keywords', reason: 'model-processing-not-permitted' };

  let answer;
  try {
    answer = await callModel([
      { role: 'system', content: promptFor(blockedTopicsFrom(config)) },
      { role: 'user', content: JSON.stringify({
        goal: value,
        ...(conversation.length ? { earlierTurns: conversation.slice(-3).map(turn => ({ user: text(turn.user).slice(0, 400), assistant: text(turn.assistant).slice(0, 400) })) } : {})
      }) }
    ], {
      config,
      fetchImpl,
      timeoutMs: CLASSIFIER_TIMEOUT_MS,
      retries: 0,
      modelId,
      effort: 'low',
      json: true,
      usageGate,
      usageSource: 'classifier'
    });
  } catch {
    return { hints: null, source: 'keywords', reason: 'model-unavailable' };
  }
  if (!answer || answer.incomplete) {
    return { hints: null, source: 'keywords', reason: 'model-incomplete', usage: answer?.usage ?? null };
  }
  const hints = normalizeClassification(parseJsonObject(answer.text), { blockedTopics: blockedTopicsFrom(config) });
  if (!hints) return { hints: null, source: 'keywords', reason: 'model-output-invalid', usage: answer.usage ?? null };
  return { hints, source: 'model', provider: answer.provider, model: answer.model, usage: answer.usage ?? null };
}
