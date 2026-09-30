/**
 * Universal external-data connector contracts.
 *
 * Kindgleam connects to no outside service except the AI model and Stripe.
 * Public web data is read by its own guarded fetcher and the model's search;
 * a person's other data arrives as attached files.
 *
 * Connectors are data capabilities, not hard-coded product modes. A connector
 * may be public, user-authorized, organization-authorized, or deployment-owned.
 * The situation engine asks for the data actually required, the policy engine
 * decides whether it is permitted, and the connector must return provenance
 * before retrieved information is treated as evidence.
 */
const text = value => String(value ?? '').trim();

export const CONNECTOR_STATES = Object.freeze([
  'available', 'authorization-required', 'connected', 'limited', 'revoked', 'unavailable'
]);


export const EXTERNAL_DATA_CONNECTORS = Object.freeze([
  {
    id: 'public-web',
    provider: 'web',
    label: 'Public web',
    category: 'public-information',
    purpose: 'Retrieve public internet information for research and evidence gathering.',
    authMode: 'none',
    visibility: 'public',
    readActions: ['search', 'retrieve'],
    writeActions: [],
    scopes: [],
    defaultState: 'available',
    dataClasses: ['public-web'],
    verification: 'source-url-and-retrieval-receipt',
    retention: 'deployment-defined'
  }
]);

export function externalConnectorCatalog() {
  return EXTERNAL_DATA_CONNECTORS.map(item => ({
    ...item,
    readActions: [...item.readActions],
    writeActions: [...item.writeActions],
    scopes: item.scopes && typeof item.scopes === 'object'
      ? Object.fromEntries(Object.entries(item.scopes).map(([key, values]) => [key, [...values]]))
      : [...(item.scopes ?? [])]
  }));
}

export function externalConnector(id) {
  const key = text(id).toLowerCase();
  return EXTERNAL_DATA_CONNECTORS.find(item => item.id === key) ?? null;
}

function normalizeSourceList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => {
    if (typeof item === 'string') return text(item).toLowerCase();
    if (item && typeof item === 'object') return text(item.id || item.name || item.provider).toLowerCase();
    return '';
  }).filter(Boolean))];
}

function sourceMatches(goal, patterns) {
  const value = text(goal);
  return patterns.some(pattern => pattern.test(value));
}

function readScopeSatisfied(connector, scopes = []) {
  if (connector.authMode === 'none' || connector.authMode === 'api-key') {
    return { required: false, satisfied: true, status: 'not-applicable' };
  }
  const granted = new Set(Array.isArray(scopes) ? scopes.map(text).filter(Boolean) : []);
  const candidates = connector.scopes && typeof connector.scopes === 'object'
    ? Object.values(connector.scopes).flat()
    : [];
  const satisfied = candidates.some(scope => granted.has(scope));
  return {
    required: true,
    satisfied,
    status: satisfied ? 'sufficient' : 'missing'
  };
}

export function connectorAccess(id, { status = 'authorization-required', scopes = [] } = {}) {
  const connector = externalConnector(id);
  if (!connector) {
    return { authorized: false, scopeStatus: 'unknown', reason: 'connector-not-registered' };
  }
  if (connector.authMode === 'none') {
    return { authorized: true, scopeStatus: 'not-applicable', reason: 'public-source' };
  }
  if (status !== 'connected') {
    return { authorized: false, scopeStatus: 'not-connected', reason: 'connection-not-active' };
  }
  const scope = readScopeSatisfied(connector, scopes);
  return {
    authorized: scope.satisfied,
    scopeStatus: scope.status,
    reason: scope.satisfied ? 'connection-and-scope-ready' : 'required-authorizing-scope-is-missing'
  };
}

