import { timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ComputeError, type IamPort } from '@better-compute/core';
import {
  childTraceparent,
  createMetrics,
  createObserver,
  formatTraceparent,
  labelValue,
  meteredIamPort,
  metricsHandler,
  parseTraceparent,
  standardMetrics,
  type ComputeSpan,
} from '@better-compute/observability';

// §14 observability: bounded registry, spans, metered IamPort, traceparent.

describe('createMetrics', () => {
  it('exposes counters, gauges and histograms in Prometheus text format', () => {
    let t = 0;
    const registry = createMetrics({ now: () => t });
    const counter = registry.counter('placements_total', 'Placements', ['outcome']);
    counter.inc({ outcome: 'placed' });
    counter.inc({ outcome: 'placed' }, 2);
    registry.gauge('work_queue_depth', 'Due rows', ['kind']).set({ kind: 'nodespec' }, 7);
    const histogram = registry.histogram(
      'reconcile_duration_seconds',
      'Runs',
      ['reconciler'],
      [0.1, 1],
    );
    const stop = histogram.startTimer({ reconciler: 'iam.inbox' });
    t = 0.5;
    expect(stop()).toBe(0.5);
    const text = registry.expose();
    expect(text).toContain('# TYPE better_compute_placements_total counter');
    expect(text).toContain('better_compute_placements_total{outcome="placed"} 3');
    expect(text).toContain('better_compute_work_queue_depth{kind="nodespec"} 7');
    expect(text).toContain(
      'better_compute_reconcile_duration_seconds_bucket{reconciler="iam.inbox",le="0.1"} 0',
    );
    expect(text).toContain(
      'better_compute_reconcile_duration_seconds_bucket{reconciler="iam.inbox",le="1"} 1',
    );
    expect(text).toContain(
      'better_compute_reconcile_duration_seconds_bucket{reconciler="iam.inbox",le="+Inf"} 1',
    );
    expect(text).toContain(
      'better_compute_reconcile_duration_seconds_sum{reconciler="iam.inbox"} 0.5',
    );
    expect(text.endsWith('\n')).toBe(true);
    expect(registry.value('placements_total', { outcome: 'placed' })).toBe(3);
    expect(() => counter.inc({ outcome: 'x' }, -1)).toThrow(/only go up/);
  });

  it('collapses past maxSeries into (other), and cleans caller-controlled values', () => {
    const registry = createMetrics({ maxSeries: 3 });
    const counter = registry.counter('http_total', 'Requests', ['path']);
    for (const path of ['/a', '/b', '/c', '/d', '/e']) counter.inc({ path });
    expect(registry.value('http_total', { path: '(other)' })).toBe(2);
    expect(registry.stats()).toEqual({ series: 4, dropped: 2 });
    expect(registry.expose()).toContain('better_compute_metrics_collapsed_total 2');
    expect(labelValue('x'.repeat(300))).toBe('(invalid)');
    expect(labelValue('')).toBe('(unknown)');
    expect(labelValue(42)).toBe('(invalid)');
    const escaped = createMetrics();
    escaped.counter('odd_total', 'x', ['v']).inc({ v: 'a"b\\c\nd' });
    expect(escaped.expose()).toContain('better_compute_odd_total{v="a\\"b\\\\c\\nd"} 1');
  });

  it('refuses tenant labels, bad names, redefinitions and unknown labels', () => {
    const registry = createMetrics();
    for (const label of ['tenant', 'tenant_id', 'tenantId', 'identity'])
      expect(() => registry.counter('x_total', 'x', [label])).toThrow(/tenant or person/);
    expect(() => registry.counter('bad-name', 'x')).toThrow(/Invalid metric name/);
    expect(() => registry.histogram('h', 'x', ['le'])).toThrow(/Invalid label/);
    expect(() => registry.histogram('h2', 'x', [], [1, 0.5])).toThrow(/increase/);
    registry.counter('same_total', 'x', ['a']);
    expect(registry.counter('same_total', 'x', ['a'])).toBeDefined();
    expect(() => registry.gauge('same_total', 'x', ['a'])).toThrow(/differently/);
    expect(() => registry.counter('same_total', 'x', ['a']).inc({ b: '1' })).toThrow(/no label b/);
  });
});

describe('metricsHandler', () => {
  it('serves metrics only to the bearer, in constant time', async () => {
    const registry = createMetrics();
    registry.counter('up_total', 'x').inc();
    const handler = metricsHandler({
      registry,
      bearerToken: 'a-scrape-token-1234',
      timingSafeEqual,
    });
    const get = (auth?: string, method = 'GET') =>
      handler(
        new Request('https://c/metrics', { method, headers: auth ? { authorization: auth } : {} }),
      );
    const ok = await get('Bearer a-scrape-token-1234');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/version=0\.0\.4/);
    expect(await ok.text()).toContain('better_compute_up_total 1');
    expect((await get('Bearer wrong')).status).toBe(401);
    expect((await get()).status).toBe(401);
    expect((await get('Bearer a-scrape-token-1234', 'POST')).status).toBe(405);
    expect(() => metricsHandler({ registry, bearerToken: 'short', timingSafeEqual })).toThrow(
      /16 characters/,
    );
  });
});

