/**
 * Execution placement and local-resource preflight.
 *
 * This module is deliberately pure. It describes where work may run; it does
 * not execute anything. Concrete runners remain outside the Kindgleam
 * process and must return real evidence before a task can complete.
 */

import crypto from 'node:crypto';

const text = value => String(value ?? '').trim();
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const nonNegative = value => {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
};

export const EXECUTION_TARGETS = Object.freeze([
  {
    id: 'local',
    label: 'Local machine',
    taskTypes: Object.freeze(['code']),
    location: 'user-device',
    requiresLocalPreflight: true,
    requiresApproval: true,
    dataTransfer: 'none-by-default',
    receipt: 'hmac-signed'
  },
  {
    id: 'general-ai-sandbox',
    label: 'Kindgleam sandbox',
    taskTypes: Object.freeze(['code']),
    location: 'general-ai-runtime',
    requiresLocalPreflight: false,
    requiresApproval: true,
    dataTransfer: 'workspace-scoped',
    receipt: 'server-managed'
  },
  {
    id: 'generic-tool-router',
    label: 'Authorized tool boundary',
    taskTypes: Object.freeze(['tool', 'investigate']),
    location: 'deployment-defined',
    requiresLocalPreflight: false,
    requiresApproval: true,
    dataTransfer: 'policy-scoped',
    receipt: 'server-managed'
  },
  {
    id: 'builtin-tools',
    label: 'Built-in tools (files, data, web, code sandbox, workspace tools)',
    taskTypes: Object.freeze(['tool']),
    location: 'application-runtime',
    requiresLocalPreflight: false,
    requiresApproval: true,
    dataTransfer: 'provider-scoped',
    receipt: 'server-managed'
  },
  {
    id: 'builtin-research',
    label: 'Built-in research (web search, pages, downloads, files)',
    taskTypes: Object.freeze(['investigate']),
    location: 'application-runtime',
    requiresLocalPreflight: false,
    requiresApproval: true,
    dataTransfer: 'provider-scoped',
    receipt: 'server-managed'
  }
]);

export const RECEIPT_ALGORITHM = 'HMAC-SHA256';

const targetMap = new Map(EXECUTION_TARGETS.map(target => [target.id, target]));

export function executionTargetCatalog() {
  return EXECUTION_TARGETS.map(target => ({ ...target, taskTypes: [...target.taskTypes] }));
}

export function executionTargetsFor(taskType) {
  const kind = text(taskType);
  return EXECUTION_TARGETS
    .filter(target => target.taskTypes.includes(kind))
    .map(target => target.id);
}

export function executionTarget(id) {
  return targetMap.get(text(id)) ?? null;
}


/**
 * Decide whether a coding task may enter direct code-generation mode or must
 * stop for a human decision first. Generating code is distinct from executing
 * it on a machine: execution targets keep their own explicit approval gate.
 */
export function codeActionDecision({
  task = {},
  run = {},
  userApproved = false
} = {}) {
  const risk = text(run?.situation?.risk).toLowerCase();
  const codeTask = task?.type === 'code' || task?.id === 'build-code' || task?.metadata?.buildPlan === true;
  if (!codeTask) {
    return {
      action: 'not-code',
      requiresApproval: false,
      reason: 'The task is not a coding task.'
    };
  }

  if (task?.metadata?.requiresClarification === true) {
    return {
      action: 'clarify',
      requiresApproval: true,
      reason: 'Material ambiguity remains and needs the person to clarify before coding.'
    };
  }

  const explicitApprovalRequired = task?.metadata?.approvalRequired === true;
  const highRisk = new Set(['high-impact', 'physical', 'regulated', 'critical']).has(risk);
  const repairAfterFailure = Number(run?.attempt ?? 1) > 1 || task?.id === 'test-code';
  if ((explicitApprovalRequired || highRisk) && !userApproved && !repairAfterFailure) {
    return {
      action: 'approval-required',
      requiresApproval: true,
      reason: explicitApprovalRequired
        ? 'This coding task is marked for explicit human approval.'
        : 'High-risk coding requires explicit human approval before direct code generation.'
    };
  }

  return {
    action: 'direct-code',
    requiresApproval: false,
    reason: repairAfterFailure
      ? 'Scoped coding repair is already authorized by the active task and its prior execution.'
      : 'The coding task is sufficiently specified for direct server-side code generation; external execution remains separately gated.'
  };
}

