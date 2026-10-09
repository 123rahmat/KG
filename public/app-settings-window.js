/**
 * Kindgleam — browser client: The settings window: its sections, search, and saving each change.
 * Part of app.js, split out by concern; app.js wires the page together.
 */

import { state, $, element, api, notify, guard, capabilities } from './ui-core.js';
import { loadUsage, openBillingPortal, renderBillingSection, renderMemories, renderSchedules, renderSecuritySection, renderUsageSection, renderWorkspaceTools, revokeOtherSessions, selectTab, syncScheduleForm } from './app-account.js';
import { setupVoiceInput, svgIcon } from './app.js';
import { DEFAULT_SETTINGS, applyTheme, persistPreferencePatch, saveSettings } from './app-settings.js';
import { renderReports } from './app-actions.js';
import { loadPolicyControls, initPolicyControls } from './governance-controls.js';

/* ---------------------------------------------------------- settings window */

const SETTING_FIELDS = [
  ['setLanguage', 'language'], ['setStyle', 'style'], ['setLength', 'length'], ['setCountry', 'country'],
  ['setAbout', 'about'], ['setConsent', 'consent'], ['setShare', 'share'], ['setTheme', 'theme'], ['setEnter', 'enterSends'],
  ['setAutonomy', 'autonomy'], ['setAdaptiveIntensity', 'adaptiveIntensity'], ['setAdaptiveDepth', 'adaptiveDepth'],
  ['setCapabilityInvestment', 'capabilityInvestment'], ['setAllowAdaptiveExpansion', 'allowAdaptiveExpansion'],
  ['setReducedMotion', 'reducedMotion'],
  ['setHighContrast', 'highContrast'], ['setNotifications', 'notifications'], ['setExternalContext', 'externalContext'],
  ['setVoiceInput', 'voiceInput'], ['setVoiceLanguage', 'voiceLanguage'], ['setOfflineQueue', 'offlineQueue'], ['setCrossChatMemory', 'crossChatMemory']
];

async function renderSkillLearning() {
  const list = $('skillLearningList');
  if (!list) return;
  const result = await api('GET', '/api/skills/profiles').catch(() => null);
  const profiles = Array.isArray(result?.profiles) ? result.profiles : [];
  if (!result) {
    list.replaceChildren(element('li', { class: 'muted small', text: 'Couldn’t load learned work patterns right now.' }));
    return;
  }
  if (!profiles.length) {
    list.replaceChildren(element('li', { class: 'muted small', text: 'No learned work patterns yet. Completed and rated work will teach the adaptive layer over time.' }));
    return;
  }
  list.replaceChildren(...profiles.slice(0, 8).map(item => {
    const attempts = Number(item.attempts ?? 0);
    const success = Number(item.success ?? 0);
    const failure = Number(item.failure ?? 0);
    const confidence = Number(item.confidence ?? 0.5);
    const taskType = item.taskType ? ' · ' + item.taskType : '';
    return element('li', { class: 'memory-item' }, [
      element('span', { class: 'action-icon' }, [svgIcon('sparkle')]),
      element('span', { class: 'memory-text' }, [
        element('strong', { text: (item.skillName || 'skill') + taskType }),
        element('span', { class: 'small muted', text: attempts + ' observations · ' + success + ' successful · ' + failure + ' failed · ' + Math.round(confidence * 100) + '% confidence' })
      ])
    ]);
  }));
}
/** Server-owned, opt-in specialist library. No source code or secrets in UI. */
async function renderSavedSpecialists() {
  const list = $('savedSpecialistList');
  if (!list) return;
  if (!state.settings.crossChatMemory) {
    list.replaceChildren(element('li', { class: 'muted small',
      text: 'Cross-chat learning is off. Enable “Use memory across chats” to save and reuse verified expertise.' }));
    return;
  }
  const result = await api('GET', '/api/specialists/saved').catch(() => null);
  if (!result) {
    list.replaceChildren(element('li', { class: 'muted small',
      text: 'Saved specialists are unavailable right now.' }));
    return;
  }
  const records = Array.isArray(result?.specialists) ? result.specialists : [];
  if (!records.length) {
    list.replaceChildren(element('li', { class: 'muted small',
      text: 'No verified specialist recipes saved in this workspace yet.' }));
    return;
  }
  list.replaceChildren(...records.slice(0, 20).map(item => {
    const id = String(item?.id || '').slice(0, 80);
    const surface = ['normal-chat', 'code', 'research'].includes(item?.surface) ? item.surface : 'normal-chat';
    const status = item.status === 'reusable' ? 'Reusable after repeated verification' : 'Observed · awaiting more verification';
    const count = Math.max(0, Number(item.verifiedExamples) || 0);
    const description = String(item.description || id).slice(0, 160);
    const children = [
      element('span', { class: 'action-icon' }, [svgIcon('sparkle')]),
      element('span', { class: 'memory-text' }, [
        element('strong', { text: description }),
        element('span', { class: 'small muted', text: surface + ' · ' + status + ' · ' + count + ' verified runs' })
      ])
    ];
    if (['admin', 'editor'].includes(state.role) && id) {
      children.push(element('button', {
        type: 'button', class: 'ghost small danger-text', text: 'Forget',
        'aria-label': 'Forget saved specialist ' + id,
        onclick: async () => {
          if (!confirm('Forget this saved specialization?')) return;
          try {
            await api('DELETE', '/api/specialists/saved/' + encodeURIComponent(id)
              + '?surface=' + encodeURIComponent(surface));
            await renderSavedSpecialists();
          } catch {
            list.prepend(element('li', { class: 'muted small',
              text: 'Could not forget the specialist. Check your permissions and retry.' }));
          }
        }
      }));
    }
    return element('li', { class: 'memory-item' }, children);
  }));
}
function renderCapabilities() {
  const can = capabilities();
  const rows = [
    [can.ai, can.ai ? 'Adaptive Gemini reasoning is available' : 'Gemini reasoning is not configured'],
    [can.ai, 'Read text files you attach (documents, notes, CSV, code)'],
    [can.research, 'Search the web for research'],
    [can.runCode, 'Run and test code'],
    [true, 'Ask before anything risky, and let you check results']
  ];
  $('capabilityList').replaceChildren(...rows.map(([ok, label]) => element('li', { class: ok ? 'yes' : 'no' }, [
    element('span', { class: 'cap-mark', 'aria-hidden': 'true', text: ok ? '✓' : '—' }),
    element('span', { text: ok ? label : `${label}: not set up` })
  ])));
}

