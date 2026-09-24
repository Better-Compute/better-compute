import { describe, expect, it } from 'vitest';
import {
  createQuotaView,
  quotaHint,
  quotaView,
  type ComputeRequester,
} from '@better-compute/console-kit';

// console-kit quota meters and the reservation pre-check.

const rows = [
  { poolId: 'pool_b', resource: 'gpu', max: 8, used: 8 },
  { poolId: 'pool_a', resource: 'vcpu', max: 100, used: 10 },
  { poolId: 'pool_a', resource: 'gpu', max: 10, used: 9 },
  { poolId: 'pool_c', resource: 'gpu', max: 0, used: 0 },
];

describe('quota view', () => {
  it('meters each pool’s resources and lists alerts, fullest first', () => {
    const view = quotaView(rows);
    expect(view.pools.map((pool) => pool.poolId)).toEqual(['pool_a', 'pool_b', 'pool_c']);
    expect(view.pools[0]!.meters).toEqual([
      { resource: 'gpu', max: 10, used: 9, available: 1, ratio: 0.9, level: 'warning' },
      { resource: 'vcpu', max: 100, used: 10, available: 90, ratio: 0.1, level: 'ok' },
    ]);
    expect(view.alerts.map((alert) => `${alert.poolId}/${alert.resource}:${alert.level}`)).toEqual([
      'pool_b/gpu:full',
      'pool_c/gpu:full',
      'pool_a/gpu:warning',
    ]);
  });

  it('pre-checks a request against the quota left', () => {
    expect(quotaHint(rows, 'pool_a', { gpu: 1, vcpu: 8 })).toEqual({ fits: true, short: [] });
    expect(quotaHint(rows, 'pool_a', { gpu: 2 })).toEqual({
      fits: false,
      short: [{ resource: 'gpu', requested: 2, available: 1 }],
    });
    expect(quotaHint(rows, 'pool_z', { gpu: 100 })).toEqual({ fits: true, short: [] });
  });

  it('loads through quotas.get', async () => {
    const calls: unknown[] = [];
    const api: ComputeRequester = {
      async $request<O>(path: string, input?: unknown) {
        calls.push({ path, input });
        return { items: rows } as O;
      },
    };
    const view = createQuotaView(api, { tenantId: 'acme', poolId: 'pool_a' });
    await view.refresh();
    expect(calls).toEqual([{ path: 'quotas/get', input: { tenantId: 'acme', poolId: 'pool_a' } }]);
    expect(view.get().value?.alerts).toHaveLength(3);
  });
});
