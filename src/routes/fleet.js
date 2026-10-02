/** Fleet-level project registry and dispatch control. */
import { FleetStore, adaptFleetCapacity } from '../fleet-control.js';

export function registerFleetRoutes(app, { pool, audit, route, scoped, metrics }) {
  const fleet = new FleetStore(pool);

  app.get('/api/fleet/status', scoped('viewer'), route(async (req, res) => {
    const summary = await fleet.summary(req.scope);
    const capacity = Math.max(1, Math.min(16, Number(process.env.FLEET_MAX_CONCURRENCY) || 4));
    const workerCount = Math.max(1, Number(process.env.FLEET_WORKERS) || 1);
    const status = { ...summary, capacity, workers: workerCount };
    res.json({
      status,
      capacityPolicy: adaptFleetCapacity({
        current: capacity, max: 16, queueDepth: status.queuedDispatches,
        usefulParallelism: status.activeProjects > 1 ? 0.8 : 0
      })
    });
  }));

  app.get('/api/fleet/projects', scoped('viewer'), route(async (req, res) => {
    const projects = await fleet.list(req.scope, {
      state: req.query?.state, limit: req.query?.limit, offset: req.query?.offset
    });
    res.json({ projects, count: projects.length });
  }));

  app.post('/api/fleet/projects', scoped('admin'), route(async (req, res) => {
    const project = await fleet.create(req.scope, req.body);
    await audit?.record({
      principalId: req.principal.id, workspaceId: req.scope.workspaceId,
      action: 'fleet.project.create', target: project.id, outcome: 'allowed',
      detail: { name: project.name, sourceId: project.sourceId }, requestId: req.requestId
    });
    metrics?.increment('fleet_projects_total', { action: 'created' });
    res.status(201).json({ project });
  }));

  app.patch('/api/fleet/projects/:id', scoped('admin'), route(async (req, res) => {
    const project = await fleet.update(req.scope, req.params.id, req.body);
    if (!project) return res.status(404).json({ error: 'Fleet project not found', code: 'project-not-found' });
    await audit?.record({
      principalId: req.principal.id, workspaceId: req.scope.workspaceId,
      action: 'fleet.project.update', target: project.id, outcome: 'allowed',
      detail: { state: project.state, priority: project.priority, maxConcurrency: project.maxConcurrency },
      requestId: req.requestId
    });
    res.json({ project });
  }));

  app.get('/api/fleet/projects/:id/dependencies', scoped('viewer'), route(async (req, res) => {
    res.json({ projectId: req.params.id, dependencies: await fleet.dependencies(req.scope, req.params.id) });
  }));

  app.post('/api/fleet/projects/:id/dependencies', scoped('admin'), route(async (req, res) => {
    try {
      const dependencies = await fleet.addDependency(req.scope, req.params.id, req.body?.dependsOnProjectId);
      res.status(201).json({ projectId: req.params.id, dependencies });
    } catch (error) {
      return res.status(400).json({ error: error.message, code: 'invalid-project-dependency' });
    }
  }));

  app.post('/api/fleet/projects/:id/dispatch', scoped('editor'), route(async (req, res) => {
    try {
      const dispatch = await fleet.enqueue(req.scope, req.params.id, req.body);
      await audit?.record({
        principalId: req.principal.id, workspaceId: req.scope.workspaceId,
        action: 'fleet.dispatch.enqueue', target: dispatch.id, outcome: 'allowed',
        detail: { projectId: dispatch.projectId, runId: req.body?.runId, taskId: req.body?.taskId },
        requestId: req.requestId
      });
      metrics?.increment('fleet_dispatches_total', { action: 'queued' });
      res.status(202).json({ dispatch });
    } catch (error) {
      return res.status(400).json({ error: error.message, code: 'invalid-fleet-dispatch' });
    }
  }));
}
