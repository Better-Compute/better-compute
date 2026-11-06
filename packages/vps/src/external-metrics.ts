import {
  ComputeError,
  isComputeError,
  parseDuration,
  type Duration,
  type Migration,
  type ModuleContext,
  type ProviderMetricSample,
  type ReconcileContext,
  type Reconciler,
} from '@better-compute/core';
import { readAccount } from './accounts.js';
import type { CostsDeps } from './costs.js';

// External host metrics (DigitalOcean P9): a VM on a provider pool runs no bcd, so it exports no metrics of its own.
// A provider whose cloud measures its machines reads them (`ProviderImpl.readMetrics`); this opt-in worker
// (`vps({ externalMetrics: {} })`) asks it on a schedule for the account's live instances and keeps the newest
// sample per instance and metric in `instance_external_metrics`. Every process of a deployment then serves the same
// gauges from that table (`storedExternalMetrics` in @better-compute/observability), and the provider is asked once
// per period, not once per replica. Key `all` enqueues each account whose client reads metrics; key `<accountId>`
// reads one account. A failing read is logged and waits for the next period (the rows go stale, read NaN).

export const externalMetricsWork = 'vps.external-metrics';

/** How long one account's read may take. */
export const externalMetricsReadMs = 45_000;
/** The most instances one account's read asks for. */
export const externalMetricsMachineLimit = 500;

export interface ExternalMetricsOptions {
  /** How often each account is read (default `5m`, at least `1m`). */
  every?: Duration;
}

export const externalMetricsMigration: Migration = {
  name: 'vps/0075_instance_external_metrics',
  sql: `
-- (P9) The newest provider-measured host metric of an instance that runs no bcd, per metric.
CREATE TABLE instance_external_metrics (
  instance_id text NOT NULL REFERENCES instances ON DELETE CASCADE,
  metric text NOT NULL,
  -- The provider id: the gauges' source label.
  source text NOT NULL,
  account_id text NOT NULL REFERENCES provider_accounts ON DELETE CASCADE,
  value float8 NOT NULL,
  -- When the provider measured it.
  at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT compute_now(),
  PRIMARY KEY (instance_id, metric)
);
CREATE INDEX instance_external_metrics_source ON instance_external_metrics (source);
CREATE INDEX instance_external_metrics_account ON instance_external_metrics (account_id);
`,
};

const metricPattern = /^[a-z][a-z0-9_]{0,63}$/;

export function externalMetricsSettings(options: ExternalMetricsOptions): {
  every: Duration;
  everyMs: number;
} {
  const every = options.every ?? '5m';
  const everyMs = parseDuration(every);
  if (!(everyMs >= 60_000))
    throw new ComputeError(
      'INVALID_CONFIG',
      'vps({ externalMetrics: { every } }) must be at least 1m',
    );
  return { every, everyMs };
}

const readsMetrics = (client: { readMetrics?: unknown }): boolean =>
  typeof client.readMetrics === 'function';

/** Key `all`: enqueues every account whose client reads metrics (building a client calls no provider API). */
async function seed(deps: CostsDeps, context: ReconcileContext): Promise<void> {
  const { rows } = await context.sql.query<{ id: string }>(
    `SELECT id FROM provider_accounts ORDER BY id`,
  );
  const reading: string[] = [];
  for (const { id } of rows)
    try {
      const account = await context.sql.transaction((tx) => readAccount(tx, id));
      if (account && readsMetrics(await deps.clients.client(account, deps))) reading.push(id);
    } catch (error) {
      deps.log.warn('vps.external-metrics: skipping an account whose client cannot be built', {
        accountId: id,
        error: String((error as Error)?.message ?? error),
      });
    }
  if (reading.length === 0) return;
  await context.sql.transaction(async (tx) => {
    if (context.work.enqueueMany) await context.work.enqueueMany(tx, externalMetricsWork, reading);
    else for (const id of reading) await context.work.enqueue(tx, externalMetricsWork, id);
  });
}

