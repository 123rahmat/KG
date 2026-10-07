/**
 * User-controlled adaptive resource policy.
 *
 * The adaptive engine may discover many possible resources, but a discovered
 * resource is not automatically brought into the workflow. This module chooses
 * the minimum set justified by the current situation and keeps user-controlled
 * ceilings on depth, context, execution and capability investment.
 */

const text = value => String(value ?? '').trim();

export const ADAPTIVE_DEPTHS = Object.freeze(['brief', 'standard', 'thorough']);
export const CAPABILITY_INVESTMENT_MODES = Object.freeze([
  'ask',
  'prepare',
  'build-candidate'
]);

export const ADAPTIVE_BUDGETS = Object.freeze({
  brief: Object.freeze({
    maxCapabilities: 8,
    maxExternalSources: 3,
    maxArtifacts: 6,
    maxContextItems: 16,
    maxExecutionStages: 4,
    maxWorkflowNodes: 10,
    maxToolCalls: 6,
    maxDiscoveryRounds: 1,
    maxAttachmentChars: 12000,
    maxEvidenceChars: 24000
  }),
  standard: Object.freeze({
    maxCapabilities: 16,
    maxExternalSources: 8,
    maxArtifacts: 20,
    maxContextItems: 48,
    maxExecutionStages: 8,
    maxWorkflowNodes: 18,
    maxToolCalls: 16,
    maxDiscoveryRounds: 2,
    maxAttachmentChars: 40000,
    maxEvidenceChars: 80000
  }),
  thorough: Object.freeze({
    maxCapabilities: 32,
    maxExternalSources: 20,
    maxArtifacts: 60,
    maxContextItems: 120,
    maxExecutionStages: 16,
    maxWorkflowNodes: 32,
    maxToolCalls: 40,
    maxDiscoveryRounds: 4,
    maxAttachmentChars: 120000,
    maxEvidenceChars: 240000
  })
});

const PROTECTED_CAPABILITIES = new Set([
  'reasoning',
  'adaptive-safety-governance',
  'situation-understanding',
  'capability-compilation',
  'planning',
  'verification'
]);

const NEXT_DEPTH = Object.freeze({ brief: 'standard', standard: 'thorough', thorough: 'thorough' });

const CAPABILITY_PRIORITY = Object.freeze({
  'evidence-retrieval': 90,
  'file-analysis': 90,
  'code-generation': 90,
  'code-execution': 95,
  design: 85,
  invention: 95,
  'hypothesis-generation': 80,
  'concept-evaluation': 85,
  'experiment-design': 85,
  'adaptive-composition': 70,
  'adaptive-execution': 80,
  'external-data-routing': 85,
  'capability-discovery': 100,
  response: 60,
  'artifact-creation': 70,
  'artifact-transformation': 70,
  modeling: 70,
  innovation: 70
});

const clampInt = (value, minimum, maximum) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
};

function list(value, max = 40) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => text(
    typeof item === 'string' ? item : item?.id ?? item?.name ?? item?.path
  )).filter(Boolean))].slice(0, max);
}

function normalizeOverrides(value = {}, defaults = ADAPTIVE_BUDGETS.standard) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const override = clampInt(input[key], 1, Math.max(fallback, 10000));
    return [key, override ?? fallback];
  }));
}

/**
 * Normalize the person's explicit adaptive controls. Missing fields are
 * intentionally conservative: the system does not silently enable expansion
 * or automatic capability investment.
 */
export function normalizeAdaptiveControl(value = {}, {
  inferredDepth = 'standard'
} = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const requestedDepth = ADAPTIVE_DEPTHS.includes(text(input.depth).toLowerCase())
    ? text(input.depth).toLowerCase()
    : '';
  const depth = requestedDepth || (ADAPTIVE_DEPTHS.includes(inferredDepth) ? inferredDepth : 'standard');
  const defaults = ADAPTIVE_BUDGETS[depth];
  const budget = normalizeOverrides(input.budget, defaults);
  const includeCapabilities = list(input.includeCapabilities, 32);
  const excludeCapabilities = list(input.excludeCapabilities, 32);
  const includeDataSources = list(input.includeDataSources, 24);
  const excludeDataSources = list(input.excludeDataSources, 24);
  const includeArtifacts = list(input.includeArtifacts, 80);
  const excludeArtifacts = list(input.excludeArtifacts, 80);
  const investment = CAPABILITY_INVESTMENT_MODES.includes(text(input.capabilityInvestment).toLowerCase())
    ? text(input.capabilityInvestment).toLowerCase()
    : 'ask';
  const intensityValues = new Set(['low', 'standard', 'high']);
  const intensity = intensityValues.has(text(input.intensity).toLowerCase())
    ? text(input.intensity).toLowerCase()
    : 'standard';
  const intensityRounds = intensity === 'high' ? Math.min(budget.maxDiscoveryRounds + 1, ADAPTIVE_BUDGETS.thorough.maxDiscoveryRounds)
    : intensity === 'low' ? Math.max(1, budget.maxDiscoveryRounds - 1)
      : budget.maxDiscoveryRounds;
  const tunedBudget = { ...budget, maxDiscoveryRounds: intensityRounds };

  // Normalizing an already normalized control must change nothing: its own
  // record of what the person specified wins over the keys it now carries
  // (an empty include list it added is not "the person chose nothing").
  const renormalized = input.schemaVersion === '1';
  const specified = key => (renormalized && typeof input[`${key}Specified`] === 'boolean' ? input[`${key}Specified`] : Object.hasOwn(input, key));
  return {
    schemaVersion: '1',
    depth,
    depthSource: renormalized && typeof input.depthSource === 'string' ? input.depthSource : requestedDepth ? 'user' : 'default',
    budget: tunedBudget,
    intensity,
    includeCapabilities,
    includeCapabilitiesSpecified: specified('includeCapabilities'),
    excludeCapabilities,
    includeDataSources,
    includeDataSourcesSpecified: specified('includeDataSources'),
    excludeDataSources,
    includeArtifacts,
    includeArtifactsSpecified: specified('includeArtifacts'),
    excludeArtifacts,
    capabilityInvestment: investment,
    allowAdaptiveExpansion: input.allowAdaptiveExpansion === true,
    expansionApprovalRequired: input.allowAdaptiveExpansion !== true,
    selectionMode: 'minimum-necessary',
    userControlled: true
  };
}


