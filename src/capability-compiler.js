/**
 * Open-world capability implementation compiler.
 *
 * Discovery is not execution. This module turns capability requirements into
 * explicit implementation routes and tells the runtime what is actually
 * executable. It never fabricates a solver, connector, runner, hardware
 * interface, or verification result.
 */

const text = value => String(value ?? '').trim();

const NATIVE = new Set([
  'reasoning','situation-understanding','capability-compilation','planning',
  'verification','iteration','adaptive-safety-governance','code-generation','code-execution',
  'design','invention','hypothesis-generation','concept-evaluation',
  'experiment-design','file-analysis','adaptive-composition'
]);

const COMPOSABLE = new Set([
  'response','artifact-creation','artifact-transformation','modeling',
  'innovation','evidence-retrieval','adaptive-execution','external-data-routing'
]);

/** Capabilities the server provides itself, which discovery never needs to add or have approved. */
export const BUILT_IN_CAPABILITIES = Object.freeze([...NATIVE, ...COMPOSABLE]);
export const isBuiltInCapability = id => NATIVE.has(id) || COMPOSABLE.has(id);

const HIGH_RISK = new Set(['code-execution','adaptive-execution']);

// These requirements describe side-effecting or environment-dependent work.
// They are never executable merely because the planner knows their names.
const RUNTIME_BOUND = new Set(['code-execution','evidence-retrieval','external-data-routing','adaptive-execution']);

function lifecycleFor(requirement, implementation) {
  const stages = ['discover', 'specify', 'implementation-check'];
  if (implementation.requiresApproval) stages.push('approval');
  if (implementation.executable) stages.push('execute', 'observe', 'verify');
  else stages.push('register-or-build');
  stages.push(implementation.executable ? 'promote-or-rollback' : 'await-implementation');
  return {
    state: implementation.executable ? 'ready-for-execution' : 'awaiting-implementation',
    stages,
    reversible: implementation.executable === true,
    evidenceRequired: implementation.executable === true
      ? 'Observed execution evidence must be bound to the capability version before promotion.'
      : 'A concrete implementation must be registered and independently verified before execution.',
    capabilityVersion: text(requirement.version) || 'candidate'
  };
}

function buildCapabilityGraph(implementations) {
  const nodes = implementations.map(item => ({
    id: item.capabilityId,
    route: item.route,
    status: item.status,
    executable: item.executable,
    dependencies: [...(item.dependencies ?? [])],
    requiresApproval: item.requiresApproval,
    lifecycle: item.lifecycle
  }));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const builtInDependencies = new Set([...NATIVE, ...COMPOSABLE]);
  const missingDependencies = [];
  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      const dependencyId = text(dependency);
      const dep = byId.get(dependencyId);
      if ((!dep && !builtInDependencies.has(dependencyId)) || (dep && !dep.executable)) {
        missingDependencies.push({ capabilityId: node.id, dependency: dependencyId });
      }
    }
  }
  const executionOrder = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = id => {
    if (visited.has(id)) return;
    if (visiting.has(id)) return; // Cycles remain visible in edges; do not recurse forever.
    visiting.add(id);
    const node = byId.get(id);
    for (const dependency of node?.dependencies ?? []) {
      const dependencyId = text(dependency);
      if (byId.get(dependencyId)?.executable) visit(dependencyId);
    }
    visiting.delete(id);
    visited.add(id);
    if (node?.executable && !missingDependencies.some(item => item.capabilityId === id)) executionOrder.push(id);
  };
  for (const node of nodes) visit(node.id);
  return {
    schemaVersion: '1',
    nodes,
    edges: nodes.flatMap(node => node.dependencies.map(dependency => ({
      from: text(dependency),
      to: node.id,
      type: 'requires'
    }))),
    missingDependencies,
    executionOrder
  };
}

function normalizeRequirement(item) {
  if (typeof item === 'string') return { id: text(item), category: 'unknown', source: 'unknown', dynamic: true };
  return {
    ...item,
    id: text(item?.id),
    category: text(item?.category) || 'unknown',
    source: text(item?.source) || 'unknown',
    dynamic: item?.dynamic === true,
    risk: text(item?.risk) || 'medium'
  };
}

