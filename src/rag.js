/**
 * Retrieval-Augmented Generation store.
 * User/workspace content is encrypted at rest. Retrieval uses keyed term
 * fingerprints so the database never needs plaintext RAG text.
 */
import { encryptJson, decryptField, keyedDigest } from './data-protection.js';
import { AdaptiveCache } from './adaptive-cache.js';

const text = value => String(value ?? '').trim();
const terms = value => [...new Set(text(value).toLowerCase()
  .split(/[^\p{L}\p{N}_-]+/u).filter(item => item.length > 2))].slice(0, 32);

export function buildRetrievalQuery(goal, { projectPaths = [], skillNames = [], priorTopics = [] } = {}) {
  return {
    goal: text(goal).slice(0, 4000),
    terms: terms(goal),
    projectPaths: [...new Set(projectPaths.map(text).filter(Boolean))].slice(0, 40),
    skills: [...new Set(skillNames.map(text).filter(Boolean))].slice(0, 20),
    priorTopics: [...new Set(priorTopics.map(text).filter(Boolean))].slice(0, 20)
  };
}

export function rankLexical(query, rows = [], limit = 12) {
  const wanted = new Set(terms(query));
  return rows.map(row => {
    const value = text(row.content || row.text || row.title);
    const have = new Set(terms(value));
    const score = [...wanted].reduce((sum, term) => sum + (have.has(term) ? 1 : 0), 0);
    return { ...row, score };
  }).filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 12)));
}

export class RagStore {
  constructor(pool, { encryptionKey, maxChunkChars = 12000 } = {}) {
    this.pool = pool;
    this.encryptionKey = encryptionKey;
    if (!this.encryptionKey) throw new Error('RAG encryption key is required');
    this.maxChunkChars = Math.max(1000, Math.min(50000, Number(maxChunkChars) || 12000));
    this.cache = new AdaptiveCache(pool, { encryptionKey, namespace: 'rag-search-v1', ttlSeconds: 45 });
  }

  async index(scope, { sourceType, sourceId, title = '', text: content, metadata = {} } = {}) {
    const body = text(content);
    if (!body) return { chunks: 0 };
    const source = text(sourceId);
    if (!source) throw new Error('RAG sourceId is required');
    const chunks = [];
    for (let i = 0; i < body.length; i += this.maxChunkChars) chunks.push(body.slice(i, i + this.maxChunkChars));

    await this.cache.purge(scope).catch(() => {});
    await this.pool.query(
      'DELETE FROM rag_documents WHERE workspace_id = $1 AND principal_id = $2 AND source_id = $3',
      [scope.workspaceId, scope.principalId, source]
    );

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const chunkTerms = terms(chunk);
      const searchTerms = chunkTerms.map(term => keyedDigest(this.encryptionKey, 'rag-term-v1', term));
      const contentDigest = keyedDigest(this.encryptionKey, 'rag-content-v1', chunk);
      await this.pool.query(
        'INSERT INTO rag_documents (id, workspace_id, principal_id, source_type, source_id, chunk_index, title, content_enc, search_terms, metadata, content_digest) VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)',
        [
          scope.workspaceId, scope.principalId, text(sourceType) || 'unknown', source, index,
          text(title), encryptJson(this.encryptionKey, 'rag-content-v1', { content: chunk }),
          JSON.stringify([...new Set(searchTerms)]), JSON.stringify(metadata), contentDigest
        ]
      );
    }
    return { chunks: chunks.length };
  }

  async search(scope, query, { limit = 8 } = {}) {
    const value = text(query);
    if (!value) return [];
    const cap = Math.max(1, Math.min(30, Number(limit) || 8));
    const cacheFingerprint = keyedDigest(this.encryptionKey, 'rag-query-fingerprint-v1', JSON.stringify(buildRetrievalQuery(value)));
    const cached = await this.cache.get(scope, value, cacheFingerprint).catch(() => null);
    if (Array.isArray(cached)) return cached.slice(0, cap);
    const hashes = terms(value).map(term => keyedDigest(this.encryptionKey, 'rag-term-v1', term));
    if (!hashes.length) return [];

    const { rows } = await this.pool.query(
      "SELECT id, source_type AS \"sourceType\", source_id AS \"sourceId\", chunk_index, title, content_enc, metadata, content_digest FROM rag_documents WHERE workspace_id = $1 AND principal_id = $2 AND search_terms ?| $3::text[] ORDER BY id LIMIT $4",
      [scope.workspaceId, scope.principalId, hashes, Math.min(cap * 4, 120)]
    );

    const decoded = rows.map(row => {
      let content = '';
      try {
        content = decryptField(this.encryptionKey, 'rag-content-v1', row.content_enc);
        const packed = JSON.parse(content);
        content = text(packed?.content);
      } catch {
        content = '';
      }
      return { ...row, content };
    });
    const results = rankLexical(value, decoded, cap)
      .map(({ content_enc, search_terms, ...item }) => item);
    await this.cache.set(scope, value, results, cacheFingerprint).catch(() => {});
    return results;
  }
}