/** Key `<accountId>`: reads the metrics of the account's live instances and stores the newest of each. */
async function readAccountMetrics(
  deps: CostsDeps,
  context: ReconcileContext,
  accountId: string,
): Promise<{ instances: number; samples: number } | undefined> {
  const account = await context.sql.transaction((tx) => readAccount(tx, accountId));
  if (!account) return undefined;
  const client = await deps.clients.client(account, deps);
  if (!client.readMetrics) return undefined;
  // Every live instance of the account the provider names: a provider-pool VM runs no bcd.
  const { rows: live } = await context.sql.query<{ id: string; external_id: string }>(
    `SELECT id, external_id FROM instances
      WHERE provider_account_id = $1 AND external_id IS NOT NULL
        AND state NOT IN ('deleted', 'deleting', 'lost', 'error')
      ORDER BY id LIMIT ${externalMetricsMachineLimit}`,
    [account.id],
  );
  const machines = live.map((row) => ({ instance: row.id, machineId: row.external_id }));
  let samples: ProviderMetricSample[] = [];
  if (machines.length > 0) {
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(externalMetricsReadMs)]);
    try {
      samples = await client.readMetrics(machines, { signal });
    } catch (error) {
      if (context.signal.aborted) throw error;
      deps.log.warn("vps.external-metrics: reading an account's metrics failed", {
        accountId: account.id,
        code: isComputeError(error) ? error.code : 'PROVIDER_ERROR',
        error: String((error as Error)?.message ?? error).slice(0, 500),
      });
      return undefined;
    }
  }
  // Only the instances asked for, well-formed names and finite values: a provider cannot add rows.
  const known = new Set(machines.map((machine) => machine.instance));
  const newest = new Map<string, ProviderMetricSample>();
  for (const sample of Array.isArray(samples) ? samples : []) {
    if (!sample || !known.has(sample.instance) || typeof sample.metric !== 'string') continue;
    if (!metricPattern.test(sample.metric)) continue;
    if (!Number.isFinite(sample.value) || !Number.isFinite(sample.at)) continue;
    const key = `${sample.instance}\u0000${sample.metric}`;
    const seen = newest.get(key);
    if (!seen || sample.at >= seen.at) newest.set(key, sample);
  }
  const kept = [...newest.values()];
  await context.sql.transaction(async (tx) => {
    // An instance no longer live (or no longer on this account) keeps no rows.
    await tx.query(
      `DELETE FROM instance_external_metrics WHERE account_id = $1 AND NOT (instance_id = ANY($2::text[]))`,
      [account.id, [...known]],
    );
    if (kept.length === 0) return;
    // A sample older than the stored one is ignored.
    await tx.query(
      `INSERT INTO instance_external_metrics (instance_id, metric, source, account_id, value, at)
       SELECT s.instance_id, s.metric, $1, $2, s.value, to_timestamp(s.at / 1000)
         FROM unnest($3::text[], $4::text[], $5::float8[], $6::float8[]) AS s(instance_id, metric, value, at)
       ON CONFLICT (instance_id, metric) DO UPDATE
         SET value = EXCLUDED.value, at = EXCLUDED.at, source = EXCLUDED.source,
             account_id = EXCLUDED.account_id, updated_at = compute_now()
         WHERE instance_external_metrics.at <= EXCLUDED.at`,
      [
        account.provider,
        account.id,
        kept.map((sample) => sample.instance),
        kept.map((sample) => sample.metric),
        kept.map((sample) => sample.value),
        kept.map((sample) => sample.at),
      ],
    );
  });
  return { instances: machines.length, samples: kept.length };
}

/** The `vps.external-metrics` reconciler; registered only with `vps({ externalMetrics })`. */
export function externalMetricsReconciler(
  options: ExternalMetricsOptions,
  deps: (context: ModuleContext) => CostsDeps,
): Reconciler {
  const settings = externalMetricsSettings(options);
  return {
    name: externalMetricsWork,
    shardBy: 'none',
    periodic: [{ key: 'all', every: settings.every }],
    async run(context, key) {
      const resolved = deps(context);
      if (key === 'all') await seed(resolved, context);
      else await readAccountMetrics(resolved, context, key);
      return 'DONE';
    },
  };
}
