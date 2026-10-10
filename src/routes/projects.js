/** User-facing project organization routes. */
import { ProjectStore, ProjectError } from '../projects.js';

export function registerProjectRoutes(app, { pool, audit, route, scoped, projects: injectedProjects = null }) {
  const projects = injectedProjects ?? new ProjectStore(pool);

  app.get('/api/projects', scoped('viewer'), route(async (req, res) => {
    res.json({ projects: await projects.list(req.scope, { includeArchived: req.query?.archived === 'true' }) });
  }));

  app.post('/api/projects', scoped('editor'), route(async (req, res) => {
    try {
      const project = await projects.create(req.scope, req.principal, req.body);
      await audit?.record({
        principalId: req.principal.id, workspaceId: req.scope.workspaceId,
        action: 'project.create', target: project.id, outcome: 'allowed',
        detail: { name: project.name, surface: project.defaultSurface }, requestId: req.requestId
      });
      res.status(201).json({ project });
    } catch (error) {
      if (error instanceof ProjectError) return res.status(error.status).json({ error: error.message, code: error.code });
      throw error;
    }
  }));

  app.get('/api/projects/:id', scoped('viewer'), route(async (req, res) => {
    const project = await projects.get(req.scope, req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found', code: 'project-not-found' });
    res.json({ project });
  }));

  app.patch('/api/projects/:id', scoped('editor'), route(async (req, res) => {
    try {
      const project = await projects.update(req.scope, req.params.id, req.body);
      if (!project) return res.status(404).json({ error: 'Project not found', code: 'project-not-found' });
      await audit?.record({
        principalId: req.principal.id, workspaceId: req.scope.workspaceId,
        action: 'project.update', target: project.id, outcome: 'allowed',
        detail: { name: project.name, surface: project.defaultSurface }, requestId: req.requestId
      });
      res.json({ project });
    } catch (error) {
      if (error instanceof ProjectError) return res.status(error.status).json({ error: error.message, code: error.code });
      throw error;
    }
  }));

  app.post('/api/projects/:id/archive', scoped('editor'), route(async (req, res) => {
    try {
      const project = await projects.archive(req.scope, req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found', code: 'project-not-found' });
      await audit?.record({
        principalId: req.principal.id, workspaceId: req.scope.workspaceId,
        action: 'project.archive', target: project.id, outcome: 'allowed', requestId: req.requestId
      });
      res.json({ project });
    } catch (error) {
      if (error instanceof ProjectError) return res.status(error.status).json({
        error: error.message, code: error.code
      });
      throw error;
    }
  }));
}
