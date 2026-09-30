/** Workspace objects: upload, list, download, lifecycle. */

export function registerObjectsRoutes(app, { objects, audit, scoped, idempotent, route }) {
  app.post('/api/objects', scoped('editor'), idempotent, route(async (req, res) =>
    res.status(201).json(await objects.create(req.scope, req.principal, req.body ?? {}, {
      requestId: req.requestId
    }))));

  app.get('/api/objects', scoped('viewer'), route(async (req, res) =>
    res.json(await objects.list(req.scope, req.query))));

  app.get('/api/objects/usage', scoped('viewer'), route(async (req, res) =>
    res.json(await objects.usage(req.scope))));

  app.get('/api/objects/:id', scoped('viewer'), route(async (req, res) => {
    const object = await objects.get(req.scope, req.params.id);
    if (!object) return res.status(404).json({ error: 'Object not found', code: 'no-object' });
    res.json(object);
  }));

  app.get('/api/objects/:id/content', scoped('viewer'), route(async (req, res) => {
    const object = await objects.read(req.scope, req.params.id);
    if (!object) return res.status(404).json({ error: 'Object not found', code: 'no-object' });
    // Always a download, never inline: stored bytes must not be able to
    // execute as markup on our own origin.
    res.set('content-type', 'application/octet-stream');
    res.set('content-disposition', 'attachment');
    res.set('x-content-type-options', 'nosniff');
    res.send(object.content);
  }));

  for (const [action, lifecycle] of [['archive', 'archived'], ['restore', 'active']]) {
    app.post(`/api/objects/:id/${action}`, scoped('editor'), route(async (req, res) => {
      const object = await objects.setLifecycle(req.scope, req.principal, req.params.id, lifecycle, {
        requestId: req.requestId
      });
      if (!object) return res.status(404).json({ error: 'Object not found', code: 'no-object' });
      res.json(object);
    }));
  }

  app.delete('/api/objects/:id', scoped('editor'), route(async (req, res) => {
    const object = await objects.remove(req.scope, req.principal, req.params.id, {
      requestId: req.requestId
    });
    if (!object) return res.status(404).json({ error: 'Object not found', code: 'no-object' });
    res.json(object);
  }));

  /* ------------------------------------------------------------- audit */
}
