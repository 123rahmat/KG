/**
 * Human-facing project organization.
 *
 * Projects group conversations and workspace activity but never become a
 * second workflow authority. Runs/tasks remain the source of truth.
 */
import crypto from 'node:crypto';

const text = value => String(value ?? '').trim();
const SURFACES = new Set(['normal-chat', 'code', 'research']);

export class ProjectError extends Error {
  constructor(message, { status = 400, code = 'project-invalid' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function normalizeProject(input = {}, { codingResearchOnly = false } = {}) {
  const value = input && typeof input === 'object' ? input : {};
  const name = text(value.name).replace(/\s+/g, ' ').slice(0, 120);
  if (!name) throw new ProjectError('Project name is required.');
  const description = text(value.description).replace(/\s+/g, ' ').slice(0, 500);
  const defaultSurface = text(value.defaultSurface || value.surface)
    || (codingResearchOnly ? 'code' : 'normal-chat');
  if (!SURFACES.has(defaultSurface)) throw new ProjectError('Project surface must be normal-chat, code or research.');
  if (codingResearchOnly && !['code','research'].includes(defaultSurface)) {
    throw new ProjectError('New projects must belong to Coding or Research.', {
      status: 422, code: 'control-project-domain-required'
    });
  }
  const visibility = text(value.visibility) || 'private';
  if (!['private', 'workspace'].includes(visibility)) throw new ProjectError('Project visibility must be private or workspace.');
  return {
    name, description, defaultSurface, visibility,
    sourceId: text(value.sourceId) || null,
    currentRevision: text(value.currentRevision) || null,
    settings: value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings) ? value.settings : {}
  };
}

function present(row) {
  if (!row) return null;
  return {
    id: row.id, workspaceId: row.workspace_id, principalId: row.principal_id,
    name: row.name, description: row.description ?? '', state: row.state,
    visibility: row.visibility ?? 'private',
    defaultSurface: row.default_surface ?? 'normal-chat',
    sourceId: row.source_id ?? null, currentRevision: row.current_revision ?? null,
    settings: row.settings ?? {},
    conversations: Number(row.conversations ?? 0), runs: Number(row.runs ?? 0),
    activeRuns: Number(row.active_runs ?? 0),
    lastActivityAt: row.last_activity_at ?? row.updated_at,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

const RUN_JOIN = [
  'r.project_id = p.id',
  'AND r.workspace_id = p.workspace_id',
  'AND (r.visibility = \'workspace\' OR r.principal_id = $2)'
].join(' ');

export class ProjectStore {
  constructor(pool, { codingResearchOnly = false } = {}) {
    this.pool = pool;
    this.codingResearchOnly = codingResearchOnly === true;
  }

  async create(scope, principal, input = {}) {
    const normalized = normalizeProject(input, { codingResearchOnly: this.codingResearchOnly });
    if (normalized.sourceId) {
      const { rows: [source] } = await this.pool.query(
        'SELECT id FROM workspace_sources WHERE id = $1 AND workspace_id = $2 AND principal_id = $3 AND revoked_at IS NULL LIMIT 1',
        [normalized.sourceId, scope.workspaceId, principal.id]
      );
      if (!source) throw new ProjectError('The selected project source is unavailable.', { status: 404, code: 'project-source-not-found' });
    }
    const id = crypto.randomUUID();
    const { rows: [row] } = await this.pool.query(
      'INSERT INTO projects (id, workspace_id, principal_id, name, description, state, visibility, default_surface, source_id, current_revision, settings) VALUES ($1,$2,$3,$4,$5,\'active\',$6,$7,$8,$9,$10::jsonb) RETURNING *',
      [id, scope.workspaceId, principal.id, normalized.name, normalized.description, normalized.visibility, normalized.defaultSurface, normalized.sourceId, normalized.currentRevision, JSON.stringify(normalized.settings)]
    );
    return present(row);
  }

  async list(scope, { includeArchived = false } = {}) {
    const states = includeArchived ? ['active', 'archived'] : ['active'];
    const { rows } = await this.pool.query(
      [
        'SELECT p.*,',
        'COUNT(DISTINCT CASE WHEN r.conversation_id IS NOT NULL THEN r.conversation_id ELSE r.id::text END)::int AS conversations,',
        'COUNT(r.id)::int AS runs,',
        'COUNT(r.id) FILTER (WHERE r.state IN (\'queued\',\'running\',\'waiting\',\'iterate\'))::int AS active_runs,',
        'MAX(r.updated_at) AS last_activity_at',
        'FROM projects p',
        'LEFT JOIN runs r ON ' + RUN_JOIN,
        'WHERE p.workspace_id = $1 AND p.state = ANY($3::text[])',
        'AND (p.visibility = \'workspace\' OR p.principal_id = $2)',
        'GROUP BY p.id',
        'ORDER BY COALESCE(MAX(r.updated_at), p.updated_at) DESC, p.updated_at DESC, p.id'
      ].join(' '),
      [scope.workspaceId, scope.principalId, states]
    );
    return rows.map(present);
  }

  async get(scope, id) {
    const { rows: [row] } = await this.pool.query(
      [
        'SELECT p.*,',
        'COUNT(DISTINCT CASE WHEN r.conversation_id IS NOT NULL THEN r.conversation_id ELSE r.id::text END)::int AS conversations,',
        'COUNT(r.id)::int AS runs,',
        'COUNT(r.id) FILTER (WHERE r.state IN (\'queued\',\'running\',\'waiting\',\'iterate\'))::int AS active_runs,',
        'MAX(r.updated_at) AS last_activity_at',
        'FROM projects p',
        'LEFT JOIN runs r ON ' + RUN_JOIN,
        'WHERE p.id = $1 AND p.workspace_id = $2',
        'AND (p.visibility = \'workspace\' OR p.principal_id = $3)',
        'GROUP BY p.id'
      ].join(' '),
      [id, scope.workspaceId, scope.principalId]
    );
    return present(row);
  }

  async assertAccessible(scope, id) {
    const project = await this.get(scope, id);
    if (!project) throw new ProjectError('Project not found.', { status: 404, code: 'project-not-found' });
    return project;
  }

  async update(scope, id, patch = {}) {
    const current = await this.get(scope, id);
    if (!current) return null;
    if (this.codingResearchOnly && (current.defaultSurface === 'normal-chat'
        || (patch?.defaultSurface && patch.defaultSurface !== current.defaultSurface)
        || (patch?.surface && patch.surface !== current.defaultSurface))) {
      throw new ProjectError('The owning control engine cannot be changed.', {
        status: 409, code: 'control-project-immutable'
      });
    }
    const normalized = normalizeProject({ ...current, ...(patch || {}) }, {
      codingResearchOnly: this.codingResearchOnly
    });
    if (normalized.sourceId) {
      const { rows: [source] } = await this.pool.query(
        'SELECT id FROM workspace_sources WHERE id = $1 AND workspace_id = $2 AND principal_id = $3 AND revoked_at IS NULL LIMIT 1',
        [normalized.sourceId, scope.workspaceId, scope.principalId]
      );
      if (!source) {
        throw new ProjectError('The selected project source is unavailable.', {
          status: 404,
          code: 'project-source-not-found'
        });
      }
    }
    const { rows: [row] } = await this.pool.query(
      'UPDATE projects SET name=$3, description=$4, visibility=$5, default_surface=$6, source_id=$7, current_revision=$8, settings=$9::jsonb, updated_at=now() WHERE id=$1 AND workspace_id=$2 RETURNING *',
      [id, scope.workspaceId, normalized.name, normalized.description, normalized.visibility, normalized.defaultSurface, normalized.sourceId, normalized.currentRevision, JSON.stringify(normalized.settings)]
    );
    return present(row);
  }

  async archive(scope, id) {
    const { rows: [row] } = await this.pool.query(
      'UPDATE projects SET state=\'archived\', updated_at=now() WHERE id=$1 AND workspace_id=$2 AND (visibility=\'workspace\' OR principal_id=$3) RETURNING *',
      [id, scope.workspaceId, scope.principalId]
    );
    return present(row);
  }
}
