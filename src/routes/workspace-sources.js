import {
  assertGitHubRepo,
  createSourceId,
  decryptSourceCredentials,
  encryptSourceCredentials,
  githubListRepositories,
  githubListBranches,
  githubReadRepository,
  githubResolveRevision,
  githubApplyChanges,
  normalizeSourceFiles,
  sourceManifest,
  sourcePublic,
  workspaceReviewDigest
} from '../workspace-sources.js';
import crypto from 'node:crypto';
import { workspacePath } from '../workspace-path.js';

const text = value => String(value ?? '').trim();

async function snapshotObject(objects, scope, principal, files, name, provenance) {
  const normalized = normalizeSourceFiles(files);
  return objects.create(scope, principal, {
    name,
    type: 'project',
    contentType: 'application/vnd.kindgleam.workspace+json',
    content: JSON.stringify({ version: 1, files: normalized }),
    provenance
  });
}


async function readSnapshotFiles(objects, scope, objectId) {
  const object = await objects.read(scope, objectId);
  if (!object?.content) return [];
  const raw = Buffer.isBuffer(object.content) ? object.content.toString('utf8') : String(object.content);
  const parsed = JSON.parse(raw);
  return normalizeSourceFiles(parsed?.files ?? []);
}

function contentDigest(content) {
  return crypto.createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex');
}

