import { describe, expect, it } from 'vitest';
import {
  createUsageView,
  usageCsv,
  usageView,
  type ComputeRequester,
  type UsageWindowInput,
} from '@better-compute/console-kit';

// console-kit usage and estimated spend over usage.list windows.

const hour = 3_600_000;
const day0 = new Date(2026, 8, 20).getTime(); // local midnight
const window = (
  hourOffset: number,
  meter: string,
  quantity: number,
  extra: Partial<UsageWindowInput> = {},
): UsageWindowInput => ({
  idempotencyKey: `cmp:alloc:${hourOffset}:${meter}`,
  allocationId: 'alloc_1',
  identityId: 'usr_a',
  meter,
  quantity,
  windowStart: day0 + hourOffset * hour,
  windowEnd: day0 + (hourOffset + 1) * hour,
  tags: {},
  ...extra,
});

const windows = [
  window(1, 'gpu.h100.hours', 8, { tags: { project: 'prj_ml' } }),
  window(2, 'gpu.h100.hours', 8, { tags: { project: 'prj_ml' } }),
  window(25, 'gpu.h100.hours', 4, { identityId: 'usr_b' }),
  window(26, 'node.metal.hours', 1, { outcome: 'dead-lettered' }),
  window(27, 'gpu.h100.hours', 8, { outcome: 'duplicate' }),
];

describe('usage view', () => {
  it('sums meters, days (empty ones too), projects and identities; skips duplicates', () => {
    const view = usageView(windows, { from: day0, to: day0 + 3 * 24 * hour });
    expect(view.meters).toEqual([
      { meter: 'gpu.h100.hours', quantity: 20 },
      { meter: 'node.metal.hours', quantity: 1 },
    ]);
    expect(view.days.map((day) => [day.byMeter['gpu.h100.hours'] ?? 0])).toEqual([[16], [4], [0]]);
    expect(view.byProject).toEqual([
      { project: 'prj_ml', quantity: 16 },
      { project: '(none)', quantity: 5 },
    ]);
    expect(view.byIdentity.map((entry) => [entry.identityId, entry.quantity])).toEqual([
      ['usr_a', 17],
      ['usr_b', 4],
    ]);
    expect(view).toMatchObject({ deadLettered: 1, windows: 5, truncated: false });
    expect(view).not.toHaveProperty('cost');
  });

  it('estimates spend only where every meter has a price', () => {
    const partial = usageView(windows, {
      from: day0,
      to: day0 + 2 * 24 * hour,
      prices: { 'gpu.h100.hours': 2.5 },
    });
    expect(partial.meters[0]).toEqual({ meter: 'gpu.h100.hours', quantity: 20, cost: 50 });
    expect(partial).not.toHaveProperty('cost');
    expect(partial.byProject[0]).toEqual({ project: 'prj_ml', quantity: 16, cost: 40 });
    expect(partial.byProject[1]).not.toHaveProperty('cost'); // includes unpriced metal hours
    expect(partial.days[0]!.cost).toBe(40);
    expect(partial.days[1]).not.toHaveProperty('cost');

    const full = usageView(windows, {
      from: day0,
      to: day0 + 2 * 24 * hour,
      prices: { 'gpu.h100.hours': 2.5, 'node.metal.hours': 0.1 },
    });
    expect(full.cost).toBe(50.1);
  });
});

describe('usage CSV', () => {
  it('writes one quoted, formula-safe row per window', () => {
    const csv = usageCsv([
      window(0, 'gpu.h100.hours', 1.5, { tags: { project: '=HYPERLINK("x")' } }),
    ]);
    const [header, row] = csv.trimEnd().split('\r\n');
    expect(header).toBe(
      'window_start,window_end,meter,quantity,project,identity_id,allocation_id,outcome,idempotency_key',
    );
    expect(row).toContain(',gpu.h100.hours,1.5,"\'=HYPERLINK(""x"")",usr_a,alloc_1,,');
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});

describe('createUsageView', () => {
  it('pages through usage.list and stops at maxWindows', async () => {
    const calls: Record<string, unknown>[] = [];
    const api: ComputeRequester = {
      async $request<O>(_path: string, input?: unknown): Promise<O> {
        const request = input as Record<string, unknown>;
        calls.push(request);
        const pageIndex = request.cursor ? Number(request.cursor) : 0;
        return {
          items: [window(pageIndex, 'gpu.h100.hours', 1)],
          cursor: String(pageIndex + 1),
        } as O;
      },
    };
    const view = createUsageView(api, {
      tenantId: 'acme',
      from: day0,
      to: day0 + 24 * hour,
      projectId: 'prj_ml',
      maxWindows: 3,
    });
    await view.refresh();
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({
      tenantId: 'acme',
      from: day0,
      to: day0 + 24 * hour,
      limit: 500,
      projectId: 'prj_ml',
    });
    expect(calls[2]).toMatchObject({ cursor: '2' });
    expect(view.get().value).toMatchObject({ truncated: true, windows: 3 });
    expect(view.get().value!.raw).toHaveLength(3);
  });
});
