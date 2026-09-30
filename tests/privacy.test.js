import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DATA_CLASSES,
  PRIVATE_DATA_CLASSES,
  normalizeDataClasses,
  privacyDecision
} from '../src/privacy.js';

test('privacy classification treats public web separately from private user data', () => {
  assert.ok(DATA_CLASSES.includes('public-web'));
  assert.ok(PRIVATE_DATA_CLASSES.includes('user-content'));
  assert.ok(!PRIVATE_DATA_CLASSES.includes('public-web'));
  assert.deepEqual(normalizeDataClasses([]), ['user-content']);
});

test('private data cannot leave its scope into an external destination without explicit allow policy', () => {
  const decision = privacyDecision({
    workspaceScope: 'w1',
    principalScope: 'u1',
    dataClasses: ['private-communications'],
    destination: 'model-provider',
    allowedDataClasses: []
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'private-data-egress-not-explicitly-authorized');
});

test('explicit allow policy still cannot permit cross-workspace access', () => {
  const decision = privacyDecision({
    workspaceScope: 'w2',
    principalScope: 'u2',
    sourceWorkspaceScope: 'w1',
    sourcePrincipalScope: 'u1',
    dataClasses: ['private-cloud-content'],
    destination: 'model-provider',
    allowedDataClasses: ['private-cloud-content']
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'cross-workspace-data-access');
});

test('same-scope private egress is allowed only when explicitly authorized', () => {
  const decision = privacyDecision({
    workspaceScope: 'w1',
    principalScope: 'u1',
    sourceWorkspaceScope: 'w1',
    sourcePrincipalScope: 'u1',
    dataClasses: ['user-content'],
    destination: 'model-provider',
    allowedDataClasses: ['user-content'],
    explicitConsent: true
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.minimumNecessary, true);
  assert.equal(decision.noCrossTenantAccess, true);
});

test('revoked or unavailable external connections cannot authorize private data', () => {
  const decision = privacyDecision({
    workspaceScope: 'w1',
    principalScope: 'u1',
    dataClasses: ['private-calendar-data'],
    destination: 'google-api',
    allowedDataClasses: ['private-calendar-data'],
    connectionAuthorized: false
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'external-connection-not-authorized');
});


test('external private-data egress fails closed when consent is absent', () => {
  const decision = privacyDecision({
    workspaceScope: 'w1',
    principalScope: 'u1',
    dataClasses: ['user-content'],
    destination: 'model-provider',
    allowedDataClasses: ['user-content']
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'explicit-data-consent-required');
});

test('explicit user consent and data-class policy are both required for provider egress', () => {
  const decision = privacyDecision({
    workspaceScope: 'w1',
    principalScope: 'u1',
    dataClasses: ['user-content'],
    destination: 'model-provider',
    allowedDataClasses: ['user-content'],
    explicitConsent: true
  });
  assert.equal(decision.allowed, true);
});


test('registered public location data class is not treated as private', () => {
  assert.ok(DATA_CLASSES.includes('location-public'));
  assert.ok(!PRIVATE_DATA_CLASSES.includes('location-public'));
});

test('wildcard data policy can authorize consented private egress', () => {
  const decision = privacyDecision({
    workspaceScope: 'w1',
    principalScope: 'u1',
    dataClasses: ['user-content'],
    destination: 'model-provider',
    allowedDataClasses: ['*'],
    explicitConsent: true
  });
  assert.equal(decision.allowed, true);
});
