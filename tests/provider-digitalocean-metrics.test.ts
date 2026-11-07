import { beforeEach, describe, expect, it } from 'vitest';
import { manualClock } from '@better-compute/core';
import { createMetrics, externalMetricsCollector } from '@better-compute/observability';
import {
  doMetricsSource,
  probeAccount,
  type DoConfig,
} from '@better-compute/provider-digitalocean';
import { DoEmulator } from './support/do-emulator/index.js';
import { seedMetric } from './support/do-emulator/monitoring.js';
import {
  doAccount,
  freshBudgets,
  noopLog,
  platformAccount,
  secrets,
} from './support/do-harness.js';

// DigitalOcean P9 monitoring: Droplet metrics from DO Monitoring as an externalMetrics source, for attached
// machines that run no bcd.

beforeEach(freshBudgets);

const now = Date.parse('2026-10-05T12:00:00Z');
const s = now / 1000;
const context = { clock: manualClock(now), secrets, log: noopLog, account: platformAccount };

function world() {
  const emu = new DoEmulator();
  // CPU seconds by mode: over the last minute, 15 s idle of 20 s in all, so a utilisation of 1 - 15/20 = 0.25.
  seedMetric(emu, 42, 'cpu', { mode: 'idle' }, [
    [s - 120, 1000],
    [s - 60, 1100],
    [s - 0, 1115],
  ]);
  seedMetric(emu, 42, 'cpu', { mode: 'user' }, [
    [s - 120, 400],
    [s - 60, 420],
    [s - 0, 424],
  ]);
  seedMetric(emu, 42, 'cpu', { mode: 'system' }, [
    [s - 120, 100],
    [s - 60, 100],
    [s - 0, 101],
  ]);
  seedMetric(emu, 42, 'memory_total', {}, [[s - 30, 2_000_000_000]]);
  seedMetric(emu, 42, 'memory_available', {}, [[s - 30, 500_000_000]]);
  seedMetric(emu, 42, 'load_1', {}, [
    [s - 90, 0.1],
    [s - 30, 0.75],
  ]);
  seedMetric(emu, 42, 'filesystem_size', { device: '/dev/vda1', mountpoint: '/' }, [
    [s - 30, 1000],
  ]);
  seedMetric(emu, 42, 'filesystem_free', { device: '/dev/vda1', mountpoint: '/' }, [[s - 30, 400]]);
  seedMetric(emu, 42, 'filesystem_size', { device: '/dev/vdb', mountpoint: '/mnt/x' }, [
    [s - 30, 9],
  ]);
  seedMetric(emu, 42, 'bandwidth', { interface: 'public', direction: 'inbound' }, [[s - 30, 8]]);
  seedMetric(emu, 42, 'bandwidth', { interface: 'public', direction: 'outbound' }, [[s - 30, 2]]);
  return emu;
}

const byMetric = (samples: { metric: string; value: number }[]) =>
  Object.fromEntries(samples.map((sample) => [sample.metric, sample.value]));