const DEPTH_RANK = Object.freeze({ brief: 0, standard: 1, thorough: 2 });
const INTENSITY_RANK = Object.freeze({ low: 0, standard: 1, high: 2 });
const INVESTMENT_RANK = Object.freeze({ ask: 0, prepare: 1, 'build-candidate': 2 });

function explicitLayerValues(layers, key) {
  return layers
    .filter(layer => layer.value && typeof layer.value === 'object' && Object.hasOwn(layer.value, key))
    .map(layer => layer.value[key]);
}

/**
 * Resolve the adaptive hierarchy without allowing a lower level to widen an
 * upper-level ceiling. The chain is:
 * user profile -> current task -> current step -> exact need.
 */
export function resolveAdaptiveControlHierarchy({
  userControl = {},
  taskControl = {},
  stepControl = {},
  need = null,
  inferredDepth = 'standard'
} = {}) {
  const layers = [
    { level: 'user', value: userControl && typeof userControl === 'object' ? userControl : {} },
    { level: 'task', value: taskControl && typeof taskControl === 'object' ? taskControl : {} },
    { level: 'step', value: stepControl && typeof stepControl === 'object' ? stepControl : {} }
  ];
  const merged = {};

  const depths = explicitLayerValues(layers, 'depth')
    .map(value => text(value).toLowerCase())
    .filter(value => DEPTH_RANK[value] !== undefined);
  if (depths.length) merged.depth = depths.reduce((a, b) => DEPTH_RANK[b] < DEPTH_RANK[a] ? b : a);

  const intensities = explicitLayerValues(layers, 'intensity')
    .map(value => text(value).toLowerCase())
    .filter(value => INTENSITY_RANK[value] !== undefined);
  if (intensities.length) merged.intensity = intensities.reduce((a, b) => INTENSITY_RANK[b] < INTENSITY_RANK[a] ? b : a);

  const investments = explicitLayerValues(layers, 'capabilityInvestment')
    .map(value => text(value).toLowerCase())
    .filter(value => INVESTMENT_RANK[value] !== undefined);
  if (investments.length) merged.capabilityInvestment = investments.reduce((a, b) => INVESTMENT_RANK[b] < INVESTMENT_RANK[a] ? b : a);

  const expansionFlags = explicitLayerValues(layers, 'allowAdaptiveExpansion')
    .map(value => value === true);
  if (expansionFlags.length) merged.allowAdaptiveExpansion = expansionFlags.every(Boolean);

  const budgetKeys = Object.keys(ADAPTIVE_BUDGETS.standard);
  const budget = {};
  for (const key of budgetKeys) {
    const values = explicitLayerValues(layers, 'budget')
      .flatMap(value => value && typeof value === 'object' && Object.hasOwn(value, key) ? [value[key]] : [])
      .map(Number)
      .filter(Number.isFinite)
      .map(value => Math.max(1, Math.trunc(value)));
    if (values.length) budget[key] = Math.min(...values);
  }
  if (Object.keys(budget).length) merged.budget = budget;

  // Explicit include lists are allow-lists. When multiple levels specify
  // them, the effective set is their intersection. Exclusions always narrow.
  for (const key of ['includeCapabilities', 'includeDataSources', 'includeArtifacts']) {
    const values = layers
      // A normalized control carries an empty list for "not chosen", marked
      // by <key>Specified === false: that is no allow-list, and treating it
      // as one would narrow every run to the base capabilities.
      .filter(layer => Array.isArray(layer.value?.[key]) && layer.value?.[`${key}Specified`] !== false)
      .map(layer => list(layer.value[key], key === 'includeCapabilities' ? 32 : key === 'includeArtifacts' ? 80 : 24));
    if (values.length) {
      const intersection = values.slice(1).reduce((current, next) => current.filter(item => next.includes(item)), values[0]);
      merged[key] = [...new Set(intersection)];
    }
  }
  for (const key of ['excludeCapabilities', 'excludeDataSources', 'excludeArtifacts']) {
    const values = layers
      .filter(layer => Array.isArray(layer.value?.[key]))
      .flatMap(layer => list(layer.value[key], key === 'excludeCapabilities' ? 32 : key === 'excludeArtifacts' ? 80 : 24));
    if (values.length) merged[key] = [...new Set(values)];
  }

  const normalized = normalizeAdaptiveControl(merged, { inferredDepth });
  const needDepth = text(need?.depth).toLowerCase();
  if (DEPTH_RANK[needDepth] !== undefined && DEPTH_RANK[needDepth] < DEPTH_RANK[normalized.depth]) {
    normalized.depth = needDepth;
    normalized.depthSource = 'exact-need-ceiling';
    normalized.budget = normalizeOverrides(normalized.budget, ADAPTIVE_BUDGETS[needDepth]);
  }

  return {
    effective: normalized,
    levels: {
      user: normalizeAdaptiveControl(userControl, { inferredDepth }),
      task: normalizeAdaptiveControl(taskControl, { inferredDepth: normalized.depth }),
      step: normalizeAdaptiveControl(stepControl, { inferredDepth: normalized.depth })
    },
    need: need && typeof need === 'object' ? {
      deliverable: text(need.deliverable).slice(0, 200),
      ...(text(need.form) ? { form: text(need.form) } : {}),
      ...(text(need.depth) ? { depth: text(need.depth) } : {}),
      ...(Array.isArray(need.exclude) && need.exclude.length ? { exclude: list(need.exclude, 6) } : {})
    } : null,
    order: ['user', 'task', 'step', 'need'],
    rule: 'Higher-level user limits are ceilings; task and step adaptation may narrow them, and the exact need may narrow depth further.'
  };
}

