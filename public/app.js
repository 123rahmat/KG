/**
 * Kindgleam — browser client.
 *
 * Authenticates by exchanging an access key for an httpOnly session cookie, so
 * no credential is ever readable from script or left in browser storage.
 * Every mutation carries the client header the server requires alongside the
 * SameSite cookie.
 *
 * The client renders state; it never decides it. Task status comes from the
 * server on every response, because the server owns the workflow. The page
 * shows one thing at a time: where the work stands, and the single action
 * the next step needs, in plain words.
 */

import { state, $, element, button, api, notify, clearNotice, guard, canEdit, aiConnected, configuredTargets, updateConnectionUI, waitForConnection } from './ui-core.js';
import { addAttachments, flushOfflineQueue, growComposer, loadRuns, newChat, renderChatList, renderRun, renderThread, sendMessage, stopRun } from './app-attachments.js';
import { initSettings, saveDraftSoon, adoptLegacy } from './app-settings.js';
import { applyRole, enterApp, initAccount, initGate, loadAudit, loadObjects, loadUsage, registerAppWorker, selectTab, showGate, signIn, signOut, takeSignInToken, uploadObject } from './app-account.js';
import { codeMarkdown, hasCode, initActions } from './app-actions.js';
import { renderMarkdown } from './markdown.js';
import { initSettingsWindow } from './app-settings-window.js';
import { initWorkspaceSources } from './workspace-sources.js';
import { initTerminal } from './terminal.js';

initSettings();
initWorkspaceSources();
initTerminal();


/* --------------------------------------------------------------- transport */


/* ------------------------------------------------------------------- notices */




/* -------------------------------------------------------------------- render */


export const bytes = value => {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = Number(value) || 0;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size < 10 && unit > 0 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
};

export const formatWhen = value => (value ? new Date(value).toLocaleString() : '—');

/** A line icon from the sprite in index.html. */
export function svgIcon(name, className = 'i') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}


export function timeAgo(value) {
  if (!value) return '';
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(value).toLocaleDateString();
}

export function browserAdaptationContext() {
  const preferences = [];
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) preferences.push('reduced-motion');
    if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) preferences.push('dark-mode');
  } catch {}
  return {
    language: navigator.language || '',
    preferences,
    accessibility: { reducedMotion: preferences.includes('reduced-motion') }
  };
}

/* ------------------------------------------------------------ plain language */

const LABEL_BY_ID = {
  'build-code': 'Write the code',
  'test-code': 'Run and test the code',
  'investigation-work': 'Research',
  'artifact-work': 'Look through your files',
  'adaptive-tool': 'Use a specialised tool',
  investigate: 'Work out what is unknown'
};

const LABEL_BY_TYPE = {
  understand: 'Understand your goal',
  clarify: 'Answer a question',
  discover: 'Work out what is unknown',
  'discover-capabilities': 'Choose the right tools',
  adapt: 'Fit the approach to you',
  plan: 'Make a plan',
  approval: 'Your approval',
  code: 'Code',
  prototype: 'Draft the result',
  tool: 'Use a tool',
  investigate: 'Research',
  respond: 'Write the answer',
  observe: 'Collect the results',
  reassess: 'Review progress',
  verify: 'Check the result',
  deliver: 'Deliver the result',
  iterate: 'Finish or improve'
};

const WHAT_HAPPENS = {
  understand: 'The goal, its limits and what a good result looks like are worked out.',
  discover: 'What is already known is separated from what still has to be found out.',
  'discover-capabilities': 'The skills, tools and information this work needs are chosen.',
  adapt: 'The approach is fitted to your situation.',
  plan: 'A step-by-step plan is made, and the checks for success are fixed.',
  respond: 'The answer is written.',
  prototype: 'A first version of the result is drafted.',
  reassess: 'Progress so far is reviewed. The plan can change if something new was learned.',
  deliver: 'The final result is put together with its limits and next steps.',
  observe: 'What the earlier steps actually produced is collected.',
  code: 'The code is written as a small, reviewable piece.',
  step: 'One part of the work planned for your need is done, building on the parts before it.'
};

// A planned step is named by the plan; everything else by its kind.
const taskLabel = task => (task ? ((task.type === 'step' || task.metadata?.buildPlan || task.metadata?.planAgreement) && task.metadata?.title) || LABEL_BY_ID[task.id] || LABEL_BY_TYPE[task.type] || task.id : '');

export const TERMINAL_STATES = ['complete', 'failed', 'blocked', 'exhausted'];
// Planning steps a person can simply confirm; result steps need real content.
const CONFIRMABLE_TASKS = ['understand', 'discover', 'discover-capabilities', 'adapt', 'plan', 'reassess', 'deliver'];

const nextTaskOf = run => run?.tasks?.find(item => item.id === run.next) ?? null;

export function runStatus(run) {
  if (run.state === 'complete') return ['Completed', 'ok'];
  if (run.state === 'failed') return ['Stopped', 'bad'];
  if (run.state === 'exhausted') return ['Out of attempts', 'bad'];
  if (run.state === 'blocked') return ['Not allowed by policy', 'bad'];
  if (run.state === 'waiting') return ['Waiting for the next requirement action', 'warn'];
  // List entries carry no steps; their state already names the next step.
  if (run.state === 'iterate') {
    if (!Array.isArray(run.tasks)) return ['Waiting for you', 'warn'];
    return run.tasks.some(task => task.status === 'failed') ? ['Needs your decision', 'warn'] : ['Result ready', 'ok'];
  }
  const type = nextTaskOf(run)?.type ?? run.state;
  if (type === 'clarify') return ['Needs your answer', 'warn'];
  if (type === 'approval') return ['Needs your approval', 'warn'];
  if (type === 'verify') return ['Ready to check', 'warn'];
  return ['In progress', ''];
}

/* ------------------------------------------------------------ execution env */

export async function loadExecutionConfig() {
  state.executionConfig = await api('GET', '/api/execution/config', undefined, { workspace: false });
  return state.executionConfig;
}

function browserPreflight() {
  let gpu = { available: false, name: '', vendor: '', memoryBytes: null };
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (gl) {
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = {
        available: true,
        name: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'WebGL-capable GPU',
        vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : '',
        memoryBytes: null
      };
    }
  } catch {}

  return {
    version: '1',
    source: 'browser',
    platform: navigator.platform || '',
    architecture: '',
    cpuCores: Number.isFinite(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : null,
    // deviceMemory is intentionally coarse and may be unavailable. The local
    // agent, when paired, supplies exact host memory.
    memoryBytes: Number.isFinite(navigator.deviceMemory) ? navigator.deviceMemory * 1024 ** 3 : null,
    availableMemoryBytes: null,
    storageBytes: null,
    availableStorageBytes: null,
    gpu,
    agent: { available: false, version: '' },
    checkedAt: new Date().toISOString()
  };
}

async function getLocalPreflight(force = false) {
  if (!force && state.localPreflight) return state.localPreflight;
  if (state.localPreflightPromise) return state.localPreflightPromise;

  state.localPreflightPromise = (async () => {
    const browser = browserPreflight();
    if (navigator.storage?.estimate) {
      try {
        const storage = await navigator.storage.estimate();
        browser.storageBytes = Number.isFinite(storage.quota) ? storage.quota : null;
        browser.availableStorageBytes = Number.isFinite(storage.quota) && Number.isFinite(storage.usage)
          ? Math.max(storage.quota - storage.usage, 0)
          : null;
      } catch {}
    }

    const agentUrl = state.executionConfig?.localAgentUrl;
    if (agentUrl) {
      try {
        const response = await fetch(agentUrl.replace(/\/$/, '') + '/v1/preflight', {
          method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store'
        });
        if (response.ok) {
          const agent = await response.json();
          state.localPreflight = {
            ...browser,
            ...agent,
            source: 'local-agent',
            agent: { available: true, version: String(agent.agent?.version ?? '') }
          };
          return state.localPreflight;
        }
      } catch {}
    }

    state.localPreflight = browser;
    return state.localPreflight;
  })().finally(() => {
    state.localPreflightPromise = null;
  });

  return state.localPreflightPromise;
}

