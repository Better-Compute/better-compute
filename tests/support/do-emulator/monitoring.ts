import type { DoEmulator } from './index.js';
import type { Json } from './state.js';

// Monitoring under `/v2/monitoring` (DigitalOcean P9): Droplet metrics as Prometheus range results
// (`{ status, data: { resultType: 'matrix', result: [{ metric, values: [[seconds, "value"]] }] } }`, spec), and the
// alert policy list. A test seeds series with `seedMetric`; a metric with no series answers an empty result.

export interface EmulatedMonitoring {
  /** `<host_id>/<metric>` → the result series. */
  series: Map<string, Json[]>;
  alerts: Json[];
}

const all = new WeakMap<DoEmulator, EmulatedMonitoring>();

export function monitoringOf(emulator: DoEmulator): EmulatedMonitoring {
  let monitoring = all.get(emulator);
  if (!monitoring) {
    monitoring = { series: new Map(), alerts: [] };
    all.set(emulator, monitoring);
  }
  return monitoring;
}

/** Adds a series of `metric` for Droplet `hostId`: `labels` beyond host_id, and `[seconds, value]` points. */
export function seedMetric(
  emulator: DoEmulator,
  hostId: number | string,
  metric: string,
  labels: Record<string, string>,
  points: [number, number][],
): void {
  const key = `${hostId}/${metric}`;
  const list = monitoringOf(emulator).series.get(key) ?? [];
  list.push({
    metric: { host_id: String(hostId), ...labels },
    values: points.map(([at, value]) => [at, String(value)]),
  });
  monitoringOf(emulator).series.set(key, list);
}

const metrics = new Set([
  'cpu',
  'memory_total',
  'memory_available',
  'load_1',
  'filesystem_size',
  'filesystem_free',
  'bandwidth',
]);

export function registerMonitoring(emulator: DoEmulator): void {
  emulator.route('GET', /^\/monitoring\/metrics\/droplet\/([a-z_0-9]+)$/, (context) => {
    const metric = context.match[1]!;
    const query = context.url.searchParams;
    const host = query.get('host_id');
    const start = Number(query.get('start'));
    const end = Number(query.get('end'));
    if (!metrics.has(metric) || !host || !Number.isFinite(start) || !Number.isFinite(end))
      return emulator.error('422-unknown');
    if (metric === 'bandwidth' && (!query.get('interface') || !query.get('direction')))
      return emulator.error('422-unknown');
    const series = (monitoringOf(emulator).series.get(`${host}/${metric}`) ?? [])
      .filter(
        (s) =>
          metric !== 'bandwidth' ||
          (s.metric.interface === query.get('interface') &&
            s.metric.direction === query.get('direction')),
      )
      .map((s) => ({
        ...s,
        values: (s.values as [number, string][]).filter(([at]) => at >= start && at <= end),
      }));
    return {
      status: 200,
      body: { status: 'success', data: { resultType: 'matrix', result: series } },
    };
  });
  emulator.route('GET', /^\/monitoring\/alerts$/, (context) =>
    emulator.paged(context, 'policies', monitoringOf(emulator).alerts),
  );
}