export function adaptiveStepScope(resourcePlan = {}, task = {}, { need = null } = {}) {
  const selected = resourcePlan?.selected ?? {};
  const selectedTools = Array.isArray(selected.tools) ? selected.tools : [];
  const hierarchy = resolveAdaptiveControlHierarchy({
    // resourcePlan.control is already the effective user/task ceiling. Do not
    // feed normalized defaults back as fresh lower-level restrictions.
    userControl: resourcePlan?.control ?? {},
    taskControl: {},
    stepControl: task?.metadata?.adaptiveControl ?? {},
    need,
    inferredDepth: resourcePlan?.control?.depth || 'standard'
  });
  const taskCapabilities = new Set(requirementsOfTask(task));
  const capabilities = (Array.isArray(selected.capabilities) ? selected.capabilities : [])
    .filter(capability => taskCapabilities.has(capability));
  // Artifacts are step-scoped. A code task does not implicitly need
  // every workspace file; the current task must justify file/data access.
  const needsArtifacts = task?.metadata?.usesArtifacts === true
    || taskCapabilities.has('file-analysis');
  const taskArtifacts = needsArtifacts ? (selected.artifacts ?? []) : [];
  const tools = toolsForTask(task, {
    selectedTools,
    artifacts: taskArtifacts,
    need
  });
  const needsData = ['investigate', 'discover', 'discover-capabilities', 'reassess'].includes(text(task?.type));
  const taskSurface = text(task?.metadata?.surface || task?.surface);
  const surfaces = taskSurface === 'research' || task?.type === 'investigate'
    ? ['research']
    : taskSurface === 'code' || task?.type === 'code'
      ? ['code']
      : ['chat'];
  return {
    level: 'step',
    capabilities,
    dataSources: needsData ? [...(selected.dataSources ?? [])] : [],
    artifacts: needsArtifacts ? [...(selected.artifacts ?? [])] : [],
    tools,
    surfaces,
    exactNeed: need && typeof need === 'object' ? need : null,
    adaptiveControl: hierarchy.effective
  };
}

