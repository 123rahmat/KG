/**
 * Fleet-level project control plane.
 *
 * This layer schedules many software projects above the existing Run/Task and
 * workspace authorities. It does not create a second execution engine.
 */
import crypto from 'node:crypto';
import { runDbScope, transaction } from './db.js';

const text = value => String(value ?? '').trim();
const list = value => Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))] : [];
const clamp = (value, min, max, fallback = min) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

export const FLEET_PROJECT_STATES = Object.freeze(['active', 'paused', 'archived']);

export class FleetValidationError extends Error {
  constructor(message) { super(message); this.name = 'FleetValidationError'; this.code = 'fleet-validation'; }
}
export const FLEET_LIMITS = Object.freeze({
  maxProjectConcurrency: 8,
  maxDispatchBatch: 32,
  maxTags: 24,
  maxDependencies: 32,
  maxPriority: 1000
});

export function normalizeProjectSpec(input = {}) {
  const value = input && typeof input === 'object' ? input : {};
  const name = text(value.name).slice(0, 180);
  if (!name) throw new FleetValidationError('Project name is required');
  return {
    name,
    state: FLEET_PROJECT_STATES.includes(text(value.state)) ? text(value.state) : 'active',
    priority: Math.round(clamp(value.priority, 0, FLEET_LIMITS.maxPriority, 0)),
    maxConcurrency: Math.round(clamp(value.maxConcurrency, 1, FLEET_LIMITS.maxProjectConcurrency, 1)),
    sourceId: text(value.sourceId) || null,
    currentRevision: text(value.currentRevision) || null,
    budgetTokens: value.budgetTokens == null ? null : Math.max(0, Number(value.budgetTokens) || 0),
    budgetComputeMs: value.budgetComputeMs == null ? null : Math.max(0, Number(value.budgetComputeMs) || 0),
    tags: list(value.tags).map(tag => tag.slice(0, 48)).slice(0, FLEET_LIMITS.maxTags),
    policy: value.policy && typeof value.policy === 'object' ? value.policy : {}
  };
}

export function projectDispatchScore(project, { nowMs = Date.now() } = {}) {
  const p = project ?? {};
  if (text(p.state) !== 'active') return Number.NEGATIVE_INFINITY;
  const running = Math.max(0, Number(p.inFlight ?? p.in_flight) || 0);
  const maxConcurrency = Math.max(1, Number(p.maxConcurrency ?? p.max_concurrency) || 1);
  if (running >= maxConcurrency) return Number.NEGATIVE_INFINITY;
  const priority = clamp(p.priority, 0, FLEET_LIMITS.maxPriority, 0);
  const last = Date.parse(p.lastDispatchAt ?? p.last_dispatch_at ?? p.createdAt ?? '') || nowMs;
  const ageMinutes = Math.max(0, (nowMs - last) / 60000);
  const failures = Math.max(0, Number(p.consecutiveFailures ?? p.consecutive_failures) || 0);
  const health = clamp(p.healthScore ?? p.health?.score ?? 1, 0, 1, 1);
  return priority * 10 + Math.min(120, ageMinutes) * 0.75 + health * 20
    - Math.min(80, failures * failures * 4);
}

export function selectFleetProjects(projects = [], {
  maxProjects = FLEET_LIMITS.maxDispatchBatch, nowMs = Date.now()
} = {}) {
  return (Array.isArray(projects) ? projects : [])
    .map(project => ({ project, score: projectDispatchScore(project, { nowMs }) }))
    .filter(item => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score || text(a.project.id).localeCompare(text(b.project.id)))
    .slice(0, Math.max(1, Math.min(FLEET_LIMITS.maxDispatchBatch, Math.floor(Number(maxProjects) || 1))))
    .map(item => item.project);
}

export function adaptFleetCapacity({
  current = 2, min = 1, max = 16, queueDepth = 0, errorRate = 0,
  dbWaiting = 0, remainingBudgetRatio = 1, averageLatencyMs = 0, usefulParallelism = 0
} = {}) {
  const cur = Math.max(min, Math.min(max, Math.floor(Number(current) || 1)));
  const errors = clamp(errorRate, 0, 1, 0);
  const budget = clamp(remainingBudgetRatio, 0, 1, 1);
  const waiting = Math.max(0, Number(dbWaiting) || 0);
  const latency = Math.max(0, Number(averageLatencyMs) || 0);
  const depth = Math.max(0, Number(queueDepth) || 0);
  const opportunity = clamp(usefulParallelism, 0, 1, 0);
  let next = cur;
  if (errors >= 0.2 || waiting >= 3 || latency >= 10000 || budget < 0.2) next -= 1;
  else if (depth >= cur * 2 && opportunity >= 0.5 && errors < 0.05 && waiting === 0 && budget >= 0.5 && latency > 0 && latency < 3000) next += 1;
  next = Math.max(min, Math.min(max, next));
  return {
    current: cur, next, queueDepth: depth, errorRate: Number(errors.toFixed(3)),
    dbWaiting: waiting, remainingBudgetRatio: Number(budget.toFixed(3)),
    averageLatencyMs: Math.round(latency),
    reason: next < cur ? 'reduce-fleet-capacity-under-pressure'
      : next > cur ? 'increase-fleet-capacity-when-healthy-and-useful' : 'hold-fleet-capacity'
  };
}

export function fleetPartition(projectId, partitions = 1) {
  const count = Math.max(1, Math.floor(Number(partitions) || 1));
  const digest = crypto.createHash('sha256').update(text(projectId), 'utf8').digest();
  return digest.readUInt32BE(0) % count;
}

