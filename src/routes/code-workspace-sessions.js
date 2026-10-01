import { CodeWorkspaceSessionStore } from '../code-workspace-sessions.js';

export function registerCodeWorkspaceSessionRoutes(app, { pool, audit, route, scoped }) {
  const sessions = new CodeWorkspaceSessionStore(pool);
  app.get('/api/code-workspaces/sessions', scoped('viewer'), route(async (req, res) => {
    res.json({ sessions: await sessions.list(req.scope, { projectId: req.query.projectId, state: req.query.state || 'active', limit: req.query.limit }) });
  }));
  app.post('/api/code-workspaces/sessions', scoped('editor'), route(async (req, res) => {
    let created;
    try { created = await sessions.create(req.scope, req.body); }
    catch (error) { return res.status(Number(error?.status) || 400).json({ error: error.message || 'Unable to create workspace session', code: error.code || 'workspace-session-invalid' }); }
    await audit?.record({ principalId: req.principal.id, workspaceId: req.scope.workspaceId, action: 'code-workspace.session.create', target: created.id, outcome: 'allowed', detail: { projectId: created.project_id, sourceId: created.source_id, conversationId: created.conversation_id }, requestId: req.requestId });
    res.status(201).json({ session: created });
  }));
  app.get('/api/code-workspaces/sessions/:id', scoped('viewer'), route(async (req, res) => {
    const session = await sessions.get(req.scope, req.params.id);
    if (!session) return res.status(404).json({ error: 'Workspace session not found', code: 'workspace-session-not-found' });
    res.json({ session });
  }));
  app.post('/api/code-workspaces/sessions/:id/close', scoped('editor'), route(async (req, res) => {
    const session = await sessions.close(req.scope, req.params.id);
    if (!session) return res.status(404).json({ error: 'Workspace session not found', code: 'workspace-session-not-found' });
    await audit?.record({ principalId: req.principal.id, workspaceId: req.scope.workspaceId, action: 'code-workspace.session.close', target: session.id, outcome: 'allowed', requestId: req.requestId });
    res.json({ session });
  }));
}