async function executeLocalAgent(request) {
  const agentUrl = state.executionConfig?.localAgentUrl;
  if (!agentUrl) throw new Error('No local agent is configured for this deployment.');

  const response = await fetch(agentUrl.replace(/\/$/, '') + '/v1/execute', {
    method: 'POST',
    mode: 'cors',
    credentials: 'omit',
    headers: { 'content-type': 'application/json', 'x-general-ai-local-agent': 'web' },
    body: JSON.stringify(request)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Local agent rejected the task (${response.status})`);
  }
  return payload;
}


/* -------------------------------------------------------------- run actions */

/** Record a person's step result and show the updated run. */
async function advance(body, targetRun = state.run) {
  const run = targetRun;
  if (!run) return;
  let updated = null;
  await guard(async () => {
    updated = await api('POST', `/api/runs/${run.id}/advance`, body);
    renderRun(updated);
    loadRuns().catch(() => {});
  }, 'runNotice');
  if (updated) await autoDrive(updated);
}

// A busy or rate-limited model is usually back within a minute: automatic
// steps try again on their own (twice at most), after the wait Gemini asked for.
const TRANSIENT_MODEL_ERRORS = new Set(['model-rate-limited', 'model-unavailable']);
const MAX_AUTO_RETRIES = 2;
const autoRetries = new Map();

function scheduleRetry(runId, outcome) {
  if (!TRANSIENT_MODEL_ERRORS.has(outcome?.code)) return 0;
  const tries = autoRetries.get(runId) ?? 0;
  if (tries >= MAX_AUTO_RETRIES) return 0;
  autoRetries.set(runId, tries + 1);
  const seconds = Math.min(90, Math.max(10, Number(outcome.retryAfterSeconds) || 20));
  setTimeout(() => {
    const current = state.chat?.runs?.find(item => item.id === runId);
    if (current && !state.busyRuns?.has(runId) && !state.drivingRuns?.has(runId)) autoDrive(current);
  }, seconds * 1000);
  return seconds;
}

/** Run one step with the person's explicit input, then carry on on its own. */
async function stepThenContinue(buttonNode, extra, targetRun = state.run) {
  const updated = await runStep(buttonNode, extra, targetRun);
  await autoDrive(updated ?? targetRun);
}

/**
 * Poll a background job until it finishes, showing elapsed time. The job
 * runs on the server whatever happens here, so a lost connection only
 * pauses the watching: it resumes when the server answers again.
 */
async function waitForJob(runId, jobId, button) {
  const started = Date.now();
  for (let polls = 0; ; polls += 1) {
    let job;
    try {
      ({ job } = await api('GET', `/api/runs/${runId}/jobs/${jobId}`));
    } catch (error) {
      if (error.code === 'offline' || error.transient) {
        if (button) button.textContent = 'Waiting for connection…';
        state.drivingLabel = 'Reconnecting — your step keeps running on the server';
        renderThread();
        await waitForConnection();
        continue;
      }
      throw error;
    }
    if (!['queued', 'running'].includes(job.state)) return job;
    const seconds = Math.round((Date.now() - started) / 1000);
    if (button) button.textContent = `Processing… ${seconds}s`;
    if (Date.now() - started > 30 * 60_000) throw new Error('This is still running. Come back later to see the result.');
    // Quick at first, when most steps finish; gentler on long ones.
    await new Promise(resolve => setTimeout(resolve, seconds < 20 ? 1000 : seconds < 120 ? 2000 : 4000));
  }
}

function explainNotExecuted(execution, task, targetRun = state.run) {
  if (execution?.status === 'consent-required') {
    if (targetRun?.id) state.consentNeeded.add(targetRun.id);
    return null;
  }
  const message = execution?.message ?? execution?.status ?? 'Nothing was done.';
  if (execution?.status === 'not-configured' && ['investigate', 'tool'].includes(task?.type)) {
    return message + ' You can add your own findings instead.';
  }
  return message;
}

async function runStep(button, extra = {}, targetRun = state.run) {
  const run = targetRun;
  const task = nextTaskOf(run);
  if (!run || !task) return run;
  state.busyRuns ??= new Set();
  if (state.busyRuns.has(run.id)) return run;
  state.busyRuns.add(run.id);
  const visibleRun = !state.chat?.id || state.chat.id === run.conversationId;
  if (visibleRun) state.driving = run.id;
  const original = button?.textContent;
  if (button) { button.disabled = true; button.textContent = 'Processing…'; }
  let updatedRun = run;
  try {
    await guard(async () => {
      state.network.interruptedRunId = null;
      if (extra.modelConsent) {
        state.consented.add(run.id);
        state.consentNeeded.delete(run.id);
      }
      const body = { ...extra, taskId: task.id, ...(state.consented.has(run.id) ? { modelConsent: true } : {}) };
      const queued = body.executionTarget === 'local'
        ? null
        : await api('POST', '/api/runs/' + run.id + '/execute', { ...body, background: true }, { idempotencyKey: crypto.randomUUID() })
          .catch(error => {
            if (error.code === 'jobs-unavailable') return null;
            if (error.code === 'job-already-active' && error.payload?.job?.id) return { job: error.payload.job };
            throw error;
          });
      if (queued) {
        const job = await waitForJob(run.id, queued.job.id, button);
        const outcome = job.outcome ?? {};
        if (outcome.execution?.status === 'consent-required') state.consentNeeded.add(run.id);
        updatedRun = await api('GET', '/api/runs/' + run.id);
        renderRun(updatedRun);
        await loadRuns();
        if (job.state !== 'succeeded' || outcome.execution?.executed === false) {
          const message = outcome.error ?? explainNotExecuted(outcome.execution, task, run);
          const retry = !button && scheduleRetry(run.id, outcome);
          if (message) notify('runNotice', 'warn', retry ? message + ' Trying again in ' + retry + 's…' : message);
        }
        return;
      }
      const first = await api('POST', '/api/runs/' + run.id + '/execute', body, { timeoutMs: 10 * 60_000 });
      if (first.execution?.status === 'local-agent-required') {
        const local = await executeLocalAgent(first.execution.request);
        const receipt = local.receipt ?? {
          executed: local.executed === true,
          status: local.status ?? 'completed',
          result: local.result ?? local.output ?? null,
          executionTarget: 'local'
        };
        if (receipt.executed !== true) {
          notify('runNotice', 'warn', local.message ?? 'The local agent did not report a finished run.');
          return;
        }
        const result = await api('POST', '/api/runs/' + run.id + '/execution-result', {
          taskId: task.id, executionTarget: 'local', receipt, evidence: { source: 'local-agent', receipt }
        });
        updatedRun = result.run;
        renderRun(updatedRun);
        await loadRuns();
        return;
      }
      updatedRun = first.run;
      renderRun(updatedRun);
      if (!first.execution?.executed) {
        const message = explainNotExecuted(first.execution, task, run);
        if (message) notify('runNotice', 'warn', message);
      }
      await loadRuns();
    }, 'runNotice', error => {
      if (error.code !== 'offline' && !error.transient) return null;
      state.network.interruptedRunId = run.id;
      return 'Connection lost. This continues on its own as soon as you are back online.';
    });
  } finally {
    state.busyRuns.delete(run.id);
    if (state.driving === run.id) state.driving = null;
    if (button?.isConnected) { button.disabled = false; button.textContent = original; }
    loadUsage();
  }
  return updatedRun;
}

/* --------------------------------------------------------- next-step cards */

export const heading = (title, text) => [
  element('h2', { text: title }),
  text ? element('p', { class: 'muted', text }) : null
];

export function field(labelText, control) {
  return element('label', {}, [element('span', { text: labelText }), control]);
}

function textArea(placeholder, rows = 4) {
  return element('textarea', { rows: String(rows), placeholder });
}


/** A person writes this step themselves (no AI, or by choice). */
function manualStepForm(task) {
  const confirmable = CONFIRMABLE_TASKS.includes(task.type);
  if (task.id === 'build-code') {
    const language = element('input', { placeholder: 'e.g. python' });
    const source = element('textarea', { rows: '10', class: 'mono', spellcheck: 'false', placeholder: 'Paste or write the code here' });
    return element('div', { class: 'stack' }, [
      field('Language', language),
      field('Code', source),
      button('Save code and continue', () => {
        if (!language.value.trim() || !source.value.trim()) return notify('runNotice', 'warn', 'Add the language and the code.');
        advance({
          taskId: task.id,
          summary: `Code written by a person (${language.value.trim()}).`,
          evidence: { humanProvided: true, structured: { language: language.value.trim(), source: source.value, notes: 'written by a person' } }
        });
      }, 'primary')
    ]);
  }
  const input = textArea(
    task.type === 'respond' ? 'Write the answer…'
      : task.type === 'prototype' ? 'Write the draft…'
        : 'Notes (optional)',
    ['respond', 'prototype'].includes(task.type) ? 8 : 3
  );
  return element('div', { class: 'stack' }, [
    field(confirmable ? 'Anything to add? (optional)' : 'Your version', input),
    button(confirmable ? 'Confirm and continue' : 'Save and continue', () => {
      const text = input.value.trim();
      if (!confirmable && !text) return notify('runNotice', 'warn', 'Write the result first.');
      const body = { taskId: task.id, summary: (text || 'Reviewed by a person.').slice(0, 500) };
      if (task.type === 'reassess') body.evidence = { humanProvided: true, assessment: text || 'Reviewed by a person; no change to the plan.' };
      else if (text) body.evidence = { humanProvided: true, text };
      advance(body);
    }, 'primary')
  ]);
}

export function governanceCard(run) {
  const governance = run?.situationGovernance ?? run?.adaptation?.governance;
  if (!governance) return null;
  const labels = {
    ready: 'Governance: ready',
    care: 'Governance: extra care',
    review: 'Governance: review needed',
    blocked: 'Governance: blocked'
  };
  const tone = governance.status === 'blocked' ? 'bad' : governance.status === 'review' ? 'warn' : 'info';
  const details = [
    governance.risk && `Risk: ${governance.risk}`,
    governance.jurisdiction?.reviewRequired ? 'Applicable jurisdiction must be established.' : '',
    governance.ethics?.finalHumanDecisionRequired ? 'Final consequential decisions stay with a person.' : '',
    governance.data?.privateData && !governance.data?.modelProviderConsent ? 'Private model/connector processing needs consent.' : ''
  ].filter(Boolean);
  return element('div', { class: `notice ${tone} governance-card` }, [
    element('strong', { text: labels[governance.status] || 'Governance' }),
    details.length ? element('ul', { class: 'small' }, details.map(item => element('li', { text: item }))) : null
  ]);
}

function reasoningCard(run, task) {
  const parts = [...heading(taskLabel(task), WHAT_HAPPENS[task.type] ?? task.purpose)];
  if (!aiConnected()) {
    parts.push(element('p', { class: 'small muted', text: 'No AI is connected, so you complete this step.' }), manualStepForm(task));
    return parts;
  }
  if (state.consentNeeded.has(run.id)) {
    parts.push(element('div', { class: 'notice warn' }, [
      element('p', { text: 'This work was started without permission for the AI to read it. Allow it to continue with AI help.' }),
      element('div', { class: 'row wrap' }, [
        button('Allow and continue', event => stepThenContinue(event.currentTarget, { modelConsent: true }), 'primary'),
        button('Do it myself instead', () => { state.consentNeeded.delete(run.id); state.manualOpen.add(run.id); renderThread(); })
      ])
    ]));
    return parts;
  }
  parts.push(element('div', { class: 'row wrap' }, [
    button('Continue', () => { state.manualOpen.delete(run.id); autoDrive(run); }, 'primary'),
    state.manualOpen.has(run.id) ? null : button('I’ll do this step myself', () => { state.manualOpen.add(run.id); renderThread(); }, 'ghost')
  ]));
  if (state.manualOpen.has(run.id)) parts.push(manualStepForm(task));
  return parts;
}

/** Map a clarifying question to the answer field the server understands. */
function answerKey(question) {
  const q = String(question).toLowerCase();
  if (q.includes('jurisdiction') || q.includes('country')) return 'jurisdiction';
  if (q.includes('success') || q.includes('acceptance criteria') || q.includes('measurable result')) return 'successCriteria';
  if (q.includes('current state')) return 'currentState';
  return 'notes';
}

function clarifyCard(run, task) {
  const questions = task.metadata?.questions?.length ? task.metadata.questions : run.situation?.clarificationQuestions ?? [];
  const inputs = questions.map(question => ({ question, input: textArea('Your answer', 2) }));
  const extra = textArea('Anything else that would help? (optional)', 2);
  return [
    ...heading('A quick question first', 'Your answer changes how this work should be done, so it is needed before going further.'),
    ...inputs.map(({ question, input }) => field(question, input)),
    field('Anything else?', extra),
    button('Send answers', () => {
      const missing = inputs.find(({ input }) => !input.value.trim());
      if (missing) return notify('runNotice', 'warn', `Please answer: ${missing.question}`);
      const answers = {};
      const notes = [];
      for (const { question, input } of inputs) {
        const key = answerKey(question);
        const value = input.value.trim();
        if (key === 'successCriteria') answers.successCriteria = [value];
        else if (key === 'notes') notes.push(`${question} ${value}`);
        else answers[key] = value;
      }
      if (extra.value.trim()) notes.push(extra.value.trim());
      answers.notes = notes.join('\n') || 'Answered.';
      advance({
        taskId: task.id,
        summary: inputs.map(({ input }) => input.value.trim()).join(' · ').slice(0, 500),
        evidence: {
          answers,
          clarification: { acknowledged: true, humanProvided: true, providedAt: new Date().toISOString() }
        }
      });
    }, 'primary')
  ];
}

/** The build plan a plan step wrote, as the person reads it. */
function planView(plan) {
  const list = (title, items, ordered = false) => (Array.isArray(items) && items.length
    ? [element('div', { class: 'build-plan-heading', text: title }), element(ordered ? 'ol' : 'ul', {}, items.map(item => element('li', { text: String(item) })))]
    : []);
  return element('div', { class: 'build-plan' }, [
    plan.summary ? element('p', { class: 'build-plan-summary', text: String(plan.summary) }) : null,
    ...list('What it will do', plan.features),
    ...list('Files', plan.files),
    ...list('How it will be tested', plan.tests),
    ...list('Assumptions', plan.assumptions),
    ...list('Keep from the existing code', plan.keepExisting),
    ...list('Remove from the existing code', plan.removeExisting),
    ...list('Add to the project', plan.addNew),
    ...list('Change in the existing code', plan.changeExisting),
    ...list('Questions for you', plan.questions, true)
  ]);
}

/** The plan is a suggestion; the person's choices are collected above approval. */
function planAgreementCard(run, task) {
  const planTask = [...run.tasks].reverse().find(item => item.metadata?.buildPlan && item.status === 'complete');
  const plan = planTask?.evidence?.structured && typeof planTask.evidence.structured === 'object' ? planTask.evidence.structured : null;
  const questions = Array.isArray(plan?.questions) ? plan.questions.filter(Boolean) : [];
  const choice = (label, placeholder) => {
    const input = element('textarea', { rows: '2', placeholder });
    return { input, field: field(label, input) };
  };
  const keep = choice('What do you want to keep? (optional)', 'Files, modules, behaviour or decisions to keep. Leave blank to accept the suggestion.');
  const remove = choice('What do you want to remove? (optional)', 'Files, modules or behaviour to remove. Leave blank to accept the suggestion.');
  const add = choice('What do you want to add? (optional)', 'New files, features, modules or tests to add. Leave blank to accept the suggestion.');
  const change = choice('What do you want to change? (optional)', 'Specific changes to make in the existing code. Leave blank to accept the suggestion.');
  const answers = choice(
    questions.length ? 'Answers / other instructions (optional)' : 'Other instructions (optional)',
    questions.length ? 'Answer the questions above or add any other instruction.' : 'Any additional instruction for the approved build.'
  );
  const stopRow = element('div', { class: 'row wrap', hidden: true }, [
    element('span', { class: 'small', text: 'Stop this work? Nothing will be changed.' }),
    button('Yes, stop it', () => stopRun('plan not agreed'), 'danger small')
  ]);
  const values = () => {
    const split = value => value.trim().split(/\n|;|,/).map(item => item.trim()).filter(Boolean).slice(0, 40);
    return {
      keepExisting: split(keep.input.value),
      removeExisting: split(remove.input.value),
      addNew: split(add.input.value),
      changeExisting: split(change.input.value)
    };
  };
  const agree = () => {
    const planChoices = values();
    const other = answers.input.value.trim();
    advance({
      taskId: task.id,
      approved: true,
      planChoices,
      conditions: other,
      summary: other || Object.values(planChoices).some(items => items.length)
        ? 'Plan approved with user-selected changes.'
        : 'Plan approved as proposed.'
    });
  };
  return [
    ...heading(
      task.metadata?.existingCodePlan ? 'Review the proposed changes to your existing code' : 'Here is the proposed plan',
      'The suggestions below do not change anything. Choose what you want to keep, remove, add or change, then approve before coding begins.'
    ),
    plan ? planView(plan) : planTask?.evidence?.text ? element('div', { class: 'answer' }, renderMarkdown(String(planTask.evidence.text))) : null,
    element('div', { class: 'plan-choice-inputs' }, [
      keep.field, remove.field, add.field, change.field, answers.field
    ]),
    element('div', { class: 'row wrap' }, [
      button(task.metadata?.existingCodePlan ? 'Approve these changes and code' : 'Approve plan and build', agree, 'primary'),
      button('Stop', () => { stopRow.hidden = false; })
    ]),
    stopRow
  ];
}

function approvalCard(run, task) {
  if (task.metadata?.planAgreement) return planAgreementCard(run, task);
  const conditions = element('input', { placeholder: 'Conditions (optional)' });
  const stopRow = element('div', { class: 'row wrap', hidden: true }, [
    element('span', { class: 'small', text: 'Stop this work? This cannot be undone.' }),
    button('Yes, stop it', () => stopRun('not approved'), 'danger small')
  ]);
  const reasons = (run.governance?.approvals ?? []).map(item => item?.reason ?? item?.id ?? item).filter(item => typeof item === 'string');
  return [
    ...heading('Your approval is needed', 'The next steps do real work outside this page, so they only run if you agree.'),
    element('p', { text: task.purpose }),
    reasons.length ? element('ul', { class: 'small muted' }, reasons.map(reason => element('li', { text: reason }))) : null,
    conditions,
    element('div', { class: 'row wrap' }, [
      button('Approve and continue', () => advance({
        taskId: task.id, approved: true, conditions: conditions.value.trim(), summary: conditions.value.trim() || 'Approved'
      }), 'primary'),
      button('Don’t approve', () => { stopRow.hidden = false; })
    ]),
    stopRow
  ];
}

function verifyCard(run, task) {
  const criteria = Array.isArray(run.verificationCriteria) ? run.verificationCriteria
    : Array.isArray(run.situation?.successCriteria) ? run.situation.successCriteria : [];
  const humanRequired = task.metadata?.verification?.humanReviewRequired === true;
  const problem = textArea('What is wrong, or what should change?', 3);
  const rejectRow = element('div', { class: 'stack', hidden: true }, [
    field('What needs to change?', problem),
    button('Send back for another try', () => {
      const text = problem.value.trim();
      if (!text) return notify('runNotice', 'warn', 'Say what needs to change.');
      advance({
        taskId: task.id,
        status: 'failed',
        summary: text.slice(0, 500),
        evidence: {
          verdict: {
            verdict: 'fail',
            criteria: criteria.map(criterion => ({ criterion, met: false, reason: text })),
            problems: [text],
            summary: text
          }
        }
      });
    }, 'danger')
  ]);
  const pass = () => advance({
    taskId: task.id,
    summary: 'Checked by a person.',
    evidence: {
      verdict: {
        verdict: 'pass',
        criteria: criteria.map(criterion => ({ criterion, met: true, reason: 'Checked by a person.' })),
        problems: [],
        summary: 'Checked by a person.'
      },
      verification: { level: 'human-certified', humanReviewed: true, method: 'A person checked the result against each point.' }
    }
  });
  return [
    ...heading('Check the result', humanRequired
      ? 'This kind of work must be checked by a person. Read the result above and compare it with these points.'
      : 'Compare the result above with these points.'),
    criteria.length ? element('ul', { class: 'criteria' }, criteria.map(criterion => element('li', { text: criterion }))) : null,
    element('div', { class: 'row wrap' }, [
      aiConnected() && !humanRequired
        ? state.consentNeeded.has(run.id)
          ? button('Allow the AI to read it and check', event => stepThenContinue(event.currentTarget, { modelConsent: true }), 'primary')
          : button('Let the AI check it', event => stepThenContinue(event.currentTarget), 'primary')
        : null,
      button('Looks good', pass, aiConnected() && !humanRequired ? '' : 'primary'),
      button('Needs changes', () => { rejectRow.hidden = false; })
    ]),
    rejectRow
  ];
}

function iterateCard(run) {
  const failed = run.tasks.filter(task => task.status === 'failed');
  const note = textArea('What should be different next time? (optional)', 2);
  const attemptsLeft = run.maxAttempts - run.attempt;
  const retry = () => advance({ taskId: 'iterate', replan: true, summary: note.value.trim() || undefined });
  const stop = () => advance({ taskId: 'iterate', replan: false });
  if (failed.length) {
    return [
      ...heading('Something did not work', failed.map(task => task.summary || taskLabel(task)).join(' · ')),
      attemptsLeft > 0 ? field('What should change?', note) : null,
      element('div', { class: 'row wrap' }, [
        attemptsLeft > 0 ? button(`Try again (${attemptsLeft} left)`, retry, 'primary') : null,
        button('Stop here', stop, attemptsLeft > 0 ? '' : 'primary')
      ])
    ];
  }
  const improveRow = element('div', { class: 'stack', hidden: true }, [
    field('What should be improved?', note),
    button('Start another attempt', retry)
  ]);
  return [
    ...heading('Is this what you needed?', 'Finish if it is, or ask for an improved version. You can also just reply below.'),
    element('div', { class: 'row wrap' }, [
      button('Yes, finish', stop, 'primary'),
      attemptsLeft > 0 ? button('Improve it', () => { improveRow.hidden = false; }) : null
    ]),
    improveRow
  ];
}

/** Research or file inspection: a connected tool, or the person's own findings. */
function findingsCard(run, task) {
  const boundaries = configuredTargets(task.type);
  const findings = textArea(task.type === 'investigate' ? 'What did you find? Include the key facts.' : 'What did you find in the file(s)?', 5);
  const sources = element('input', { placeholder: 'Links or document names, separated by commas (optional)' });
  const ownForm = element('div', { class: 'stack' }, [
    field(task.type === 'investigate' ? 'Your findings' : 'What you found', findings),
    field('Sources', sources),
    button('Save my findings', () => {
      if (!findings.value.trim()) return notify('runNotice', 'warn', 'Write what you found first.');
      advance({
        taskId: task.id,
        summary: findings.value.trim().slice(0, 500),
        evidence: {
          humanProvided: true,
          findings: findings.value.trim(),
          sources: sources.value.split(',').map(item => item.trim()).filter(Boolean)
        }
      });
    }, boundaries.length ? '' : 'primary')
  ]);
  if (!boundaries.length) {
    return [
      ...heading(taskLabel(task), 'No research tool is connected, so add what you found yourself. It is saved as your own work.'),
      ownForm
    ];
  }
  const approve = element('input', { type: 'checkbox' });
  const runButton = button(task.type === 'investigate' ? 'Run the research' : 'Run the tool', event => {
    if (!approve.checked) return notify('runNotice', 'warn', 'Tick the approval box first.');
    stepThenContinue(event.currentTarget, { approved: true });
  }, 'primary');
  // Usable once approved, so a click never seems to do nothing.
  runButton.disabled = true;
  runButton.title = 'Tick the approval box first';
  approve.addEventListener('change', () => { runButton.disabled = !approve.checked; runButton.title = approve.checked ? '' : 'Tick the approval box first'; });
  return [
    ...heading(taskLabel(task), `This uses ${boundaries.map(target => target.label).join(' / ')} to fetch real information.`),
    element('label', { class: 'checkbox' }, [approve, element('span', { text: 'I approve using it for this step' })]),
    runButton,
    element('details', {}, [element('summary', { class: 'small', text: 'Or add your own findings' }), ownForm])
  ];
}

/** Code or a model run that must really happen somewhere. */
function executionCard(run, task) {
  const targets = configuredTargets(task.type);
  if (!targets.length && task.id === 'test-code') {
    return [
      ...heading(taskLabel(task), 'No place to run code is set up here, so the tests are skipped and the code comes to you marked as not run.'),
      button('Continue without running it', event => stepThenContinue(event.currentTarget, {}), 'primary')
    ];
  }
  if (!targets.length) {
    return [
      ...heading(taskLabel(task), 'This step has to really run, but no place to run it is set up yet.'),
      element('p', { class: 'small muted', text: 'An administrator can connect one: the local agent on your computer, or the Kindgleam runner. Until then this work cannot go further.' })
    ];
  }
  const select = element('select', { 'aria-label': 'Where to run' },
    targets.map(target => element('option', { value: target.id, text: target.label })));
  if (!targets.some(target => target.id === state.executionTarget)) {
    state.executionTarget = targets.some(target => target.id === 'local') ? 'local' : targets[0].id;
  }
  select.value = state.executionTarget;
  const status = element('div', { class: 'small muted', 'aria-live': 'polite' });
  const approve = element('input', { type: 'checkbox' });
  select.addEventListener('change', () => { state.executionTarget = select.value; approve.checked = false; });
  const check = targets.some(target => target.id === 'local')
    ? button('Check this computer', () => guard(async () => {
        const preflight = await getLocalPreflight(true);
        const decision = await api('POST', `/api/runs/${run.id}/execution-plan`, { executionTarget: 'auto', preflight, cloudFallbackAllowed: true });
        if (decision.target && targets.some(target => target.id === decision.target)) {
          state.executionTarget = decision.target;
          select.value = decision.target;
        }
        status.textContent = preflight.agent?.available
          ? `Local agent connected · ${preflight.cpuCores ?? '?'} cores · ${preflight.memoryBytes ? bytes(preflight.memoryBytes) : 'memory unknown'}`
          : 'Checked from the browser only. Exact checks need the local agent.';
        if (state.executionTarget !== 'local') status.textContent += ` Suggested: ${select.selectedOptions[0]?.text ?? state.executionTarget}.`;
      }, 'runNotice'), 'small')
    : null;
  return [
    ...heading(taskLabel(task), task.purpose),
    element('div', { class: 'row wrap' }, [field('Where to run', select), check]),
    status,
    element('label', { class: 'checkbox' }, [approve, element('span', { text: 'I approve running this in the selected place' })]),
    button('Run', async event => {
      if (!approve.checked) return notify('runNotice', 'warn', 'Tick the approval box first.');
      const target = select.value;
      await stepThenContinue(event.currentTarget, {
        executionTarget: target,
        approved: true,
        preflight: target === 'local' ? await getLocalPreflight() : undefined,
        requirements: task.metadata?.requirements,
        cloudFallbackAllowed: false
      });
    }, 'primary')
  ];
}

export function renderNextStep(run) {
  let parts;
  if (!canEdit()) parts = [element('p', { class: 'muted small', text: 'View only: an editor can move this work forward.' })];
  else if (run.state === 'iterate') parts = iterateCard(run);
  else {
    const task = nextTaskOf(run);
    if (!task) return null;
    else if (task.type === 'clarify') parts = clarifyCard(run, task);
    else if (task.type === 'approval') parts = approvalCard(run, task);
    else if (task.type === 'verify') parts = verifyCard(run, task);
    else if (task.type === 'observe') {
      parts = [
        ...heading(taskLabel(task), WHAT_HAPPENS.observe),
        button('Continue', () => autoDrive(run), 'primary')
      ];
    } else if (['investigate', 'tool'].includes(task.type)) parts = findingsCard(run, task);
    else if (task.type === 'code' && task.metadata?.modelGenerated !== true) parts = executionCard(run, task);
    else parts = reasoningCard(run, task);
  }
  return element('div', { class: 'step-card stack' }, parts.filter(Boolean));
}

/* -------------------------------------------------------------------- chat */

// AI steps that run on their own in a chat; everything else waits for the
// person (questions, approvals, research and code runs, human checks).
const AUTOMATIC_TASKS = ['understand', 'discover', 'discover-capabilities', 'adapt', 'plan', 'respond', 'prototype', 'reassess', 'deliver', 'observe', 'step'];

export function isAutomatic(run) {
  if (!run || TERMINAL_STATES.includes(run.state) || run.state === 'iterate' || !canEdit()) return false;
  const task = nextTaskOf(run);
  if (!task || state.manualOpen.has(run.id) || state.consentNeeded.has(run.id)) return false;
  if (task.type === 'observe') return true;
  if (!aiConnected()) return false;
  if (task.type === 'verify') return task.metadata?.verification?.humanReviewRequired !== true;
  if (task.id === 'build-code' && task.metadata?.modelGenerated === true) return true;
  if (repairRerun(run)) return true;
  // Nowhere to run the tests: the server records them as not run and the
  // code goes on to be checked and delivered, so nothing waits on a person.
  if (task.id === 'test-code' && !configuredTargets('code').length) return true;
  return AUTOMATIC_TASKS.includes(task.type);
}

/**
 * After a failed code run went back for a fix, the fixed code runs again in
 * the same sealed sandbox the person approved for this attempt (no network,
 * nothing outside it touched). Anything else, the local agent included, asks
 * again.
 */
function repairRerun(run) {
  const task = nextTaskOf(run);
  if (task?.id !== 'test-code') return null;
  const last = (run.adaptation?.codeRepairs ?? []).filter(item => Number(item.attempt) === Number(run.attempt)).at(-1);
  if (last?.failure?.target !== 'general-ai-sandbox') return null;
  return { executionTarget: 'general-ai-sandbox', approved: true, requirements: task.metadata?.requirements, cloudFallbackAllowed: false };
}

/** Run the AI steps one after another, stopping where the person is needed. */
export async function autoDrive(run) {
  if (!run) return run;
  state.drivingRuns ??= new Set();
  if (state.drivingRuns.has(run.id)) return run;
  state.drivingRuns.add(run.id);
  let current = run;
  try {
    for (let steps = 0; steps < 30 && isAutomatic(current); steps += 1) {
      const before = String(current.next) + ':' + String(current.attempt);
      const rerun = repairRerun(current);
      if (state.chat?.id === current.conversationId || !state.chat?.id) {
        state.run = current;
        state.driving = current.id;
        state.drivingLabel = rerun ? 'Running the revised code' : taskLabel(nextTaskOf(current));
        renderThread();
      }
      const updated = await runStep(null, rerun ?? {}, current);
      if (updated) current = updated;
      if (String(current.next) + ':' + String(current.attempt) === before) break;
    }
  } finally {
    state.drivingRuns.delete(run.id);
    if (state.driving === run.id) state.driving = null;
    state.drivingLabel = '';
    if (state.run?.id === run.id) {
      state.run = current;
      renderThread();
    } else {
      loadRuns().catch(() => {});
    }
  }
  return current;
}

// Only real outcomes are shown as the answer; planning and checking notes
// stay behind "Show steps".
const RESULT_TASKS = ['deliver', 'respond', 'prototype'];

export function resultText(run) {
  const recent = [...run.tasks].reverse();
  const spoken = recent.find(task => task.evidence?.text && RESULT_TASKS.includes(task.type));
  if (spoken) return spoken.evidence.text;
  const code = recent.find(task => task.id === 'build-code' && hasCode(task.evidence?.structured));
  if (code) return codeMarkdown(code.evidence.structured);
  // Research is shown as soon as it exists, so a check before the final
  // answer has something to check.
  const research = recent.find(task => ['investigate', 'tool'].includes(task.type) && (task.evidence?.findings || task.evidence?.text));
  if (!research) return '';
  const evidence = research.evidence;
  const cited = [
    ...(evidence.sources ?? []),
    ...(evidence.citations ?? []).map(item => item?.url).filter(Boolean)
  ];
  const sources = cited.length ? `\n\nSources: ${[...new Set(cited)].join(', ')}` : '';
  // A tool step that already answered speaks for itself.
  const label = research.type === 'investigate' ? 'Research findings:\n\n' : '';
  return `${label}${evidence.findings ?? evidence.text}${sources}`;
}

/**
 * What a step adapted, in a few words: code fixed after a failing test, a
 * run it could not do here. Empty when nothing changed from the plan.
 */
function stepNote(run, task) {
  const fixes = (run.adaptation?.codeRepairs ?? []).filter(item => Number(item.attempt) === Number(run.attempt)).length;
  if (task.id === 'build-code' && fixes) return `fixed ${fixes === 1 ? 'once' : `${fixes} times`} after a failing test`;
  if (task.id === 'test-code' && fixes) return task.status === 'complete' ? `passed after ${fixes === 1 ? '1 fix' : `${fixes} fixes`}` : `run ${fixes + 1}`;
  if (task.status === 'skipped') return /^Not run:/.test(task.summary ?? '') ? task.summary.replace(/^Not run: /, 'not run: ') : 'skipped: not needed';
  return '';
}

const arrayOf = value => (Array.isArray(value) ? value : []);
const clip = (value, max) => {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** Words to read, not markup: code blocks, headings and backticks go. */
function plainText(value) {
  return String(value ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A JSON reply's own summary, when it has one. */
function jsonSummary(value) {
  for (const key of ['summary', 'findings', 'decision', 'reasoning', 'notes']) {
    const found = value?.[key] ?? value?.reassessment?.[key];
    if (typeof found === 'string' && found.trim()) return found;
  }
  return '';
}

/** A step's text evidence, read as JSON when it is some. */
function parsedEvidence(evidence) {
  const raw = String(evidence?.text ?? '').trim();
  if (!/^[[{]/.test(raw)) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** What one step did, as the person reads it under its row. */
function stepDetail(task) {
  const evidence = task.evidence && typeof task.evidence === 'object' ? task.evidence : {};
  const rows = [];
  const line = (label, value) => { if (String(value ?? '').trim()) rows.push(element('p', {}, [element('strong', { text: `${label}: ` }), element('span', { text: value })])); };
  const list = (label, items) => {
    const shown = (Array.isArray(items) ? items : []).filter(Boolean).slice(0, 8);
    if (!shown.length) return;
    rows.push(element('p', {}, element('strong', { text: `${label}:` })));
    rows.push(element('ul', {}, shown.map(item => (item instanceof Node ? element('li', {}, item) : element('li', { text: item })))));
  };
  const structured = evidence.structured && typeof evidence.structured === 'object' ? evidence.structured : null;
  const json = structured ?? parsedEvidence(evidence);
  line('Aim', task.purpose);
  // The result in words: a JSON reply by its own summary, prose without markup.
  const summary = String(task.summary ?? '').trim();
  const result = /^[[{]/.test(summary) ? plainText(jsonSummary(json ?? parsedEvidence({ text: summary }))) : plainText(summary);
  if (task.status === 'skipped') line('Skipped', summary || 'not needed');
  else if (result && result !== task.purpose) line('Result', clip(result, 400));
  // The code it wrote: the language and the files.
  if (task.id === 'build-code' && json) {
    const files = Array.isArray(json.files) ? json.files.map(file => file?.path).filter(Boolean) : [];
    line('Wrote', `${json.language ?? 'code'}${files.length ? `, ${files.length} file${files.length === 1 ? '' : 's'}: ${files.join(', ')}` : ''}`);
    if (json.notes && plainText(json.notes) !== result) line('Notes', clip(plainText(json.notes), 300));
  }
  // What running it showed.
  const run = evidence.result;
  const output = run?.output && typeof run.output === 'object' ? run.output : run;
  if (output && typeof output === 'object') {
    const tests = output.testSummary;
    if (tests && !/^Tests:/.test(result)) line('Tests', `${tests.passed} of ${tests.total} passed${tests.failed ? `, ${tests.failed} failed` : ''}`);
    if (output.program?.stdout) line('Printed', clip(output.program.stdout, 300));
    else if (output.stdout && !tests) line('Printed', clip(output.stdout, 300));
    if (output.status && output.status !== 'completed') line('Run', clip(output.message || output.status, 200));
    if (output.status === 'failed' && output.stderr) line('Error', clip(String(output.stderr).split('\n').slice(-6).join('\n'), 400));
  }
  // The check: each criterion and whether it was met.
  const verdict = evidence.verdict && typeof evidence.verdict === 'object' ? evidence.verdict : null;
  if (task.type === 'verify' && verdict) {
    line('Verdict', verdict.verdict === 'pass' ? 'passed' : 'found problems');
    list('Checked', arrayOf(verdict.criteria).map(item => `${item?.met ? '✓' : '✕'} ${clip(item?.criterion, 140)}`));
    list('Problems', arrayOf(verdict.problems).map(item => clip(item, 200)));
  }
  // What understanding found.
  if (task.type === 'understand' && json && !structured) {
    list('Success criteria', arrayOf(json.successCriteria).map(item => clip(typeof item === 'string' ? item : item?.requirement, 160)));
    list('Questions', arrayOf(json.questions).map(item => clip(item, 160)));
  }
  // Tools it used and sources it read. Only web addresses become links.
  list('Used', arrayOf(evidence.tools).map(item => `${toolLabel(item?.tool)[1]}${item?.outcome && item.outcome !== 'ok' ? ` (${item.outcome})` : ''}`));
  list('Sources', arrayOf(evidence.citations).filter(source => /^https?:\/\//i.test(String(source?.url ?? '')))
    .map(source => element('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', text: clip(source.title || source.url, 90) })));
  // Anything else it wrote in words.
  const said = json ? '' : plainText(evidence.text);
  if (said && !['respond', 'deliver'].includes(task.type) && !said.startsWith(result.slice(0, 60))) line('Said', clip(said, 500));
  return rows;
}

export function stepsList(run) {
  state.openSteps ??= new Set();
  return element('ol', { class: 'steps' }, run.tasks.map(task => {
    const note = stepNote(run, task);
    const key = `${run.id}:${task.id}`;
    const open = state.openSteps.has(key);
    const detailId = `step-${run.id}-${task.id}`.replace(/[^\w-]/g, '-');
    const detail = element('div', { class: 'step-detail', id: detailId, hidden: !open }, stepDetail(task));
    const toggle = element('button', {
      type: 'button', class: 'step-toggle', 'aria-expanded': String(open), 'aria-controls': detailId,
      'aria-label': `${open ? 'Hide' : 'Show'} what "${taskLabel(task)}" did`, title: open ? 'Hide details' : 'Show details',
      onclick: () => {
        const now = detail.hidden;
        detail.hidden = !now;
        toggle.setAttribute('aria-expanded', String(now));
        toggle.setAttribute('aria-label', `${now ? 'Hide' : 'Show'} what "${taskLabel(task)}" did`);
        toggle.title = now ? 'Hide details' : 'Show details';
        if (now) state.openSteps.add(key); else state.openSteps.delete(key);
      }
    }, svgIcon('chevron'));
    return element('li', {
      'data-status': task.status,
      'data-next': String(task.id === run.next && !TERMINAL_STATES.includes(run.state))
    }, [
      element('div', { class: 'step-row' }, [
        element('span', { class: 'mark', text: task.status === 'complete' ? '✓' : task.status === 'failed' ? '✕' : task.status === 'skipped' ? '–' : task.id === run.next ? '●' : '○' }),
        element('span', { class: 'step-label', text: taskLabel(task) }),
        ...(note ? [element('span', { class: 'step-note', text: ` · ${note}` })] : []),
        toggle
      ]),
      detail
    ]);
  }));
}

export async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

export async function saveAnswer(value, runId) {
  const object = await api('POST', '/api/objects', {
    type: 'chat-answer',
    name: `answer-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`,
    content: value,
    provenance: { source: 'chat-answer', runId: runId ?? null }
  });
  notify('runNotice', 'ok', `Saved to Files as ${object.name ?? object.id}.`);
}

const TOOL_LABELS = {
  'web.search': ['search', 'Searched the web'], 'web.fetch': ['explore', 'Read a web page'], 'web.download': ['download', 'Downloaded a file'],
  'file.read': ['files', 'Read your file'], 'data.analyze': ['activity', 'Analysed a table'], 'math.evaluate': ['check', 'Calculated'],
  'code.run': ['run', 'Ran code in the sandbox'], 'tool.create': ['sparkle', 'Built a new tool'],
  'schedule.create': ['bell', 'Scheduled'], 'schedule.list': ['activity', 'Checked your schedules'],
  'memory.save': ['memory', 'Saved to memory'], 'memory.forget': ['memory', 'Forgot from memory'],
  'finance.project': ['activity', 'Projected the numbers']
};
export const toolLabel = name => TOOL_LABELS[name] ?? (String(name).startsWith('ws.') ? ['sparkle', `Used your tool ${String(name).slice(3)}`] : ['sparkle', name]);
initActions();
initAccount();
initSettingsWindow();

/* ----------------------------------------------------------- landing visual
   A lightweight, deterministic product animation: no canvas, no video asset,
   and no fabricated runtime telemetry. It simply illustrates the real
   adaptive sequence and the real role catalog. */
function initLandingWorkflowDemos() {
  const reduceMotion = () => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch { return false; }
  };

  const controllers = [
    {
      root: document.querySelector('[data-demo="chat"]'),
      itemSelector: '[data-chat-step]',
      progressSelector: '[data-chat-progress]',
      stepCount: 5,
      duration: 2300
    },
    {
      root: document.querySelector('[data-demo="code"]'),
      itemSelector: '[data-code-step]',
      progressSelector: '[data-code-progress]',
      stepCount: 6,
      duration: 2500
    }
  ].filter(item => item.root);

  controllers.forEach(controller => {
    const { root, itemSelector, progressSelector, stepCount, duration } = controller;
    const items = [...root.querySelectorAll(itemSelector)];
    const progress = [...root.querySelectorAll(progressSelector)];
    const status = root.querySelector('[data-demo-status]');
    let step = 0;
    let timer = null;

    const render = () => {
      items.forEach((node, index) => node.classList.toggle('is-active', index === step));
      progress.forEach((node, index) => node.classList.toggle('is-active', index === step));
      root.dataset.currentStep = String(step);
      if (status) status.textContent = step === stepCount - 1 ? 'verifying' : 'running';
    };

    const start = () => {
      if (reduceMotion() || timer) return;
      timer = window.setInterval(() => {
        step = (step + 1) % stepCount;
        render();
      }, duration);
    };

    const stop = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };

    render();
    start();

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else start();
    });

    try {
      window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
        if (reduceMotion()) {
          stop();
          render();
        } else {
          start();
        }
      });
    } catch {}
  });
}
initLandingWorkflowDemos();

/* ---------------------------------------------------------------- wire-up */

function setVoiceStatus(message, hidden = false) {
  const node = $('voiceStatus');
  if (!node) return;
  node.hidden = hidden || !message;
  node.textContent = message || '';
}

export function setupVoiceInput() {
  const node = $('voiceBtn');
  if (!node) return;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!state.settings.voiceInput || !Recognition) {
    node.disabled = !canEdit() || !Recognition || !state.settings.voiceInput;
    node.classList.remove('listening');
    node.title = Recognition ? 'Voice input is off in Settings' : 'Voice input is not supported by this browser';
    setVoiceStatus(Recognition ? 'Voice input is off' : 'Voice input is not supported here', !Recognition);
    if (state.voice.recognition) {
      try { state.voice.recognition.abort(); } catch {}
      state.voice.recognition = null;
    }
    return;
  }
  if (state.voice.recognition) {
    state.voice.recognition.lang = state.settings.voiceLanguage || navigator.language || 'en-US';
    node.disabled = !canEdit();
    node.title = state.voice.listening ? 'Stop voice input' : 'Speak your message';
    return;
  }

  const recognition = new Recognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.lang = state.settings.voiceLanguage || navigator.language || 'en-US';

  recognition.onstart = () => {
    state.voice.listening = true;
    state.voice.baseText = $('goal').value.trim();
    node.classList.add('listening');
    node.title = 'Stop voice input';
    setVoiceStatus('Listening…', false);
  };

  recognition.onresult = event => {
    let finalText = '';
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const transcript = event.results[i][0]?.transcript ?? '';
      if (event.results[i].isFinal) finalText += transcript;
      else interim += transcript;
    }
    $('goal').value = [state.voice.baseText, finalText, interim].filter(Boolean).join(' ').trim();
    growComposer();
    saveDraftSoon();
  };

  recognition.onerror = event => {
    if (event.error === 'not-allowed') setVoiceStatus('Microphone permission was blocked', false);
    else if (event.error !== 'aborted') setVoiceStatus('Voice input stopped', false);
  };

  recognition.onend = () => {
    state.voice.listening = false;
    node.classList.remove('listening');
    node.title = 'Speak your message';
    setVoiceStatus('', true);
    saveDraftSoon();
  };

  state.voice.recognition = recognition;
  node.disabled = !canEdit();
  node.title = 'Speak your message';
}

function toggleVoiceInput() {
  const recognition = state.voice.recognition;
  if (!recognition) return setupVoiceInput();
  if (state.voice.listening) {
    try { recognition.stop(); } catch {}
    return;
  }
  recognition.lang = state.settings.voiceLanguage || navigator.language || 'en-US';
  try { recognition.start(); } catch {
    setVoiceStatus('Voice input could not start. Check microphone permission.', false);
  }
}

$('attachBtn').addEventListener('click', () => $('attachInput').click());
$('voiceBtn').addEventListener('click', toggleVoiceInput);
$('attachInput').addEventListener('change', event => {
  addAttachments(event.target.files ?? []);
  event.target.value = '';
});
// Files can also be dropped on, or pasted into, the message box.
$('composer').addEventListener('dragover', event => { event.preventDefault(); $('composer').classList.add('dragging'); });
$('composer').addEventListener('dragleave', () => $('composer').classList.remove('dragging'));
$('composer').addEventListener('drop', event => {
  event.preventDefault();
  $('composer').classList.remove('dragging');
  if (canEdit() && event.dataTransfer?.files?.length) addAttachments(event.dataTransfer.files);
});
$('goal').addEventListener('paste', event => {
  if (canEdit() && event.clipboardData?.files?.length) {
    event.preventDefault();
    addAttachments(event.clipboardData.files);
  }
});
$('chatSearch').addEventListener('input', renderChatList);

$('signin').addEventListener('submit', signIn);
initGate();
$('signout').addEventListener('click', signOut);
$('composer').addEventListener('submit', event => {
  event.preventDefault();
  sendMessage($('goal').value);
});
$('newWork').addEventListener('click', newChat);
$('newWorkTop').addEventListener('click', newChat);
$('newWorkHead').addEventListener('click', newChat);

// On wide screens the sidebar can be hidden; the choice is remembered here.
// When closed it shrinks to a slim rail of icons rather than disappearing.
function setRailCollapsed(collapsed) {
  document.body.classList.toggle('rail-collapsed', collapsed);
  const label = collapsed ? 'Show sidebar' : 'Hide sidebar';
  $('collapseRail').setAttribute('aria-label', label);
  $('collapseRail').title = label;
  try { localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0'); } catch {}
}
const RAIL_KEY = 'kindgleam:rail-collapsed';
adoptLegacy(localStorage, RAIL_KEY);
try { if (localStorage.getItem(RAIL_KEY) === '1') setRailCollapsed(true); } catch {}
$('collapseRail').addEventListener('click', () => {
  // On phones the same button just closes the slide-over menu.
  if (window.matchMedia('(max-width: 860px)').matches) document.body.classList.remove('chats-open');
  else setRailCollapsed(!document.body.classList.contains('rail-collapsed'));
});
$('expandRail').addEventListener('click', () => setRailCollapsed(false));
$('railChats').addEventListener('click', () => {
  setRailCollapsed(false);
  $('chatSearch').focus();
});
$('chatsTop').addEventListener('click', () => document.body.classList.toggle('chats-open'));
$('railBackdrop').addEventListener('click', () => document.body.classList.remove('chats-open'));
// Escape closes the phone menu, after any panel open above it.
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.defaultPrevented && $('notifyPanel').hidden && !document.querySelector('dialog[open]') && document.body.classList.contains('chats-open')) document.body.classList.remove('chats-open');
});
$('goal').addEventListener('input', growComposer);
$('refreshRuns').addEventListener('click', () => guard(loadRuns));
$('refreshObjects').addEventListener('click', () => guard(loadObjects));
$('refreshAudit').addEventListener('click', () => guard(loadAudit));
$('uploadObject').addEventListener('click', uploadObject);

$('tabs').addEventListener('click', event => {
  const tab = event.target.closest('[data-tab]');
  if (tab) selectTab(tab.dataset.tab);
});

document.addEventListener('kindgleam:select-surface', event => {
  const name = event.detail?.name;
  if (name) selectTab(name);
});

$('workspace').addEventListener('change', event => {
  state.workspaceId = event.target.value;
  state.role = state.workspaces.find(workspace => workspace.id === state.workspaceId)?.role ?? 'viewer';
  applyRole();
  newChat();
});

// Enter sends, Shift+Enter starts a new line, as in any chat.
$('goal').addEventListener('keydown', event => {
  if (document.body.dataset.aiUsageLocked === 'true') return;
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && state.settings.enterSends) {
    event.preventDefault();
    sendMessage($('goal').value);
  }
});

/**
 * When the connection returns: send what was queued, and pick up a run whose
 * steps were cut off by the drop. A run that stopped for any other reason
 * (an error, a question for the person) is left for the person.
 */
async function resumeAfterReconnect() {
  updateConnectionUI();
  if (!state.principal || navigator.onLine === false) return;
  flushOfflineQueue().catch(() => {});
  loadRuns().catch(() => {});
  const run = state.run;
  if (!run || run.id !== state.network.interruptedRunId || state.driving || state.busy) return;
  state.network.interruptedRunId = null;
  try {
    const fresh = await api('GET', `/api/runs/${run.id}`);
    if (state.run?.id !== fresh.id || state.driving || state.busy) return;
    renderRun(fresh);
    clearNotice('runNotice');
    if (isAutomatic(fresh)) await autoDrive(fresh);
  } catch (error) {
    if (error.code === 'offline' || error.transient) state.network.interruptedRunId = run.id;
  }
}

window.addEventListener('online', resumeAfterReconnect);
window.addEventListener('kindgleam:reconnected', resumeAfterReconnect);
window.addEventListener('offline', updateConnectionUI);
// A phone that slept may have lost its requests without an offline event.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resumeAfterReconnect();
});
// An expired session goes back to sign-in; the draft and queued messages stay on this device.
window.addEventListener('kindgleam:signed-out', () => {
  if (!state.principal) return;
  state.principal = null;
  showGate();
  notify('gateNotice', 'warn', 'Your session ended. Sign in again; your draft and any queued messages are kept on this device.');
});

// The shell can load from the service worker while the network is unavailable.
registerAppWorker();
updateConnectionUI();
setupVoiceInput();

// A sign-in link from an email goes straight to its confirm step. Otherwise
// an existing cookie means we are already signed in; if not, show the gate.
if (takeSignInToken()) showGate();
else enterApp().catch(() => { $('landing').hidden = false; updateConnectionUI(); });
