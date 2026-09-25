import { describe, expect, it } from 'vitest';
import {
  ComputeError,
  defineSchedulerPlugin,
  type Atom,
  type Device,
  type GpuLink,
  type NodeView,
  type PlacementRequest,
} from '@better-compute/core';
import {
  assertSelector,
  choosePlan,
  defaultAtomPick,
  formatSelector,
  ineligibility,
  isSchedulable,
  matchesSelector,
  nodeBucket,
  parseSelector,
  planPlacement,
  quotaDemand,
  scalarCapacity,
  summarizeRejections,
} from '@better-compute/capacity';

// The pure half of capacity: selectors, schedulability, and the placement pipeline (PLAN.md §10.2,
// §10.3). No database; NodeViews are built by hand.

const pool = { ownerTenantId: 'acme' };

function gpu(nodeId: string, index: number, extra: Partial<Device> = {}): Atom {
  return {
    id: `${nodeId}-gpu${index}`,
    nodeId,
    class: 'gpu',
    bookable: true,
    healthy: true,
    attributes: {
      gpuProduct: 'H100-SXM5-80GB',
      gpuModel: 'H100',
      vramGiB: 80,
      numaNode: index < 4 ? 0 : 1,
    },
    ...extra,
  } as Atom;
}

/** A node with `count` GPUs, of which `busy` (by index) are booked. */
function node(
  id: string,
  count = 8,
  options: Partial<NodeView> & { busy?: number[] } = {},
): NodeView {
  const { busy = [], ...rest } = options;
  const devices = Array.from({ length: count }, (_, index) => gpu(id, index));
  return {
    id,
    siteId: 'site_1',
    poolId: 'pool_1',
    ownerTenantId: 'platform',
    role: 'host',
    provisionState: 'adopted',
    maintenance: false,
    cordoned: false,
    connectivity: 'connected',
    trust: 'platform',
    labels: {},
    noScheduleReasons: [],
    devices,
    free: devices.filter((_, index) => !busy.includes(index)),
    resources: {},
    ...rest,
  };
}

/** An all-to-all topology: `NV` within each group of GPU indexes, `SYS` across. */
function links(
  id: string,
  count: number,
  groups: number[][],
): Record<string, Record<string, GpuLink>> {
  const result: Record<string, Record<string, GpuLink>> = {};
  const groupOf = (index: number) => groups.findIndex((group) => group.includes(index));
  for (let a = 0; a < count; a++)
    for (let b = 0; b < count; b++)
      if (a !== b)
        (result[`${id}-gpu${a}`] ??= {})[`${id}-gpu${b}`] =
          groupOf(a) === groupOf(b) ? 'NV' : 'SYS';
  return result;
}

function request(count: number, extra: Partial<PlacementRequest> = {}): PlacementRequest {
  return {
    tenantId: 'acme',
    poolId: 'pool_1',
    reservationId: 'rsv_1',
    devices: [{ class: 'gpu', count }],
    during: { start: 0, end: 3_600_000 },
    ...extra,
  };
}

