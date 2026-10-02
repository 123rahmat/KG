/**
 * Adaptive subsystem orchestration for medium, large and very-large coding work.
 *
 * This is a planning/co-ordination layer, not a second execution authority.
 * It turns repository intelligence into bounded subsystem contracts, a
 * dependency DAG, efficient execution waves, and typed peer communication.
 * Writers still require the normal server-owned mutation/revision gates.
 */
import crypto from 'node:crypto';
import { safeWorkspacePath } from './code-workspace.js';

const text = value => String(value ?? '').trim();
const list = value => Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))] : [];
const clip = (value, max) => text(value).slice(0, max);
const normalizeMessagePayload = value => {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {};
  for (const [key, raw] of Object.entries(source).slice(0, 16)) {
    const safeKey = clip(key, 80);
    if (!safeKey) continue;
    if (Array.isArray(raw)) result[safeKey] = raw.slice(0, 12).map(item => clip(typeof item === 'string' ? item : JSON.stringify(item), 700)).filter(Boolean);
    else if (raw && typeof raw === 'object') result[safeKey] = clip(JSON.stringify(raw), 1800);
    else if (typeof raw === 'string') result[safeKey] = clip(raw, 1600);
    else if (typeof raw === 'number' || typeof raw === 'boolean') result[safeKey] = raw;
  }
  const packed = JSON.stringify(result);
  return packed.length <= 7000 ? result : { summary: clip(packed, 6800), truncated: true };
};
const boundedInt = (value, fallback, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : fallback;
};

export const CODE_WORKSPACE_A2A_POLICY = Object.freeze({
  channel: 'typed-project-bus',
  identity: 'project-revision-plus-subsystem-plus-agent',
  scope: 'self-and-dependency-neighbors',
  staleRevision: 'reject-and-rebase',
  contractDrift: 'integration-gate',
  peerData: 'untrusted-data-only',
  rawPeerFindings: 'hidden-from-unrelated-agents',
  crossSubsystemWrites: 'ownership-transfer-required',
  acknowledgement: 'new-message-required',
  deliveryLoop: 'observe-assess-plan-implement-test-repair-reassess-verify-handoff'
});

export const SUBSYSTEM_MESSAGE_TYPES = Object.freeze([
  'contract-update',
  'dependency-request',
  'dependency-response',
  'blocker',
  'handoff',
  'test-result',
  'integration-request'
]);

export const DEFAULT_MAX_SUBSYSTEMS = 12;
export const ABSOLUTE_MAX_SUBSYSTEMS = 24;
export const MAX_SUBSYSTEM_MESSAGES = 64;

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex').slice(0, 24);
}

function fileGroup(path) {
  const safe = safeWorkspacePath(path);
  if (!safe) return null;
  const [head, ...rest] = safe.split('/');
  return rest.length ? head : '__root__';
}

function depthFor(path) {
  return text(path) ? text(path).split('/').length : 0;
}

function directoryChildren(hierarchy, root) {
  const prefix = root ? root + '/' : '';
  const directories = Array.isArray(hierarchy?.directories) ? hierarchy.directories : [];
  const direct = directories
    .filter(item => {
      const path = text(item?.path);
      if (!path || path === root || !path.startsWith(prefix)) return false;
      return depthFor(path) === depthFor(root) + 1;
    })
    .sort((a, b) => Number(b.fileCount || 0) - Number(a.fileCount || 0) || text(a.path).localeCompare(text(b.path)));
  return direct;
}

function topLevelRoots(index) {
  const hierarchy = index?.hierarchy;
  const directories = Array.isArray(hierarchy?.directories) ? hierarchy.directories : [];
  const roots = directories
    .filter(item => depthFor(item?.path) === 1)
    .map(item => text(item.path))
    .filter(Boolean)
    .sort();
  if (roots.length) return roots;
  const planned = [...new Set((index?.plannedRoots ?? []).map(text).filter(Boolean))];
  if (planned.length) return planned;
  // Compact indexes and fixtures may omit hierarchy metadata. Derive stable
  // subsystem candidates from the first path segment without reading content.
  return [...new Set((Array.isArray(index?.files) ? index.files : [])
    .map(file => fileGroup(file?.path))
    .filter(root => root && root !== '__root__'))].sort();
}

