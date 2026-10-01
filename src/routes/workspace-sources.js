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
  sourcePublic
} from '../workspace-sources.js';

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

function mergeSourceDelta(baseFiles, changedFiles, deletedPaths) {
  const map = new Map(normalizeSourceFiles(baseFiles).map(file => [file.path, file.content]));
  for (const path of Array.isArray(deletedPaths) ? deletedPaths : []) {
    const safe = String(path ?? '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
    if (safe) map.delete(safe);
  }
  for (const file of normalizeSourceFiles(changedFiles)) map.set(file.path, file.content);
  return normalizeSourceFiles([...map].map(([path, content]) => ({ path, content })));
}

export function registerWorkspaceSourcesRoutes(app, {
  pool, objects, audit, config, scoped, route, idempotent, fetchImpl = fetch
}) {
  const encryptionKey = config.security.personalDataEncryptionKey;

  app.get('/api/workspace/sources', scoped('viewer'), route(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT * FROM workspace_sources
         WHERE workspace_id = $1 AND principal_id = $2 AND revoked_at IS NULL
       ORDER BY updated_at DESC, id DESC`,
      [req.scope.workspaceId, req.principal.id]
    );
    res.json({ sources: rows.map(sourcePublic) });
  }));

  app.post('/api/workspace/sources/local', scoped('editor'), idempotent, route(async (req, res) => {
    const files = normalizeSourceFiles(req.body?.files);
    if (!files.length) return res.status(400).json({ error: 'Choose at least one local file.', code: 'local-files-required' });
    const manifest = sourceManifest(files);
    const sourceId = createSourceId();
    const name = text(req.body?.name) || 'Local folder';
    const object = await snapshotObject(objects, req.scope, req.principal, files, `${name}.workspace`, {
      kind: 'local-folder', contentHash: manifest.contentHash, fileCount: manifest.fileCount
    });
    const { rows: [row] } = await pool.query(
      `INSERT INTO workspace_sources
        (id, workspace_id, principal_id, kind, name, provider_key, snapshot_object_id, permissions, metadata)
       VALUES ($1, $2, $3, 'local-folder', $4, $5, $6, $7::jsonb, $8::jsonb)
       RETURNING *`,
      [
        sourceId, req.scope.workspaceId, req.principal.id, name,
        `local:${manifest.contentHash.slice(0, 20)}`, object.id,
        JSON.stringify({ read: true, write: req.body?.write !== false, source: 'browser-folder-permission' }),
        JSON.stringify({ contentHash: manifest.contentHash, fileCount: manifest.fileCount, manifest: manifest.files, browserGranted: true })
      ]
    );
    await audit?.record({
      principalId: req.principal.id, workspaceId: req.scope.workspaceId,
      action: 'workspace.source.connect', target: sourceId, outcome: 'allowed',
      detail: { kind: 'local-folder', fileCount: manifest.fileCount }, requestId: req.requestId
    });
    res.status(201).json({ source: sourcePublic(row), manifest });
  }));

  app.post('/api/workspace/sources/local/:id/sync', scoped('editor'), route(async (req, res) => {
    const { rows: [source] } = await pool.query(
      `SELECT * FROM workspace_sources
         WHERE id = $1 AND workspace_id = $2 AND principal_id = $3
           AND kind = 'local-folder' AND revoked_at IS NULL
       FOR UPDATE`,
      [text(req.params.id), req.scope.workspaceId, req.principal.id]
    );
    if (!source) return res.status(404).json({ error: 'Local folder source not found', code: 'no-source' });
    let files;
    if (Array.isArray(req.body?.changedFiles) && req.body?.manifest) {
      const baseFiles = await readSnapshotFiles(objects, req.scope, source.snapshot_object_id);
      files = mergeSourceDelta(baseFiles, req.body.changedFiles, req.body.deletedPaths);
    } else {
      files = normalizeSourceFiles(req.body?.files);
    }
    const manifest = sourceManifest(files);
    if (source.metadata?.contentHash === manifest.contentHash) return res.json({ source: sourcePublic(source), unchanged: true, manifest });
    const object = await snapshotObject(objects, req.scope, req.principal, files, `${source.name}.workspace`, {
      kind: 'local-folder', sourceId: source.id, contentHash: manifest.contentHash, fileCount: manifest.fileCount
    });
    const { rows: [updated] } = await pool.query(
      `UPDATE workspace_sources
          SET snapshot_object_id = $4,
              metadata = metadata || $5::jsonb, updated_at = now()
        WHERE id = $1 AND workspace_id = $2 AND principal_id = $3
        RETURNING *`,
      [
        source.id, req.scope.workspaceId, req.principal.id, object.id,
        JSON.stringify({ contentHash: manifest.contentHash, fileCount: manifest.fileCount, manifest: manifest.files, syncedAt: new Date().toISOString() })
      ]
    );
    res.json({ source: sourcePublic(updated), manifest, unchanged: false });
  }));

  app.post('/api/workspace/sources/github', scoped('editor'), idempotent, route(async (req, res) => {
    const token = text(req.body?.token);
    const owner = text(req.body?.owner);
    const repo = text(req.body?.repo);
    if (!token) return res.status(400).json({ error: 'A GitHub credential is required.', code: 'github-credential-required' });
    assertGitHubRepo(owner, repo);
    const read = await githubReadRepository({ fetchImpl, token, owner, repo, ref: text(req.body?.ref) || null });
    const manifest = sourceManifest(read.files);
    const object = await snapshotObject(objects, req.scope, req.principal, read.files, `${owner}-${repo}.workspace`, {
      kind: 'github', owner, repo, ref: read.source.ref, contentHash: manifest.contentHash, fileCount: manifest.fileCount
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
        JSON.stringify({ url: read.source.url, private: read.source.private, commitSha: read.source.commitSha, treeSha: read.source.treeSha, contentHash: manifest.contentHash, fileCount: manifest.fileCount, manifest: manifest.files })
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
    if (source.kind !== 'github') return res.status(400).json({ error: 'Use the local folder sync endpoint.', code: 'wrong-source-kind' });
    const token = decryptSourceCredentials(encryptionKey, source.credentials_enc);
    if (!token) return res.status(409).json({ error: 'GitHub credentials are unavailable. Reconnect the repository.', code: 'source-credentials-missing' });
    const revision = await githubResolveRevision({ fetchImpl, token, owner: source.repo_owner, repo: source.repo_name, ref: source.repo_ref });
    if (source.metadata?.commitSha && revision.sha === source.metadata.commitSha) {
      return res.json({ source: sourcePublic(source), unchanged: true, revision: revision.sha, manifest: { contentHash: source.metadata?.contentHash ?? null, fileCount: source.metadata?.fileCount ?? 0, files: source.metadata?.manifest ?? [] } });
    }
    const read = await githubReadRepository({ fetchImpl, token, owner: source.repo_owner, repo: source.repo_name, ref: source.repo_ref });
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
        JSON.stringify({ url: read.source.url, private: read.source.private, commitSha: read.source.commitSha, treeSha: read.source.treeSha, contentHash: manifest.contentHash, fileCount: manifest.fileCount, manifest: manifest.files, syncedAt: new Date().toISOString() })
      ]
    );
    res.json({ source: sourcePublic(updated), manifest, unchanged: false });
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
    if (source.kind !== 'github') return res.status(400).json({ error: 'Local folder changes are written by the browser after explicit approval.', code: 'local-write-client-side' });
    if (source.permissions?.write !== true) return res.status(403).json({ error: 'This GitHub source is read-only. Reconnect it with explicit write permission to enable write-back.', code: 'source-read-only' });
    const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
    if (!changes.length) return res.status(400).json({ error: 'No changes supplied.', code: 'changes-required' });
    const token = decryptSourceCredentials(encryptionKey, source.credentials_enc);
    if (!token) return res.status(409).json({ error: 'GitHub credentials are unavailable. Reconnect the repository.', code: 'source-credentials-missing' });
    const result = await githubApplyChanges({
      fetchImpl, token,
      owner: source.repo_owner,
      repo: source.repo_name,
      ref: source.repo_ref,
      expectedCommitSha: text(req.body?.expectedCommitSha) || text(source.metadata?.commitSha),
      changes,
      message: text(req.body?.message) || 'workspace: apply reviewed changes'
    });
    const { rows: [updated] } = await pool.query(
      `UPDATE workspace_sources
          SET repo_ref = $4,
              metadata = metadata || $5::jsonb,
              updated_at = now()
        WHERE id = $1 AND workspace_id = $2 AND principal_id = $3
        RETURNING *`,
      [
        source.id, req.scope.workspaceId, req.principal.id, result.ref,
        JSON.stringify({ commitSha: result.commitSha, staleSnapshot: true, writeAt: new Date().toISOString() })
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