function selectedByPriority(requirements, control) {
  const excluded = new Set(control.excludeCapabilities.map(value => value.toLowerCase()));
  const explicit = new Set(control.includeCapabilities.map(value => value.toLowerCase()));
  const all = requirements
    .map(item => ({
      ...item,
      id: text(typeof item === 'string' ? item : item?.id).toLowerCase()
    }))
    .filter(item => item.id);
  // Safety, governance and planning primitives cannot be excluded by a scope
  // setting; everything else the person excludes stays out and is reported.
  const normalized = all.filter(item => PROTECTED_CAPABILITIES.has(item.id) || !excluded.has(item.id));

  const mandatory = normalized.filter(item => PROTECTED_CAPABILITIES.has(item.id) || explicit.has(item.id));
  const optional = normalized
    .filter(item => !PROTECTED_CAPABILITIES.has(item.id) && !explicit.has(item.id)
      && !control.includeCapabilitiesSpecified)
    .sort((a, b) => {
      const priority = (CAPABILITY_PRIORITY[b.id] ?? 50) - (CAPABILITY_PRIORITY[a.id] ?? 50);
      if (priority !== 0) return priority;
      if (Boolean(b.dynamic) !== Boolean(a.dynamic)) return b.dynamic ? -1 : 1;
      return a.id.localeCompare(b.id);
    });

  const selected = [];
  const omitted = [];
  const seen = new Set();

  for (const item of [...mandatory, ...optional]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    if (selected.length < control.budget.maxCapabilities) selected.push(item);
    else omitted.push(item);
  }

  // Safety/governance primitives cannot be excluded by a user scope setting.
  const missingProtected = normalized.filter(item => PROTECTED_CAPABILITIES.has(item.id) && !seen.has(item.id));
  for (const item of missingProtected) {
    if (selected.some(current => current.id === item.id)) continue;
    selected.push(item);
  }

  return { selected, omitted, excluded: all.filter(item => excluded.has(item.id) && !PROTECTED_CAPABILITIES.has(item.id)) };
}

function selectItems(values, include, exclude, maximum, includeSpecified = false) {
  const normalized = list(values, Math.max(maximum, 80));
  const allow = new Set(include.map(text));
  const deny = new Set(exclude.map(text));
  const explicit = normalized.filter(value => allow.has(value) && !deny.has(value));
  const ordinary = normalized.filter(value => !allow.has(value) && !deny.has(value));
  const selected = includeSpecified
    ? [...new Set(explicit)].slice(0, maximum)
    : [...new Set([...explicit, ...ordinary])].slice(0, maximum);
  const omitted = normalized.filter(value => !selected.includes(value));
  return {
    selected,
    omitted,
    excluded: normalized.filter(value => deny.has(value))
  };
}

const BUILTIN_TOOL_BY_CAPABILITY = Object.freeze({
  'evidence-retrieval': ['web.search', 'web.fetch', 'web.download'],
  'external-data-routing': [],
  'file-analysis': ['file.read'],
  'artifact-transformation': ['file.read'],
  'adaptive-execution': [],
  'code-generation': [],
  'code-execution': [],
  modeling: ['math.evaluate']
});

export function toolsForRequirements(requirements = [], { artifacts = [], need = null } = {}) {
  const items = Array.isArray(requirements) ? requirements : [];
  const ids = new Set(items.map(item => text(typeof item === 'string' ? item : item?.id)).filter(Boolean));
  const tools = [];
  for (const item of items) {
    const id = text(typeof item === 'string' ? item : item?.id);
    tools.push(...(BUILTIN_TOOL_BY_CAPABILITY[id] ?? []));
    tools.push(...(Array.isArray(item?.tools) ? item.tools.map(text).filter(Boolean) : []));
  }
  // Ordinary reasoning gets no calculator merely because one exists. Expose
  // exact arithmetic only when the need explicitly asks for it.
  const needText = text(need?.deliverable || need?.request || '');
  if (ids.has('response') && /\b(?:calculate|compute|work out|exact(?:ly)?|how much|how many)\b/i.test(needText)) {
    tools.push('math.evaluate');
  }
  // Financial projections are better served by the deterministic first-party
  // projection tool than by free-form arithmetic. Expose it only when the
  // requested deliverable is clearly a business/finance projection.
  if (/\b(?:financial|finance|business|bakery|startup|start-up|revenue|profit|cash ?flow|break-even|projection|forecast|budget)\b/i.test(needText)
      && /\b(?:project|projection|forecast|model|estimate|break-even|months?|revenue|profit|costs?)\b/i.test(needText)) {
    tools.push('finance.project');
  }
  if ((Array.isArray(artifacts) ? artifacts : []).some(value => /\.(?:xlsx|csv)$/i.test(text(value)))) tools.push('data.analyze');
  return [...new Set(tools)];
}

// What a step of each type needs when it does not say (steps recorded before
// requires was kept, or built elsewhere); the same mapping the engine uses
// when it creates the step.
const TYPE_REQUIREMENTS = Object.freeze({
  investigate: ['evidence-retrieval'],
  verify: ['verification'],
  'build-code': ['code-generation'],
  'test-code': ['code-execution']
});

/** The capabilities a step needs: its own list, or its type's default. */
export function requirementsOfTask(task = {}) {
  const own = Array.isArray(task?.requires) ? task.requires.map(text).filter(Boolean) : [];
  if (own.length) return own;
  if (text(task?.type) === 'code') return [...(TYPE_REQUIREMENTS[text(task?.id)] ?? ['code-generation', 'code-execution'])];
  return [...(TYPE_REQUIREMENTS[text(task?.type)] ?? [])];
}

