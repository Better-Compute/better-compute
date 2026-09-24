import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ComputeError,
  type Migration,
  type MigrationResult,
  type SqlExecutor,
  type SqlResult,
  type SqlTx,
  type TransactionOptions,
} from '@better-compute/core';
import { runMigrations, type MigrationTx } from './migrate.js';

// The transaction machinery both executors share. A driver supplies connections; this module owns
// BEGIN/COMMIT/ROLLBACK, savepoints for nested transactions, and the async-context scope that lets
// the executor's own `query` and `transaction` join the transaction of the calling code.

/** One statement's outcome with its command tag (`COMMIT` reports `ROLLBACK` after a failure). */
export interface StatementResult<R = Record<string, unknown>> extends SqlResult<R> {
  command: string;
}

/** One database connection, used by one caller at a time. */
export interface Session {
  /** Exactly one statement, over the extended protocol, with `$n` parameters. */
  query<R>(text: string, params?: readonly unknown[]): Promise<StatementResult<R>>;
  /** A parameterless script of one or more statements; returns each statement's command tag. */
  exec(script: string): Promise<string[]>;
}

/** Exclusive use of a session until `release` is called. */
export interface SessionLease {
  session: Session;
  /** Returns the session; `broken` discards it (a failed ROLLBACK leaves it in an unknown state). */
  release(broken?: boolean): void;
}

/** What an executor needs from a database client. */
export interface Driver {
  readonly kind: SqlExecutor['kind'];
  /** Applied with `SET LOCAL` in every transaction; standalone statements then run in one too. */
  readonly statementTimeoutMs?: number;
  acquire(): Promise<SessionLease>;
  /** One statement outside any transaction. */
  standalone<R>(text: string, params?: readonly unknown[]): Promise<StatementResult<R>>;
  close(): Promise<void>;
}

type Isolation = NonNullable<TransactionOptions['isolation']>;

const isolationLevels: Readonly<Record<Isolation, string>> = {
  'read committed': 'READ COMMITTED',
  'repeatable read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
};

/** A promise-chain lock: callers run one at a time in arrival order. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** Waits for the lock and returns the function that releases it. */
  lock(): Promise<() => void> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(() => release);
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.lock();
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

/** A transaction or savepoint that the current async call chain runs inside. */
interface Scope {
  session: Session;
  active: boolean;
  depth: number;
  isolation: Isolation;
  readOnly: boolean;
  /** Serializes nested transactions opened directly in this scope; savepoints are strictly LIFO. */
  children: Mutex;
}

interface BeginOptions extends TransactionOptions {
  /** Migrations: no statement timeout (index builds can take minutes). */
  unlimited?: boolean;
}

const closedExecutor = () => new ComputeError('INTERNAL_ERROR', 'The database executor is closed');
const completedTransaction = () =>
  new ComputeError('INTERNAL_ERROR', 'The transaction has already completed');

function toResult<R>(result: StatementResult<R>): SqlResult<R> {
  return { rows: result.rows, rowCount: result.rowCount };
}

function checkOptions(options: TransactionOptions | undefined): {
  isolation: Isolation;
  readOnly: boolean;
} {
  const isolation = options?.isolation ?? 'read committed';
  if (!Object.hasOwn(isolationLevels, isolation))
    throw new ComputeError('INVALID_INPUT', `Unknown isolation level ${String(isolation)}`);
  const readOnly = options?.readOnly ?? false;
  if (typeof readOnly !== 'boolean')
    throw new ComputeError('INVALID_INPUT', 'readOnly must be a boolean');
  return { isolation, readOnly };
}

