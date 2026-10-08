/** Scoped policy controls with revision checks and guarded async updates. */
import { state, $, api, notify } from './ui-core.js';

let loaded = null;
let generation = 0;
const fields = ['policyApproval', 'policyTokens', 'policyDeniedTools', 'policyAdvanced'];
const current = snapshot => snapshot.workspaceId === state.workspaceId && snapshot.principalId === state.principal?.id && snapshot.layer === $('policyLayer').value;
const disable = disabled => {
  fields.forEach(id => { $(id).disabled = disabled; });
  $('policySave').disabled = disabled;
};

function renderEffective(effective) {
  const controls = effective?.constraints;
  if (!controls || effective.status !== 'evaluated') {
    $('policyEffective').textContent = 'Mandatory policy is unavailable. Execution cannot continue.';
    return;
  }
  const parts = [controls.requireHumanApproval ? 'Human approval is required.' : 'No policy requires additional human approval.',
    controls.maxTokens === null ? 'No policy token cap is configured.' : `Run token cap: ${controls.maxTokens.toLocaleString()}.`];
  for (const [key, label] of [['deniedTools', 'Blocked tools'], ['deniedModels', 'Blocked models'], ['deniedDataClasses', 'Blocked data classes'], ['deniedCapabilities', 'Blocked capabilities']]) {
    if (controls[key]?.length) parts.push(`${label}: ${controls[key].join(', ')}.`);
  }
  for (const [key, label] of [['allowedToolsGroups', 'Allowed tools'], ['allowedModelsGroups', 'Allowed models'], ['allowedDataClassesGroups', 'Allowed data classes']]) {
    if (controls[key]?.length) parts.push(`${label} must match every group: ${controls[key].map(rules => rules.length ? '[' + rules.join(', ') + ']' : '[none]').join(' and ')}.`);
  }
  $('policyEffective').textContent = parts.join(' ');
}

export async function loadPolicyControls() {
  if (!state.workspaceId) return;
  const snapshot = { workspaceId: state.workspaceId, principalId: state.principal?.id, layer: $('policyLayer').value, generation: ++generation };
  loaded = null;
  disable(true);
  $('policyAuthority').textContent = 'Loading current policy…';
  $('policyEffective').textContent = '';
  try {
    const [row, result] = await Promise.all([
      api('GET', '/api/governance?layer=' + encodeURIComponent(snapshot.layer), undefined, { workspaceId: snapshot.workspaceId }),
      api('GET', '/api/governance/effective', undefined, { workspaceId: snapshot.workspaceId })
    ]);
    if (!current(snapshot) || snapshot.generation !== generation) return;
    loaded = { ...snapshot, row };
    const policy = { ...(row.policy ?? {}) };
    $('policyApproval').checked = policy.requireHumanApproval === true;
    $('policyTokens').value = policy.maxTokens ?? '';
    $('policyDeniedTools').value = (policy.deniedTools ?? []).join('\n');
    delete policy.requireHumanApproval; delete policy.maxTokens; delete policy.deniedTools;
    $('policyAdvanced').value = JSON.stringify(policy, null, 2);
    $('policyAuthority').textContent = row.canEdit
      ? snapshot.layer === 'user' ? 'Your personal restrictions. Higher-level restrictions still apply.' : `You can manage ${snapshot.layer} policy. Changes are recorded in the audit trail.`
      : snapshot.layer === 'organization' ? 'Read only. An explicitly provisioned organization administrator manages this policy.' : 'Read only. A workspace administrator manages this policy.';
    renderEffective(result.effective);
    disable(row.canEdit !== true);
    notify('policyNotice', 'info', 'Existing runs keep their original restrictions. New restrictions apply at their next execution boundary.');
  } catch (error) {
    if (current(snapshot) && snapshot.generation === generation) {
      $('policyAuthority').textContent = 'Policy could not be loaded.';
      notify('policyNotice', 'bad', error.message);
    }
  }
}

export async function savePolicyControls() {
  const snapshot = loaded;
  if (!snapshot || !current(snapshot) || snapshot.row.canEdit !== true || $('policySave').disabled) return;
  let policy;
  try {
    policy = JSON.parse($('policyAdvanced').value || '{}');
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Additional restrictions must be a JSON object.');
    policy.requireHumanApproval = $('policyApproval').checked;
    const tokens = $('policyTokens').value.trim();
    if (tokens) policy.maxTokens = Number(tokens); else delete policy.maxTokens;
    policy.deniedTools = [...new Set($('policyDeniedTools').value.split(/[\n,]/).map(value => value.trim()).filter(Boolean))];
  } catch (error) {
    notify('policyNotice', 'bad', error.message);
    return;
  }
  disable(true);
  try {
    await api('POST', '/api/governance', { layer: snapshot.layer, policy, expectedRevision: snapshot.row.revision },
      { workspaceId: snapshot.workspaceId, retries: 0 });
    if (!current(snapshot) || snapshot.generation !== generation) return;
    await loadPolicyControls();
    if (current(snapshot)) notify('policyNotice', 'ok', 'Policy saved. Original run restrictions remain in effect.');
  } catch (error) {
    if (!current(snapshot) || snapshot.generation !== generation) return;
    disable(false);
    notify('policyNotice', 'bad', error.code === 'policy-revision-conflict'
      ? 'Someone changed this policy. Reload it and review their changes before saving.' : error.message);
    if (error.code === 'policy-revision-conflict') $('policySave').disabled = true;
  }
}

export function initPolicyControls() {
  $('policyLayer').addEventListener('change', loadPolicyControls);
  $('policyReload').addEventListener('click', loadPolicyControls);
  $('policySave').addEventListener('click', savePolicyControls);
  document.addEventListener('kindgleam:scope-state', () => {
    if (document.querySelector('.settings-section.active')?.dataset.settingsSection === 'policies') loadPolicyControls();
  });
}