export function toolsForTask(task = {}, { selectedTools = [], artifacts = [], need = null } = {}) {
  const selected = new Set(Array.isArray(selectedTools) ? selectedTools.map(text).filter(Boolean) : []);
  const metadata = task?.metadata ?? {};
  const declared = list(metadata.allowedTools, 80);
  const discovered = Array.isArray(metadata.capabilitySpecs)
    ? metadata.capabilitySpecs.flatMap(spec => Array.isArray(spec?.tools) ? spec.tools.map(text).filter(Boolean) : [])
    : [];
  const taskNeeds = toolsForRequirements(requirementsOfTask(task), { artifacts, need });
  const candidates = [...new Set([...taskNeeds, ...declared, ...discovered])];
  // Normal tools must be selected by this situation. A newly discovered tool
  // is allowed only when the server has attached its capability spec to this
  // task after the corresponding approval gate.
  return candidates.filter(name => selected.has(name) || discovered.includes(name) || declared.includes(name));
}

function surfaceForRequirement(id) {
  if (id === 'evidence-retrieval' || id === 'external-data-routing') return 'research';
  if (id === 'file-analysis') return 'chat';
  if (id === 'code-generation' || id === 'code-execution') return 'code';
  if (id === 'design') return 'chat';
  if (['invention', 'hypothesis-generation', 'concept-evaluation', 'experiment-design'].includes(id)) return 'chat';
  return null;
}

/**
 * Select the minimum useful resource set. The full deployment catalog remains
 * visible to the compiler, but only the selected set is presented as the
 * current working scope.
 */
