// A small, bounded Prometheus registry (PLAN.md §14): metric names carry the `better_compute_` prefix, no label
// may identify a tenant, and each metric's series are capped (`maxSeries`, default 2000) so a runaway label can
// never exhaust memory or the TSDB: new label sets past the cap fold into one `(other)` series, and are counted.

import { ComputeError } from '@better-compute/core';

export type Labels = Readonly<Record<string, string>>;

export interface Counter {
  inc(labels?: Labels, value?: number): void;
}
export interface Gauge {
  set(labels: Labels | undefined, value: number): void;
  inc(labels?: Labels, value?: number): void;
  dec(labels?: Labels, value?: number): void;
}
export interface Histogram {
  observe(labels: Labels | undefined, value: number): void;
  /** Starts a timer; the returned function observes the elapsed seconds. */
  startTimer(labels?: Labels): () => number;
}

export interface MetricsOptions {
  /** Default `better_compute_`. */
  prefix?: string;
  /** Default 2000 (§14). */
  maxSeries?: number;
  /** Label names refused at definition. Default: anything naming a tenant. */
  forbiddenLabels?: readonly string[];
  /** Seconds source for `startTimer` (tests). */
  now?: () => number;
}

type Kind = 'counter' | 'gauge' | 'histogram';

interface Family {
  name: string;
  help: string;
  kind: Kind;
  labelNames: readonly string[];
  buckets?: readonly number[];
  /** key → value (counter/gauge) or { buckets, sum, count } (histogram). */
  series: Map<string, { labels: Labels; value: number; buckets?: number[]; sum?: number }>;
}

const namePattern = /^[a-z_][a-z0-9_]*$/;
const defaultForbidden = [
  'tenant',
  'tenant_id',
  'tenantid',
  'org',
  'organization',
  'identity',
  'user',
];
export const defaultBuckets: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
];

const escapeLabel = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const escapeHelp = (value: string) => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