function normalizeGpu(gpu = {}) {
  return {
    available: gpu?.available === true,
    name: text(gpu?.name),
    vendor: text(gpu?.vendor),
    memoryBytes: nonNegative(gpu?.memoryBytes)
  };
}

export function normalizePreflight(preflight = {}) {
  const software = preflight?.software && typeof preflight.software === 'object'
    ? Object.fromEntries(
        Object.entries(preflight.software)
          .filter(([name, version]) => text(name) && text(version))
          .map(([name, version]) => [text(name), text(version)])
      )
    : {};

  return {
    version: text(preflight.version) || '1',
    source: text(preflight.source) || 'browser',
    platform: text(preflight.platform),
    architecture: text(preflight.architecture),
    cpuCores: nonNegative(preflight.cpuCores),
    memoryBytes: nonNegative(preflight.memoryBytes),
    availableMemoryBytes: nonNegative(preflight.availableMemoryBytes),
    storageBytes: nonNegative(preflight.storageBytes),
    availableStorageBytes: nonNegative(preflight.availableStorageBytes),
    gpu: normalizeGpu(preflight.gpu),
    software,
    agent: {
      available: preflight?.agent?.available === true,
      version: text(preflight?.agent?.version)
    },
    checkedAt: text(preflight.checkedAt) || new Date().toISOString()
  };
}

export function defaultExecutionRequirements(taskType, overrides = {}) {
  const kind = text(taskType);
  const base = kind === 'code'
    ? {
        cpuCores: 2,
        memoryBytes: 2 * 1024 ** 3,
        storageBytes: 1 * 1024 ** 3,
        gpu: { required: false, memoryBytes: 0 },
        software: {}
      }
    : {
        cpuCores: 1,
        memoryBytes: 512 * 1024 ** 2,
        storageBytes: 256 * 1024 ** 2,
        gpu: { required: false, memoryBytes: 0 },
        software: {}
      };

  const resources = overrides && typeof overrides === 'object' ? overrides : {};
  return {
    cpuCores: Math.max(base.cpuCores, nonNegative(resources.cpuCores) ?? 0),
    memoryBytes: Math.max(base.memoryBytes, nonNegative(resources.memoryBytes) ?? 0),
    storageBytes: Math.max(base.storageBytes, nonNegative(resources.storageBytes) ?? 0),
    gpu: {
      required: resources?.gpu?.required === true || base.gpu.required,
      memoryBytes: Math.max(base.gpu.memoryBytes, nonNegative(resources?.gpu?.memoryBytes) ?? 0)
    },
    software: {
      ...base.software,
      ...(resources?.software && typeof resources.software === 'object' ? resources.software : {})
    }
  };
}

export function assessLocalCompatibility(taskType, preflight, requirements = {}) {
  const actual = normalizePreflight(preflight);
  const required = defaultExecutionRequirements(taskType, requirements);
  // Shortfalls are proven; unknowns only mean the preflight has not said.
  // An unknown must route to a preflight, never be treated as insufficient.
  const reasons = [];
  const unknowns = [];

  if (actual.agent.available !== true) reasons.push('a paired local execution agent is required');

  if (actual.cpuCores === null) unknowns.push('CPU core count is unknown');
  else if (actual.cpuCores < required.cpuCores) reasons.push(`requires at least ${required.cpuCores} CPU cores`);

  const memory = actual.availableMemoryBytes ?? actual.memoryBytes;
  if (memory === null) unknowns.push('available RAM is unknown');
  else if (memory < required.memoryBytes) reasons.push(`requires at least ${formatBytes(required.memoryBytes)} available RAM`);

  const storage = actual.availableStorageBytes ?? actual.storageBytes;
  if (storage === null) unknowns.push('available storage is unknown');
  else if (storage < required.storageBytes) reasons.push(`requires at least ${formatBytes(required.storageBytes)} free storage`);

  if (required.gpu.required && !actual.gpu.available) reasons.push('a compatible GPU is required');
  if (required.gpu.memoryBytes > 0 && (actual.gpu.memoryBytes ?? 0) < required.gpu.memoryBytes) {
    reasons.push(`requires at least ${formatBytes(required.gpu.memoryBytes)} GPU memory`);
  }

  for (const [name, version] of Object.entries(required.software)) {
    const installed = actual.software[name];
    if (!installed) {
      reasons.push(`required software is missing: ${name} ${version}`);
      continue;
    }
    if (!versionAtLeast(installed, version)) {
      reasons.push(`requires ${name} ${version} or newer (found ${installed})`);
    }
  }

  return {
    compatible: reasons.length === 0 && unknowns.length === 0,
    status: reasons.length ? 'insufficient' : unknowns.length ? 'unknown' : 'compatible',
    reasons: [...reasons, ...unknowns],
    requirements: required,
    preflight: actual
  };
}