function presentProject(row) {
  if (!row) return null;
  return {
    id: row.id, workspaceId: row.workspace_id, principalId: row.principal_id, name: row.name,
    state: row.state, priority: row.priority, maxConcurrency: row.max_concurrency,
    sourceId: row.source_id ?? null, currentRevision: row.current_revision ?? null,
    budgetTokens: row.budget_tokens == null ? null : Number(row.budget_tokens),
    budgetComputeMs: row.budget_compute_ms == null ? null : Number(row.budget_compute_ms),
    inFlight: Number(row.in_flight ?? 0), queued: Number(row.queued ?? 0) > 0,
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    successCount: Number(row.success_count ?? 0), failureCount: Number(row.failure_count ?? 0),
    health: row.health ?? { score: 1 }, tags: Array.isArray(row.tags) ? row.tags : [],
    policy: row.policy ?? {}, nextDispatchAt: row.next_dispatch_at ?? null,
    lastDispatchAt: row.last_dispatch_at ?? null, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

export class FleetStore {
  constructor(pool) { this.pool = pool; }

  async create(scope, spec) {
    const normalized = normalizeProjectSpec(spec);
    const id = crypto.randomUUID();
    const sql = [
      'INSERT INTO fleet_projects',
      '(id,workspace_id,principal_id,name,state,priority,max_concurrency,source_id,current_revision,budget_tokens,budget_compute_ms,tags,policy)',
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb) RETURNING *'
    ].join(' ');
    const { rows: [row] } = await this.pool.query(sql, [
      id, scope.workspaceId, scope.principalId, normalized.name, normalized.state, normalized.priority,
      normalized.maxConcurrency, normalized.sourceId, normalized.currentRevision,
      normalized.budgetTokens, normalized.budgetComputeMs, JSON.stringify(normalized.tags), JSON.stringify(normalized.policy)
    ]);
    return presentProject(row);
  }

  async summary(scope) {
    const { rows: [row] = [] } = await this.pool.query("SELECT count(*)::bigint projects,count(*) FILTER (WHERE state='active')::bigint active_projects,(SELECT count(*)::bigint FROM fleet_dispatches WHERE workspace_id=$1 AND state='queued') queued_dispatches,(SELECT count(*)::bigint FROM fleet_dispatches WHERE workspace_id=$1 AND state='running') running_dispatches,count(*) FILTER (WHERE COALESCE((health->>'score')::double precision,1)<0.5)::bigint unhealthy_projects FROM fleet_projects WHERE workspace_id=$1", [scope.workspaceId]);
    return { projects:Number(row.projects||0), activeProjects:Number(row.active_projects||0), queuedDispatches:Number(row.queued_dispatches||0), runningDispatches:Number(row.running_dispatches||0), unhealthyProjects:Number(row.unhealthy_projects||0) };
  }

  async list(scope, { state = '', limit = 100, offset = 0 } = {}) {
    const states = FLEET_PROJECT_STATES.includes(text(state)) ? [text(state)] : FLEET_PROJECT_STATES;
    const sql = [
      'SELECT p.*, COALESCE(q.queued_count,0) queued, COALESCE(r.running_count,0) in_flight',
      'FROM fleet_projects p',
      "LEFT JOIN (SELECT project_id,count(*) queued_count FROM fleet_dispatches WHERE workspace_id=$1 AND state='queued' GROUP BY project_id) q ON q.project_id=p.id",
      "LEFT JOIN (SELECT project_id,count(*) running_count FROM fleet_dispatches WHERE workspace_id=$1 AND state='running' GROUP BY project_id) r ON r.project_id=p.id",
      'WHERE p.workspace_id=$1 AND p.state=ANY($2::text[])',
      'ORDER BY p.priority DESC,p.updated_at DESC,p.id LIMIT $3 OFFSET $4'
    ].join(' ');
    const { rows } = await this.pool.query(sql, [
      scope.workspaceId, states, Math.max(1, Math.min(500, Number(limit) || 100)), Math.max(0, Number(offset) || 0)
    ]);
    return rows.map(presentProject);
  }

  async get(scope, id) {
    const { rows: [row] } = await this.pool.query(
      'SELECT * FROM fleet_projects WHERE id=$1 AND workspace_id=$2', [text(id), scope.workspaceId]
    );
    return presentProject(row);
  }

  async update(scope, id, patch) {
    const current = await this.get(scope, id);
    if (!current) return null;
    const n = normalizeProjectSpec({ ...current, ...(patch || {}) });
    const sql = [
      'UPDATE fleet_projects SET name=$3,state=$4,priority=$5,max_concurrency=$6,source_id=$7,current_revision=$8,',
      'budget_tokens=$9,budget_compute_ms=$10,tags=$11::jsonb,policy=$12::jsonb,updated_at=now()',
      'WHERE id=$1 AND workspace_id=$2 RETURNING *'
    ].join(' ');
    const { rows: [row] } = await this.pool.query(sql, [
      id, scope.workspaceId, n.name, n.state, n.priority, n.maxConcurrency, n.sourceId,
      n.currentRevision, n.budgetTokens, n.budgetComputeMs, JSON.stringify(n.tags), JSON.stringify(n.policy)
    ]);
    return presentProject(row);
  }

  async dependencies(scope, id) {
    const { rows } = await this.pool.query(
      'SELECT d.depends_on_project_id id,p.name,p.state FROM fleet_project_dependencies d JOIN fleet_projects p ON p.id=d.depends_on_project_id WHERE d.project_id=$1 AND d.workspace_id=$2 ORDER BY p.priority DESC,p.id',
      [text(id), scope.workspaceId]
    );
    return rows.map(row => ({ id: row.id, name: row.name, state: row.state }));
  }

  async addDependency(scope, id, dependsOnId) {
    const left = text(id); const right = text(dependsOnId);
    if (!left || !right || left === right) throw new FleetValidationError('A project cannot depend on itself');
    const cycleSql = [
      'WITH RECURSIVE reaches(id) AS (',
      'SELECT depends_on_project_id FROM fleet_project_dependencies WHERE project_id=$1 AND workspace_id=$3',
      'UNION',
      'SELECT d.depends_on_project_id FROM fleet_project_dependencies d JOIN reaches r ON r.id=d.project_id WHERE d.workspace_id=$3)',
      'SELECT 1 FROM reaches WHERE id=$2 LIMIT 1'
    ].join(' ');
    const { rows: cycle } = await this.pool.query(cycleSql, [left, right, scope.workspaceId]);
    if (cycle.length) throw new FleetValidationError('Adding this dependency would create a project cycle');
    const { rows: count } = await this.pool.query(
      'SELECT count(*)::int count FROM fleet_project_dependencies WHERE project_id=$1 AND workspace_id=$2',
      [left, scope.workspaceId]
    );
    if (Number(count[0]?.count || 0) >= FLEET_LIMITS.maxDependencies) throw new FleetValidationError('Project dependency limit reached');
    await this.pool.query(
      'INSERT INTO fleet_project_dependencies(workspace_id,project_id,depends_on_project_id) SELECT $3,$1,$2 WHERE EXISTS (SELECT 1 FROM fleet_projects WHERE id=$1 AND workspace_id=$3) AND EXISTS (SELECT 1 FROM fleet_projects WHERE id=$2 AND workspace_id=$3) ON CONFLICT DO NOTHING',
      [left, right, scope.workspaceId]
    );
    return this.dependencies(scope, left);
  }

  async enqueue(scope, projectId, { runId, taskId, request = {}, maxAttempts = 3 } = {}) {
    const project = await this.get(scope, projectId);
    if (!project) throw new FleetValidationError('Fleet project not found');
    if (project.state !== 'active') throw new FleetValidationError('Project is not active');
    const run = text(runId);
    const task = text(taskId);
    if (!run || !task) throw new FleetValidationError('Fleet dispatch requires runId and taskId');
    const { rows: [target] = [] } = await this.pool.query(
      `SELECT t.id, t.status, r.state
         FROM runs r
         JOIN run_tasks t ON t.run_id = r.id
        WHERE r.id = $1 AND r.workspace_id = $2 AND t.id = $3
          AND (r.visibility = 'workspace' OR r.principal_id = $4)
        LIMIT 1`,
      [run, scope.workspaceId, task, scope.principalId]
    );
    if (!target) throw new FleetValidationError('Fleet dispatch references an inaccessible run or task');
    if (target.status !== 'pending') throw new FleetValidationError('Fleet dispatch target task is no longer pending');
    if (['complete','failed','blocked','exhausted'].includes(text(target.state))) {
      throw new FleetValidationError('Fleet dispatch target run is already terminal');
    }
    const { rows: [row] } = await this.pool.query(
      "INSERT INTO fleet_dispatches(id,workspace_id,principal_id,project_id,state,payload,max_attempts,available_at) VALUES($1,$2,$3,$4,'queued',$5::jsonb,$6,now()) RETURNING *",
      [crypto.randomUUID(), scope.workspaceId, scope.principalId, projectId,
        JSON.stringify({ runId: run, taskId: task, request: request && typeof request === 'object' ? request : {} }),
        Math.max(1, Math.min(8, Number(maxAttempts) || 3))]
    );
    return { id: row.id, projectId: row.project_id, state: row.state, attempts: row.attempts, availableAt: row.available_at, createdAt: row.created_at };
  }
  async reapExpired({ workspaceId = '', limit = 100 } = {}) {
    return transaction(this.pool, async client => {
      const params = [];
      const conditions = ["state='running'", "lease_until IS NOT NULL", "lease_until < now()", "attempts >= max_attempts"];
      if (workspaceId) {
        params.push(workspaceId);
        conditions.push('workspace_id=
    limit = 8, workerId = 'worker', leaseMs = 300000, partition = null, partitions = 1, workspaceId = ''
  } = {}) {
    const safeLimit = Math.max(1, Math.min(FLEET_LIMITS.maxDispatchBatch, Number(limit) || 8));
    const safeLease = Math.max(10000, Math.min(900000, Number(leaseMs) || 300000));
    const count = Math.max(1, Number(partitions) || 1);
    const shard = partition == null ? null : Math.max(0, Math.min(count - 1, Number(partition) || 0));
    return transaction(this.pool, async client => {
      const params = [];
      const conditions = [
"((d.state='queued' AND d.available_at<=now() AND d.attempts<d.max_attempts) OR (d.state='running' AND d.lease_until<now()))",
        'd.attempts<d.max_attempts',
        "p.state='active'",
        "(p.next_dispatch_at IS NULL OR p.next_dispatch_at<=now())",
        '(p.budget_tokens IS NULL OR p.budget_tokens>0)',
        '(p.budget_compute_ms IS NULL OR p.budget_compute_ms>0)',
        "p.max_concurrency>(SELECT count(*) FROM fleet_dispatches r WHERE r.project_id=d.project_id AND r.state='running')",
        "NOT EXISTS (SELECT 1 FROM fleet_project_dependencies dep WHERE dep.project_id=d.project_id AND NOT EXISTS (SELECT 1 FROM fleet_dispatches latest WHERE latest.project_id=dep.depends_on_project_id AND latest.id=(SELECT l2.id FROM fleet_dispatches l2 WHERE l2.project_id=dep.depends_on_project_id ORDER BY l2.updated_at DESC,l2.id DESC LIMIT 1) AND latest.state='succeeded'))"
      ];
      if (workspaceId) { params.push(workspaceId); conditions.unshift('d.workspace_id=$' + params.length); }
      if (shard != null) {
        params.push(count);
        const countParam = params.length;
        params.push(shard);
        const shardParam = params.length;
        conditions.push('mod(abs(hashtext(d.project_id)),$' + countParam + '::int)=$' + shardParam);
      }
      const limitParam = params.length + 1; params.push(safeLimit);
      const sql = [
        'WITH candidates AS (SELECT d.id FROM fleet_dispatches d JOIN fleet_projects p ON p.id=d.project_id',
        'WHERE ' + conditions.join(' AND '),
        'ORDER BY (p.priority*10 + LEAST(120,EXTRACT(EPOCH FROM (now()-COALESCE(p.last_dispatch_at,p.created_at)))/60)*0.75 + COALESCE((p.health->>\'score\')::double precision,1)*20 - LEAST(80,p.consecutive_failures*p.consecutive_failures*4)) DESC,d.created_at ASC,d.id ASC',
        'FOR UPDATE OF d SKIP LOCKED LIMIT $' + limitParam + ')',
        "UPDATE fleet_dispatches d SET state='running',attempts=d.attempts+1,lease_until=now()+(" + (limitParam + 1) + "::bigint*interval '1 millisecond'),worker_id=$" + (limitParam + 2) + ",started_at=COALESCE(d.started_at,now()),updated_at=now() FROM candidates c WHERE d.id=c.id RETURNING d.*"
      ].join(' ');
      params.push(safeLease, text(workerId) || 'worker');
      const { rows } = await client.query(sql, params);
      if (!rows.length) return [];
      return rows.map(row => ({
        id: row.id, projectId: row.project_id, workspaceId: row.workspace_id,
        principalId: row.principal_id, state: row.state, attempts: row.attempts,
        maxAttempts: row.max_attempts, payload: row.payload ?? {}, leaseUntil: row.lease_until
      }));
    });
  }

  async renewLease(scope, dispatchId, { workerId, attempts, leaseMs = 300000 } = {}) {
    const safeLease = Math.max(10000, Math.min(900000, Number(leaseMs) || 300000));
    const { rows: [row] = [] } = await this.pool.query("UPDATE fleet_dispatches SET lease_until=now()+($3::bigint * interval '1 millisecond'),updated_at=now() WHERE id=$1 AND workspace_id=$2 AND state='running' AND worker_id=$4 AND attempts=$5 AND lease_until>now() RETURNING id,lease_until",
      [text(dispatchId), scope.workspaceId, safeLease, text(workerId), Number(attempts) || 0]
    );
    return row ? { id: row.id, leaseUntil: row.lease_until } : null;
  }

  async release(scope, dispatchId, { workerId, attempts, delayMs = 5000, error = null } = {}) {
    const delay = Math.max(1000, Math.min(300000, Number(delayMs) || 5000));
    const { rows: [row] = [] } = await this.pool.query("UPDATE fleet_dispatches SET state='queued',lease_until=NULL,worker_id=NULL,available_at=now()+($3::bigint * interval '1 millisecond'),error=$6,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND state='running' AND worker_id=$4 AND attempts=$5 RETURNING id,state,available_at",
      [text(dispatchId), scope.workspaceId, delay, text(workerId), Number(attempts) || 0, error ? text(error).slice(0,1000) : null]
    );
    return row ? { id: row.id, state: row.state, availableAt: row.available_at } : null;
  }
  async finish(scope, dispatchId, {
    state = 'succeeded', healthOutcome = null, workerId = null, attempts = null,
    costTokens = 0, costComputeMs = 0, error = null, metadata = {}
  } = {}) {
    if (!['succeeded','failed','cancelled'].includes(text(state))) throw new FleetValidationError('Invalid terminal dispatch state');
    return transaction(this.pool, async client => {
      const fenceParams = [text(dispatchId), scope.workspaceId];
      const fence = ['id=$1', 'workspace_id=$2', "state='running'"];
      if (text(workerId)) { fenceParams.push(text(workerId)); fence.push('worker_id=
      if (!dispatch) return null;
      const { rows: [project] = [] } = await client.query(
        'SELECT * FROM fleet_projects WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [dispatch.project_id, scope.workspaceId]
      );
      if (!project) return null;
      const outcome = text(healthOutcome) || state;
      const succeeded = outcome === 'succeeded';
      const failed = outcome === 'failed';
      const oldScore = Number(project.health?.score ?? 1);
      const score = succeeded ? oldScore * 0.9 + 0.1 : failed ? oldScore * 0.8 : oldScore;
      const failures = failed ? Number(project.consecutive_failures || 0) + 1 : succeeded ? 0 : Number(project.consecutive_failures || 0);
      const tokenSpent = Math.max(0, Number(costTokens) || 0);
      const computeSpent = Math.max(0, Number(costComputeMs) || 0);
      await client.query(
        "UPDATE fleet_dispatches SET state=$2,lease_until=NULL,worker_id=NULL,finished_at=now(),updated_at=now(),cost_tokens=$3,cost_compute_ms=$4,error=$5,metadata=$6::jsonb WHERE id=$1 AND state='running'",
        [dispatch.id, state, tokenSpent, computeSpent, error ? text(error).slice(0,1000) : null, JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {})]
      );
      await client.query(
        "UPDATE fleet_projects SET in_flight=(SELECT count(*) FROM fleet_dispatches d WHERE d.project_id=$1 AND d.state='running'),consecutive_failures=$2,success_count=success_count+$3,failure_count=failure_count+$4,health=$5::jsonb,last_dispatch_at=now(),next_dispatch_at=CASE WHEN $4>0 AND $2>=2 THEN now()+interval '5 minutes' ELSE next_dispatch_at END,budget_tokens=CASE WHEN budget_tokens IS NULL THEN NULL ELSE GREATEST(0,budget_tokens-$6) END,budget_compute_ms=CASE WHEN budget_compute_ms IS NULL THEN NULL ELSE GREATEST(0,budget_compute_ms-$7) END,updated_at=now() WHERE id=$1 AND workspace_id=$8",
        [dispatch.project_id, failures, succeeded ? 1 : 0, failed ? 1 : 0,
          JSON.stringify({ score: Number(score.toFixed(4)), lastOutcome: succeeded ? 'succeeded' : failed ? 'failed' : state }),
          tokenSpent, computeSpent, scope.workspaceId]
      );
      return { id: dispatch.id, state, projectId: dispatch.project_id };
    });
  }
}

export function fleetStatus(projects = [], { capacity = 1, workerCount = 1 } = {}) {
  const items = Array.isArray(projects) ? projects : [];
  return {
    projects: items.length,
    activeProjects: items.filter(item => item.state === 'active').length,
    queuedDispatches: items.reduce((n, item) => n + Number(item.queued || 0), 0),
    runningDispatches: items.reduce((n, item) => n + Number(item.inFlight || 0), 0),
    unhealthyProjects: items.filter(item => Number(item.health?.score ?? 1) < 0.5).length,
    capacity: Math.max(1, Number(capacity) || 1),
    workers: Math.max(1, Number(workerCount) || 1)
  };
}

export function createFleetWorker({
  fleet, identity, runs, executeNext, logger, metrics,
  pollMs = 1000, batchSize = 8, maxConcurrency = 4, workerId = 'fleet-' + process.pid,
  partition = null, partitions = 1
} = {}) {
  let timer = null; let active = null; let stopping = false;

  async function process(dispatch) {
    const startedAt = Date.now();
    const scope = { principalId: dispatch.principalId, workspaceId: dispatch.workspaceId };
    return runDbScope({ ...scope, organizationId: '', jurisdiction: '', role: 'job-worker' }, async () => {
      try {
        let access;
        try {
          access = await identity.requireAccess({ id: dispatch.principalId }, dispatch.workspaceId, 'editor');
        } catch {
          await fleet.finish(scope, dispatch.id, { state: 'failed', error: 'Fleet dispatch access was revoked' });
          return false;
        }
        access.principalId = dispatch.principalId;
        const payload = dispatch.payload ?? {};
        const run = await runs.get(access, payload.runId);
        const task = run?.tasks.find(item => item.id === payload.taskId);
        if (!run || !task) {
          await fleet.finish(scope, dispatch.id, { state: 'failed', error: 'Fleet dispatch references a missing run or task' });
          return false;
        }
        if (task.status === 'complete') {
          await fleet.finish(scope, dispatch.id, { state: 'succeeded', metadata: { code: 'completed-earlier' } });
          return true;
        }
        const reply = await executeNext({
          scope: access, principal: { id: dispatch.principalId }, runId: payload.runId,
          body: payload.request ?? {}, requestId: null, expectedTaskId: payload.taskId
        });
        await fleet.finish(scope, dispatch.id, {
          state: reply.status < 400 ? 'succeeded' : 'failed',
          error: reply.status < 400 ? null : text(reply.body?.error),
          costComputeMs: Date.now() - startedAt,
          metadata: { status: reply.status }
        });
        return reply.status < 400;
      } catch (error) {
        await fleet.finish(scope, dispatch.id, {
          state: 'failed', error: text(error?.message) || 'Fleet execution failed',
          costComputeMs: Date.now() - startedAt
        }).catch(() => {});
        logger?.error('fleet dispatch failed', { error, dispatchId: dispatch.id });
        metrics?.increment('fleet_dispatch_execution_errors_total');
        return false;
      }
    });
  }

  async function runOnce() {
    if (stopping) return 0;
    const batch = await fleet.acquireBatch({
      limit: batchSize, workerId, partition, partitions
    });
    if (!batch.length) return 0;
    const ceiling = Math.max(1, Math.min(16, Number(maxConcurrency) || 1));
    const adaptive = adaptFleetCapacity({
      current: runOnce.currentWidth || ceiling,
      max: ceiling,
      queueDepth: batch.length,
      usefulParallelism: batch.length > 1 ? 1 : 0,
      remainingBudgetRatio: 1
    });
    const width = adaptive.next;
    runOnce.currentWidth = width;
    let processed = 0;
    for (let i = 0; i < batch.length; i += width) {
      await Promise.all(batch.slice(i, i + width).map(process));
      processed += Math.min(width, batch.length - i);
    }
    metrics?.increment('fleet_dispatches_total', { action: 'processed' });
    return processed;
  }

  runOnce.currentWidth = Math.max(1, Math.min(16, Number(maxConcurrency) || 1));

  const tick = async () => {
    if (active || stopping) return;
    active = runOnce().catch(error => logger?.error('fleet worker cycle failed', { error })).finally(() => { active = null; });
  };

  return {
    runOnce,
    start() {
      stopping = false;
      if (!timer) { timer = setInterval(tick, pollMs); timer.unref?.(); }
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      await active;
    }
  };
}
 + params.length);
      }
      const limitParam = params.length + 1;
      params.push(Math.max(1, Math.min(500, Number(limit) || 100)));
      const sql = [
        'WITH expired AS (SELECT id,project_id FROM fleet_dispatches WHERE',
        conditions.join(' AND '),
        'ORDER BY lease_until ASC,id ASC FOR UPDATE SKIP LOCKED LIMIT 
    limit = 8, workerId = 'worker', leaseMs = 300000, partition = null, partitions = 1, workspaceId = ''
  } = {}) {
    const safeLimit = Math.max(1, Math.min(FLEET_LIMITS.maxDispatchBatch, Number(limit) || 8));
    const safeLease = Math.max(10000, Math.min(900000, Number(leaseMs) || 300000));
    const count = Math.max(1, Number(partitions) || 1);
    const shard = partition == null ? null : Math.max(0, Math.min(count - 1, Number(partition) || 0));
    return transaction(this.pool, async client => {
      const params = [];
      const conditions = [
"((d.state='queued' AND d.available_at<=now() AND d.attempts<d.max_attempts) OR (d.state='running' AND d.lease_until<now()))",
        'd.attempts<d.max_attempts',
        "p.state='active'",
        "(p.next_dispatch_at IS NULL OR p.next_dispatch_at<=now())",
        '(p.budget_tokens IS NULL OR p.budget_tokens>0)',
        '(p.budget_compute_ms IS NULL OR p.budget_compute_ms>0)',
        "p.max_concurrency>(SELECT count(*) FROM fleet_dispatches r WHERE r.project_id=d.project_id AND r.state='running')",
        "NOT EXISTS (SELECT 1 FROM fleet_project_dependencies dep WHERE dep.project_id=d.project_id AND NOT EXISTS (SELECT 1 FROM fleet_dispatches latest WHERE latest.project_id=dep.depends_on_project_id AND latest.id=(SELECT l2.id FROM fleet_dispatches l2 WHERE l2.project_id=dep.depends_on_project_id ORDER BY l2.updated_at DESC,l2.id DESC LIMIT 1) AND latest.state='succeeded'))"
      ];
      if (workspaceId) { params.push(workspaceId); conditions.unshift('d.workspace_id=$' + params.length); }
      if (shard != null) {
        params.push(count);
        const countParam = params.length;
        params.push(shard);
        const shardParam = params.length;
        conditions.push('mod(abs(hashtext(d.project_id)),$' + countParam + '::int)=$' + shardParam);
      }
      const limitParam = params.length + 1; params.push(safeLimit);
      const sql = [
        'WITH candidates AS (SELECT d.id FROM fleet_dispatches d JOIN fleet_projects p ON p.id=d.project_id',
        'WHERE ' + conditions.join(' AND '),
        'ORDER BY (p.priority*10 + LEAST(120,EXTRACT(EPOCH FROM (now()-COALESCE(p.last_dispatch_at,p.created_at)))/60)*0.75 + COALESCE((p.health->>\'score\')::double precision,1)*20 - LEAST(80,p.consecutive_failures*p.consecutive_failures*4)) DESC,d.created_at ASC,d.id ASC',
        'FOR UPDATE OF d SKIP LOCKED LIMIT $' + limitParam + ')',
        "UPDATE fleet_dispatches d SET state='running',attempts=d.attempts+1,lease_until=now()+(" + (limitParam + 1) + "::bigint*interval '1 millisecond'),worker_id=$" + (limitParam + 2) + ",started_at=COALESCE(d.started_at,now()),updated_at=now() FROM candidates c WHERE d.id=c.id RETURNING d.*"
      ].join(' ');
      params.push(safeLease, text(workerId) || 'worker');
      const { rows } = await client.query(sql, params);
      if (!rows.length) return [];
      return rows.map(row => ({
        id: row.id, projectId: row.project_id, workspaceId: row.workspace_id,
        principalId: row.principal_id, state: row.state, attempts: row.attempts,
        maxAttempts: row.max_attempts, payload: row.payload ?? {}, leaseUntil: row.lease_until
      }));
    });
  }

  async finish(scope, dispatchId, {
    state = 'succeeded', costTokens = 0, costComputeMs = 0, error = null, metadata = {}
  } = {}) {
    if (!['succeeded','failed','cancelled'].includes(text(state))) throw new FleetValidationError('Invalid terminal dispatch state');
    return transaction(this.pool, async client => {
      const { rows: [dispatch] = [] } = await client.query(
        'SELECT * FROM fleet_dispatches WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [text(dispatchId), scope.workspaceId]
      );
      if (!dispatch) return null;
      const { rows: [project] = [] } = await client.query(
        'SELECT * FROM fleet_projects WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [dispatch.project_id, scope.workspaceId]
      );
      if (!project) return null;
      const succeeded = state === 'succeeded';
      const failed = state === 'failed';
      const oldScore = Number(project.health?.score ?? 1);
      const score = succeeded ? oldScore * 0.9 + 0.1 : failed ? oldScore * 0.8 : oldScore;
      const failures = failed ? Number(project.consecutive_failures || 0) + 1 : succeeded ? 0 : Number(project.consecutive_failures || 0);
      const tokenSpent = Math.max(0, Number(costTokens) || 0);
      const computeSpent = Math.max(0, Number(costComputeMs) || 0);
      await client.query(
        "UPDATE fleet_dispatches SET state=$2,lease_until=NULL,finished_at=now(),updated_at=now(),cost_tokens=$3,cost_compute_ms=$4,error=$5,metadata=$6::jsonb WHERE id=$1 AND state='running'",
        [dispatch.id, state, tokenSpent, computeSpent, error ? text(error).slice(0,1000) : null, JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {})]
      );
      await client.query(
        "UPDATE fleet_projects SET in_flight=(SELECT count(*) FROM fleet_dispatches d WHERE d.project_id=$1 AND d.state='running'),consecutive_failures=$2,success_count=success_count+$3,failure_count=failure_count+$4,health=$5::jsonb,last_dispatch_at=now(),next_dispatch_at=CASE WHEN $4>0 AND $2>=2 THEN now()+interval '5 minutes' ELSE next_dispatch_at END,budget_tokens=CASE WHEN budget_tokens IS NULL THEN NULL ELSE GREATEST(0,budget_tokens-$6) END,budget_compute_ms=CASE WHEN budget_compute_ms IS NULL THEN NULL ELSE GREATEST(0,budget_compute_ms-$7) END,updated_at=now() WHERE id=$1 AND workspace_id=$8",
        [dispatch.project_id, failures, succeeded ? 1 : 0, failed ? 1 : 0,
          JSON.stringify({ score: Number(score.toFixed(4)), lastOutcome: succeeded ? 'succeeded' : failed ? 'failed' : state }),
          tokenSpent, computeSpent, scope.workspaceId]
      );
      return { id: dispatch.id, state, projectId: dispatch.project_id };
    });
  }
}