export function openSettings() {
  syncPlatformSections();
  activateSettingsSection('general');
  $('settingsSearch').value = '';
  const avatar = $('settingsAvatar');
  const largeAvatar = $('settingsAvatarLarge');
  const initial = (state.principal?.name || '?').trim().charAt(0).toUpperCase();
  if (avatar) avatar.textContent = initial;
  if (largeAvatar) largeAvatar.textContent = initial;
  const miniName = $('settingsAccountName');
  const miniRole = $('settingsAccountRole');
  if (miniName) miniName.textContent = state.principal?.name || 'Account';
  if (miniRole) miniRole.textContent = state.workspaces.find(item => item.id === state.workspaceId)?.name || 'Personal workspace';
  for (const [id, key] of SETTING_FIELDS) {
    const field = $(id);
    if (field.type === 'checkbox') field.checked = Boolean(state.settings[key]);
    else field.value = state.settings[key] ?? '';
  }
  renderCapabilities();
  $('accountLine').textContent = `${state.principal.name} · ${state.role} in ${state.workspaces.find(item => item.id === state.workspaceId)?.name ?? state.workspaceId}`;
  document.body.classList.remove('chats-open');
  $('settings').showModal();
}
/* ------------------------------------------------------------ email sending (platform admins) */

const MAIL_PRESETS = {
  gmail: { host: 'smtp.gmail.com', port: 465, security: 'tls', hint: 'For Gmail, create an app password in your Google Account under Security → App passwords. Your normal password will not work.' },
  outlook: { host: 'smtp.office365.com', port: 587, security: 'starttls', hint: 'For Outlook or Microsoft 365, use your email password, or an app password if two-step sign-in is on.' },
  yahoo: { host: 'smtp.mail.yahoo.com', port: 465, security: 'tls', hint: 'For Yahoo, generate an app password in Account security.' },
  custom: { hint: 'Use the SMTP details from your email provider.' }
};

const isPlatformAdmin = () => state.principal?.platformAdmin === true;

/** Platform-only sections exist in the page for everyone, shown only to platform admins. */
export function syncPlatformSections() {
  for (const node of document.querySelectorAll('[data-platform-only]')) {
    if (!isPlatformAdmin()) node.hidden = true;
    else if (node.classList.contains('settings-nav-item')) node.hidden = false;
  }
}

function presetFor(host) {
  return Object.entries(MAIL_PRESETS).find(([, preset]) => preset.host === host)?.[0] ?? 'custom';
}

function applyMailPreset(name, { keepServer = false } = {}) {
  const preset = MAIL_PRESETS[name] ?? MAIL_PRESETS.custom;
  if (!keepServer && preset.host) {
    $('mailHost').value = preset.host;
    $('mailPort').value = String(preset.port);
    $('mailSecurity').value = preset.security;
  }
  $('mailServerRow').hidden = name !== 'custom';
  $('mailPasswordHint').textContent = preset.hint;
}

