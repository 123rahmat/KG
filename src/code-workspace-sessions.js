/** Concurrent code-workspace sessions. */
import crypto from 'node:crypto';
const text = value => String(value ?? '').trim();
const ID = /^[A-Za-z0-9-]{8,80}$/;

export function normalizeWorkspaceSessionInput(body = {}) {
  const conversationId = text(body.conversationId);
  if (conversationId && !ID.test(conversationId)) throw new Error('Invalid conversationId');
  const branch = text(body.branch);
  if (branch.length > 200) throw new Error('Branch name is too long');
  return {
    projectId: text(body.projectId) || null,
    sourceId: text(body.sourceId) || null,
    conversationId: conversationId || null,
    branch: branch || null,
    baseRevision: text(body.baseRevision) || null,
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {}
  };
}
export class CodeWorkspaceSessionStore {
  constructor(pool) { this.pool = pool; }
  async create(scope, body = {}) {
    const input = normalizeWorkspaceSessionInput(body);
    if (!input.projectId && !input.sourceId) throw new Error('projectId or sourceId is required');
    if (input.sourceId) {
      const { rows: [source] } = await this.pool.query(
        `SELECT id, kind FROM workspace_sources WHERE id = $1 AND workspace_id = $2 AND principal_id = $3 AND revoked_at IS NULL LIMIT 1`,
        [input.sourceId, scope.workspaceId, scope.principalId]
      );
      if (!source || source.kind !== 'github') { const error = new Error('Only GitHub repositories are supported as Code Workspace sources.'); error.status = 404; error.code = 'github-source-required'; throw error; }
    }
    const id = crypto.randomUUID();
    const { rows: [row] } = await this.pool.query(
      'INSERT INTO code_workspace_sessions (id, workspace_id, principal_id, project_id, source_id, conversation_id, branch, base_revision, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *',
      [id, scope.workspaceId, scope.principalId, input.projectId, input.sourceId, input.conversationId, input.branch, input.baseRevision, JSON.stringify(input.metadata)]
    );
    return row;
  }
  async list(scope, { projectId = null, state = 'active', limit = 50 } = {}) {
    const size = Math.max(1, Math.min(100, Number(limit) || 50));
    const { rows } = await this.pool.query(
      'SELECT id, project_id AS "projectId", source_id AS "sourceId", conversation_id AS "conversationId", branch, base_revision AS "baseRevision", state, metadata, created_at AS "createdAt", updated_at AS "updatedAt", closed_at AS "closedAt" FROM code_workspace_sessions WHERE workspace_id = $1 AND principal_id = $2 AND ($3::text IS NULL OR project_id = $3) AND ($4::text IS NULL OR state = $4) ORDER BY updated_at DESC, id DESC LIMIT $5',
      [scope.workspaceId, scope.principalId, text(projectId) || null, text(state) || null, size]
    );
    return rows;
  }
  async get(scope, id) {
    const { rows: [row] } = await this.pool.query(
      'SELECT id, project_id AS "projectId", source_id AS "sourceId", conversation_id AS "conversationId", branch, base_revision AS "baseRevision", state, metadata, created_at AS "createdAt", updated_at AS "updatedAt", closed_at AS "closedAt" FROM code_workspace_sessions WHERE id = $1 AND workspace_id = $2 AND principal_id = $3 LIMIT 1',
      [text(id), scope.workspaceId, scope.principalId]
    );
    return row ?? null;
  }
  async close(scope, id) {
    const { rows: [row] } = await this.pool.query(
      "UPDATE code_workspace_sessions SET state = 'closed', closed_at = COALESCE(closed_at, now()), updated_at = now() WHERE id = $1 AND workspace_id = $2 AND principal_id = $3 RETURNING id, state, closed_at AS \"closedAt\", updated_at AS \"updatedAt\"",
      [text(id), scope.workspaceId, scope.principalId]
    );
    return row ?? null;
  }
}