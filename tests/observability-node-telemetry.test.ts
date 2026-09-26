import { describe, expect, it } from 'vitest';
import type { ModuleContext, NodeRecord, SqlExecutor } from '@better-compute/core';
import {
  nodeTelemetryFindings,
  nodeTelemetryModule,
  telemetryProblem,
} from '@better-compute/observability';

// nodeTelemetryModule: NodeSpec.telemetry per node (PLAN.md P8), the pool's policy.telemetry over the
// platform default field by field; a bad pool policy is skipped and reported, never sent.

function sqlWith(pools: Record<string, unknown>): SqlExecutor {
  return {
    query: async (text: string, params?: unknown[]) => {
      if (text.includes('to_regclass')) return { rows: [{ ok: true }] };
      if (text.includes('WHERE id = $1')) {
        const id = params![0] as string;
        return { rows: id in pools ? [{ telemetry: pools[id] ?? null }] : [] };
      }
      return {
        rows: Object.entries(pools)
          .filter(([, telemetry]) => telemetry !== undefined)
          .map(([id, telemetry]) => ({ id, telemetry })),
      };
    },
  } as unknown as SqlExecutor;
}

const node = (poolId: string | undefined, role: NodeRecord['role'] = 'dedicated') =>
  ({ id: 'n1', poolId, role }) as NodeRecord;

describe('nodeTelemetryModule', () => {
  it('sends the default collector, with a pool policy winning field by field', async () => {
    const module = nodeTelemetryModule({
      otlpEndpoint: 'https://otel.example.com:4318',
      intervalSeconds: 30,
      resourceAttributes: { 'deployment.environment': 'prod', region: 'eu' },
    });
    const context = {
      sql: sqlWith({
        pool_a: { headersRef: 'secret://t/otel', resourceAttributes: { region: 'fsn1' } },
        pool_b: null,
        pool_bad: { otlpEndpoint: 'http://collector.internal' },
      }),
    } as unknown as ModuleContext;
    expect(await module.nodeSpec!(context, node('pool_a'))).toEqual({
      telemetry: {
        otlpEndpoint: 'https://otel.example.com:4318',
        intervalSeconds: 30,
        headersRef: 'secret://t/otel',
        resourceAttributes: { 'deployment.environment': 'prod', region: 'fsn1' },
      },
    });
    expect(await module.nodeSpec!(context, node('pool_b'))).toEqual({
      telemetry: {
        otlpEndpoint: 'https://otel.example.com:4318',
        intervalSeconds: 30,
        resourceAttributes: { 'deployment.environment': 'prod', region: 'eu' },
      },
    });
    // An invalid pool policy is skipped: its nodes keep the default.
    expect((await module.nodeSpec!(context, node('pool_bad'))).telemetry?.otlpEndpoint).toBe(
      'https://otel.example.com:4318',
    );
    // Site agents export too; `roles` narrows it.
    expect(await module.nodeSpec!(context, node(undefined, 'site'))).toHaveProperty('telemetry');
    const hostsOnly = nodeTelemetryModule({
      otlpEndpoint: 'https://otel.example.com',
      roles: ['host'],
    });
    expect(await hostsOnly.nodeSpec!(context, node(undefined, 'site'))).toEqual({});
    expect(await hostsOnly.nodeSpec!(context, node(undefined, 'host'))).toHaveProperty('telemetry');
  });

  it('sends nothing without an endpoint, unless the pool names one', async () => {
    const module = nodeTelemetryModule();
    const context = {
      sql: sqlWith({ pool_a: { otlpEndpoint: 'https://otel.pool-a.example' }, pool_b: null }),
    } as unknown as ModuleContext;
    expect(await module.nodeSpec!(context, node('pool_b'))).toEqual({});
    expect(await module.nodeSpec!(context, node('pool_a'))).toEqual({
      telemetry: { otlpEndpoint: 'https://otel.pool-a.example' },
    });
  });

  it('validates its options and reports bad pool policies', async () => {
    expect(() => nodeTelemetryModule({ otlpEndpoint: 'http://otel.example.com' })).toThrow(/https/);
    expect(() =>
      nodeTelemetryModule({ otlpEndpoint: 'https://x', headersRef: 'Bearer abc' }),
    ).toThrow(/headersRef/);
    expect(() => nodeTelemetryModule({ otlpEndpoint: 'https://x', intervalSeconds: 1 })).toThrow(
      /intervalSeconds/,
    );
    expect(() =>
      nodeTelemetryModule({
        otlpEndpoint: 'https://x',
        resourceAttributes: { 'bcd.node.id': 'spoof' },
      }),
    ).toThrow(/bcd\.\*/);
    expect(nodeTelemetryModule({ otlpEndpoint: 'http://localhost:4318' }).name).toBe(
      'node-telemetry',
    );
    expect(telemetryProblem({ otlpEndpoint: 'https://x', extra: 1 })).toMatch(
      /extra is not a setting/,
    );
    expect(telemetryProblem({ resourceAttributes: { a: 'x\ny' } })).toMatch(/single-line/);

    expect(
      await nodeTelemetryFindings(sqlWith({ ok: { otlpEndpoint: 'https://x' }, none: undefined })),
    ).toEqual([]);
    const findings = await nodeTelemetryFindings(
      sqlWith({ bad: { otlpEndpoint: 'ftp://x' }, worse: 'nope' }),
    );
    expect(findings).toEqual([
      expect.objectContaining({ check: 'pool-telemetry-invalid', severity: 'warning', count: 2 }),
    ]);
    expect(findings[0]!.message).toContain('bad: otlpEndpoint must be an https:// URL');
  });
});
