-- Kindgleam: one-time PostgreSQL identity provisioning.
--
-- Run once as a database administrator (not as any application role):
--   psql "postgres://admin@host/postgres" -v db=kindgleam \
--        -v migrate_pw=... -v runtime_pw=... -v backup_pw=... -v restore_pw=... \
--        -f docs/sql/roles.sql
--
-- Four identities, one per plane. Each gets its own credential so access is
-- attributable and revocable on its own:
--
--   kindgleam_migrate  owns the schema; runs migrations at application boot
--   kindgleam_runtime  serves requests; DML only, cannot bypass RLS
--   kindgleam_backup   reads every row for pg_dump; not a superuser
--   kindgleam_restore  restores by acting as the schema owner (membership)
--
-- Everything else (CONNECT, schema usage, table grants for the runtime and
-- backup roles) is reconciled by the application on every boot, so grants
-- stay correct as migrations add tables.

CREATE ROLE kindgleam_migrate LOGIN PASSWORD :'migrate_pw' BYPASSRLS;
CREATE ROLE kindgleam_runtime LOGIN PASSWORD :'runtime_pw' NOBYPASSRLS;
CREATE ROLE kindgleam_backup  LOGIN PASSWORD :'backup_pw'  BYPASSRLS;
CREATE ROLE kindgleam_restore LOGIN PASSWORD :'restore_pw' BYPASSRLS;

-- Restore drops and recreates owned tables; membership lets it act as the
-- owner without sharing the migration credential. INHERIT FALSE means it
-- holds no owner privileges until pg_restore explicitly runs SET ROLE.
GRANT kindgleam_migrate TO kindgleam_restore WITH INHERIT FALSE, SET TRUE;

CREATE DATABASE :"db" OWNER kindgleam_migrate;
\connect :"db"
ALTER SCHEMA public OWNER TO kindgleam_migrate;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
