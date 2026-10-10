/**
 * Process bootstrap and lifecycle.
 *
 * Boots in a fixed order — config, logging, database, migrations, app — and
 * refuses to serve if any step fails, rather than accepting traffic in a half
 * configured state.
 */

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { loadConfig } from './src/config.js';
import { createPool, migrate, assertNoPlaintextObjects, assertRlsReady, assertMaintenanceBypassRls } from './src/db.js';
import { createLogger, createMetrics } from './src/observability.js';
import { backfillSensitiveData, assertSensitiveDataEncrypted } from './src/data-protection.js';
import { Identity } from './src/identity.js';
import { ObjectStore } from './src/objects.js';
import { RunStore } from './src/runs.js';
import { Audit } from './src/audit.js';
import { GovernanceStore } from './src/governance.js';
import { CapabilityStore } from './src/capability-store.js';
import { JobStore, createJobWorker } from './src/jobs.js';
import { Scheduler } from './src/scheduling.js';
import { createApp, VERSION } from './src/app.js';
import { attachTerminalServer } from './src/terminal.js';
import { FleetStore, createFleetWorker } from './src/fleet-control.js';
import { ProjectStore } from './src/projects.js';
import { providerConcurrencyStats } from './src/runtime.js';

/** Wire the object graph. Exported so tests build the same one. */
export function build({ config, logger, metrics, fetchImpl }) {
  const pool = createPool(config, logger);
  const audit = new Audit(pool, logger, {
    encryptionKey: config.security.personalDataEncryptionKey,
    previousEncryptionKey: config.security.personalDataEncryptionKeyPrevious
  });
  const governance = new GovernanceStore(pool);
  const capabilities = new CapabilityStore(pool, { audit });
  const identity = new Identity(pool, { sessionHours: config.limits.sessionHours });
  const objects = new ObjectStore(pool, {
    maxObjectBytes: config.limits.objectBytes,
    maxProvenanceBytes: config.limits.provenanceBytes,
    maxFieldChars: config.limits.fieldChars,
    encryptionKey: config.security.objectEncryptionKey,
    audit
  });
  const runs = new RunStore(pool, {
    maxAttempts: config.limits.runAttempts,
    maxEvidenceBytes: config.limits.evidenceBytes,
    maxGoalChars: config.limits.goalChars,
    audit,
    capabilities
  });
  const jobs = new JobStore(pool);
  const fleet = new FleetStore(pool);
  const projects = new ProjectStore(pool, {
    codingResearchOnly: config.product?.codingResearchOnly === true
  });
  // Reminders and scheduled questions (src/scheduling.js).
  const scheduler = new Scheduler({ pool, runs, identity, logger, metrics });
  const app = createApp({ config, pool, identity, governance, capabilities, objects, runs, jobs, scheduler, fleet, projects, audit, logger, metrics, fetchImpl });
  app.locals.objects = objects;
  const worker = createJobWorker({ jobs, identity, runs, logger, metrics, executeNext: app.locals.executeNext });
  const fleetWorker = createFleetWorker({
    fleet, identity, runs, logger, metrics, executeNext: app.locals.executeNext,
    batchSize: config.fleet.batchSize,
    maxConcurrency: config.fleet.maxConcurrency,
    partition: config.fleet.partition,
    partitions: config.fleet.partitions
  });
  return { pool, audit, governance, capabilities, identity, objects, runs, jobs, scheduler, worker, fleet, fleetWorker, app };
}

