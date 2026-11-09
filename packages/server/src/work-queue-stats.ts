import { ComputeError, type SqlExecutor } from '@better-compute/core';

// (U-04) `system.workQueue`: the backlog of the work queue per kind, for operators and the platform's job
// dashboards. Each periodic job keeps one row that a worker claims, runs and reschedules, plus rows other code
// enqueues (an instance id, a sandbox id). A row due for long that no worker holds means nobody drains that kind.
// It only reads, in one statement.

export interface WorkQueueStatsInput {
  /** Only these kinds, answered in this order (a kind with no rows reports zeros); omitted: every kind queued. */
  kinds?: string[];
  /** How long past due an unclaimed row counts as overdue (default 5 minutes, as `selfCheck`'s). */
  overdueAfterMs?: number;
}

export interface WorkQueueKindStats {
  kind: string;
  /** Rows queued (due or not). */
  queued: number;
  /** Rows due now and not held by a worker. */
  due: number;
  /** Rows due for longer than `overdueAfterMs` and not held by a worker. */
  overdue: number;
  /** Rows a worker holds right now. */
  claimed: number;
  /** Rows whose last runs failed (`attempts > 0`, backing off). */
  retrying: number;
  /** The earliest `not_before` of the rows no worker holds, epoch ms; absent when there is none. */
  nextDueAt?: number;
}

export interface WorkQueueStats {
  /** When the queue was read (the database clock, `compute_now()`), epoch ms. */
  at: number;
  overdueAfterMs: number;
  /** Workers whose heartbeat is under a minute old. */
  liveWorkers: number;
  kinds: WorkQueueKindStats[];
}

const kindPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const maxWorkQueueKinds = 100;
export const defaultOverdueAfterMs = 5 * 60_000;

export function parseWorkQueueStats(raw: unknown): WorkQueueStatsInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  if (typeof input !== 'object' || Array.isArray(input))
    throw new ComputeError('INVALID_INPUT', 'The request must be an object');
  for (const key of Object.keys(input))
    if (key !== 'kinds' && key !== 'overdueAfterMs')
      throw new ComputeError('INVALID_INPUT', `Unknown field ${JSON.stringify(key)}`);
  const result: WorkQueueStatsInput = {};
  if (input.kinds !== undefined) {
    if (
      !Array.isArray(input.kinds) ||
      input.kinds.length === 0 ||
      input.kinds.length > maxWorkQueueKinds ||
      input.kinds.some((kind) => typeof kind !== 'string' || !kindPattern.test(kind))
    )
      throw new ComputeError(
        'INVALID_INPUT',
        `kinds must list 1 to ${maxWorkQueueKinds} work kinds (letters, digits, . _ : -)`,
      );
    result.kinds = [...new Set(input.kinds as string[])];
  }
  if (input.overdueAfterMs !== undefined) {
    const value = input.overdueAfterMs;
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > 7 * 24 * 3_600_000
    )
      throw new ComputeError('INVALID_INPUT', 'overdueAfterMs must be an integer from 0 to 7 days');
    result.overdueAfterMs = value;
  }
  return result;
}

/** The JSON Schema of `system.workQueue`'s input. */
export const workQueueStatsSchema = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    kinds: {
      type: 'array',
      minItems: 1,
      maxItems: maxWorkQueueKinds,
      items: { type: 'string', pattern: kindPattern.source, maxLength: 128 },
      description:
        'Only these kinds, in this order (a kind with no rows reports zeros); omitted: every kind queued',
    },
    overdueAfterMs: {
      type: 'integer',
      minimum: 0,
      maximum: 7 * 24 * 3_600_000,
      default: defaultOverdueAfterMs,
      description: 'How long past due an unclaimed row counts as overdue',
    },
  },
} as const;

interface StatsRow {
  kind: string;
  queued: number;
  due: number;
  overdue: number;
  claimed: number;
  retrying: number;
  next_due_ms: number | string | null;
}

const statsQuery = `SELECT kind,
       count(*)::int AS queued,
       count(*) FILTER (WHERE not_before <= compute_now()
                          AND (claimed_until IS NULL OR claimed_until < compute_now()))::int AS due,
       count(*) FILTER (WHERE not_before <= compute_now() - make_interval(secs => $2::float8)
                          AND (claimed_until IS NULL OR claimed_until < compute_now()))::int AS overdue,
       count(*) FILTER (WHERE claimed_until >= compute_now())::int AS claimed,
       count(*) FILTER (WHERE attempts > 0)::int AS retrying,
       (extract(epoch FROM min(not_before) FILTER (
          WHERE not_before <> 'infinity' AND (claimed_until IS NULL OR claimed_until < compute_now())
        )) * 1000)::float8 AS next_due_ms
  FROM work_queue
 WHERE ($1::text[] IS NULL OR kind = ANY($1::text[]))
 GROUP BY kind
 ORDER BY kind`;

const headerQuery = `SELECT (extract(epoch FROM compute_now()) * 1000)::float8 AS at_ms,
  (SELECT count(*) FROM workers wk WHERE wk.heartbeat_at > compute_now() - interval '1 minute')::int AS live_workers`;

/** Reads the work queue's backlog (read-only). */
export async function workQueueStats(
  database: Pick<SqlExecutor, 'query'>,
  input: WorkQueueStatsInput,
): Promise<WorkQueueStats> {
  const overdueAfterMs = input.overdueAfterMs ?? defaultOverdueAfterMs;
  const { rows } = await database.query<StatsRow>(statsQuery, [
    input.kinds ?? null,
    overdueAfterMs / 1000,
  ]);
  const { rows: header } = await database.query<{ at_ms: number | string; live_workers: number }>(
    headerQuery,
  );
  const stats = (kind: string, row: StatsRow | undefined): WorkQueueKindStats => {
    const out: WorkQueueKindStats = {
      kind,
      queued: Number(row?.queued ?? 0),
      due: Number(row?.due ?? 0),
      overdue: Number(row?.overdue ?? 0),
      claimed: Number(row?.claimed ?? 0),
      retrying: Number(row?.retrying ?? 0),
    };
    const next = row?.next_due_ms;
    if (next !== null && next !== undefined && Number.isFinite(Number(next)))
      out.nextDueAt = Number(next);
    return out;
  };
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  return {
    at: Number(header[0]?.at_ms ?? 0),
    overdueAfterMs,
    liveWorkers: Number(header[0]?.live_workers ?? 0),
    kinds: input.kinds
      ? input.kinds.map((kind) => stats(kind, byKind.get(kind)))
      : rows.map((row) => stats(row.kind, row)),
  };
}