describe('selectors', () => {
  it('parses the CLI shorthand and formats it back', () => {
    const selector = parseSelector(
      'gpuProduct in (H100-SXM5-80GB, H200-SXM5-141GB), vramGiB >= 80, mig.capable, !fabric.domain, zone != b',
    );
    expect(selector.matchExpressions).toEqual([
      { key: 'gpuProduct', op: 'In', values: ['H100-SXM5-80GB', 'H200-SXM5-141GB'] },
      { key: 'vramGiB', op: 'Gte', values: [80] },
      { key: 'mig.capable', op: 'Exists' },
      { key: 'fabric.domain', op: 'DoesNotExist' },
      { key: 'zone', op: 'NotIn', values: ['b'] },
    ]);
    expect(formatSelector(selector)).toBe(
      'gpuProduct in (H100-SXM5-80GB, H200-SXM5-141GB), vramGiB >= 80, mig.capable, !fabric.domain, zone notin (b)',
    );
    expect(parseSelector(formatSelector(selector))).toEqual(selector);
  });

  it('rejects malformed shorthand and selectors with INVALID_INPUT', () => {
    for (const bad of ['gpuProduct in (a', 'vramGiB >', '9lives', 'a notin ()'])
      expect(() => parseSelector(bad), bad).toThrow(ComputeError);
    expect(() =>
      assertSelector({ matchExpressions: [{ key: 'x', op: 'Gt', values: ['big'] }] }),
    ).toThrow(/numeric/);
    expect(() =>
      assertSelector({ matchExpressions: [{ key: 'x', op: 'Exists', values: ['a'] }] }),
    ).toThrow(/takes no values/);
    expect(() =>
      assertSelector({ matchExpressions: [{ key: 'x', op: 'Like', values: ['a'] }] }),
    ).toThrow(/bad op/);
    expect(() => assertSelector({ matchExpressions: [] })).not.toThrow();
  });

  it('reads device attributes before node labels, and compares numerically', () => {
    const subject = {
      attributes: { vramGiB: 80, gpuProduct: 'H100-SXM5-80GB' },
      labels: { vramGiB: '10', zone: 'a', 'cuda.driver.major': '550' },
    };
    const holds = (text: string) => matchesSelector(parseSelector(text), subject);
    expect(holds('vramGiB >= 80')).toBe(true);
    expect(holds('vramGiB < 80')).toBe(false);
    expect(holds('cuda.driver.major > 535')).toBe(true);
    expect(holds('zone = a')).toBe(true);
    expect(holds('zone notin (a)')).toBe(false);
    expect(holds('missing notin (a)')).toBe(true);
    expect(holds('gpuProduct > 3')).toBe(false);
    expect(matchesSelector(undefined, subject)).toBe(true);
  });
});

describe('schedulability (§10.2)', () => {
  it('puts each unschedulable node in its bucket, in a fixed order', () => {
    const base = node('n');
    expect(isSchedulable(base, pool)).toBe(true);
    expect(nodeBucket({ ...base, role: 'dedicated' }, pool)).toBe('excluded');
    expect(nodeBucket({ ...base, trust: 'tenant-controlled' }, pool)).toBe('excluded');
    expect(nodeBucket({ ...base, trust: 'tenant-owned', ownerTenantId: 'other' }, pool)).toBe(
      'excluded',
    );
    expect(nodeBucket({ ...base, trust: 'tenant-owned', ownerTenantId: 'acme' }, pool)).toBe(
      'schedulable',
    );
    expect(nodeBucket({ ...base, maintenance: true, connectivity: 'lost' }, pool)).toBe(
      'maintenance',
    );
    expect(nodeBucket({ ...base, cordoned: true }, pool)).toBe('maintenance');
    expect(nodeBucket({ ...base, provisionState: 'deploying' }, pool)).toBe('provisioning');
    expect(nodeBucket({ ...base, provisionState: 'deployed' }, pool)).toBe('schedulable');
    expect(nodeBucket({ ...base, connectivity: 'unreachable' }, pool)).toBe('unreachable');
    expect(nodeBucket({ ...base, noScheduleReasons: ['GpuCountMismatch'] }, pool)).toBe(
      'unhealthy',
    );
    expect(ineligibility({ ...base, noScheduleReasons: ['a', 'b'] }, pool)?.reason).toBe(
      'NoSchedule: a, b',
    );
  });
});