export function chooseExecutionTarget(taskType, {
  preference = 'auto',
  preflight = null,
  requirements = {},
  cloudFallbackAllowed = true,
  availableTargets = executionTargetsFor(taskType)
} = {}) {
  const kind = text(taskType);
  const candidates = [...new Set(availableTargets.filter(target => executionTarget(target)?.taskTypes.includes(kind)))];
  if (!candidates.length) {
    return {
      status: 'unsupported',
      taskType: kind,
      target: null,
      options: [],
      reason: 'No execution target is configured for this task type.'
    };
  }

  const requested = text(preference) || 'auto';
  const hasLocalCandidate = candidates.includes('local');
  const hasPreflight = Boolean(preflight && typeof preflight === 'object' && Object.keys(preflight).length);
  if (hasLocalCandidate && (requested === 'auto' || requested === 'local') && !hasPreflight) {
    return {
      status: 'preflight-required',
      taskType: kind,
      target: null,
      options: candidates,
      reason: 'Local execution requires an exact local-agent preflight before a local or cloud target is selected.'
    };
  }

  const local = hasLocalCandidate
    ? assessLocalCompatibility(kind, preflight ?? {}, requirements)
    : null;

  if (requested !== 'auto') {
    if (!candidates.includes(requested)) {
      return {
        status: 'invalid-selection',
        taskType: kind,
        target: null,
        options: candidates,
        local,
        reason: `Execution target "${requested}" is not available for ${kind} tasks.`
      };
    }
    if (requested === 'local' && local?.status !== 'compatible') {
      return {
        status: local?.status === 'unknown' ? 'preflight-required' : 'local-insufficient',
        taskType: kind,
        target: null,
        options: candidates,
        local,
        reason: local?.reasons?.join('; ') || 'Local preflight did not establish compatibility.'
      };
    }
    return {
      status: 'approval-required',
      taskType: kind,
      target: requested,
      options: candidates,
      local,
      requiresApproval: true,
      approvalReason: 'The selected execution target is authorized but must be explicitly approved by a human.'
    };
  }

  if (local?.status === 'compatible') {
    return {
      status: 'approval-required',
      taskType: kind,
      target: 'local',
      options: candidates,
      local,
      requiresApproval: true,
      approvalReason: 'Local execution is compatible; explicit approval is still required.'
    };
  }

  // Without a usable local machine, code runs in Kindgleam's own sandbox.
  const fallback = 'general-ai-sandbox';
  if (cloudFallbackAllowed && candidates.includes(fallback)) {
    return {
      status: 'approval-required',
      taskType: kind,
      target: fallback,
      options: candidates,
      local,
      fallbackFromLocal: true,
      requiresApproval: true,
      approvalReason: 'Local execution is unavailable or insufficient; the fallback target is still subject to explicit approval.'
    };
  }

  return {
    status: local?.status === 'unknown' ? 'preflight-required' : 'local-insufficient',
    taskType: kind,
    target: null,
    options: candidates,
    local,
    reason: local?.reasons?.join('; ') || 'No compatible execution target is available.'
  };
}

/**
 * The identity of one execution. A runner replays the receipt of an ID it
 * has seen (so a retried request never runs twice), so each fixed version of
 * code is a new execution: `round` is the repair round (0 before any fix).
 */
export function executionIdFor({ runId, taskId, attempt = 0, executionTarget = '', round = 0 } = {}) {
  const repairRound = Number.isInteger(Number(round)) && Number(round) > 0 ? Number(round) : 0;
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      runId: text(runId),
      taskId: text(taskId),
      attempt: Number.isInteger(Number(attempt)) ? Number(attempt) : 0,
      executionTarget: text(executionTarget),
      // Left out before any fix, so first executions keep their IDs.
      ...(repairRound ? { round: repairRound } : {})
    }), 'utf8')
    .digest('hex');
}

function canonicalPayloadValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(canonicalPayloadValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort()
        .filter(key => value[key] !== undefined)
        .map(key => [key, canonicalPayloadValue(value[key])])
    );
  }
  return null;
}

export function canonicalExecutionReceipt({ runId, taskId, taskType, attempt = 0, challengeNonce = '', receipt = {} } = {}) {
  const outputHash = crypto.createHash('sha256')
    .update(String(receipt.stdout ?? ''), 'utf8')
    .digest('hex');
  const errorHash = crypto.createHash('sha256')
    .update(String(receipt.stderr ?? ''), 'utf8')
    .digest('hex');

  return JSON.stringify({
    runId: text(runId),
    taskId: text(taskId),
    taskType: text(taskType),
    attempt: Number.isInteger(Number(attempt)) ? Number(attempt) : 0,
    executionId: text(receipt.executionId),
    challengeNonce: text(challengeNonce || receipt.challengeNonce),
    executionTarget: text(receipt.executionTarget),
    payloadDigest: text(receipt.payloadDigest),
    executed: receipt.executed === true,
    status: text(receipt.status),
    exitCode: Number.isInteger(receipt.exitCode) ? receipt.exitCode : null,
    signal: text(receipt.signal),
    outputTruncated: receipt.outputTruncated === true,
    stdoutHash: outputHash,
    stderrHash: errorHash,
    startedAt: text(receipt.startedAt),
    completedAt: text(receipt.completedAt),
    agentVersion: text(receipt.agentVersion)
  });
}

export function executionSucceeded(result = {}) {
  if (result?.executed !== true) return false;
  const status = text(result?.status).toLowerCase();
  if (['completed', 'complete', 'success', 'succeeded', 'passed'].includes(status)) {
    return result?.exitCode === undefined || result?.exitCode === null || result?.exitCode === 0;
  }
  return false;
}

/**
 * The fingerprint of exactly the code a local execution may run. It is part
 * of the signed challenge, so a challenge approved for one program cannot be
 * used to run another, whoever carries it between server and agent.
 */
export function executionPayloadDigest(payload = {}) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalPayloadValue(payload)), 'utf8')
    .digest('base64url');
}

export function signExecutionChallenge(secret, context = {}) {
  const key = text(secret);
  if (!key) return null;
  const payload = JSON.stringify({
    runId: text(context.runId),
    taskId: text(context.taskId),
    taskType: text(context.taskType),
    attempt: Number.isInteger(Number(context.attempt)) ? Number(context.attempt) : 0,
    executionId: text(context.executionId),
    executionTarget: text(context.executionTarget),
    expiresAt: text(context.expiresAt),
    nonce: text(context.nonce),
    payloadDigest: text(context.payloadDigest)
  });
  return crypto.createHmac('sha256', key).update(payload, 'utf8').digest('base64url');
}

export function verifyExecutionChallenge(secret, context = {}, signature) {
  const expected = signExecutionChallenge(secret, context);
  const supplied = text(signature);
  if (!expected || !supplied) return false;
  if (!context.expiresAt || Date.parse(context.expiresAt) <= Date.now()) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function signExecutionReceipt(secret, context = {}) {
  const key = text(secret);
  if (!key) return null;
  return crypto.createHmac('sha256', key)
    .update(canonicalExecutionReceipt(context), 'utf8')
    .digest('base64url');
}

export function verifyExecutionReceipt(secret, context = {}, signature) {
  const expected = signExecutionReceipt(secret, context);
  const supplied = text(signature);
  if (!expected || !supplied) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

export function formatBytes(bytes) {
  const value = nonNegative(bytes);
  if (value === null) return 'unknown size';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}


function versionParts(value) {
  const matches = text(value).match(/\d+(?:\.\d+)*/);
  return matches ? matches[0].split('.').map(Number) : [];
}

function versionAtLeast(installed, required) {
  const actual = versionParts(installed);
  const minimum = versionParts(required);
  if (!actual.length || !minimum.length) return false;
  const width = Math.max(actual.length, minimum.length);
  for (let index = 0; index < width; index += 1) {
    const a = actual[index] ?? 0;
    const b = minimum[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}