function ids(values = []) {
  return new Set((values ?? []).map(item =>
    text(typeof item === 'string' ? item : item?.id || item?.name).toLowerCase()
  ).filter(Boolean));
}

function routeFor(requirement, context) {
  const id = requirement.id;
  const connectors = ids(context.connectors);
  const runtimes = ids(context.runtimes);
  const targets = ids(context.executionTargets);
  const hardware = ids(context.hardwareRunners);

  // Runtime-bound capabilities are resolved against concrete deployment
  // resources first. A planner/catalog entry is not evidence of availability.
  if (RUNTIME_BOUND.has(id)) {
    const targetMap = {
      'code-execution': ['local','general-ai-sandbox'],
      'evidence-retrieval': ['builtin-research','builtin-tools','generic-tool-router'],
      'external-data-routing': ['generic-tool-router'],
      // Kindgleam's own toolbox (files, data, web, sandbox, schedules and the
      // workspace's own tools) carries out discovered capabilities.
      'adaptive-execution': ['builtin-tools','generic-tool-router']
    };
    // Public web data needs no authorized connector, so provider web search
    // can route it; anything private still needs the generic tool boundary.
    const dataClasses = Array.isArray(requirement.dataClasses) ? requirement.dataClasses : [];
    if (id === 'external-data-routing' && dataClasses.length && dataClasses.every(item => item === 'public-web')) {
      targetMap[id] = ['builtin-research', ...targetMap[id]];
    }
    const target = (targetMap[id] ?? []).find(item => targets.has(item));
    if (target || runtimes.has(id.toLowerCase()) || runtimes.has('generic-tool-router')) return {
      route: target ? 'execution-target' : 'runtime',
      status: 'runtime-available',
      executable: true,
      reason: target
        ? `A configured execution target (${target}) can provide this capability.`
        : 'A concrete runtime implementation was supplied by the deployment.'
    };
    if ((id === 'external-data-routing' || id === 'adaptive-execution') && connectors.size) return {
      route: 'connector',
      status: 'connector-dependent',
      executable: context.connectorAccessReady === true,
      reason: context.connectorAccessReady === true
        ? 'A configured connector is available and authorized for this capability.'
        : 'A connector exists, but authorization is not established.'
    };
    return {
      route: 'implementation-required',
      status: 'runtime-required',
      executable: false,
      reason: 'This capability requires a concrete runtime, execution target, or connector; none is registered for this deployment.'
    };
  }

  if (NATIVE.has(id)) return {
    route: 'native',
    status: 'available',
    executable: true,
    reason: 'Provided by the platform bootstrap runtime.'
  };
  if (COMPOSABLE.has(id)) return {
    route: 'composite',
    status: 'composable',
    executable: true,
    reason: 'Can be assembled from governed platform primitives.'
  };

  // A generic router or hardware pool is not an implementation of a capability
  // that was only discovered; those need their own registered runner.
  const discovered = Boolean(requirement.dynamic) || requirement.source === 'discoverable';
  if (runtimes.has(id.toLowerCase()) || (!discovered && runtimes.has('generic-tool-router'))) return {
    route: 'runtime',
    status: 'runtime-available',
    executable: true,
    reason: 'A concrete runtime implementation was supplied by the deployment.'
  };

  if (hardware.has(id.toLowerCase()) || (!discovered && hardware.has('hardware'))) return {
    route: 'hardware',
    status: 'hardware-available',
    executable: true,
    reason: 'A concrete hardware runner was supplied by the deployment.'
  };

  if (discovered) return {
    route: 'implementation-required',
    status: 'discovered-not-implemented',
    executable: false,
    reason: 'The capability is known to be required, but no concrete implementation/runner is currently registered.'
  };

  return {
    route: 'unavailable',
    status: 'not-implemented',
    executable: false,
    reason: 'No concrete implementation was registered for this capability.'
  };
}

