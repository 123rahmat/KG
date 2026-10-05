/** Workspace objects: upload, list, preview, download, lifecycle. */

import { readDocumentIsolated } from '../document-runner.js';

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

  app.get('/api/objects/:id/preview', scoped('viewer'), route(async (req, res) => {
    const object = await objects.read(req.scope, req.params.id);
    if (!object) return res.status(404).json({ error: 'Object not found', code: 'no-object' });
    try {
      const parsed = await readDocumentIsolated(object.content, {
        name: object.metadata.name,
        contentType: object.metadata.contentType
      }, { timeoutMs: 12_000 });
      return res.json({
        id: object.metadata.id,
        name: object.metadata.name,
        contentType: object.metadata.contentType,
        kind: parsed.kind,
        format: parsed.format,
        pages: parsed.pages ?? null,
        slides: parsed.slides ?? null,
        truncated: parsed.truncated === true,
        text: String(parsed.text ?? '').slice(0, 24_000),
        tables: Array.isArray(parsed.tables) ? parsed.tables.slice(0, 6).map(table => ({
          name: table.name,
          sample: Array.isArray(table.rows) ? table.rows.slice(0, 6) : []
        })) : []
      });
    } catch (error) {
      return res.status(422).json({
        error: error?.message || 'This artifact could not be previewed.',
        code: error?.code || 'preview-unavailable'
      });
    }
  }));

  app.get('/api/objects/:id/content', scoped('viewer'), route(async (req, res) => {
    const object = await objects.read(req.scope, req.params.id);
    if (!object) return res.status(404).json({ error: 'Object not found', code: 'no-object' });
    // Always a download, never inline: stored bytes must not be able to
    // execute as markup on our own origin.
    const preview = req.query.preview === '1' || req.query.preview === 'true';
    if (preview) {
      const contentType = String(object.metadata.contentType || '').split(';')[0].toLowerCase();
      const safeInline = new Set([
        'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'
      ]).has(contentType);
      if (!safeInline) {
        return res.status(415).json({ error: 'This artifact format is not safe to render inline.', code: 'inline-preview-unsupported' });
      }
      res.set('content-type', contentType);
      res.set('content-disposition', 'inline');
      res.set('content-security-policy', "default-src 'none'; frame-ancestors 'self'; object-src 'none';");
    } else {
      res.set('content-type', 'application/octet-stream');
      res.set('content-disposition', 'attachment');
    }
    res.set('x-content-type-options', 'nosniff');
    res.set('cache-control', 'private, no-store');
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
