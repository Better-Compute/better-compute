// The §14 gauges that describe the whole deployment rather than one process, sampled from compute's tables on a
// timer (PLAN.md §14): due work by kind, queue backlogs, nodes by connectivity and generation lag, GPUs by state,
// suspended and deleted tenants with unfinished teardowns, the soonest node certificate expiry, this process's clock against compute_now(), and command latency (enqueue
// to terminal) for commands settled since the last poll. It may run in every worker: the gauges are the same
// everywhere, and the histogram is observed only by the holder of one `leases` row, so each command counts once.
// Every statement except that lease's upsert is read-only and bounded; a table a deployment does not have (an
// optional module's) is skipped.

import type { SqlExecutor } from '@better-compute/core';
import { labelValue, type Labels } from './registry.js';
import type { StandardMetrics } from './standard.js';

export interface DatabaseCollectorOptions {
  sql: Pick<SqlExecutor, 'query'>;
  /** Poll period for `start()` (default 15 s). */
  intervalMs?: number;
  /** This process's clock in ms (default `Date.now`), compared with compute_now(). */
  now?: () => number;
  /** A command kind's lane (`control`, `provision`, `bulk`) for the latency histogram; default `(unknown)`. */
  laneOf?: (kind: string) => string | undefined;
  /**
   * Host certificates to watch besides node certificates (serving, CA, signing), as `{ kind, notAfter }`:
   * `cert_expiry_seconds{kind}` reports the soonest per kind.
   */
  certificates?: () => readonly { kind: string; notAfter: number }[];
  /** Poll failures (never thrown from the timer). */
  onError?: (error: unknown) => void;
  /**
   * The command-latency histogram is observed by one process of the deployment at a time: the holder of this
   * `leases` row (default `metrics:command-latency`), so running the collector in every worker counts each
   * command once. The gauges are sampled everywhere. `false` observes in this process unconditionally.
   */
  latencyLease?: string | false;
  /** This process's lease owner id (default a random id). */
  owner?: string;
}

export interface DatabaseCollector {
  /** Runs one poll now. */
  refresh(): Promise<void>;
  /** Polls every `intervalMs` until `stop()`. */
  start(): void;
  stop(): void;
}

const terminal = ['succeeded', 'failed', 'rejected', 'expired', 'cancelled'];
/** At most this many settled commands are observed per poll (the rest wait for the next one). */
const latencyBatch = 5_000;
/** Outbox rows past a cursor are counted up to this bound. */
const backlogCap = 100_000;

/**
 * Samples compute's tables into `metrics` (from `standardMetrics(registry)`):
 *
 * ```ts
 * const metrics = standardMetrics(registry);
 * const collector = databaseCollector(metrics, { sql: compute.database });
 * collector.start(); // in the worker role
 * ```
 */
