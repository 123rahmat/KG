/**
 * Two-layer memory:
 *   - Every chat has its own memory, always on, bound to conversation_id.
 *   - Cross-chat memory is optional and user-controlled.
 *
 * Memory never crosses workspace/person boundaries. Secrets and sensitive
 * personal details are never kept.
 */

import crypto from 'node:crypto';
import { registerTools } from './toolbox.js';
import { encryptJson, decryptField, keyedDigest } from './data-protection.js';

const text = value => String(value ?? '').trim();
export const MEMORY_KINDS = Object.freeze(['about', 'preference', 'project', 'fact', 'episodic', 'semantic']);
export const MAX_MEMORY_CHARS = 500;
export const MAX_MEMORIES = 300;
const RECALL_LIMIT = 15;

const SECRET = [
  /\b(?:\d[ -]?){13,19}\b/, // card numbers
  /\b(?:password|passcode|pin code|passwd|api[ _-]?key|secret key|private key|access token|seed phrase|recovery phrase|otp|cvv)\b/i,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/,
  /\b(?:ghp|gho|github_pat|xox[bpas]|AKIA)[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
];

// Special categories of personal data are not remembered: religion and
// belief (never discussed here), and sexuality, health conditions and politics.
const SENSITIVE = /\b(?:religio\w*|faith|muslim|christian|catholic|protestant|hindu|jewish|jew|sikh|buddhist|jain|atheist|agnostic|sunni|shia|ahmadi|mosque|church|temple|synagogue|pray\w*|sexual orientation|gay|lesbian|bisexual|transgender|hiv|diagnos\w* with|political part(?:y|ies)|votes? for)\b/i;

export class MemoryError extends Error {
  constructor(message, { status = 400, code = 'memory-invalid' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const normalized = value => text(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const STOP = new Set('a an the and or but of to in on at for with by from is are was were be been am i me my we our you your it its this that these those do does did have has had can could should would will what how why when where which who whom please about into than then so as if not no yes'.split(' '));
const terms = value => new Set(normalized(value).split(' ').filter(word => word.length > 2 && !STOP.has(word)));

const decode = (row, encryptionKey) => {
  const raw = decryptField(encryptionKey, 'memory-content-v1', row.content_enc);
  try {
    const packed = JSON.parse(raw);
    if (packed && typeof packed === 'object' && typeof packed.content === 'string') {
      return { ...row, content: packed.content, normalized: packed.normalized || normalized(packed.content) };
    }
  } catch {}
  // Legacy encrypted rows held only the content string. Its normalized lookup
  // value can be reconstructed exactly from the same normalization function.
  return { ...row, content: raw, normalized: normalized(raw) };
};
const shape = (row, encryptionKey) => {
  const decoded = row?.content_enc ? decode(row, encryptionKey) : row;
  return {
  id: decoded.id, content: decoded.content, kind: decoded.kind,
  sourceRunId: row.source_run_id ?? null,
  conversationId: row.conversation_id ?? null,
  projectId: row.project_id ?? null,
  createdAt: decoded.created_at, updatedAt: decoded.updated_at, lastUsedAt: decoded.last_used_at ?? null
  };
};

export class MemoryStore {
  constructor(pool, { encryptionKey = null } = {}) {
    this.pool = pool;
    this.encryptionKey = encryptionKey;
    if (!this.encryptionKey) throw new Error('PERSONAL_DATA_ENCRYPTION_KEY is required for memory storage');
  }

  /** Cross-chat recall is off by default. Chat-local memory is never disabled. */
  async crossChatEnabled(principalId) {
    if (!principalId) return false;
    const { rows: [row] } = await this.pool.query(
      "SELECT settings->'crossChatMemory' AS enabled FROM user_preferences WHERE principal_id = $1",
      [principalId]
    ).catch(() => ({ rows: [] }));
    return row?.enabled === true;
  }

  /** Settings manages explicitly saved cross-chat memories. */
  async list(scope, { limit = MAX_MEMORIES } = {}) {
    const { rows } = await this.pool.query(
      `SELECT * FROM memories
        WHERE workspace_id = $1 AND principal_id = $2 AND conversation_id IS NULL
        ORDER BY updated_at DESC LIMIT $3`,
      [scope.workspaceId, scope.principalId, Math.min(MAX_MEMORIES, Math.max(1, limit))]
    );
    return rows.map(row => shape(row, this.encryptionKey));
  }

  /** Automatic memories are bound to the current chat. */
  async add(scope, { content, kind = 'fact', sourceRunId = null, conversationId = null, projectId = null }) {
    const value = text(content).replace(/\s+/g, ' ');
    if (!value) throw new MemoryError('Say what to remember.');
    if (value.length > MAX_MEMORY_CHARS) throw new MemoryError(`A memory is at most ${MAX_MEMORY_CHARS} characters.`);
    if (SECRET.some(pattern => pattern.test(value))) {
      throw new MemoryError('Passwords, keys, codes and card numbers are never kept in memory.', { code: 'memory-secret' });
    }
    if (SENSITIVE.test(value)) {
      throw new MemoryError('Religion, beliefs and other sensitive personal details are not kept in memory.', { code: 'memory-sensitive' });
    }
    const type = MEMORY_KINDS.includes(kind) ? kind : 'fact';
    const conversation = text(conversationId);
    const project = text(projectId);
    if (conversation && !/^[A-Za-z0-9-]{8,64}$/.test(conversation)) {
      throw new MemoryError('Invalid conversation memory scope.', { status: 400, code: 'invalid-conversation' });
    }
    if (project && !/^[A-Za-z0-9-]{8,64}$/.test(project)) {
      throw new MemoryError('Invalid project memory scope.', { status: 400, code: 'invalid-project' });
    }
    const key = normalized(value);
    const digest = keyedDigest(this.encryptionKey, 'memory-lookup-v1', key);
    const { rows: [same] } = await this.pool.query(
      `SELECT * FROM memories
        WHERE workspace_id = $1 AND principal_id = $2
          AND COALESCE(project_id, '') = COALESCE($3, '')
          AND COALESCE(conversation_id, '') = COALESCE($4, '')
          AND normalized_digest = $5`,
      [scope.workspaceId, scope.principalId, project || null, conversation || null, digest]
    );
    if (same) {
      const { rows: [row] } = await this.pool.query(
        'UPDATE memories SET updated_at = now() WHERE id = $1 RETURNING *', [same.id]
      );
      return { memory: shape(row, this.encryptionKey), created: false };
    }
    const { rows: [row] } = await this.pool.query(
      `INSERT INTO memories
        (id, workspace_id, principal_id, content, normalized, content_enc, normalized_digest, encryption_version, kind, source_run_id, project_id, conversation_id)
       VALUES ($1, $2, $3, '', '', $4, $5, 1, $6, $7, $8, $9) RETURNING *`,
      [
        crypto.randomUUID(), scope.workspaceId, scope.principalId,
        encryptJson(this.encryptionKey, 'memory-content-v1', { content: value, normalized: key }),
        keyedDigest(this.encryptionKey, 'memory-lookup-v1', key),
        type, sourceRunId, project || null, conversation || null
      ]
    );
    // Memory capacity is per chat, or per explicit cross-chat scope;
    // one chat can never evict another chat's private memory.
    const scopeClause = conversation
      ? 'AND project_id = $3 AND conversation_id = $4'
      : project
        ? 'AND project_id = $3 AND conversation_id IS NULL'
        : 'AND project_id IS NULL AND conversation_id IS NULL';
    const params = conversation
      ? [scope.workspaceId, scope.principalId, project, conversation, MAX_MEMORIES]
      : project
        ? [scope.workspaceId, scope.principalId, project, MAX_MEMORIES]
        : [scope.workspaceId, scope.principalId, MAX_MEMORIES];
    await this.pool.query(
      `DELETE FROM memories WHERE id IN (
         SELECT id FROM memories
          WHERE workspace_id = $1 AND principal_id = $2 ${scopeClause}
          ORDER BY COALESCE(last_used_at, updated_at) DESC OFFSET ${conversation ? 5 : project ? 4 : 3})`,
      params
    );
    return { memory: shape(row, this.encryptionKey), created: true };
  }

  async forget(scope, id) {
    const { rows } = await this.pool.query(
      'DELETE FROM memories WHERE id = $1 AND workspace_id = $2 AND principal_id = $3 RETURNING id',
      [text(id), scope.workspaceId, scope.principalId]
    );
    return rows.length;
  }

  /** Forget the memories that mention every meaningful word of `about`. */
  async forgetMatching(scope, about, { conversationId = null, projectId = null, crossChat = false } = {}) {
    const wanted = terms(about);
    if (!wanted.size) return [];
    const id = text(conversationId);
    const project = text(projectId);
    const rows = crossChat
      ? (await this.pool.query(
          `SELECT * FROM memories
             WHERE workspace_id = $1 AND principal_id = $2
             ORDER BY updated_at DESC LIMIT $3`,
          [scope.workspaceId, scope.principalId, MAX_MEMORIES]
        )).rows
      : id
        ? (await this.pool.query(
            `SELECT * FROM memories
               WHERE workspace_id = $1 AND principal_id = $2 AND project_id = $3 AND conversation_id = $4
               ORDER BY updated_at DESC LIMIT $5`,
            [scope.workspaceId, scope.principalId, project || null, id, MAX_MEMORIES]
          )).rows
        : [];
    const matches = rows.map(row => shape(row, this.encryptionKey)).filter(memory => {
      const have = terms(memory.content);
      return [...wanted].every(word => have.has(word));
    });
    if (matches.length) {
      await this.pool.query(
        'DELETE FROM memories WHERE id = ANY($1::text[]) AND workspace_id = $2 AND principal_id = $3',
        [matches.map(memory => memory.id), scope.workspaceId, scope.principalId]
      );
    }
    return matches;
  }

  /** "Forget everything": every memory of this person here, whichever chat it belongs to. */
  async clear(scope) {
    const { rowCount } = await this.pool.query(
      'DELETE FROM memories WHERE workspace_id = $1 AND principal_id = $2',
      [scope.workspaceId, scope.principalId]
    );
    return rowCount;
  }

  async clearConversation(scope, conversationId, projectId = null) {
    const id = text(conversationId);
    if (!id) return 0;
    const { rowCount } = await this.pool.query(
      'DELETE FROM memories WHERE workspace_id = $1 AND principal_id = $2 AND conversation_id = $3 AND ($4::text IS NULL OR project_id = $4)',
      [scope.workspaceId, scope.principalId, id, text(projectId) || null]
    );
    return rowCount;
  }

  /**
   * The memories that matter for this goal: who the person is and how they
   * like answers always; other memories when they share words with the goal,
   * then the most recent.
   */
  async recall(scope, goal, { conversationId = null, projectId = null, crossChat = false, limit = RECALL_LIMIT } = {}) {
    const id = text(conversationId);
    const project = text(projectId);
    const local = id
      ? (await this.pool.query(
          `SELECT * FROM memories
             WHERE workspace_id = $1 AND principal_id = $2
               AND conversation_id = $3
               AND ($4::text IS NULL OR project_id = $4)
             ORDER BY updated_at DESC LIMIT $5`,
          [scope.workspaceId, scope.principalId, id, project || null, MAX_MEMORIES]
        )).rows.map(row => shape(row, this.encryptionKey))
      : [];
    // This chat's own memories always come first; other chats add to them
    // and can never push them out.
    const all = crossChat
      ? [...local, ...(await this.pool.query(
          `SELECT * FROM memories
             WHERE workspace_id = $1 AND principal_id = $2
               AND ($3::text IS NULL OR conversation_id IS DISTINCT FROM $3)
               AND ($4::text IS NULL OR project_id = $4)
             ORDER BY updated_at DESC LIMIT $4`,
          [scope.workspaceId, scope.principalId, id || null, project || null, MAX_MEMORIES]
        )).rows.map(row => shape(row, this.encryptionKey))]
      : local;
    if (!all.length) return [];
    const wanted = terms(goal);
    const scored = all.map((memory, index) => {
      const have = terms(memory.content);
      const overlap = [...wanted].filter(word => have.has(word)).length;
      const standing = memory.kind === 'about' || memory.kind === 'preference' ? 2 : 0;
      return { memory, score: overlap * 3 + standing - index / all.length };
    }).sort((a, b) => b.score - a.score);
    const chosen = scored.slice(0, limit).map(item => item.memory);
    await this.pool.query(
      'UPDATE memories SET last_used_at = now() WHERE id = ANY($1::text[])',
      [chosen.map(memory => memory.id)]
    ).catch(() => {});
    return chosen.map(memory => ({ id: memory.id, kind: memory.kind, content: memory.content }));
  }
}

/** The chat a run's memory belongs to: its conversation, or the run itself for a one-off. */
export const chatScope = run => text(run?.conversationId ?? run?.conversation_id ?? run?.id) || null;

/** Memory available to a chat: local memory always; other chats only with the optional switch. */
export async function memoriesFor(memories, scope, run) {
  if (!memories || !scope?.workspaceId || !scope.principalId) return [];
  if (run?.principalId && run.principalId !== scope.principalId) return [];
  const conversationId = chatScope(run);
  const crossChat = await memories.crossChatEnabled(scope.principalId);
  return memories.recall(
    scope,
    [run?.goal, ...(run?.adaptation?.conversation ?? []).slice(-2).map(turn => turn.user)].join(' '),
    { conversationId, projectId: run?.projectId ?? run?.project_id ?? null, crossChat }
  );
}

const memoryReady = ctx => (ctx.memories && ctx.run?.principalId === ctx.scope?.principalId && chatScope(ctx.run)
  ? { ready: true }
  : { ready: false, needs: 'memory', reason: 'This chat does not have a valid conversation scope.' });

registerTools([
  {
    name: 'memory.save',
    title: 'Remember',
    description: 'Remember something lasting the person told you. It is kept in this chat by default; cross-chat memory can make it available in other chats when the person enables it. Never passwords, keys, card numbers, sensitive personal details, or anything they asked not to keep.',
    input: { fact: 'one short sentence', kind: `${MEMORY_KINDS.join(' | ')}` },
    ready: memoryReady,
    async run(input, ctx) {
      try {
        const { memory, created } = await ctx.memories.add(ctx.scope, {
          content: input.fact,
          kind: input.kind,
          sourceRunId: ctx.run?.id ?? null,
          conversationId: chatScope(ctx.run),
          projectId: ctx.run?.projectId ?? ctx.run?.project_id ?? null
        });
        return { remembered: memory.content, created, scope: memory.conversationId ? 'this-chat' : 'cross-chat' };
      } catch (error) {
        if (error instanceof MemoryError) return { error: error.message };
        throw error;
      }
    }
  },
  {
    name: 'memory.forget',
    title: 'Forget',
    description: 'Forget what the person asks you to forget. Give the words it mentions, e.g. "Lahore" or "site engineer".',
    input: { about: 'words the memory mentions' },
    ready: memoryReady,
    async run(input, ctx) {
      const crossChat = await ctx.memories.crossChatEnabled(ctx.scope.principalId);
      const conversationId = chatScope(ctx.run);
      const removed = await ctx.memories.forgetMatching(ctx.scope, input.about, { conversationId, crossChat });
      return removed.length
        ? { forgot: removed.map(memory => memory.content) }
        : { forgot: [], note: 'Nothing in memory matched those words.' };
    }
  }
]);
