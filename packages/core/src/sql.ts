import { ComputeError } from './errors.js';

export interface SqlResult<R> {
  rows: R[];
  rowCount: number;
}

/** A connection or transaction that runs parameterized SQL (`$1`, `$2`, … placeholders). */
export interface SqlTx {
  query<R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<SqlResult<R>>;
}

export interface TransactionOptions {
  /** Default `read committed`; guarded updates and row locks carry the invariants (P4). */
  isolation?: 'read committed' | 'repeatable read' | 'serializable';
  readOnly?: boolean;
}

/**
 * `<owner>/<nnnn>_<slug>`: the owner is `core`, a built-in module or a module/plugin name, and
 * numbers only grow within an owner. The ledger (`compute_migrations`) is append-only.
 */
export type MigrationName = `${string}/${string}`;

export interface Migration {
  name: MigrationName;
  sql: string | ((tx: SqlTx) => Promise<void>);
}

export interface MigrationResult {
  /** Newly applied, in order. */
  applied: string[];
  /** Already in the ledger. */
  skipped: string[];
}

/**
 * The store contract `postgres()` and `pglite()` implement and the server consumes without importing
 * either. Both speak PostgreSQL; PGlite serializes transactions on its single connection.
 */
export interface SqlExecutor extends SqlTx {
  readonly dialect: 'postgres';
  readonly kind: 'postgres' | 'pglite';
  /** Runs `fn` in one transaction; it commits when `fn` resolves and rolls back when it throws. */
  transaction<T>(fn: (tx: SqlTx) => Promise<T>, options?: TransactionOptions): Promise<T>;
  /** Applies the adapter-owned base schema, then `extra` (module and plugin migrations) in order. */
  migrate(extra?: readonly Migration[]): Promise<MigrationResult>;
  close(): Promise<void>;
}

const migrationPattern = /^([a-z][a-z0-9-]{0,63})\/(\d{4})_[a-z0-9][a-z0-9_-]{0,95}$/;

/** Whether `name` follows `<owner>/<nnnn>_<slug>`. */
export function isMigrationName(name: unknown): name is MigrationName {
  return typeof name === 'string' && migrationPattern.test(name);
}

/**
 * Checks a migration list before anything runs: names well formed and unique, and numbers strictly
 * increasing within each owner. Throws `INVALID_CONFIG`.
 */
export function assertMigrations(migrations: readonly Migration[]): void {
  const seen = new Set<string>();
  const last = new Map<string, number>();
  for (const migration of migrations) {
    const match = typeof migration.name === 'string' ? migrationPattern.exec(migration.name) : null;
    if (!match)
      throw new ComputeError('INVALID_CONFIG', `Invalid migration name ${String(migration.name)}`);
    if (seen.has(migration.name))
      throw new ComputeError('INVALID_CONFIG', `Duplicate migration ${migration.name}`);
    seen.add(migration.name);
    const owner = match[1]!;
    const number = Number(match[2]);
    if (number <= (last.get(owner) ?? 0))
      throw new ComputeError('INVALID_CONFIG', `Migration ${migration.name} is out of order`);
    last.set(owner, number);
    if (typeof migration.sql !== 'string' && typeof migration.sql !== 'function')
      throw new ComputeError('INVALID_CONFIG', `Migration ${migration.name} has no sql`);
  }
}