export function fleetStatus(projects = [], { capacity = 1, workerCount = 1 } = {}) {
  const items = Array.isArray(projects) ? projects : [];
  return {
    projects: items.length,
    activeProjects: items.filter(item => item.state === 'active').length,
    queuedDispatches: items.reduce((n, item) => n + Number(item.queued || 0), 0),
    runningDispatches: items.reduce((n, item) => n + Number(item.inFlight || 0), 0),
    unhealthyProjects: items.filter(item => Number(item.health?.score ?? 1) < 0.5).length,
    capacity: Math.max(1, Number(capacity) || 1),
    workers: Math.max(1, Number(workerCount) || 1)
  };
}

export function createFleetWorker({
  fleet, identity, runs, executeNext, logger, metrics,
  pollMs = 1000, batchSize = 8, maxConcurrency = 4, workerId = 'fleet-' + process.pid,
  partition = null, partitions = 1
} = {}) {
  let timer = null; let active = null; let stopping = false;

  async function process(dispatch) {
    const startedAt = Date.now();
    const scope = { principalId: dispatch.principalId, workspaceId: dispatch.workspaceId };
    return runDbScope({ ...scope, organizationId: '', jurisdiction: '', role: 'job-worker' }, async () => {
      try {
        let access;
        try {
          access = await identity.requireAccess({ id: dispatch.principalId }, dispatch.workspaceId, 'editor');
        } catch {
          await fleet.finish(scope, dispatch.id, { state: 'failed', error: 'Fleet dispatch access was revoked' });
          return false;
        }
        access.principalId = dispatch.principalId;
        const payload = dispatch.payload ?? {};
        const run = await runs.get(access, payload.runId);
        const task = run?.tasks.find(item => item.id === payload.taskId);
        if (!run || !task) {
          await fleet.finish(scope, dispatch.id, { state: 'failed', error: 'Fleet dispatch references a missing run or task' });
          return false;
        }
        if (task.status === 'complete') {
          await fleet.finish(scope, dispatch.id, { state: 'succeeded', metadata: { code: 'completed-earlier' } });
          return true;
        }
        const reply = await executeNext({
          scope: access, principal: { id: dispatch.principalId }, runId: payload.runId,
          body: payload.request ?? {}, requestId: null, expectedTaskId: payload.taskId
        });
        await fleet.finish(scope, dispatch.id, {
          state: reply.status < 400 ? 'succeeded' : 'failed',
          error: reply.status < 400 ? null : text(reply.body?.error),
          costComputeMs: Date.now() - startedAt,
          metadata: { status: reply.status }
        });
        return reply.status < 400;
      } catch (error) {
        await fleet.finish(scope, dispatch.id, {
          state: 'failed', error: text(error?.message) || 'Fleet execution failed',
          costComputeMs: Date.now() - startedAt
        }).catch(() => {});
        logger?.error('fleet dispatch failed', { error, dispatchId: dispatch.id });
        metrics?.increment('fleet_dispatch_execution_errors_total');
        return false;
      }
    });
  }

  async function runOnce() {
    if (stopping) return 0;
    const batch = await fleet.acquireBatch({
      limit: batchSize, workerId, partition, partitions
    });
    if (!batch.length) return 0;
    const ceiling = Math.max(1, Math.min(16, Number(maxConcurrency) || 1));
    const adaptive = adaptFleetCapacity({
      current: runOnce.currentWidth || ceiling,
      max: ceiling,
      queueDepth: batch.length,
      usefulParallelism: batch.length > 1 ? 1 : 0,
      remainingBudgetRatio: 1
    });
    const width = adaptive.next;
    runOnce.currentWidth = width;
    let processed = 0;
    for (let i = 0; i < batch.length; i += width) {
      await Promise.all(batch.slice(i, i + width).map(process));
      processed += Math.min(width, batch.length - i);
    }
    metrics?.increment('fleet_dispatches_total', { action: 'processed' });
    return processed;
  }

  runOnce.currentWidth = Math.max(1, Math.min(16, Number(maxConcurrency) || 1));

  const tick = async () => {
    if (active || stopping) return;
    active = runOnce().catch(error => logger?.error('fleet worker cycle failed', { error })).finally(() => { active = null; });
  };

  return {
    runOnce,
    start() {
      stopping = false;
      if (!timer) { timer = setInterval(tick, pollMs); timer.unref?.(); }
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      await active;
    }
  };
}
 + limitParam + ')',
        "UPDATE fleet_dispatches d SET state='failed',error='lease-expired-attempt-budget-exhausted',lease_until=NULL,worker_id=NULL,finished_at=now(),updated_at=now() FROM expired e WHERE d.id=e.id RETURNING d.project_id"
      ].join(' ');
      const { rows } = await client.query(sql, params);
      if (!rows.length) return 0;
      const ids = [...new Set(rows.map(row => row.project_id))];
      await client.query(
        "UPDATE fleet_projects p SET in_flight=(SELECT count(*) FROM fleet_dispatches d WHERE d.project_id=p.id AND d.state='running'),failure_count=failure_count+1,consecutive_failures=consecutive_failures+1,updated_at=now() WHERE p.id=ANY($1::text[])",
        [ids]
      );
      return rows.length;
    });
  }
  async acquireBatch({
    limit = 8, workerId = 'worker', leaseMs = 300000, partition = null, partitions = 1, workspaceId = ''
  } = {}) {
    const safeLimit = Math.max(1, Math.min(FLEET_LIMITS.maxDispatchBatch, Number(limit) || 8));
    const safeLease = Math.max(10000, Math.min(900000, Number(leaseMs) || 300000));
    const count = Math.max(1, Number(partitions) || 1);
    const shard = partition == null ? null : Math.max(0, Math.min(count - 1, Number(partition) || 0));
    return transaction(this.pool, async client => {
      const params = [];
      const conditions = [
"((d.state='queued' AND d.available_at<=now() AND d.attempts<d.max_attempts) OR (d.state='running' AND d.lease_until<now()))",
        'd.attempts<d.max_attempts',
        "p.state='active'",
        "(p.next_dispatch_at IS NULL OR p.next_dispatch_at<=now())",
        '(p.budget_tokens IS NULL OR p.budget_tokens>0)',
        '(p.budget_compute_ms IS NULL OR p.budget_compute_ms>0)',
        "p.max_concurrency>(SELECT count(*) FROM fleet_dispatches r WHERE r.project_id=d.project_id AND r.state='running')",
        "NOT EXISTS (SELECT 1 FROM fleet_project_dependencies dep WHERE dep.project_id=d.project_id AND NOT EXISTS (SELECT 1 FROM fleet_dispatches latest WHERE latest.project_id=dep.depends_on_project_id AND latest.id=(SELECT l2.id FROM fleet_dispatches l2 WHERE l2.project_id=dep.depends_on_project_id ORDER BY l2.updated_at DESC,l2.id DESC LIMIT 1) AND latest.state='succeeded'))"
      ];
      if (workspaceId) { params.push(workspaceId); conditions.unshift('d.workspace_id=$' + params.length); }
      if (shard != null) {
        params.push(count);
        const countParam = params.length;
        params.push(shard);
        const shardParam = params.length;
        conditions.push('mod(abs(hashtext(d.project_id)),$' + countParam + '::int)=$' + shardParam);
      }
      const limitParam = params.length + 1; params.push(safeLimit);
      const sql = [
        'WITH candidates AS (SELECT d.id FROM fleet_dispatches d JOIN fleet_projects p ON p.id=d.project_id',
        'WHERE ' + conditions.join(' AND '),
        'ORDER BY (p.priority*10 + LEAST(120,EXTRACT(EPOCH FROM (now()-COALESCE(p.last_dispatch_at,p.created_at)))/60)*0.75 + COALESCE((p.health->>\'score\')::double precision,1)*20 - LEAST(80,p.consecutive_failures*p.consecutive_failures*4)) DESC,d.created_at ASC,d.id ASC',
        'FOR UPDATE OF d SKIP LOCKED LIMIT $' + limitParam + ')',
        "UPDATE fleet_dispatches d SET state='running',attempts=d.attempts+1,lease_until=now()+(" + (limitParam + 1) + "::bigint*interval '1 millisecond'),worker_id=$" + (limitParam + 2) + ",started_at=COALESCE(d.started_at,now()),updated_at=now() FROM candidates c WHERE d.id=c.id RETURNING d.*"
      ].join(' ');
      params.push(safeLease, text(workerId) || 'worker');
      const { rows } = await client.query(sql, params);
      if (!rows.length) return [];
      return rows.map(row => ({
        id: row.id, projectId: row.project_id, workspaceId: row.workspace_id,
        principalId: row.principal_id, state: row.state, attempts: row.attempts,
        maxAttempts: row.max_attempts, payload: row.payload ?? {}, leaseUntil: row.lease_until
      }));
    });
  }

  async finish(scope, dispatchId, {
    state = 'succeeded', costTokens = 0, costComputeMs = 0, error = null, metadata = {}
  } = {}) {
    if (!['succeeded','failed','cancelled'].includes(text(state))) throw new FleetValidationError('Invalid terminal dispatch state');
    return transaction(this.pool, async client => {
      const { rows: [dispatch] = [] } = await client.query(
        'SELECT * FROM fleet_dispatches WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [text(dispatchId), scope.workspaceId]
      );
      if (!dispatch) return null;
      const { rows: [project] = [] } = await client.query(
        'SELECT * FROM fleet_projects WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [dispatch.project_id, scope.workspaceId]
      );
      if (!project) return null;
      const succeeded = state === 'succeeded';
      const failed = state === 'failed';
      const oldScore = Number(project.health?.score ?? 1);
      const score = succeeded ? oldScore * 0.9 + 0.1 : failed ? oldScore * 0.8 : oldScore;
      const failures = failed ? Number(project.consecutive_failures || 0) + 1 : succeeded ? 0 : Number(project.consecutive_failures || 0);
      const tokenSpent = Math.max(0, Number(costTokens) || 0);
      const computeSpent = Math.max(0, Number(costComputeMs) || 0);
      await client.query(
        "UPDATE fleet_dispatches SET state=$2,lease_until=NULL,finished_at=now(),updated_at=now(),cost_tokens=$3,cost_compute_ms=$4,error=$5,metadata=$6::jsonb WHERE id=$1 AND state='running'",
        [dispatch.id, state, tokenSpent, computeSpent, error ? text(error).slice(0,1000) : null, JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {})]
      );
      await client.query(
        "UPDATE fleet_projects SET in_flight=(SELECT count(*) FROM fleet_dispatches d WHERE d.project_id=$1 AND d.state='running'),consecutive_failures=$2,success_count=success_count+$3,failure_count=failure_count+$4,health=$5::jsonb,last_dispatch_at=now(),next_dispatch_at=CASE WHEN $4>0 AND $2>=2 THEN now()+interval '5 minutes' ELSE next_dispatch_at END,budget_tokens=CASE WHEN budget_tokens IS NULL THEN NULL ELSE GREATEST(0,budget_tokens-$6) END,budget_compute_ms=CASE WHEN budget_compute_ms IS NULL THEN NULL ELSE GREATEST(0,budget_compute_ms-$7) END,updated_at=now() WHERE id=$1 AND workspace_id=$8",
        [dispatch.project_id, failures, succeeded ? 1 : 0, failed ? 1 : 0,
          JSON.stringify({ score: Number(score.toFixed(4)), lastOutcome: succeeded ? 'succeeded' : failed ? 'failed' : state }),
          tokenSpent, computeSpent, scope.workspaceId]
      );
      return { id: dispatch.id, state, projectId: dispatch.project_id };
    });
  }
}

