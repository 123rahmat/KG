# KG Code — clean source export

This branch provides a safe, reproducible **coding-focused source ZIP**. It is a portable checkout for review and a replacement build; it is **not** a production database backup.

## Build / download the ZIP

From a local checkout run:

```bash
npm run archive:code
```

The result is `dist/KG-Code-clean-source.zip`, containing the full committed source tree under `KG-Code/`. The release source can also be downloaded as GitHub's **Download ZIP** archive of this branch without running any build tools. GitHub's archive contains the committed tree, not the Git history.

## Clean-up boundary

- Retained all server authorization, project/tenant checks, verified execution gates, migrations, runtime and sandbox controls, the coding IDE UI, chat files, conversation history compatibility, and the supporting tests.
- Removed abandoned planning scratch documents from **this export branch only**; the protected main branch and the backup snapshot still keep their full histories.
- The code defaults `KG_CODING_ONLY=true` for **new** work. Historical non-coding records and supporting compatibility modules remain deliberately read-only where relevant. Deleting those modules without migration tests could make old attachments/history inaccessible.
- Local secrets (`.env`, credentials, `node_modules`, local backups and untracked build artifacts) must stay out of exports. The archive script reads committed `HEAD` only and rejects common tracked secret names.
- A ZIP file by itself is not an executable GitHub repository. Do **not** clear `main` to commit only a ZIP: keep the source, history, build/test config, and deployment definition as real tracked files.
- The running service is not validated by this export alone. Before any replacement: run `npm ci`, `npm run verify`, `npm run test:code:hardening`, PostgreSQL integration tests and the real browser/sandbox tests.

## Restore

The unmodified main-branch snapshot from October 10, 2026 is preserved at `backup/kg-code-main-20261010`. Do not force-push or delete the current `main`. For a future cutover, compare the source branch, run CI, then merge/fast-forward a verified source tree; do not replace the whole repository with a binary archive.
