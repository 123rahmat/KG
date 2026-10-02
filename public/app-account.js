/**
 * Kindgleam — browser client: The person's account: files, activity, usage and billing, notifications and schedules, and memory.
 * Part of app.js, split out by concern; app.js wires the page together.
 */

import { state, $, element, button, api, notify, guard, canEdit, downloadUrl, clearNotice, updateConnectionUI } from './ui-core.js';
import { bytes, formatWhen, loadExecutionConfig, setupVoiceInput, svgIcon, timeAgo } from './app.js';
import { fileToBase64, flushOfflineQueue, growComposer, loadRuns, newChat, openChat, renderChatHead } from './app-attachments.js';
import { renderExplore } from './app-actions.js';
import { activateSettingsSection, openSettings } from './app-settings-window.js';
import { OFFLINE_QUEUE_KEY, clearDraft, clearOfflineFiles, loadOfflineFiles, loadPreferences, readDraft, setSaveState } from './app-settings.js';

/* ------------------------------------------------------------------ files */

export async function loadObjects() {
  const [{ objects }, usage] = await Promise.all([
    api('GET', '/api/objects?limit=50'),
    api('GET', '/api/objects/usage')
  ]);

  const list = $('objectList');
  list.replaceChildren();
  if (!objects.length) {
    list.append(element('div', { class: 'empty', text: 'No files in this workspace yet.' }));
  } else {
    const body = element('tbody');
    for (const object of objects) {
      const editable = canEdit();
      body.append(element('tr', {}, [
        element('td', { class: 'truncate', text: object.name ?? object.id }),
        element('td', { class: 'small muted', text: object.type }),
        element('td', { class: 'small muted', text: bytes(object.size) }),
        element('td', {}, element('span', {
          class: `pill ${object.lifecycle === 'archived' ? 'warn' : 'idle'}`, text: object.lifecycle
        })),
        element('td', { class: 'actions' }, [
          element('a', { class: 'btn small', href: downloadUrl(`/api/objects/${object.id}/content`), download: '', text: 'Download' }),
          editable ? button(object.lifecycle === 'archived' ? 'Restore' : 'Archive',
            () => guard(() => mutateObject(object, object.lifecycle === 'archived' ? 'restore' : 'archive')), 'small') : null,
          editable ? button('Delete', () => guard(() => removeObject(object)), 'small danger') : null
        ])
      ]));
    }
    list.append(element('div', { class: 'table-wrap' }, element('table', {}, [
      element('thead', {}, element('tr', {}, ['Name', 'Label', 'Size', 'State', '']
        .map(label => element('th', { text: label })))),
      body
    ])));
  }

  const usedRatio = usage.maxBytes ? usage.bytes / usage.maxBytes : 0;
  $('usage').replaceChildren(
    element('div', { class: 'small muted', text: `${usage.objects} of ${usage.maxObjects} files` }),
    element('div', { class: 'meter' }, element('i', {
      class: usedRatio > 0.9 ? 'bad' : usedRatio > 0.7 ? 'warn' : '',
      style: { width: `${Math.min(usedRatio * 100, 100).toFixed(1)}%` }
    })),
    element('div', { class: 'small muted', text: `${bytes(usage.bytes)} of ${bytes(usage.maxBytes)}` })
  );
}

async function mutateObject(object, action) {
  await api('POST', `/api/objects/${object.id}/${action}`, {});
  await loadObjects();
}

async function removeObject(object) {
  if (!confirm(`Delete "${object.name ?? object.id}"? This cannot be undone.`)) return;
  await api('DELETE', `/api/objects/${object.id}`);
  await loadObjects();
}

export async function uploadObject() {
  const input = $('file');
  const file = input.files?.[0];
  if (!file) return notify('notice', 'warn', 'Choose a file first.');

  await guard(async () => {
    await api('POST', '/api/objects', {
      name: file.name,
      type: $('objectType').value.trim() || 'document',
      contentType: file.type || 'application/octet-stream',
      content: await fileToBase64(file),
      encoding: 'base64',
      visibility: $('shareObject').checked ? 'workspace' : 'private'
    });
    input.value = '';
    await loadObjects();
  });
}

/* ---------------------------------------------------------------- activity */

export async function loadAudit() {
  const { entries } = await api('GET', '/api/audit?limit=100');
  const list = $('auditList');
  list.replaceChildren();
  if (!entries.length) {
    list.append(element('div', { class: 'empty', text: 'Nothing recorded yet.' }));
    return;
  }
  const body = element('tbody');
  for (const entry of entries) {
    body.append(element('tr', {}, [
      element('td', { class: 'small muted', text: formatWhen(entry.at) }),
      element('td', { class: 'small', text: entry.action }),
      element('td', {}, element('span', {
        class: `pill ${entry.outcome === 'allowed' ? 'ok' : entry.outcome === 'denied' ? 'warn' : 'bad'}`,
        text: entry.outcome
      })),
      element('td', { class: 'mono truncate', text: entry.target ?? '—' })
    ]));
  }
  list.append(element('div', { class: 'table-wrap' }, element('table', {}, [
    element('thead', {}, element('tr', {}, ['When', 'Action', 'Outcome', 'Target']
      .map(label => element('th', { text: label })))),
    body
  ])));
}

const TAB_LOADERS = { runs: loadRuns, explore: async () => renderExplore(), objects: loadObjects, audit: loadAudit };

export async function selectTab(name) {
  document.body.classList.remove('chats-open');
  for (const tab of $('tabs').children) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  }
  for (const tab of ['runs', 'explore', 'objects', 'audit']) {
    $(`tab-${tab}`).hidden = tab !== name;
  }
  await guard(() => TAB_LOADERS[name]());
}

