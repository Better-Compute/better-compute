import { describe, expect, it } from 'vitest';
import { ComputeError } from '@better-compute/core';
import {
  createMetrics,
  externalMetricsCollector,
  metricCatalog,
  type ExternalMetricSample,
  type ExternalMetricsSource,
} from '@better-compute/observability';

// The externalMetrics source contract (DigitalOcean P9): pull sources of host metrics for machines that run no bcd,
// collected into bounded gauges labelled by source and instance.

const machine = { instance: 'inst_1', machineId: '42' };

function source(id: string, answer: () => Promise<ExternalMetricSample[]>): ExternalMetricsSource {
  return { id, read: () => answer() };
}

describe('externalMetricsCollector', () => {
  it('fills one gauge per metric at scrape time, by source and instance', async () => {
    let now = 1_000_000;
    const registry = createMetrics();
    const collector = externalMetricsCollector(
      registry,
      [
        {
          source: source('digitalocean', async () => [
            { instance: 'inst_1', metric: 'cpu_utilization_ratio', value: 0.25, at: now - 1000 },
            { instance: 'inst_1', metric: 'memory_used_bytes', value: 512, at: now - 1000 },
          ]),
          machines: () => [machine],
        },
      ],
      { now: () => now },
    );
    expect(await collector.pull()).toEqual([{ source: 'digitalocean', samples: 2 }]);
    const text = registry.expose();
    expect(text).toContain(
      'better_compute_external_host_cpu_utilization_ratio{source="digitalocean",instance="inst_1"} 0.25',
    );
    expect(
      registry.value('external_host_memory_used_bytes', {
        source: 'digitalocean',
        instance: 'inst_1',
      }),
    ).toBe(512);
    expect(
      registry.value('external_metrics_last_pull_timestamp_seconds', { source: 'digitalocean' }),
    ).toBe(1000);

    // Past the staleness window the value reads NaN rather than a frozen reading.
    now += 16 * 60_000;
    registry.expose();
    expect(
      registry.value('external_host_cpu_utilization_ratio', {
        source: 'digitalocean',
        instance: 'inst_1',
      }),
    ).toBeNaN();
  });

  it('keeps only the machines asked for, known metrics and finite values', async () => {
    const registry = createMetrics();
    const collector = externalMetricsCollector(registry, [
      {
        source: source('do', async () => [
          { instance: 'inst_other', metric: 'load1', value: 1, at: Date.now() },
          { instance: 'inst_1', metric: 'bogus' as never, value: 1, at: Date.now() },
          { instance: 'inst_1', metric: 'load1', value: Number.POSITIVE_INFINITY, at: Date.now() },
          { instance: 'inst_1', metric: 'load1', value: 0.5, at: Date.now() },
        ]),
        machines: async () => [machine],
      },
    ]);
    await collector.pull();
    registry.expose();
    expect(registry.value('external_host_load1', { source: 'do', instance: 'inst_1' })).toBe(0.5);
    expect(
      registry.value('external_host_load1', { source: 'do', instance: 'inst_other' }),
    ).toBeUndefined();
  });

  it('counts a failing source by error code and never stops another', async () => {
    const registry = createMetrics();
    const collector = externalMetricsCollector(registry, [
      {
        source: source('broken', async () => {
          throw new ComputeError('RATE_LIMITED', 'budget');
        }),
        machines: () => [machine],
      },
      {
        source: source('fine', async () => [
          { instance: 'inst_1', metric: 'load1', value: 2, at: Date.now() },
        ]),
        machines: () => [machine],
      },
    ]);
    expect(await collector.pull()).toEqual([
      { source: 'broken', samples: 0, error: 'RATE_LIMITED' },
      { source: 'fine', samples: 1 },
    ]);
    expect(
      registry.value('external_metrics_pull_failures_total', {
        source: 'broken',
        code: 'RATE_LIMITED',
      }),
    ).toBe(1);
  });

  it('does not ask a source about no machines, and refuses a source id that cannot be a label', async () => {
    let asked = 0;
    const registry = createMetrics();
    const collector = externalMetricsCollector(registry, [
      { source: source('do', async () => (asked++, [])), machines: () => [] },
    ]);
    await collector.pull();
    expect(asked).toBe(0);
    expect(() =>
      externalMetricsCollector(createMetrics(), [
        { source: source('Not A Label', async () => []), machines: () => [] },
      ]),
    ).toThrow(/source id/);
  });

  it('is in the metric catalog', () => {
    const family = metricCatalog().find(
      (f) => f.name === 'better_compute_external_host_cpu_utilization_ratio',
    );
    expect(family).toMatchObject({
      kind: 'gauge',
      labels: ['source', 'instance'],
      source: 'externalMetricsCollector',
    });
  });
});