function rootStats(index, root) {
  const files = Array.isArray(index?.files) ? index.files : [];
  const prefix = root === '__root__' ? '' : root + '/';
  const owned = files.filter(file => {
    const path = safeWorkspacePath(file?.path);
    return path && (root === '__root__' ? !path.includes('/') : path === root || path.startsWith(prefix));
  });
  const bytes = owned.reduce((sum, file) => sum + Math.max(0, Number(file?.bytes) || 0), 0);
  const tests = owned.filter(file => file?.test === true).length;
  return { files: owned.length, bytes, tests };
}

function chooseUnitRoots(index, target) {
  const roots = topLevelRoots(index);
  const units = roots.map(root => root);
  if ((index?.files ?? []).some(file => fileGroup(file?.path) === '__root__')) units.unshift('__root__');
  if (!units.length) return [];
  const desired = Math.max(1, Math.min(Number(target) || 1, ABSOLUTE_MAX_SUBSYSTEMS));

  // Split the largest hierarchical unit until the target is reachable.
  while (units.length < desired) {
    let bestIndex = -1;
    let bestChildren = [];
    let bestScore = -1;
    for (let i = 0; i < units.length; i += 1) {
      const root = units[i];
      if (root === '__root__') continue;
      const children = directoryChildren(index?.hierarchy, root);
      if (!children.length) continue;
      const stats = rootStats(index, root);
      const score = stats.files + stats.bytes / 1_000_000;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
        bestChildren = children.map(item => text(item.path)).filter(Boolean);
      }
    }
    if (bestIndex < 0 || !bestChildren.length) break;
    const parent = units[bestIndex];
    const slots = desired - units.length + 1;
    if (slots <= 1) break;
    // When a directory has more children than the remaining worker budget,
    // promote only the largest children and keep the parent as a deterministic
    // residual bucket. Longest-prefix ownership ensures files belong to exactly
    // one subsystem even though the residual bucket has a broader root.
    const promoted = bestChildren.slice(0, Math.min(bestChildren.length, slots - 1));
    if (!promoted.length) break;
    units.splice(bestIndex, 1, parent, ...promoted);
    const seen = new Set();
    for (let i = units.length - 1; i >= 0; i -= 1) {
      if (seen.has(units[i])) units.splice(i, 1);
      else seen.add(units[i]);
    }
  }
  return [...new Set(units)];
}

function assignedRoot(path, roots) {
  const safe = safeWorkspacePath(path);
  if (!safe) return null;
  const matches = roots
    .filter(root => root !== '__root__' && (safe === root || safe.startsWith(root + '/')))
    .sort((a, b) => b.length - a.length);
  if (matches.length) return matches[0];
  if (roots.includes('__root__') && !safe.includes('/')) return '__root__';
  return null;
}

function dependencyMetrics(index, roots) {
  const edges = Array.isArray(index?.dependencies) ? index.dependencies : [];
  let cross = 0;
  for (const edge of edges) {
    const from = assignedRoot(edge?.from, roots);
    const to = assignedRoot(edge?.to, roots);
    if (from && to && from !== to) cross += 1;
  }
  return {
    edges: edges.length,
    crossEdges: cross,
    crossEdgeRatio: edges.length ? cross / edges.length : 0
  };
}

