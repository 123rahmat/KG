import { RagStore } from '../rag.js';

export function registerRagRoutes(app, { pool, config, audit, route, scoped }) {
  const rag = new RagStore(pool, { encryptionKey: config.security.personalDataEncryptionKey, maxChunkChars: 12000 });
  app.post('/api/rag/index', scoped('editor'), route(async (req, res) => {
    const result = await rag.index(req.scope, { sourceType: req.body?.sourceType, sourceId: req.body?.sourceId, title: req.body?.title, text: req.body?.text, metadata: req.body?.metadata });
    await audit?.record({ principalId: req.principal.id, workspaceId: req.scope.workspaceId, action: 'rag.index', target: String(req.body?.sourceId ?? ''), outcome: 'allowed', detail: { sourceType: req.body?.sourceType, chunks: result.chunks }, requestId: req.requestId });
    res.status(201).json(result);
  }));
  app.get('/api/rag/search', scoped('viewer'), route(async (req, res) => {
    const results = await rag.search(req.scope, req.query.q, { limit: req.query.limit });
    res.json({ results });
  }));
}