function showMailStatus(mail) {
  const card = $('mailStatus');
  card.classList.toggle('ok', mail.configured);
  card.classList.toggle('warn', !mail.configured);
  card.replaceChildren(
    element('strong', { text: mail.configured ? `Sign-in links are sent from ${mail.fromEmail}` : 'Email sending is not set up yet' }),
    element('p', { text: mail.configured
      ? `Through ${mail.host}:${mail.port}. ${mail.passwordSet ? 'The password is saved, encrypted.' : 'No password saved.'}`
      : mail.fallback === 'server-log'
        ? 'Until it is, sign-in links are printed to the server log (development only). People can still use access keys.'
        : 'Until it is, people can only sign in with access keys.' })
  );
}

async function renderMailSection() {
  if (!isPlatformAdmin()) return;
  const { mail } = await api('GET', '/api/admin/mail', undefined, { workspace: false });
  showMailStatus(mail);
  if (mail.configured) {
    $('mailUsername').value = mail.username;
    $('mailFromName').value = mail.fromName;
    $('mailHost').value = mail.host;
    $('mailPort').value = String(mail.port);
    $('mailSecurity').value = mail.security;
    $('mailPreset').value = presetFor(mail.host);
    applyMailPreset($('mailPreset').value, { keepServer: true });
  } else {
    $('mailUsername').value ||= state.principal.email ?? '';
    $('mailFromName').value ||= 'Kindgleam';
    applyMailPreset($('mailPreset').value);
  }
  $('mailPassword').value = '';
}

async function saveMail() {
  const button = $('mailSave');
  button.disabled = true;
  try {
    const { mail } = await api('PUT', '/api/admin/mail', {
      host: $('mailHost').value.trim(),
      port: Number($('mailPort').value),
      security: $('mailSecurity').value,
      username: $('mailUsername').value.trim(),
      password: $('mailPassword').value,
      fromName: $('mailFromName').value.trim(),
      fromEmail: $('mailUsername').value.trim()
    }, { workspace: false });
    $('mailPassword').value = '';
    showMailStatus(mail);
    notify('mailNotice', 'ok', 'Saved. Send a test email to check it works.');
  } catch (error) {
    notify('mailNotice', 'bad', error.message);
  } finally {
    button.disabled = false;
  }
}

