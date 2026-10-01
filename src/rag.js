/**
 * Retrieval-Augmented Generation storage and retrieval.
 * Provider-neutral: deterministic lexical retrieval works without extensions;
 * an injected embedder enables vector retrieval when pgvector is available.
 */
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
    const value = text(row.text || row.content || row.title);
    const have = new Set(terms(value));
    const score = [...wanted].reduce((sum, term) => sum + (have.has(term) ? 1 : 0), 0);
    return { ...row, score };
  }).filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 12)));
}

export class RagStore {
  constructor(pool, { embedder = null, maxChunkChars = 12000 } = {}) {
    this.pool = pool;
    this.embedder = typeof embedder === 'function' ? embedder : null;
    this.maxChunkChars = maxChunkChars;
  }

  async index(scope, { sourceType, sourceId, title = '', text: content, metadata = {} } = {}) {
    const body = text(content);
    if (!body) return { chunks: 0 };
    const chunks = [];
    for (let i = 0; i < body.length; i += this.maxChunkChars) chunks.push(body.slice(i, i + this.maxChunkChars));

    await this.pool.query('DELETE FROM rag_documents WHERE workspace_id = $1 AND source_id = $2',
      [scope.workspaceId, text(sourceId)]);

    for (let index = 0; index < chunks.length; index += 1) {
      let embedding = null;
      if (this.embedder) {
        try { embedding = await this.embedder(chunks[index]); } catch { embedding = null; }
      }
      await this.pool.query(
        'INSERT INTO rag_documents (id, workspace_id, principal_id, source_type, source_id, chunk_index, title, content, metadata, embedding) VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)',
        [scope.workspaceId, scope.principalId, text(sourceType) || 'unknown', text(sourceId), index, text(title), chunks[index], JSON.stringify(metadata), embedding]
      );
    }
    return { chunks: chunks.length };
  }

  async search(scope, query, { limit = 8 } = {}) {
    const value = text(query);
    if (!value) return [];
    const cap = Math.max(1, Math.min(30, Number(limit) || 8));

    if (this.embedder) {
      try {
        const vector = await this.embedder(value);
        const { rows } = await this.pool.query(
          'SELECT id, source_type AS "sourceType", source_id AS "sourceId", title, content, metadata, 1 - (embedding <=> $3::vector) AS score FROM rag_documents WHERE workspace_id = $1 AND principal_id = $2 AND embedding IS NOT NULL ORDER BY embedding <=> $3::vector LIMIT $4',
          [scope.workspaceId, scope.principalId, JSON.stringify(vector), cap]
        );
        return rows;
      } catch {
        // Optional pgvector/embedding path; use lexical fallback below.
      }
    }

    const { rows } = await this.pool.query(
      "SELECT id, source_type AS \"sourceType\", source_id AS \"sourceId\", title, content, metadata FROM rag_documents WHERE workspace_id = $1 AND principal_id = $2 AND to_tsvector('simple', coalesce(title,'') || ' ' || content) @@ plainto_tsquery('simple', $3) ORDER BY ts_rank_cd(to_tsvector('simple', coalesce(title,'') || ' ' || content), plainto_tsquery('simple', $3)) DESC, id LIMIT $4",
      [scope.workspaceId, scope.principalId, value.slice(0, 1000), cap]
    );
    return rows;
  }
}
