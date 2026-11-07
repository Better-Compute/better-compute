import { isComputeError, type SqlExecutor } from '@better-compute/core';
import { labelValue, type MetricsRegistry } from './registry.js';

// External host metrics (DigitalOcean P9, the `externalMetrics` source contract): nodes export their own metrics
// over OTLP, but a machine that runs no bcd (an attached VM) has none. A provider whose cloud measures its machines
// (DigitalOcean Monitoring) offers a pull source; this collector pulls it when the host asks (`pull`, on the host's
// own schedule) and fills one gauge per metric, labelled by source and instance id, at scrape time. Samples older
// than `staleAfterMs` read NaN, so a machine that stopped reporting never shows a frozen value. A source that fails
// is counted and keeps its previous samples until they go stale; one source never stops another.

/** The metrics a source may report, in their base units. */
export const externalMetricNames = [
  'cpu_utilization_ratio',
  'memory_used_bytes',
  'memory_total_bytes',
  'load1',
  'filesystem_used_bytes',
  'filesystem_size_bytes',
  'network_receive_bytes_per_second',
  'network_transmit_bytes_per_second',
] as const;

export type ExternalMetricName = (typeof externalMetricNames)[number];

/** A machine to read: the better-compute instance it backs and the provider's machine id. */
export interface ExternalMachineRef {
  instance: string;
  machineId: string;
}

/** One reading of one metric of one machine; `at` is epoch ms of the measurement. */
export interface ExternalMetricSample {
  instance: string;
  metric: ExternalMetricName;
  value: number;
  at: number;
}

/**
 * A pull source of host metrics (provider monitoring APIs). `read` answers the newest sample of each metric it has
 * for the machines asked; a machine or metric it cannot read is left out. It never returns secrets or tenant data.
 */
export interface ExternalMetricsSource {
  /** A short, stable name (`digitalocean`): the `source` label. */
  readonly id: string;
  read(
    machines: readonly ExternalMachineRef[],
    context: { signal: AbortSignal },
  ): Promise<ExternalMetricSample[]>;
}

export interface ExternalMetricsBinding {
  source: ExternalMetricsSource;
  /** The machines to read on each pull (the host's attached machines on the source's accounts). */
  machines: () => readonly ExternalMachineRef[] | Promise<readonly ExternalMachineRef[]>;
}

export interface ExternalMetricsCollectorOptions {
  /** Samples older than this read NaN (default 15 minutes). */
  staleAfterMs?: number;
  /** Epoch ms (tests). */
  now?: () => number;
  /** How long one pull may take, per source (default 60 s). */
  pullTimeoutMs?: number;
}

export interface ExternalMetricsCollector {
  /** Reads every source once, in parallel; answers how many samples each source gave or why it failed. */
  pull(signal?: AbortSignal): Promise<{ source: string; samples: number; error?: string }[]>;
}

const sourcePattern = /^[a-z][a-z0-9-]{0,31}$/;