export function planAdaptiveResources({
  requirements = [],
  externalData = {},
  artifacts = [],
  surfaces = [],
  primarySurface = 'chat',
  implementationPlan = null,
  situation = {},
  control = {}
} = {}) {
  const hierarchy = resolveAdaptiveControlHierarchy({
    userControl: situation?.userProfile?.adaptiveControl ?? {},
    taskControl: control,
    stepControl: situation?.step?.adaptiveControl ?? {},
    need: situation?.need ?? null,
    inferredDepth: situation?.adaptation?.user?.adaptiveDepth || situation?.need?.depth || 'standard'
  });
  let normalizedControl = hierarchy.effective;

  let requirementSelection = selectedByPriority(requirements, normalizedControl);
  let dataSelection = selectItems(
    externalData?.requested ?? externalData?.connectors ?? [],
    normalizedControl.includeDataSources,
    normalizedControl.excludeDataSources,
    normalizedControl.budget.maxExternalSources,
    normalizedControl.includeDataSourcesSpecified
  );
  let artifactSelection = selectItems(
    artifacts,
    normalizedControl.includeArtifacts,
    normalizedControl.excludeArtifacts,
    normalizedControl.budget.maxArtifacts,
    normalizedControl.includeArtifactsSpecified
  );

  // A brief need is served by its main surface alone: an optional capability
  // of another surface (research for "change one function") is left out
  // and reported, so it can be offered as an expansion instead of used.
  const narrowToPrimary = selection => {
    if (normalizedControl.depth !== 'brief' || primarySurface === 'chat') return selection;
    const explicit = new Set(normalizedControl.includeCapabilities.map(value => text(value).toLowerCase()));
    const unrelated = item => !PROTECTED_CAPABILITIES.has(item.id) && !explicit.has(item.id)
      && surfaceForRequirement(item.id) !== null && surfaceForRequirement(item.id) !== primarySurface;
    return {
      ...selection,
      selected: selection.selected.filter(item => !unrelated(item)),
      omitted: [...selection.omitted, ...selection.selected.filter(unrelated)]
    };
  };
  requirementSelection = narrowToPrimary(requirementSelection);

  const orderedSurfaces = ['chat', 'research', 'code'];
  const chooseSurfaces = selected => {
    const neededSurfaces = new Set(['chat']);
    for (const item of selected) {
      const surface = surfaceForRequirement(item.id);
      if (surface) neededSurfaces.add(surface);
    }
    const primaryIsJustified = selected.some(item => surfaceForRequirement(item.id) === primarySurface);
    if (primarySurface === 'chat' || primaryIsJustified) neededSurfaces.add(primarySurface);
    const picked = [...new Set(surfaces)].filter(surface => neededSurfaces.has(surface));
    if (!picked.includes('chat')) picked.unshift('chat');
    const primary = picked.includes(primarySurface)
      ? primarySurface
      : orderedSurfaces.find(surface => picked.includes(surface)) || 'chat';
    return { selectedSurfaces: picked, primaryCandidate: primary };
  };
  let { selectedSurfaces, primaryCandidate } = chooseSurfaces(requirementSelection.selected);

  const allRequirementIds = new Set(requirements.map(item => text(typeof item === 'string' ? item : item?.id)));
  let selectedIds = new Set(requirementSelection.selected.map(item => item.id));
  let missingFromScope = [...allRequirementIds].filter(id => id && !selectedIds.has(id));
  let expandedFrom = null;

  const scopeNeedsExpansion = () =>
    missingFromScope.length > 0 || dataSelection.omitted.length > 0 || artifactSelection.omitted.length > 0;

  if (scopeNeedsExpansion() && normalizedControl.allowAdaptiveExpansion && normalizedControl.depth !== 'thorough') {
    expandedFrom = normalizedControl.depth;
    const expandedDepth = NEXT_DEPTH[normalizedControl.depth];
    normalizedControl = normalizeAdaptiveControl({
      ...normalizedControl,
      depth: expandedDepth,
      allowAdaptiveExpansion: true
    }, { inferredDepth: expandedDepth });
    normalizedControl.depthSource = 'user-approved-expansion';
    requirementSelection = narrowToPrimary(selectedByPriority(requirements, normalizedControl));
    dataSelection = selectItems(
      externalData?.requested ?? externalData?.connectors ?? [],
      normalizedControl.includeDataSources,
      normalizedControl.excludeDataSources,
      normalizedControl.budget.maxExternalSources,
      normalizedControl.includeDataSourcesSpecified
    );
    artifactSelection = selectItems(
      artifacts,
      normalizedControl.includeArtifacts,
      normalizedControl.excludeArtifacts,
      normalizedControl.budget.maxArtifacts,
      normalizedControl.includeArtifactsSpecified
    );
    ({ selectedSurfaces, primaryCandidate } = chooseSurfaces(requirementSelection.selected));
    selectedIds = new Set(requirementSelection.selected.map(item => item.id));
    missingFromScope = [...allRequirementIds].filter(id => id && !selectedIds.has(id));
  }

  const missingImplementations = Array.isArray(implementationPlan?.missing)
    ? [...new Set(implementationPlan.missing.map(text).filter(Boolean))]
    : [];

  const investableMissing = missingImplementations.filter(id => {
    if (PROTECTED_CAPABILITIES.has(id)) return false;
    const requirement = requirements.find(item => text(typeof item === 'string' ? item : item?.id) === id);
    return requirement?.dynamic === true || requirement?.source === 'discoverable';
  });
  const investment =
    !investableMissing.length
      ? { decision: 'none', automatic: false, reason: 'No missing non-protected capability requires investment.' }
      : normalizedControl.capabilityInvestment === 'build-candidate'
        ? {
            decision: 'prepare-build-candidate',
            automatic: false,
            reason: 'The user authorized preparation of a candidate capability, but promotion/execution still requires verification and approval.',
            capabilities: investableMissing
          }
        : normalizedControl.capabilityInvestment === 'prepare'
          ? {
              decision: 'prepare-design',
              automatic: false,
              reason: 'Prepare governed implementation designs for missing capabilities without making them executable.',
              capabilities: investableMissing
            }
          : {
              decision: 'user-choice-required',
              automatic: false,
              reason: 'A capability is missing; present the gap and let the user decide whether to invest in building it.',
              capabilities: investableMissing
            };

  const omitted = {
    capabilities: requirementSelection.omitted.map(item => item.id),
    dataSources: dataSelection.omitted,
    artifacts: artifactSelection.omitted,
    surfaces: [...new Set(surfaces)].filter(surface => !selectedSurfaces.includes(surface))
  };

  const expansionNeeded = scopeNeedsExpansion();

  return {
    schemaVersion: '1',
    mode: normalizedControl.selectionMode,
    userControlled: true,
    control: normalizedControl,
    hierarchy: {
      order: hierarchy.order,
      user: hierarchy.levels.user,
      task: hierarchy.levels.task,
      step: hierarchy.levels.step,
      need: hierarchy.need,
      rule: hierarchy.rule
    },
    budget: normalizedControl.budget,
    selected: {
      capabilities: requirementSelection.selected.map(item => item.id),
      dataSources: dataSelection.selected,
      artifacts: artifactSelection.selected,
      tools: toolsForRequirements(requirementSelection.selected, { artifacts: artifactSelection.selected, need: situation?.need ?? null }),
      surfaces: selectedSurfaces,
      primarySurface: primaryCandidate
    },
    omitted,
    excluded: {
      capabilities: requirementSelection.excluded.map(item => item.id),
      dataSources: dataSelection.excluded,
      artifacts: artifactSelection.excluded
    },
    implementation: {
      missing: missingImplementations,
      investment
    },
    expansion: {
      needed: expansionNeeded,
      allowed: normalizedControl.allowAdaptiveExpansion,
      expanded: Boolean(expandedFrom),
      fromDepth: expandedFrom,
      approvalRequired: normalizedControl.expansionApprovalRequired,
      automatic: Boolean(expandedFrom),
      rule: normalizedControl.allowAdaptiveExpansion
        ? 'One user-authorized depth expansion may occur when the selected scope is insufficient; further expansion requires another user decision.'
        : 'Adaptive expansion must stop at the user-selected scope and ask before adding more.'
    },
    contextPolicy: {
      minimumNecessary: true,
      maxItems: normalizedControl.budget.maxContextItems,
      rule: 'Only selected resources are part of the active working set; omitted resources remain available for later user-approved expansion.'
    },
    executionPolicy: {
      maxStages: normalizedControl.budget.maxExecutionStages,
      maxToolCalls: normalizedControl.budget.maxToolCalls,
      maxDiscoveryRounds: normalizedControl.budget.maxDiscoveryRounds,
      overBudgetRequiresExpansion: true
    },
    principle: 'Availability is not selection. The adaptive engine selects only what the current situation justifies, within user-controlled limits.'
  };
}

