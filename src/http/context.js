/**
 * Request context: trusted identity and workspace, planning input, cookies.
 *
 * Identity and scope always come from authentication, never request JSON.
 */

export const text = value => String(value ?? '').trim();

// Earlier product name, kept: renaming the cookie would sign everyone out.
export const SESSION_COOKIE = 'professor_session';

/**
 * The session cookie's name. Over HTTPS it carries the __Host- prefix: the
 * browser then only accepts it from this exact host, Secure, on Path=/ and
 * without a Domain, so a sibling subdomain cannot plant or overwrite it
 * (cookie tossing into someone else's session).
 */
export const sessionCookieName = config => (config?.cookieSecure ? '__Host-kg_session' : SESSION_COOKIE);
/** Browsers cannot set this cross-origin without CORS, so it proves intent. */
export const CSRF_HEADER = 'x-kindgleam-client';
// Earlier product names, still accepted so pages opened before a rename keep working.
export const LEGACY_CSRF_HEADERS = ['x-general-ai-client', 'x-professor-client'];

export function trustedUserContext(req) {
  const supplied = req.body?.user && typeof req.body.user === 'object' && !Array.isArray(req.body.user)
    ? req.body.user
    : {};
  const preferences = Array.isArray(req.body?.preferences)
    ? req.body.preferences
    : Array.isArray(supplied.preferences) ? supplied.preferences : [];
  const accessibility = supplied.accessibility && typeof supplied.accessibility === 'object' && !Array.isArray(supplied.accessibility)
    ? {
        reducedMotion: supplied.accessibility.reducedMotion === true,
        highContrast: supplied.accessibility.highContrast === true,
        largeText: supplied.accessibility.largeText === true,
        screenReader: supplied.accessibility.screenReader === true
      }
    : {};
  return {
    id: req.principal.id,
    kind: req.principal.kind,
    role: req.scope.role,
    skillLevel: text(req.body?.skillLevel ?? supplied.skillLevel),
    language: text(req.body?.language ?? supplied.language),
    preferences: [...new Set(preferences.map(text).filter(Boolean))].slice(0, 40),
    accessibility,
    // Stable per-user adaptive ceiling/preferences. The current task may narrow
    // this, but it must never silently broaden the user's selected limits.
    adaptiveControl: supplied.adaptiveControl && typeof supplied.adaptiveControl === 'object' && !Array.isArray(supplied.adaptiveControl)
      ? supplied.adaptiveControl
      : {}
  };
}

export function trustedWorkspaceContext(req) {
  return {
    id: req.scope.workspaceId,
    name: req.scope.name,
    organizationId: req.scope.organizationId,
    organizationName: req.scope.organizationName,
    organizationType: req.scope.organizationType,
    jurisdiction: req.scope.jurisdiction
  };
}

export function parseCookies(header) {
  const jar = {};
  for (const part of text(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    try {
      jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // A malformed cookie is untrusted input; ignore it and let authentication fail normally.
    }
  }
  return jar;
}

/** The whole-situation planning input, built from trusted scope plus request fields. */
export function planningInput(req, policies, config) {
  return {
    policies,
    activeSurface: req.body?.activeSurface,
    timeZone: req.body?.timeZone,
    runtimeMode: config.runtimeMode,
    workspaceType: req.scope.organizationType,
    // The workspace's jurisdiction wins; otherwise the person may say where
    // they are (context for the answer, never an authorization).
    jurisdiction: req.scope.jurisdiction || String(req.body?.jurisdiction ?? '').trim().slice(0, 80),
    user: trustedUserContext(req),
    workspace: trustedWorkspaceContext(req),
    project: req.body?.project ?? null,
    files: req.body?.files ?? req.body?.artifacts ?? [],
    priorWork: req.body?.priorWork ?? req.body?.history ?? [],
    constraints: req.body?.constraints ?? [],
    resources: req.body?.resources ?? [],
    requirements: req.body?.requirements ?? [],
    successCriteria: req.body?.successCriteria ?? req.body?.acceptanceCriteria ?? [],
    outputs: req.body?.outputs ?? req.body?.desiredOutputs ?? [],
    environment: req.body?.environment ?? req.body?.runtime ?? null,
    language: req.body?.language ?? '',
    skillLevel: req.body?.skillLevel ?? req.body?.user?.skillLevel ?? '',
    preferences: req.body?.preferences ?? [],
    currentState: req.body?.currentState ?? null,
    completedSteps: req.body?.completedSteps ?? [],
    failedSteps: req.body?.failedSteps ?? [],
    evidence: req.body?.evidence ?? [],
    questions: req.body?.questions ?? [],
    visibility: req.body?.visibility ?? 'private',
    privacyConsent: req.body?.privacyConsent ?? {},
    need: req.body?.need ?? req.body?.taskNeed ?? null,
    adaptiveControl: req.body?.adaptiveControl && typeof req.body.adaptiveControl === 'object' && !Array.isArray(req.body.adaptiveControl)
      ? req.body.adaptiveControl
      : {},
    verifiedConnections: [],
    dataSources: req.body?.dataSources ?? req.body?.externalDataSources ?? [],
    connections: req.body?.connections ?? [],
    connectedServices: req.body?.connectedServices ?? []
  };
}

/** What a client may see about how its goal was classified. */
export function publicClassification(result) {
  return {
    source: result.source,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.model ? { provider: result.provider, model: result.model } : {}),
    ...(result.hints ? { confidence: result.hints.confidence } : {})
  };
}