describe('createObserver', () => {
  it('times work into spans, classifies outcomes, and never lets hooks or metrics break the work', async () => {
    const seen: ComputeSpan[] = [];
    let t = 0;
    const registry = createMetrics();
    const observer = createObserver({
      metrics: registry,
      now: () => t,
      onSpan: [
        (span) => seen.push(span),
        () => {
          throw new Error('broken hook');
        },
      ],
    });
    const value = await observer.span(
      'operation',
      'reservations.create',
      async () => {
        t += 25;
        return 42;
      },
      { tenantId: 'ten_a', requestId: 'req_1' },
    );
    expect(value).toBe(42);
    await expect(
      observer.span('operation', 'nodes.cordon', async () => {
        throw new ComputeError('ACCESS_DENIED', 'no');
      }),
    ).rejects.toThrow('no');
    await expect(
      observer.span('http', '/api/compute/whatever', async () => {
        throw new ComputeError('NOT_FOUND', 'no such method');
      }),
    ).rejects.toThrow();
    await expect(
      observer.span('command', 'node.reboot', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(seen.map((s) => [s.name, s.outcome, s.code])).toEqual([
      ['reservations.create', 'ok', undefined],
      ['nodes.cordon', 'denied', 'ACCESS_DENIED'],
      ['/api/compute/whatever', 'error', 'NOT_FOUND'],
      ['node.reboot', 'error', undefined],
    ]);
    expect(seen[0]).toMatchObject({ durationMs: 25, tenantId: 'ten_a', requestId: 'req_1' });
    const text = registry.expose();
    // Tenant ids never become labels; caller-named failures collapse to (invalid).
    expect(text).not.toContain('ten_a');
    expect(text).toContain('name="(invalid)",outcome="error",code="NOT_FOUND"');
    expect(text).toContain('better_compute_span_duration_seconds_count{kind="operation"} 2');
  });
});

describe('meteredIamPort', () => {
  it('records iam_calls_total{op,outcome} and latency, and behaves like the inner port', async () => {
    const registry = createMetrics();
    const metrics = standardMetrics(registry);
    const inner = {
      rootTenantId: 'ten_root',
      authenticate: async () => ({
        identityId: 'i',
        identityKind: 'user',
        tenantId: 't',
        sessionId: 's',
        sessionKind: 'user',
        mfa: false,
      }),
      require: async (_c: unknown, d: { action: string }) => {
        if (d.action === 'compute:nodes:ssh-root') throw new ComputeError('ACCESS_DENIED', 'no');
      },
      authorize: async () => true,
      authorizeMany: async () => [true],
      requestConfirmation: async () => 'not-held-back' as const,
      billingCheck: async () => ({ allowed: true, budgets: [] }),
      recordUsage: async () => [],
      featureEnabled: async () => {
        throw new Error('IAM down');
      },
      capabilities: () => ({
        pluginResolver: false,
        eventDetail: false,
        evaluate: false,
        readOnlyDecisions: false,
      }),
    } as unknown as IamPort;
    const port = meteredIamPort(inner, metrics);
    expect(port.rootTenantId).toBe('ten_root');
    await port.authenticate({ token: 't' });
    const decision = (action: string) => ({
      tenantId: 't',
      action,
      resource: { type: 'compute-node', id: 'n' },
    });
    await port.require({ token: 't' }, decision('compute:nodes:read'));
    await expect(
      port.require({ token: 't' }, decision('compute:nodes:ssh-root')),
    ).rejects.toThrow();
    await expect(port.featureEnabled('t', 'k')).rejects.toThrow('IAM down');
    expect(registry.value('iam_calls_total', { op: 'require', outcome: 'ok' })).toBe(1);
    expect(registry.value('iam_calls_total', { op: 'require', outcome: 'denied' })).toBe(1);
    expect(registry.value('iam_calls_total', { op: 'featureEnabled', outcome: 'error' })).toBe(1);
    expect(registry.value('iam_call_duration_seconds', { op: 'require' })).toBe(2);
    expect(Object.keys(metrics)).toEqual(
      expect.arrayContaining([
        'commandLatency',
        'commandsSwept',
        'workQueueDepth',
        'reconcileDuration',
        'generationLag',
        'bookingConflicts',
        'poolGpus',
        'nodeConnectivity',
        'iamCalls',
        'iamCallDuration',
        'resolverLookups',
        'iamInboxSpill',
        'usageDeadLetters',
        'clockOffset',
      ]),
    );
  });
});

describe('traceparent', () => {
  it('parses and formats W3C trace context, refusing invalid values', () => {
    const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    expect(parseTraceparent(header)).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentId: '00f067aa0ba902b7',
      sampled: true,
    });
    expect(formatTraceparent(parseTraceparent(header)!)).toBe(header);
    for (const bad of [
      undefined,
      '',
      'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
      '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01',
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra',
      '00-xyz-00f067aa0ba902b7-01',
    ])
      expect(parseTraceparent(bad), String(bad)).toBeUndefined();
    expect(
      parseTraceparent('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00-future'),
    ).toMatchObject({
      sampled: false,
    });
    const child = childTraceparent(parseTraceparent(header));
    expect(child.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(child.parentId).not.toBe('00f067aa0ba902b7');
    expect(parseTraceparent(formatTraceparent(childTraceparent()))).toBeDefined();
  });
});