export function estimateSubsystemCount(index = {}, {
  maxSubsystems = DEFAULT_MAX_SUBSYSTEMS,
  minFilesPerSubsystem = 8,
  risk = 'ordinary',
  adaptivePressure = 0,
  pressureTrend = 'stable'
} = {}) {
  const files = Math.max(0, Number(index?.fileCount) || (Array.isArray(index?.files) ? index.files.length : 0));
  const bytes = Math.max(0, Number(index?.totals?.bytes) || 0);
  const dependencies = Math.max(0, Number(index?.totals?.dependencies) || Number(index?.dependencies?.length) || 0);
  const roots = topLevelRoots(index);
  const plannedRoots = [...new Set((Array.isArray(index?.plannedRoots) ? index.plannedRoots : []).map(text).filter(Boolean))];
  const scale = text(index?.scale || index?.hierarchy?.scale) || 'small';
  if (plannedRoots.length) {
    const max = boundedInt(maxSubsystems, DEFAULT_MAX_SUBSYSTEMS, ABSOLUTE_MAX_SUBSYSTEMS);
    const count = Math.max(1, Math.min(max, plannedRoots.length, ABSOLUTE_MAX_SUBSYSTEMS));
    return {
      count,
      scale,
      score: Number((count + 0.5).toFixed(3)),
      independentStructure: 1,
      coupling: 0,
      rootCount: plannedRoots.length,
      fileCount: files,
      bytes,
      dependencies,
      reason: 'from-scratch-architectural-scaffold',
      plannedRoots
    };
  }
  if (files <= minFilesPerSubsystem && scale === 'small') {
    return {
      count: 1,
      scale,
      score: 0,
      independentStructure: 1,
      coupling: 0,
      reason: 'single-subsystem-work-is-simpler'
    };
  }

  const base = { small: 1, medium: 2, large: 4, 'very-large': 6 }[scale] ?? 2;
  const density = files ? dependencies / files : 0;
  const structural = Math.min(3, Math.max(0, roots.length - 1) * 0.55);
  const sizePressure = Math.max(0, Math.log2(Math.max(1, files / Math.max(minFilesPerSubsystem, 1))));
  const score = base + Math.min(3.5, sizePressure * 0.65) + structural + Math.min(2.5, density * 3);
  const max = boundedInt(maxSubsystems, DEFAULT_MAX_SUBSYSTEMS, ABSOLUTE_MAX_SUBSYSTEMS);
  const baseUnits = roots.length + (((index?.files ?? []).some(file => fileGroup(file?.path) === '__root__')) ? 1 : 0);
  const capped = Math.max(1, Math.min(max, Math.max(Math.round(score), baseUnits)));

  // Coupled repositories benefit from fewer coordination boundaries. We use a
  // deterministic first-pass grouping estimate from top-level roots.
  const provisionalRoots = chooseUnitRoots(index, Math.min(capped, Math.max(1, roots.length || 1)));
  const coupling = dependencyMetrics(index, provisionalRoots).crossEdgeRatio;
  const pressure = Math.max(0, Math.min(1, Number(adaptivePressure) || 0));
  const trend = text(pressureTrend).toLowerCase() || 'stable';
  let count = capped;
  if (coupling >= 0.55) count -= 2;
  else if (coupling >= 0.35) count -= 1;
  else if (coupling <= 0.08 && provisionalRoots.length >= capped) count += 1;

  // Pressure is a live workload signal, not a replacement for topology. When
  // pressure materially rises, independent work may justify additional
  // subsystem boundaries even when file-count scale has not crossed a new
  // bucket yet. When pressure materially falls and the project is stable, one
  // boundary may be consolidated. Coupling always remains the stronger guard.
  if (pressure >= 0.72 && coupling < 0.45) {
    count += Math.min(3, 1 + Math.floor((pressure - 0.72) / 0.12));
  } else if (pressure <= 0.28 && trend === 'down' && coupling < 0.35 && count > 1) {
    count -= 1;
  }

  if (text(risk).toLowerCase() === 'high-impact' || text(risk).toLowerCase() === 'physical') count = Math.min(count, 4);
  count = Math.max(1, Math.min(max, count));

  return {
    count,
    scale,
    score: Number(score.toFixed(3)),
    independentStructure: Number(Math.max(0, 1 - coupling).toFixed(3)),
    coupling: Number(coupling.toFixed(3)),
    rootCount: roots.length,
    fileCount: files,
    bytes,
    dependencies,
    reason: coupling >= 0.35
      ? 'reduce-subsystems-because-boundaries-are-tightly-coupled'
      : pressure >= 0.72
        ? 'increase-subsystems-because-live-work-pressure-increased'
        : pressure <= 0.28 && trend === 'down'
          ? 'reduce-subsystems-because-live-work-pressure-decreased'
          : 'increase-subsystems-with-project-size-and-independent-structure',
    adaptivePressure: Number(pressure.toFixed(3)),
    pressureTrend: trend
  };
}

