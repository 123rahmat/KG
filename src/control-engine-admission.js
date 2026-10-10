/**
 * Strict new-work admission for one KG runtime / two domain controllers.
 *
 * This gate is separate from abuse policy, never records safety strikes, and
 * runs before reading attachments, using models, retrieval, tools or agents.
 * It is activated only by the staged CODING_RESEARCH_ONLY deployment flag.
 *
 * UI-supplied surface/project names are never sufficient authorization:
 * the project owner, immutable run identity, and prior continuation are
 * resolved from authorized server-side rows.
 */
import { assessWorkDomain } from './work-domain.js';
import { controlEngineForSurface } from './work-control-engines.js';

const text = value => String(value ?? '').trim();
const VALID_SURFACES = new Set(['code', 'research']);

export class ControlAdmissionError extends Error {
  constructor(message, code = 'control-admission-denied', status = 422, detail = undefined) {
    super(message);
    this.name = 'ControlAdmissionError';
    this.code = code;
    this.status = status;
    if (detail) this.detail = detail;
  }
}

export async function admitControlEngineRequest({
  pool, scope, principalId, goal, projectId, activeSurface, conversationId,
  allowMixed = false
} = {}) {
  const projectKey = text(projectId);
  if (!projectKey) {
    throw new ControlAdmissionError(
      'Choose a Coding or Research project before beginning new work.',
      'control-project-required', 422
    );
  }
  // Reject inaccessible projects without disclosing their existence.
  const result = await pool.query(
    `SELECT id, default_surface, state, current_revision
       FROM projects
      WHERE id = $1 AND workspace_id = $2
        AND (principal_id = $3 OR visibility = 'workspace')
        AND state = 'active' LIMIT 1`,
    [projectKey, scope.workspaceId, principalId]
  );
  const project = result.rows?.[0];
  if (!project) throw new ControlAdmissionError('Project not found.', 'control-project-not-found', 404);
  const surface = text(project.default_surface).toLowerCase();
  if (!VALID_SURFACES.has(surface)) {
    throw new ControlAdmissionError(
      'Historical Normal Chat projects are read-only; choose Coding or Research.',
      'control-historical-project', 422
    );
  }
  // Keep domain switching explicit. Never silently attach Research work to
  // Coding write authority because a message happened to mention papers.
  const requestedSurface = text(activeSurface).toLowerCase();
  if (requestedSurface && requestedSurface !== surface) {
    throw new ControlAdmissionError(
      'Selected workspace does not match the project’s control engine.',
      'control-surface-mismatch', 409
    );
  }
  let conversation = [];
  const conversationKey = text(conversationId);
  if (conversationKey) {
    // A real project-bound prior run is trusted for a contextual follow-up;
    // other chats, different projects and old general-chat runs are ignored.
    const history = await pool.query(
      `SELECT id, surface, goal FROM runs
         WHERE workspace_id = $1 AND principal_id = $2
           AND project_id = $3 AND conversation_id = $4
           AND surface = $5 ORDER BY created_at DESC LIMIT 3`,
      [scope.workspaceId, principalId, projectKey, conversationKey, surface]
    );
    conversation = (history.rows ?? []).map(row => ({
      scopeDecision: {
        status: 'in-scope', domain: controlEngineForSurface(row.surface)
      }
    }));
  }
  const assessment = assessWorkDomain({ request: goal, conversation });
  if (assessment.status === 'mixed' && !allowMixed) {
    throw new ControlAdmissionError(
      assessment.reply || 'Separate the Coding/Research task from unrelated requests.',
      'control-mixed-request', 422,
      { supportedRequest: assessment.supportedRequest, unsupportedSummary: assessment.unsupportedSummary }
    );
  }
  if (assessment.status === 'out-of-scope' || assessment.status === 'needs-clarification') {
    throw new ControlAdmissionError(assessment.reply || 'Specify Coding or Research work.',
      assessment.status === 'out-of-scope' ? 'control-out-of-scope' : 'control-clarification-required',
      422);
  }
  const controller = controlEngineForSurface(surface);
  if (assessment.domain !== controller) {
    throw new ControlAdmissionError(
      'This work belongs to a different project control engine; choose the matching project.',
      'control-domain-mismatch', 409,
      { assessedDomain: assessment.domain, projectControlEngineId: controller }
    );
  }
  return Object.freeze({
    controlEngineId: controller,
    surface,
    projectId: projectKey,
    projectRevision: text(project.current_revision) || null,
    scopeDecision: assessment
  });
}