/** Registers the external host gauges and returns the collector the host pulls. */
export function externalMetricsCollector(
  registry: MetricsRegistry,
  sources: readonly ExternalMetricsBinding[],
  options: ExternalMetricsCollectorOptions = {},
): ExternalMetricsCollector {
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? 15 * 60_000;
  const pullTimeoutMs = options.pullTimeoutMs ?? 60_000;
  for (const { source } of sources)
    if (!sourcePattern.test(source.id))
      throw new Error(
        `external metrics source id ${JSON.stringify(source.id)} is not [a-z][a-z0-9-]{0,31}`,
      );
  const gauges = new Map(
    externalMetricNames.map((name) => [
      name,
      registry.gauge(
        `external_host_${name}`,
        `A host metric of a machine that runs no bcd, pulled from its provider (${name})`,
        ['source', 'instance'],
      ),
    ]),
  );
  const failures = registry.counter(
    'external_metrics_pull_failures_total',
    'Pulls of an external metrics source that failed',
    ['source', 'code'],
  );
  const lastPull = registry.gauge(
    'external_metrics_last_pull_timestamp_seconds',
    'When an external metrics source last answered (epoch seconds)',
    ['source'],
  );
  /** source → instance|metric → sample. */
  const latest = new Map<string, Map<string, ExternalMetricSample>>();

  registry.collect(() => {
    const cutoff = now() - staleAfterMs;
    for (const [source, samples] of latest)
      for (const sample of samples.values())
        gauges
          .get(sample.metric)
          ?.set(
            { source, instance: labelValue(sample.instance) },
            sample.at >= cutoff ? sample.value : Number.NaN,
          );
  });

  return {
    async pull(signal) {
      return Promise.all(
        sources.map(async ({ source, machines }) => {
          const timeout = AbortSignal.timeout(pullTimeoutMs);
          const bound = signal ? AbortSignal.any([signal, timeout]) : timeout;
          try {
            const list = await machines();
            const samples = list.length === 0 ? [] : await source.read(list, { signal: bound });
            const known = new Set(list.map((machine) => machine.instance));
            const kept = latest.get(source.id) ?? new Map<string, ExternalMetricSample>();
            for (const sample of samples) {
              // Only the machines asked for, only known metrics, only finite values: a source cannot add series.
              if (!known.has(sample.instance) || !gauges.has(sample.metric)) continue;
              if (!Number.isFinite(sample.value) || !Number.isFinite(sample.at)) continue;
              const key = `${sample.instance}\u0000${sample.metric}`;
              const seen = kept.get(key);
              if (!seen || sample.at >= seen.at) kept.set(key, sample);
            }
            // A machine no longer listed is dropped (its series read NaN once its samples go stale).
            for (const [key, sample] of kept)
              if (!known.has(sample.instance)) {
                kept.delete(key);
                gauges
                  .get(sample.metric)
                  ?.set({ source: source.id, instance: labelValue(sample.instance) }, Number.NaN);
              }
            latest.set(source.id, kept);
            lastPull.set({ source: source.id }, Math.floor(now() / 1000));
            return { source: source.id, samples: samples.length };
          } catch (error) {
            const code = isComputeError(error) ? error.code : 'INTERNAL_ERROR';
            failures.inc({ source: source.id, code });
            return { source: source.id, samples: 0, error: code };
          }
        }),
      );
    },
  };
}

/**
 * A binding that serves what vps stored (`vps({ externalMetrics })` reads each provider account's machines into
 * `instance_external_metrics` once per period): the samples of one source (a provider id) as the provider measured
 * them, so every process of a deployment serves the same gauges without asking the provider itself. Before vps has
 * migrated the table it answers nothing.
 */
export function storedExternalMetrics(
  sql: { query: SqlExecutor['query'] },
  source: string,
): ExternalMetricsBinding {
  let present = false;
  let rows: { instance_id: string; metric: string; value: number; at_ms: number }[] = [];
  return {
    async machines() {
      if (!present) {
        const { rows: found } = await sql.query<{ found: string | null }>(
          'SELECT to_regclass($1)::text AS found',
          ['instance_external_metrics'],
        );
        present = Boolean(found[0]?.found);
        if (!present) return [];
      }
      ({ rows } = await sql.query<{ instance_id: string; metric: string; value: number; at_ms: number }>(
        `SELECT instance_id, metric, value, (extract(epoch FROM at) * 1000)::float8 AS at_ms
           FROM instance_external_metrics WHERE source = $1 ORDER BY instance_id, metric`,
        [source],
      ));
      return [...new Set(rows.map((row) => row.instance_id))].map((instance) => ({
        instance,
        machineId: instance,
      }));
    },
    source: {
      id: source,
      async read() {
        return rows.flatMap((row) =>
          (externalMetricNames as readonly string[]).includes(row.metric)
            ? [
                {
                  instance: row.instance_id,
                  metric: row.metric as ExternalMetricName,
                  value: Number(row.value),
                  at: Number(row.at_ms),
                },
              ]
            : [],
        );
      },
    },
  };
}