export function fleetStatus(projects = [], { capacity = 1, workerCount = 1 } = {}) {
  const items = Array.isArray(projects) ? projects : [];
  return {
    projects: items.length,
    activeProjects: items.filter(item => item.state === 'active').length,
    queuedDispatches: items.reduce((n, item) => n + Number(item.queued || 0), 0),
    runningDispatches: items.reduce((n, item) => n + Number(item.inFlight || 0), 0),
    unhealthyProjects: items.filter(item => Number(item.health?.score ?? 1) < 0.5).length,
    capacity: Math.max(1, Number(capacity) || 1),
    workers: Math.max(1, Number(workerCount) || 1)
  };
}

export function createFleetWorker({
  fleet, identity, runs, executeNext, logger, metrics,
  pollMs = 1000, batchSize = 8, maxConcurrency = 4, workerId = 'fleet-' + process.pid,
  partition = null, partitions = 1
} = {}) {
  let timer = null; let active = null; let stopping = false;

  async function process(dispatch) {
    const startedAt = Date.now();
    const scope = { principalId: dispatch.principalId, workspaceId: dispatch.workspaceId };
    return runDbScope({ ...scope, organizationId: '', jurisdiction: '', role: 'job-worker' }, async () => {
      try {
        let access;
        try {
          access = await identity.requireAccess({ id: dispatch.principalId }, dispatch.workspaceId, 'editor');
        } catch {
          await fleet.finish(scope, dispatch.id, { state: 'failed', error: 'Fleet dispatch access was revoked' });
          return false;
        }
        access.principalId = dispatch.principalId;
        const payload = dispatch.payload ?? {};
        const run = await runs.get(access, payload.runId);
        const task = run?.tasks.find(item => item.id === payload.taskId);
        if (!run || !task) {
          await fleet.finish(scope, dispatch.id, { state: 'failed', error: 'Fleet dispatch references a missing run or task' });
          return false;
        }
        if (task.status === 'complete') {
          await fleet.finish(scope, dispatch.id, { state: 'succeeded', metadata: { code: 'completed-earlier' } });
          return true;
        }
        const reply = await executeNext({
          scope: access, principal: { id: dispatch.principalId }, runId: payload.runId,
          body: payload.request ?? {}, requestId: null, expectedTaskId: payload.taskId
        });
        await fleet.finish(scope, dispatch.id, {
          state: reply.status < 400 ? 'succeeded' : 'failed',
          error: reply.status < 400 ? null : text(reply.body?.error),
          costComputeMs: Date.now() - startedAt,
          metadata: { status: reply.status }
        });
        return reply.status < 400;
      } catch (error) {
        await fleet.finish(scope, dispatch.id, {
          state: 'failed', error: text(error?.message) || 'Fleet execution failed',
          costComputeMs: Date.now() - startedAt
        }).catch(() => {});
        logger?.error('fleet dispatch failed', { error, dispatchId: dispatch.id });
        metrics?.increment('fleet_dispatch_execution_errors_total');
        return false;
      }
    });
  }

  async function runOnce() {
    if (stopping) return 0;
    const batch = await fleet.acquireBatch({
      limit: batchSize, workerId, partition, partitions
    });
    if (!batch.length) return 0;
    const ceiling = Math.max(1, Math.min(16, Number(maxConcurrency) || 1));
    const adaptive = adaptFleetCapacity({
      current: runOnce.currentWidth || ceiling,
      max: ceiling,
      queueDepth: batch.length,
      usefulParallelism: batch.length > 1 ? 1 : 0,
      remainingBudgetRatio: 1
    });
    const width = adaptive.next;
    runOnce.currentWidth = width;
    let processed = 0;
    for (let i = 0; i < batch.length; i += width) {
      await Promise.all(batch.slice(i, i + width).map(process));
      processed += Math.min(width, batch.length - i);
    }
    metrics?.increment('fleet_dispatches_total', { action: 'processed' });
    return processed;
  }

  runOnce.currentWidth = Math.max(1, Math.min(16, Number(maxConcurrency) || 1));

  const tick = async () => {
    if (active || stopping) return;
    active = runOnce().catch(error => logger?.error('fleet worker cycle failed', { error })).finally(() => { active = null; });
  };

  return {
    runOnce,
    start() {
      stopping = false;
      if (!timer) { timer = setInterval(tick, pollMs); timer.unref?.(); }
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      await active;
    }
  };
}
 + fenceParams.length); }
      if (attempts !== null && attempts !== undefined) { fenceParams.push(Number(attempts) || 0); fence.push('attempts=
      if (!dispatch) return null;
      const { rows: [project] = [] } = await client.query(
        'SELECT * FROM fleet_projects WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [dispatch.project_id, scope.workspaceId]
      );
      if (!project) return null;
      const succeeded = state === 'succeeded';
      const failed = state === 'failed';
      const oldScore = Number(project.health?.score ?? 1);
      const score = succeeded ? oldScore * 0.9 + 0.1 : failed ? oldScore * 0.8 : oldScore;
      const failures = failed ? Number(project.consecutive_failures || 0) + 1 : succeeded ? 0 : Number(project.consecutive_failures || 0);
      const tokenSpent = Math.max(0, Number(costTokens) || 0);
      const computeSpent = Math.max(0, Number(costComputeMs) || 0);
      await client.query(
        "UPDATE fleet_dispatches SET state=$2,lease_until=NULL,finished_at=now(),updated_at=now(),cost_tokens=$3,cost_compute_ms=$4,error=$5,metadata=$6::jsonb WHERE id=$1 AND state='running'",
        [dispatch.id, state, tokenSpent, computeSpent, error ? text(error).slice(0,1000) : null, JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {})]
      );
      await client.query(
        "UPDATE fleet_projects SET in_flight=(SELECT count(*) FROM fleet_dispatches d WHERE d.project_id=$1 AND d.state='running'),consecutive_failures=$2,success_count=success_count+$3,failure_count=failure_count+$4,health=$5::jsonb,last_dispatch_at=now(),next_dispatch_at=CASE WHEN $4>0 AND $2>=2 THEN now()+interval '5 minutes' ELSE next_dispatch_at END,budget_tokens=CASE WHEN budget_tokens IS NULL THEN NULL ELSE GREATEST(0,budget_tokens-$6) END,budget_compute_ms=CASE WHEN budget_compute_ms IS NULL THEN NULL ELSE GREATEST(0,budget_compute_ms-$7) END,updated_at=now() WHERE id=$1 AND workspace_id=$8",
        [dispatch.project_id, failures, succeeded ? 1 : 0, failed ? 1 : 0,
          JSON.stringify({ score: Number(score.toFixed(4)), lastOutcome: succeeded ? 'succeeded' : failed ? 'failed' : state }),
          tokenSpent, computeSpent, scope.workspaceId]
      );
      return { id: dispatch.id, state, projectId: dispatch.project_id };
    });
  }
}

export function fleetStatus(projects = [], { capacity = 1, workerCount = 1 } = {}) {
  const items = Array.isArray(projects) ? projects : [];
  return {
    projects: items.length,
    activeProjects: items.filter(item => item.state === 'active').length,
    queuedDispatches: items.reduce((n, item) => n + Number(item.queued || 0), 0),
    runningDispatches: items.reduce((n, item) => n + Number(item.inFlight || 0), 0),
    unhealthyProjects: items.filter(item => Number(item.health?.score ?? 1) < 0.5).length,
    capacity: Math.max(1, Number(capacity) || 1),
    workers: Math.max(1, Number(workerCount) || 1)
  };
}