function effectiveGithubChanges(baseFiles, changes) {
  const base = new Map(normalizeSourceFiles(baseFiles).map(file => [file.path, file.content]));
  const seen = new Set();
  const effective = [];
  for (const change of Array.isArray(changes) ? changes : []) {
    const path = workspacePath(String(change?.path ?? '').trim().replaceAll('\\', '/').replace(/^\.\//, ''));
    if (!path) throw new Error('GitHub change path is invalid');
    if (seen.has(path)) throw new Error('GitHub change set contains duplicate paths: ' + path);
    seen.add(path);

    const isDelete = change?.kind === 'delete' || change?.delete === true;
    if (!isDelete && change?.kind && change.kind !== 'upsert') {
      throw new Error('GitHub write-back accepts only full-file upserts and deletes.');
    }

    const current = base.get(path);
    const expected = text(change?.beforeDigest);
    if (current !== undefined) {
      if (!expected) {
        const error = new Error('A pre-image digest is required for an existing GitHub file: ' + path);
        error.code = 'github-preimage-required';
        throw error;
      }
      if (contentDigest(current) !== expected) {
        const error = new Error('The proposed GitHub change is based on an older workspace file: ' + path);
        error.code = 'stale-github-file';
        throw error;
      }
    } else if (expected) {
      const error = new Error('The proposed GitHub change references a file that is no longer in the workspace snapshot: ' + path);
      error.code = 'stale-github-file';
      throw error;
    }

    if (isDelete) {
      if (current === undefined) continue;
      effective.push({ path, kind: 'delete', beforeDigest: expected });
      continue;
    }

    const content = String(change?.content ?? '');
    if (current === content) continue;
    effective.push({ path, content, ...(current !== undefined ? { beforeDigest: expected } : {}) });
  }
  return effective;
}

export function registerWorkspaceSourcesRoutes(app, {
  pool, objects, audit, config, scoped, route, idempotent, fetchImpl = fetch
}) {
  const encryptionKey = config.security.personalDataEncryptionKey;

  app.get('/api/workspace/sources', scoped('viewer'), route(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT * FROM workspace_sources
         WHERE workspace_id = $1 AND principal_id = $2 AND kind = 'github' AND revoked_at IS NULL
       ORDER BY updated_at DESC, id DESC`,
      [req.scope.workspaceId, req.principal.id]
    );
    res.json({ sources: rows.map(sourcePublic) });
  }));

  app.post('/api/workspace/sources/github', scoped('editor'), idempotent, route(async (req, res) => {
    const token = text(req.body?.token);
    const owner = text(req.body?.owner);
    const repo = text(req.body?.repo);
    if (!token) return res.status(400).json({ error: 'A GitHub credential is required.', code: 'github-credential-required' });
    assertGitHubRepo(owner, repo);
    const read = await githubReadRepository({ fetchImpl, token, owner, repo, ref: text(req.body?.ref) || null, repoPath: text(req.body?.repoPath) || null });
    const manifest = sourceManifest(read.files);
    const object = await snapshotObject(objects, req.scope, req.principal, read.files, `${owner}-${repo}.workspace`, {
      kind: 'github', owner, repo, ref: read.source.ref, repoPath: read.source.repoPath, contentHash: manifest.contentHash, fileCount: manifest.fileCount, ingestion: read.ingestion
    });
    const sourceId = createSourceId();
    const { rows: [row] } = await pool.query(
      `INSERT INTO workspace_sources
        (id, workspace_id, principal_id, kind, name, provider_key, repo_owner, repo_name,
         repo_ref, snapshot_object_id, credentials_enc, permissions, metadata)
       VALUES ($1, $2, $3, 'github', $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
       RETURNING *`,
      [
        sourceId, req.scope.workspaceId, req.principal.id, `${owner}/${repo}`,
        `github:${owner}/${repo}`, owner, repo, read.source.ref, object.id,
        encryptSourceCredentials(encryptionKey, token),
        JSON.stringify({ read: true, write: req.body?.write === true }),
        JSON.stringify({ url: read.source.url, private: read.source.private, commitSha: read.source.commitSha, treeSha: read.source.treeSha, repoPath: read.source.repoPath, contentHash: manifest.contentHash, fileCount: manifest.fileCount, manifest: manifest.files, ingestion: read.ingestion })
      ]
    );
    await audit?.record({
      principalId: req.principal.id, workspaceId: req.scope.workspaceId,
      action: 'workspace.source.connect', target: sourceId, outcome: 'allowed',
      detail: { kind: 'github', owner, repo, ref: read.source.ref, write: req.body?.write === true }, requestId: req.requestId
    });
    res.status(201).json({ source: sourcePublic(row), manifest });
  }));

  app.post('/api/workspace/sources/github/repositories', scoped('viewer'), route(async (req, res) => {
    const token = text(req.body?.token);
    if (!token) return res.status(400).json({ error: 'A GitHub credential is required.', code: 'github-credential-required' });
    const repositories = await githubListRepositories({ fetchImpl, token, page: req.body?.page });
    res.json({
      repositories: (repositories ?? []).map(repo => ({
        id: repo.id,
        fullName: repo.full_name,
        owner: repo.owner?.login ?? '',
        name: repo.name,
        private: repo.private === true,
        defaultBranch: repo.default_branch ?? 'main'
      }))
    });
  }));

  app.post('/api/workspace/sources/github/branches', scoped('viewer'), route(async (req, res) => {
    const token = text(req.body?.token);
    const owner = text(req.body?.owner);
    const repo = text(req.body?.repo);
    if (!token) return res.status(400).json({ error: 'A GitHub credential is required.', code: 'github-credential-required' });
    assertGitHubRepo(owner, repo);
    const branches = await githubListBranches({ fetchImpl, token, owner, repo, page: req.body?.page });
    res.json({ branches: (branches ?? []).map(branch => ({ name: branch.name, protected: branch.protected === true })) });
  }));



  app.post('/api/workspace/sources/:id/sync', scoped('editor'), route(async (req, res) => {
    const { rows: [source] } = await pool.query(
      `SELECT * FROM workspace_sources
         WHERE id = $1 AND workspace_id = $2 AND principal_id = $3 AND revoked_at IS NULL
       FOR UPDATE`,
      [text(req.params.id), req.scope.workspaceId, req.principal.id]
    );
    if (!source) return res.status(404).json({ error: 'Workspace source not found', code: 'no-source' });
    if (source.kind !== 'github') return res.status(404).json({ error: 'Only GitHub repositories are supported as Code Workspace sources.', code: 'github-source-required' });
    const token = decryptSourceCredentials(encryptionKey, source.credentials_enc);
    if (!token) return res.status(409).json({ error: 'GitHub credentials are unavailable. Reconnect the repository.', code: 'source-credentials-missing' });
    const revision = await githubResolveRevision({ fetchImpl, token, owner: source.repo_owner, repo: source.repo_name, ref: source.repo_ref });
    if (source.metadata?.commitSha && revision.sha === source.metadata.commitSha) {
      return res.json({ source: sourcePublic(source), unchanged: true, revision: revision.sha, manifest: { contentHash: source.metadata?.contentHash ?? null, fileCount: source.metadata?.fileCount ?? 0, files: source.metadata?.manifest ?? [] } });
    }
    const read = await githubReadRepository({ fetchImpl, token, owner: source.repo_owner, repo: source.repo_name, ref: source.repo_ref, repoPath: text(source.metadata?.repoPath) || null });
    const manifest = sourceManifest(read.files);
    if (source.metadata?.contentHash === manifest.contentHash) return res.json({ source: sourcePublic(source), unchanged: true, manifest });
    const object = await snapshotObject(objects, req.scope, req.principal, read.files, `${source.name}.workspace`, {
      kind: 'github', sourceId: source.id, owner: source.repo_owner, repo: source.repo_name,
      ref: read.source.ref, contentHash: manifest.contentHash, fileCount: manifest.fileCount
    });
    const { rows: [updated] } = await pool.query(
      `UPDATE workspace_sources SET snapshot_object_id = $4, repo_ref = $5,
          metadata = metadata || $6::jsonb, updated_at = now()
        WHERE id = $1 AND workspace_id = $2 AND principal_id = $3 RETURNING *`,
      [
        source.id, req.scope.workspaceId, req.principal.id, object.id, read.source.ref,
        JSON.stringify({ url: read.source.url, private: read.source.private, commitSha: read.source.commitSha, treeSha: read.source.treeSha, repoPath: read.source.repoPath, contentHash: manifest.contentHash, fileCount: manifest.fileCount, manifest: manifest.files, ingestion: read.ingestion, syncedAt: new Date().toISOString() })
      ]
    );
    res.json({ source: sourcePublic(updated), manifest, unchanged: false });
  }));

  app.post('/api/workspace/sources/:id/review', scoped('editor'), route(async (req, res) => {
    const { rows: [source] } = await pool.query(
      `SELECT * FROM workspace_sources
         WHERE id = $1 AND workspace_id = $2 AND principal_id = $3 AND revoked_at IS NULL
       FOR UPDATE`,
      [text(req.params.id), req.scope.workspaceId, req.principal.id]
    );
    if (!source) return res.status(404).json({ error: 'Workspace source not found', code: 'no-source' });

    const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
    if (!changes.length) return res.status(400).json({ error: 'No changes supplied.', code: 'changes-required' });

    if (source.kind !== 'github') {
      return res.status(404).json({ error: 'Only GitHub repositories are supported as Code Workspace sources.', code: 'github-source-required' });
    }
    const storedCommitSha = text(source.metadata?.commitSha);
    const requestedCommitSha = text(req.body?.expectedCommitSha) || storedCommitSha;
    if (!storedCommitSha || requestedCommitSha !== storedCommitSha) {
      return res.status(409).json({
        error: 'The proposed review is based on a different GitHub revision. Sync the repository first.',
        code: 'stale-github-revision'
      });
    }

    const baseFiles = await readSnapshotFiles(objects, req.scope, source.snapshot_object_id);
    let effective;
    try {
      effective = effectiveGithubChanges(baseFiles, changes);
    } catch (error) {
      if (error?.code === 'github-preimage-required' || error?.code === 'stale-github-file') {
        return res.status(409).json({ error: error.message, code: error.code });
      }
      throw error;
    }

    const base = new Map(baseFiles.map(file => [file.path, file.content]));
    let reviewChars = 0;
    const clip = value => {
      const raw = value === null ? null : String(value);
      const limit = 24_000;
      if (raw === null || raw.length <= limit) return { content: raw, truncated: false };
      const head = Math.floor(limit * 0.75);
      const tail = limit - head;
      return {
        content: raw.slice(0, head) + `\\n…[preview clipped; ${raw.length - limit} characters omitted]…\\n` + raw.slice(-tail),
        truncated: true
      };
    };

    const preview = effective.map(change => {
      const before = base.get(change.path);
      const after = change.kind === 'delete' ? null : String(change.content ?? '');
      const beforePreview = clip(before);
      const afterPreview = clip(after);
      const contribution = (beforePreview.content?.length ?? 0) + (afterPreview.content?.length ?? 0);
      reviewChars += contribution;

      return {
        path: change.path,
        kind: change.kind === 'delete' ? 'deleted' : before === undefined ? 'added' : 'modified',
        before: reviewChars > 240_000
          ? { content: null, truncated: true }
          : beforePreview,
        after: reviewChars > 240_000
          ? { content: null, truncated: true }
          : afterPreview,
        beforeDigest: before === undefined ? null : contentDigest(before),
        afterDigest: after === null ? null : contentDigest(after),
        previewOmitted: reviewChars > 240_000
      };
    });

    const reviewDigest = workspaceReviewDigest(source, effective);

    res.json({
      source: sourcePublic(source),
      review: {
        digest: reviewDigest,
        sourceRevision: source.metadata?.commitSha ?? source.metadata?.contentHash ?? null,
        changes: preview,
        counts: {
          added: preview.filter(item => item.kind === 'added').length,
          modified: preview.filter(item => item.kind === 'modified').length,
          deleted: preview.filter(item => item.kind === 'deleted').length
        }
      }
    });
  }));

  app.post('/api/workspace/sources/:id/apply', scoped('editor'), idempotent, route(async (req, res) => {
    if (req.body?.confirm !== 'APPLY_WORKSPACE_CHANGES') {
      return res.status(400).json({ error: 'Explicit confirmation is required before repository writes.', code: 'write-confirmation-required' });
    }
    const { rows: [source] } = await pool.query(
      `SELECT * FROM workspace_sources
         WHERE id = $1 AND workspace_id = $2 AND principal_id = $3 AND revoked_at IS NULL
       FOR UPDATE`,
      [text(req.params.id), req.scope.workspaceId, req.principal.id]
    );
    if (!source) return res.status(404).json({ error: 'Workspace source not found', code: 'no-source' });
    if (source.kind !== 'github') return res.status(404).json({ error: 'Only GitHub repositories are supported as Code Workspace sources.', code: 'github-source-required' });
    if (source.permissions?.write !== true) return res.status(403).json({ error: 'This GitHub source is read-only. Reconnect it with explicit write permission to enable write-back.', code: 'source-read-only' });
    const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
    if (!changes.length) return res.status(400).json({ error: 'No changes supplied.', code: 'changes-required' });
    const storedCommitSha = text(source.metadata?.commitSha);
    const requestedCommitSha = text(req.body?.expectedCommitSha) || storedCommitSha;
    if (!storedCommitSha || requestedCommitSha !== storedCommitSha) {
      return res.status(409).json({
        error: 'The proposed changes are based on a different GitHub revision. Sync the repository before applying them.',
        code: 'stale-github-revision'
      });
    }
    const token = decryptSourceCredentials(encryptionKey, source.credentials_enc);
    if (!token) return res.status(409).json({ error: 'GitHub credentials are unavailable. Reconnect the repository.', code: 'source-credentials-missing' });
    const baseFiles = await readSnapshotFiles(objects, req.scope, source.snapshot_object_id);
    const effective = effectiveGithubChanges(baseFiles, changes);
    const reviewDigest = workspaceReviewDigest(source, effective);
    if (text(req.body?.reviewDigest) !== reviewDigest) {
      return res.status(409).json({
        error: 'A fresh server review is required before these exact changes can be applied.',
        code: 'review-required',
        reviewDigest
      });
    }
    if (!effective.length) return res.json({ source: sourcePublic(source), unchanged: true, result: { unchanged: true, commitSha: storedCommitSha, ref: source.repo_ref, changedFiles: [] } });
    const result = await githubApplyChanges({
      fetchImpl, token,
      owner: source.repo_owner,
      repo: source.repo_name,
      ref: source.repo_ref,
      repoPath: text(source.metadata?.repoPath) || null,
      expectedCommitSha: storedCommitSha,
      changes: effective,
      message: text(req.body?.message) || 'workspace: apply reviewed changes'
    });
    const confirmedHead = await githubResolveRevision({
      fetchImpl,
      token,
      owner: source.repo_owner,
      repo: source.repo_name,
      ref: source.repo_ref
    });
    if (confirmedHead.sha !== result.commitSha) {
      return res.status(409).json({
        error: 'The repository moved after the workspace write. Sync and review the changes again.',
        code: 'write-back-head-changed',
        commitSha: result.commitSha,
        currentCommitSha: confirmedHead.sha
      });
    }
    const baseMap = new Map(baseFiles.map(file => [file.path, file.content]));
    for (const change of effective) {
      const path = workspacePath(String(change?.path ?? '').trim().replaceAll('\\', '/').replace(/^\.\//, ''));
      if (!path) continue;
      if (change?.kind === 'delete' || change?.delete === true) baseMap.delete(path);
      else baseMap.set(path, String(change?.content ?? ''));
    }
    const refreshedFiles = normalizeSourceFiles([...baseMap].map(([path, content]) => ({ path, content })));
    const refreshedManifest = sourceManifest(refreshedFiles);
    const refreshedObject = await snapshotObject(objects, req.scope, req.principal, refreshedFiles, `${source.name}.workspace`, {
      kind: 'github', sourceId: source.id, owner: source.repo_owner, repo: source.repo_name,
      ref: result.ref, commitSha: result.commitSha, contentHash: refreshedManifest.contentHash, fileCount: refreshedManifest.fileCount
    });
    const { rows: [updated] } = await pool.query(
      `UPDATE workspace_sources
          SET repo_ref = $4,
              snapshot_object_id = $5,
              metadata = metadata || $6::jsonb,
              updated_at = now()
        WHERE id = $1 AND workspace_id = $2 AND principal_id = $3
        RETURNING *`,
      [
        source.id, req.scope.workspaceId, req.principal.id, result.ref, refreshedObject.id,
        JSON.stringify({
          commitSha: result.commitSha, treeSha: result.treeSha, staleSnapshot: false,
          contentHash: refreshedManifest.contentHash, fileCount: refreshedManifest.fileCount,
          manifest: refreshedManifest.files, writeAt: new Date().toISOString()
        })
      ]
    );
    await audit?.record({
      principalId: req.principal.id, workspaceId: req.scope.workspaceId,
      action: 'workspace.source.write', target: source.id, outcome: 'allowed',
      detail: { kind: 'github', ref: source.repo_ref, changedFiles: result.changedFiles ?? [], commitSha: result.commitSha },
      requestId: req.requestId
    });
    res.json({ source: sourcePublic(updated), result });
  }));

  app.post('/api/workspace/sources/:id/revoke', scoped('editor'), route(async (req, res) => {
    const { rows: [row] } = await pool.query(
      `UPDATE workspace_sources
          SET revoked_at = now(), credentials_enc = NULL, updated_at = now()
        WHERE id = $1 AND workspace_id = $2 AND principal_id = $3
        RETURNING *`,
      [text(req.params.id), req.scope.workspaceId, req.principal.id]
    );
    if (!row) return res.status(404).json({ error: 'Workspace source not found', code: 'no-source' });
    await audit?.record({
      principalId: req.principal.id, workspaceId: req.scope.workspaceId,
      action: 'workspace.source.revoke', target: row.id, outcome: 'allowed', requestId: req.requestId
    });
    res.json({ source: sourcePublic(row) });
  }));
}
