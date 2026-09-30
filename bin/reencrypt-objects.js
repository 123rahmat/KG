#!/usr/bin/env node
import { loadConfig } from '../src/config.js';
import { createPool, migrate, reencryptPlaintextObjects } from '../src/db.js';
import { createLogger } from '../src/observability.js';

const config = loadConfig();
if (!config.security.objectEncryptionKey) throw new Error('OBJECT_ENCRYPTION_KEY is required');
const logger = createLogger({ level: config.logLevel });
// Re-encryption migrates the schema and rewrites every tenant's blobs, so it
// runs as the migration identity: the runtime role can do neither (no DDL,
// and row-level security limits it to one tenant).
const pool = createPool(config, logger, {
  connectionString: config.database.migrationUrl || config.database.url,
  applicationName: 'kindgleam-reencrypt'
});
try {
  await migrate(pool, logger);
  const count = await reencryptPlaintextObjects(pool, config.security.objectEncryptionKey, logger);
  logger.info('legacy object re-encryption complete', { objects: count });
} finally {
  await pool.end();
}