export function applyRole() {
  const editor = canEdit();
  $('createRun').disabled = !editor;
  $('goal').disabled = !editor;
  $('goal').placeholder = editor
    ? 'Ask anything…'
    : 'You have view-only access in this workspace.';
  $('newWork').hidden = !editor;
  $('newWorkTop').hidden = !editor;
  $('newWorkHead').hidden = !editor;
  $('uploadObject').disabled = !editor;
  $('who').textContent = state.principal.name;
  $('userInitial').textContent = (state.principal.name || '?').trim().charAt(0).toUpperCase();
  $('workspace').hidden = state.workspaces.length < 2;
  $('attachBtn').disabled = !editor;
  setupVoiceInput();
  updateConnectionUI();
}

export function registerAppWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}

/* ------------------------------------------------ usage, billing, security */

/** 1234 → "1.2k", 2500000 → "2.5M": tokens as a person reads them. */
const formatTokens = value => {
  const n = Number(value) || 0;
  if (n >= 1e9) return `${Number((n / 1e9).toPrecision(3))}B`;
  if (n >= 1e6) return `${Number((n / 1e6).toPrecision(3))}M`;
  if (n >= 1e3) return `${Number((n / 1e3).toPrecision(3))}k`;
  return String(n);
};
const untilText = iso => {
  if (!iso) return '';
  const minutes = Math.max(1, Math.round((new Date(iso) - Date.now()) / 60000));
  const when = new Date(iso).toLocaleString([], { weekday: minutes > 1440 ? 'short' : undefined, hour: 'numeric', minute: '2-digit' });
  return minutes < 60 ? `in ${minutes} min (${when})` : minutes < 1440 ? `in ${Math.floor(minutes / 60)} h ${minutes % 60} min (${when})` : `on ${when}`;
};
const SOURCE_LABELS = { chat: 'Chat answers & steps', classifier: 'Understanding requests', 'simulation-design': 'Earlier features' };

let usageLoading = null;

/** Usage quota is scoped to the signed-in person + workspace, not a chat. */
export function usageLimitStatus() {
  const windows = Array.isArray(state.usage?.windows) ? state.usage.windows : [];
  const exhausted = windows.find(window => window?.exceeded);
  if (!exhausted) return null;
  return {
    window: exhausted.id,
    label: exhausted.label,
    resetsAt: exhausted.resetsAt ?? null,
    message: `AI usage limit reached for this workspace (${exhausted.label}).`
  };
}

/** Keep the same persistent lock visible wherever chat/code work happens. */
export function renderUsageLimitLock() {
  const lock = usageLimitStatus();
  const resetText = lock?.resetsAt
    ? ` AI access opens again at ${new Date(lock.resetsAt).toLocaleString()}.`
    : '';
  const message = lock
    ? `${lock.message} AI is paused in every chat and code workspace.${resetText} Work that does not use the AI still works.`
    : '';
  for (const id of ['usageLimitBanner', 'usageLimitBannerCode']) {
    const node = $(id);
    if (!node) continue;
    node.hidden = !message;
    node.className = 'notice bad usage-limit-banner';
    node.textContent = message;
  }
  document.body.dataset.aiUsageLocked = lock ? 'true' : 'false';
  for (const id of ['goal', 'createRun', 'attachBtn', 'voiceBtn', 'attachInput']) {
    const node = $(id);
    if (!node) continue;
    node.disabled = Boolean(lock);
    node.setAttribute('aria-disabled', String(Boolean(lock)));
    if (lock) node.title = 'AI usage limit reached for this workspace.';
  }
  return lock;
}

/** Fetch usage (with this chat's context) and refresh every place that shows it. */
export function loadUsage() {
  if (!state.principal) return Promise.resolve(null);
  usageLoading ??= api('GET', `/api/usage${state.chat?.id ? `?conversationId=${encodeURIComponent(state.chat.id)}` : ''}`)
    .then(usage => {
      state.usage = usage;
      renderUsageRing();
      renderUsageLimitLock();
      renderChatHead();
      if (!$('settings').hidden && $('settings').open && document.querySelector('.settings-section.active')?.dataset.settingsSection === 'usage') renderUsageSection();
      return usage;
    })
    .catch(() => {
      renderUsageLimitLock();
      return null;
    })
    .finally(() => { usageLoading = null; });
  return usageLoading;
}

/** The 4-hour window at a glance, beside the account button. */
function renderUsageRing() {
  const usage = state.usage;
  const ring = $('usageRing');
  const session = usage?.windows?.find(item => item.id === 'session');
  ring.hidden = !session || !usage.model;
  if (ring.hidden) return;
  const percent = session.percent;
  const fill = $('usageRingFill');
  const length = 2 * Math.PI * 15;
  fill.style.strokeDasharray = `${length}`;
  fill.style.strokeDashoffset = `${length * (1 - (percent ?? 0) / 100)}`;
  ring.dataset.level = percent == null ? 'none' : percent >= 90 ? 'high' : percent >= 70 ? 'mid' : 'low';
  $('usageRingText').textContent = percent == null ? formatTokens(session.used) : percent >= 100 ? 'Full' : `${Math.round(percent)}%`;
  const text = percent == null
    ? `AI usage: ${formatTokens(session.used)} tokens in the last 4 hours (no limit)`
    : `AI usage: ${Math.round(percent)}% of your 4-hour limit${session.resetsAt ? `, frees up ${untilText(session.resetsAt)}` : ''}`;
  ring.title = text;
  ring.setAttribute('aria-label', text);
}