export function createFleetWorker({
  fleet, identity, runs, executeNext, logger, metrics,
  pollMs = 1000, batchSize = 8, maxConcurrency = 4, workerId = 'fleet-' + process.pid,
  partition = null, partitions = 1
} = {}) {
  let timer = null; let active = null; let stopping = false;

  async function process(dispatch) {
    const startedAt = Date.now();
    const scope = { principalId: dispatch.principalId, workspaceId: dispatch.workspaceId };
    return runDbScope({ ...scope, organizationId: '', jurisdiction: '', role: 'job-worker' }, async () => {
      try {
        let access;
        try {
          access = await identity.requireAccess({ id: dispatch.principalId }, dispatch.workspaceId, 'editor');
        } catch {
          await fleet.finish(scope, dispatch.id, { state: 'failed', error: 'Fleet dispatch access was revoked' });
          return false;
        }
        access.principalId = dispatch.principalId;
        const payload = dispatch.payload ?? {};
        const run = await runs.get(access, payload.runId);
        const task = run?.tasks.find(item => item.id === payload.taskId);
        if (!run || !task) {
          await fleet.finish(scope, dispatch.id, { state: 'failed', error: 'Fleet dispatch references a missing run or task' });
          return false;
        }
        if (task.status === 'complete') {
          await fleet.finish(scope, dispatch.id, { state: 'succeeded', metadata: { code: 'completed-earlier' } });
          return true;
        }
        const reply = await executeNext({
          scope: access, principal: { id: dispatch.principalId }, runId: payload.runId,
          body: payload.request ?? {}, requestId: null, expectedTaskId: payload.taskId
        });
        await fleet.finish(scope, dispatch.id, {
          state: reply.status < 400 ? 'succeeded' : 'failed',
          error: reply.status < 400 ? null : text(reply.body?.error),
          costComputeMs: Date.now() - startedAt,
          metadata: { status: reply.status }
        });
        return reply.status < 400;
      } catch (error) {
        await fleet.finish(scope, dispatch.id, {
          state: 'failed', error: text(error?.message) || 'Fleet execution failed',
          costComputeMs: Date.now() - startedAt
        }).catch(() => {});
        logger?.error('fleet dispatch failed', { error, dispatchId: dispatch.id });
        metrics?.increment('fleet_dispatch_execution_errors_total');
        return false;
      }
    });
  }

  async function runOnce() {
    if (stopping) return 0;
    const batch = await fleet.acquireBatch({
      limit: batchSize, workerId, partition, partitions
    });
    if (!batch.length) return 0;
    const ceiling = Math.max(1, Math.min(16, Number(maxConcurrency) || 1));
    const adaptive = adaptFleetCapacity({
      current: runOnce.currentWidth || ceiling,
      max: ceiling,
      queueDepth: batch.length,
      usefulParallelism: batch.length > 1 ? 1 : 0,
      remainingBudgetRatio: 1
    });
    const width = adaptive.next;
    runOnce.currentWidth = width;
    let processed = 0;
    for (let i = 0; i < batch.length; i += width) {
      await Promise.all(batch.slice(i, i + width).map(process));
      processed += Math.min(width, batch.length - i);
    }
    metrics?.increment('fleet_dispatches_total', { action: 'processed' });
    return processed;
  }

  runOnce.currentWidth = Math.max(1, Math.min(16, Number(maxConcurrency) || 1));

  const tick = async () => {
    if (active || stopping) return;
    active = runOnce().catch(error => logger?.error('fleet worker cycle failed', { error })).finally(() => { active = null; });
  };

  return {
    runOnce,
    start() {
      stopping = false;
      if (!timer) { timer = setInterval(tick, pollMs); timer.unref?.(); }
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      await active;
    }
  };
}
 + params.length);
      }
      const limitParam = params.length + 1;
      params.push(Math.max(1, Math.min(500, Number(limit) || 100)));
      const sql = [
        'WITH expired AS (SELECT id,project_id FROM fleet_dispatches WHERE',
        conditions.join(' AND '),
        'ORDER BY lease_until ASC,id ASC FOR UPDATE SKIP LOCKED LIMIT 
    limit = 8, workerId = 'worker', leaseMs = 300000, partition = null, partitions = 1, workspaceId = ''
  } = {}) {
    const safeLimit = Math.max(1, Math.min(FLEET_LIMITS.maxDispatchBatch, Number(limit) || 8));
    const safeLease = Math.max(10000, Math.min(900000, Number(leaseMs) || 300000));
    const count = Math.max(1, Number(partitions) || 1);
    const shard = partition == null ? null : Math.max(0, Math.min(count - 1, Number(partition) || 0));
    return transaction(this.pool, async client => {
      const params = [];
      const conditions = [
"((d.state='queued' AND d.available_at<=now() AND d.attempts<d.max_attempts) OR (d.state='running' AND d.lease_until<now()))",
        'd.attempts<d.max_attempts',
        "p.state='active'",
        "(p.next_dispatch_at IS NULL OR p.next_dispatch_at<=now())",
        '(p.budget_tokens IS NULL OR p.budget_tokens>0)',
        '(p.budget_compute_ms IS NULL OR p.budget_compute_ms>0)',
        "p.max_concurrency>(SELECT count(*) FROM fleet_dispatches r WHERE r.project_id=d.project_id AND r.state='running')",
        "NOT EXISTS (SELECT 1 FROM fleet_project_dependencies dep WHERE dep.project_id=d.project_id AND NOT EXISTS (SELECT 1 FROM fleet_dispatches latest WHERE latest.project_id=dep.depends_on_project_id AND latest.id=(SELECT l2.id FROM fleet_dispatches l2 WHERE l2.project_id=dep.depends_on_project_id ORDER BY l2.updated_at DESC,l2.id DESC LIMIT 1) AND latest.state='succeeded'))"
      ];
      if (workspaceId) { params.push(workspaceId); conditions.unshift('d.workspace_id=$' + params.length); }
      if (shard != null) {
        params.push(count);
        const countParam = params.length;
        params.push(shard);
        const shardParam = params.length;
        conditions.push('mod(abs(hashtext(d.project_id)),$' + countParam + '::int)=$' + shardParam);
      }
      const limitParam = params.length + 1; params.push(safeLimit);
      const sql = [
        'WITH candidates AS (SELECT d.id FROM fleet_dispatches d JOIN fleet_projects p ON p.id=d.project_id',
        'WHERE ' + conditions.join(' AND '),
        'ORDER BY (p.priority*10 + LEAST(120,EXTRACT(EPOCH FROM (now()-COALESCE(p.last_dispatch_at,p.created_at)))/60)*0.75 + COALESCE((p.health->>\'score\')::double precision,1)*20 - LEAST(80,p.consecutive_failures*p.consecutive_failures*4)) DESC,d.created_at ASC,d.id ASC',
        'FOR UPDATE OF d SKIP LOCKED LIMIT $' + limitParam + ')',
        "UPDATE fleet_dispatches d SET state='running',attempts=d.attempts+1,lease_until=now()+(" + (limitParam + 1) + "::bigint*interval '1 millisecond'),worker_id=$" + (limitParam + 2) + ",started_at=COALESCE(d.started_at,now()),updated_at=now() FROM candidates c WHERE d.id=c.id RETURNING d.*"
      ].join(' ');
      params.push(safeLease, text(workerId) || 'worker');
      const { rows } = await client.query(sql, params);
      if (!rows.length) return [];
      return rows.map(row => ({
        id: row.id, projectId: row.project_id, workspaceId: row.workspace_id,
        principalId: row.principal_id, state: row.state, attempts: row.attempts,
        maxAttempts: row.max_attempts, payload: row.payload ?? {}, leaseUntil: row.lease_until
      }));
    });
  }

  async finish(scope, dispatchId, {
    state = 'succeeded', costTokens = 0, costComputeMs = 0, error = null, metadata = {}
  } = {}) {
    if (!['succeeded','failed','cancelled'].includes(text(state))) throw new FleetValidationError('Invalid terminal dispatch state');
    return transaction(this.pool, async client => {
      const { rows: [dispatch] = [] } = await client.query(
        'SELECT * FROM fleet_dispatches WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [text(dispatchId), scope.workspaceId]
      );
      if (!dispatch) return null;
      const { rows: [project] = [] } = await client.query(
        'SELECT * FROM fleet_projects WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [dispatch.project_id, scope.workspaceId]
      );
      if (!project) return null;
      const succeeded = state === 'succeeded';
      const failed = state === 'failed';
      const oldScore = Number(project.health?.score ?? 1);
      const score = succeeded ? oldScore * 0.9 + 0.1 : failed ? oldScore * 0.8 : oldScore;
      const failures = failed ? Number(project.consecutive_failures || 0) + 1 : succeeded ? 0 : Number(project.consecutive_failures || 0);
      const tokenSpent = Math.max(0, Number(costTokens) || 0);
      const computeSpent = Math.max(0, Number(costComputeMs) || 0);
      await client.query(
        "UPDATE fleet_dispatches SET state=$2,lease_until=NULL,finished_at=now(),updated_at=now(),cost_tokens=$3,cost_compute_ms=$4,error=$5,metadata=$6::jsonb WHERE id=$1 AND state='running'",
        [dispatch.id, state, tokenSpent, computeSpent, error ? text(error).slice(0,1000) : null, JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {})]
      );
      await client.query(
        "UPDATE fleet_projects SET in_flight=(SELECT count(*) FROM fleet_dispatches d WHERE d.project_id=$1 AND d.state='running'),consecutive_failures=$2,success_count=success_count+$3,failure_count=failure_count+$4,health=$5::jsonb,last_dispatch_at=now(),next_dispatch_at=CASE WHEN $4>0 AND $2>=2 THEN now()+interval '5 minutes' ELSE next_dispatch_at END,budget_tokens=CASE WHEN budget_tokens IS NULL THEN NULL ELSE GREATEST(0,budget_tokens-$6) END,budget_compute_ms=CASE WHEN budget_compute_ms IS NULL THEN NULL ELSE GREATEST(0,budget_compute_ms-$7) END,updated_at=now() WHERE id=$1 AND workspace_id=$8",
        [dispatch.project_id, failures, succeeded ? 1 : 0, failed ? 1 : 0,
          JSON.stringify({ score: Number(score.toFixed(4)), lastOutcome: succeeded ? 'succeeded' : failed ? 'failed' : state }),
          tokenSpent, computeSpent, scope.workspaceId]
      );
      return { id: dispatch.id, state, projectId: dispatch.project_id };
    });
  }
}

export function fleetStatus(projects = [], { capacity = 1, workerCount = 1 } = {}) {
  const items = Array.isArray(projects) ? projects : [];
  return {
    projects: items.length,
    activeProjects: items.filter(item => item.state === 'active').length,
    queuedDispatches: items.reduce((n, item) => n + Number(item.queued || 0), 0),
    runningDispatches: items.reduce((n, item) => n + Number(item.inFlight || 0), 0),
    unhealthyProjects: items.filter(item => Number(item.health?.score ?? 1) < 0.5).length,
    capacity: Math.max(1, Number(capacity) || 1),
    workers: Math.max(1, Number(workerCount) || 1)
  };
}