export function adaptiveScopeForNextStep(resourcePlan = {}, {
  newlyRequiredCapabilities = [],
  newlyRequestedDataSources = []
} = {}) {
  const current = resourcePlan?.selected ?? {};
  return {
    current,
    additions: {
      capabilities: list(newlyRequiredCapabilities, 32),
      dataSources: list(newlyRequestedDataSources, 24)
    },
    decision: 're-evaluate-before-add',
    requiresUserExpansion: resourcePlan?.expansion?.approvalRequired !== false
      && (newlyRequiredCapabilities.length > 0 || newlyRequestedDataSources.length > 0)
  };
}


export function effortForAdaptiveDepth(depth = 'standard', requested = null) {
  const ceiling = text(depth).toLowerCase() === 'brief' ? 'low'
    : text(depth).toLowerCase() === 'thorough' ? 'high'
      : 'medium';
  const order = ['low', 'medium', 'high'];
  if (!order.includes(text(requested).toLowerCase())) return ceiling;
  return order[Math.min(order.indexOf(ceiling), order.indexOf(text(requested).toLowerCase()))];
}


export function adaptiveExecutionBudgetStatus(run, task = null) {
  const budget = run?.adaptation?.resourcePlan?.budget;
  if (!budget || typeof budget !== 'object') return { allowed: true };
  const executionTypes = new Set(['code', 'tool', 'investigate']);
  if (!executionTypes.has(text(task?.type))) return { allowed: true };

  const completedExecutionStages = Array.isArray(run.tasks)
    ? run.tasks.filter(item => executionTypes.has(text(item.type)) && item.status === 'complete').length
    : 0;
  const maxExecutionStages = Number(budget.maxExecutionStages);
  if (Number.isFinite(maxExecutionStages) && completedExecutionStages >= maxExecutionStages) {
    return {
      allowed: false,
      code: 'adaptive-execution-budget-exhausted',
      reason: 'The selected adaptive scope has reached its execution-stage limit. Increase the adaptive depth or explicitly allow a larger scope before continuing.',
      completedExecutionStages,
      maxExecutionStages
    };
  }

  const completedToolCalls = Array.isArray(run.tasks)
    ? run.tasks.reduce((total, item) => total + (
        Array.isArray(item.evidence?.tools) ? item.evidence.tools.length : 0
      ), 0)
    : 0;
  const maxToolCalls = Number(budget.maxToolCalls);
  if (Number.isFinite(maxToolCalls) && completedToolCalls >= maxToolCalls) {
    return {
      allowed: false,
      code: 'adaptive-tool-budget-exhausted',
      reason: 'The selected adaptive scope has reached its tool-use limit. Increase the adaptive depth or explicitly allow a larger scope before continuing.',
      completedToolCalls,
      maxToolCalls
    };
  }

  return { allowed: true, completedExecutionStages, completedToolCalls };
}

/**
 * Reconcile the active resource scope after every completed/failed step.
 *
 * This is deliberately a pure, cheap transition check: it does not invoke a
 * model or add resources by itself. It records what became unnecessary,
 * what became newly justified, and whether the current scope must be
 * reconsidered before the next step. Expensive discovery remains governed by
 * the normal workflow.
 */