function subsystemId(root, index) {
  const base = root === '__root__' ? 'shared-platform' : root
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'subsystem';
  return `${base}-${index + 1}`;
}

export function buildSubsystemPlan(index = {}, {
  maxSubsystems = DEFAULT_MAX_SUBSYSTEMS,
  minFilesPerSubsystem = 8,
  risk = 'ordinary',
  revisionId = null,
  adaptivePressure = 0,
  pressureTrend = 'stable'
} = {}) {
  const decision = estimateSubsystemCount(index, {
    maxSubsystems,
    minFilesPerSubsystem,
    risk,
    adaptivePressure,
    pressureTrend
  });
  const roots = chooseUnitRoots(index, decision.count);
  const effectiveRoots = roots.length ? roots : ['__root__'];
  const files = Array.isArray(index?.files) ? index.files : [];
  const assignments = new Map();
  const sharedPaths = [];
  for (const file of files) {
    const path = safeWorkspacePath(file?.path);
    if (!path) continue;
    const root = assignedRoot(path, effectiveRoots);
    if (root) assignments.set(path, root);
    else sharedPaths.push(path);
  }

  const subsystemMap = new Map();
  effectiveRoots.forEach((root, i) => subsystemMap.set(root, {
    id: subsystemId(root, i),
    roots: [root],
    files: [],
    tests: [],
    readSet: [],
    writeSet: [],
    dependencies: new Set(),
    consumers: new Set(),
    sharedResources: [],
    contractVersion: 1
  }));

  for (const [path, root] of assignments) {
    const subsystem = subsystemMap.get(root);
    if (!subsystem) continue;
    subsystem.files.push(path);
    const record = files.find(item => safeWorkspacePath(item?.path) === path);
    if (record?.test === true) subsystem.tests.push(path);
    subsystem.writeSet.push(path);
  }

  const rootByFile = path => assignments.get(safeWorkspacePath(path)) ?? null;
  for (const edge of Array.isArray(index?.dependencies) ? index.dependencies : []) {
    const from = rootByFile(edge?.from);
    const to = rootByFile(edge?.to);
    if (!from || !to || from === to) continue;
    subsystemMap.get(from)?.dependencies.add(subsystemMap.get(to)?.id);
    subsystemMap.get(to)?.consumers.add(subsystemMap.get(from)?.id);
    subsystemMap.get(from)?.readSet.push(edge.to);
    subsystemMap.get(to)?.readSet.push(edge.from);
  }

  const subsystems = [...subsystemMap.values()].map((item, i) => {
    const filesSorted = [...new Set(item.files)].sort();
    const testsSorted = [...new Set(item.tests)].sort();
    const readSet = [...new Set(item.readSet)].sort();
    const contract = {
      id: item.id,
      ownerRoot: item.roots[0],
      paths: filesSorted,
      tests: testsSorted,
      dependencies: [...item.dependencies].sort(),
      consumers: [...item.consumers].sort(),
      sharedResources: item.sharedResources,
      publicInterfaces: [],
      invariants: [],
      version: item.contractVersion
    };
    return {
      id: item.id,
      ordinal: i,
      roots: item.roots,
      fileCount: filesSorted.length,
      files: filesSorted,
      tests: testsSorted,
      readSet,
      writeSet: filesSorted,
      dependencies: contract.dependencies,
      consumers: contract.consumers,
      sharedResources: item.sharedResources,
      contract: {
        ...contract,
        fingerprint: digest(contract)
      },
      baseRevision: text(revisionId || index?.revisionId || index?.contentHash) || null
    };
  });

  const subsystemById = new Map(subsystems.map(item => [item.id, item]));
  const indegree = new Map(subsystems.map(item => [item.id, item.dependencies.filter(dep => subsystemById.has(dep)).length]));
  const waves = [];
  const remaining = new Set(subsystems.map(item => item.id));
  let cycleDetected = false;
  while (remaining.size) {
    const wave = [...remaining]
      .filter(id => indegree.get(id) === 0)
      .sort((a, b) => subsystemById.get(a).ordinal - subsystemById.get(b).ordinal);
    if (!wave.length) {
      // A dependency cycle is an architectural boundary problem. Keep the
      // plan inspectable but force a serialized cycle; a normal parallel wave
      // would let mutually dependent workers race each other.
      cycleDetected = true;
      waves.push([...remaining].sort((a, b) => subsystemById.get(a).ordinal - subsystemById.get(b).ordinal));
      break;
    }
    waves.push(wave);
    for (const id of wave) {
      remaining.delete(id);
      for (const consumer of subsystemById.get(id)?.consumers ?? []) {
        if (indegree.has(consumer)) indegree.set(consumer, Math.max(0, indegree.get(consumer) - 1));
      }
    }
  }

  const metrics = dependencyMetrics(index, effectiveRoots);
  const shared = {
    id: 'shared-integration',
    files: [...new Set(sharedPaths)].sort(),
    reason: sharedPaths.length ? 'files-without-a-safe-subsystem-owner' : 'no-unassigned-project-files'
  };

  return {
    version: 1,
    kind: 'adaptive-subsystem-plan',
    scale: decision.scale,
    decision,
    project: {
      revisionId: text(revisionId || index?.revisionId || index?.contentHash) || null,
      contentHash: text(index?.contentHash) || null,
      fileCount: files.length
    },
    metrics: {
      crossEdgeRatio: Number(metrics.crossEdgeRatio.toFixed(3)),
      crossEdges: metrics.crossEdges,
      dependencyEdges: metrics.edges,
      parallelWaveCount: waves.length,
      sharedFileCount: shared.files.length
    },
    subsystems,
    waves: waves.map((ids, indexValue) => ({
      index: indexValue,
      subsystemIds: ids,
      parallel: !cycleDetected && ids.length > 1,
      ...(cycleDetected && indexValue === waves.length - 1 ? { cycleDetected: true } : {})
    })),
    shared,
    policy: {
      communication: 'typed-project-bus',
      writes: 'exact-revision-plus-owned-paths',
      merge: 'integration-gate',
      replanning: 'after-material-boundary-or-contract-change'
    }
  };
}