export function createFleetWorker({
  fleet, identity, runs, executeNext, logger, metrics,
  pollMs = 1000, batchSize = 8, maxConcurrency = 4, workerId = 'fleet-' + process.pid,
  partition = null, partitions = 1
} = {}) {
  let timer = null; let active = null; let stopping = false;

  async function process(dispatch) {
    const startedAt = Date.now();
    const scope = { principalId: dispatch.principalId, workspaceId: dispatch.workspaceId };
    return runDbScope({ ...scope, organizationId: '', jurisdiction: '', role: 'job-worker' }, async () => {
      try {
        let access;
        try {
          access = await identity.requireAccess({ id: dispatch.principalId }, dispatch.workspaceId, 'editor');
        } catch {
          await fleet.finish(scope, dispatch.id, { state: 'failed', error: 'Fleet dispatch access was revoked' });
          return false;
        }
        access.principalId = dispatch.principalId;
        const payload = dispatch.payload ?? {};
        const run = await runs.get(access, payload.runId);
        const task = run?.tasks.find(item => item.id === payload.taskId);
        if (!run || !task) {
          await fleet.finish(scope, dispatch.id, { state: 'failed', error: 'Fleet dispatch references a missing run or task' });
          return false;
        }
        if (task.status === 'complete') {
          await fleet.finish(scope, dispatch.id, { state: 'succeeded', metadata: { code: 'completed-earlier' } });
          return true;
        }
        const reply = await executeNext({
          scope: access, principal: { id: dispatch.principalId }, runId: payload.runId,
          body: payload.request ?? {}, requestId: null, expectedTaskId: payload.taskId
        });
        await fleet.finish(scope, dispatch.id, {
          state: reply.status < 400 ? 'succeeded' : 'failed',
          error: reply.status < 400 ? null : text(reply.body?.error),
          costComputeMs: Date.now() - startedAt,
          metadata: { status: reply.status }
        });
        return reply.status < 400;
      } catch (error) {
        await fleet.finish(scope, dispatch.id, {
          state: 'failed', error: text(error?.message) || 'Fleet execution failed',
          costComputeMs: Date.now() - startedAt
        }).catch(() => {});
        logger?.error('fleet dispatch failed', { error, dispatchId: dispatch.id });
        metrics?.increment('fleet_dispatch_execution_errors_total');
        return false;
      }
    });
  }

  async function runOnce() {
    if (stopping) return 0;
    const batch = await fleet.acquireBatch({
      limit: batchSize, workerId, partition, partitions
    });
    if (!batch.length) return 0;
    const ceiling = Math.max(1, Math.min(16, Number(maxConcurrency) || 1));
    const adaptive = adaptFleetCapacity({
      current: runOnce.currentWidth || ceiling,
      max: ceiling,
      queueDepth: batch.length,
      usefulParallelism: batch.length > 1 ? 1 : 0,
      remainingBudgetRatio: 1
    });
    const width = adaptive.next;
    runOnce.currentWidth = width;
    let processed = 0;
    for (let i = 0; i < batch.length; i += width) {
      await Promise.all(batch.slice(i, i + width).map(process));
      processed += Math.min(width, batch.length - i);
    }
    metrics?.increment('fleet_dispatches_total', { action: 'processed' });
    return processed;
  }

  runOnce.currentWidth = Math.max(1, Math.min(16, Number(maxConcurrency) || 1));

  const tick = async () => {
    if (active || stopping) return;
    active = runOnce().catch(error => logger?.error('fleet worker cycle failed', { error })).finally(() => { active = null; });
  };

  return {
    runOnce,
    start() {
      stopping = false;
      if (!timer) { timer = setInterval(tick, pollMs); timer.unref?.(); }
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      await active;
    }
  };
}
 + limitParam + ')',
        "UPDATE fleet_dispatches d SET state='failed',error='lease-expired-attempt-budget-exhausted',lease_until=NULL,worker_id=NULL,finished_at=now(),updated_at=now() FROM expired e WHERE d.id=e.id RETURNING d.project_id"
      ].join(' ');
      const { rows } = await client.query(sql, params);
      if (!rows.length) return 0;
      const ids = [...new Set(rows.map(row => row.project_id))];
      await client.query(
        "UPDATE fleet_projects p SET in_flight=(SELECT count(*) FROM fleet_dispatches d WHERE d.project_id=p.id AND d.state='running'),failure_count=failure_count+1,consecutive_failures=consecutive_failures+1,updated_at=now() WHERE p.id=ANY($1::text[])",
        [ids]
      );
      return rows.length;
    });
  }
  async acquireBatch({
    limit = 8, workerId = 'worker', leaseMs = 300000, partition = null, partitions = 1, workspaceId = ''
  } = {}) {
    const safeLimit = Math.max(1, Math.min(FLEET_LIMITS.maxDispatchBatch, Number(limit) || 8));
    const safeLease = Math.max(10000, Math.min(900000, Number(leaseMs) || 300000));
    const count = Math.max(1, Number(partitions) || 1);
    const shard = partition == null ? null : Math.max(0, Math.min(count - 1, Number(partition) || 0));
    return transaction(this.pool, async client => {
      const params = [];
      const conditions = [
"((d.state='queued' AND d.available_at<=now() AND d.attempts<d.max_attempts) OR (d.state='running' AND d.lease_until<now()))",
        'd.attempts<d.max_attempts',
        "p.state='active'",
        "(p.next_dispatch_at IS NULL OR p.next_dispatch_at<=now())",
        '(p.budget_tokens IS NULL OR p.budget_tokens>0)',
        '(p.budget_compute_ms IS NULL OR p.budget_compute_ms>0)',
        "p.max_concurrency>(SELECT count(*) FROM fleet_dispatches r WHERE r.project_id=d.project_id AND r.state='running')",
        "NOT EXISTS (SELECT 1 FROM fleet_project_dependencies dep WHERE dep.project_id=d.project_id AND NOT EXISTS (SELECT 1 FROM fleet_dispatches latest WHERE latest.project_id=dep.depends_on_project_id AND latest.id=(SELECT l2.id FROM fleet_dispatches l2 WHERE l2.project_id=dep.depends_on_project_id ORDER BY l2.updated_at DESC,l2.id DESC LIMIT 1) AND latest.state='succeeded'))"
      ];
      if (workspaceId) { params.push(workspaceId); conditions.unshift('d.workspace_id=$' + params.length); }
      if (shard != null) {
        params.push(count);
        const countParam = params.length;
        params.push(shard);
        const shardParam = params.length;
        conditions.push('mod(abs(hashtext(d.project_id)),$' + countParam + '::int)=$' + shardParam);
      }
      const limitParam = params.length + 1; params.push(safeLimit);
      const sql = [
        'WITH candidates AS (SELECT d.id FROM fleet_dispatches d JOIN fleet_projects p ON p.id=d.project_id',
        'WHERE ' + conditions.join(' AND '),
        'ORDER BY (p.priority*10 + LEAST(120,EXTRACT(EPOCH FROM (now()-COALESCE(p.last_dispatch_at,p.created_at)))/60)*0.75 + COALESCE((p.health->>\'score\')::double precision,1)*20 - LEAST(80,p.consecutive_failures*p.consecutive_failures*4)) DESC,d.created_at ASC,d.id ASC',
        'FOR UPDATE OF d SKIP LOCKED LIMIT $' + limitParam + ')',
        "UPDATE fleet_dispatches d SET state='running',attempts=d.attempts+1,lease_until=now()+(" + (limitParam + 1) + "::bigint*interval '1 millisecond'),worker_id=$" + (limitParam + 2) + ",started_at=COALESCE(d.started_at,now()),updated_at=now() FROM candidates c WHERE d.id=c.id RETURNING d.*"
      ].join(' ');
      params.push(safeLease, text(workerId) || 'worker');
      const { rows } = await client.query(sql, params);
      if (!rows.length) return [];
      return rows.map(row => ({
        id: row.id, projectId: row.project_id, workspaceId: row.workspace_id,
        principalId: row.principal_id, state: row.state, attempts: row.attempts,
        maxAttempts: row.max_attempts, payload: row.payload ?? {}, leaseUntil: row.lease_until
      }));
    });
  }

  async finish(scope, dispatchId, {
    state = 'succeeded', costTokens = 0, costComputeMs = 0, error = null, metadata = {}
  } = {}) {
    if (!['succeeded','failed','cancelled'].includes(text(state))) throw new FleetValidationError('Invalid terminal dispatch state');
    return transaction(this.pool, async client => {
      const { rows: [dispatch] = [] } = await client.query(
        'SELECT * FROM fleet_dispatches WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [text(dispatchId), scope.workspaceId]
      );
      if (!dispatch) return null;
      const { rows: [project] = [] } = await client.query(
        'SELECT * FROM fleet_projects WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [dispatch.project_id, scope.workspaceId]
      );
      if (!project) return null;
      const succeeded = state === 'succeeded';
      const failed = state === 'failed';
      const oldScore = Number(project.health?.score ?? 1);
      const score = succeeded ? oldScore * 0.9 + 0.1 : failed ? oldScore * 0.8 : oldScore;
      const failures = failed ? Number(project.consecutive_failures || 0) + 1 : succeeded ? 0 : Number(project.consecutive_failures || 0);
      const tokenSpent = Math.max(0, Number(costTokens) || 0);
      const computeSpent = Math.max(0, Number(costComputeMs) || 0);
      await client.query(
        "UPDATE fleet_dispatches SET state=$2,lease_until=NULL,finished_at=now(),updated_at=now(),cost_tokens=$3,cost_compute_ms=$4,error=$5,metadata=$6::jsonb WHERE id=$1 AND state='running'",
        [dispatch.id, state, tokenSpent, computeSpent, error ? text(error).slice(0,1000) : null, JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {})]
      );
      await client.query(
        "UPDATE fleet_projects SET in_flight=(SELECT count(*) FROM fleet_dispatches d WHERE d.project_id=$1 AND d.state='running'),consecutive_failures=$2,success_count=success_count+$3,failure_count=failure_count+$4,health=$5::jsonb,last_dispatch_at=now(),next_dispatch_at=CASE WHEN $4>0 AND $2>=2 THEN now()+interval '5 minutes' ELSE next_dispatch_at END,budget_tokens=CASE WHEN budget_tokens IS NULL THEN NULL ELSE GREATEST(0,budget_tokens-$6) END,budget_compute_ms=CASE WHEN budget_compute_ms IS NULL THEN NULL ELSE GREATEST(0,budget_compute_ms-$7) END,updated_at=now() WHERE id=$1 AND workspace_id=$8",
        [dispatch.project_id, failures, succeeded ? 1 : 0, failed ? 1 : 0,
          JSON.stringify({ score: Number(score.toFixed(4)), lastOutcome: succeeded ? 'succeeded' : failed ? 'failed' : state }),
          tokenSpent, computeSpent, scope.workspaceId]
      );
      return { id: dispatch.id, state, projectId: dispatch.project_id };
    });
  }
}

export function fleetStatus(projects = [], { capacity = 1, workerCount = 1 } = {}) {
  const items = Array.isArray(projects) ? projects : [];
  return {
    projects: items.length,
    activeProjects: items.filter(item => item.state === 'active').length,
    queuedDispatches: items.reduce((n, item) => n + Number(item.queued || 0), 0),
    runningDispatches: items.reduce((n, item) => n + Number(item.inFlight || 0), 0),
    unhealthyProjects: items.filter(item => Number(item.health?.score ?? 1) < 0.5).length,
    capacity: Math.max(1, Number(capacity) || 1),
    workers: Math.max(1, Number(workerCount) || 1)
  };
}

export function createFleetWorker({
  fleet, identity, runs, executeNext, logger, metrics,
  pollMs = 1000, batchSize = 8, maxConcurrency = 4, workerId = 'fleet-' + process.pid,
  partition = null, partitions = 1
} = {}) {
  let timer = null; let active = null; let stopping = false;

  async function process(dispatch) {
    const startedAt = Date.now();
    const scope = { principalId: dispatch.principalId, workspaceId: dispatch.workspaceId };
    return runDbScope({ ...scope, organizationId: '', jurisdiction: '', role: 'job-worker' }, async () => {
      try {
        let access;
        try {
          access = await identity.requireAccess({ id: dispatch.principalId }, dispatch.workspaceId, 'editor');
        } catch {
          await fleet.finish(scope, dispatch.id, { state: 'failed', error: 'Fleet dispatch access was revoked' });
          return false;
        }
        access.principalId = dispatch.principalId;
        const payload = dispatch.payload ?? {};
        const run = await runs.get(access, payload.runId);
        const task = run?.tasks.find(item => item.id === payload.taskId);
        if (!run || !task) {
          await fleet.finish(scope, dispatch.id, { state: 'failed', error: 'Fleet dispatch references a missing run or task' });
          return false;
        }
        if (task.status === 'complete') {
          await fleet.finish(scope, dispatch.id, { state: 'succeeded', metadata: { code: 'completed-earlier' } });
          return true;
        }
        const reply = await executeNext({
          scope: access, principal: { id: dispatch.principalId }, runId: payload.runId,
          body: payload.request ?? {}, requestId: null, expectedTaskId: payload.taskId
        });
        await fleet.finish(scope, dispatch.id, {
          state: reply.status < 400 ? 'succeeded' : 'failed',
          error: reply.status < 400 ? null : text(reply.body?.error),
          costComputeMs: Date.now() - startedAt,
          metadata: { status: reply.status }
        });
        return reply.status < 400;
      } catch (error) {
        await fleet.finish(scope, dispatch.id, {
          state: 'failed', error: text(error?.message) || 'Fleet execution failed',
          costComputeMs: Date.now() - startedAt
        }).catch(() => {});
        logger?.error('fleet dispatch failed', { error, dispatchId: dispatch.id });
        metrics?.increment('fleet_dispatch_execution_errors_total');
        return false;
      }
    });
  }

  async function runOnce() {
    if (stopping) return 0;
    const batch = await fleet.acquireBatch({
      limit: batchSize, workerId, partition, partitions
    });
    if (!batch.length) return 0;
    const ceiling = Math.max(1, Math.min(16, Number(maxConcurrency) || 1));
    const adaptive = adaptFleetCapacity({
      current: runOnce.currentWidth || ceiling,
      max: ceiling,
      queueDepth: batch.length,
      usefulParallelism: batch.length > 1 ? 1 : 0,
      remainingBudgetRatio: 1
    });
    const width = adaptive.next;
    runOnce.currentWidth = width;
    let processed = 0;
    for (let i = 0; i < batch.length; i += width) {
      await Promise.all(batch.slice(i, i + width).map(process));
      processed += Math.min(width, batch.length - i);
    }
    metrics?.increment('fleet_dispatches_total', { action: 'processed' });
    return processed;
  }

  runOnce.currentWidth = Math.max(1, Math.min(16, Number(maxConcurrency) || 1));

  const tick = async () => {
    if (active || stopping) return;
    active = runOnce().catch(error => logger?.error('fleet worker cycle failed', { error })).finally(() => { active = null; });
  };

  return {
    runOnce,
    start() {
      stopping = false;
      if (!timer) { timer = setInterval(tick, pollMs); timer.unref?.(); }
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      await active;
    }
  };
}
 + fenceParams.length); }
      const { rows: [dispatch] = [] } = await client.query(
        'SELECT * FROM fleet_dispatches WHERE ' + fence.join(' AND ') + ' FOR UPDATE',
        fenceParams
      );
      if (!dispatch) return null;
      const { rows: [project] = [] } = await client.query(
        'SELECT * FROM fleet_projects WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [dispatch.project_id, scope.workspaceId]
      );
      if (!project) return null;
      const succeeded = state === 'succeeded';
      const failed = state === 'failed';
      const oldScore = Number(project.health?.score ?? 1);
      const score = succeeded ? oldScore * 0.9 + 0.1 : failed ? oldScore * 0.8 : oldScore;
      const failures = failed ? Number(project.consecutive_failures || 0) + 1 : succeeded ? 0 : Number(project.consecutive_failures || 0);
      const tokenSpent = Math.max(0, Number(costTokens) || 0);
      const computeSpent = Math.max(0, Number(costComputeMs) || 0);
      await client.query(
        "UPDATE fleet_dispatches SET state=$2,lease_until=NULL,finished_at=now(),updated_at=now(),cost_tokens=$3,cost_compute_ms=$4,error=$5,metadata=$6::jsonb WHERE id=$1 AND state='running'",
        [dispatch.id, state, tokenSpent, computeSpent, error ? text(error).slice(0,1000) : null, JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {})]
      );
      await client.query(
        "UPDATE fleet_projects SET in_flight=(SELECT count(*) FROM fleet_dispatches d WHERE d.project_id=$1 AND d.state='running'),consecutive_failures=$2,success_count=success_count+$3,failure_count=failure_count+$4,health=$5::jsonb,last_dispatch_at=now(),next_dispatch_at=CASE WHEN $4>0 AND $2>=2 THEN now()+interval '5 minutes' ELSE next_dispatch_at END,budget_tokens=CASE WHEN budget_tokens IS NULL THEN NULL ELSE GREATEST(0,budget_tokens-$6) END,budget_compute_ms=CASE WHEN budget_compute_ms IS NULL THEN NULL ELSE GREATEST(0,budget_compute_ms-$7) END,updated_at=now() WHERE id=$1 AND workspace_id=$8",
        [dispatch.project_id, failures, succeeded ? 1 : 0, failed ? 1 : 0,
          JSON.stringify({ score: Number(score.toFixed(4)), lastOutcome: succeeded ? 'succeeded' : failed ? 'failed' : state }),
          tokenSpent, computeSpent, scope.workspaceId]
      );
      return { id: dispatch.id, state, projectId: dispatch.project_id };
    });
  }
}