describe('planPlacement (§10.3)', () => {
  it('prefers the fullest node that still fits (binpack keeps 8-GPU boards whole)', () => {
    const nodes = [
      node('empty'),
      node('half', 8, { busy: [0, 1, 2, 3] }),
      node('full', 8, { busy: [0, 1, 2, 3, 4, 5, 6] }),
    ];
    const plan = planPlacement(request(2), nodes, pool);
    expect(plan.ranked.map((entry) => entry.nodeId)).toEqual(['half', 'empty']);
    expect(plan.rejected).toEqual([{ nodeId: 'full', filter: 'fits', reason: '1 of 2 gpu free' }]);
    expect(plan.ranked[0]!.atoms).toEqual(['half-gpu4', 'half-gpu5']);
    expect(plan.ranked[0]!.scores.binpack).toBeGreaterThan(plan.ranked[1]!.scores.binpack!);
  });

  it('takes a whole 8-GPU board for an 8-GPU request', () => {
    const plan = planPlacement(request(8), [node('a'), node('b', 8, { busy: [7] })], pool);
    expect(plan.ranked.map((entry) => entry.nodeId)).toEqual(['a']);
    expect(plan.ranked[0]!.atoms).toHaveLength(8);
  });

  it('turns down ineligible, excluded and other-pool nodes with reasons', () => {
    const plan = planPlacement(
      request(1, { excludeNodes: ['x'] }),
      [node('x'), node('c', 8, { cordoned: true }), node('o', 8, { poolId: 'pool_2' }), node('ok')],
      pool,
    );
    expect(plan.ranked.map((entry) => entry.nodeId)).toEqual(['ok']);
    expect(plan.rejected).toEqual([
      { nodeId: 'x', filter: 'excluded', reason: 'excluded by the request' },
      { nodeId: 'c', filter: 'eligible', reason: 'cordoned' },
      { nodeId: 'o', filter: 'eligible', reason: 'in another pool' },
    ]);
    expect(summarizeRejections(plan.rejected)).toBe(
      'no node fits (3 nodes): 1 × cordoned; 1 × excluded: excluded by the request; 1 × in another pool',
    );
    expect(summarizeRejections([])).toBe('the pool has no nodes');
  });

  it('applies device selectors over attributes and node labels', () => {
    const l40 = node('l40', 4);
    const devices = l40.devices.map((device) => ({
      ...device,
      attributes: {
        ...device.attributes,
        gpuProduct: 'L40S-PCIE-48GB',
        gpuModel: 'L40S',
        vramGiB: 48,
      },
    })) as Atom[];
    const nodes = [{ ...l40, devices, free: devices }, node('h100', 8, { labels: { zone: 'b' } })];
    const wants = (text: string) =>
      planPlacement(
        request(2, { devices: [{ class: 'gpu', count: 2, selector: parseSelector(text) }] }),
        nodes,
        pool,
      ).ranked.map((entry) => entry.nodeId);
    expect(wants('vramGiB >= 80')).toEqual(['h100']);
    expect(wants('gpuModel in (L40S)')).toEqual(['l40']);
    expect(wants('zone = b')).toEqual(['h100']);
    expect(wants('zone = c')).toEqual([]);
  });

  it('checks scalar claims against floor(allocatable × ratio) − allocated', () => {
    const roomy = node('roomy', 8, {
      resources: { vcpu: { allocatable: 64, ratio: 2, allocated: 100 } },
    });
    const tight = node('tight', 8, {
      resources: { vcpu: { allocatable: 64, ratio: 1, allocated: 60 } },
    });
    const plan = planPlacement(
      request(1, { resources: { vcpu: 16 } }),
      [roomy, tight, node('none')],
      pool,
    );
    expect(plan.ranked.map((entry) => entry.nodeId)).toEqual(['roomy']);
    expect(plan.rejected.map((entry) => entry.reason)).toEqual([
      'vcpu: 16 requested, 4 free',
      'no vcpu',
    ]);
  });

  it('picks NVLink-complete sets, and refuses nvlink-all when none exists', () => {
    // Two NVLink islands of 4 (0–3, 4–7); 0 and 4 are booked.
    const split = node('split', 8, {
      busy: [0, 4],
      links: links('split', 8, [
        [0, 1, 2, 3],
        [4, 5, 6, 7],
      ]),
    });
    const three = planPlacement(request(3), [split], pool).ranked[0]!;
    expect(three.worstLink).toBe('NV');
    expect(new Set(three.atoms.map((atom) => Number(atom.slice(-1)) < 4)).size).toBe(1);

    const four = planPlacement(request(4, { topology: 'nvlink-all' }), [split], pool);
    expect(four.ranked).toEqual([]);
    expect(four.rejected[0]).toMatchObject({ filter: 'topology' });

    const loose = planPlacement(request(4), [split], pool).ranked[0]!;
    expect(loose.worstLink).toBe('SYS');
    expect(loose.scores.topology).toBe(0);
  });

  it('scores a pick with unknown links neutrally and single GPUs perfectly', () => {
    expect(planPlacement(request(2), [node('n')], pool).ranked[0]!.scores.topology).toBe(0.5);
    expect(planPlacement(request(1), [node('n')], pool).ranked[0]!.scores.topology).toBe(1);
  });

  it('keeps a default pick on one NUMA node when links do not decide', () => {
    const view = node('n', 8, { busy: [0] });
    const atoms = defaultAtomPick(3, view.free, view).map((atom) => atom.attributes.numaNode);
    expect(new Set(atoms).size).toBe(1);
  });

  it('never picks unhealthy or unbookable atoms, even if a view lists them as free', () => {
    const view = node('n', 2);
    const free = [
      { ...view.free[0]!, healthy: false },
      { ...view.free[1]!, bookable: false },
    ] as Atom[];
    const plan = planPlacement(request(1), [{ ...view, free }], pool);
    expect(plan.ranked).toEqual([]);
  });

  it('runs plugin filters, pickers and scorers', () => {
    const plugin = defineSchedulerPlugin({
      id: 'acme',
      filters: [
        {
          id: 'no-b',
          filter: (_request, view) => (view.id === 'b' ? { reason: 'b is reserved' } : true),
        },
      ],
      scorers: [
        { id: 'prefer-c', weight: 10, score: (_request, view) => (view.id === 'c' ? 1 : 0) },
      ],
      preferAllocation: [{ class: 'gpu', pick: (device, free) => free.slice(-device.count) }],
    });
    const plan = planPlacement(request(2), [node('a'), node('b'), node('c')], pool, {
      plugins: [plugin],
    });
    expect(plan.ranked.map((entry) => entry.nodeId)).toEqual(['c', 'a']);
    expect(plan.ranked[0]!.atoms).toEqual(['c-gpu6', 'c-gpu7']);
    expect(plan.rejected).toEqual([{ nodeId: 'b', filter: 'no-b', reason: 'b is reserved' }]);

    const liar = defineSchedulerPlugin({
      id: 'liar',
      preferAllocation: [{ class: 'gpu', pick: (_device, free) => [free[0]!, free[0]!] }],
    });
    const refused = planPlacement(request(2), [node('a')], pool, { plugins: [liar] });
    expect(refused.rejected[0]).toMatchObject({ filter: 'liar' });
  });

  it('honours weight overrides', () => {
    const nodes = [node('empty'), node('half', 8, { busy: [0, 1, 2, 3] })];
    const spread = planPlacement(request(1), nodes, pool, {
      weights: { binpack: 0, spread: 1, fragmentation: 0 },
    });
    expect(spread.ranked[0]!.nodeId).toBe('empty');
  });

  it('places several device requests on one node without reusing atoms', () => {
    const plan = planPlacement(
      request(0, {
        devices: [
          { class: 'gpu', count: 2 },
          { class: 'gpu', count: 3 },
        ],
      }),
      [node('n', 4), node('m', 8)],
      pool,
    );
    expect(plan.ranked.map((entry) => entry.nodeId)).toEqual(['m']);
    expect(new Set(plan.ranked[0]!.atoms).size).toBe(5);
  });
});

