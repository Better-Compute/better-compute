import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ComputeError,
  type Logger,
  type SqlExecutor,
  type SqlTx,
  type TransactionOptions,
} from '@better-compute/core';

// After-commit hooks (best-effort side effects such as notifier pokes, P1). The executor the server
// hands out wraps the store's: `transaction()` collects the hooks registered inside it and runs them
// once the outermost transaction has committed. A savepoint that rolls back drops its hooks.

/** Work to run once the surrounding transaction commits; errors are logged, never thrown. */
export type CommitHook = () => void | Promise<void>;

interface Scope {
  hooks: CommitHook[];
  closed: boolean;
}

export interface CommitHooks {
  /** The store's executor with after-commit hooks; statements and transactions pass straight through. */
  readonly database: SqlExecutor;
  /**
   * Runs `hook` after the current transaction of `database` commits. Outside one (or inside a
   * transaction opened on the raw store), it runs on the next macrotask: best effort only.
   */
  afterCommit(hook: CommitHook): void;
  /** Whether the calling code runs inside a transaction opened through `database`. */
  inTransaction(): boolean;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function withCommitHooks(inner: SqlExecutor, log: Logger): CommitHooks {
  const storage = new AsyncLocalStorage<Scope>();

  const run = (hooks: readonly CommitHook[]) => {
    for (const hook of hooks)
      void (async () => {
        try {
          await hook();
        } catch (error) {
          log.warn('An after-commit hook failed', { error: message(error) });
        }
      })();
  };

  const database: SqlExecutor = {
    dialect: inner.dialect,
    kind: inner.kind,
    query: (text, params) => inner.query(text, params),
    async transaction<T>(fn: (tx: SqlTx) => Promise<T>, options?: TransactionOptions): Promise<T> {
      const parent = storage.getStore();
      const scope: Scope = { hooks: [], closed: false };
      let result: T;
      try {
        result = await inner.transaction((tx) => storage.run(scope, () => fn(tx)), options);
      } finally {
        scope.closed = true;
      }
      if (parent && !parent.closed) parent.hooks.push(...scope.hooks);
      else run(scope.hooks);
      return result;
    },
    migrate: (extra) => inner.migrate(extra),
    close: () => inner.close(),
  };

  return {
    database,
    afterCommit(hook) {
      if (typeof hook !== 'function')
        throw new ComputeError('INVALID_INPUT', 'afterCommit takes a function');
      const scope = storage.getStore();
      if (scope && !scope.closed) scope.hooks.push(hook);
      else setTimeout(() => run([hook]), 0);
    },
    inTransaction() {
      const scope = storage.getStore();
      return scope !== undefined && !scope.closed;
    },
  };
}