export function fleetStatus(projects = [], { capacity = 1, workerCount = 1 } = {}) {
  const items = Array.isArray(projects) ? projects : [];
  return {
    projects: items.length,
    activeProjects: items.filter(item => item.state === 'active').length,
    queuedDispatches: items.reduce((n, item) => n + Number(item.queued || 0), 0),
    runningDispatches: items.reduce((n, item) => n + Number(item.inFlight || 0), 0),
    unhealthyProjects: items.filter(item => Number(item.health?.score ?? 1) < 0.5).length,
    capacity: Math.max(1, Number(capacity) || 1),
    workers: Math.max(1, Number(workerCount) || 1)
  };
}

export function createFleetWorker({
  fleet, identity, runs, executeNext, logger, metrics,
  pollMs = 1000, batchSize = 8, maxConcurrency = 4, workerId = 'fleet-' + process.pid,
  partition = null, partitions = 1
} = {}) {
  let timer = null; let active = null; let stopping = false;

  async function process(dispatch) {
    const startedAt = Date.now();
    const scope = { principalId: dispatch.principalId, workspaceId: dispatch.workspaceId };
    return runDbScope({ ...scope, organizationId: '', jurisdiction: '', role: 'job-worker' }, async () => {
      try {
        let access;
        try {
          access = await identity.requireAccess({ id: dispatch.principalId }, dispatch.workspaceId, 'editor');
        } catch {
          await fleet.finish(scope, dispatch.id, { state: 'failed', error: 'Fleet dispatch access was revoked' });
          return false;
        }
        access.principalId = dispatch.principalId;
        const payload = dispatch.payload ?? {};
        const run = await runs.get(access, payload.runId);
        const task = run?.tasks.find(item => item.id === payload.taskId);
        if (!run || !task) {
          await fleet.finish(scope, dispatch.id, { state: 'failed', error: 'Fleet dispatch references a missing run or task' });
          return false;
        }
        if (task.status === 'complete') {
          await fleet.finish(scope, dispatch.id, { state: 'succeeded', metadata: { code: 'completed-earlier' } });
          return true;
        }
        const reply = await executeNext({
          scope: access, principal: { id: dispatch.principalId }, runId: payload.runId,
          body: payload.request ?? {}, requestId: null, expectedTaskId: payload.taskId
        });
        await fleet.finish(scope, dispatch.id, {
          state: reply.status < 400 ? 'succeeded' : 'failed',
          error: reply.status < 400 ? null : text(reply.body?.error),
          costComputeMs: Date.now() - startedAt,
          metadata: { status: reply.status }
        });
        return reply.status < 400;
      } catch (error) {
        await fleet.finish(scope, dispatch.id, {
          state: 'failed', error: text(error?.message) || 'Fleet execution failed',
          costComputeMs: Date.now() - startedAt
        }).catch(() => {});
        logger?.error('fleet dispatch failed', { error, dispatchId: dispatch.id });
        metrics?.increment('fleet_dispatch_execution_errors_total');
        return false;
      }
    });
  }

  async function runOnce() {
    if (stopping) return 0;
    const batch = await fleet.acquireBatch({
      limit: batchSize, workerId, partition, partitions
    });
    if (!batch.length) return 0;
    const ceiling = Math.max(1, Math.min(16, Number(maxConcurrency) || 1));
    const adaptive = adaptFleetCapacity({
      current: runOnce.currentWidth || ceiling,
      max: ceiling,
      queueDepth: batch.length,
      usefulParallelism: batch.length > 1 ? 1 : 0,
      remainingBudgetRatio: 1
    });
    const width = adaptive.next;
    runOnce.currentWidth = width;
    let processed = 0;
    for (let i = 0; i < batch.length; i += width) {
      await Promise.all(batch.slice(i, i + width).map(process));
      processed += Math.min(width, batch.length - i);
    }
    metrics?.increment('fleet_dispatches_total', { action: 'processed' });
    return processed;
  }

  runOnce.currentWidth = Math.max(1, Math.min(16, Number(maxConcurrency) || 1));

  const tick = async () => {
    if (active || stopping) return;
    active = runOnce().catch(error => logger?.error('fleet worker cycle failed', { error })).finally(() => { active = null; });
  };

  return {
    runOnce,
    start() {
      stopping = false;
      if (!timer) { timer = setInterval(tick, pollMs); timer.unref?.(); }
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      await active;
    }
  };
}
 + params.length);
      }
      const limitParam = params.length + 1;
      params.push(Math.max(1, Math.min(500, Number(limit) || 100)));
      const sql = [
        'WITH expired AS (SELECT id,project_id FROM fleet_dispatches WHERE',
        conditions.join(' AND '),
        'ORDER BY lease_until ASC,id ASC FOR UPDATE SKIP LOCKED LIMIT 
    limit = 8, workerId = 'worker', leaseMs = 300000, partition = null, partitions = 1, workspaceId = ''
  } = {}) {
    const safeLimit = Math.max(1, Math.min(FLEET_LIMITS.maxDispatchBatch, Number(limit) || 8));
    const safeLease = Math.max(10000, Math.min(900000, Number(leaseMs) || 300000));
    const count = Math.max(1, Number(partitions) || 1);
    const shard = partition == null ? null : Math.max(0, Math.min(count - 1, Number(partition) || 0));
    return transaction(this.pool, async client => {
      const params = [];
      const conditions = [
"((d.state='queued' AND d.available_at<=now() AND d.attempts<d.max_attempts) OR (d.state='running' AND d.lease_until<now()))",
        'd.attempts<d.max_attempts',
        "p.state='active'",
        "(p.next_dispatch_at IS NULL OR p.next_dispatch_at<=now())",
        '(p.budget_tokens IS NULL OR p.budget_tokens>0)',
        '(p.budget_compute_ms IS NULL OR p.budget_compute_ms>0)',
        "p.max_concurrency>(SELECT count(*) FROM fleet_dispatches r WHERE r.project_id=d.project_id AND r.state='running')",
        "NOT EXISTS (SELECT 1 FROM fleet_project_dependencies dep WHERE dep.project_id=d.project_id AND NOT EXISTS (SELECT 1 FROM fleet_dispatches latest WHERE latest.project_id=dep.depends_on_project_id AND latest.id=(SELECT l2.id FROM fleet_dispatches l2 WHERE l2.project_id=dep.depends_on_project_id ORDER BY l2.updated_at DESC,l2.id DESC LIMIT 1) AND latest.state='succeeded'))"
      ];
      if (workspaceId) { params.push(workspaceId); conditions.unshift('d.workspace_id=$' + params.length); }
      if (shard != null) {
        params.push(count);
        const countParam = params.length;
        params.push(shard);
        const shardParam = params.length;
        conditions.push('mod(abs(hashtext(d.project_id)),$' + countParam + '::int)=$' + shardParam);
      }
      const limitParam = params.length + 1; params.push(safeLimit);
      const sql = [
        'WITH candidates AS (SELECT d.id FROM fleet_dispatches d JOIN fleet_projects p ON p.id=d.project_id',
        'WHERE ' + conditions.join(' AND '),
        'ORDER BY (p.priority*10 + LEAST(120,EXTRACT(EPOCH FROM (now()-COALESCE(p.last_dispatch_at,p.created_at)))/60)*0.75 + COALESCE((p.health->>\'score\')::double precision,1)*20 - LEAST(80,p.consecutive_failures*p.consecutive_failures*4)) DESC,d.created_at ASC,d.id ASC',
        'FOR UPDATE OF d SKIP LOCKED LIMIT $' + limitParam + ')',
        "UPDATE fleet_dispatches d SET state='running',attempts=d.attempts+1,lease_until=now()+(" + (limitParam + 1) + "::bigint*interval '1 millisecond'),worker_id=$" + (limitParam + 2) + ",started_at=COALESCE(d.started_at,now()),updated_at=now() FROM candidates c WHERE d.id=c.id RETURNING d.*"
      ].join(' ');
      params.push(safeLease, text(workerId) || 'worker');
      const { rows } = await client.query(sql, params);
      if (!rows.length) return [];
      return rows.map(row => ({
        id: row.id, projectId: row.project_id, workspaceId: row.workspace_id,
        principalId: row.principal_id, state: row.state, attempts: row.attempts,
        maxAttempts: row.max_attempts, payload: row.payload ?? {}, leaseUntil: row.lease_until
      }));
    });
  }

  async finish(scope, dispatchId, {
    state = 'succeeded', costTokens = 0, costComputeMs = 0, error = null, metadata = {}
  } = {}) {
    if (!['succeeded','failed','cancelled'].includes(text(state))) throw new FleetValidationError('Invalid terminal dispatch state');
    return transaction(this.pool, async client => {
      const { rows: [dispatch] = [] } = await client.query(
        'SELECT * FROM fleet_dispatches WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [text(dispatchId), scope.workspaceId]
      );
      if (!dispatch) return null;
      const { rows: [project] = [] } = await client.query(
        'SELECT * FROM fleet_projects WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [dispatch.project_id, scope.workspaceId]
      );
      if (!project) return null;
      const succeeded = state === 'succeeded';
      const failed = state === 'failed';
      const oldScore = Number(project.health?.score ?? 1);
      const score = succeeded ? oldScore * 0.9 + 0.1 : failed ? oldScore * 0.8 : oldScore;
      const failures = failed ? Number(project.consecutive_failures || 0) + 1 : succeeded ? 0 : Number(project.consecutive_failures || 0);
      const tokenSpent = Math.max(0, Number(costTokens) || 0);
      const computeSpent = Math.max(0, Number(costComputeMs) || 0);
      await client.query(
        "UPDATE fleet_dispatches SET state=$2,lease_until=NULL,finished_at=now(),updated_at=now(),cost_tokens=$3,cost_compute_ms=$4,error=$5,metadata=$6::jsonb WHERE id=$1 AND state='running'",
        [dispatch.id, state, tokenSpent, computeSpent, error ? text(error).slice(0,1000) : null, JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {})]
      );
      await client.query(
        "UPDATE fleet_projects SET in_flight=(SELECT count(*) FROM fleet_dispatches d WHERE d.project_id=$1 AND d.state='running'),consecutive_failures=$2,success_count=success_count+$3,failure_count=failure_count+$4,health=$5::jsonb,last_dispatch_at=now(),next_dispatch_at=CASE WHEN $4>0 AND $2>=2 THEN now()+interval '5 minutes' ELSE next_dispatch_at END,budget_tokens=CASE WHEN budget_tokens IS NULL THEN NULL ELSE GREATEST(0,budget_tokens-$6) END,budget_compute_ms=CASE WHEN budget_compute_ms IS NULL THEN NULL ELSE GREATEST(0,budget_compute_ms-$7) END,updated_at=now() WHERE id=$1 AND workspace_id=$8",
        [dispatch.project_id, failures, succeeded ? 1 : 0, failed ? 1 : 0,
          JSON.stringify({ score: Number(score.toFixed(4)), lastOutcome: succeeded ? 'succeeded' : failed ? 'failed' : state }),
          tokenSpent, computeSpent, scope.workspaceId]
      );
      return { id: dispatch.id, state, projectId: dispatch.project_id };
    });
  }
}

export function fleetStatus(projects = [], { capacity = 1, workerCount = 1 } = {}) {
  const items = Array.isArray(projects) ? projects : [];
  return {
    projects: items.length,
    activeProjects: items.filter(item => item.state === 'active').length,
    queuedDispatches: items.reduce((n, item) => n + Number(item.queued || 0), 0),
    runningDispatches: items.reduce((n, item) => n + Number(item.inFlight || 0), 0),
    unhealthyProjects: items.filter(item => Number(item.health?.score ?? 1) < 0.5).length,
    capacity: Math.max(1, Number(capacity) || 1),
    workers: Math.max(1, Number(workerCount) || 1)
  };
}

