import { getReferenceString } from '@medplum/core';
import { AsyncJob } from '@medplum/fhirtypes';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, PoolClient } from 'pg';
import { MedplumDatabaseConfig, MedplumServerConfig } from './config';
import { AsyncJobExecutor } from './fhir/operations/utils/asyncjobexecutor';
import { getSystemRepo } from './fhir/repo';
import { globalLogger } from './logger';
import * as dataMigrations from './migrations/data';
import * as schemaMigrations from './migrations/schema';
import { addAsyncJobPollerJob } from './workers/asyncjobpoller';

export enum DatabaseMode {
  READER = 'reader',
  WRITER = 'writer',
}

let pool: Pool | undefined;
let readonlyPool: Pool | undefined;
let serverVersion: string | undefined;

export function getDatabasePool(mode: DatabaseMode): Pool {
  if (!pool) {
    throw new Error('Database not setup');
  }

  if (mode === DatabaseMode.READER && readonlyPool) {
    return readonlyPool;
  }

  return pool;
}

export const locks = {
  migration: 1,
};

export async function initDatabase(serverConfig: MedplumServerConfig): Promise<void> {
  pool = await initPool(serverConfig.database, serverConfig.databaseProxyEndpoint);

  if (serverConfig.database.runMigrations !== false) {
    await runMigrations(pool);
  }

  if (serverConfig.readonlyDatabase) {
    readonlyPool = await initPool(serverConfig.readonlyDatabase, serverConfig.readonlyDatabaseProxyEndpoint);
  }
}

async function initPool(config: MedplumDatabaseConfig, proxyEndpoint: string | undefined): Promise<Pool> {
  const poolConfig = {
    host: config.host,
    port: config.port,
    database: config.dbname,
    user: config.username,
    password: config.password,
    ssl: config.ssl,
    max: config.maxConnections ?? 100,
  };

  if (proxyEndpoint) {
    poolConfig.host = proxyEndpoint;
    poolConfig.ssl = poolConfig.ssl ?? {};
    poolConfig.ssl.require = true;
  }

  const pool = new Pool(poolConfig);

  pool.on('error', (err) => {
    globalLogger.error('Database connection error', err);
  });

  if (!config.disableConnectionConfiguration) {
    pool.on('connect', (client) => {
      client.query(`SET statement_timeout TO ${config.queryTimeout ?? 60000}`).catch((err) => {
        globalLogger.warn('Failed to set query timeout', err);
      });
      client.query(`SET default_transaction_isolation TO 'REPEATABLE READ'`).catch((err) => {
        globalLogger.warn('Failed to set default transaction isolation', err);
      });
    });
  }

  return pool;
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }

  if (readonlyPool) {
    await readonlyPool.end();
    readonlyPool = undefined;
  }
}

async function runMigrations(pool: Pool): Promise<void> {
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('SELECT pg_advisory_lock($1)', [locks.migration]);
    await client.query(`SET statement_timeout TO 0`); // Disable timeout for migrations AFTER getting lock
    await migrate(client);
  } catch (err: any) {
    globalLogger.error('Database schema migration error', err);
    if (client) {
      await client.query('SELECT pg_advisory_unlock($1)', [locks.migration]);
      client.release(err);
      client = undefined;
    }
  } finally {
    if (client) {
      await client.query('SELECT pg_advisory_unlock($1)', [locks.migration]);
      client.release(true); // Ensure migration connection is torn down and not re-used
      client = undefined;
    }
  }
}

async function migrate(client: PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS "DatabaseMigration" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "version" INTEGER NOT NULL,
    "dataVersion" INTEGER NOT NULL
  )`);

  const result = await client.query('SELECT "version", "dataVersion" FROM "DatabaseMigration"');
  let version = result.rows[0]?.version ?? -1;
  let dataVersion = result.rows[0]?.dataVersion ?? -1;
  const allDataVersions = getMigrationVersions(dataMigrations);
  let pendingDataMigration = 0;

  // If this is the first time the server has been started up (version < 0)
  // We need to initialize our migrations table
  // This also opts us into the fast path for data migrations, so we can skip all checks for server version and go straight to the latest data version
  if (version < 0) {
    const latestDataVersion = allDataVersions[allDataVersions.length - 1];
    await client.query(
      `INSERT INTO "DatabaseMigration" ("id", "version", "dataVersion") VALUES (1, 0, ${latestDataVersion})`
    );
    version = 0;
    dataVersion = latestDataVersion;
  } else if (allDataVersions.includes(dataVersion + 1)) {
    // Before migrating, check if we have pending data migrations to apply
    // We have to check these first since they depend on particular versions of the server code to be present in order
    // To ensure that the migration is applied before at a particular point in time before the version that requires it
    pendingDataMigration = dataVersion + 1;

    // Since an outstanding data migration exists, we need to apply it. To apply it we need to check the corresponding server version
    // There is a manifest that contains the required server version for a given data migration
    // That we can check
    const manifest = JSON.parse(
      readFileSync(resolve(__dirname, 'migrations/data/data-version-manifest.json'), { encoding: 'utf-8' })
    ) as Record<string, { serverVersion: string }>;
    const requiredServerVersion = manifest['v' + pendingDataMigration].serverVersion;

    // If the current server version is not the one we require for this data migration
    // Then we should throw and abort the migration process
    const serverVersion = getServerVersion();
    if (serverVersion !== requiredServerVersion) {
      throw new Error(
        `Unable to run data migration against the current server version. Migration requires server at version ${requiredServerVersion}, but current server version is ${serverVersion}`
      );
    }

    // If we make it here, we have a pending migration, but we don't want to apply it until we make sure we apply all the schema migrations first
  }

  const schemaKeys = Object.keys(schemaMigrations);
  for (let i = version + 1; i <= schemaKeys.length; i++) {
    const migration = (schemaMigrations as Record<string, schemaMigrations.Migration>)['v' + i];
    if (migration) {
      const start = Date.now();
      await migration.run(client);
      globalLogger.info('Database schema migration', { version: `v${i}`, duration: `${Date.now() - start} ms` });
      await client.query('UPDATE "DatabaseMigration" SET "version"=$1', [i]);
    }
  }

  // TODO: Instead of running the migration here, queue it up in an async job
  if (pendingDataMigration) {
    // Queue up the async job here
    const migration = (dataMigrations as Record<string, dataMigrations.Migration>)['v' + pendingDataMigration];
    const startTimeMs = Date.now();
    // Get async job
    const migrationAsyncJob = (await migration.run(getSystemRepo())) as unknown as AsyncJob;
    const systemRepo = getSystemRepo();
    const exec = new AsyncJobExecutor(systemRepo);
    await exec.init(getReferenceString(migrationAsyncJob));
    await exec.run(async (ownJob) => {
      await addAsyncJobPollerJob(
        {
          ownJob,
          trackedJob: migrationAsyncJob,
          jobType: 'dataMigration',
          jobData: { startTimeMs, migrationVersion: pendingDataMigration },
        },
        1000
      );
    });
  }
}

function getMigrationVersions(migrationModule: Record<string, any>): number[] {
  const prefixedVersions = Object.keys(migrationModule).filter((key) => key.startsWith('v'));
  const migrationVersions = prefixedVersions.map((key) => Number.parseInt(key.slice(1), 10)).sort((a, b) => a - b);
  return migrationVersions;
}

function getServerVersion(): string {
  if (!serverVersion) {
    serverVersion = (
      JSON.parse(readFileSync(resolve(__dirname, '../package.json'), { encoding: 'utf-8' })) as Record<string, any>
    ).version as string;
  }
  return serverVersion;
}
