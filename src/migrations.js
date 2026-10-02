/**
 * The database schema, as an ordered list of migrations.
 *
 * Every migration ever written, in order. Never edit one that has shipped:
 * add a new one. `migrate()` in db.js applies pending ones by version.
 */

export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial-schema',
    sql: `
      CREATE TABLE workspaces (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        max_bytes     BIGINT NOT NULL,
        max_objects   BIGINT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        archived_at   TIMESTAMPTZ
      );

      CREATE TABLE principals (
        id            TEXT PRIMARY KEY,
        kind          TEXT NOT NULL CHECK (kind IN ('user', 'service')),
        name          TEXT NOT NULL,
        email         TEXT UNIQUE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        disabled_at   TIMESTAMPTZ
      );

      -- Only the SHA-256 of the key's secret half is stored. A database dump
      -- therefore cannot be replayed as credentials.
      CREATE TABLE api_keys (
        id            TEXT PRIMARY KEY,
        principal_id  TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        secret_hash   TEXT NOT NULL,
        name          TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at  TIMESTAMPTZ,
        expires_at    TIMESTAMPTZ,
        revoked_at    TIMESTAMPTZ
      );
      CREATE INDEX api_keys_principal_idx ON api_keys(principal_id);

      CREATE TABLE memberships (
        workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id  TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        role          TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, principal_id)
      );
      CREATE INDEX memberships_principal_idx ON memberships(principal_id);

      -- Content is referenced by a workspace-scoped keyed digest and is
      -- reference-counted. Cross-workspace content is intentionally not
      -- deduplicated, so one tenant cannot infer another tenant's content identity.
      CREATE TABLE blobs (
        digest        TEXT PRIMARY KEY,
        bytes         BYTEA NOT NULL,
        size          BIGINT NOT NULL,
        ref_count     BIGINT NOT NULL DEFAULT 0 CHECK (ref_count >= 0),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE objects (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        owner_id      TEXT NOT NULL REFERENCES principals(id),
        type          TEXT NOT NULL,
        name          TEXT,
        content_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
        size          BIGINT NOT NULL,
        digest        TEXT NOT NULL REFERENCES blobs(digest),
        version       INTEGER NOT NULL DEFAULT 1,
        lifecycle     TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'archived')),
        provenance    JSONB,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX objects_scope_idx ON objects(workspace_id, lifecycle, created_at DESC, id DESC);
      CREATE INDEX objects_digest_idx ON objects(digest);

      -- A run is the server's copy of a workflow. The client never holds the
      -- authoritative state, so it cannot report work that did not happen.
      CREATE TABLE runs (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id  TEXT NOT NULL REFERENCES principals(id),
        goal          TEXT NOT NULL,
        surface       TEXT NOT NULL,
        state         TEXT NOT NULL,
        intent        JSONB NOT NULL,
        capabilities  JSONB NOT NULL,
        governance    JSONB NOT NULL,
        attempt       INTEGER NOT NULL DEFAULT 1,
        max_attempts  INTEGER NOT NULL,
        tokens_used   BIGINT NOT NULL DEFAULT 0,
        max_tokens    BIGINT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at  TIMESTAMPTZ
      );
      CREATE INDEX runs_scope_idx ON runs(workspace_id, created_at DESC, id DESC);

      CREATE TABLE run_tasks (
        run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        id            TEXT NOT NULL,
        position      INTEGER NOT NULL,
        type          TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'running', 'complete', 'failed', 'skipped')),
        depends_on    JSONB NOT NULL,
        requires      JSONB NOT NULL,
        purpose       TEXT NOT NULL,
        summary       TEXT,
        evidence      JSONB,
        started_at    TIMESTAMPTZ,
        completed_at  TIMESTAMPTZ,
        PRIMARY KEY (run_id, id)
      );

      -- Append-only. Nothing in the application issues UPDATE or DELETE here.
      CREATE TABLE audit_log (
        id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        principal_id  TEXT,
        workspace_id  TEXT,
        action        TEXT NOT NULL,
        target        TEXT,
        outcome       TEXT NOT NULL,
        detail        JSONB,
        request_id    TEXT,
        ip            TEXT
      );
      CREATE INDEX audit_log_scope_idx ON audit_log(workspace_id, at DESC);
      CREATE INDEX audit_log_principal_idx ON audit_log(principal_id, at DESC);

      -- Lets a client retry a POST after a timeout without doing the work twice.
      CREATE TABLE idempotency_keys (
        key           TEXT NOT NULL,
        principal_id  TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        request_hash  TEXT NOT NULL,
        status_code   INTEGER NOT NULL,
        response      JSONB NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (key, principal_id)
      );
      CREATE INDEX idempotency_created_idx ON idempotency_keys(created_at);

      CREATE TABLE sessions (
        id            TEXT PRIMARY KEY,
        principal_id  TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at    TIMESTAMPTZ NOT NULL,
        revoked_at    TIMESTAMPTZ
      );
      CREATE INDEX sessions_principal_idx ON sessions(principal_id);
      CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
    `
  },
  {
    version: 2,
    name: 'unified-individual-enterprise-governance',
    sql: `
      CREATE TABLE organizations (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        type          TEXT NOT NULL CHECK (type IN ('personal', 'enterprise')),
        settings      JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      ALTER TABLE workspaces
        ADD COLUMN IF NOT EXISTS organization_id TEXT REFERENCES organizations(id),
        ADD COLUMN IF NOT EXISTS jurisdiction TEXT;

      ALTER TABLE runs
        ADD COLUMN IF NOT EXISTS adaptation JSONB NOT NULL DEFAULT '{}'::jsonb;

      INSERT INTO organizations (id, name, type)
      SELECT w.id, w.name, 'personal'
        FROM workspaces w
       WHERE NOT EXISTS (
         SELECT 1 FROM organizations o WHERE o.id = w.id
       );

      UPDATE workspaces
         SET organization_id = id
       WHERE organization_id IS NULL;

      CREATE INDEX IF NOT EXISTS workspaces_org_idx
        ON workspaces(organization_id);

      CREATE TABLE governance_policies (
        layer         TEXT NOT NULL CHECK (layer IN ('platform', 'jurisdiction', 'organization', 'workspace', 'user')),
        scope_id      TEXT NOT NULL,
        policy        JSONB NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
        version       TEXT NOT NULL DEFAULT '1',
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (layer, scope_id)
      );

      CREATE INDEX governance_policy_scope_idx
        ON governance_policies(scope_id, layer);

      INSERT INTO governance_policies (layer, scope_id, policy)
      VALUES ('platform', 'global', '{}'::jsonb)
      ON CONFLICT (layer, scope_id) DO NOTHING;
    `
  },
  {
    version: 3,
    name: 'execution-task-metadata',
    sql: `
      ALTER TABLE run_tasks
        ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
    `
  },
  {
    version: 4,
    name: 'encrypted-object-blobs',
    sql: `
      ALTER TABLE blobs
        ADD COLUMN IF NOT EXISTS encryption_version SMALLINT NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS rate_limit_windows (
        bucket_key       TEXT PRIMARY KEY,
        window_start_ms  BIGINT NOT NULL,
        request_count    INTEGER NOT NULL CHECK (request_count >= 0)
      );
      CREATE INDEX IF NOT EXISTS rate_limit_window_age_idx
        ON rate_limit_windows(window_start_ms);
    `
  },
  {
    version: 5,
    name: 'immutable-audit-log',
    sql: `
      CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'audit_log is append-only';
      END;
      $$;

      DROP TRIGGER IF EXISTS audit_log_no_update_delete ON audit_log;
      CREATE TRIGGER audit_log_no_update_delete
      BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW
      EXECUTE FUNCTION prevent_audit_log_mutation();
    `
  },
  {
    version: 6,
    name: 'idempotency-reservations',
    sql: `
      ALTER TABLE idempotency_keys
        ALTER COLUMN status_code DROP NOT NULL,
        ALTER COLUMN response DROP NOT NULL;
      ALTER TABLE idempotency_keys
        ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'complete'
          CHECK (state IN ('pending', 'complete')),
        ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS idempotency_pending_idx
        ON idempotency_keys(state, lease_until);
    `
  },
  {
    version: 7,
    name: 'capability-registry',
    sql: `
      CREATE TABLE IF NOT EXISTS capability_specs (
        workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        capability_id TEXT NOT NULL,
        spec          JSONB NOT NULL CHECK (jsonb_typeof(spec) = 'object'),
        status        TEXT NOT NULL DEFAULT 'candidate'
                     CHECK (status IN ('candidate', 'approved', 'revoked')),
        created_by    TEXT NOT NULL REFERENCES principals(id),
        approved_by   TEXT REFERENCES principals(id),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, capability_id)
      );
      CREATE INDEX IF NOT EXISTS capability_specs_status_idx
        ON capability_specs(workspace_id, status, updated_at DESC);
    `
  }
  ,{
    version: 8,
    name: 'persistent-situation-state',
    sql: `
      ALTER TABLE runs
        ADD COLUMN IF NOT EXISTS situation JSONB NOT NULL DEFAULT '{}'::jsonb;

      CREATE TABLE IF NOT EXISTS situation_events (
        id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id TEXT NOT NULL REFERENCES principals(id),
        event_type   TEXT NOT NULL,
        event        JSONB NOT NULL CHECK (jsonb_typeof(event) = 'object'),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS situation_events_run_idx
        ON situation_events(run_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS situation_events_scope_idx
        ON situation_events(workspace_id, created_at DESC, id DESC);
    `
  }

  ,{
    version: 9,
    name: 'user-private-visibility',
    sql: `
      ALTER TABLE runs
        ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'
          CHECK (visibility IN ('private', 'workspace'));
      ALTER TABLE objects
        ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'
          CHECK (visibility IN ('private', 'workspace'));
      CREATE INDEX IF NOT EXISTS runs_visibility_idx
        ON runs(workspace_id, visibility, principal_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS objects_visibility_idx
        ON objects(workspace_id, visibility, owner_id, created_at DESC);
    `
  },
  {
    version: 10,
    name: 'database-row-level-security',
    sql: `
      -- Blob rows are tenant-scoped in production. Legacy plaintext-era rows
      -- must never represent the same digest across multiple workspaces.
      DO $rls$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM objects
          GROUP BY digest
          HAVING COUNT(DISTINCT workspace_id) > 1
        ) THEN
          RAISE EXCEPTION 'Cannot establish blob tenant ownership: one digest belongs to multiple workspaces';
        END IF;
        IF EXISTS (
          SELECT 1
          FROM blobs b
          WHERE NOT EXISTS (SELECT 1 FROM objects o WHERE o.digest = b.digest)
            AND b.ref_count <> 0
        ) THEN
          RAISE EXCEPTION 'Cannot establish blob tenant ownership: referenced orphan blob exists';
        END IF;
      END
      $rls$;

      DELETE FROM blobs b
       WHERE NOT EXISTS (SELECT 1 FROM objects o WHERE o.digest = b.digest)
         AND b.ref_count = 0;

      ALTER TABLE blobs
        ADD COLUMN IF NOT EXISTS workspace_id TEXT;

      UPDATE blobs b
         SET workspace_id = (
           SELECT MIN(o.workspace_id)
             FROM objects o
            WHERE o.digest = b.digest
         )
       WHERE b.workspace_id IS NULL;

      ALTER TABLE blobs
        ALTER COLUMN workspace_id SET NOT NULL;

      DO $rls$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conname = 'blobs_workspace_id_fkey'
        ) THEN
          ALTER TABLE blobs
            ADD CONSTRAINT blobs_workspace_id_fkey
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
        END IF;
      END
      $rls$;

      CREATE INDEX IF NOT EXISTS blobs_workspace_idx
        ON blobs(workspace_id, created_at DESC, digest);

      -- Credential lookup happens before a request has an authenticated
      -- principal, so api_keys/sessions remain protected by their exact
      -- parameterized lookup paths rather than request-time RLS context.
      ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
      ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS workspace_scope_policy ON workspaces;
      CREATE POLICY workspace_scope_policy ON workspaces
        FOR ALL
        USING (
          EXISTS (
            SELECT 1 FROM memberships m
             WHERE m.workspace_id = workspaces.id
               AND m.principal_id = NULLIF(current_setting('app.principal_id', true), '')
          )
          AND (
            NULLIF(current_setting('app.workspace_id', true), '') IS NULL
            OR workspaces.id = current_setting('app.workspace_id', true)
          )
        )
        WITH CHECK (
          workspaces.id = current_setting('app.workspace_id', true)
        );

      ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS organization_scope_policy ON organizations;
      CREATE POLICY organization_scope_policy ON organizations
        FOR ALL
        USING (
          EXISTS (
            SELECT 1
              FROM workspaces w
              JOIN memberships m ON m.workspace_id = w.id
             WHERE w.organization_id = organizations.id
               AND m.principal_id = NULLIF(current_setting('app.principal_id', true), '')
          )
          AND (
            NULLIF(current_setting('app.organization_id', true), '') IS NULL
            OR organizations.id = current_setting('app.organization_id', true)
          )
        )
        WITH CHECK (
          organizations.id = current_setting('app.organization_id', true)
        );

      ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
      ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS membership_scope_policy ON memberships;
      CREATE POLICY membership_scope_policy ON memberships
        FOR ALL
        USING (
          memberships.principal_id = current_setting('app.principal_id', true)
          AND (
            NULLIF(current_setting('app.workspace_id', true), '') IS NULL
            OR memberships.workspace_id = current_setting('app.workspace_id', true)
          )
        )
        WITH CHECK (
          memberships.principal_id = current_setting('app.principal_id', true)
        );

      ALTER TABLE objects ENABLE ROW LEVEL SECURITY;
      ALTER TABLE objects FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS object_scope_policy ON objects;
      CREATE POLICY object_scope_policy ON objects
        FOR ALL
        USING (
          objects.workspace_id = current_setting('app.workspace_id', true)
          AND (objects.visibility = 'workspace' OR objects.owner_id = current_setting('app.principal_id', true))
        )
        WITH CHECK (
          objects.workspace_id = current_setting('app.workspace_id', true)
          AND objects.owner_id = current_setting('app.principal_id', true)
        );

      ALTER TABLE blobs ENABLE ROW LEVEL SECURITY;
      ALTER TABLE blobs FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS blob_scope_policy ON blobs;
      CREATE POLICY blob_scope_policy ON blobs
        FOR ALL
        USING (blobs.workspace_id = current_setting('app.workspace_id', true))
        WITH CHECK (blobs.workspace_id = current_setting('app.workspace_id', true));

      ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
      ALTER TABLE runs FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS run_scope_policy ON runs;
      CREATE POLICY run_scope_policy ON runs
        FOR ALL
        USING (
          runs.workspace_id = current_setting('app.workspace_id', true)
          AND (runs.visibility = 'workspace' OR runs.principal_id = current_setting('app.principal_id', true))
        )
        WITH CHECK (
          runs.workspace_id = current_setting('app.workspace_id', true)
          AND runs.principal_id = current_setting('app.principal_id', true)
        );

      ALTER TABLE run_tasks ENABLE ROW LEVEL SECURITY;
      ALTER TABLE run_tasks FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS run_task_scope_policy ON run_tasks;
      CREATE POLICY run_task_scope_policy ON run_tasks
        FOR ALL
        USING (
          EXISTS (
            SELECT 1 FROM runs r
             WHERE r.id = run_tasks.run_id
               AND r.workspace_id = current_setting('app.workspace_id', true)
               AND (r.visibility = 'workspace' OR r.principal_id = current_setting('app.principal_id', true))
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM runs r
             WHERE r.id = run_tasks.run_id
               AND r.workspace_id = current_setting('app.workspace_id', true)
               AND r.principal_id = current_setting('app.principal_id', true)
          )
        );

      ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
      ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS audit_scope_policy ON audit_log;
      CREATE POLICY audit_scope_policy ON audit_log
        FOR SELECT
        USING (
          audit_log.workspace_id = current_setting('app.workspace_id', true)
          AND current_setting('app.role', true) = 'admin'
        );
      DROP POLICY IF EXISTS audit_insert_policy ON audit_log;
      CREATE POLICY audit_insert_policy ON audit_log
        FOR INSERT
        WITH CHECK (
          (
            audit_log.workspace_id IS NULL
            OR audit_log.workspace_id = current_setting('app.workspace_id', true)
          )
          AND (
            audit_log.principal_id IS NULL
            OR audit_log.principal_id = current_setting('app.principal_id', true)
          )
        );

      ALTER TABLE governance_policies ENABLE ROW LEVEL SECURITY;
      ALTER TABLE governance_policies FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS governance_scope_policy ON governance_policies;
      CREATE POLICY governance_scope_policy ON governance_policies
        FOR SELECT
        USING (
          (layer = 'platform' AND scope_id = 'global')
          OR (layer = 'jurisdiction' AND scope_id = current_setting('app.jurisdiction', true))
          OR (layer = 'organization' AND scope_id = current_setting('app.organization_id', true))
          OR (layer = 'workspace' AND scope_id = current_setting('app.workspace_id', true))
          OR (layer = 'user' AND scope_id = current_setting('app.principal_id', true))
        );
      DROP POLICY IF EXISTS governance_write_policy ON governance_policies;
      CREATE POLICY governance_write_policy ON governance_policies
        FOR ALL
        USING (
          current_setting('app.role', true) = 'admin'
          AND (
            (layer = 'organization' AND scope_id = current_setting('app.organization_id', true))
            OR (layer = 'workspace' AND scope_id = current_setting('app.workspace_id', true))
            OR (layer = 'user' AND scope_id = current_setting('app.principal_id', true))
          )
        )
        WITH CHECK (
          current_setting('app.role', true) = 'admin'
          AND (
            (layer = 'organization' AND scope_id = current_setting('app.organization_id', true))
            OR (layer = 'workspace' AND scope_id = current_setting('app.workspace_id', true))
            OR (layer = 'user' AND scope_id = current_setting('app.principal_id', true))
          )
        );

      ALTER TABLE capability_specs ENABLE ROW LEVEL SECURITY;
      ALTER TABLE capability_specs FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS capability_select_policy ON capability_specs;
      CREATE POLICY capability_select_policy ON capability_specs
        FOR SELECT
        USING (capability_specs.workspace_id = current_setting('app.workspace_id', true));
      DROP POLICY IF EXISTS capability_update_policy ON capability_specs;
      CREATE POLICY capability_update_policy ON capability_specs
        FOR UPDATE
        USING (capability_specs.workspace_id = current_setting('app.workspace_id', true))
        WITH CHECK (capability_specs.workspace_id = current_setting('app.workspace_id', true));
      DROP POLICY IF EXISTS capability_insert_policy ON capability_specs;
      CREATE POLICY capability_insert_policy ON capability_specs
        FOR INSERT
        WITH CHECK (
          capability_specs.workspace_id = current_setting('app.workspace_id', true)
          AND capability_specs.created_by = current_setting('app.principal_id', true)
        );
      DROP POLICY IF EXISTS capability_delete_policy ON capability_specs;
      CREATE POLICY capability_delete_policy ON capability_specs
        FOR DELETE
        USING (capability_specs.workspace_id = current_setting('app.workspace_id', true));

      ALTER TABLE situation_events ENABLE ROW LEVEL SECURITY;
      ALTER TABLE situation_events FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS situation_event_scope_policy ON situation_events;
      CREATE POLICY situation_event_scope_policy ON situation_events
        FOR ALL
        USING (
          situation_events.workspace_id = current_setting('app.workspace_id', true)
          AND (
            situation_events.principal_id = current_setting('app.principal_id', true)
            OR EXISTS (
              SELECT 1 FROM runs r
               WHERE r.id = situation_events.run_id
                 AND r.visibility = 'workspace'
               )
          )
        )
        WITH CHECK (
          situation_events.workspace_id = current_setting('app.workspace_id', true)
          AND situation_events.principal_id = current_setting('app.principal_id', true)
        );

      -- Operational tables are intentionally not tenant-content tables:
      -- rate limiting can begin before authentication and credential lookup
      -- must work before a principal exists. Their access is constrained by
      -- exact application code paths and least-privileged grants.
      REVOKE ALL ON schema_migrations FROM PUBLIC;
    `
  },
  {
    version: 11,
    name: 'session-key-binding',
    sql: `
      -- A session lives only as long as the key that created it, so revoking
      -- a leaked key also ends every browser session minted from it.
      ALTER TABLE sessions
        ADD COLUMN IF NOT EXISTS api_key_id TEXT REFERENCES api_keys(id) ON DELETE CASCADE;
      CREATE INDEX IF NOT EXISTS sessions_api_key_idx ON sessions(api_key_id);
    `
  },
  {
    version: 12,
    name: 'background-run-jobs',
    sql: `
      -- Durable background execution. A job pins the task it was queued for,
      -- so it can never run a different task if the run moves on meanwhile.
      CREATE TABLE IF NOT EXISTS run_jobs (
        id            TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        task_id       TEXT NOT NULL,
        workspace_id  TEXT NOT NULL,
        principal_id  TEXT NOT NULL,
        state         TEXT NOT NULL DEFAULT 'queued'
                        CHECK (state IN ('queued', 'running', 'succeeded', 'refused', 'failed')),
        request       JSONB NOT NULL DEFAULT '{}'::jsonb,
        outcome       JSONB,
        attempts      INTEGER NOT NULL DEFAULT 0,
        max_attempts  INTEGER NOT NULL DEFAULT 3,
        lease_until   TIMESTAMPTZ,
        request_id    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at   TIMESTAMPTZ
      );
      -- One active job per task: a double click cannot queue the work twice.
      CREATE UNIQUE INDEX IF NOT EXISTS run_jobs_one_active_per_task
        ON run_jobs(run_id, task_id) WHERE state IN ('queued', 'running');
      CREATE INDEX IF NOT EXISTS run_jobs_claim_idx
        ON run_jobs(created_at) WHERE state IN ('queued', 'running');

      ALTER TABLE run_jobs ENABLE ROW LEVEL SECURITY;
      ALTER TABLE run_jobs FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS run_job_scope_policy ON run_jobs;
      -- The owner sees its jobs. The worker role may see all of them only in
      -- its claim transaction; each job then runs under its owner's scope.
      CREATE POLICY run_job_scope_policy ON run_jobs
        FOR ALL
        USING (
          (run_jobs.workspace_id = current_setting('app.workspace_id', true)
            AND run_jobs.principal_id = current_setting('app.principal_id', true))
          OR current_setting('app.role', true) = 'job-worker'
        )
        WITH CHECK (
          (run_jobs.workspace_id = current_setting('app.workspace_id', true)
            AND run_jobs.principal_id = current_setting('app.principal_id', true))
          OR current_setting('app.role', true) = 'job-worker'
        );
    `
  },
  {
    version: 13,
    name: 'workspace-run-collaboration-boundary',
    sql: `
      -- Shared runs are collaborative state. Private runs remain owner-only.
      -- Ownership, workspace and visibility are immutable after creation so
      -- the broader UPDATE policy cannot be used to transfer a run.
      CREATE OR REPLACE FUNCTION prevent_run_scope_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $scope$
      BEGIN
        IF NEW.workspace_id <> OLD.workspace_id
           OR NEW.principal_id <> OLD.principal_id
           OR NEW.visibility <> OLD.visibility THEN
          RAISE EXCEPTION 'run scope and visibility are immutable';
        END IF;
        RETURN NEW;
      END;
      $scope$;

      DROP TRIGGER IF EXISTS run_scope_immutable ON runs;
      CREATE TRIGGER run_scope_immutable
      BEFORE UPDATE ON runs
      FOR EACH ROW
      EXECUTE FUNCTION prevent_run_scope_mutation();

      DROP POLICY IF EXISTS run_scope_policy ON runs;
      CREATE POLICY run_scope_policy ON runs
        FOR ALL
        USING (
          runs.workspace_id = current_setting('app.workspace_id', true)
          AND (
            runs.principal_id = current_setting('app.principal_id', true)
            OR (
              runs.visibility = 'workspace'
              AND current_setting('app.role', true) IN ('editor', 'admin', 'job-worker')
            )
          )
        )
        WITH CHECK (
          runs.workspace_id = current_setting('app.workspace_id', true)
          AND (
            runs.principal_id = current_setting('app.principal_id', true)
            OR (
              runs.visibility = 'workspace'
              AND current_setting('app.role', true) IN ('editor', 'admin', 'job-worker')
            )
          )
        );

      DROP POLICY IF EXISTS run_task_scope_policy ON run_tasks;
      CREATE POLICY run_task_scope_policy ON run_tasks
        FOR ALL
        USING (
          EXISTS (
            SELECT 1 FROM runs r
             WHERE r.id = run_tasks.run_id
               AND r.workspace_id = current_setting('app.workspace_id', true)
               AND (
                 r.principal_id = current_setting('app.principal_id', true)
                 OR (
                   r.visibility = 'workspace'
                   AND current_setting('app.role', true) IN ('editor', 'admin', 'job-worker')
                 )
               )
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM runs r
             WHERE r.id = run_tasks.run_id
               AND r.workspace_id = current_setting('app.workspace_id', true)
               AND (
                 r.principal_id = current_setting('app.principal_id', true)
                 OR (
                   r.visibility = 'workspace'
                   AND current_setting('app.role', true) IN ('editor', 'admin', 'job-worker')
                 )
               )
          )
        );

      DROP POLICY IF EXISTS situation_event_scope_policy ON situation_events;
      CREATE POLICY situation_event_scope_policy ON situation_events
        FOR ALL
        USING (
          situation_events.workspace_id = current_setting('app.workspace_id', true)
          AND (
            situation_events.principal_id = current_setting('app.principal_id', true)
            OR EXISTS (
              SELECT 1 FROM runs r
               WHERE r.id = situation_events.run_id
                 AND r.workspace_id = current_setting('app.workspace_id', true)
                 AND r.visibility = 'workspace'
                 AND current_setting('app.role', true) IN ('editor', 'admin', 'job-worker')
            )
          )
        )
        WITH CHECK (
          situation_events.workspace_id = current_setting('app.workspace_id', true)
          AND (
            situation_events.principal_id = current_setting('app.principal_id', true)
            OR current_setting('app.role', true) IN ('editor', 'admin', 'job-worker')
          )
          AND EXISTS (
            SELECT 1 FROM runs r
             WHERE r.id = situation_events.run_id
               AND r.workspace_id = current_setting('app.workspace_id', true)
               AND (
                 r.principal_id = current_setting('app.principal_id', true)
                 OR (
                   r.visibility = 'workspace'
                   AND current_setting('app.role', true) IN ('editor', 'admin', 'job-worker')
                 )
               )
          )
        );
    `
  },
  {
    version: 14,
    name: 'idempotency-response-rls',
    sql: `
      -- Idempotency responses may contain private run/object data. Keep them
      -- principal-scoped in the runtime database role; only the internal
      -- maintenance context may sweep expired rows.
      ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
      ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS idempotency_principal_policy ON idempotency_keys;
      CREATE POLICY idempotency_principal_policy ON idempotency_keys
        FOR ALL
        USING (
          principal_id = current_setting('app.principal_id', true)
          OR current_setting('app.role', true) = 'maintenance'
        )
        WITH CHECK (
          principal_id = current_setting('app.principal_id', true)
          OR current_setting('app.role', true) = 'maintenance'
        );
    `
  },
  {
    version: 15,
    name: 'workspace-run-read-access',
    sql: `
      -- Migration 13 limited shared runs to editors for every command, which
      -- also hid them from workspace viewers. Permissive policies are OR'd
      -- per command, so these SELECT-only policies let any workspace member
      -- read a shared run while writes stay with the owner and editors.
      DROP POLICY IF EXISTS run_read_policy ON runs;
      CREATE POLICY run_read_policy ON runs
        FOR SELECT
        USING (
          runs.workspace_id = current_setting('app.workspace_id', true)
          AND (
            runs.principal_id = current_setting('app.principal_id', true)
            OR runs.visibility = 'workspace'
          )
        );

      DROP POLICY IF EXISTS run_task_read_policy ON run_tasks;
      CREATE POLICY run_task_read_policy ON run_tasks
        FOR SELECT
        USING (
          EXISTS (
            SELECT 1 FROM runs r
             WHERE r.id = run_tasks.run_id
               AND r.workspace_id = current_setting('app.workspace_id', true)
               AND (
                 r.principal_id = current_setting('app.principal_id', true)
                 OR r.visibility = 'workspace'
               )
          )
        );

      DROP POLICY IF EXISTS situation_event_read_policy ON situation_events;
      CREATE POLICY situation_event_read_policy ON situation_events
        FOR SELECT
        USING (
          situation_events.workspace_id = current_setting('app.workspace_id', true)
          AND EXISTS (
            SELECT 1 FROM runs r
             WHERE r.id = situation_events.run_id
               AND r.workspace_id = current_setting('app.workspace_id', true)
               AND (
                 r.principal_id = current_setting('app.principal_id', true)
                 OR r.visibility = 'workspace'
               )
          )
        );
    `
  },
  {
    version: 16,
    name: 'run-conversations',
    sql: `
      -- A chat conversation is a sequence of runs. Each message is its own
      -- governed run; the conversation id only groups them for display and
      -- for giving the model the earlier turns.
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS conversation_id TEXT
        CHECK (conversation_id IS NULL OR conversation_id ~ '^[A-Za-z0-9-]{8,64}$');
      CREATE INDEX IF NOT EXISTS runs_conversation_idx
        ON runs (workspace_id, conversation_id, created_at);
    `
  },
  {
    version: 17,
    name: 'simulation-and-user-preferences',
    sql: `
      CREATE TABLE IF NOT EXISTS simulation_models (
        id             TEXT PRIMARY KEY,
        workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id   TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        visibility     TEXT NOT NULL DEFAULT 'private'
                       CHECK (visibility IN ('private', 'workspace')),
        name           TEXT NOT NULL,
        goal           TEXT NOT NULL,
        model_version  INTEGER NOT NULL DEFAULT 1,
        model          JSONB NOT NULL CHECK (jsonb_typeof(model) = 'object'),
        situation      JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(situation) = 'object'),
        verification   JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(verification) = 'object'),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS simulation_models_scope_idx
        ON simulation_models(workspace_id, visibility, principal_id, updated_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS simulation_runs (
        id             TEXT PRIMARY KEY,
        model_id       TEXT NOT NULL REFERENCES simulation_models(id) ON DELETE CASCADE,
        workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id   TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        model_version  INTEGER NOT NULL,
        status         TEXT NOT NULL,
        scenario       JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scenario) = 'object'),
        result         JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
        verification   JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(verification) = 'object'),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS simulation_runs_scope_idx
        ON simulation_runs(workspace_id, principal_id, created_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS simulation_live_sessions (
        id             TEXT PRIMARY KEY,
        model_id       TEXT NOT NULL REFERENCES simulation_models(id) ON DELETE CASCADE,
        workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id   TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        status         TEXT NOT NULL DEFAULT 'paused',
        mode           TEXT NOT NULL DEFAULT 'manual'
                       CHECK (mode IN ('manual', 'continuous')),
        model_version  INTEGER NOT NULL,
        time           DOUBLE PRECISION NOT NULL DEFAULT 0,
        state          JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object'),
        trace          JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(trace) = 'array'),
        verification   JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(verification) = 'object'),
        changed_at     TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS simulation_live_one_active_idx
        ON simulation_live_sessions(model_id, workspace_id, principal_id)
        WHERE status <> 'stopped';
      CREATE INDEX IF NOT EXISTS simulation_live_scope_idx
        ON simulation_live_sessions(workspace_id, principal_id, updated_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS user_preferences (
        principal_id  TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
        settings      JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      ALTER TABLE simulation_models ENABLE ROW LEVEL SECURITY;
      ALTER TABLE simulation_models FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS simulation_model_read_policy ON simulation_models;
      CREATE POLICY simulation_model_read_policy ON simulation_models
        FOR SELECT
        USING (
          simulation_models.workspace_id = current_setting('app.workspace_id', true)
          AND (
            simulation_models.principal_id = current_setting('app.principal_id', true)
            OR simulation_models.visibility = 'workspace'
          )
        );
      DROP POLICY IF EXISTS simulation_model_write_policy ON simulation_models;
      CREATE POLICY simulation_model_write_policy ON simulation_models
        FOR ALL
        USING (
          simulation_models.workspace_id = current_setting('app.workspace_id', true)
          AND simulation_models.principal_id = current_setting('app.principal_id', true)
        )
        WITH CHECK (
          simulation_models.workspace_id = current_setting('app.workspace_id', true)
          AND simulation_models.principal_id = current_setting('app.principal_id', true)
        );

      ALTER TABLE simulation_runs ENABLE ROW LEVEL SECURITY;
      ALTER TABLE simulation_runs FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS simulation_run_read_policy ON simulation_runs;
      CREATE POLICY simulation_run_read_policy ON simulation_runs
        FOR SELECT
        USING (
          simulation_runs.workspace_id = current_setting('app.workspace_id', true)
          AND simulation_runs.principal_id = current_setting('app.principal_id', true)
        );
      DROP POLICY IF EXISTS simulation_run_insert_policy ON simulation_runs;
      CREATE POLICY simulation_run_insert_policy ON simulation_runs
        FOR INSERT
        WITH CHECK (
          simulation_runs.workspace_id = current_setting('app.workspace_id', true)
          AND simulation_runs.principal_id = current_setting('app.principal_id', true)
        );

      ALTER TABLE simulation_live_sessions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE simulation_live_sessions FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS simulation_live_read_policy ON simulation_live_sessions;
      CREATE POLICY simulation_live_read_policy ON simulation_live_sessions
        FOR SELECT
        USING (
          simulation_live_sessions.workspace_id = current_setting('app.workspace_id', true)
          AND simulation_live_sessions.principal_id = current_setting('app.principal_id', true)
        );
      DROP POLICY IF EXISTS simulation_live_write_policy ON simulation_live_sessions;
      CREATE POLICY simulation_live_write_policy ON simulation_live_sessions
        FOR ALL
        USING (
          simulation_live_sessions.workspace_id = current_setting('app.workspace_id', true)
          AND simulation_live_sessions.principal_id = current_setting('app.principal_id', true)
        )
        WITH CHECK (
          simulation_live_sessions.workspace_id = current_setting('app.workspace_id', true)
          AND simulation_live_sessions.principal_id = current_setting('app.principal_id', true)
        );

      ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
      ALTER TABLE user_preferences FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS user_preferences_policy ON user_preferences;
      CREATE POLICY user_preferences_policy ON user_preferences
        FOR ALL
        USING (user_preferences.principal_id = current_setting('app.principal_id', true))
        WITH CHECK (user_preferences.principal_id = current_setting('app.principal_id', true));
    `
  },
  {
    version: 18,
    name: 'usage-ledger-and-billing',
    sql: `
      -- One row per model call: who spent tokens, where, on what. Usage
      -- windows (5 hours, a week) and the context meter read from here.
      CREATE TABLE IF NOT EXISTS usage_events (
        id             BIGSERIAL PRIMARY KEY,
        principal_id   TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        run_id         TEXT REFERENCES runs(id) ON DELETE SET NULL,
        conversation_id TEXT,
        source         TEXT NOT NULL CHECK (source IN ('chat', 'classifier', 'simulation-design')),
        provider       TEXT NOT NULL DEFAULT '',
        model          TEXT NOT NULL DEFAULT '',
        input_tokens   INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
        output_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS usage_events_principal_time_idx ON usage_events(principal_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS usage_events_conversation_idx ON usage_events(principal_id, conversation_id, created_at DESC);

      ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
      ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS usage_events_read_policy ON usage_events;
      CREATE POLICY usage_events_read_policy ON usage_events
        FOR SELECT
        USING (usage_events.principal_id = current_setting('app.principal_id', true));
      DROP POLICY IF EXISTS usage_events_insert_policy ON usage_events;
      CREATE POLICY usage_events_insert_policy ON usage_events
        FOR INSERT
        WITH CHECK (
          usage_events.principal_id = current_setting('app.principal_id', true)
          AND usage_events.workspace_id = current_setting('app.workspace_id', true)
        );

      -- Billing details a workspace admin keeps for invoices. Card data is
      -- never stored here: payment methods live with the payment provider.
      CREATE TABLE IF NOT EXISTS workspace_billing (
        workspace_id   TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        billing_email  TEXT NOT NULL DEFAULT '',
        company_name   TEXT NOT NULL DEFAULT '',
        tax_id         TEXT NOT NULL DEFAULT '',
        country        TEXT NOT NULL DEFAULT '',
        address        TEXT NOT NULL DEFAULT '',
        updated_by     TEXT REFERENCES principals(id) ON DELETE SET NULL,
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE workspace_billing ENABLE ROW LEVEL SECURITY;
      ALTER TABLE workspace_billing FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS workspace_billing_policy ON workspace_billing;
      CREATE POLICY workspace_billing_policy ON workspace_billing
        FOR ALL
        USING (workspace_billing.workspace_id = current_setting('app.workspace_id', true))
        WITH CHECK (workspace_billing.workspace_id = current_setting('app.workspace_id', true));
    `
  },
  {
    version: 19,
    name: 'stripe-subscriptions',
    sql: `
      -- The workspace's Stripe customer and subscription, kept in step by
      -- signed webhooks. Card data never reaches this database.
      ALTER TABLE workspace_billing ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
      ALTER TABLE workspace_billing ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
      ALTER TABLE workspace_billing ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT '';
      ALTER TABLE workspace_billing ADD COLUMN IF NOT EXISTS plan_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE workspace_billing ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;
      ALTER TABLE workspace_billing ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE workspace_billing ADD COLUMN IF NOT EXISTS stripe_synced_at TIMESTAMPTZ;

      -- Each Stripe event is applied once, however often Stripe resends it.
      CREATE TABLE IF NOT EXISTS stripe_events (
        id           TEXT PRIMARY KEY,
        type         TEXT NOT NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;
      ALTER TABLE stripe_events FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS stripe_events_policy ON stripe_events;
      CREATE POLICY stripe_events_policy ON stripe_events
        FOR ALL
        USING (stripe_events.workspace_id = current_setting('app.workspace_id', true))
        WITH CHECK (stripe_events.workspace_id = current_setting('app.workspace_id', true));
    `
  },
  {
    version: 20,
    name: 'run-actions',
    sql: `
      -- Things the AI proposed that change something outside the chat (a
      -- reminder, a calendar event, spending money, running code). Nothing
      -- here runs until a person with edit rights approves it.
      CREATE TABLE IF NOT EXISTS run_actions (
        id            TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        task_id       TEXT NOT NULL,
        workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id  TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        tool          TEXT NOT NULL,
        input         JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(input) = 'object'),
        summary       TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'proposed'
                      CHECK (status IN ('proposed', 'running', 'done', 'failed', 'declined')),
        result        JSONB,
        decided_by    TEXT REFERENCES principals(id) ON DELETE SET NULL,
        decided_at    TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS run_actions_run_idx ON run_actions(run_id, created_at);
      ALTER TABLE run_actions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE run_actions FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS run_actions_policy ON run_actions;
      CREATE POLICY run_actions_policy ON run_actions
        FOR ALL
        USING (run_actions.workspace_id = current_setting('app.workspace_id', true))
        WITH CHECK (run_actions.workspace_id = current_setting('app.workspace_id', true));
    `
  },
  {
    version: 21,
    name: 'workspace-tools',
    sql: `
      -- Tools Kindgleam built for a workspace: code with tests that passed in
      -- the sandbox, approved by an admin, reused by later chats and designs.
      CREATE TABLE IF NOT EXISTS workspace_tools (
        workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name          TEXT NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{1,39}$'),
        title         TEXT NOT NULL,
        description   TEXT NOT NULL,
        input_schema  JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(input_schema) = 'object'),
        language      TEXT NOT NULL CHECK (language IN ('python', 'javascript')),
        source        TEXT NOT NULL,
        tests         TEXT NOT NULL,
        packages      JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(packages) = 'array'),
        version       INTEGER NOT NULL DEFAULT 1,
        status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
        test_result   JSONB,
        created_by    TEXT REFERENCES principals(id) ON DELETE SET NULL,
        approved_by   TEXT REFERENCES principals(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, name)
      );
      ALTER TABLE workspace_tools ENABLE ROW LEVEL SECURITY;
      ALTER TABLE workspace_tools FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS workspace_tools_policy ON workspace_tools;
      CREATE POLICY workspace_tools_policy ON workspace_tools
        FOR ALL
        USING (workspace_tools.workspace_id = current_setting('app.workspace_id', true))
        WITH CHECK (workspace_tools.workspace_id = current_setting('app.workspace_id', true));
    `
  },
  {
    version: 22,
    name: 'schedules-and-notifications',
    sql: `
      -- Things a person asked to happen later or again: a reminder, a question
      -- asked in their chat, a simulation re-run with an alert condition.
      CREATE TABLE IF NOT EXISTS schedules (
        id              TEXT PRIMARY KEY,
        workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id    TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        conversation_id TEXT,
        title           TEXT NOT NULL,
        kind            TEXT NOT NULL CHECK (kind IN ('reminder', 'ask', 'simulation')),
        payload         JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
        rule            JSONB NOT NULL CHECK (jsonb_typeof(rule) = 'object'),
        time_zone       TEXT NOT NULL DEFAULT 'UTC',
        next_run_at     TIMESTAMPTZ,
        last_run_at     TIMESTAMPTZ,
        run_count       INTEGER NOT NULL DEFAULT 0,
        last_outcome    JSONB,
        active          BOOLEAN NOT NULL DEFAULT true,
        lease_until     TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS schedules_due_idx ON schedules(next_run_at) WHERE active;
      CREATE INDEX IF NOT EXISTS schedules_owner_idx ON schedules(workspace_id, principal_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS notifications (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id  TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        schedule_id   TEXT REFERENCES schedules(id) ON DELETE SET NULL,
        title         TEXT NOT NULL,
        body          TEXT NOT NULL DEFAULT '',
        tone          TEXT NOT NULL DEFAULT 'info' CHECK (tone IN ('info', 'alert')),
        link          JSONB,
        read_at       TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS notifications_owner_idx ON notifications(workspace_id, principal_id, created_at DESC);

      ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
      ALTER TABLE schedules FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS schedules_policy ON schedules;
      -- The owner sees their schedules. The scheduler may see all of them only
      -- in its claim transaction; each then runs under its owner's scope.
      CREATE POLICY schedules_policy ON schedules
        FOR ALL
        USING (
          (schedules.workspace_id = current_setting('app.workspace_id', true)
            AND schedules.principal_id = current_setting('app.principal_id', true))
          OR current_setting('app.role', true) = 'scheduler'
        )
        WITH CHECK (
          (schedules.workspace_id = current_setting('app.workspace_id', true)
            AND schedules.principal_id = current_setting('app.principal_id', true))
          OR current_setting('app.role', true) = 'scheduler'
        );
      ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
      ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS notifications_policy ON notifications;
      CREATE POLICY notifications_policy ON notifications
        FOR ALL
        USING (notifications.workspace_id = current_setting('app.workspace_id', true)
          AND notifications.principal_id = current_setting('app.principal_id', true))
        WITH CHECK (notifications.workspace_id = current_setting('app.workspace_id', true)
          AND notifications.principal_id = current_setting('app.principal_id', true));
    `
  },
  {
    version: 23,
    name: 'memories',
    sql: `
      -- What a person told Kindgleam that stays true across chats. Only that
      -- person, in that workspace, can read or change their memories.
      CREATE TABLE IF NOT EXISTS memories (
        id             TEXT PRIMARY KEY,
        workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id   TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        content        TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 500),
        normalized     TEXT NOT NULL,
        kind           TEXT NOT NULL DEFAULT 'fact' CHECK (kind IN ('about', 'preference', 'project', 'fact')),
        source_run_id  TEXT REFERENCES runs(id) ON DELETE SET NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at   TIMESTAMPTZ,
        UNIQUE (workspace_id, principal_id, normalized)
      );
      CREATE INDEX IF NOT EXISTS memories_owner_idx ON memories(workspace_id, principal_id, updated_at DESC);
      ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
      ALTER TABLE memories FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS memories_policy ON memories;
      CREATE POLICY memories_policy ON memories
        FOR ALL
        USING (memories.workspace_id = current_setting('app.workspace_id', true)
          AND memories.principal_id = current_setting('app.principal_id', true))
        WITH CHECK (memories.workspace_id = current_setting('app.workspace_id', true)
          AND memories.principal_id = current_setting('app.principal_id', true));
    `
  },
  {
    version: 24,
    name: 'usage-policy',
    sql: `
      -- Requests the usage policy declined: the category only, never the text.
      CREATE TABLE IF NOT EXISTS safety_events (
        id            BIGSERIAL PRIMARY KEY,
        workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id  TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        kind          TEXT NOT NULL CHECK (kind IN ('refused')),
        category      TEXT NOT NULL,
        source        TEXT NOT NULL DEFAULT 'rules' CHECK (source IN ('rules', 'model', 'tool')),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS safety_events_owner_idx ON safety_events(workspace_id, principal_id, created_at DESC);

      -- Answers people reported, for the workspace's admins to review.
      CREATE TABLE IF NOT EXISTS safety_reports (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id  TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        run_id        TEXT REFERENCES runs(id) ON DELETE SET NULL,
        reason        TEXT NOT NULL CHECK (reason IN ('harmful', 'wrong', 'unfair', 'privacy', 'other')),
        note          TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
        excerpt       TEXT NOT NULL DEFAULT '' CHECK (length(excerpt) <= 2000),
        status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
        resolved_by   TEXT REFERENCES principals(id) ON DELETE SET NULL,
        resolved_at   TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS safety_reports_workspace_idx ON safety_reports(workspace_id, status, created_at DESC);

      -- Each person confirms their age and accepts the terms once per version.
      CREATE TABLE IF NOT EXISTS terms_acceptances (
        principal_id   TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        version        TEXT NOT NULL,
        age_confirmed  BOOLEAN NOT NULL,
        accepted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (principal_id, version)
      );

      ALTER TABLE safety_events ENABLE ROW LEVEL SECURITY;
      ALTER TABLE safety_events FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS safety_events_policy ON safety_events;
      CREATE POLICY safety_events_policy ON safety_events
        FOR ALL
        USING (safety_events.workspace_id = current_setting('app.workspace_id', true)
          AND (safety_events.principal_id = current_setting('app.principal_id', true)
            OR current_setting('app.role', true) = 'admin'))
        WITH CHECK (safety_events.workspace_id = current_setting('app.workspace_id', true)
          AND safety_events.principal_id = current_setting('app.principal_id', true));

      ALTER TABLE safety_reports ENABLE ROW LEVEL SECURITY;
      ALTER TABLE safety_reports FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS safety_reports_policy ON safety_reports;
      -- The reporter sees their reports; the workspace's admins see and resolve all of them.
      CREATE POLICY safety_reports_policy ON safety_reports
        FOR ALL
        USING (safety_reports.workspace_id = current_setting('app.workspace_id', true)
          AND (safety_reports.principal_id = current_setting('app.principal_id', true)
            OR current_setting('app.role', true) = 'admin'))
        WITH CHECK (safety_reports.workspace_id = current_setting('app.workspace_id', true)
          AND (safety_reports.principal_id = current_setting('app.principal_id', true)
            OR current_setting('app.role', true) = 'admin'));

      ALTER TABLE terms_acceptances ENABLE ROW LEVEL SECURITY;
      ALTER TABLE terms_acceptances FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS terms_acceptances_policy ON terms_acceptances;
      CREATE POLICY terms_acceptances_policy ON terms_acceptances
        FOR ALL
        USING (terms_acceptances.principal_id = current_setting('app.principal_id', true))
        WITH CHECK (terms_acceptances.principal_id = current_setting('app.principal_id', true));
    `
  },
  {
    version: 25,
    name: 'off-topic-events',
    sql: `
      -- Topics the operator chose not to offer are recorded apart from
      -- harmful requests, so they never pause anyone's chats.
      ALTER TABLE safety_events DROP CONSTRAINT IF EXISTS safety_events_kind_check;
      ALTER TABLE safety_events ADD CONSTRAINT safety_events_kind_check CHECK (kind IN ('refused', 'off-topic'));
    `
  },
  {
    version: 26,
    name: 'workspace-ai-settings',
    sql: `
      -- Workspace-owned model routing controls. API keys never live here.
      CREATE TABLE IF NOT EXISTS workspace_ai_settings (
        workspace_id     TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        default_model    TEXT NOT NULL DEFAULT '',
        enabled_models   JSONB NOT NULL DEFAULT '[]'::jsonb
                         CHECK (jsonb_typeof(enabled_models) = 'array'),
        updated_by       TEXT REFERENCES principals(id) ON DELETE SET NULL,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE workspace_ai_settings ENABLE ROW LEVEL SECURITY;
      ALTER TABLE workspace_ai_settings FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS workspace_ai_settings_policy ON workspace_ai_settings;
      CREATE POLICY workspace_ai_settings_policy ON workspace_ai_settings
        FOR ALL
        USING (workspace_ai_settings.workspace_id = current_setting('app.workspace_id', true))
        WITH CHECK (workspace_ai_settings.workspace_id = current_setting('app.workspace_id', true));
    `
  },
  {
    version: 27,
    name: 'runs-recent-index',
    sql: `
      -- The chat list reads a workspace's most recently updated runs first,
      -- so its cost follows the page size, not the workspace's history.
      CREATE INDEX IF NOT EXISTS runs_recent_idx ON runs (workspace_id, updated_at DESC, id DESC);
    `
  }

  ,{
    version: 28,
    name: 'run-requirement-state',
    sql: `
      -- Requirements are first-class run state. The task graph remains
      -- intentionally sparse: this records what must ultimately be
      -- satisfied without pretending future work already exists.
      ALTER TABLE runs
        ADD COLUMN IF NOT EXISTS requirements JSONB NOT NULL
          DEFAULT '{"version":1,"items":[],"overallProgress":0,"completionReady":false}'::jsonb;

      CREATE INDEX IF NOT EXISTS runs_requirement_progress_idx
        ON runs(workspace_id, ((requirements->>'overallProgress')::integer), updated_at DESC);
    `
  }

  ,{
    version: 29,
    name: 'remove-simulation',
    sql: `
      -- Kindgleam has no simulation feature: simulation requests are code
      -- projects, and files are handled in the chat. Its schedules and
      -- tables go. Usage rows recorded as 'simulation-design' stay as history.
      DELETE FROM schedules WHERE kind NOT IN ('reminder', 'ask');
      ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_kind_check;
      ALTER TABLE schedules ADD CONSTRAINT schedules_kind_check CHECK (kind IN ('reminder', 'ask'));
      DROP TABLE IF EXISTS simulation_live_sessions;
      DROP TABLE IF EXISTS simulation_runs;
      DROP TABLE IF EXISTS simulation_models;
    `
  }
  ,{
    version: 30,
    name: 'chat-local-memory-cross-chat-control',
    sql: `
      ALTER TABLE memories
        ADD COLUMN IF NOT EXISTS conversation_id TEXT;
      ALTER TABLE memories
        DROP CONSTRAINT IF EXISTS memories_workspace_id_principal_id_normalized_key;
      CREATE UNIQUE INDEX IF NOT EXISTS memories_scope_normalized_idx
        ON memories (workspace_id, principal_id, COALESCE(conversation_id, ''), normalized);
      CREATE INDEX IF NOT EXISTS memories_conversation_idx
        ON memories (workspace_id, principal_id, conversation_id, updated_at DESC);
    `
  }
  ,{
    version: 31,
    name: 'keep-legacy-memory-on',
    sql: `
      -- Memory used to be one switch, on unless turned off. Cross-chat memory
      -- is now off unless turned on, so anyone who already had memories and
      -- never chose keeps what they had: on, or their old choice.
      INSERT INTO user_preferences (principal_id, settings)
      SELECT DISTINCT m.principal_id, '{"crossChatMemory": true}'::jsonb
        FROM memories m
       WHERE m.conversation_id IS NULL
      ON CONFLICT (principal_id) DO UPDATE
        SET settings = user_preferences.settings || jsonb_build_object(
              'crossChatMemory',
              CASE WHEN jsonb_typeof(user_preferences.settings->'memory') = 'boolean'
                   THEN user_preferences.settings->'memory' ELSE 'true'::jsonb END),
            updated_at = now()
      WHERE NOT (user_preferences.settings ? 'crossChatMemory');
    `
  }
  ,{
    version: 32,
    name: 'email-sign-in',
    sql: `
      -- Mail settings belong to the whole service, so changing them needs a
      -- platform administrator, not a workspace admin: with open sign-up,
      -- every new person administers their own personal workspace. Until
      -- now every workspace admin was created by an operator, so they keep
      -- the right to manage the service.
      ALTER TABLE principals ADD COLUMN IF NOT EXISTS platform_admin BOOLEAN NOT NULL DEFAULT false;
      UPDATE principals p SET platform_admin = true
       WHERE EXISTS (SELECT 1 FROM memberships m WHERE m.principal_id = p.id AND m.role = 'admin');

      -- One-time sign-in links. Only the SHA-256 of the token is stored, so
      -- the table is not a list of usable links. Looked up before anyone is
      -- signed in, like sessions, by exact parameterized paths only.
      CREATE TABLE IF NOT EXISTS login_links (
        id          TEXT PRIMARY KEY,
        email       TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at  TIMESTAMPTZ NOT NULL,
        used_at     TIMESTAMPTZ,
        ip          TEXT
      );
      CREATE INDEX IF NOT EXISTS login_links_email_idx ON login_links (email, created_at DESC);
      CREATE INDEX IF NOT EXISTS login_links_expiry_idx ON login_links (expires_at);

      -- The outgoing mail account (one row). The password is encrypted with
      -- OBJECT_ENCRYPTION_KEY before it is written.
      CREATE TABLE IF NOT EXISTS mail_settings (
        id            TEXT PRIMARY KEY CHECK (id = 'default'),
        host          TEXT NOT NULL,
        port          INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
        security      TEXT NOT NULL CHECK (security IN ('tls', 'starttls', 'none')),
        username      TEXT NOT NULL DEFAULT '',
        password_enc  TEXT,
        from_name     TEXT NOT NULL DEFAULT 'Kindgleam',
        from_email    TEXT NOT NULL,
        updated_by    TEXT REFERENCES principals(id) ON DELETE SET NULL,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Sign-up creates a person, their organization, their workspace and
      -- their admin membership at once. The runtime role may only read those
      -- tables, so it gets this one narrow door instead of INSERT on all four.
      -- It runs as the schema owner and states its own scope, so the row
      -- security checks see exactly the rows it creates and nothing else.
      CREATE OR REPLACE FUNCTION kg_sign_up(p_email TEXT, p_name TEXT, p_max_bytes BIGINT, p_max_objects INTEGER)
      RETURNS TEXT
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_temp
      AS $fn$
      DECLARE
        v_email TEXT := lower(btrim(p_email));
        v_principal TEXT;
        v_workspace TEXT := 'ws-' || replace(gen_random_uuid()::text, '-', '');
        v_org TEXT := 'org-' || v_workspace;
      BEGIN
        IF v_email !~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' OR length(v_email) > 254 THEN
          RAISE EXCEPTION 'invalid email' USING ERRCODE = '22023';
        END IF;
        SELECT id INTO v_principal FROM principals WHERE email = v_email;
        IF v_principal IS NOT NULL THEN
          RETURN v_principal;
        END IF;
        v_principal := gen_random_uuid()::text;
        PERFORM set_config('app.principal_id', v_principal, true),
                set_config('app.workspace_id', v_workspace, true),
                set_config('app.organization_id', v_org, true);
        INSERT INTO principals (id, kind, name, email)
        VALUES (v_principal, 'user', COALESCE(NULLIF(btrim(p_name), ''), split_part(v_email, '@', 1)), v_email);
        INSERT INTO organizations (id, name, type) VALUES (v_org, 'Personal', 'personal');
        INSERT INTO workspaces (id, name, max_bytes, max_objects, organization_id)
        VALUES (v_workspace, 'Personal', p_max_bytes, p_max_objects, v_org);
        INSERT INTO memberships (workspace_id, principal_id, role) VALUES (v_workspace, v_principal, 'admin');
        RETURN v_principal;
      EXCEPTION WHEN unique_violation THEN
        -- The same address signed up twice at once: both get the one account.
        SELECT id INTO v_principal FROM principals WHERE email = v_email;
        RETURN v_principal;
      END
      $fn$;
      REVOKE ALL ON FUNCTION kg_sign_up(TEXT, TEXT, BIGINT, INTEGER) FROM PUBLIC;
    `
  }
  ,{
    version: 33,
    name: 'sign-in-codes',
    sql: `
      -- Each sign-in email also carries an 8-digit code, for when the email is
      -- read on another device. Stored as a hash salted with the link's own
      -- id; wrong guesses are counted so the code cannot be brute-forced.
      ALTER TABLE login_links ADD COLUMN IF NOT EXISTS code_hash TEXT;
      ALTER TABLE login_links ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
    `
  }
  ,{
    version: 34,
    name: 'sign-in-ip-index',
    sql: `
      -- Sign-in requests are capped per network address; count them by index.
      CREATE INDEX IF NOT EXISTS login_links_ip_idx ON login_links (ip, created_at DESC);
    `
  }
  ,{
    version: 35,
    name: 'application-encryption-for-private-data',
    sql: `
      -- High-sensitivity billing metadata is encrypted by the application with
      -- a dedicated deployment key. Legacy columns remain only as empty
      -- compatibility fields after backfill; payment-card data is never stored.
      ALTER TABLE workspace_billing
        ADD COLUMN IF NOT EXISTS billing_private_enc TEXT,
        ADD COLUMN IF NOT EXISTS billing_encryption_version INTEGER NOT NULL DEFAULT 0;

      -- Individual user memory is private content. The encrypted content and a
      -- keyed lookup digest let the app search without keeping the memory text
      -- or normalized plaintext in PostgreSQL.
      ALTER TABLE memories
        ADD COLUMN IF NOT EXISTS content_enc TEXT,
        ADD COLUMN IF NOT EXISTS normalized_digest TEXT,
        ADD COLUMN IF NOT EXISTS encryption_version INTEGER NOT NULL DEFAULT 0;

      DROP INDEX IF EXISTS memories_scope_normalized_idx;
      CREATE UNIQUE INDEX IF NOT EXISTS memories_scope_digest_idx
        ON memories (workspace_id, principal_id, COALESCE(conversation_id, ''), normalized_digest)
        WHERE normalized_digest IS NOT NULL AND normalized_digest <> '';
      CREATE INDEX IF NOT EXISTS memories_scope_time_idx
        ON memories (workspace_id, principal_id, conversation_id, updated_at DESC);
    `
  }
  ,{
    version: 36,
    name: 'encrypt-private-feedback',
    sql: `
      -- Feedback notes and answer excerpts can contain private user/workspace
      -- content. Keep searchable status/reason fields separate from the text.
      ALTER TABLE safety_reports
        ADD COLUMN IF NOT EXISTS note_enc TEXT,
        ADD COLUMN IF NOT EXISTS excerpt_enc TEXT,
        ADD COLUMN IF NOT EXISTS encryption_version INTEGER NOT NULL DEFAULT 0;
    `
  }
  ,{
    version: 37,
    name: 'allow-encrypted-memory-columns',
    sql: `
      -- Encrypted memory rows intentionally keep plaintext content/normalized
      -- blank. Remove the legacy plaintext-only constraints and let the
      -- encrypted representation enforce that a memory still has content.
      ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_content_check;
      ALTER TABLE memories
        ADD CONSTRAINT memories_content_check CHECK (
          (encryption_version = 1 AND content_enc IS NOT NULL AND length(content_enc) > 0)
          OR length(content) BETWEEN 1 AND 500
        );

      -- The old unique constraint indexed plaintext normalized content. It
      -- would collapse every encrypted row to the same empty value.
      ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_workspace_id_principal_id_normalized_key;
    `
  }
  ,{
    version: 38,
    name: 'billing-and-webhook-rls',
    sql: `
      -- Workspace members may read plan status, but only workspace admins or
      -- the signed Stripe webhook context may change billing state.
      DROP POLICY IF EXISTS workspace_billing_policy ON workspace_billing;
      CREATE POLICY workspace_billing_read ON workspace_billing
        FOR SELECT
        USING (workspace_billing.workspace_id = current_setting('app.workspace_id', true));
      CREATE POLICY workspace_billing_insert ON workspace_billing
        FOR INSERT
        WITH CHECK (
          workspace_billing.workspace_id = current_setting('app.workspace_id', true)
          AND current_setting('app.role', true) IN ('admin', 'billing-webhook')
        );
      CREATE POLICY workspace_billing_update ON workspace_billing
        FOR UPDATE
        USING (
          workspace_billing.workspace_id = current_setting('app.workspace_id', true)
          AND current_setting('app.role', true) IN ('admin', 'billing-webhook')
        )
        WITH CHECK (
          workspace_billing.workspace_id = current_setting('app.workspace_id', true)
          AND current_setting('app.role', true) IN ('admin', 'billing-webhook')
        );
      CREATE POLICY workspace_billing_delete ON workspace_billing
        FOR DELETE
        USING (
          workspace_billing.workspace_id = current_setting('app.workspace_id', true)
          AND current_setting('app.role', true) = 'admin'
        );
    `
  }
  ,{
    version: 39,
    name: 'encrypt-idempotency-replays',
    sql: `
      -- Idempotency responses can contain private workflow data. Keep the
      -- replayable copy encrypted and remove the plaintext JSONB body.
      ALTER TABLE idempotency_keys
        ADD COLUMN IF NOT EXISTS response_enc TEXT,
        ADD COLUMN IF NOT EXISTS encryption_version INTEGER NOT NULL DEFAULT 0;
    `
  }
  ,{
    version: 40,
    name: 'encrypt-audit-details',
    sql: `
      -- Audit metadata remains searchable, but arbitrary detail is encrypted
      -- because it may contain private workflow context.
      ALTER TABLE audit_log
        ADD COLUMN IF NOT EXISTS detail_enc TEXT,
        ADD COLUMN IF NOT EXISTS detail_encryption_version INTEGER NOT NULL DEFAULT 0;
    `
  }
  ,{
    version: 41,
    name: 'workspace-project-sources',
    sql: `
      CREATE TABLE IF NOT EXISTS workspace_sources (
        id                TEXT PRIMARY KEY,
        workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id      TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        kind              TEXT NOT NULL CHECK (kind IN ('local-folder', 'github')),
        name              TEXT NOT NULL,
        provider_key      TEXT,
        repo_owner        TEXT,
        repo_name         TEXT,
        repo_ref          TEXT,
        snapshot_object_id TEXT REFERENCES objects(id) ON DELETE SET NULL,
        credentials_enc   TEXT,
        permissions       JSONB NOT NULL DEFAULT '{}'::jsonb,
        metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
        revoked_at        TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS workspace_sources_scope_idx
        ON workspace_sources (workspace_id, principal_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS workspace_sources_provider_idx
        ON workspace_sources (kind, provider_key);
      ALTER TABLE workspace_sources ENABLE ROW LEVEL SECURITY;
      ALTER TABLE workspace_sources FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS workspace_sources_policy ON workspace_sources;
      CREATE POLICY workspace_sources_policy ON workspace_sources
        USING (
          workspace_sources.workspace_id = current_setting('app.workspace_id', true)
          AND (
            workspace_sources.principal_id = current_setting('app.principal_id', true)
            OR current_setting('app.role', true) IN ('admin', 'service')
          )
        )
        WITH CHECK (
          workspace_sources.workspace_id = current_setting('app.workspace_id', true)
          AND workspace_sources.principal_id = current_setting('app.principal_id', true)
        );
      REVOKE ALL ON workspace_sources FROM PUBLIC;
    `
  }
  ,{
    version: 42,
    name: 'unified-agent-workspace-rag-state',
    sql: `
      CREATE TABLE IF NOT EXISTS run_agents (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        task_id TEXT,
        role TEXT NOT NULL,
        model_id TEXT,
        state TEXT NOT NULL DEFAULT 'pending',
        wave_index INTEGER NOT NULL DEFAULT 0,
        finding JSONB,
        error_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        UNIQUE(run_id, role, wave_index)
      );
      CREATE INDEX IF NOT EXISTS run_agents_run_idx ON run_agents(run_id, wave_index, state);

      CREATE TABLE IF NOT EXISTS run_waves (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        wave_index INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        agent_count INTEGER NOT NULL DEFAULT 0,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE(run_id, wave_index)
      );
      CREATE INDEX IF NOT EXISTS run_waves_run_idx ON run_waves(run_id, wave_index);

      CREATE TABLE IF NOT EXISTS code_workspace_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        project_id TEXT,
        source_id TEXT REFERENCES workspace_sources(id) ON DELETE SET NULL,
        conversation_id TEXT,
        branch TEXT,
        base_revision TEXT,
        state TEXT NOT NULL DEFAULT 'active',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        closed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS code_workspace_sessions_scope_idx ON code_workspace_sessions(workspace_id, principal_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS code_workspace_sessions_project_idx ON code_workspace_sessions(workspace_id, project_id, branch, updated_at DESC);

      CREATE TABLE IF NOT EXISTS rag_documents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        title TEXT,
        content_enc TEXT NOT NULL,
        search_terms JSONB NOT NULL DEFAULT '[]'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        content_digest TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(workspace_id, source_id, chunk_index)
      );
      CREATE INDEX IF NOT EXISTS rag_documents_scope_idx ON rag_documents(workspace_id, principal_id, source_type, source_id);
      CREATE INDEX IF NOT EXISTS rag_documents_terms_idx ON rag_documents USING GIN(search_terms);

      ALTER TABLE run_agents ENABLE ROW LEVEL SECURITY;
      ALTER TABLE run_agents FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS run_agents_scope_policy ON run_agents;
      CREATE POLICY run_agents_scope_policy ON run_agents USING (
        EXISTS (SELECT 1 FROM runs r WHERE r.id = run_agents.run_id
          AND r.workspace_id = current_setting('app.workspace_id', true)
          AND (r.visibility = 'workspace' OR r.principal_id = current_setting('app.principal_id', true)))
      ) WITH CHECK (
        EXISTS (SELECT 1 FROM runs r WHERE r.id = run_agents.run_id
          AND r.workspace_id = current_setting('app.workspace_id', true)
          AND (r.visibility = 'workspace' OR r.principal_id = current_setting('app.principal_id', true)))
      );

      ALTER TABLE run_waves ENABLE ROW LEVEL SECURITY;
      ALTER TABLE run_waves FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS run_waves_scope_policy ON run_waves;
      CREATE POLICY run_waves_scope_policy ON run_waves USING (
        EXISTS (SELECT 1 FROM runs r WHERE r.id = run_waves.run_id
          AND r.workspace_id = current_setting('app.workspace_id', true)
          AND (r.visibility = 'workspace' OR r.principal_id = current_setting('app.principal_id', true)))
      ) WITH CHECK (
        EXISTS (SELECT 1 FROM runs r WHERE r.id = run_waves.run_id
          AND r.workspace_id = current_setting('app.workspace_id', true)
          AND (r.visibility = 'workspace' OR r.principal_id = current_setting('app.principal_id', true)))
      );

      ALTER TABLE code_workspace_sessions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE code_workspace_sessions FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS code_workspace_sessions_scope_policy ON code_workspace_sessions;
      CREATE POLICY code_workspace_sessions_scope_policy ON code_workspace_sessions USING (
        code_workspace_sessions.workspace_id = current_setting('app.workspace_id', true)
        AND code_workspace_sessions.principal_id = current_setting('app.principal_id', true)
      ) WITH CHECK (
        code_workspace_sessions.workspace_id = current_setting('app.workspace_id', true)
        AND code_workspace_sessions.principal_id = current_setting('app.principal_id', true)
      );

      ALTER TABLE rag_documents ENABLE ROW LEVEL SECURITY;
      ALTER TABLE rag_documents FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS rag_documents_scope_policy ON rag_documents;
      CREATE POLICY rag_documents_scope_policy ON rag_documents USING (
        rag_documents.workspace_id = current_setting('app.workspace_id', true)
        AND rag_documents.principal_id = current_setting('app.principal_id', true)
      ) WITH CHECK (
        rag_documents.workspace_id = current_setting('app.workspace_id', true)
        AND rag_documents.principal_id = current_setting('app.principal_id', true)
      );

      REVOKE ALL ON run_agents, run_waves, code_workspace_sessions, rag_documents FROM PUBLIC;
        `
  }
  ,{
    version: 43,
    name: 'encrypted-run-blackboard',
    sql: `
      CREATE TABLE IF NOT EXISTS run_blackboards (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        version INTEGER NOT NULL DEFAULT 1,
        state_enc TEXT NOT NULL,
        state_digest TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(run_id)
      );
      CREATE INDEX IF NOT EXISTS run_blackboards_scope_idx
        ON run_blackboards(workspace_id, principal_id, updated_at DESC);
      ALTER TABLE run_blackboards ENABLE ROW LEVEL SECURITY;
      ALTER TABLE run_blackboards FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS run_blackboards_scope_policy ON run_blackboards;
      CREATE POLICY run_blackboards_scope_policy ON run_blackboards
        USING (
          run_blackboards.workspace_id = current_setting('app.workspace_id', true)
          AND run_blackboards.principal_id = current_setting('app.principal_id', true)
        )
        WITH CHECK (
          run_blackboards.workspace_id = current_setting('app.workspace_id', true)
          AND run_blackboards.principal_id = current_setting('app.principal_id', true)
        );
      REVOKE ALL ON run_blackboards FROM PUBLIC;
    `
  }
  ,{
    version: 44,
    name: 'memory-layer-expansion',
    sql: `
      ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_kind_check;
      ALTER TABLE memories ADD CONSTRAINT memories_kind_check
        CHECK (kind IN ('about', 'preference', 'project', 'fact', 'episodic', 'semantic'));
    `
  }  ,{
    version: 45,
    name: 'encrypted-adaptive-context-cache',
    sql: `
      CREATE TABLE IF NOT EXISTS adaptive_cache (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        namespace TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        value_enc TEXT NOT NULL,
        source_fingerprint TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(workspace_id, principal_id, namespace, cache_key)
      );
      CREATE INDEX IF NOT EXISTS adaptive_cache_expiry_idx ON adaptive_cache(expires_at);
      CREATE INDEX IF NOT EXISTS adaptive_cache_scope_idx ON adaptive_cache(workspace_id, principal_id, namespace, updated_at DESC);
      ALTER TABLE adaptive_cache ENABLE ROW LEVEL SECURITY;
      ALTER TABLE adaptive_cache FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS adaptive_cache_scope_policy ON adaptive_cache;
      CREATE POLICY adaptive_cache_scope_policy ON adaptive_cache
        USING (
          adaptive_cache.workspace_id = current_setting('app.workspace_id', true)
          AND adaptive_cache.principal_id = current_setting('app.principal_id', true)
        )
        WITH CHECK (
          adaptive_cache.workspace_id = current_setting('app.workspace_id', true)
          AND adaptive_cache.principal_id = current_setting('app.principal_id', true)
        );
      REVOKE ALL ON adaptive_cache FROM PUBLIC;
    `
  }  ,{
    version: 46,
    name: 'run-outcome-feedback',
    sql: `
      CREATE TABLE IF NOT EXISTS run_feedback (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        rating TEXT NOT NULL CHECK (rating IN ('positive', 'negative')),
        reason TEXT NOT NULL CHECK (reason IN ('correct','incorrect','incomplete','unsafe','too-slow','too-expensive','other')),
        note_enc TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(run_id, principal_id)
      );
      CREATE INDEX IF NOT EXISTS run_feedback_scope_idx ON run_feedback(workspace_id, principal_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS run_feedback_run_idx ON run_feedback(run_id, created_at DESC);
      ALTER TABLE run_feedback ENABLE ROW LEVEL SECURITY;
      ALTER TABLE run_feedback FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS run_feedback_scope_policy ON run_feedback;
      CREATE POLICY run_feedback_scope_policy ON run_feedback
        USING (
          run_feedback.workspace_id = current_setting('app.workspace_id', true)
          AND run_feedback.principal_id = current_setting('app.principal_id', true)
        )
        WITH CHECK (
          run_feedback.workspace_id = current_setting('app.workspace_id', true)
          AND run_feedback.principal_id = current_setting('app.principal_id', true)
        );
      REVOKE ALL ON run_feedback FROM PUBLIC;
    `
  }  ,{
    version: 47,
    name: 'rag-principal-isolation-constraint',
    sql: `
      ALTER TABLE rag_documents DROP CONSTRAINT IF EXISTS rag_documents_workspace_id_source_id_chunk_index_key;
      CREATE UNIQUE INDEX IF NOT EXISTS rag_documents_owner_source_chunk_idx
        ON rag_documents (workspace_id, principal_id, source_id, chunk_index);
    `
  },
  {
    version: 48,
    name: 'tamper-evident-audit-and-runtime-grants',
    sql: `
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      ALTER TABLE audit_log
        ADD COLUMN IF NOT EXISTS prev_hash TEXT,
        ADD COLUMN IF NOT EXISTS entry_hash TEXT;

      DROP TRIGGER IF EXISTS audit_log_no_update_delete ON audit_log;

      DO $audit$
      DECLARE
        previous_hash TEXT := NULL;
        item RECORD;
        canonical TEXT;
        current_hash TEXT;
      BEGIN
        FOR item IN
          SELECT id, at, principal_id, workspace_id, action, target, outcome,
                 detail_enc, detail_encryption_version, request_id, ip
            FROM audit_log
           ORDER BY id
        LOOP
          canonical :=
            COALESCE(item.id::text, '') || E'\\x1f' ||
            COALESCE(item.at::text, '') || E'\\x1f' ||
            COALESCE(item.principal_id, '') || E'\\x1f' ||
            COALESCE(item.workspace_id, '') || E'\\x1f' ||
            COALESCE(item.action, '') || E'\\x1f' ||
            COALESCE(item.target, '') || E'\\x1f' ||
            COALESCE(item.outcome, '') || E'\\x1f' ||
            COALESCE(item.detail_enc, '') || E'\\x1f' ||
            COALESCE(item.detail_encryption_version::text, '') || E'\\x1f' ||
            COALESCE(item.request_id, '') || E'\\x1f' ||
            COALESCE(item.ip, '') || E'\\x1f' ||
            COALESCE(previous_hash, '');
          current_hash := encode(digest(canonical, 'sha256'), 'hex');
          UPDATE audit_log
             SET prev_hash = previous_hash, entry_hash = current_hash
           WHERE id = item.id;
          previous_hash := current_hash;
        END LOOP;
      END
      $audit$;

      CREATE UNIQUE INDEX IF NOT EXISTS audit_log_entry_hash_uidx
        ON audit_log(entry_hash);
      CREATE INDEX IF NOT EXISTS audit_log_hash_idx
        ON audit_log(workspace_id, id DESC, entry_hash);

      CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'audit_log is append-only';
      END;
      $$;

      DROP TRIGGER IF EXISTS audit_log_no_update_delete ON audit_log;
      CREATE TRIGGER audit_log_no_update_delete
      BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW
      EXECUTE FUNCTION prevent_audit_log_mutation();
    `
  },
  {
    version: 49,
    name: 'scope-audit-chain-to-tenant',
    sql: `
      -- A runtime tenant can only read its own audit rows under FORCE RLS.
      -- Rebuild the chain per workspace (and one separate global chain for
      -- workspace-less authentication events) so verification remains possible
      -- without crossing tenant boundaries.
      DROP TRIGGER IF EXISTS audit_log_no_update_delete ON audit_log;

      DO $audit$
      DECLARE
        previous_by_scope JSONB := '{}'::jsonb;
        item RECORD;
        scope_key TEXT;
        previous_hash TEXT;
        canonical TEXT;
        current_hash TEXT;
      BEGIN
        FOR item IN
          SELECT id, at, principal_id, workspace_id, action, target, outcome,
                 detail_enc, detail_encryption_version, request_id, ip
            FROM audit_log
           ORDER BY id
        LOOP
          scope_key := CASE WHEN item.workspace_id IS NULL THEN 'G:NULL' ELSE 'W:' || item.workspace_id END;
          previous_hash := NULLIF(previous_by_scope ->> scope_key, '');
          canonical :=
            COALESCE(item.id::text, '') || E'\\x1f' ||
            COALESCE(item.at::text, '') || E'\\x1f' ||
            COALESCE(item.principal_id, '') || E'\\x1f' ||
            COALESCE(item.workspace_id, '') || E'\\x1f' ||
            COALESCE(item.action, '') || E'\\x1f' ||
            COALESCE(item.target, '') || E'\\x1f' ||
            COALESCE(item.outcome, '') || E'\\x1f' ||
            COALESCE(item.detail_enc, '') || E'\\x1f' ||
            COALESCE(item.detail_encryption_version::text, '') || E'\\x1f' ||
            COALESCE(item.request_id, '') || E'\\x1f' ||
            COALESCE(item.ip, '') || E'\\x1f' ||
            COALESCE(previous_hash, '');
          current_hash := encode(digest(canonical, 'sha256'), 'hex');
          UPDATE audit_log
             SET prev_hash = previous_hash, entry_hash = current_hash
           WHERE id = item.id;
          previous_by_scope := jsonb_set(previous_by_scope, ARRAY[scope_key], to_jsonb(current_hash), true);
        END LOOP;
      END
      $audit$;

      CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'audit_log is append-only';
      END;
      $$;

      DROP TRIGGER IF EXISTS audit_log_no_update_delete ON audit_log;
      CREATE TRIGGER audit_log_no_update_delete
      BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW
      EXECUTE FUNCTION prevent_audit_log_mutation();
    `
  },
  {
    version: 50,
    name: 'governed-evolution-proposals',
    sql: `
      CREATE TABLE IF NOT EXISTS evolution_proposals (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        feedback_id TEXT REFERENCES run_feedback(id) ON DELETE CASCADE,
        target TEXT NOT NULL CHECK (target IN ('retrieval','reasoning','verification','orchestration','efficiency','safety')),
        status TEXT NOT NULL DEFAULT 'candidate'
          CHECK (status IN ('candidate','approved','rejected','implemented')),
        summary_enc TEXT NOT NULL,
        evidence_enc TEXT,
        fingerprint TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(feedback_id, target)
      );
      CREATE INDEX IF NOT EXISTS evolution_proposals_scope_idx
        ON evolution_proposals(workspace_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS evolution_proposals_run_idx
        ON evolution_proposals(run_id, created_at DESC);

      ALTER TABLE evolution_proposals ENABLE ROW LEVEL SECURITY;
      ALTER TABLE evolution_proposals FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS evolution_proposals_scope_policy ON evolution_proposals;
      CREATE POLICY evolution_proposals_scope_policy ON evolution_proposals
        USING (
          evolution_proposals.workspace_id = current_setting('app.workspace_id', true)
          AND (
            evolution_proposals.principal_id = current_setting('app.principal_id', true)
            OR current_setting('app.role', true) IN ('admin', 'service')
          )
        )
        WITH CHECK (
          evolution_proposals.workspace_id = current_setting('app.workspace_id', true)
          AND evolution_proposals.principal_id = current_setting('app.principal_id', true)
        );
      REVOKE ALL ON evolution_proposals FROM PUBLIC;
    `
  },
  {
    version: 51,
    name: 'evolution-admin-update-policy',
    sql: `
      DROP POLICY IF EXISTS evolution_proposals_scope_policy ON evolution_proposals;
      CREATE POLICY evolution_proposals_scope_policy ON evolution_proposals
        USING (
          evolution_proposals.workspace_id = current_setting('app.workspace_id', true)
          AND (
            evolution_proposals.principal_id = current_setting('app.principal_id', true)
            OR current_setting('app.role', true) IN ('admin', 'service')
          )
        )
        WITH CHECK (
          evolution_proposals.workspace_id = current_setting('app.workspace_id', true)
          AND (
            evolution_proposals.principal_id = current_setting('app.principal_id', true)
            OR current_setting('app.role', true) IN ('admin', 'service')
          )
        );
    `
  },
  {
    version: 52,
    name: 'secure-audit-chain-head-lookup',
    sql: `
      -- Audit-chain continuity must not depend on the caller being allowed
      -- to read audit rows. The function is SECURITY DEFINER, locked to the
      -- migration/maintenance owner, and uses a fixed search path.
      CREATE OR REPLACE FUNCTION kg_audit_previous_hash(target_workspace TEXT)
      RETURNS TEXT
      LANGUAGE SQL
      SECURITY DEFINER
      SET search_path = public, pg_temp
      SET row_security = off
      AS $audit$
        SELECT entry_hash
          FROM audit_log
         WHERE workspace_id IS NOT DISTINCT FROM target_workspace
         ORDER BY id DESC
         LIMIT 1
      $audit$;

      REVOKE ALL ON FUNCTION kg_audit_previous_hash(TEXT) FROM PUBLIC;
    `
  },
  {
    version: 53,
    name: 'remove-legacy-simulation-schedules',
    sql: `
      -- Simulation is no longer an executable/schedulable capability. Remove
      -- the obsolete database enum-like constraint so old clients cannot
      -- resurrect that surface through direct writes.
      ALTER TABLE schedules
        DROP CONSTRAINT IF EXISTS schedules_kind_check;
      ALTER TABLE schedules
        ADD CONSTRAINT schedules_kind_check
        CHECK (kind IN ('reminder', 'ask'));
    `
  },
  {
    version: 54,
    name: 'adaptive-skill-learning',
    sql: `
      CREATE TABLE IF NOT EXISTS skill_profiles (
        workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id       TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        skill_name         TEXT NOT NULL,
        task_type          TEXT NOT NULL DEFAULT '',
        success_count      INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
        failure_count      INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
        uncertain_count    INTEGER NOT NULL DEFAULT 0 CHECK (uncertain_count >= 0),
        confidence         DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
        utility_ema        DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (utility_ema >= -1 AND utility_ema <= 1),
        last_observed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, principal_id, skill_name, task_type)
      );

      CREATE INDEX IF NOT EXISTS skill_profiles_lookup_idx
        ON skill_profiles(workspace_id, principal_id, task_type, last_observed_at DESC);

      CREATE TABLE IF NOT EXISTS skill_observations (
        id                 TEXT PRIMARY KEY,
        workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id       TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        run_id             TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        task_id            TEXT NOT NULL,
        skill_name         TEXT NOT NULL,
        task_type          TEXT NOT NULL DEFAULT '',
        outcome            TEXT NOT NULL CHECK (outcome IN ('success','failure','uncertain')),
        source             TEXT NOT NULL CHECK (source IN ('execution','feedback','verification','repair')),
        reason             TEXT NOT NULL DEFAULT '',
        signal             DOUBLE PRECISION NOT NULL CHECK (signal >= -1 AND signal <= 1),
        event_key          TEXT NOT NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, principal_id, run_id, task_id, skill_name, source, event_key)
      );

      CREATE INDEX IF NOT EXISTS skill_observations_scope_idx
        ON skill_observations(workspace_id, principal_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS skill_observations_skill_idx
        ON skill_observations(workspace_id, principal_id, skill_name, task_type, created_at DESC);

      ALTER TABLE skill_profiles ENABLE ROW LEVEL SECURITY;
      ALTER TABLE skill_profiles FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS skill_profiles_scope_policy ON skill_profiles;
      CREATE POLICY skill_profiles_scope_policy ON skill_profiles
        USING (
          skill_profiles.workspace_id = current_setting('app.workspace_id', true)
          AND skill_profiles.principal_id = current_setting('app.principal_id', true)
        )
        WITH CHECK (
          skill_profiles.workspace_id = current_setting('app.workspace_id', true)
          AND skill_profiles.principal_id = current_setting('app.principal_id', true)
        );

      ALTER TABLE skill_observations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE skill_observations FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS skill_observations_scope_policy ON skill_observations;
      CREATE POLICY skill_observations_scope_policy ON skill_observations
        USING (
          skill_observations.workspace_id = current_setting('app.workspace_id', true)
          AND skill_observations.principal_id = current_setting('app.principal_id', true)
        )
        WITH CHECK (
          skill_observations.workspace_id = current_setting('app.workspace_id', true)
          AND skill_observations.principal_id = current_setting('app.principal_id', true)
        );

      REVOKE ALL ON skill_profiles FROM PUBLIC;
      REVOKE ALL ON skill_observations FROM PUBLIC;
    `
  },
  {
    version: 55,
    name: 'skill-context-patterns',
    sql: `
      ALTER TABLE skill_observations
        ADD COLUMN IF NOT EXISTS context_signature TEXT NOT NULL DEFAULT '';

      CREATE INDEX IF NOT EXISTS skill_observations_context_idx
        ON skill_observations(workspace_id, principal_id, context_signature, skill_name, task_type, created_at DESC);
    `
  },
  {
    version: 56,
    name: 'skill-pattern-intelligence',
    sql: `
      CREATE TABLE IF NOT EXISTS skill_patterns (
        workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        principal_id      TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        skill_name        TEXT NOT NULL,
        task_type         TEXT NOT NULL DEFAULT '',
        context_signature TEXT NOT NULL DEFAULT '',
        pattern_kind      TEXT NOT NULL CHECK (pattern_kind IN ('context-outcome','failure')),
        pattern_key       TEXT NOT NULL,
        success_count     INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
        failure_count     INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
        uncertain_count   INTEGER NOT NULL DEFAULT 0 CHECK (uncertain_count >= 0),
        utility_ema       DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (utility_ema >= -1 AND utility_ema <= 1),
        last_observed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, principal_id, skill_name, task_type, context_signature, pattern_kind, pattern_key)
      );
      CREATE INDEX IF NOT EXISTS skill_patterns_lookup_idx ON skill_patterns(workspace_id, principal_id, skill_name, task_type, context_signature, last_observed_at DESC);
      CREATE INDEX IF NOT EXISTS skill_patterns_failure_idx ON skill_patterns(workspace_id, principal_id, context_signature, pattern_kind, last_observed_at DESC);
      ALTER TABLE skill_patterns ENABLE ROW LEVEL SECURITY;
      ALTER TABLE skill_patterns FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS skill_patterns_scope_policy ON skill_patterns;
      CREATE POLICY skill_patterns_scope_policy ON skill_patterns
        USING (skill_patterns.workspace_id = current_setting('app.workspace_id', true) AND skill_patterns.principal_id = current_setting('app.principal_id', true))
        WITH CHECK (skill_patterns.workspace_id = current_setting('app.workspace_id', true) AND skill_patterns.principal_id = current_setting('app.principal_id', true));
      REVOKE ALL ON skill_patterns FROM PUBLIC;
    `
  }
  ,{
    version: 57,
    name: 'fleet-project-control-plane',
    sql: "CREATE TABLE IF NOT EXISTS fleet_projects (\n id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,\n name TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','archived')), priority INTEGER NOT NULL DEFAULT 0 CHECK (priority >= 0 AND priority <= 1000),\n max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrency >= 1 AND max_concurrency <= 8), source_id TEXT REFERENCES workspace_sources(id) ON DELETE SET NULL, current_revision TEXT,\n budget_tokens BIGINT CHECK (budget_tokens IS NULL OR budget_tokens >= 0), budget_compute_ms BIGINT CHECK (budget_compute_ms IS NULL OR budget_compute_ms >= 0),\n in_flight INTEGER NOT NULL DEFAULT 0 CHECK (in_flight >= 0), success_count BIGINT NOT NULL DEFAULT 0 CHECK (success_count >= 0), failure_count BIGINT NOT NULL DEFAULT 0 CHECK (failure_count >= 0),\n consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0), health JSONB NOT NULL DEFAULT '{\"score\":1}'::jsonb CHECK (jsonb_typeof(health)='object'),\n tags JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tags)='array'), policy JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(policy)='object'),\n next_dispatch_at TIMESTAMPTZ, last_dispatch_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());\nCREATE INDEX IF NOT EXISTS fleet_projects_scope_idx ON fleet_projects(workspace_id,state,priority DESC,updated_at DESC,id);\nCREATE INDEX IF NOT EXISTS fleet_projects_source_idx ON fleet_projects(workspace_id,source_id);\nCREATE TABLE IF NOT EXISTS fleet_project_dependencies (\n workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES fleet_projects(id) ON DELETE CASCADE, depends_on_project_id TEXT NOT NULL REFERENCES fleet_projects(id) ON DELETE CASCADE,\n PRIMARY KEY (workspace_id,project_id,depends_on_project_id), CHECK (project_id <> depends_on_project_id));\nCREATE INDEX IF NOT EXISTS fleet_project_dependencies_dependency_idx ON fleet_project_dependencies(workspace_id,depends_on_project_id,project_id);\nCREATE TABLE IF NOT EXISTS fleet_dispatches (\n id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES fleet_projects(id) ON DELETE CASCADE,\n state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed','cancelled')), payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload)='object'),\n attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0), max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1 AND max_attempts <= 8), lease_until TIMESTAMPTZ, worker_id TEXT,\n available_at TIMESTAMPTZ NOT NULL DEFAULT now(), started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, cost_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cost_tokens >= 0),\n cost_compute_ms BIGINT NOT NULL DEFAULT 0 CHECK (cost_compute_ms >= 0), error TEXT, metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),\n created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());\nCREATE INDEX IF NOT EXISTS fleet_dispatches_queue_idx ON fleet_dispatches(workspace_id,state,available_at,created_at,id);\nCREATE INDEX IF NOT EXISTS fleet_dispatches_project_idx ON fleet_dispatches(workspace_id,project_id,state,updated_at DESC);\nCREATE INDEX IF NOT EXISTS fleet_dispatches_lease_idx ON fleet_dispatches(state,lease_until);\nALTER TABLE fleet_projects ENABLE ROW LEVEL SECURITY; ALTER TABLE fleet_projects FORCE ROW LEVEL SECURITY;\nDROP POLICY IF EXISTS fleet_projects_scope_policy ON fleet_projects;\nCREATE POLICY fleet_projects_scope_policy ON fleet_projects USING ((fleet_projects.workspace_id=current_setting('app.workspace_id',true) AND fleet_projects.principal_id=current_setting('app.principal_id',true)) OR current_setting('app.role',true) IN ('admin','service','job-worker')) WITH CHECK ((fleet_projects.workspace_id=current_setting('app.workspace_id',true) AND fleet_projects.principal_id=current_setting('app.principal_id',true)) OR current_setting('app.role',true) IN ('admin','service','job-worker'));\nALTER TABLE fleet_project_dependencies ENABLE ROW LEVEL SECURITY; ALTER TABLE fleet_project_dependencies FORCE ROW LEVEL SECURITY;\nDROP POLICY IF EXISTS fleet_project_dependencies_scope_policy ON fleet_project_dependencies;\nCREATE POLICY fleet_project_dependencies_scope_policy ON fleet_project_dependencies USING (fleet_project_dependencies.workspace_id=current_setting('app.workspace_id',true) OR current_setting('app.role',true) IN ('admin','service','job-worker')) WITH CHECK (fleet_project_dependencies.workspace_id=current_setting('app.workspace_id',true) OR current_setting('app.role',true) IN ('admin','service','job-worker'));\nALTER TABLE fleet_dispatches ENABLE ROW LEVEL SECURITY; ALTER TABLE fleet_dispatches FORCE ROW LEVEL SECURITY;\nDROP POLICY IF EXISTS fleet_dispatches_scope_policy ON fleet_dispatches;\nCREATE POLICY fleet_dispatches_scope_policy ON fleet_dispatches USING ((fleet_dispatches.workspace_id=current_setting('app.workspace_id',true) AND fleet_dispatches.principal_id=current_setting('app.principal_id',true)) OR current_setting('app.role',true) IN ('admin','service','job-worker')) WITH CHECK ((fleet_dispatches.workspace_id=current_setting('app.workspace_id',true) AND fleet_dispatches.principal_id=current_setting('app.principal_id',true)) OR current_setting('app.role',true) IN ('admin','service','job-worker'));\nREVOKE ALL ON fleet_projects FROM PUBLIC; REVOKE ALL ON fleet_project_dependencies FROM PUBLIC; REVOKE ALL ON fleet_dispatches FROM PUBLIC;"
  }
];