export function databaseCollector(
  metrics: StandardMetrics,
  options: DatabaseCollectorOptions,
): DatabaseCollector {
  const { sql } = options;
  const now = options.now ?? Date.now;
  const tables = new Map<string, boolean>();
  const columns = new Map<string, boolean>();
  /** Label sets each gauge was given last time, so ones that disappeared read 0 instead of going stale. */
  const lastSets = new Map<object, Map<string, Labels>>();
  let latencySince: string | undefined;
  /** Where the sandbox series left off (timestamptz text): readiness, expiry and warm refills. */
  let sandboxSince: { ready: string; expired: string; refilled: string } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  const intervalMs = options.intervalMs ?? 15_000;
  const lease =
    options.latencyLease === undefined ? 'metrics:command-latency' : options.latencyLease;
  const owner = options.owner ?? `collector-${globalThis.crypto.randomUUID()}`;
  // Three polls without a renewal hand the histogram to another process.
  const leaseSeconds = Math.max(5, (3 * intervalMs) / 1000);

  let stopped = false;

  /** Takes or renews the latency lease; false while another live process holds it, or after `stop()`. */
  async function holdsLatencyLease(): Promise<boolean> {
    if (lease === false) return true;
    if (stopped) return false;
    const { rows } = await sql.query(
      `INSERT INTO leases (name, owner, epoch, expires_at)
       VALUES ($1, $2, 1, compute_now() + make_interval(secs => $3))
       ON CONFLICT (name) DO UPDATE SET owner = EXCLUDED.owner,
              epoch = CASE WHEN leases.owner = EXCLUDED.owner THEN leases.epoch ELSE leases.epoch + 1 END,
              expires_at = EXCLUDED.expires_at
        WHERE leases.owner = EXCLUDED.owner OR leases.expires_at < compute_now()
       RETURNING epoch`,
      [lease, owner, leaseSeconds],
    );
    return rows.length > 0;
  }

  async function exists(table: string): Promise<boolean> {
    let found = tables.get(table);
    if (found === undefined) {
      const { rows } = await sql.query<{ found: string | null }>(
        'SELECT to_regclass($1)::text AS found',
        [table],
      );
      found = Boolean(rows[0]?.found);
      // A missing table may appear once its module migrates; only a present one is remembered.
      if (found) tables.set(table, true);
    }
    return found;
  }

  async function hasColumn(table: string, column: string): Promise<boolean> {
    const key = `${table}.${column}`;
    let found = columns.get(key);
    if (found === undefined) {
      const { rows } = await sql.query(
        'SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2',
        [table, column],
      );
      found = rows.length > 0;
      if (found) columns.set(key, true);
    }
    return found;
  }

  /** Sets every given label set and zeroes the ones set last time but not now. */
  function setAll(
    gauge: { set(labels: Labels | undefined, value: number): void },
    values: readonly [Labels, number][],
  ) {
    const previous = lastSets.get(gauge) ?? new Map<string, Labels>();
    const current = new Map<string, Labels>();
    for (const [labels, value] of values) {
      const key = JSON.stringify(labels);
      current.set(key, labels);
      gauge.set(labels, value);
    }
    for (const [key, labels] of previous) if (!current.has(key)) gauge.set(labels, 0);
    lastSets.set(gauge, current);
  }

  async function poll(): Promise<void> {
    const { rows: clock } = await sql.query<{ now_ms: string | number; now_text: string }>(
      'SELECT extract(epoch FROM compute_now()) * 1000 AS now_ms, compute_now()::text AS now_text',
    );
    metrics.clockOffset.set(undefined, (now() - Number(clock[0]!.now_ms)) / 1000);

    const { rows: due } = await sql.query<{ kind: string; count: number }>(
      `SELECT kind, count(*)::int AS count FROM work_queue
        WHERE not_before <= compute_now() AND (claimed_until IS NULL OR claimed_until < compute_now())
        GROUP BY kind`,
    );
    setAll(
      metrics.workQueueDepth,
      due.map((row) => [{ kind: labelValue(row.kind) }, Number(row.count)]),
    );

    const { rows: nodes } = await sql.query<{
      connectivity: string;
      count: number;
      lagging: number;
    }>(
      `SELECT connectivity, count(*)::int AS count,
              count(*) FILTER (WHERE observed_generation < generation)::int AS lagging
         FROM nodes WHERE deleted_at IS NULL GROUP BY connectivity`,
    );
    setAll(
      metrics.nodeConnectivity,
      nodes.map((row) => [{ state: labelValue(row.connectivity) }, Number(row.count)]),
    );
    metrics.generationLag.set(
      undefined,
      nodes.reduce((sum, row) => sum + Number(row.lagging), 0),
    );

    const { rows: gpus } = await sql.query<Record<string, string | number | null>>(
      `SELECT sum(total) AS total, sum(allocatable) AS allocatable, sum(allocated) AS allocated,
              sum(reserved) AS reserved, sum(provisioning) AS provisioning, sum(unhealthy) AS unhealthy,
              sum(maintenance) AS maintenance, sum(unreachable) AS unreachable
         FROM pool_capacity_rollup WHERE resource = 'gpu'`,
    );
    setAll(
      metrics.poolGpus,
      Object.entries(gpus[0] ?? {}).map(([state, value]) => [{ state }, Number(value ?? 0)]),
    );

    const backlog: [Labels, number][] = [];
    const count = async (queue: string, table: string, where: string) => {
      if (!(await exists(table))) return;
      const { rows } = await sql.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM (SELECT 1 FROM ${table} WHERE ${where} LIMIT ${backlogCap}) s`,
      );
      backlog.push([{ queue }, Number(rows[0]?.count ?? 0)]);
    };
    await count('commands', 'commands', `state = 'pending'`);
    await count('iam_inbox', 'iam_inbox', 'processed_at IS NULL');
    await count('usage', 'usage_windows', 'recorded_at IS NULL');
    await count('webhooks', 'webhook_deliveries', `state = 'pending'`);
    // Events a sink gave up on (poison isolation, core/0019): they wait for an operator.
    await count('outbox_dead_letters', 'outbox_dead_letters', 'true');
    if (await exists('outbox_cursors')) {
      // Each sink's cursor: rows published after it are its backlog.
      const { rows: cursors } = await sql.query<{ name: string; txid: string; seq: string }>(
        'SELECT name, txid::text AS txid, seq::text AS seq FROM outbox_cursors ORDER BY name',
      );
      for (const cursor of cursors) {
        const { rows } = await sql.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM (
             SELECT 1 FROM outbox o WHERE (o.txid, o.seq) > ($1::xid8, $2::bigint) LIMIT ${backlogCap}) s`,
          [cursor.txid, cursor.seq],
        );
        backlog.push([{ queue: `outbox:${labelValue(cursor.name)}` }, Number(rows[0]?.count ?? 0)]);
      }
    }
    setAll(metrics.backlog, backlog);

    // §3.7 warm pools: unclaimed warm instances by state, and how many the templates are short of warm.min.
    if (await exists('sandbox_templates')) {
      const { rows: warm } = await sql.query<{ state: string; count: number }>(
        `SELECT state, count(*)::int AS count FROM instances
          WHERE warm_template_id IS NOT NULL AND desired_state <> 'deleted' GROUP BY state`,
      );
      setAll(
        metrics.sandboxWarmInstances,
        warm.map((row) => [{ state: labelValue(row.state) }, Number(row.count)]),
      );
      const { rows: deficit } = await sql.query<{ missing: number }>(
        `SELECT coalesce(sum(greatest(0, t.warm_min - coalesce(w.n, 0))), 0)::int AS missing
           FROM sandbox_templates t
           LEFT JOIN (SELECT warm_template_id, count(*)::int AS n FROM instances
                       WHERE warm_template_id IS NOT NULL AND desired_state <> 'deleted'
                       GROUP BY warm_template_id) w ON w.warm_template_id = t.id
          WHERE NOT t.deleted AND t.warm_min > 0`,
      );
      metrics.sandboxWarmDeficit.set(undefined, Number(deficit[0]?.missing ?? 0));
    }

    // §12.8: tenants the envelope refuses, and deleted ones a module is still releasing.
    if (await exists('compute_tenant_states')) {
      const { rows: tenants } = await sql.query<{ state: string; count: number; pending: number }>(
        `SELECT state, count(*)::int AS count,
                count(*) FILTER (WHERE state = 'deleted' AND teardown_done_at IS NULL)::int AS pending
           FROM compute_tenant_states WHERE state <> 'active' GROUP BY state`,
      );
      setAll(
        metrics.tenantStates,
        tenants.map((row) => [{ state: labelValue(row.state) }, Number(row.count)]),
      );
      metrics.tenantTeardownsPending.set(
        undefined,
        tenants.reduce((sum, row) => sum + Number(row.pending), 0),
      );
    }

    // A node's newest live certificate is the one renewals replace: the soonest of those per role is how close
    // the fleet is to a node dropping off because renewals fail.
    const expiries = new Map<string, number>();
    const { rows: certs } = await sql.query<{ role: string; seconds: string | number | null }>(
      `SELECT c.role, extract(epoch FROM min(c.latest) - compute_now()) AS seconds
         FROM (SELECT node_id, role, max(not_after) AS latest FROM node_certs
                WHERE revoked_at IS NULL GROUP BY node_id, role) c
         JOIN nodes n ON n.id = c.node_id AND n.deleted_at IS NULL
        GROUP BY c.role`,
    );
    for (const row of certs)
      if (row.seconds !== null) expiries.set(`node:${labelValue(row.role)}`, Number(row.seconds));
    const nowMs = Number(clock[0]!.now_ms);
    for (const certificate of options.certificates?.() ?? []) {
      const kind = labelValue(certificate.kind);
      const seconds = (certificate.notAfter - nowMs) / 1000;
      expiries.set(kind, Math.min(expiries.get(kind) ?? Infinity, seconds));
    }
    setAll(
      metrics.certExpiry,
      [...expiries].map(([kind, seconds]) => [{ kind }, seconds]),
    );

    const observes = await holdsLatencyLease();
    if (!observes) {
      // Another process observes; if this one takes over later, it starts from then.
      latencySince = undefined;
      sandboxSince = undefined;
    } else await observeSandboxes(clock[0]!.now_text);
    if (observes && (await hasColumn('commands', 'created_at'))) {
      if (latencySince === undefined) {
        // Start from now: history before the collector ran is not re-observed after a restart.
        latencySince = clock[0]!.now_text;
      } else {
        // The cursor stays a timestamptz in text form (exact to the microsecond), never a float.
        const { rows: settled } = await sql.query<{
          kind: string;
          seconds: string | number;
          updated_text: string;
        }>(
          `SELECT kind, extract(epoch FROM updated_at - created_at) AS seconds, updated_at::text AS updated_text
             FROM commands
            WHERE state = ANY($1::text[]) AND updated_at > $2::timestamptz
            ORDER BY updated_at LIMIT ${latencyBatch}`,
          [terminal, latencySince],
        );
        for (const row of settled)
          metrics.commandLatency.observe(
            {
              kind: labelValue(row.kind),
              lane: labelValue(options.laneOf?.(row.kind)),
            },
            Math.max(0, Number(row.seconds)),
          );
        if (settled.length) latencySince = settled.at(-1)!.updated_text;
      }
    }
  }

  /** Sandboxes that became ready or expired, and warm instances created, since the last poll (lease holder only). */
  async function observeSandboxes(nowText: string): Promise<void> {
    if (!(await exists('sandboxes'))) return;
    if (sandboxSince === undefined) {
      // Start from now, as the command histogram does.
      sandboxSince = { ready: nowText, expired: nowText, refilled: nowText };
      return;
    }
    const { rows: ready } = await sql.query<{
      warm: boolean;
      seconds: string | number;
      at: string;
    }>(
      `SELECT warm, extract(epoch FROM ready_at - created_at) AS seconds, ready_at::text AS at FROM sandboxes
        WHERE ready_at > $1::timestamptz ORDER BY ready_at LIMIT ${latencyBatch}`,
      [sandboxSince.ready],
    );
    for (const row of ready)
      metrics.sandboxReady.observe(
        { source: row.warm ? 'warm' : 'cold' },
        Math.max(0, Number(row.seconds)),
      );
    if (ready.length) sandboxSince.ready = ready.at(-1)!.at;
    const { rows: expired } = await sql.query<{ seconds: string | number; at: string }>(
      `SELECT extract(epoch FROM expired_at - expires_at) AS seconds, expired_at::text AS at FROM sandboxes
        WHERE expired_at > $1::timestamptz ORDER BY expired_at LIMIT ${latencyBatch}`,
      [sandboxSince.expired],
    );
    for (const row of expired)
      metrics.sandboxExpiryLag.observe(undefined, Math.max(0, Number(row.seconds)));
    if (expired.length) sandboxSince.expired = expired.at(-1)!.at;
    // A warm instance keeps no mark once claimed but its sandbox's `warm`, so both count.
    const { rows: refills } = await sql.query<{ count: number; at: string | null }>(
      `SELECT count(*)::int AS count, max(i.created_at)::text AS at FROM instances i
        WHERE i.created_at > $1::timestamptz
          AND (i.warm_template_id IS NOT NULL
               OR EXISTS (SELECT 1 FROM sandboxes s WHERE s.instance_id = i.id AND s.warm))`,
      [sandboxSince.refilled],
    );
    const refilled = Number(refills[0]?.count ?? 0);
    if (refilled > 0 && refills[0]!.at) {
      metrics.sandboxWarmRefills.inc(undefined, refilled);
      sandboxSince.refilled = refills[0]!.at;
    }
  }

  const refresh = () => {
    running ??= poll().finally(() => {
      running = undefined;
    });
    return running;
  };

  return {
    refresh,
    start() {
      if (timer) return;
      stopped = false;
      timer = setInterval(() => {
        refresh().catch((error: unknown) => {
          try {
            options.onError?.(error);
          } catch {
            // A broken reporter changes nothing.
          }
        });
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      stopped = true;
      // Hand the histogram over at once rather than at the lease's expiry (best effort).
      if (lease !== false)
        void sql
          .query(
            `UPDATE leases SET expires_at = compute_now() - interval '1 second'
              WHERE name = $1 AND owner = $2`,
            [lease, owner],
          )
          .catch(() => undefined);
    },
  };
}