export function compileCapabilityImplementations(requirements = [], context = {}) {
  const normalized = requirements.map(normalizeRequirement).filter(item => item.id);
  const implementations = normalized.map(requirement => {
    const route = routeFor(requirement, context);
    return {
      capabilityId: requirement.id,
      ...route,
      risk: requirement.risk || (HIGH_RISK.has(requirement.id) ? 'high' : 'medium'),
      requiresApproval: requirement.risk === 'high' || HIGH_RISK.has(requirement.id),
      dependencies: Array.isArray(requirement.dependencies) ? [...requirement.dependencies] : [],
      implementationSpec: requirement.spec ?? null,
      provenance: {
        source: requirement.source,
        registered: requirement.source !== 'unknown',
        implementationVersion: text(requirement.version) || 'candidate'
      },
      health: {
        status: route.executable ? 'available' : 'unavailable',
        checkedAt: new Date().toISOString()
      },
      evidenceContract: {
        required: route.executable,
        executionReceipt: route.executable,
        verificationResult: route.executable
      }
    };
  });
  for (const implementation of implementations) {
    const requirement = normalized.find(item => item.id === implementation.capabilityId);
    implementation.lifecycle = lifecycleFor(requirement, implementation);
  }
  const capabilityGraph = buildCapabilityGraph(implementations);

  const missing = implementations.filter(item => !item.executable);
  const blocked = implementations.filter(item => item.status === 'connector-dependent' && context.connectorAccessReady !== true);
  const approvalRequired = implementations
    .filter(item => item.executable && item.requiresApproval)
    .map(item => item.capabilityId);
  const ready = missing.length === 0
    && blocked.length === 0
    && capabilityGraph.missingDependencies.length === 0;

  return {
    schemaVersion: '1',
    openWorld: true,
    implementations,
    executable: implementations.filter(item => item.executable).map(item => item.capabilityId),
    missing: missing.map(item => item.capabilityId),
    blocked: blocked.map(item => item.capabilityId),
    capabilityGraph,
    ready,
    executionReady: ready && approvalRequired.length === 0,
    approvalRequired,
    state: missing.length
      ? 'implementation-required'
      : blocked.length
        ? 'authorization-or-connector-required'
        : capabilityGraph.missingDependencies.length
          ? 'dependency-required'
          : approvalRequired.length
            ? 'approval-required'
            : 'ready',
    nextActions: [
      ...missing.map(id => ({ action: 'discover-or-register-implementation', capabilityId: id })),
      ...blocked.map(id => ({ action: 'authorize-and-connect', capabilityId: id })),
      ...capabilityGraph.missingDependencies.map(item => ({
        action: 'satisfy-capability-dependency',
        capabilityId: item.capabilityId,
        dependency: item.dependency
      })),
      ...approvalRequired.map(capabilityId => ({
        action: 'obtain-execution-approval',
        capabilityId
      }))
    ].filter((item, index, items) =>
      items.findIndex(other => JSON.stringify(other) === JSON.stringify(item)) === index
    ),
    principle: 'A discovered capability is never represented as executable until a concrete governed implementation is registered; executable does not mean approved for side effects.'
  };
}


/**
 * Compile only the capabilities needed by one execution task. This is the
 * common gate used by every execution surface so a new task type cannot
 * accidentally bypass the open-world implementation contract.
 */
export function compileExecutionCapabilityPlan(requirements = [], {
  taskType = '',
  executionTargets = [],
  runtimes = [],
  connectors = [],
  connectorAccessReady = false,
  hardwareRunners = []
} = {}) {
  const relevant = requirements.filter(item => {
    const id = text(typeof item === 'string' ? item : item?.id);
    if (!id) return false;
    if (taskType === 'code') return ['code-generation','code-execution'].includes(id);
    if (taskType === 'investigate') return ['evidence-retrieval','external-data-routing','adaptive-execution'].includes(id);
    if (taskType === 'tool') return ['external-data-routing','adaptive-execution'].includes(id);
    return false;
  });
  return compileCapabilityImplementations(relevant, {
    executionTargets,
    runtimes,
    connectors,
    connectorAccessReady,
    hardwareRunners
  });
}