function usageMeter(window) {
  const limited = window.limit != null;
  const level = !limited ? 'none' : window.percent >= 90 ? 'high' : window.percent >= 70 ? 'mid' : 'low';
  const bar = element('div', { class: 'usage-bar', role: 'progressbar', 'aria-label': window.label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(window.percent ?? 0) }, [
    element('span', { class: 'usage-bar-fill' })
  ]);
  bar.firstChild.style.width = `${limited ? window.percent : 0}%`;
  return element('div', { class: 'usage-meter', 'data-level': level }, [
    element('div', { class: 'usage-meter-head' }, [
      element('strong', { text: window.id === 'session' ? '4-hour window' : 'This week' }),
      element('span', { class: 'usage-meter-figure', text: limited ? `${Math.round(window.percent)}%` : formatTokens(window.used) })
    ]),
    bar,
    element('div', { class: 'usage-meter-foot small muted' }, [
      element('span', { text: limited ? `${formatTokens(window.used)} of ${formatTokens(window.limit)} tokens` : `${formatTokens(window.used)} tokens · no limit set` }),
      element('span', { text: window.exceeded ? `Opens again ${untilText(window.resetsAt)}` : window.used && window.resetsAt ? `Frees up ${untilText(window.resetsAt)}` : '' })
    ]),
    element('div', { class: 'usage-split small' }, [
      element('span', {}, [element('i', { class: 'dot in' }), `In ${formatTokens(window.input)}`]),
      element('span', {}, [element('i', { class: 'dot out' }), `Out ${formatTokens(window.output)}`]),
      element('span', { class: 'muted', text: `${window.calls} AI call${window.calls === 1 ? '' : 's'}` })
    ])
  ]);
}

export function renderUsageSection() {
  const usage = state.usage;
  if (!usage) { $('usageMeters').replaceChildren(element('p', { class: 'muted small', text: 'Usage could not be loaded.' })); return; }
  $('usageMeters').replaceChildren(...usage.windows.map(usageMeter));
  const max = Math.max(1, ...usage.days.map(day => day.tokens));
  $('usageDays').replaceChildren(...usage.days.map(day => {
    const label = new Date(`${day.date}T12:00:00Z`).toLocaleDateString([], { weekday: 'short' });
    const column = element('div', { class: 'usage-day', title: `${day.date}: ${day.tokens.toLocaleString()} tokens` }, [
      element('span', { class: 'usage-day-value small', text: day.tokens ? formatTokens(day.tokens) : '' }),
      element('span', { class: 'usage-day-bar' }),
      element('span', { class: 'usage-day-label small muted', text: label })
    ]);
    column.children[1].style.height = `${Math.max(day.tokens ? 4 : 0, (day.tokens / max) * 100)}%`;
    return column;
  }));
  const total = Object.values(usage.bySource).reduce((sum, value) => sum + value, 0);
  $('usageSources').replaceChildren(...(total
    ? Object.entries(usage.bySource).sort((a, b) => b[1] - a[1]).map(([source, tokens]) => {
      const row = element('div', { class: 'usage-source' }, [
        element('span', { text: SOURCE_LABELS[source] ?? source }),
        element('span', { class: 'usage-source-bar' }, [element('i')]),
        element('strong', { class: 'small', text: `${formatTokens(tokens)} · ${Math.round((tokens / total) * 100)}%` })
      ]);
      row.querySelector('i').style.width = `${(tokens / total) * 100}%`;
      return row;
    })
    : [element('p', { class: 'muted small', text: 'No AI usage in the last 7 days.' })]));
  const model = usage.model;
  $('usageModel').replaceChildren(model
    ? element('dl', { class: 'usage-model-grid' }, [
      element('dt', { text: 'Provider' }), element('dd', { text: model.provider }),
      element('dt', { text: 'Model' }), element('dd', { text: model.model || 'provider default' }),
      element('dt', { text: 'Context window' }), element('dd', { text: model.contextWindow ? `${formatTokens(model.contextWindow)} tokens` : 'unknown' }),
      element('dt', { text: 'This chat' }), element('dd', { text: usage.context ? `${formatTokens(usage.context.used)} tokens on the last reply (${usage.context.percent}%)` : 'Open a chat to see how full its context is' })
    ])
    : element('p', { class: 'muted small', text: 'No AI model is connected, so nothing is used or counted.' }));
}

const SUBSCRIPTION_TEXT = {
  active: ['Active', 'ok'], trialing: ['Trial', 'ok'], past_due: ['Payment failed', 'warn'], unpaid: ['Unpaid', 'bad'],
  canceled: ['Cancelled', ''], incomplete: ['Waiting for payment', 'warn'], incomplete_expired: ['Payment not completed', ''], paused: ['Paused', 'warn']
};

function subscriptionLine(subscription) {
  if (!subscription) return null;
  const [label, tone] = SUBSCRIPTION_TEXT[subscription.status] ?? [subscription.status, ''];
  const end = subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const detail = subscription.status === 'past_due' ? 'Update your card in Manage payment to keep the plan.'
    : subscription.cancelAtPeriodEnd && end ? `Ends on ${end}; it will not renew.`
      : ['active', 'trialing'].includes(subscription.status) && end ? `Renews on ${end}.` : '';
  return element('div', { class: 'billing-status' }, [element('span', { class: `pill ${tone}`, text: label }), detail ? element('span', { class: 'small muted', text: detail }) : null].filter(Boolean));
}