export function compactSubsystemPlan(plan, { maxSubsystems = DEFAULT_MAX_SUBSYSTEMS, maxFilesPerSubsystem = 60 } = {}) {
  if (!plan || typeof plan !== 'object') return null;
  return {
    version: plan.version,
    kind: plan.kind,
    scale: plan.scale,
    decision: plan.decision ?? null,
    project: plan.project ?? null,
    metrics: plan.metrics ?? null,
    subsystems: (Array.isArray(plan.subsystems) ? plan.subsystems : [])
      .slice(0, Math.max(1, Math.min(ABSOLUTE_MAX_SUBSYSTEMS, Number(maxSubsystems) || DEFAULT_MAX_SUBSYSTEMS)))
      .map(item => ({
        id: item.id,
        ordinal: item.ordinal,
        roots: list(item.roots),
        fileCount: Number(item.fileCount) || 0,
        files: list(item.files).slice(0, maxFilesPerSubsystem),
        tests: list(item.tests).slice(0, Math.min(40, maxFilesPerSubsystem)),
        readSet: list(item.readSet).slice(0, 40),
        writeSet: list(item.writeSet).slice(0, maxFilesPerSubsystem),
        dependencies: list(item.dependencies),
        consumers: list(item.consumers),
        contract: item.contract ?? null,
        baseRevision: item.baseRevision ?? null
      })),
    waves: (Array.isArray(plan.waves) ? plan.waves : []).slice(0, 24),
    shared: {
      id: plan.shared?.id ?? 'shared-integration',
      files: list(plan.shared?.files).slice(0, Math.min(60, maxFilesPerSubsystem)),
      reason: text(plan.shared?.reason)
    },
    policy: plan.policy ?? null
  };
}

