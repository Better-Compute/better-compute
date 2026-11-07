import { describe, expect, it } from 'vitest';
import { ComputeError, manualClock } from '@better-compute/core';
import { createMetrics } from '@better-compute/observability';
import { emfMetricsExporter, parsePrometheusText, rdsAuthToken, rdsAuthTokenProvider } from '@better-compute/aws';
import { AwsEmulator } from './support/aws-platform-emulator/index.js';

function rdsOptions(emu: AwsEmulator) {
  return {
    region: 'eu-west-1',
    credentials: emu.credentials,
    clock: emu.clock,
    hostname: 'bc-db.cluster-abc.eu-west-1.rds.amazonaws.com',
    username: 'better_compute',
  };
}

describe('RDS IAM auth', () => {
  it('token is a presigned connect URL for rds-db without a scheme', async () => {
    const emu = new AwsEmulator();
    const token = await rdsAuthToken(rdsOptions(emu));
    expect(token.startsWith('https://')).toBe(false);
    expect(token.startsWith('bc-db.cluster-abc.eu-west-1.rds.amazonaws.com:5432/?')).toBe(true);
    const url = new URL(`https://${token}`);
    expect(url.searchParams.get('Action')).toBe('connect');
    expect(url.searchParams.get('DBUser')).toBe('better_compute');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/\/eu-west-1\/rds-db\/aws4_request$/);
    // The signature verifies (the emulator checks presigned URLs as RDS would).
    expect(emu.authenticate('GET', url, {}, new Uint8Array())).toMatchObject({ service: 'rds-db', presigned: true });
    emu.clock.advance(901_000);
    expect(emu.authenticate('GET', url, {}, new Uint8Array())).toHaveProperty('error');
    await expect(rdsAuthToken({ ...rdsOptions(emu), hostname: 'evil.com/x' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('provider caches and refreshes before expiry', async () => {
    const emu = new AwsEmulator();
    let resolved = 0;
    const provider = rdsAuthTokenProvider({
      ...rdsOptions(emu),
      credentials: { kind: 'counting', credentials: async (context) => (resolved++, emu.credentials.credentials(context)) },
    });
    const [a, b] = await Promise.all([provider(), provider()]);
    expect(a).toBe(b);
    expect(resolved).toBe(1);
    emu.clock.advance(11 * 60_000);
    expect(await provider()).toBe(a);
    emu.clock.advance(60_001);
    const fresh = await provider();
    expect(fresh).not.toBe(a);
    expect(resolved).toBe(2);
  });

  it('provider refreshes before temporary credentials expire (review)', async () => {
    const emu = new AwsEmulator();
    let resolved = 0;
    const provider = rdsAuthTokenProvider({
      ...rdsOptions(emu),
      credentials: {
        kind: 'expiring',
        credentials: async () => {
          resolved++;
          return { accessKeyId: 'ASIATESTKEY000000001', secretAccessKey: 'x', sessionToken: 'tok', expiresAt: emu.clock.now() + 5 * 60_000 };
        },
      },
    });
    const first = await provider();
    expect(resolved).toBe(1);
    // Within the credentials' life less three minutes: cached.
    emu.clock.advance(60_000);
    expect(await provider()).toBe(first);
    // Two minutes before the credentials expire (the token itself would have 13 left): re-minted.
    emu.clock.advance(2 * 60_000);
    const fresh = await provider();
    expect(fresh).not.toBe(first);
    expect(resolved).toBe(2);
  });

  it('token never appears in logs', async () => {
    // The token path has no logger at all; the provider holds it only in memory.
    const emu = new AwsEmulator();
    const entries: unknown[] = [];
    const log = { debug: (...a: unknown[]) => entries.push(a), info: (...a: unknown[]) => entries.push(a), warn: (...a: unknown[]) => entries.push(a), error: (...a: unknown[]) => entries.push(a) };
    const token = await rdsAuthTokenProvider({ ...rdsOptions(emu), log })();
    expect(JSON.stringify(entries)).not.toContain(new URL(`https://${token}`).searchParams.get('X-Amz-Signature'));
  });
});

describe('CloudWatch EMF', () => {
  function world() {
    const registry = createMetrics();
    const lines: string[] = [];
    const clock = manualClock(Date.UTC(2026, 9, 1));
    const exporter = emfMetricsExporter({ registry, out: (line) => lines.push(line), clock });
    const docs = () => lines.map((line) => JSON.parse(line) as Record<string, any>);
    return { registry, lines, exporter, docs, clock };
  }

  it('parses counters, gauges and histograms', () => {
    const registry = createMetrics();
    registry.counter('requests_total', 'r', ['module', 'code']).inc({ module: 'vps', code: 'OK' }, 3);
    registry.gauge('pool_free', 'f', ['pool']).set({ pool: 'p "1"' }, 7);
    registry.histogram('latency_seconds', 'l', ['method'], [0.1, 1]).observe({ method: 'get' }, 0.5);
    const samples = parsePrometheusText(registry.expose());
    expect(samples).toContainEqual({ name: 'better_compute_requests_total', labels: { module: 'vps', code: 'OK' }, value: 3, type: 'counter' });
    expect(samples).toContainEqual({ name: 'better_compute_pool_free', labels: { pool: 'p "1"' }, value: 7, type: 'gauge' });
    expect(samples).toContainEqual({ name: 'better_compute_latency_seconds_sum', labels: { method: 'get' }, value: 0.5, type: 'histogram' });
    expect(samples).toContainEqual({ name: 'better_compute_latency_seconds_bucket', labels: { method: 'get', le: '1' }, value: 1, type: 'histogram' });
  });

  it('first flush is a baseline, then deltas', () => {
    const { registry, exporter, docs } = world();
    const counter = registry.counter('requests_total', 'r', ['module']);
    const gauge = registry.gauge('queue_depth', 'q', ['module']);
    const histogram = registry.histogram('latency_seconds', 'l', ['module'], [1]);
    counter.inc({ module: 'vps' }, 5);
    gauge.set({ module: 'vps' }, 2);
    histogram.observe({ module: 'vps' }, 0.25);
    exporter.flush();
    expect(docs()).toHaveLength(1);
    expect(docs()[0]).not.toHaveProperty('requests_total');
    expect(docs()[0]).toMatchObject({ module: 'vps', queue_depth: 2 });
    counter.inc({ module: 'vps' }, 4);
    histogram.observe({ module: 'vps' }, 0.5);
    exporter.flush();
    expect(docs()[1]).toMatchObject({ module: 'vps', requests_total: 4, queue_depth: 2, latency_seconds_sum: 0.5, latency_seconds_count: 1 });
    expect(Object.keys(docs()[1]!).some((key) => key.includes('bucket'))).toBe(false);
  });

  it('drops non-dimension labels', () => {
    const { registry, exporter, docs } = world();
    const gauge = registry.gauge('nodes', 'n', ['pool', 'node']);
    gauge.set({ pool: 'p1', node: 'a' }, 1);
    gauge.set({ pool: 'p1', node: 'b' }, 2);
    exporter.flush();
    expect(docs()).toEqual([
      {
        _aws: { Timestamp: Date.UTC(2026, 9, 1), CloudWatchMetrics: [{ Namespace: 'BetterCompute', Dimensions: [['pool']], Metrics: [{ Name: 'nodes' }] }] },
        pool: 'p1',
        nodes: 3,
      },
    ]);
  });

  it('splits documents at 100 metrics', () => {
    const { registry, exporter, docs } = world();
    for (let i = 0; i < 150; i++) registry.gauge(`g${i}`, 'g').set(undefined, i);
    exporter.flush();
    expect(docs()).toHaveLength(2);
    expect(docs()[0]!._aws.CloudWatchMetrics[0].Metrics).toHaveLength(100);
    expect(docs()[1]!._aws.CloudWatchMetrics[0].Metrics).toHaveLength(50);
  });

  it('EMF shape has _aws.CloudWatchMetrics with namespace and dimensions', () => {
    const registry = createMetrics();
    registry.gauge('up', 'u', ['module', 'kind']).set({ module: 'vps', kind: 'x' }, 1);
    const lines: string[] = [];
    emfMetricsExporter({ registry, namespace: 'Acme/BC', out: (line) => lines.push(line), clock: manualClock(5) }).flush();
    const doc = JSON.parse(lines[0]!);
    expect(doc._aws).toEqual({ Timestamp: 5, CloudWatchMetrics: [{ Namespace: 'Acme/BC', Dimensions: [['kind', 'module']], Metrics: [{ Name: 'up' }] }] });
    expect(doc).toMatchObject({ module: 'vps', kind: 'x', up: 1 });
    expect(() => emfMetricsExporter({ registry, dimensions: Array.from({ length: 31 }, (_, i) => `d${i}`) })).toThrow(ComputeError);
  });
});