/** Label values may come from callers: overlong or non-string values read `(invalid)`, empty ones `(unknown)`. */
export function labelValue(value: unknown): string {
  if (value === undefined || value === '') return '(unknown)';
  if (typeof value !== 'string' || value.length > 256) return '(invalid)';
  return value;
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

export interface MetricsRegistry {
  readonly prefix: string;
  counter(name: string, help: string, labelNames?: readonly string[]): Counter;
  gauge(name: string, help: string, labelNames?: readonly string[]): Gauge;
  histogram(
    name: string,
    help: string,
    labelNames?: readonly string[],
    buckets?: readonly number[],
  ): Histogram;
  /** Prometheus text exposition format 0.0.4. */
  expose(): string;
  /** The number of live series, and how many were dropped at the cap. */
  stats(): { series: number; dropped: number };
  /** Looks up a value (tests and health checks). */
  value(name: string, labels?: Labels): number | undefined;
  reset(): void;
}

export function createMetrics(options: MetricsOptions = {}): MetricsRegistry {
  const prefix = options.prefix ?? 'better_compute_';
  const maxSeries = options.maxSeries ?? 2000;
  const forbidden = new Set(
    (options.forbiddenLabels ?? defaultForbidden).map((l) => l.toLowerCase()),
  );
  const now = options.now ?? (() => performance.now() / 1000);
  const families = new Map<string, Family>();
  let series = 0;
  let dropped = 0;

  const define = (
    kind: Kind,
    rawName: string,
    help: string,
    labelNames: readonly string[],
    buckets?: readonly number[],
  ): Family => {
    const name = rawName.startsWith(prefix) ? rawName : `${prefix}${rawName}`;
    if (!namePattern.test(name))
      throw new ComputeError('INVALID_CONFIG', `Invalid metric name ${name}`);
    for (const label of labelNames) {
      if (forbidden.has(label.toLowerCase()))
        throw new ComputeError(
          'INVALID_CONFIG',
          `Label ${label} on ${name} would identify a tenant or person`,
        );
      if (!namePattern.test(label) || label === 'le')
        throw new ComputeError('INVALID_CONFIG', `Invalid label ${label} on ${name}`);
    }
    const existing = families.get(name);
    if (existing) {
      if (existing.kind !== kind || existing.labelNames.join(',') !== labelNames.join(','))
        throw new ComputeError('INVALID_CONFIG', `Metric ${name} is already defined differently`);
      return existing;
    }
    if (buckets && buckets.some((b, i) => i > 0 && b <= buckets[i - 1]!))
      throw new ComputeError('INVALID_CONFIG', `Buckets of ${name} must increase`);
    const family: Family = {
      name,
      help,
      kind,
      labelNames: [...labelNames],
      ...(buckets ? { buckets: [...buckets] } : {}),
      series: new Map(),
    };
    families.set(name, family);
    return family;
  };

  const seriesOf = (family: Family, labels: Labels = {}) => {
    const values = family.labelNames.map((label) => labelValue(labels[label]));
    const extra = Object.keys(labels).find((label) => !family.labelNames.includes(label));
    if (extra)
      throw new ComputeError('INVALID_INPUT', `Metric ${family.name} has no label ${extra}`);
    let key = values.join('\u0000');
    let entry = family.series.get(key);
    if (!entry) {
      // Past the family's budget every new label set shares one `(other)` series (as better-iam does).
      const collapsed = family.series.size >= maxSeries;
      if (collapsed) {
        dropped++;
        values.fill('(other)');
        key = values.join('\u0000');
        entry = family.series.get(key);
      }
      if (!entry) {
        series++;
        entry = {
          labels: Object.fromEntries(family.labelNames.map((label, i) => [label, values[i]!])),
          value: 0,
          ...(family.kind === 'histogram' ? { buckets: family.buckets!.map(() => 0), sum: 0 } : {}),
        };
        family.series.set(key, entry);
      }
    }
    return entry;
  };

  const labelText = (labels: Labels, extra?: [string, string]) => {
    const pairs = Object.entries(labels);
    if (extra) pairs.push(extra);
    return pairs.length ? `{${pairs.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}` : '';
  };

  return {
    prefix,
    counter(name, help, labelNames = []) {
      const family = define('counter', name, help, labelNames);
      return {
        inc(labels, value = 1) {
          if (!(value >= 0)) throw new ComputeError('INVALID_INPUT', 'Counters only go up');
          const entry = seriesOf(family, labels);
          if (entry) entry.value += value;
        },
      };
    },
    gauge(name, help, labelNames = []) {
      const family = define('gauge', name, help, labelNames);
      return {
        set(labels, value) {
          const entry = seriesOf(family, labels);
          if (entry) entry.value = value;
        },
        inc(labels, value = 1) {
          const entry = seriesOf(family, labels);
          if (entry) entry.value += value;
        },
        dec(labels, value = 1) {
          const entry = seriesOf(family, labels);
          if (entry) entry.value -= value;
        },
      };
    },
    histogram(name, help, labelNames = [], buckets = defaultBuckets) {
      const family = define('histogram', name, help, labelNames, buckets);
      const observe = (labels: Labels | undefined, value: number) => {
        const entry = seriesOf(family, labels);
        if (!entry) return;
        entry.value += 1;
        entry.sum! += value;
        family.buckets!.forEach((bound, i) => {
          if (value <= bound) entry.buckets![i]! += 1;
        });
      };
      return {
        observe,
        startTimer(labels) {
          const started = now();
          return () => {
            const elapsed = now() - started;
            observe(labels, elapsed);
            return elapsed;
          };
        },
      };
    },
    expose() {
      const lines: string[] = [];
      for (const family of families.values()) {
        lines.push(
          `# HELP ${family.name} ${escapeHelp(family.help)}`,
          `# TYPE ${family.name} ${family.kind}`,
        );
        for (const entry of family.series.values()) {
          if (family.kind !== 'histogram') {
            lines.push(`${family.name}${labelText(entry.labels)} ${formatValue(entry.value)}`);
            continue;
          }
          family.buckets!.forEach((bound, i) =>
            lines.push(
              `${family.name}_bucket${labelText(entry.labels, ['le', formatValue(bound)])} ${entry.buckets![i]}`,
            ),
          );
          lines.push(
            `${family.name}_bucket${labelText(entry.labels, ['le', '+Inf'])} ${entry.value}`,
          );
          lines.push(`${family.name}_sum${labelText(entry.labels)} ${formatValue(entry.sum!)}`);
          lines.push(`${family.name}_count${labelText(entry.labels)} ${entry.value}`);
        }
      }
      lines.push(
        `# HELP ${prefix}metrics_collapsed_total Recordings folded into an (other) series because a metric reached maxSeries`,
        `# TYPE ${prefix}metrics_collapsed_total counter`,
        `${prefix}metrics_collapsed_total ${dropped}`,
      );
      return `${lines.join('\n')}\n`;
    },
    stats: () => ({ series, dropped }),
    value(name, labels = {}) {
      const family = families.get(name.startsWith(prefix) ? name : `${prefix}${name}`);
      if (!family) return undefined;
      const key = family.labelNames.map((label) => labelValue(labels[label])).join('\u0000');
      return family.series.get(key)?.value;
    },
    reset() {
      for (const family of families.values()) family.series.clear();
      series = 0;
      dropped = 0;
    },
  };
}

export interface MetricsHandlerOptions {
  registry: MetricsRegistry;
  /** Scrapers present `Authorization: Bearer <token>`. At least 16 characters. */
  bearerToken: string;
  /** A constant-time comparison (`crypto.timingSafeEqual` in Node), injected to keep this module browser-safe. */
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

const sha256 = async (text: string) =>
  new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

/**
 * `GET /metrics` behind a bearer token. Both tokens are hashed first, so the comparison is constant-time
 * whatever their lengths.
 */
export function metricsHandler(
  options: MetricsHandlerOptions,
): (request: Request) => Promise<Response> {
  if (typeof options.bearerToken !== 'string' || options.bearerToken.length < 16)
    throw new ComputeError(
      'INVALID_CONFIG',
      'The metrics bearer token must be at least 16 characters',
    );
  const expected = sha256(options.bearerToken);
  return async (request) => {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '');
    if (!match || !options.timingSafeEqual(await sha256(match[1]!.trim()), await expected))
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer' },
      });
    return new Response(options.registry.expose(), {
      headers: {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  };
}