export function subsystemAssignment(plan, { role = 'subsystem-worker', preferredId = null, ordinal = 0 } = {}) {
  const subsystems = Array.isArray(plan?.subsystems) ? plan.subsystems : [];
  if (!subsystems.length) return null;
  if (preferredId && subsystems.some(item => item.id === preferredId)) return subsystems.find(item => item.id === preferredId);
  const index = Math.max(0, Number(ordinal) || 0) % subsystems.length;
  return { ...subsystems[index], assignedRole: text(role) || 'subsystem-worker' };
}

export function createSubsystemMessage({
  type,
  from,
  to = null,
  subsystemId = null,
  projectRevision = null,
  contractVersion = null,
  payload = {}
} = {}) {
  const normalizedType = SUBSYSTEM_MESSAGE_TYPES.includes(text(type)) ? text(type) : null;
  const messagePayload = normalizeMessagePayload(payload);
  const body = {
    type: normalizedType,
    from: text(from) || null,
    to: text(to) || null,
    subsystemId: text(subsystemId) || null,
    projectRevision: text(projectRevision) || null,
    contractVersion: Number.isFinite(Number(contractVersion)) ? Number(contractVersion) : null,
    payload: messagePayload
  };
  if (!body.type || !body.from || !body.subsystemId) return null;
  return Object.freeze({
    id: digest(body),
    ...body,
    createdAt: new Date().toISOString()
  });
}

export function mergeSubsystemMessages(current = [], incoming = [], { limit = MAX_SUBSYSTEM_MESSAGES } = {}) {
  const all = [...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])]
    .filter(item => item && SUBSYSTEM_MESSAGE_TYPES.includes(text(item.type)) && text(item.from) && text(item.subsystemId))
    .map(item => ({
      id: text(item.id) || digest({
        type: text(item.type),
        from: text(item.from),
        to: text(item.to),
        subsystemId: text(item.subsystemId),
        projectRevision: text(item.projectRevision),
        contractVersion: item.contractVersion ?? null,
        payload: item.payload && typeof item.payload === 'object' ? item.payload : {}
      }),
      type: text(item.type),
      from: text(item.from),
      to: text(item.to) || null,
      subsystemId: text(item.subsystemId),
      projectRevision: text(item.projectRevision) || null,
      contractVersion: Number.isFinite(Number(item.contractVersion)) ? Number(item.contractVersion) : null,
      payload: item.payload && typeof item.payload === 'object' ? item.payload : {},
      createdAt: text(item.createdAt) || new Date().toISOString()
    }));
  const deduped = [...new Map(all.map(item => [item.id, item])).values()];
  return deduped.slice(-Math.max(1, Math.min(MAX_SUBSYSTEM_MESSAGES, Number(limit) || MAX_SUBSYSTEM_MESSAGES)));
}

export function subsystemCommunicationContext(plan, subsystemId, messages = []) {
  const subsystem = (plan?.subsystems ?? []).find(item => item.id === subsystemId);
  if (!subsystem) return null;
  const currentRevision = text(subsystem.baseRevision);
  const relevantMessages = mergeSubsystemMessages([], messages)
    .filter(item => (!currentRevision || item.projectRevision === currentRevision))
    .filter(item => !item.to || item.to === subsystemId || item.subsystemId === subsystemId)
    .slice(-24);
  return {
    subsystem: {
      id: subsystem.id,
      roots: subsystem.roots,
      files: subsystem.files,
      tests: subsystem.tests,
      dependencies: subsystem.dependencies,
      consumers: subsystem.consumers,
      contract: subsystem.contract,
      baseRevision: subsystem.baseRevision
    },
    neighborContracts: (plan.subsystems ?? [])
      .filter(item => item.id !== subsystem.id && (
        subsystem.dependencies.includes(item.id) || subsystem.consumers.includes(item.id)
      ))
      .map(item => ({ id: item.id, contract: item.contract, paths: item.roots })),
    messages: relevantMessages,
    rules: {
      peerDataIsUntrusted: true,
      contractChangesRequireIntegration: true,
      crossSubsystemWritesRequireOwnershipTransfer: true,
      staleRevisionRequiresRebase: true,
      ...CODE_WORKSPACE_A2A_POLICY
    }
  };
}
