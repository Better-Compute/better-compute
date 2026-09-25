// Every metric family this package defines (PLAN.md §14), listed by running each definer against a recording
// registry, so the list (and the generated reference page built from it) cannot drift from the code.

import { createObserver } from './spans.js';
import {
  eventCounter,
  gatewayCollector,
  meteredAttestor,
  meteredGatewayServices,
  meteredProvider,
  placementObserver,
  revocationFeedCollector,
} from './instrument.js';
import {
  defaultBuckets,
  type Counter,
  type Gauge,
  type Histogram,
  type MetricsRegistry,
} from './registry.js';
import { standardMetrics } from './standard.js';

export interface MetricFamily {
  /** The full series name, prefix included (`better_compute_…`). */
  name: string;
  kind: 'counter' | 'gauge' | 'histogram';
  help: string;
  labels: readonly string[];
  /** Histograms only: the bucket upper bounds, in seconds. */
  buckets?: readonly number[];
  /** The function that defines it (`standardMetrics`, `gatewayCollector`, …). */
  source: string;
}

/** A registry that records definitions and discards samples. */
function recordingRegistry(
  prefix: string,
  into: MetricFamily[],
  source: () => string,
): MetricsRegistry {
  const seen = new Set<string>();
  const define = (
    kind: MetricFamily['kind'],
    name: string,
    help: string,
    labels: readonly string[] = [],
    buckets?: readonly number[],
  ) => {
    const full = `${prefix}${name}`;
    if (seen.has(full)) return;
    seen.add(full);
    into.push({
      name: full,
      kind,
      help,
      labels: [...labels],
      ...(kind === 'histogram' ? { buckets: [...(buckets ?? defaultBuckets)] } : {}),
      source: source(),
    });
  };
  const counter: Counter = { inc() {} };
  const gauge: Gauge = { set() {}, inc() {}, dec() {} };
  const histogram: Histogram = { observe() {}, startTimer: () => () => 0 };
  return {
    prefix,
    counter(name, help, labels) {
      define('counter', name, help, labels);
      return counter;
    },
    gauge(name, help, labels) {
      define('gauge', name, help, labels);
      return gauge;
    },
    histogram(name, help, labels, buckets) {
      define('histogram', name, help, labels, buckets);
      return histogram;
    },
    collect() {},
    expose: () => '',
    stats: () => ({ series: 0, dropped: 0 }),
    value: () => undefined,
    reset() {},
  };
}

/**
 * Every metric family the package's definers register, in definition order. `databaseCollector` fills families of
 * `standardMetrics` and defines none of its own.
 */
export function metricCatalog(options: { prefix?: string } = {}): readonly MetricFamily[] {
  const families: MetricFamily[] = [];
  let source = '';
  const registry = recordingRegistry(options.prefix ?? 'better_compute_', families, () => source);
  const as = (name: string, run: () => void) => {
    source = name;
    run();
  };
  let metrics: ReturnType<typeof standardMetrics> | undefined;
  as('standardMetrics', () => {
    metrics = standardMetrics(registry);
  });
  as('createObserver', () => createObserver({ metrics: registry }));
  as('meteredAttestor', () =>
    meteredAttestor(
      { id: 'catalog', version: '0.0.0', roles: [], verify: async () => ({}) } as never,
      registry,
    ),
  );
  as('meteredGatewayServices', () =>
    meteredGatewayServices({ join: undefined, renew: undefined, secret: undefined }, registry),
  );
  as('meteredProvider', () =>
    meteredProvider({ id: 'catalog', create: async () => ({}) } as never, registry),
  );
  as('placementObserver', () => placementObserver(metrics!, registry));
  as('gatewayCollector', () => gatewayCollector(registry, () => []));
  as('revocationFeedCollector', () => revocationFeedCollector(registry, () => ({})));
  as('eventCounter', () => eventCounter(registry));
  return families;
}
