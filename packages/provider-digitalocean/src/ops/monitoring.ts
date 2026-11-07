import { isComputeError, type ProviderContext } from '@better-compute/core';
import { clientFor } from '../client/build.js';
import type { DoClient } from '../client/http.js';
import type { DoConfig, DoProviderOptions } from '../config.js';
import { parseMachineId } from '../ids.js';

// Droplet metrics from DigitalOcean Monitoring (P9) as an `externalMetrics` source (observability's
// `ExternalMetricsSource`, matched structurally: this package does not depend on observability). For attached
// Droplets that run no bcd, so they have no OTLP export of their own; the Droplet needs DO's metrics agent
// (`monitoring: true` at create, the default).
//
// Each metric is one `GET /monitoring/metrics/droplet/<metric>?host_id&start&end` over the last ten minutes
// (Prometheus range results, scope `monitoring:read`), on the `sweep` budget. Defaults read CPU, memory and load
// (four requests per Droplet); `filesystem` (two) and `bandwidth` (two) are opt-in. CPU is utilisation over the last
// two points of the per-mode CPU-seconds counters; memory used is total less available; the filesystem is the root
// mount's. Bandwidth is read as megabits per second (unverified unit) and reported as bytes per second.
//
// Droplets are read four at a time (`concurrency`). When the budget runs out mid-pull, or the caller's signal aborts
// (vps gives each account's read a deadline), the samples read so far are answered and the next pull starts at the
// first Droplet this one read nothing for, so every Droplet gets its turn; a missing scope fails the pull. A machine id that is not a Droplet id,
// and a Droplet DO has no data for, give no sample.

export type DoMetricGroup = 'cpu' | 'memory' | 'load' | 'filesystem' | 'bandwidth';

/** The metric names of observability's `externalMetricNames` this source reports. */
export type DoExternalMetric =
  | 'cpu_utilization_ratio'
  | 'memory_used_bytes'
  | 'memory_total_bytes'
  | 'load1'
  | 'filesystem_used_bytes'
  | 'filesystem_size_bytes'
  | 'network_receive_bytes_per_second'
  | 'network_transmit_bytes_per_second';

export interface DoMetricSample {
  instance: string;
  metric: DoExternalMetric;
  value: number;
  at: number;
}

export interface DoMetricsSource {
  readonly id: 'digitalocean';
  read(
    machines: readonly { instance: string; machineId: string }[],
    context: { signal: AbortSignal },
  ): Promise<DoMetricSample[]>;
}

export interface DoMetricsOptions extends DoProviderOptions {
  /** Default `['cpu', 'memory', 'load']`. */
  metrics?: readonly DoMetricGroup[];
  /** Droplets read at a time (each one's requests stay sequential). Default 4. */
  concurrency?: number;
}

const windowSeconds = 600;
const megabitBytes = 125_000;

interface Series {
  metric?: Record<string, string>;
  values?: [number, string][];
}

/** The points of each series of a range result, as `[ms, value]`, oldest first; unreadable points dropped. */
function seriesOf(body: unknown): { labels: Record<string, string>; points: [number, number][] }[] {
  const result = (body as { data?: { result?: Series[] } } | undefined)?.data?.result;
  if (!Array.isArray(result)) return [];
  return result.map((series) => ({
    labels: series.metric ?? {},
    points: (series.values ?? [])
      .map(([at, value]) => [Number(at) * 1000, Number(value)] as [number, number])
      .filter(([at, value]) => Number.isFinite(at) && Number.isFinite(value))
      .sort((a, b) => a[0] - b[0]),
  }));
}

const last = (points: readonly [number, number][]) => points[points.length - 1];