async function testMail() {
  const button = $('mailTest');
  button.disabled = true;
  button.textContent = 'Sending…';
  try {
    const result = await api('POST', '/api/admin/mail/test', { to: state.principal.email ?? $('mailUsername').value.trim() }, { workspace: false, retries: 0 });
    notify('mailNotice', result.delivered ? 'ok' : 'warn', result.delivered
      ? `Test email sent to ${result.to}. Check that inbox (and spam).`
      : 'Not sent: no account is saved yet, so it was printed to the server log.');
  } catch (error) {
    notify('mailNotice', 'bad', error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Send a test email';
  }
}

export function activateSettingsSection(name) {
  const sections = [...document.querySelectorAll('.settings-section')];
  const buttons = [...document.querySelectorAll('.settings-nav-item')];
  const allowed = item => item.dataset.platformOnly === undefined || isPlatformAdmin();
  const section = sections.find(item => item.dataset.settingsSection === name && allowed(item)) || sections[0];
  if (!section) return;
  const activeName = section.dataset.settingsSection;
  sections.forEach(item => { item.classList.toggle('active', item === section); item.hidden = item !== section; });
  buttons.forEach(item => item.classList.toggle('active', item.dataset.settingsSection === activeName));
  $('settingsTitle').textContent = section.dataset.settingsTitle || 'Settings';
  $('settingsDescription').textContent = section.dataset.settingsDescription || '';
  $('settingsContent').scrollTop = 0;
  // Live sections load when opened, so they always show the current state.
  if (activeName === 'usage') { renderUsageSection(); loadUsage(); }
  if (activeName === 'billing') renderBillingSection();
  if (activeName === 'security') renderSecuritySection();
  if (activeName === 'policies') loadPolicyControls();
  if (activeName === 'workspace') { renderWorkspaceTools(); renderReports(); }
  if (activeName === 'schedules') { renderSchedules(); syncScheduleForm(); }
  if (activeName === 'personalization') { renderMemories(); renderSkillLearning(); renderSavedSpecialists(); }
  if (activeName === 'mail') renderMailSection().catch(error => notify('mailNotice', 'bad', error.message));
}
// Resetting asks on the button itself: a second click within a few seconds.
let resetArmedUntil = 0;

/** Start-up work of this part, run by app.js at the point it always ran. */
export function initSettingsWindow() {
  initPolicyControls();
  // Every change is saved at once; there is no separate save button to miss.
  $('settingsForm').addEventListener('input', event => {
    const entry = SETTING_FIELDS.find(([id]) => id === event.target.id);
    if (!entry) return;
    state.settings[entry[1]] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    saveSettings();
    persistPreferencePatch(entry[1], state.settings[entry[1]]);
    if (entry[1] === 'theme') applyTheme();
    if (entry[1] === 'share' && !state.chat.runs.length) $('shareRun').checked = state.settings.share;
    if (entry[1] === 'consent' && state.settings.consent) state.chat.consent = true;
    if (entry[1] === 'voiceInput' || entry[1] === 'voiceLanguage') setupVoiceInput();
    if (entry[1] === 'crossChatMemory') renderSavedSpecialists();
  });
  $('openSettings').addEventListener('click', openSettings);
  $('usageRing').addEventListener('click', () => { openSettings(); activateSettingsSection('usage'); });
  $('billingPortal').addEventListener('click', openBillingPortal);
  $('revokeSessions').addEventListener('click', revokeOtherSessions);
  $('settingsFiles').addEventListener('click', () => { $('settings').close(); selectTab('objects'); });
  $('settingsActivity').addEventListener('click', () => { $('settings').close(); selectTab('audit'); });
  $('skillLearningRefresh')?.addEventListener('click', renderSkillLearning);
  $('savedSpecialistRefresh')?.addEventListener('click', renderSavedSpecialists);
  $('skillLearningClear')?.addEventListener('click', async () => {
    if (!confirm('Forget all learned work patterns for this workspace?')) return;
    await guard(async () => {
      await api('DELETE', '/api/skills/profiles');
      await renderSkillLearning();
    }, 'runNotice');
  });
  document.querySelectorAll('.settings-nav-item').forEach(button => {
    button.addEventListener('click', () => {
      $('settingsSearch').value = '';
      activateSettingsSection(button.dataset.settingsSection);
    });
  });
  $('settingsSearch').addEventListener('input', event => {
    const query = event.target.value.trim().toLowerCase();
    const sections = [...document.querySelectorAll('.settings-section')];
    if (!query) {
      activateSettingsSection(document.querySelector('.settings-nav-item.active')?.dataset.settingsSection || 'general');
      return;
    }
    const matches = sections.filter(section => section.textContent.toLowerCase().includes(query)
      && (section.dataset.platformOnly === undefined || isPlatformAdmin()));
    sections.forEach(section => { section.hidden = !matches.includes(section); section.classList.toggle('active', matches.includes(section)); });
    document.querySelectorAll('.settings-nav-item').forEach(button => button.classList.toggle('active', matches.length === 1 && button.dataset.settingsSection === matches[0].dataset.settingsSection));
    $('settingsTitle').textContent = matches.length === 1 ? (matches[0].dataset.settingsTitle || 'Settings') : 'Search results';
    $('settingsDescription').textContent = matches.length ? 'Settings matching your search.' : 'No settings matched your search.';
    $('settingsContent').scrollTop = 0;
  });
  $('settingsClose').addEventListener('click', () => $('settings').close());
  $('mailPreset').addEventListener('change', event => applyMailPreset(event.target.value));
  $('mailSave').addEventListener('click', saveMail);
  $('mailTest').addEventListener('click', testMail);
  activateSettingsSection('general');
  $('resetSettings').addEventListener('click', event => {
    const control = event.currentTarget;
    if (Date.now() > resetArmedUntil) {
      resetArmedUntil = Date.now() + 4000;
      control.textContent = 'Click again to reset';
      control.classList.add('danger-text');
      setTimeout(() => {
        if (Date.now() < resetArmedUntil) return;
        control.textContent = 'Reset to defaults';
        control.classList.remove('danger-text');
      }, 4100);
      return;
    }
    resetArmedUntil = 0;
    control.textContent = 'Reset to defaults';
    control.classList.remove('danger-text');
    state.settings = { ...DEFAULT_SETTINGS };
    saveSettings();
    applyTheme();
    for (const [id, key] of SETTING_FIELDS) {
      const field = $(id);
      if (field.type === 'checkbox') field.checked = Boolean(state.settings[key]);
      else field.value = state.settings[key] ?? '';
      persistPreferencePatch(key, state.settings[key]);
    }
    $('settingsSearch').value = '';
    for (const group of $('settingsForm').querySelectorAll('.settings-group')) group.hidden = false;
    syncPlatformSections();
    setupVoiceInput();
  });
}