export function resolveExternalDataNeeds(goal, {
  dataSources = [],
  externalDataSources = [],
  connections = [],
  connectedServices = [],
  verifiedConnections = [],
  workspace = null,
  user = null
} = {}) {
  const explicit = normalizeSourceList([
    ...dataSources,
    ...externalDataSources,
    ...connections,
    ...connectedServices
  ]);

  const inferred = [];
  // Whole words only: a website to build is not a request to search the web.
  if (sourceMatches(goal, [/\b(?:web|internet|online|latest|current|sources?|research|find information)\b/i])) inferred.push('public-web');

  const requested = [...new Set([...explicit, ...inferred])];
  // Request JSON can identify which connector the user wants, but it can
  // never prove that the private provider is connected. Only the
  // server-backed verifiedConnections channel may authorize private access.
  const normalizedVerifiedConnections = Array.isArray(verifiedConnections)
    ? verifiedConnections.filter(item => item && typeof item === 'object').map(item => ({
        id: text(item.id || item.connectorId || item.provider).toLowerCase(),
        status: CONNECTOR_STATES.includes(text(item.status).toLowerCase())
          ? text(item.status).toLowerCase()
          : 'authorization-required',
        scopes: Array.isArray(item.scopes) ? item.scopes.map(text).filter(Boolean) : [],
        principalScope: text(item.principalScope || item.accountScope),
        sourceRef: text(item.sourceRef || item.resourceId),
        verified: item.verified === true
      })).filter(item => item.id && item.verified === true && item.status === 'connected')
    : [];
  const connectionMap = new Map(normalizedVerifiedConnections.map(item => [item.id, item]));
  const sources = requested.map(id => {
    const connector = externalConnector(id);
    if (!connector) {
      return {
        id,
        status: 'authorization-required',
        knownConnector: false,
        reason: 'No concrete connector is registered; capability discovery must find an authorized implementation.'
      };
    }
    const connection = connectionMap.get(id);
    const accessCheck = connectorAccess(id, {
      status: connection?.status ?? connector.defaultState,
      scopes: connection?.scopes ?? []
    });
    return {
      id,
      provider: connector.provider,
      category: connector.category,
      visibility: connector.visibility,
      dataClasses: [...connector.dataClasses],
      requested: true,
      knownConnector: true,
      authMode: connector.authMode,
      status: connection?.status ?? connector.defaultState,
      scopes: connection?.scopes ?? [],
      principalScope: connection?.principalScope
        ?? (user?.id ? 'user:' + text(user.id) : (workspace?.id ? 'workspace:' + text(workspace.id) : null)),
      sourceRef: connection?.sourceRef ?? null,
      scopeStatus: accessCheck.scopeStatus,
      access: accessCheck.authorized
        ? (connector.authMode === 'none' ? 'public' : 'authorized')
        : 'authorization-required',
      accessReason: accessCheck.reason
    };
  });

  const connected = sources.filter(item => item.status === 'connected').map(item => item.id);
  const authorizationRequired = sources
    .filter(item => item.access === 'authorization-required')
    .map(item => item.id);

  return {
    requested,
    sources,
    connected,
    authorizationRequired,
    hasExternalDataNeed: sources.length > 0,
    provenanceRequired: sources.length > 0,
    userOrWorkspaceScoped: sources.some(item => /private|policy-scoped/i.test(item.visibility)),
    principle: 'A connector is never treated as accessible merely because it is listed. Retrieval requires an actual connection, authorization and policy permission.'
  };
}

export function buildExternalDataPlan(goal, context = {}) {
  const needs = resolveExternalDataNeeds(goal, context);
  return {
    ...needs,
    connectors: needs.sources.map(item => item.id),
    state: !needs.hasExternalDataNeed
      ? 'not-required'
      : needs.authorizationRequired.length
        ? (needs.connected.length ? 'partially-available' : 'authorization-required')
        : 'available',
    retrieval: needs.sources.map(item => ({
      connector: item.id,
      status: item.status,
      authorized: item.access === 'authorized' || item.access === 'public',
      dataClasses: item.dataClasses,
      provenanceRequired: true,
      storeMinimumRequired: true
    })),
    unavailableClaims: [
      'provider-internal data not exposed through an authorized connector',
      'the entire internet is not a guaranteed universal dataset'
    ]
  };
}

export { readScopeSatisfied };