export async function start({ env = process.env } = {}) {
  const config = loadConfig(env);
  const logger = createLogger({ level: config.logLevel });
  const metrics = createMetrics();
  const providerSeries = field => providerConcurrencyStats().map(row => ({
    tags: { model: row.key },
    value: Number(row[field]) || 0
  }));
  metrics.gauge('model_provider_active', () => providerSeries('active'));
  metrics.gauge('model_provider_concurrency', () => providerSeries('concurrency'));
  metrics.gauge('model_provider_queued', () => providerSeries('queued'));
  metrics.gauge('model_provider_utilization', () => providerSeries('utilization'));
  metrics.gauge('model_provider_queue_pressure', () => providerSeries('queuePressure'));
  metrics.gauge('model_provider_last_latency_ms', () => providerSeries('lastLatencyMs'));
  metrics.gauge('model_provider_failure_streak', () => providerSeries('failureStreak'));

  logger.info('starting', { version: VERSION, nodeEnv: config.nodeEnv, node: process.version });

  const { pool, identity, app, worker, fleetWorker, scheduler, audit } = build({ config, logger, metrics });
  const migrationPool = config.database.migrationUrl
    ? createPool(config, logger, {
        connectionString: config.database.migrationUrl,
        applicationName: 'kindgleam-migrations'
      })
    : null;
  const migrationTarget = migrationPool ?? pool;
  const username = url => {
    if (!url) return null;
    try { return decodeURIComponent(new URL(url).username) || null; } catch { return null; }
  };
  try {
    await migrate(migrationTarget, logger, {
      runtimeRole: username(config.database.url),
      backupRole: username(config.database.backupUrl),
      restoreRole: username(config.database.restoreUrl),
      hardenRuntime: Boolean(migrationPool)
    });
    await backfillSensitiveData(migrationTarget, {
      billingKey: config.security.billingEncryptionKey,
      billingPreviousKey: config.security.billingEncryptionKeyPrevious,
      personalDataKey: config.security.personalDataEncryptionKey,
      personalDataPreviousKey: config.security.personalDataEncryptionKeyPrevious,
      logger
    });
    if (config.security.objectEncryptionKey && !(await assertNoPlaintextObjects(migrationTarget))) {
      const error = new Error('Plaintext object blobs remain. Run the re-encryption operator command before starting the application.');
      error.code = 'EOBJECTSNEEDREENCRYPTION';
      throw error;
    }
    if (config.production) {
      await assertMaintenanceBypassRls(migrationTarget, 'migration');
      await assertRlsReady(pool);
      await assertSensitiveDataEncrypted(migrationTarget);
    }
  } finally {
    await migrationPool?.end();
  }

  await app.locals.recoverExpiredActions?.({ limit: 500 });
  const server = createServer(app);
  const terminalServer = attachTerminalServer(server, { config, identity, pool, objects: app.locals.objects, audit, logger, metrics });
  server.requestTimeout = config.limits.requestTimeoutMs;
  server.headersTimeout = 30_000;
  // Longer than a typical load balancer's idle timeout, so the balancer closes
  // idle connections rather than us racing it and losing in-flight requests.
  server.keepAliveTimeout = 65_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  logger.info('listening', { host: config.host, port: server.address().port });
  worker.start();
  fleetWorker.start();
  scheduler.start();

  // Expired sessions and spent idempotency records accumulate otherwise.
  const sweeper = setInterval(() => {
    Promise.all([
      identity.purgeExpired(),
      app.locals.recoverExpiredActions?.({ limit: 500 }),
      pool.query(
        'DELETE FROM rate_limit_windows WHERE window_start_ms < $1',
        [Date.now() - 24 * 60 * 60 * 1000]
      )
    ])
      .then(([identityResult, actionResult, rateResult]) => logger.debug('purged expired records', {
        ...identityResult,
        uncertainActions: actionResult ?? 0,
        rateLimitWindows: rateResult.rowCount
      }))
      .catch(error => logger.error('purge failed', { error }));
  }, 3_600_000);
  sweeper.unref();

  let closing = false;
  const shutdown = async signal => {
    if (closing) return;
    closing = true;
    logger.info('shutting down', { signal });
    clearInterval(sweeper);

    const drainMs = signal === 'SIGTERM' ? config.limits.shutdownDrainMs : 0;
    const forced = setTimeout(() => {
      logger.error('shutdown timed out; exiting');
      process.exit(1);
    }, drainMs + 15_000);
    forced.unref();

    // Stop taking new jobs and schedules at once: work claimed now could be
    // cut off by the deadline. The job in hand finishes; an unfinished one is
    // reclaimed by another instance after its lease.
    const background = Promise.all([
      terminalServer.close(),
      worker.stop().catch(error => logger.error('job worker shutdown failed', { error })),
      fleetWorker.stop().catch(error => logger.error('fleet worker shutdown failed', { error })),
      scheduler.stop().catch(error => logger.error('scheduler shutdown failed', { error }))
    ]);

    // Report not-ready and keep serving HTTP for the drain period, so the
    // load balancer stops sending traffic before connections are refused.
    app.locals.draining = true;
    if (drainMs) await new Promise(resolve => setTimeout(resolve, drainMs));

    // Stop accepting, let in-flight requests finish, then drop the pool.
    await Promise.all([new Promise(resolve => server.close(resolve)), background]);
    await pool.end().catch(error => logger.error('pool shutdown failed', { error }));
    clearTimeout(forced);
    logger.info('stopped');
    process.exit(0);
  };

  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown(signal));

  // A crash with an unknown state is worse than a restart with a clean one.
  process.on('unhandledRejection', error => {
    logger.error('unhandled rejection', { error });
    shutdown('unhandledRejection');
  });
  process.on('uncaughtException', error => {
    logger.error('uncaught exception', { error });
    shutdown('uncaughtException');
  });

  return { server, pool, config, logger, terminalServer };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await start();
  } catch (error) {
    // Config and migration failures must be readable without a log pipeline.
    console.error(error.code === 'ECONFIG' ? error.message : error);
    process.exit(1);
  }
}
