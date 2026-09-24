import {
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from 'kysely';
import { ComputeError, type SqlTx } from '@better-compute/core';

const counted = new Set([
  'InsertQueryNode',
  'UpdateQueryNode',
  'DeleteQueryNode',
  'MergeQueryNode',
]);

function connection(sql: SqlTx): DatabaseConnection {
  return {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      const { rows, rowCount } = await sql.query<R>(query.sql, query.parameters);
      return counted.has(query.query.kind) ? { rows, numAffectedRows: BigInt(rowCount) } : { rows };
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      throw new ComputeError('UNSUPPORTED', 'Streaming queries are not supported; page with LIMIT');
    },
  };
}

const useExecutorTransactions = () =>
  new ComputeError(
    'UNSUPPORTED',
    "Open transactions with the SqlExecutor's transaction(); Kysely queries inside it join it",
  );

/**
 * A Kysely dialect over a `SqlExecutor` or one of its transactions, so modules write typed queries
 * (`new Kysely<ModuleTables>({ dialect: kyselyDialect(ctx.sql) })`) against either store. Queries
 * made through an executor join the transaction of the calling code, so one Kysely instance serves
 * inside and outside `transaction()`. Kysely's own `transaction()` is refused.
 */
export function kyselyDialect(sql: SqlTx): Dialect {
  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection(sql);
    },
    async beginTransaction() {
      throw useExecutorTransactions();
    },
    async commitTransaction() {
      throw useExecutorTransactions();
    },
    async rollbackTransaction() {
      throw useExecutorTransactions();
    },
    async releaseConnection() {},
    async destroy() {},
  };
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => driver,
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}
