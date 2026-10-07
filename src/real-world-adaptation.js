/**
 * Real-world adaptive task and behavior model.
 *
 * This layer models operational reality around a user's goal without pretending
 * the system can observe the person or environment. Behavioral signals come
 * only from the current request, explicit preferences, authorized state, or
 * observed task outcomes.
 *
 * It answers four questions:
 *   1. What kind of real-world outcome is this?
 *   2. What can change the outcome (time, people, dependencies, resources,
 *      side effects, interruptions)?
 *   3. What should the system do next?
 *   4. What must remain under the person's control?
 */

const text = value => String(value ?? '').trim();
const clamp01 = value => Math.min(1, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0));

const list = value => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => text(
    typeof item === 'string' ? item : item?.id ?? item?.name ?? item?.title ?? ''
  )).filter(Boolean))].slice(0, 40);
};

const OBJECTIVE_WORDS = /\b(?:need to|have to|must|should|want to|plan to|trying to|i'll|i will|we need|we have to|submit|send|call|meet|attend|buy|book|pay|renew|apply|travel|visit|pick up|deliver|install|fix|prepare|schedule|organize|finish|complete)\b/i;
const DECISION_WORDS = /\b(?:choose|decide|decision|which one|should i|should we|compare|trade[- ]?off|prioriti[sz]e|approve|reject)\b/i;
const COORDINATION_WORDS = /\b(?:team|together|with my|with our|client|customer|teacher|student|manager|boss|colleague|family|doctor|lawyer|vendor|supplier|meeting|appointment|handoff|coordinate|schedule with)\b/i;
const MONITOR_WORDS = /\b(?:monitor|watch|track|check whether|let me know|notify me when|keep an eye|follow up|status of)\b/i;
const ROUTINE_WORDS = /\b(?:every day|daily|weekly|monthly|each week|each month|every morning|every evening|routine|habit|regularly|weekday)\b/i;
const TIME_WORDS = /\b(?:today|tonight|tomorrow|morning|afternoon|evening|this week|next week|before|after|by [^.!?]{1,40}|deadline|due|urgent|asap|soon|appointment|meeting)\b/i;
const EXTERNAL_ACTION_WORDS = /\b(?:send|email|message|call|book|buy|pay|transfer|submit|publish|deploy|delete|share|invite|cancel|reschedule|sign|upload|download|post|contact)\b/i;
const PHYSICAL_WORDS = /\b(?:drive|travel|visit|pick up|deliver|repair|install|build|operate|machine|vehicle|tool|hardware|house|home|office|site|equipment|physical)\b/i;

function normalizedRisk(situation = {}) {
  const value = text(situation.risk).toLowerCase();
  if (value === 'crisis' || value === 'high-impact' || value === 'physical') return value;
  if (situation.irreversible || situation.externalSideEffect || situation.peopleDecision) return 'consequential';
  return 'ordinary';
}

function classifyRealWorldIntent(goal, context = {}) {
  const value = text(goal);
  const explicit = text(context.taskIntent || context.realWorldIntent).toLowerCase();
  if (['information', 'action', 'decision', 'coordination', 'monitoring', 'routine', 'planning'].includes(explicit)) return explicit;
  if (ROUTINE_WORDS.test(value)) return 'routine';
  if (MONITOR_WORDS.test(value)) return 'monitoring';
  if (DECISION_WORDS.test(value)) return 'decision';
  if (EXTERNAL_ACTION_WORDS.test(value)) return 'action';
  if (COORDINATION_WORDS.test(value)) return 'coordination';
  if (OBJECTIVE_WORDS.test(value)) return 'action';
  return 'information';
}

function temporalState(context = {}) {
  const dueAt = context.dueAt ?? context.deadline ?? context.timeline?.deadline ?? null;
  const startAt = context.startAt ?? context.timeline?.startAt ?? null;
  const now = context.now ? new Date(context.now) : new Date();
  const parse = value => {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const due = parse(dueAt);
  const start = parse(startAt);
  if (!due) {
    return {
      known: false,
      status: TIME_WORDS.test(text(context.goal ?? '')) ? 'time-mentioned' : 'unscheduled',
      dueAt: null,
      startAt: start?.toISOString() ?? null,
      urgency: TIME_WORDS.test(text(context.goal ?? '')) ? 0.45 : 0
    };
  }
  const ms = due.getTime() - now.getTime();
  const hours = ms / 3_600_000;
  const urgency = ms <= 0 ? 1
    : hours <= 2 ? 0.95
      : hours <= 24 ? 0.8
        : hours <= 72 ? 0.6
          : hours <= 168 ? 0.4 : 0.15;
  return {
    known: true,
    status: ms < 0 ? 'overdue' : ms <= 86_400_000 ? 'due-soon' : 'scheduled',
    dueAt: due.toISOString(),
    startAt: start?.toISOString() ?? null,
    hoursRemaining: Number(hours.toFixed(2)),
    urgency
  };
}

function completionState(context = {}) {
  const current = context.currentState;
  const completed = Array.isArray(context.completedSteps) ? context.completedSteps.length : 0;
  const failed = Array.isArray(context.failedSteps) ? context.failedSteps.length : 0;
  const explicit = text(typeof current === 'string' ? current : current?.status ?? current?.state).toLowerCase();
  if (['complete', 'completed', 'done', 'delivered'].includes(explicit)) return 'complete';
  if (['blocked', 'waiting', 'paused'].includes(explicit)) return explicit === 'paused' ? 'waiting' : 'blocked';
  if (failed > 0) return 'recovery';
  if (completed > 0) return 'in-progress';
  return 'not-started';
}

function observedTaskBehavior(context = {}) {
  const completed = Array.isArray(context.completedSteps) ? context.completedSteps.length : 0;
  const failed = Array.isArray(context.failedSteps) ? context.failedSteps.length : 0;
  const total = completed + failed;
  const completionRatio = total ? completed / total : null;
  const current = text(typeof context.currentState === 'string'
    ? context.currentState
    : context.currentState?.status ?? context.currentState?.state).toLowerCase();
  return {
    completedCount: completed,
    failedCount: failed,
    completionRatio: completionRatio === null ? null : Number(completionRatio.toFixed(3)),
    stalled: ['blocked', 'waiting', 'paused'].includes(current),
    recoveryNeeded: failed > 0,
    source: 'workflow-outcomes',
    notPersonalityInference: true
  };
}

function capacityModel(context = {}) {
  const raw = context.capacity ?? context.user?.capacity ?? {};
  const availability = text(context.availability ?? context.user?.availability).toLowerCase();
  const numeric = Number(raw?.attention ?? raw?.energy ?? raw?.load);
  const load = Number.isFinite(numeric) ? clamp01(numeric)
    : /overloaded|busy|limited|low capacity/i.test(availability) ? 0.8
      : /available|focused|free/i.test(availability) ? 0.2
        : 0.5;
  return {
    attentionLoad: Number(load.toFixed(3)),
    available: Number((1 - load).toFixed(3)),
    source: Number.isFinite(numeric) || availability ? 'explicit' : 'unspecified',
    competingCommitments: list(context.competingCommitments ?? context.busyWith ?? [])
  };
}

function behaviorPreferences(context = {}) {
  const source = context.userBehavior ?? context.behavior ?? context.user?.behavior ?? {};
  const preferences = Array.isArray(context.preferences) ? context.preferences.join(' ') : text(context.preferences);
  const merged = { ...(source && typeof source === 'object' ? source : {}) };

  const readEnum = (name, values, fallback) => {
    const value = text(merged[name] ?? '').toLowerCase();
    return values.includes(value) ? value : fallback;
  };

  return {
    autonomy: readEnum('autonomy', ['assist', 'collaborate', 'act-with-approval'], 'collaborate'),
    pace: readEnum('pace', ['fast', 'balanced', 'deliberate'], /fast|quick|brief/i.test(preferences) ? 'fast' : 'balanced'),
    detail: readEnum('detail', ['minimal', 'normal', 'detailed'], /brief|concise|minimal/i.test(preferences) ? 'minimal' : 'normal'),
    interruption: readEnum('interruption', ['avoid', 'situational', 'welcome'], /do not interrupt|avoid interruptions/i.test(preferences) ? 'avoid' : 'situational'),
    reminders: readEnum('reminders', ['none', 'important-only', 'useful'], /no reminders|do not remind/i.test(preferences) ? 'none' : 'important-only'),
    confirmation: readEnum('confirmation', ['every-external-action', 'consequential-only', 'never-auto-confirm'], 'consequential-only'),
    source: 'explicit-or-task-observed',
    inferredPersonality: false
  };
}

function dependencyModel(context = {}) {
  const dependencies = Array.isArray(context.dependencies)
    ? context.dependencies
    : Array.isArray(context.prerequisites)
      ? context.prerequisites
      : [];
  return dependencies.slice(0, 40).map(item => {
    if (typeof item === 'string') return { id: item, status: 'unknown' };
    return {
      id: text(item?.id ?? item?.name ?? item?.title),
      status: text(item?.status).toLowerCase() || 'unknown',
      blocking: item?.blocking !== false
    };
  }).filter(item => item.id);
}

function requiredRealWorldControls({ intent, temporal, risk, externalAction, physical, coordination }) {
  const controls = new Set();
  if (temporal.status === 'overdue' || temporal.urgency >= 0.8) controls.add('deadline-awareness');
  if (externalAction) controls.add('external-action-boundary');
  if (physical || risk === 'physical') controls.add('physical-world-caution');
  if (coordination) controls.add('actor-and-commitment-tracking');
  if (intent === 'decision' || risk === 'consequential' || risk === 'high-impact') controls.add('decision-support-not-decision-substitution');
  controls.add('evidence-before-claiming-outcome');
  return [...controls];
}

export function buildRealWorldTaskModel(goal, context = {}) {
  const value = text(goal);
  const c = context && typeof context === 'object' ? context : {};
  const intent = classifyRealWorldIntent(value, { ...c, goal: value });
  const risk = normalizedRisk(c.situation ?? c);
  const temporal = temporalState({ ...c, goal: value });
  const completion = completionState(c);
  const observedBehavior = observedTaskBehavior(c);
  const capacity = capacityModel(c);
  const dependencies = dependencyModel(c);
  const externalAction = EXTERNAL_ACTION_WORDS.test(value)
    || c.externalSideEffect === true
    || c.execution?.external === true;
  const physical = PHYSICAL_WORDS.test(value) || c.physical === true;
  const coordination = intent === 'coordination' || COORDINATION_WORDS.test(value);
  const commitments = list(c.commitments ?? c.promises ?? c.agendaItems);
  const resources = list(c.resources ?? c.availableResources);
  const blockedDependencies = dependencies.filter(item => item.blocking !== false && !['ready', 'complete', 'done', 'satisfied'].includes(item.status));

  const interruptionRisk = temporal.urgency >= 0.8 || externalAction || physical ? 0.65 : 0.25;
  const actionability = intent === 'action' || intent === 'coordination' || intent === 'routine' ? 0.85
    : intent === 'decision' ? 0.65 : 0.35;

  let next = 'answer-or-plan';
  if (completion === 'complete') next = 'deliver-and-stop';
  else if (blockedDependencies.length) next = 'resolve-blocking-dependency';
  else if (completion === 'recovery') next = 'diagnose-before-retry';
  else if (temporal.status === 'overdue') next = 'surface-deadline-and-replan';
  else if (externalAction) next = 'prepare-then-request-approval';
  else if (intent === 'monitoring') next = 'establish-observation-and-check-in';
  else if (intent === 'coordination') next = 'prepare-commitments-and-coordination';
  else if (intent === 'decision') next = 'present-options-and-consequences';
  else if (intent === 'routine') next = 'convert-to-repeatable-routine';
  else if (capacity.attentionLoad >= 0.8 && actionability >= 0.65 && temporal.urgency < 0.8) next = 'reduce-to-smallest-next-action';
  else if (actionability >= 0.8) next = 'prepare-concrete-next-action';
  else if (completion === 'in-progress') next = 'resume-from-current-state';

  const controls = requiredRealWorldControls({
    intent, temporal, risk, externalAction, physical, coordination
  });

  return {
    version: 1,
    realWorld: true,
    intent,
    state: completion,
    risk,
    temporal,
    dependencies,
    blockedDependencies,
    commitments,
    resources,
    competingCommitments: capacity.competingCommitments,
    signals: {
      externalAction,
      physical,
      coordination,
      timeSensitive: temporal.known || temporal.status === 'time-mentioned',
      interruptionRisk,
      actionability
    },
    userBehavior: behaviorPreferences(c),
    observedBehavior,
    capacity,
    nextAction: next,
    controls,
    observability: {
      explicitOnly: true,
      mayInferPrivateBehavior: false,
      mayClaimPresenceOrCompletionWithoutEvidence: false,
      acceptableEvidence: ['user-reported outcome', 'authorized tool result', 'observed workflow result', 'verified artifact']
    },
    commitmentPolicy: {
      preserveExplicitCommitments: true,
      doNotInventCommitments: true,
      surfaceConflictsBeforeCommitment: true,
      distinguishIntentionFromCompletion: true
    },
    stopPolicy: {
      stopWhenOutcomeVerified: true,
      doNotCreateRecurringFollowUpWithoutUserIntent: true,
      doNotActExternallyWithoutRequiredAuthority: true
    }
  };
}

export function realWorldExecutionPolicy(model = {}) {
  const m = model && typeof model === 'object' ? model : {};
  const temporal = m.temporal ?? {};
  const behavior = m.userBehavior ?? {};
  const controls = Array.isArray(m.controls) ? m.controls : [];
  const next = text(m.nextAction) || 'answer-or-plan';

  return {
    mode: m.realWorld ? 'operational-adaptive' : 'conversation-adaptive',
    nextAction: next,
    urgency: Number(temporal.urgency) || 0,
    dueState: text(temporal.status) || 'unscheduled',
    autonomy: text(behavior.autonomy) || 'collaborate',
    pace: text(behavior.pace) || 'balanced',
    interruption: text(behavior.interruption) || 'situational',
    attentionLoad: Number(m.capacity?.attentionLoad) || 0,
    observedCompletionRatio: m.observedBehavior?.completionRatio ?? null,
    reminderPolicy: text(behavior.reminders) || 'important-only',
    externalAction: controls.includes('external-action-boundary') ? 'approval-or-existing-authority' : 'none',
    coordination: controls.includes('actor-and-commitment-tracking') ? 'track-actors-and-commitments' : 'none',
    verification: 'verify-real-world-outcome-before-claiming-complete',
    privacy: 'explicit-and-authorized-signals-only'
  };
}
