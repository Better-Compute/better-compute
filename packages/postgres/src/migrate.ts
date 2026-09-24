import {
  ComputeError,
  assertMigrations,
  type Migration,
  type MigrationResult,
  type SqlTx,
} from '@better-compute/core';
import { baseMigrations, baseSchemaVersion } from './migrations/index.js';

/** A migration transaction: `exec` runs a parameterless, multi-statement script. */
export interface MigrationTx extends SqlTx {
  exec(script: string): Promise<void>;
}

/** Opens one transaction without the executor's statement timeout. */
export type MigrationTransaction = <T>(fn: (tx: MigrationTx) => Promise<T>) => Promise<T>;

/** The lowest `server_version_num` the schema supports (D3: PostgreSQL 16 or later). */
const minimumServerVersion = 160000;

/**
 * Serializes migrators across processes. A transaction-level lock, released at COMMIT, so it is
 * safe behind PgBouncer's transaction pooling. The first key spells "bcmp".
 */
const lockMigrations = 'SELECT pg_advisory_xact_lock(1650683248, 1)';

const bootstrap = `
CREATE TABLE IF NOT EXISTS compute_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS compute_schema_version (id int PRIMARY KEY CHECK (id = 1), version int NOT NULL);
`;

const pattern = /^([a-z][a-z0-9-]{0,63})\/(\d{4})_/;

function parse(name: string): { owner: string; number: number } | undefined {
  const match = pattern.exec(name);
  return match ? { owner: match[1]!, number: Number(match[2]) } : undefined;
}

interface Ledger {
  version: number | undefined;
  names: Set<string>;
}

/**
 * Ledger entries this build cannot account for: a later number from an owner it knows (a newer
 * release migrated the database), or an unknown name at or below its last number (a migration was
 * renamed or removed, which append-only forbids). Owners it has no migrations for are ignored, so
 * a module that is no longer configured does not block startup.
 */
function unaccounted(ledger: Ledger, known: readonly Migration[]) {
  const names = new Set<string>(known.map((migration) => migration.name));
  const highest = new Map<string, number>();
  for (const migration of known) {
    const { owner, number } = parse(migration.name)!;
    highest.set(owner, Math.max(number, highest.get(owner) ?? 0));
  }
  const newer: string[] = [];
  const unknown: string[] = [];
  for (const name of [...ledger.names].sort()) {
    const parsed = names.has(name) ? undefined : parse(name);
    const last = parsed && highest.get(parsed.owner);
    if (parsed && last !== undefined) (parsed.number > last ? newer : unknown).push(name);
  }
  return { newer, unknown };
}

function refuse(ledger: Ledger, known: readonly Migration[]): void {
  const { newer, unknown } = unaccounted(ledger, known);
  const newerVersion = ledger.version !== undefined && ledger.version > baseSchemaVersion;
  if (!newerVersion && newer.length === 0 && unknown.length === 0) return;
  const reasons: string[] = [];
  if (newerVersion)
    reasons.push(
      `its base schema is version ${ledger.version}, and this build knows version ${baseSchemaVersion}`,
    );
  if (newer.length)
    reasons.push(
      `a newer better-compute applied ${newer.join(', ')}, which this build does not know`,
    );
  if (unknown.length)
    reasons.push(
      `the ledger records ${unknown.join(', ')}, which this build does not know; migrations are append-only, so one was renamed or removed`,
    );
  throw new ComputeError(
    'INVALID_CONFIG',
    `Refusing to migrate: ${reasons.join('; ')}. Run the better-compute release that migrated this database, or a newer one.`,
    undefined,
    {
      newer,
      unknown,
      schemaVersion: ledger.version ?? null,
      knownSchemaVersion: baseSchemaVersion,
    },
  );
}

/**
 * Applies the base schema and then `extra`, one transaction per migration, recording each in the
 * append-only `compute_migrations` ledger. Idempotent; concurrent migrators serialize on a
 * transaction-level advisory lock and skip what another one applied.
 */
export async function runMigrations(
  transaction: MigrationTransaction,
  extra: readonly Migration[],
): Promise<MigrationResult> {
  if (!Array.isArray(extra))
    throw new ComputeError('INVALID_CONFIG', 'migrate() takes an array of migrations');
  for (const migration of extra)
    if (parse(String(migration?.name))?.owner === 'core')
      throw new ComputeError(
        'INVALID_CONFIG',
        `Migration ${migration.name}: the core owner is reserved for the store's base schema`,
      );
  const all = [...baseMigrations, ...extra];
  assertMigrations(all);

  const ledger = await transaction(async (tx): Promise<Ledger> => {
    const [server] = (
      await tx.query<{ version: number }>(
        "SELECT current_setting('server_version_num')::int AS version",
      )
    ).rows;
    if (!server || server.version < minimumServerVersion)
      throw new ComputeError(
        'INVALID_CONFIG',
        `better-compute needs PostgreSQL 16 or later; this server reports ${server?.version ?? 'no'} server_version_num`,
      );
    await tx.query(lockMigrations);
    await tx.exec(bootstrap);
    const [row] = (
      await tx.query<{ version: number }>('SELECT version FROM compute_schema_version WHERE id = 1')
    ).rows;
    const names = (await tx.query<{ name: string }>('SELECT name FROM compute_migrations')).rows;
    return { version: row?.version, names: new Set(names.map((entry) => entry.name)) };
  });
  refuse(ledger, all);

  const result: MigrationResult = { applied: [], skipped: [] };
  for (const [index, migration] of all.entries()) {
    if (ledger.names.has(migration.name)) {
      result.skipped.push(migration.name);
      continue;
    }
    const applied = await transaction(async (tx) => {
      await tx.query(lockMigrations);
      const done = await tx.query('SELECT 1 FROM compute_migrations WHERE name = $1', [
        migration.name,
      ]);
      if (done.rowCount > 0) return false;
      try {
        if (typeof migration.sql === 'string') await tx.exec(migration.sql);
        else await migration.sql(tx);
      } catch (error) {
        throw Object.assign(
          new ComputeError(
            'INTERNAL_ERROR',
            `Migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`,
            undefined,
            { migration: migration.name },
          ),
          { cause: error },
        );
      }
      await tx.query(
        'INSERT INTO compute_migrations (name, applied_at) VALUES ($1, compute_now())',
        [migration.name],
      );
      if (index < baseMigrations.length)
        await tx.query(
          `INSERT INTO compute_schema_version (id, version) VALUES (1, $1)
           ON CONFLICT (id) DO UPDATE SET version = GREATEST(compute_schema_version.version, EXCLUDED.version)`,
          [index + 1],
        );
      return true;
    });
    (applied ? result.applied : result.skipped).push(migration.name);
  }
  return result;
}