describe('doMetricsSource', () => {
  it('reads CPU, memory and load by default, in base units', async () => {
    const emu = world();
    const source = doMetricsSource(doAccount as DoConfig, context, { fetch: emu.fetch });
    expect(source.id).toBe('digitalocean');
    const samples = await source.read([{ instance: 'inst_1', machineId: '42' }], {
      signal: new AbortController().signal,
    });
    expect(byMetric(samples)).toEqual({
      cpu_utilization_ratio: 0.25,
      memory_total_bytes: 2_000_000_000,
      memory_used_bytes: 1_500_000_000,
      load1: 0.75,
    });
    expect(samples.every((sample) => sample.instance === 'inst_1')).toBe(true);
    expect(samples.find((x) => x.metric === 'load1')!.at).toBe(now - 30_000);
    // Every request is a read of this Droplet over a bounded window, on the monitoring API.
    for (const request of emu.requests) {
      expect(request.method).toBe('GET');
      expect(request.url.pathname).toMatch(/^\/v2\/monitoring\/metrics\/droplet\//);
      expect(request.url.searchParams.get('host_id')).toBe('42');
      expect(
        Number(request.url.searchParams.get('end')) - Number(request.url.searchParams.get('start')),
      ).toBe(600);
    }
  });

  it('reads the root filesystem and public bandwidth when asked', async () => {
    const emu = world();
    const source = doMetricsSource(doAccount as DoConfig, context, {
      fetch: emu.fetch,
      metrics: ['filesystem', 'bandwidth'],
    });
    const samples = await source.read([{ instance: 'inst_1', machineId: '42' }], {
      signal: new AbortController().signal,
    });
    expect(byMetric(samples)).toEqual({
      filesystem_size_bytes: 1000,
      filesystem_used_bytes: 600,
      // Megabits per second as bytes per second.
      network_receive_bytes_per_second: 1_000_000,
      network_transmit_bytes_per_second: 250_000,
    });
  });

  it('skips a machine id that is not a Droplet id, and one DO has no data for', async () => {
    const emu = world();
    const source = doMetricsSource(doAccount as DoConfig, context, { fetch: emu.fetch });
    const samples = await source.read(
      [
        { instance: 'inst_x', machineId: 'not-a-droplet' },
        { instance: 'inst_2', machineId: '43' },
      ],
      { signal: new AbortController().signal },
    );
    expect(samples).toEqual([]);
    expect(emu.requests.every((r) => r.url.searchParams.get('host_id') === '43')).toBe(true);
  });

  it('answers what it read when the sweep budget runs out, and fails on a missing scope', async () => {
    const emu = world();
    const source = doMetricsSource(doAccount as DoConfig, context, {
      fetch: emu.fetch,
      budget: { perMinute: 20, perHour: 5000 },
      concurrency: 1,
    });
    const machines = Array.from({ length: 5 }, (_, i) => ({
      instance: `inst_${i}`,
      machineId: '42',
    }));
    const samples = await source.read(machines, { signal: new AbortController().signal });
    // A 20-per-minute budget leaves the sweep class 4 requests: one machine's four reads.
    expect(new Set(samples.map((sample) => sample.instance))).toEqual(new Set(['inst_0']));

    freshBudgets();
    const denied = world();
    denied.failNext({ path: /^\/monitoring\// }, 403, denied.error('forbidden').body);
    const refusing = doMetricsSource(doAccount as DoConfig, context, { fetch: denied.fetch });
    await expect(
      refusing.read([{ instance: 'inst_1', machineId: '42' }], {
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it('answers what it read when the deadline passes, and the next pull reads the rest', async () => {
    const emu = world();
    // Every request takes 20 ms and honours the caller's signal, like a slow DigitalOcean.
    const slow: typeof fetch = (input, init) =>
      new Promise((resolve, reject) => {
        const signal = init?.signal;
        const timer = setTimeout(() => resolve(emu.fetch(input, init)), 20);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      });
    const source = doMetricsSource(doAccount as DoConfig, context, {
      fetch: slow,
      concurrency: 2,
    });
    const machines = Array.from({ length: 12 }, (_, i) => ({
      instance: `inst_${i}`,
      machineId: '42',
    }));
    // Four sequential requests per Droplet at 20 ms or more: two to three pairs of Droplets fit in 300 ms, not six.
    const first = await source.read(machines, { signal: AbortSignal.timeout(300) });
    const firstRead = new Set(first.map((sample) => sample.instance));
    expect(firstRead.size).toBeGreaterThan(0);
    expect(firstRead.size).toBeLessThan(12);
    const full = (instance: string) => first.filter((x) => x.instance === instance).length === 4;
    expect([...firstRead].some(full)).toBe(true);
    // The next pull starts where this one stopped, so the Droplets left out are read now.
    const second = await source.read(machines, { signal: new AbortController().signal });
    const secondRead = new Set(second.map((sample) => sample.instance));
    for (const instance of machines.map((m) => m.instance))
      expect(firstRead.has(instance) || secondRead.has(instance)).toBe(true);
    expect(secondRead.has([...firstRead][0]!)).toBe(true);
  });

  it('reads several Droplets at a time, and gets round them all under a small budget', async () => {
    const emu = world();
    let open = 0;
    let peak = 0;
    const counting: typeof fetch = async (input, init) => {
      open++;
      peak = Math.max(peak, open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await emu.fetch(input, init);
      } finally {
        open--;
      }
    };
    const machines = Array.from({ length: 6 }, (_, i) => ({
      instance: `inst_${i}`,
      machineId: '42',
    }));
    const source = doMetricsSource(doAccount as DoConfig, context, { fetch: counting });
    expect(
      new Set(
        (await source.read(machines, { signal: new AbortController().signal })).map(
          (x) => x.instance,
        ),
      ).size,
    ).toBe(6);
    expect(peak).toBe(4);

    // A budget of 4 sweep requests per pull, 4 Droplets at a time: each pull reads part of 4 Droplets, and the next
    // starts after them, so no Droplet is starved.
    freshBudgets();
    const clock = manualClock(now);
    const tight = doMetricsSource(
      doAccount as DoConfig,
      { ...context, clock },
      {
        fetch: emu.fetch,
        budget: { perMinute: 20, perHour: 5000 },
      },
    );
    const seen = new Set<string>();
    for (let pass = 0; pass < 2; pass++) {
      // A minute later the budget's window has room again.
      if (pass) clock.advance(61_000);
      for (const sample of await tight.read(machines, { signal: new AbortController().signal }))
        seen.add(sample.instance);
    }
    expect(seen.size).toBe(6);
  });

  it('plugs into the externalMetrics collector', async () => {
    const emu = world();
    const registry = createMetrics();
    const collector = externalMetricsCollector(
      registry,
      [
        {
          source: doMetricsSource(doAccount as DoConfig, context, { fetch: emu.fetch }),
          machines: () => [{ instance: 'inst_1', machineId: '42' }],
        },
      ],
      { now: () => now },
    );
    expect(await collector.pull()).toEqual([{ source: 'digitalocean', samples: 4 }]);
    registry.expose();
    expect(
      registry.value('external_host_cpu_utilization_ratio', {
        source: 'digitalocean',
        instance: 'inst_1',
      }),
    ).toBe(0.25);
  });

  it('adds monitoring:read to the operations probe', async () => {
    const emu = world();
    const report = await probeAccount(
      doAccount as DoConfig,
      context,
      { fetch: emu.fetch },
      { operations: true },
    );
    expect(report.operations).toMatchObject({ monitoring: 'ok' });
  });
});