export function createFleetWorker({
  fleet, identity, runs, executeNext, logger, metrics,
  pollMs = 1000, batchSize = 8, maxConcurrency = 4, workerId = 'fleet-' + process.pid,
  partition = null, partitions = 1
} = {}) {
  let timer = null; let active = null; let stopping = false;

  async function process(dispatch) {
    const startedAt = Date.now();
    const scope = { principalId: dispatch.principalId, workspaceId: dispatch.workspaceId };
    return runDbScope({ ...scope, organizationId: '', jurisdiction: '', role: 'job-worker' }, async () => {
      try {
        let access;
        try {
          access = await identity.requireAccess({ id: dispatch.principalId }, dispatch.workspaceId, 'editor');
        } catch {
          await fleet.finish(scope, dispatch.id, { state: 'failed', error: 'Fleet dispatch access was revoked' });
          return false;
        }
        access.principalId = dispatch.principalId;
        const payload = dispatch.payload ?? {};
        const run = await runs.get(access, payload.runId);
        const task = run?.tasks.find(item => item.id === payload.taskId);
        if (!run || !task) {
          await fleet.finish(scope, dispatch.id, { state: 'failed', error: 'Fleet dispatch references a missing run or task' });
          return false;
        }
        if (task.status === 'complete') {
          await fleet.finish(scope, dispatch.id, { state: 'succeeded', metadata: { code: 'completed-earlier' } });
          return true;
        }
        const reply = await executeNext({
          scope: access, principal: { id: dispatch.principalId }, runId: payload.runId,
          body: payload.request ?? {}, requestId: null, expectedTaskId: payload.taskId
        });
        await fleet.finish(scope, dispatch.id, {
          state: reply.status < 400 ? 'succeeded' : 'failed',
          error: reply.status < 400 ? null : text(reply.body?.error),
          costComputeMs: Date.now() - startedAt,
          metadata: { status: reply.status }
        });
        return reply.status < 400;
      } catch (error) {
        await fleet.finish(scope, dispatch.id, {
          state: 'failed', error: text(error?.message) || 'Fleet execution failed',
          costComputeMs: Date.now() - startedAt
        }).catch(() => {});
        logger?.error('fleet dispatch failed', { error, dispatchId: dispatch.id });
        metrics?.increment('fleet_dispatch_execution_errors_total');
        return false;
      }
    });
  }

  async function runOnce() {
    if (stopping) return 0;
    const batch = await fleet.acquireBatch({
      limit: batchSize, workerId, partition, partitions
    });
    if (!batch.length) return 0;
    const ceiling = Math.max(1, Math.min(16, Number(maxConcurrency) || 1));
    const adaptive = adaptFleetCapacity({
      current: runOnce.currentWidth || ceiling,
      max: ceiling,
      queueDepth: batch.length,
      usefulParallelism: batch.length > 1 ? 1 : 0,
      remainingBudgetRatio: 1
    });
    const width = adaptive.next;
    runOnce.currentWidth = width;
    let processed = 0;
    for (let i = 0; i < batch.length; i += width) {
      await Promise.all(batch.slice(i, i + width).map(process));
      processed += Math.min(width, batch.length - i);
    }
    metrics?.increment('fleet_dispatches_total', { action: 'processed' });
    return processed;
  }

  runOnce.currentWidth = Math.max(1, Math.min(16, Number(maxConcurrency) || 1));

  const tick = async () => {
    if (active || stopping) return;
    active = runOnce().catch(error => logger?.error('fleet worker cycle failed', { error })).finally(() => { active = null; });
  };

  return {
    runOnce,
    start() {
      stopping = false;
      if (!timer) { timer = setInterval(tick, pollMs); timer.unref?.(); }
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      await active;
    }
  };
}
 + limitParam + ')',
        "UPDATE fleet_dispatches d SET state='failed',error='lease-expired-attempt-budget-exhausted',lease_until=NULL,worker_id=NULL,finished_at=now(),updated_at=now() FROM expired e WHERE d.id=e.id RETURNING d.project_id"
      ].join(' ');
      const { rows } = await client.query(sql, params);
      if (!rows.length) return 0;
      const ids = [...new Set(rows.map(row => row.project_id))];
      await client.query(
        "UPDATE fleet_projects p SET in_flight=(SELECT count(*) FROM fleet_dispatches d WHERE d.project_id=p.id AND d.state='running'),failure_count=failure_count+1,consecutive_failures=consecutive_failures+1,updated_at=now() WHERE p.id=ANY($1::text[])",
        [ids]
      );
      return rows.length;
    });
  }
  async acquireBatch({
    limit = 8, workerId = 'worker', leaseMs = 300000, partition = null, partitions = 1, workspaceId = ''
  } = {}) {
    const safeLimit = Math.max(1, Math.min(FLEET_LIMITS.maxDispatchBatch, Number(limit) || 8));
    const safeLease = Math.max(10000, Math.min(900000, Number(leaseMs) || 300000));
    const count = Math.max(1, Number(partitions) || 1);
    const shard = partition == null ? null : Math.max(0, Math.min(count - 1, Number(partition) || 0));
    return transaction(this.pool, async client => {
      const params = [];
      const conditions = [
"((d.state='queued' AND d.available_at<=now() AND d.attempts<d.max_attempts) OR (d.state='running' AND d.lease_until<now()))",
        'd.attempts<d.max_attempts',
        "p.state='active'",
        "(p.next_dispatch_at IS NULL OR p.next_dispatch_at<=now())",
        '(p.budget_tokens IS NULL OR p.budget_tokens>0)',
        '(p.budget_compute_ms IS NULL OR p.budget_compute_ms>0)',
        "p.max_concurrency>(SELECT count(*) FROM fleet_dispatches r WHERE r.project_id=d.project_id AND r.state='running')",
        "NOT EXISTS (SELECT 1 FROM fleet_project_dependencies dep WHERE dep.project_id=d.project_id AND NOT EXISTS (SELECT 1 FROM fleet_dispatches latest WHERE latest.project_id=dep.depends_on_project_id AND latest.id=(SELECT l2.id FROM fleet_dispatches l2 WHERE l2.project_id=dep.depends_on_project_id ORDER BY l2.updated_at DESC,l2.id DESC LIMIT 1) AND latest.state='succeeded'))"
      ];
      if (workspaceId) { params.push(workspaceId); conditions.unshift('d.workspace_id=$' + params.length); }
      if (shard != null) {
        params.push(count);
        const countParam = params.length;
        params.push(shard);
        const shardParam = params.length;
        conditions.push('mod(abs(hashtext(d.project_id)),$' + countParam + '::int)=$' + shardParam);
      }
      const limitParam = params.length + 1; params.push(safeLimit);
      const sql = [
        'WITH candidates AS (SELECT d.id FROM fleet_dispatches d JOIN fleet_projects p ON p.id=d.project_id',
        'WHERE ' + conditions.join(' AND '),
        'ORDER BY (p.priority*10 + LEAST(120,EXTRACT(EPOCH FROM (now()-COALESCE(p.last_dispatch_at,p.created_at)))/60)*0.75 + COALESCE((p.health->>\'score\')::double precision,1)*20 - LEAST(80,p.consecutive_failures*p.consecutive_failures*4)) DESC,d.created_at ASC,d.id ASC',
        'FOR UPDATE OF d SKIP LOCKED LIMIT $' + limitParam + ')',
        "UPDATE fleet_dispatches d SET state='running',attempts=d.attempts+1,lease_until=now()+(" + (limitParam + 1) + "::bigint*interval '1 millisecond'),worker_id=$" + (limitParam + 2) + ",started_at=COALESCE(d.started_at,now()),updated_at=now() FROM candidates c WHERE d.id=c.id RETURNING d.*"
      ].join(' ');
      params.push(safeLease, text(workerId) || 'worker');
      const { rows } = await client.query(sql, params);
      if (!rows.length) return [];
      return rows.map(row => ({
        id: row.id, projectId: row.project_id, workspaceId: row.workspace_id,
        principalId: row.principal_id, state: row.state, attempts: row.attempts,
        maxAttempts: row.max_attempts, payload: row.payload ?? {}, leaseUntil: row.lease_until
      }));
    });
  }

  async finish(scope, dispatchId, {
    state = 'succeeded', costTokens = 0, costComputeMs = 0, error = null, metadata = {}
  } = {}) {
    if (!['succeeded','failed','cancelled'].includes(text(state))) throw new FleetValidationError('Invalid terminal dispatch state');
    return transaction(this.pool, async client => {
      const { rows: [dispatch] = [] } = await client.query(
        'SELECT * FROM fleet_dispatches WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [text(dispatchId), scope.workspaceId]
      );
      if (!dispatch) return null;
      const { rows: [project] = [] } = await client.query(
        'SELECT * FROM fleet_projects WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [dispatch.project_id, scope.workspaceId]
      );
      if (!project) return null;
      const succeeded = state === 'succeeded';
      const failed = state === 'failed';
      const oldScore = Number(project.health?.score ?? 1);
      const score = succeeded ? oldScore * 0.9 + 0.1 : failed ? oldScore * 0.8 : oldScore;
      const failures = failed ? Number(project.consecutive_failures || 0) + 1 : succeeded ? 0 : Number(project.consecutive_failures || 0);
      const tokenSpent = Math.max(0, Number(costTokens) || 0);
      const computeSpent = Math.max(0, Number(costComputeMs) || 0);
      await client.query(
        "UPDATE fleet_dispatches SET state=$2,lease_until=NULL,finished_at=now(),updated_at=now(),cost_tokens=$3,cost_compute_ms=$4,error=$5,metadata=$6::jsonb WHERE id=$1 AND state='running'",
        [dispatch.id, state, tokenSpent, computeSpent, error ? text(error).slice(0,1000) : null, JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {})]
      );
      await client.query(
        "UPDATE fleet_projects SET in_flight=(SELECT count(*) FROM fleet_dispatches d WHERE d.project_id=$1 AND d.state='running'),consecutive_failures=$2,success_count=success_count+$3,failure_count=failure_count+$4,health=$5::jsonb,last_dispatch_at=now(),next_dispatch_at=CASE WHEN $4>0 AND $2>=2 THEN now()+interval '5 minutes' ELSE next_dispatch_at END,budget_tokens=CASE WHEN budget_tokens IS NULL THEN NULL ELSE GREATEST(0,budget_tokens-$6) END,budget_compute_ms=CASE WHEN budget_compute_ms IS NULL THEN NULL ELSE GREATEST(0,budget_compute_ms-$7) END,updated_at=now() WHERE id=$1 AND workspace_id=$8",
        [dispatch.project_id, failures, succeeded ? 1 : 0, failed ? 1 : 0,
          JSON.stringify({ score: Number(score.toFixed(4)), lastOutcome: succeeded ? 'succeeded' : failed ? 'failed' : state }),
          tokenSpent, computeSpent, scope.workspaceId]
      );
      return { id: dispatch.id, state, projectId: dispatch.project_id };
    });
  }
}

export function fleetStatus(projects = [], { capacity = 1, workerCount = 1 } = {}) {
  const items = Array.isArray(projects) ? projects : [];
  return {
    projects: items.length,
    activeProjects: items.filter(item => item.state === 'active').length,
    queuedDispatches: items.reduce((n, item) => n + Number(item.queued || 0), 0),
    runningDispatches: items.reduce((n, item) => n + Number(item.inFlight || 0), 0),
    unhealthyProjects: items.filter(item => Number(item.health?.score ?? 1) < 0.5).length,
    capacity: Math.max(1, Number(capacity) || 1),
    workers: Math.max(1, Number(workerCount) || 1)
  };
}

export function createFleetWorker({
  fleet, identity, runs, executeNext, logger, metrics,
  pollMs = 1000, batchSize = 8, maxConcurrency = 4, workerId = 'fleet-' + process.pid,
  partition = null, partitions = 1
} = {}) {
  let timer = null; let active = null; let stopping = false;

  async function process(dispatch) {
    const startedAt = Date.now();
    const scope = { principalId: dispatch.principalId, workspaceId: dispatch.workspaceId };
    return runDbScope({ ...scope, organizationId: '', jurisdiction: '', role: 'job-worker' }, async () => {
      try {
        let access;
        try {
          access = await identity.requireAccess({ id: dispatch.principalId }, dispatch.workspaceId, 'editor');
        } catch {
          await fleet.finish(scope, dispatch.id, { state: 'failed', error: 'Fleet dispatch access was revoked' });
          return false;
        }
        access.principalId = dispatch.principalId;
        const payload = dispatch.payload ?? {};
        const run = await runs.get(access, payload.runId);
        const task = run?.tasks.find(item => item.id === payload.taskId);
        if (!run || !task) {
          await fleet.finish(scope, dispatch.id, { state: 'failed', error: 'Fleet dispatch references a missing run or task' });
          return false;
        }
        if (task.status === 'complete') {
          await fleet.finish(scope, dispatch.id, { state: 'succeeded', metadata: { code: 'completed-earlier' } });
          return true;
        }
        const reply = await executeNext({
          scope: access, principal: { id: dispatch.principalId }, runId: payload.runId,
          body: payload.request ?? {}, requestId: null, expectedTaskId: payload.taskId
        });
        await fleet.finish(scope, dispatch.id, {
          state: reply.status < 400 ? 'succeeded' : 'failed',
          error: reply.status < 400 ? null : text(reply.body?.error),
          costComputeMs: Date.now() - startedAt,
          metadata: { status: reply.status }
        });
        return reply.status < 400;
      } catch (error) {
        await fleet.finish(scope, dispatch.id, {
          state: 'failed', error: text(error?.message) || 'Fleet execution failed',
          costComputeMs: Date.now() - startedAt
        }).catch(() => {});
        logger?.error('fleet dispatch failed', { error, dispatchId: dispatch.id });
        metrics?.increment('fleet_dispatch_execution_errors_total');
        return false;
      }
    });
  }

  async function runOnce() {
    if (stopping) return 0;
    const batch = await fleet.acquireBatch({
      limit: batchSize, workerId, partition, partitions
    });
    if (!batch.length) return 0;
    const ceiling = Math.max(1, Math.min(16, Number(maxConcurrency) || 1));
    const adaptive = adaptFleetCapacity({
      current: runOnce.currentWidth || ceiling,
      max: ceiling,
      queueDepth: batch.length,
      usefulParallelism: batch.length > 1 ? 1 : 0,
      remainingBudgetRatio: 1
    });
    const width = adaptive.next;
    runOnce.currentWidth = width;
    let processed = 0;
    for (let i = 0; i < batch.length; i += width) {
      await Promise.all(batch.slice(i, i + width).map(process));
      processed += Math.min(width, batch.length - i);
    }
    metrics?.increment('fleet_dispatches_total', { action: 'processed' });
    return processed;
  }

  runOnce.currentWidth = Math.max(1, Math.min(16, Number(maxConcurrency) || 1));

  const tick = async () => {
    if (active || stopping) return;
    active = runOnce().catch(error => logger?.error('fleet worker cycle failed', { error })).finally(() => { active = null; });
  };

  return {
    runOnce,
    start() {
      stopping = false;
      if (!timer) { timer = setInterval(tick, pollMs); timer.unref?.(); }
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      await active;
    }
  };
}
