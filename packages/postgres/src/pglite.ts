import { ComputeError, type SqlExecutor } from '@better-compute/core';
import type { PGlite } from '@electric-sql/pglite';
import { createExecutor, Mutex, type Driver, type Session } from './executor.js';

export interface PgliteOptions {
  /**
   * Where PGlite keeps its files; a directory path persists across runs. Default: in memory, gone
   * when the executor closes.
   */
  dataDir?: string;
  /**
   * More PGlite extensions, by namespace (`{ vector }`). `btree_gist`, which the base schema
   * needs, is always included.
   */
  extensions?: Record<string, unknown>;
  /**
   * PGlite has no autovacuum, so nothing gathers planner statistics and plans stay those of empty
   * tables (a sequential scan where Postgres would use an index). The executor runs `ANALYZE` after
   * `migrate()` and then every `analyzeEveryMs` (default 60 000; 0 turns the timer off, for tests
   * that want no background statements).
   */
  analyzeEveryMs?: number;
}

function missingPeer(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return code === 'ERR_MODULE_NOT_FOUND' && String(message).includes('@electric-sql/pglite');
}

async function open(options: PgliteOptions): Promise<PGlite> {
  let modules;
  try {
    // Loaded on first use: @electric-sql/pglite is an optional peer dependency.
    modules = await Promise.all([
      import('@electric-sql/pglite'),
      import('@electric-sql/pglite/contrib/btree_gist'),
    ]);
  } catch (error) {
    if (missingPeer(error))
      throw new ComputeError(
        'MISSING_DEPENDENCY',
        'pglite() needs the optional peer dependency @electric-sql/pglite; install it next to @better-compute/postgres',
      );
    throw error;
  }
  const [{ PGlite }, { btree_gist }] = modules;
  const db = await PGlite.create({
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    extensions: { ...(options.extensions as Record<string, never>), btree_gist },
  });
  // Deterministic text output of timestamps and ranges in dev and tests; PGlite owns this one
  // connection, so a session setting is safe here (unlike behind PgBouncer).
  await db.exec("SET TimeZone TO 'UTC'");
  return db;
}

function session(db: PGlite): Session {
  return {
    async query<R>(text: string, params: readonly unknown[] = []) {
      const outcome = await db.query<R>(text, [...params]);
      return {
        rows: outcome.rows,
        rowCount: outcome.rowCount ?? outcome.affectedRows ?? outcome.rows.length,
        command: outcome.command ?? '',
      };
    },
    async exec(script: string) {
      return (await db.exec(script)).map((outcome) => outcome.command ?? '');
    },
  };
}

/**
 * A `SqlExecutor` over PGlite (PostgreSQL in WebAssembly) for development and tests. It has one
 * connection, so transactions and standalone statements run one at a time behind an async mutex;
 * code inside a transaction that waits for another top-level transaction therefore deadlocks.
 * Nested `transaction()` calls become savepoints. PGlite loads lazily on the first statement.
 */
export function pglite(options: PgliteOptions = {}): SqlExecutor {
  if (!options || typeof options !== 'object')
    throw new ComputeError('INVALID_CONFIG', 'pglite() takes an options object');
  if (options.dataDir !== undefined && (typeof options.dataDir !== 'string' || !options.dataDir))
    throw new ComputeError('INVALID_CONFIG', 'dataDir must be a non-empty path');
  if (
    options.extensions !== undefined &&
    (typeof options.extensions !== 'object' || options.extensions === null)
  )
    throw new ComputeError('INVALID_CONFIG', 'extensions must map namespaces to PGlite extensions');
  const analyzeEveryMs = options.analyzeEveryMs ?? 60_000;
  if (!Number.isInteger(analyzeEveryMs) || analyzeEveryMs < 0)
    throw new ComputeError('INVALID_CONFIG', 'analyzeEveryMs must be a whole number ≥ 0');

  const mutex = new Mutex();
  let opening: Promise<{ db: PGlite; session: Session }> | undefined;
  const ready = () => (opening ??= open(options).then((db) => ({ db, session: session(db) })));

  const driver: Driver = {
    kind: 'pglite',
    async acquire() {
      const release = await mutex.lock();
      try {
        return { session: (await ready()).session, release: () => release() };
      } catch (error) {
        release();
        throw error;
      }
    },
    async standalone<R>(text: string, params?: readonly unknown[]) {
      return mutex.run(async () => (await ready()).session.query<R>(text, params));
    },
    async close() {
      if (timer) clearInterval(timer);
      timer = undefined;
      // Waits for the running and queued transactions, then shuts PGlite down.
      await mutex.run(async () => {
        if (opening) await (await opening.catch(() => undefined))?.db.close();
      });
    },
  };
  const executor = createExecutor(driver);
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const analyze = () => driver.standalone('ANALYZE');
  const migrate = executor.migrate.bind(executor);
  const close = executor.close.bind(executor);
  executor.migrate = async (extra) => {
    const result = await migrate(extra);
    await analyze();
    if (analyzeEveryMs > 0 && !timer && !closed) {
      // Best effort: a failed ANALYZE (say, racing close) only leaves the old statistics.
      timer = setInterval(() => void analyze().catch(() => undefined), analyzeEveryMs);
      timer.unref?.();
    }
    return result;
  };
  executor.close = async () => {
    closed = true;
    await close();
  };
  return executor;
}