describe('scalarCapacity', () => {
  it('floors allocatable × ratio as the database does in numeric, not a float short of it', () => {
    // In float, 100 × 0.29 is 28.999…96; the SQL guards allow 29.
    expect(100 * 0.29).toBeLessThan(29);
    expect(scalarCapacity({ allocatable: 100, ratio: 0.29 })).toBe(29);
    expect(scalarCapacity({ allocatable: 64, ratio: 1.5 })).toBe(96);
    expect(scalarCapacity({ allocatable: 7, ratio: 0.5 })).toBe(3);
  });
});

describe('choosePlan and quotaDemand', () => {
  const ranked = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((nodeId, index) => ({
    nodeId,
    atoms: [],
    resources: {},
    scores: {},
    score: 10 - index,
  }));

  it('picks at random among the top N only', () => {
    expect(choosePlan(ranked, () => 0)?.nodeId).toBe('a');
    expect(choosePlan(ranked, () => 0.9999)?.nodeId).toBe('e');
    expect(choosePlan(ranked, () => 0.9999, 2)?.nodeId).toBe('b');
    expect(choosePlan(ranked, () => 1, 1)?.nodeId).toBe('a');
    expect(choosePlan([], () => 0)).toBeUndefined();
  });

  it('counts device classes and scalars', () => {
    expect(
      quotaDemand({
        devices: [
          { class: 'gpu', count: 4 },
          { class: 'gpu', count: 2 },
          { class: 'nic.vf', count: 1 },
        ],
        resources: { vcpu: 16, memoryGiB: 0 },
      }),
    ).toEqual({ gpu: 6, 'nic.vf': 1, vcpu: 16 });
  });
});
