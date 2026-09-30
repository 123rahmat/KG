/**
 * Privacy boundary.
 *
 * Privacy is a system invariant: data must remain bound to the authenticated
 * principal/workspace, use the minimum necessary classification, and may leave
 * the platform only through an explicitly permitted destination.
 */

const text = value => String(value ?? '').trim();

export const DATA_CLASSES = Object.freeze([
  'public-web',
  'user-content',
  'workspace-content',
  'workspace-secret',
  'private-cloud-content',
  'private-cloud-data',
  'private-communications',
  'private-calendar-data',
  'private-media',
  'location-public',
  'identity',
  'credentials',
  'payment',
  'external-service-data'
]);

export const PUBLIC_DATA_CLASSES = Object.freeze(['public-web', 'location-public']);

export const PRIVATE_DATA_CLASSES = Object.freeze(
  DATA_CLASSES.filter(item => !PUBLIC_DATA_CLASSES.includes(item))
);

function list(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(text).filter(Boolean))]
    : [];
}

export function normalizeDataClasses(value, fallback = ['user-content']) {
  const classes = list(value);
  return classes.length ? classes : [...fallback];
}

export function privacyDecision({
  workspaceScope,
  principalScope,
  sourceWorkspaceScope = workspaceScope,
  sourcePrincipalScope = principalScope,
  dataClasses = ['user-content'],
  destination = 'internal',
  allowedDataClasses = [],
  deniedDataClasses = [],
  connectionAuthorized = true,
  explicitConsent = false
} = {}) {
  const classes = normalizeDataClasses(dataClasses);
  const allowed = list(allowedDataClasses);
  const denied = list(deniedDataClasses);
  const crossWorkspace = Boolean(
    sourceWorkspaceScope && workspaceScope && String(sourceWorkspaceScope) !== String(workspaceScope)
  );
  const crossPrincipal = Boolean(
    sourcePrincipalScope && principalScope && String(sourcePrincipalScope) !== String(principalScope)
  );
  const privateData = classes.some(item => PRIVATE_DATA_CLASSES.includes(item));
  const hasAllowList = allowed.length > 0;
  const allAllowed = classes.every(item => allowed.some(rule =>
    rule === '*' || rule === item || (rule.endsWith('*') && item.startsWith(rule.slice(0, -1)))
  ));
  const anyDenied = classes.some(item => denied.some(rule =>
    rule === '*' || rule === item || (rule.endsWith('*') && item.startsWith(rule.slice(0, -1)))
  ));
  const external = destination !== 'internal';

  let allowedDecision = true;
  let reason = 'internal-same-scope';

  if (crossWorkspace || crossPrincipal) {
    allowedDecision = false;
    reason = crossWorkspace ? 'cross-workspace-data-access' : 'cross-principal-data-access';
  } else if (!connectionAuthorized) {
    allowedDecision = false;
    reason = 'external-connection-not-authorized';
  } else if (anyDenied) {
    allowedDecision = false;
    reason = 'data-class-explicitly-denied';
  } else if (external && privateData && (!hasAllowList || !allAllowed)) {
    allowedDecision = false;
    reason = 'private-data-egress-not-explicitly-authorized';
  } else if (external && privateData && !explicitConsent) {
    // Policy permits the class; the user must still consent to it leaving.
    allowedDecision = false;
    reason = 'explicit-data-consent-required';
  } else if (external) {
    reason = privateData ? 'authorized-private-egress' : 'public-data-egress';
  }

  return {
    allowed: allowedDecision,
    reason,
    destination,
    dataClasses: classes,
    privateData,
    crossWorkspace,
    crossPrincipal,
    minimumNecessary: true,
    noCrossTenantAccess: !crossWorkspace,
    noCrossPrincipalAccess: !crossPrincipal,
    explicitAuthorizationRequired: external && privateData,
    principle: 'Authenticated scope, minimum necessary data, authorization and destination policy must all hold before private data leaves its current trust boundary.'
  };
}