/** The SQLSTATE of a database error (`23P01`, `40001`, …), from `pg` and PGlite alike. */
export function sqlState(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

class Executor implements SqlExecutor {
  readonly dialect = 'postgres' as const;
  readonly kind: SqlExecutor['kind'];
  private readonly scope = new AsyncLocalStorage<Scope>();
  private closed = false;

  constructor(private readonly driver: Driver) {
    this.kind = driver.kind;
  }

  private current(): Scope | undefined {
    const scope = this.scope.getStore();
    return scope?.active ? scope : undefined;
  }

  private assertOpen(): void {
    if (this.closed) throw closedExecutor();
  }

  private handle(scope: Scope): MigrationTx {
    return {
      query: async <R>(text: string, params?: readonly unknown[]) => {
        if (!scope.active) throw completedTransaction();
        return toResult(await scope.session.query<R>(text, params));
      },
      exec: async (script: string) => {
        if (!scope.active) throw completedTransaction();
        await scope.session.exec(script);
      },
    };
  }

  async query<R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<SqlResult<R>> {
    const scope = this.current();
    if (scope) return toResult(await scope.session.query<R>(text, params));
    this.assertOpen();
    if (this.driver.statementTimeoutMs !== undefined)
      return this.begin((tx) => tx.query<R>(text, params), {});
    return toResult(await this.driver.standalone<R>(text, params));
  }

  async transaction<T>(fn: (tx: SqlTx) => Promise<T>, options?: TransactionOptions): Promise<T> {
    const scope = this.current();
    if (scope) return this.savepoint(scope, fn, options);
    this.assertOpen();
    return this.begin(fn, options ?? {});
  }

  /** Opens a top-level transaction on its own session. */
  private async begin<T>(fn: (tx: MigrationTx) => Promise<T>, options: BeginOptions): Promise<T> {
    const { isolation, readOnly } = checkOptions(options);
    const lease = await this.driver.acquire();
    let broken = false;
    /** Transaction control; an error without a SQLSTATE means the connection itself failed. */
    const control = async (script: string) => {
      try {
        return await lease.session.exec(script);
      } catch (error) {
        if (sqlState(error) === undefined) broken = true;
        throw error;
      }
    };
    try {
      const timeout = options.unlimited ? 0 : this.driver.statementTimeoutMs;
      // Transaction-scoped settings only: nothing survives on a pooled (PgBouncer) connection.
      await control(
        `BEGIN ISOLATION LEVEL ${isolationLevels[isolation]}${readOnly ? ' READ ONLY' : ''}` +
          (timeout === undefined ? '' : `; SET LOCAL statement_timeout = ${timeout}`),
      );
      const scope: Scope = {
        session: lease.session,
        active: true,
        depth: 0,
        isolation,
        readOnly,
        children: new Mutex(),
      };
      let result: T;
      try {
        result = await this.scope.run(scope, () => fn(this.handle(scope)));
      } catch (error) {
        scope.active = false;
        await control('ROLLBACK').catch(() => {
          broken = true;
        });
        throw error;
      }
      scope.active = false;
      const tags = await control('COMMIT');
      if (tags.at(-1) === 'ROLLBACK')
        throw new ComputeError(
          'INTERNAL_ERROR',
          'A statement failed inside the transaction and its error was caught, so PostgreSQL rolled the transaction back',
        );
      return result;
    } finally {
      lease.release(broken);
    }
  }

  /** Runs a nested transaction as a savepoint of `parent`. */
  private savepoint<T>(
    parent: Scope,
    fn: (tx: SqlTx) => Promise<T>,
    options: TransactionOptions | undefined,
  ): Promise<T> {
    const { isolation, readOnly } = checkOptions({
      isolation: options?.isolation ?? parent.isolation,
      readOnly: options?.readOnly ?? parent.readOnly,
    });
    if (isolation !== parent.isolation || readOnly !== parent.readOnly)
      return Promise.reject(
        new ComputeError(
          'INVALID_INPUT',
          'A nested transaction runs as a savepoint and cannot change isolation or read-only mode',
        ),
      );
    return parent.children.run(async () => {
      if (!parent.active) throw completedTransaction();
      const name = `bc_sp_${parent.depth + 1}`;
      const session = parent.session;
      await session.exec(`SAVEPOINT ${name}`);
      const scope: Scope = {
        ...parent,
        active: true,
        depth: parent.depth + 1,
        children: new Mutex(),
      };
      const undo = async () => {
        await session.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);
      };
      let result: T;
      try {
        result = await this.scope.run(scope, () => fn(this.handle(scope)));
      } catch (error) {
        scope.active = false;
        await undo();
        throw error;
      }
      scope.active = false;
      try {
        await session.exec(`RELEASE SAVEPOINT ${name}`);
      } catch (error) {
        // Only an aborted transaction refuses RELEASE: a statement failed and its error was caught.
        await undo();
        throw Object.assign(
          new ComputeError(
            'INTERNAL_ERROR',
            'A statement failed inside the nested transaction and its error was caught, so it was rolled back',
          ),
          { cause: error },
        );
      }
      return result;
    });
  }

  async migrate(extra: readonly Migration[] = []): Promise<MigrationResult> {
    if (this.current())
      throw new ComputeError('INVALID_STATE', 'migrate() cannot run inside a transaction');
    this.assertOpen();
    return runMigrations((fn) => this.begin(fn, { unlimited: true }), extra);
  }

  async close(): Promise<void> {
    if (this.current())
      throw new ComputeError(
        'INTERNAL_ERROR',
        'Cannot close the executor inside one of its transactions',
      );
    if (this.closed) return;
    this.closed = true;
    await this.driver.close();
  }
}

/**
 * Wraps a driver in the shared transaction semantics:
 * - `transaction()` runs `fn` between BEGIN and COMMIT on one connection and rolls back when it
 *   throws. A statement error that `fn` catches still rolls the transaction back, and the call
 *   rejects with `INTERNAL_ERROR` rather than reporting a commit that did not happen.
 * - Inside a transaction's async call chain, the executor's own `query()` joins that transaction and
 *   `transaction()` opens a savepoint (released on success, rolled back when `fn` throws; the outer
 *   transaction continues). Code that holds the executor and code that holds `tx` behave the same.
 * - A `tx` handle rejects every use once its transaction or savepoint has ended.
 */
export function createExecutor(driver: Driver): SqlExecutor {
  return new Executor(driver);
}
