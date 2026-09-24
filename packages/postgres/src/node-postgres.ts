import pg from 'pg';
import { ComputeError, type SqlExecutor } from '@better-compute/core';
import { createExecutor, type Driver, type Session, type StatementResult } from './executor.js';

export interface PostgresOptions {
  /** A `postgres://` or `postgresql://` connection string. Give this or `pool`. */
  url?: string;
  /**
   * A `pg.Pool` the application owns (TLS, auth hooks, a PgBouncer endpoint). `close()` leaves it
   * open. Give this or `url`.
   */
  pool?: pg.Pool;
  /** Pool size when `url` is given. Default 10, at most 100. */
  max?: number;
  /**
   * Applied with `SET LOCAL statement_timeout` at the start of every transaction; standalone
   * statements then run in a transaction of their own. Migrations run without it.
   */
  statementTimeoutMs?: number;
}

const INT8 = 20;
const INT8_ARRAY = 1016;
const INTERVAL = 1186;

/** An `int8` as PGlite reads it: a number when it is a safe integer, else a bigint. */
function parseInt8(text: string): number | bigint {
  const value = BigInt(text);
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value;
}

/** `{1,2,NULL}` or nested `{{1,2},{3,4}}`: integer elements never need quoting. */
function parseInt8Array(text: string): unknown[] {
  let index = 0;
  const parse = (): unknown[] => {
    const values: unknown[] = [];
    index++; // '{'
    while (index < text.length && text[index] !== '}') {
      if (text[index] === '{') values.push(parse());
      else {
        let end = index;
        while (end < text.length && text[end] !== ',' && text[end] !== '}') end++;
        const item = text.slice(index, end);
        values.push(item === 'NULL' ? null : parseInt8(item));
        index = end;
      }
      if (text[index] === ',') index++;
    }
    index++; // '}'
    return values;
  };
  return parse();
}

/**
 * Result parsing that matches PGlite's, so code reads the same values from either executor: int8
 * as a number (a bigint beyond 2^53), interval as its text. Everything else keeps node-postgres's
 * defaults (numeric as a string, timestamptz as a Date, bytea as a Buffer).
 */
const types: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: string) => {
    if (format === undefined || format === 'text') {
      if (oid === INT8) return parseInt8;
      if (oid === INT8_ARRAY) return parseInt8Array;
      if (oid === INTERVAL) return (text: string) => text;
    }
    return pg.types.getTypeParser(oid, format as 'text');
  }) as pg.CustomTypesConfig['getTypeParser'],
};

type ExtendedQuery = pg.QueryConfig & { queryMode: 'extended' };

function statement(text: string, params: readonly unknown[] = []): ExtendedQuery {
  // Always the extended protocol: exactly one statement per query(), as on PGlite.
  return { text, values: [...params], types, queryMode: 'extended' };
}

function result<R>(outcome: pg.QueryResult): StatementResult<R> {
  return { rows: outcome.rows as R[], rowCount: outcome.rowCount ?? 0, command: outcome.command };
}

function session(client: pg.PoolClient): Session {
  return {
    async query<R>(text: string, params?: readonly unknown[]) {
      return result<R>(await client.query(statement(text, params)));
    },
    async exec(script: string) {
      // No parameters: the simple protocol, which runs a multi-statement script.
      const outcome = (await client.query(script)) as pg.QueryResult | pg.QueryResult[];
      return (Array.isArray(outcome) ? outcome : [outcome]).map((entry) => entry.command);
    },
  };
}

function positiveInteger(value: unknown, max: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max;
}

/**
 * A `SqlExecutor` over node-postgres. Safe behind PgBouncer in transaction mode: it keeps no
 * session state (settings are `SET LOCAL`), never LISTENs, uses only unnamed prepared statements
 * and takes no session-level advisory locks. Nested `transaction()` calls become savepoints.
 */
export function postgres(options: PostgresOptions): SqlExecutor {
  if (!options || typeof options !== 'object')
    throw new ComputeError('INVALID_CONFIG', 'postgres() needs { url } or { pool }');
  const { url, pool: given, max = 10, statementTimeoutMs } = options;
  if ((url === undefined) === (given === undefined))
    throw new ComputeError('INVALID_CONFIG', 'postgres() needs exactly one of url and pool');
  if (url !== undefined && (typeof url !== 'string' || !/^postgres(?:ql)?:\/\//u.test(url)))
    throw new ComputeError('INVALID_CONFIG', 'url must be a postgres:// connection string');
  if (given !== undefined && (typeof given !== 'object' || typeof given.connect !== 'function'))
    throw new ComputeError('INVALID_CONFIG', 'pool must be a pg.Pool');
  if (!positiveInteger(max, 100))
    throw new ComputeError('INVALID_CONFIG', 'max must be an integer from 1 to 100');
  if (statementTimeoutMs !== undefined && !positiveInteger(statementTimeoutMs, 2_147_483_647))
    throw new ComputeError('INVALID_CONFIG', 'statementTimeoutMs must be a positive integer');

  const pool =
    given ?? new pg.Pool({ connectionString: url, max, connectionTimeoutMillis: 10_000 });
  // An idle client's error (a restarted server) must not crash the process; pg drops that client
  // and the next checkout connects afresh.
  if (!given) pool.on('error', () => {});

  const driver: Driver = {
    kind: 'postgres',
    statementTimeoutMs,
    async acquire() {
      const client = await pool.connect();
      return {
        session: session(client),
        release: (broken) => client.release(broken ? true : undefined),
      };
    },
    async standalone<R>(text: string, params?: readonly unknown[]) {
      return result<R>(await pool.query(statement(text, params)));
    },
    async close() {
      if (!given) await pool.end();
    },
  };
  return createExecutor(driver);
}