function planCard(plan, billing) {
  const subscription = billing.stripe.subscription;
  const subscribed = subscription && ['active', 'trialing', 'past_due'].includes(subscription.status);
  // Free is the plan of everyone without a subscription.
  const current = plan.free ? !subscribed : subscribed && subscription.planId === plan.id;
  const sales = Boolean(plan.contactUrl);
  const limits = sales && !plan.fourHourTokens && !plan.weeklyTokens
    ? ['Usage limits set for your organisation']
    : [
      plan.fourHourTokens ? `${formatTokens(plan.fourHourTokens)} tokens per 4 hours` : 'No 4-hour limit',
      plan.weeklyTokens ? `${formatTokens(plan.weeklyTokens)} tokens per week` : 'No weekly limit'
    ];
  let action;
  if (current) action = element('span', { class: 'pill ok', text: 'Your plan' });
  else if (sales) {
    action = element('a', { class: 'btn small', href: plan.contactUrl, text: 'Contact sales' });
    if (plan.contactUrl.startsWith('https:')) { action.target = '_blank'; action.rel = 'noopener noreferrer'; }
  } else if (!billing.canEdit) action = element('span', { class: 'small muted', text: 'An admin can change the plan' });
  else if (plan.free) action = button(`Move to ${plan.name}`, openBillingPortal, 'ghost small');
  else if (subscribed) action = button(`Switch to ${plan.name}`, openBillingPortal, 'small');
  else action = button(`Choose ${plan.name}`, event => startCheckout(plan.id, event.currentTarget), 'primary small');
  return element('article', { class: `billing-plan-option${current ? ' current' : ''}${plan.badge ? ' featured' : ''}` }, [
    plan.badge ? element('span', { class: 'billing-badge', text: plan.badge }) : null,
    element('div', { class: 'billing-plan-option-head' }, [element('strong', { text: plan.name }), plan.price ? element('span', { class: 'billing-price', text: plan.price }) : null].filter(Boolean)),
    plan.description ? element('p', { class: 'small muted', text: plan.description }) : null,
    element('ul', { class: 'billing-features' }, [...limits, ...plan.features].map(item => element('li', {}, [svgIcon('check'), element('span', { text: item })]))),
    action
  ].filter(Boolean));
}

export async function renderBillingSection() {
  const billing = await api('GET', '/api/billing').catch(() => null);
  if (!billing) { $('billingPlan').replaceChildren(element('p', { class: 'muted small', text: 'Billing could not be loaded.' })); return null; }
  const limits = [
    billing.limits.fourHourTokens ? `${formatTokens(billing.limits.fourHourTokens)} tokens per 4 hours` : null,
    billing.limits.weeklyTokens ? `${formatTokens(billing.limits.weeklyTokens)} tokens per week` : null
  ].filter(Boolean);
  $('billingPlan').replaceChildren(
    element('div', { class: 'billing-plan-card' }, [
      element('span', { class: 'billing-plan-icon' }, [svgIcon('card')]),
      element('div', {}, [
        element('span', { class: 'settings-eyebrow', text: 'Current plan' }),
        element('strong', { text: billing.plan || (billing.stripe ? 'Free' : 'Standard') }),
        element('span', { class: 'small muted', text: limits.length ? `Includes ${limits.join(' and ')}.` : 'No usage limits apply.' }),
        subscriptionLine(billing.stripe?.subscription)
      ].filter(Boolean)),
      element('button', { type: 'button', class: 'ghost small', text: 'See usage', onclick: () => activateSettingsSection('usage') })
    ])
  );
  $('billingPlans').hidden = !billing.stripe?.plans?.length;
  if (billing.stripe) $('billingPlans').replaceChildren(...billing.stripe.plans.map(plan => planCard(plan, billing)));

  $('billingPortal').hidden = !billing.canManage;
  $('billingPortalNote').textContent = billing.canManage
    ? 'Change your card, switch or cancel the plan and download invoices on Stripe’s secure page. Card details never pass through Kindgleam.'
    : billing.portalConfigured
      ? 'Only workspace admins can manage the payment method and invoices.'
      : 'Payments are not set up for this deployment yet. An administrator can connect Stripe.';
  const fields = { billingEmail: 'billingEmail', companyName: 'billingCompany', taxId: 'billingTaxId', country: 'billingCountry', address: 'billingAddress' };
  $('billingForm').hidden = !billing.canEdit;
  $('billingDetailsNote').textContent = billing.canEdit
    ? 'These appear on your invoices. Never enter card numbers here.'
    : 'Only workspace admins can see and change billing details.';
  if (billing.canEdit) for (const [key, id] of Object.entries(fields)) $(id).value = billing.details?.[key] ?? '';
  $('billingSaved').textContent = billing.updatedAt ? `Last saved ${timeAgo(billing.updatedAt)}` : '';
  $('billingSupport').textContent = billing.supportEmail ? `Questions about billing? Write to ${billing.supportEmail}.` : '';
  return billing;
}

/** Off to Stripe Checkout; Stripe sends the person back with ?billing=… */
async function startCheckout(planId, control) {
  if (control) { control.disabled = true; control.textContent = 'Opening Stripe…'; }
  await guard(async () => {
    const { url } = await api('POST', '/api/billing/checkout', { planId });
    window.location.assign(url);
  }, 'billingNotice');
  if (control?.isConnected) control.disabled = false;
}

export async function openBillingPortal() {
  $('billingPortal').disabled = true;
  await guard(async () => {
    const { url } = await api('POST', '/api/billing/portal', {});
    window.location.assign(url);
  }, 'billingNotice');
  $('billingPortal').disabled = false;
}

/**
 * Back from Stripe. The plan changes only when Stripe's signed webhook
 * arrives, which can take a few seconds: wait for it, then say so.
 */