export function doMetricsSource(
  config: DoConfig,
  context: ProviderContext,
  options: DoMetricsOptions = {},
): DoMetricsSource {
  const client: DoClient = clientFor(config, context, options);
  const groups = new Set(options.metrics ?? ['cpu', 'memory', 'load']);
  let cursor = 0;

  async function range(
    metric: string,
    host: number,
    signal: AbortSignal,
    extra: Record<string, string> = {},
  ) {
    const end = Math.floor(context.clock.now() / 1000);
    const body = await client.request<unknown>('GET', `/monitoring/metrics/droplet/${metric}`, {
      query: {
        host_id: String(host),
        start: String(end - windowSeconds),
        end: String(end),
        ...extra,
      },
      signal,
      budget: 'sweep',
    });
    return seriesOf(body);
  }

  async function readOne(
    instance: string,
    host: number,
    signal: AbortSignal,
    out: DoMetricSample[],
  ): Promise<void> {
    const push = (metric: DoExternalMetric, value: number, at: number) => {
      if (Number.isFinite(value) && Number.isFinite(at)) out.push({ instance, metric, value, at });
    };
    if (groups.has('cpu')) {
      const series = await range('cpu', host, signal);
      let total = 0;
      let idle = 0;
      let at = 0;
      let complete = series.length > 0;
      for (const { labels, points } of series) {
        if (points.length < 2) {
          complete = false;
          continue;
        }
        const [t1, v1] = points[points.length - 1]!;
        const [, v0] = points[points.length - 2]!;
        const delta = Math.max(0, v1 - v0);
        total += delta;
        if (labels.mode === 'idle') idle += delta;
        at = Math.max(at, t1);
      }
      if (complete && total > 0)
        push('cpu_utilization_ratio', Math.min(1, Math.max(0, 1 - idle / total)), at);
    }
    if (groups.has('memory')) {
      const total = last((await range('memory_total', host, signal))[0]?.points ?? []);
      const available = last((await range('memory_available', host, signal))[0]?.points ?? []);
      if (total) push('memory_total_bytes', total[1], total[0]);
      if (total && available)
        push(
          'memory_used_bytes',
          Math.max(0, total[1] - available[1]),
          Math.min(total[0], available[0]),
        );
    }
    if (groups.has('load')) {
      const load = last((await range('load_1', host, signal))[0]?.points ?? []);
      if (load) push('load1', load[1], load[0]);
    }
    if (groups.has('filesystem')) {
      const root = (series: Awaited<ReturnType<typeof range>>) =>
        last(series.find((s) => s.labels.mountpoint === '/')?.points ?? []);
      const size = root(await range('filesystem_size', host, signal));
      const free = root(await range('filesystem_free', host, signal));
      if (size) push('filesystem_size_bytes', size[1], size[0]);
      if (size && free)
        push('filesystem_used_bytes', Math.max(0, size[1] - free[1]), Math.min(size[0], free[0]));
    }
    if (groups.has('bandwidth')) {
      for (const [direction, metric] of [
        ['inbound', 'network_receive_bytes_per_second'],
        ['outbound', 'network_transmit_bytes_per_second'],
      ] as const) {
        const point = last(
          (await range('bandwidth', host, signal, { interface: 'public', direction }))[0]?.points ??
            [],
        );
        if (point) push(metric, point[1] * megabitBytes, point[0]);
      }
    }
  }

  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));

  return {
    id: 'digitalocean',
    async read(machines, { signal }) {
      const out: DoMetricSample[] = [];
      const valid = machines.flatMap((machine) => {
        try {
          return [{ instance: machine.instance, host: parseMachineId(machine.machineId) }];
        } catch {
          return [];
        }
      });
      if (valid.length === 0) return out;
      const start = cursor % valid.length;
      // Per Droplet, in pull order: whether it finished, and whether it gave any sample.
      const done = new Array<boolean>(valid.length).fill(false);
      const read = new Array<boolean>(valid.length).fill(false);
      let next = 0;
      let stopped = false;
      let failure: { error: unknown } | undefined;
      async function worker(): Promise<void> {
        while (!stopped && !failure && !signal.aborted && next < valid.length) {
          const i = next++;
          const { instance, host } = valid[(start + i) % valid.length]!;
          const before = out.length;
          try {
            await readOne(instance, host, signal, out);
            done[i] = true;
          } catch (error) {
            if (isComputeError(error, 'NOT_FOUND')) done[i] = true;
            // The budget is spent, or the caller's deadline passed: answer what was read so far.
            else if (signal.aborted || isComputeError(error, 'RATE_LIMITED')) stopped = true;
            else failure ??= { error };
          } finally {
            if (out.length > before) read[i] = true;
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, valid.length) }, worker));
      if (failure) throw failure.error;
      const first = done.findIndex((finished, i) => !finished && !read[i]);
      // The next pull starts at the first Droplet this one gave nothing for (a Droplet read in part had its turn),
      // so every Droplet gets its turn however many fit in one pull.
      cursor = first === -1 ? start : start + first;
      return out;
    },
  };
}
