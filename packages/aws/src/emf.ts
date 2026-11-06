import { ComputeError, systemClock, type Clock } from '@better-compute/core';

export interface PromSample {
  /** The series name as exposed (`x_total`, `x_sum`, `x_bucket`, …). */
  name: string;
  labels: Readonly<Record<string, string>>;
  value: number;
  /** The family's `# TYPE` (histogram for its `_bucket`, `_sum` and `_count` series). */
  type: 'counter' | 'gauge' | 'histogram' | 'untyped';
}

/** A sample value; undefined when malformed (the line is skipped). */
function parseValue(text: string): number | undefined {
  if (text === '+Inf') return Number.POSITIVE_INFINITY;
  if (text === '-Inf') return Number.NEGATIVE_INFINITY;
  if (text === 'NaN') return Number.NaN;
  const value = Number(text);
  return Number.isNaN(value) ? undefined : value;
}

function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = Object.create(null) as Record<string, string>;
  let i = 0;
  while (i < text.length) {
    const nameMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"/.exec(text.slice(i));
    if (!nameMatch) break;
    i += nameMatch[0].length;
    let value = '';
    for (;;) {
      const char = text[i];
      if (char === undefined) throw new ComputeError('INVALID_INPUT', 'unterminated label value');
      i++;
      if (char === '"') break;
      if (char === '\\') {
        const next = text[i++];
        value += next === 'n' ? '\n' : (next ?? '');
      } else value += char;
    }
    labels[nameMatch[1]!] = value;
    const comma = /^\s*,?/.exec(text.slice(i));
    i += comma ? comma[0].length : 0;
  }
  return { ...labels };
}

/** Parses the Prometheus text format 0.0.4 (what `MetricsRegistry.expose()` returns). */
export function parsePrometheusText(text: string): PromSample[] {
  const types = new Map<string, PromSample['type']>();
  const samples: PromSample[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#')) {
      const type = /^#\s*TYPE\s+([A-Za-z_:][A-Za-z0-9_:]*)\s+(counter|gauge|histogram|summary|untyped)\s*$/.exec(line);
      if (type) types.set(type[1]!, type[2] === 'summary' ? 'untyped' : (type[2] as PromSample['type']));
      continue;
    }
    const match = /^([A-Za-z_:][A-Za-z0-9_:]*)(\{(.*)\})?\s+(\S+)(\s+\S+)?$/.exec(line);
    if (!match) continue;
    const name = match[1]!;
    const histogram = ['_bucket', '_sum', '_count'].some(
      (suffix) => name.endsWith(suffix) && types.get(name.slice(0, -suffix.length)) === 'histogram',
    );
    const type = types.get(name) ?? (histogram ? 'histogram' : 'untyped');
    const value = parseValue(match[4]!);
    if (value === undefined) continue;
    samples.push({ name, labels: match[3] ? parseLabels(match[3]) : {}, value, type });
  }
  return samples;
}

export interface EmfMetricsExporterOptions {
  registry: { expose(): string };
  /** Default 'BetterCompute'. */
  namespace?: string;
  /** Labels kept as EMF dimensions (default ['module','method','code','pool','kind']); all others dropped (cardinality). */
  dimensions?: readonly string[];
  /** Default 60_000. */
  intervalMs?: number;
  /** Default `process.stdout.write(line + '\n')` (the awslogs driver ships stdout to CloudWatch Logs). */
  out?: (line: string) => void;
  clock?: Clock;
  /** The registry's metric-name prefix, dropped from EMF names (default 'better_compute_'). */
  prefix?: string;
}

const maxMetricsPerDocument = 100;
const maxDimensions = 30;

/**
 * Writes the registry as CloudWatch Embedded Metric Format lines: counters (and histogram `_sum`
 * and `_count`) as deltas since the last flush (the first flush records a baseline), gauges as
 * values. Only the dimension labels are kept; series that differ only in dropped labels are summed.
 */
export function emfMetricsExporter(options: EmfMetricsExporterOptions): { flush(): void; start(): void; stop(): void } {
  const namespace = options.namespace ?? 'BetterCompute';
  if (!/^[A-Za-z0-9 ._/#:-]{1,255}$/.test(namespace)) throw new ComputeError('INVALID_CONFIG', 'not a CloudWatch namespace');
  const dimensions = [...(options.dimensions ?? ['module', 'method', 'code', 'pool', 'kind'])];
  if (dimensions.length > maxDimensions) throw new ComputeError('INVALID_CONFIG', `EMF allows at most ${maxDimensions} dimensions`);
  const intervalMs = options.intervalMs ?? 60_000;
  const out = options.out ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const clock = options.clock ?? systemClock;
  const prefix = options.prefix ?? 'better_compute_';
  const previous = new Map<string, number>();
  let baselined = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function flush(): void {
    const samples = parsePrometheusText(options.registry.expose());
    const seen = new Map<string, number>();
    /** dimension-set key → { dims, metrics: name → value } */
    const groups = new Map<string, { dims: Record<string, string>; metrics: Map<string, number> }>();
    for (const sample of samples) {
      if (sample.type === 'histogram' && !/_(sum|count)$/.test(sample.name)) continue;
      if (!Number.isFinite(sample.value)) continue;
      const seriesKey = `${sample.name}${JSON.stringify(Object.entries(sample.labels).sort())}`;
      let value = sample.value;
      if (sample.type === 'counter' || sample.type === 'histogram') {
        const before = previous.get(seriesKey);
        seen.set(seriesKey, sample.value);
        if (!baselined) continue;
        // A reset counter (process restart) starts again from zero.
        value = before === undefined ? sample.value : sample.value >= before ? sample.value - before : sample.value;
      }
      const dims: Record<string, string> = {};
      for (const name of dimensions) {
        const label = sample.labels[name];
        if (label !== undefined && label !== '') dims[name] = label;
      }
      const groupKey = JSON.stringify(Object.entries(dims).sort());
      const group = groups.get(groupKey) ?? { dims, metrics: new Map<string, number>() };
      groups.set(groupKey, group);
      const metric = sample.name.startsWith(prefix) ? sample.name.slice(prefix.length) : sample.name;
      group.metrics.set(metric, (group.metrics.get(metric) ?? 0) + value);
    }
    for (const [key, value] of seen) previous.set(key, value);
    baselined = true;
    const timestamp = clock.now();
    for (const { dims, metrics } of groups.values()) {
      const entries = [...metrics].filter(([name]) => !Object.hasOwn(dims, name));
      for (let i = 0; i < entries.length; i += maxMetricsPerDocument) {
        const slice = entries.slice(i, i + maxMetricsPerDocument);
        const document: Record<string, unknown> = {
          _aws: {
            Timestamp: timestamp,
            CloudWatchMetrics: [
              { Namespace: namespace, Dimensions: [Object.keys(dims).sort()], Metrics: slice.map(([name]) => ({ Name: name })) },
            ],
          },
          ...dims,
        };
        for (const [name, value] of slice) document[name] = value;
        out(JSON.stringify(document));
      }
    }
  }

  return {
    flush,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        try {
          flush();
        } catch {
          /* a malformed exposition is skipped; the next interval tries again */
        }
      }, intervalMs);
      (timer as { unref?: () => void }).unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