async function handleBillingReturn() {
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get('billing');
  if (!outcome) return;
  params.delete('billing');
  history.replaceState(null, '', `${window.location.pathname}${params.size ? `?${params}` : ''}${window.location.hash}`);
  openSettings();
  activateSettingsSection('billing');
  if (outcome === 'cancelled') return notify('billingNotice', 'info', 'Checkout was cancelled. Nothing was charged.');
  if (outcome !== 'success') return;
  notify('billingNotice', 'info', 'Payment received by Stripe. Activating your plan…');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const billing = await renderBillingSection();
    if (['active', 'trialing'].includes(billing?.stripe?.subscription?.status)) {
      notify('billingNotice', 'ok', `${billing.plan} is active. Thank you!`);
      loadUsage();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  notify('billingNotice', 'warn', 'Stripe has not confirmed the payment yet. It will show here as soon as it does; nothing else is needed from you.');
}

export async function saveBilling() {
  const button = $('billingSave');
  button.disabled = true;
  await guard(async () => {
    await api('PUT', '/api/billing', {
      billingEmail: $('billingEmail').value, companyName: $('billingCompany').value, taxId: $('billingTaxId').value,
      country: $('billingCountry').value, address: $('billingAddress').value
    });
    $('billingSaved').textContent = 'Saved';
  }, 'billingNotice');
  button.disabled = false;
}

export async function renderSecuritySection() {
  const result = await api('GET', '/api/sessions', undefined, { workspace: false }).catch(() => null);
  const sessions = result?.sessions ?? [];
  $('sessionList').replaceChildren(...(sessions.length
    ? sessions.map(item => element('li', { class: 'session-item' }, [
      svgIcon('lock'),
      element('div', {}, [
        element('strong', { text: item.current ? 'This browser' : 'Another browser or device' }),
        element('span', { class: 'small muted', text: `Signed in ${timeAgo(item.createdAt)} · expires ${new Date(item.expiresAt).toLocaleDateString()}` })
      ]),
      item.current ? element('span', { class: 'pill ok', text: 'Current' }) : null
    ].filter(Boolean)))
    : [element('li', { class: 'muted small', text: result ? 'Signed in with an API key only; there are no browser sessions.' : 'Sessions could not be loaded.' })]));
  $('revokeSessions').disabled = sessions.filter(item => !item.current).length === 0;
}

export async function renderWorkspaceTools() {
  const result = await api('GET', '/api/workspace-tools').catch(() => null);
  const host = $('workspaceTools');
  if (!result) { host.replaceChildren(element('li', { class: 'muted small', text: 'Tools could not be loaded.' })); return; }
  if (!result.tools.length) {
    host.replaceChildren(element('li', { class: 'muted small', text: result.sandbox
      ? 'None yet. They appear here when Kindgleam builds one and an admin approves it.'
      : 'None yet. Building tools needs the Kindgleam sandbox, which is not set up on this site.' }));
    return;
  }
  host.replaceChildren(...result.tools.map(tool => element('li', { class: `workspace-tool${tool.status === 'retired' ? ' retired' : ''}` }, [
    element('div', {}, [
      element('strong', { text: tool.title }),
      element('span', { class: 'small muted', text: `${tool.tool} · v${tool.version} · ${tool.language}${tool.packages?.length ? ` · ${tool.packages.join(', ')}` : ''}` }),
      element('span', { class: 'small', text: tool.description })
    ]),
    tool.status === 'retired' ? element('span', { class: 'pill', text: 'Retired' })
      : state.role === 'admin' ? button('Retire', event => retireWorkspaceTool(tool.name, event.currentTarget), 'ghost small')
        : element('span', { class: 'pill ok', text: tool.tested ? 'Tested' : 'Active' })
  ])));
}

async function retireWorkspaceTool(name, control) {
  control.disabled = true;
  await guard(async () => {
    await api('POST', `/api/workspace-tools/${encodeURIComponent(name)}/retire`, {});
    await renderWorkspaceTools();
  }, 'runNotice');
}

export async function revokeOtherSessions() {
  await guard(async () => {
    const { revoked } = await api('POST', '/api/sessions/revoke-others', {}, { workspace: false });
    notify('runNotice', 'ok', revoked ? `Signed out ${revoked} other session${revoked === 1 ? '' : 's'}.` : 'There were no other sessions.');
    await renderSecuritySection();
  }, 'runNotice');
}
let notifyTimer = null;

async function loadNotifications() {
  if (!state.principal || !state.workspaceId) return;
  const result = await api('GET', '/api/notifications').catch(() => null);
  if (!result) return;
  state.notifications = result.notifications;
  const count = $('notifyCount');
  count.hidden = !result.unread;
  count.textContent = result.unread > 9 ? '9+' : String(result.unread);
  $('notifyBell').setAttribute('aria-label', result.unread ? `Notifications, ${result.unread} unread` : 'Notifications');
  if (!$('notifyPanel').hidden) renderNotifications();
}

function renderNotifications() {
  const list = $('notifyList');
  if (!state.notifications.length) {
    list.replaceChildren(element('li', { class: 'muted small notify-empty', text: 'Nothing yet. Reminders and scheduled results appear here.' }));
    return;
  }
  list.replaceChildren(...state.notifications.map(item => {
    const entry = element('li', { class: `notify-item${item.read ? '' : ' unread'}${item.tone === 'alert' ? ' alert' : ''}` }, [
      element('strong', { text: item.title }),
      item.body ? element('span', { class: 'small', text: item.body }) : null,
      element('span', { class: 'small muted', text: timeAgo(item.createdAt) })
    ].filter(Boolean));
    if (item.link) {
      entry.tabIndex = 0;
      entry.setAttribute('role', 'button');
      const open = () => openNotification(item);
      entry.addEventListener('click', open);
      entry.addEventListener('keydown', event => { if (event.key === 'Enter') open(); });
    }
    return entry;
  }));
}

async function openNotification(item) {
  toggleNotifications(false);
  if (!item.read) api('POST', '/api/notifications/read', { ids: [item.id] }).then(loadNotifications).catch(() => {});
  if (item.link?.conversationId) await openChat(item.link.conversationId);
}

function toggleNotifications(open = $('notifyPanel').hidden) {
  $('notifyPanel').hidden = !open;
  $('notifyBell').setAttribute('aria-expanded', String(open));
  if (open) { renderNotifications(); loadNotifications(); }
}

function startNotificationPolling() {
  loadNotifications();
  clearInterval(notifyTimer);
  notifyTimer = setInterval(() => { if (document.visibilityState === 'visible') loadNotifications(); }, 60_000);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function renderSchedules() {
  const result = await api('GET', '/api/schedules').catch(() => null);
  const list = $('scheduleList');
  if (!result) { list.replaceChildren(element('li', { class: 'muted small', text: 'Schedules could not be loaded.' })); return; }
  const active = result.schedules.filter(item => item.active);
  if (!active.length) { list.replaceChildren(element('li', { class: 'muted small', text: 'No schedules yet.' })); return; }
  list.replaceChildren(...active.map(item => element('li', { class: 'schedule-item' }, [
    element('span', { class: 'action-icon' }, [svgIcon(item.kind === 'ask' ? 'chat' : 'bell')]),
    element('div', {}, [
      element('strong', { text: item.title }),
      element('span', { class: 'small muted', text: item.description }),
      element('span', { class: 'small', text: item.nextRunAt ? `Next: ${new Date(item.nextRunAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : '' })
    ]),
    button('Cancel', async event => {
      event.currentTarget.disabled = true;
      await guard(async () => { await api('DELETE', `/api/schedules/${encodeURIComponent(item.id)}`); await renderSchedules(); }, 'runNotice');
    }, 'ghost small')
  ])));
}

function scheduleRuleFromForm() {
  const repeat = $('scheduleRepeat').value;
  if (repeat === 'once') return { type: 'once', at: $('scheduleAt').value };
  if (repeat === 'daily') return { type: 'daily', time: $('scheduleTime').value };
  if (repeat === 'monthly') return { type: 'monthly', day: Number($('scheduleDay').value), time: $('scheduleTime').value };
  return { type: 'weekly', days: [...document.querySelectorAll('#scheduleDaysRow input:checked')].map(input => Number(input.value)), time: $('scheduleTime').value };
}

export function syncScheduleForm() {
  const repeat = $('scheduleRepeat').value;
  $('scheduleAtRow').hidden = repeat !== 'once';
  $('scheduleTimeRow').hidden = repeat === 'once';
  $('scheduleDaysRow').hidden = repeat !== 'weekly';
  $('scheduleDayRow').hidden = repeat !== 'monthly';
}
/* ------------------------------------------------------------- memory */

export async function renderMemories() {
  const list = $('memoryList');
  const result = await api('GET', '/api/memories').catch(() => null);
  if (!result) { list.replaceChildren(element('li', { class: 'muted small', text: 'Memory could not be loaded.' })); return; }
  $('memoryClear').hidden = !result.memories.length;
  if (!result.memories.length) {
    list.replaceChildren(element('li', { class: 'muted small', text: result.crossChatMemory
      ? 'No cross-chat memories saved yet.'
      : 'Cross-chat memory is off. Each chat still keeps its own memory automatically.' }));
    return;
  }
  list.replaceChildren(...result.memories.map(item => element('li', { class: 'memory-item' }, [
    element('span', { class: 'action-icon' }, [svgIcon('memory')]),
    element('span', { class: 'memory-text', text: item.content }),
    button('Delete', async event => {
      event.currentTarget.disabled = true;
      await guard(async () => { await api('DELETE', `/api/memories/${encodeURIComponent(item.id)}`); await renderMemories(); }, 'runNotice');
    }, 'ghost small')
  ])));
}

async function addMemory() {
  const content = $('memoryInput').value.trim();
  if (!content) return;
  $('memoryAdd').disabled = true;
  await guard(async () => {
    await api('POST', '/api/memories', { content, kind: 'about' });
    $('memoryInput').value = '';
    await renderMemories();
  }, 'runNotice');
  $('memoryAdd').disabled = false;
}

/** First use: the person confirms their age and accepts the terms, once per version. */
async function ensureTerms() {
  const status = await api('GET', '/api/terms', undefined, { workspace: false }).catch(() => null);
  if (!status || status.accepted) return;
  const dialog = $('termsDialog');
  $('termsMinimumAge').textContent = String(status.minimumAge);
  const sync = () => { $('termsContinue').disabled = !($('termsAge').checked && $('termsAccept').checked); };
  $('termsAge').addEventListener('change', sync);
  $('termsAccept').addEventListener('change', sync);
  // It cannot be dismissed: nothing is used before the terms are accepted.
  dialog.addEventListener('cancel', event => event.preventDefault());
  dialog.showModal();
  await new Promise(resolve => {
    $('termsForm').addEventListener('submit', async event => {
      event.preventDefault();
      $('termsContinue').disabled = true;
      try {
        await api('POST', '/api/terms', { version: status.version, ageConfirmed: $('termsAge').checked, accept: $('termsAccept').checked }, { workspace: false });
        dialog.close();
        resolve();
      } catch (error) {
        notify('termsNotice', 'warn', error.message);
        sync();
      }
    });
  });
}

export async function enterApp() {
  $('landing').hidden = true;
  const me = await api('GET', '/api/me', undefined, { workspace: false });
  state.principal = me.principal;
  state.workspaces = me.workspaces;

  if (!me.workspaces.length) {
    await showGate();
    return notify('gateNotice', 'warn', 'This account is not a member of any workspace yet.');
  }

  state.workspaceId = me.workspaces[0].id;
  state.role = me.workspaces[0].role;
  $('workspace').replaceChildren(...me.workspaces.map(workspace =>
    element('option', { value: workspace.id, text: `${workspace.name} · ${workspace.role}` })));
  $('workspace').value = state.workspaceId;

  $('gate').hidden = true;
  $('app').hidden = false;
  // Who is signed in shows at once, even behind the first-use terms prompt.
  $('who').textContent = state.principal.name;
  $('userInitial').textContent = (state.principal.name || '?').trim().charAt(0).toUpperCase();
  await ensureTerms();
  await loadPreferences();
  await loadExecutionConfig().catch(() => {
    state.executionConfig = { targets: [], localAgentUrl: null, reasoning: { configured: false } };
  });
  applyRole();
  newChat();
  const draft = readDraft();
  if (draft?.text && draft.workspaceId === state.workspaceId) {
    $('goal').value = draft.text;
    growComposer();
    setSaveState('Draft restored', 'ok');
  }
  updateConnectionUI();
  await selectTab('runs');
  for (const item of state.network.queue) await loadOfflineFiles(item);
  flushOfflineQueue().catch(() => {});
  loadUsage();
  startNotificationPolling();
  handleBillingReturn();
}

export async function signIn(event) {
  event.preventDefault();
  try {
    clearNotice('gateNotice');
    await api('POST', '/api/session', { apiKey: $('apiKey').value.trim() }, { workspace: false });
    $('apiKey').value = '';
    await enterApp();
  } catch (error) {
    notify('gateNotice', 'bad', error.status === 401 ? 'That access key was not accepted.' : error.message);
  }
}

/* ------------------------------------------------------------ email sign-in */

const gate = { options: null, email: '', token: '', code: '', resendTimer: 0 };
const GATE_STEPS = ['gateEmail', 'gateSent', 'gateConfirm', 'gateKey'];

/**
 * A sign-in link opens the app with ?signin=<token>. Take the token out of
 * the address bar at once, so it is not left in history or shared by accident.
 */
export function takeSignInToken() {
  const url = new URL(location.href);
  const token = url.searchParams.get('signin');
  if (!token) return '';
  url.searchParams.delete('signin');
  history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
  gate.token = token;
  return token;
}

function showStep(step) {
  for (const id of GATE_STEPS) $(id).hidden = id !== step;
  // The switch offers the other way in, when this server has both.
  const both = gate.options?.email !== false;
  $('gateSwitch').hidden = !both || !['gateEmail', 'gateKey'].includes(step);
  $('gateSwitchButton').textContent = step === 'gateKey' ? 'Continue with email instead' : 'Sign in with an access key';
  const focus = { gateEmail: 'signinEmail', gateKey: 'apiKey', gateConfirm: 'copyCode', gateSent: 'signinCode' }[step];
  requestAnimationFrame(() => $(focus)?.focus());
}

/** Show the sign-in card at the right step: confirm a link, email, or key. */
export async function showGate() {
  $('app').hidden = true;
  $('landing').hidden = true;
  $('gate').hidden = false;
  if (!gate.options) {
    gate.options = await api('GET', '/api/sign-in/options', undefined, { workspace: false, retries: 1 })
      .catch(() => ({ email: false, accessKey: true }));
  }
  if (gate.token) return showLinkCode();
  showStep(gate.options.email ? 'gateEmail' : 'gateKey');
}

/** Opened from the email: show the link's code, to type where sign-in started. */
async function showLinkCode() {
  showStep('gateConfirm');
  $('linkCode').textContent = '•••• ••••';
  try {
    const { code, email, expiresAt } = await api('POST', '/api/sign-in/email/link-code', { token: gate.token }, { workspace: false, retries: 1 });
    gate.code = code;
    $('linkCode').textContent = `${code.slice(0, 4)} ${code.slice(4)}`;
    $('codeFor').textContent = email;
    $('codeForWrap').hidden = !email;
    $('codeMinutes').textContent = String(Math.max(1, Math.round((new Date(expiresAt) - Date.now()) / 60_000)));
  } catch (error) {
    gate.token = '';
    showStep(gate.options?.email === false ? 'gateKey' : 'gateEmail');
    notify('gateNotice', 'warn', error.status === 401
      ? 'This sign-in link has expired or was already used. Enter your email to get a new one.'
      : error.message);
  }
}

function startResendCooldown(seconds = 30) {
  clearInterval(gate.resendTimer);
  const resend = $('resendLink');
  let left = seconds;
  const tick = () => {
    resend.disabled = left > 0;
    resend.textContent = left > 0 ? `Resend email in ${left}s` : 'Resend email';
    if (left-- <= 0) clearInterval(gate.resendTimer);
  };
  tick();
  gate.resendTimer = setInterval(tick, 1000);
}

async function sendSignInLink() {
  const email = $('signinEmail').value.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return notify('gateNotice', 'warn', 'Enter a valid email address, like you@example.com.');
  }
  clearNotice('gateNotice');
  const submit = $('emailContinue');
  submit.disabled = true;
  submit.textContent = 'Sending…';
  try {
    const sent = await api('POST', '/api/sign-in/email', { email }, { workspace: false, retries: 0 });
    gate.email = sent.email;
    $('sentTo').textContent = sent.email;
    $('sentMinutes').textContent = String(sent.expiresInMinutes ?? 15);
    $('signinCode').value = '';
    showStep('gateSent');
    startResendCooldown();
  } catch (error) {
    notify('gateNotice', 'bad', error.status === 429 ? 'Too many attempts. Wait a minute and try again.' : error.message);
  } finally {
    submit.disabled = false;
    submit.textContent = 'Continue with email';
  }
}

async function confirmSignInLink() {
  const confirm = $('confirmSignin');
  confirm.disabled = true;
  confirm.textContent = 'Signing in…';
  clearNotice('gateNotice');
  try {
    await api('POST', '/api/sign-in/email/verify', { token: gate.token }, { workspace: false, retries: 0 });
    gate.token = '';
    await enterApp();
  } catch (error) {
    gate.token = '';
    showStep(gate.options?.email === false ? 'gateKey' : 'gateEmail');
    notify('gateNotice', 'warn', error.status === 401
      ? 'This sign-in link has expired or was already used. Enter your email to get a new one.'
      : error.message);
  } finally {
    confirm.disabled = false;
    confirm.textContent = 'Sign in on this device instead';
  }
}

/** Show the code as "1234 5678" while it is typed or pasted. */
function formatCode(input) {
  const digits = input.value.replace(/\D/g, '').slice(0, 8);
  input.value = digits.length > 4 ? `${digits.slice(0, 4)} ${digits.slice(4)}` : digits;
  return digits;
}

async function submitSignInCode() {
  const input = $('signinCode');
  const code = formatCode(input);
  if (code.length !== 8) return notify('gateNotice', 'warn', 'Enter all 8 digits of the code from the email.');
  const submit = $('codeSubmit');
  if (submit.disabled) return;
  submit.disabled = true;
  submit.textContent = 'Signing in…';
  clearNotice('gateNotice');
  try {
    await api('POST', '/api/sign-in/email/code', { email: gate.email, code }, { workspace: false, retries: 0 });
    await enterApp();
  } catch (error) {
    input.value = '';
    input.focus();
    notify('gateNotice', 'bad', error.status === 429 ? 'Too many attempts. Wait a minute and try again.' : error.message);
  } finally {
    submit.disabled = false;
    submit.textContent = 'Sign in';
  }
}

/** Wire the sign-in card once, at start-up. */
export function initGate() {
  const openSignIn = () => { showGate().catch(error => notify('gateNotice', 'bad', error.message)); };
  $('landingSignIn')?.addEventListener('click', openSignIn);
  $('landingSignInPrimary')?.addEventListener('click', openSignIn);
  $('emailSignin').addEventListener('submit', event => { event.preventDefault(); sendSignInLink(); });
  $('resendLink').addEventListener('click', async () => {
    $('signinEmail').value = gate.email;
    await sendSignInLink();
  });
  $('changeEmail').addEventListener('click', () => {
    clearInterval(gate.resendTimer);
    clearNotice('gateNotice');
    showStep('gateEmail');
  });
  $('confirmSignin').addEventListener('click', confirmSignInLink);
  $('copyCode').addEventListener('click', async () => {
    if (!gate.code) return;
    try {
      await navigator.clipboard.writeText(gate.code);
      $('copyCode').textContent = 'Copied';
    } catch {
      $('copyCode').textContent = 'Select the code to copy it';
    }
    setTimeout(() => { $('copyCode').textContent = 'Copy code'; }, 2000);
  });
  $('codeForm').addEventListener('submit', event => { event.preventDefault(); submitSignInCode(); });
  // All 8 digits typed or pasted: sign in without another click.
  $('signinCode').addEventListener('input', event => { if (formatCode(event.target).length === 8) submitSignInCode(); });
  $('gateSwitchButton').addEventListener('click', () => {
    clearNotice('gateNotice');
    showStep($('gateKey').hidden ? 'gateKey' : 'gateEmail');
  });
}

export async function signOut() {
  await api('DELETE', '/api/session', undefined, { workspace: false }).catch(() => {});
  clearDraft();
  try { sessionStorage.removeItem(OFFLINE_QUEUE_KEY); } catch {}
  await clearOfflineFiles();
  location.reload();
}

/** Start-up work of this part, run by app.js at the point it always ran. */
export function initAccount() {
  /* ------------------------------------------------ notifications and schedules */

  state.notifications = [];
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadNotifications(); });
  $('scheduleDaysRow').append(...WEEKDAYS.map((name, index) => element('label', { class: 'day-chip' }, [
    element('input', { type: 'checkbox', value: String(index), ...(index === 1 ? { checked: true } : {}) }), element('span', { text: name })
  ])));
  $('scheduleRepeat').addEventListener('change', syncScheduleForm);
  $('scheduleCreate').addEventListener('click', async () => {
    const title = $('scheduleTitle').value.trim();
    const message = $('scheduleMessage').value.trim() || title;
    if (!title) return notify('runNotice', 'warn', 'Give the reminder a title.');
    $('scheduleCreate').disabled = true;
    await guard(async () => {
      const { schedule } = await api('POST', '/api/schedules', {
        title, kind: 'reminder', payload: { message }, rule: scheduleRuleFromForm(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      });
      $('scheduleSaved').textContent = `Added: ${schedule.description}`;
      $('scheduleTitle').value = '';
      $('scheduleMessage').value = '';
      await renderSchedules();
    }, 'runNotice');
    $('scheduleCreate').disabled = false;
  });
  $('memoryAdd').addEventListener('click', addMemory);
  $('openMemorySettings').addEventListener('click', () => { activateSettingsSection('personalization'); $('memoryList').scrollIntoView({ block: 'center' }); });
  $('memoryInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addMemory(); } });
  $('memoryClear').addEventListener('click', async () => {
    if (!confirm('Forget everything Kindgleam remembers about you in this workspace?')) return;
    await guard(async () => { await api('DELETE', '/api/memories'); await renderMemories(); }, 'runNotice');
  });
  $('setCrossChatMemory').addEventListener('change', () => setTimeout(renderMemories, 300));
  $('notifyBell').addEventListener('click', event => { event.stopPropagation(); toggleNotifications(); });
  $('notifyReadAll').addEventListener('click', async () => {
    await api('POST', '/api/notifications/read', {}).catch(() => {});
    await loadNotifications();
  });
  document.addEventListener('click', event => {
    if (!$('notifyPanel').hidden && !$('notifyPanel').contains(event.target) && !$('notifyBell').contains(event.target)) toggleNotifications(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('notifyPanel').hidden) {
      toggleNotifications(false);
      // One Escape closes one thing: the panel now, the menu next time.
      event.preventDefault();
    }
  });
}