export function reconcileAdaptiveTransition({
  resourcePlan = {},
  requirements = [],
  artifacts = [],
  dataSources = [],
  nextTask = null,
  situationChanged = true
} = {}) {
  const selected = resourcePlan?.selected ?? {};
  const selectedCapabilities = new Set(list(selected.capabilities, 64));
  const selectedArtifacts = new Set(list(selected.artifacts, 120));
  const selectedDataSources = new Set(list(selected.dataSources, 40));
  const requiredIds = new Set(
    (Array.isArray(requirements) ? requirements : [])
      .map(item => text(typeof item === 'string' ? item : item?.id))
      .filter(Boolean)
  );
  const requestedArtifacts = new Set(list(artifacts, 120));
  const requestedData = new Set(list(dataSources, 40));

  const additions = [...requiredIds].filter(id => !selectedCapabilities.has(id));
  const removableCapabilities = [...selectedCapabilities]
    .filter(id => !requiredIds.has(id) && !PROTECTED_CAPABILITIES.has(id));
  const artifactAdditions = [...requestedArtifacts].filter(item => !selectedArtifacts.has(item));
  const artifactRemovals = [...selectedArtifacts].filter(item => !requestedArtifacts.has(item));
  const dataAdditions = [...requestedData].filter(item => !selectedDataSources.has(item));
  const dataRemovals = [...selectedDataSources].filter(item => !requestedData.has(item));

  const expansion = additions.length || artifactAdditions.length || dataAdditions.length;
  const narrowing = removableCapabilities.length || artifactRemovals.length || dataRemovals.length;
  const decision = expansion
    ? 're-evaluate-before-expansion'
    : narrowing
      ? 'narrow-scope-before-next-step'
      : 'continue-current-scope';

  // Efficiency is part of the adaptive decision, not a post-hoc optimization:
  // reuse verified state when the next step needs the same scope; otherwise
  // spend compute only on the changed boundary. Expensive discovery is never
  // repeated merely because a new step started.
  const efficiency = {
    reuseCurrentScope: !expansion,
    targetedReassessmentOnly: Boolean(expansion || narrowing),
    avoidRedundantDiscovery: !expansion,
    preserveVerifiedEvidence: true,
    stopIfNoJustifiedNextStep: !nextTask,
    strategy: expansion
      ? 'reuse-verified-state-and-reassess-only-new-requirements'
      : narrowing
        ? 'reuse-verified-state-and-drop-unneeded-resources'
        : 'continue-with-existing-verified-scope',
    objective: 'minimize model calls, context, tool calls and execution while preserving the evidence required for the next verified result'
  };

  return {
    situationChanged: situationChanged === true,
    evaluated: true,
    nextTask: text(nextTask?.id || nextTask?.type || ''),
    additions: {
      capabilities: additions,
      artifacts: artifactAdditions,
      dataSources: dataAdditions
    },
    removals: {
      capabilities: removableCapabilities,
      artifacts: artifactRemovals,
      dataSources: dataRemovals
    },
    decision,
    efficiency,
    minimumNecessary: true,
    automaticExpansion: false,
    rule: 'Every transition re-checks the active scope; additions require normal governance/expansion rules, while unnecessary resources can be removed from the next step.'
  };
}


export function adaptiveBudgetForRun(resourcePlan = {}) {
  const control = resourcePlan?.control ?? normalizeAdaptiveControl({});
  const depth = ADAPTIVE_DEPTHS.includes(text(control?.depth).toLowerCase())
    ? text(control.depth).toLowerCase()
    : 'standard';
  const defaults = ADAPTIVE_BUDGETS[depth];
  return {
    maxToolCalls: Number(control?.budget?.maxToolCalls) || defaults.maxToolCalls,
    maxExecutionStages: Number(control?.budget?.maxExecutionStages) || defaults.maxExecutionStages,
    maxWorkflowNodes: Number(control?.budget?.maxWorkflowNodes) || defaults.maxWorkflowNodes,
    maxDiscoveryRounds: Number(control?.budget?.maxDiscoveryRounds) || defaults.maxDiscoveryRounds,
    maxContextItems: Number(control?.budget?.maxContextItems) || defaults.maxContextItems,
    allowAdaptiveExpansion: control?.allowAdaptiveExpansion === true
  };
}

export function adaptiveBudgetStatus(tasks = [], resourcePlan = {}) {
  const budget = adaptiveBudgetForRun(resourcePlan);
  const discoveryTypes = new Set(['discover-capabilities', 'reassess']);
  const toolCalls = tasks.reduce((total, task) => total + (
    task.status === 'complete' && Array.isArray(task.evidence?.tools)
      ? task.evidence.tools.length
      : 0
  ), 0);
  const executionStages = tasks.filter(task =>
    task.status === 'complete'
    && task.metadata?.execution === true
  ).length;
  const discoveryRounds = tasks.filter(task =>
    task.status === 'complete' && discoveryTypes.has(task.type)
  ).length;
  const workflowNodes = tasks.length;
  return {
    budget,
    used: { toolCalls, executionStages, discoveryRounds, workflowNodes },
    remaining: {
      toolCalls: Math.max(0, budget.maxToolCalls - toolCalls),
      executionStages: Math.max(0, budget.maxExecutionStages - executionStages),
      discoveryRounds: Math.max(0, budget.maxDiscoveryRounds - discoveryRounds),
      workflowNodes: Math.max(0, budget.maxWorkflowNodes - workflowNodes)
    },
    exceeded: {
      toolCalls: toolCalls >= budget.maxToolCalls,
      executionStages: executionStages >= budget.maxExecutionStages,
      discoveryRounds: discoveryRounds >= budget.maxDiscoveryRounds,
      workflowNodes: workflowNodes >= budget.maxWorkflowNodes
    },
    expansionAllowed: budget.allowAdaptiveExpansion,
    decision: (toolCalls >= budget.maxToolCalls || executionStages >= budget.maxExecutionStages
      || discoveryRounds >= budget.maxDiscoveryRounds || workflowNodes >= budget.maxWorkflowNodes)
      ? (budget.allowAdaptiveExpansion ? 'expansion-may-be-requested' : 'stop-or-request-expansion')
      : 'continue-within-scope'
  };
}
