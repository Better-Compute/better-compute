import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Atom, Device, NodeView, PlacementRequest } from '@better-compute/core';
import {
  choosePlan,
  dedicatedTaint,
  isSchedulable,
  missingNodeLabel,
  planPlacement,
  shortlistable,
  shortlistPlan,
  type CandidateCounts,
} from '@better-compute/capacity';

// Properties of capacity's pure planning (PLAN.md §15 "capacity math, scorers, seeded planning"),
// over random pools: nodes of every eligibility (cordons, taints, dedications to a tenant, other
// connectivity), GPUs healthy or not, busy or free, NVLink or not, scalar room or not.
// - soundness: every ranked plan is on a node schedulable for the request's tenant, not excluded,
//   with distinct free atoms of exactly the requested classes and counts, and scalars that fit;
// - order: best first, ties by node id; every node is either ranked or rejected, once;
// - the shortlist (counts → partial scores → top candidates → bound) ranks exactly the whole
//   pool's top N whenever it answers.

const POOL = 'pool_p';
const pool = { ownerTenantId: 'root' };
const links = ['NV', 'PIX', 'PHB', 'SYS'] as const;

const nodeArb = (index: number) =>
  fc
    .record({
      gpus: fc.integer({ min: 0, max: 8 }),
      nic: fc.boolean(),
      state: fc.constantFrom(
        'ok',
        'ok',
        'ok',
        'ok',
        'cordoned',
        'lost',
        'tainted',
        'dedicated-acme',
        'dedicated-beta',
        'dedicated-acme+tainted',
      ),
      healthy: fc.array(fc.boolean(), { minLength: 9, maxLength: 9 }),
      busy: fc.array(fc.boolean(), { minLength: 9, maxLength: 9 }),
      linked: fc.constantFrom('none', 'islands', 'flat'),
      vcpuAllocated: fc.integer({ min: 0, max: 64 }),
      driver: fc.constantFrom(undefined, undefined, '1.0', '2.0'),
    })
    .map((seed): NodeView => {
      const id = `n_${String(index).padStart(3, '0')}`;
      const devices: Device[] = [];
      for (let g = 0; g < seed.gpus; g++)
        devices.push({
          id: `${id}-g${g}`,
          nodeId: id,
          class: 'gpu',
          bookable: true,
          healthy: seed.healthy[g]! || g % 3 !== 0,
          attributes: { gpuModel: 'H100', numaNode: g < 4 ? 0 : 1 },
        });
      if (seed.nic)
        devices.push({
          id: `${id}-nic`,
          nodeId: id,
          class: 'nic',
          bookable: true,
          healthy: true,
          attributes: {},
        });
      const free = devices.filter(
        (device, at): device is Atom => device.bookable && device.healthy && !seed.busy[at],
      );
      let nodeLinks: NodeView['links'];
      if (seed.linked !== 'none' && seed.gpus > 1) {
        const table: Record<string, Record<string, (typeof links)[number]>> = {};
        for (let a = 0; a < seed.gpus; a++)
          for (let b = 0; b < seed.gpus; b++) {
            if (a === b) continue;
            const link = seed.linked === 'flat' ? 'PHB' : a >> 1 === b >> 1 ? 'NV' : 'SYS';
            (table[`${id}-g${a}`] ??= {})[`${id}-g${b}`] = link;
          }
        nodeLinks = table;
      }
      const reasons: Record<string, string[]> = {
        tainted: ['taint:maintenance-window'],
        'dedicated-acme': [dedicatedTaint('acme')],
        'dedicated-beta': [dedicatedTaint('beta')],
        'dedicated-acme+tainted': [dedicatedTaint('acme'), 'GpuCountMismatch'],
      };
      return {
        id,
        siteId: 'site_p',
        poolId: POOL,
        ownerTenantId: 'root',
        role: 'host',
        provisionState: 'adopted',
        maintenance: false,
        cordoned: seed.state === 'cordoned',
        connectivity: seed.state === 'lost' ? 'lost' : 'connected',
        trust: 'platform',
        labels: seed.driver ? { 'bc.dev/driver.kata': seed.driver } : {},
        noScheduleReasons: reasons[seed.state] ?? [],
        devices,
        free,
        resources: { vcpu: { allocatable: 64, ratio: 1, allocated: seed.vcpuAllocated } },
        ...(nodeLinks ? { links: nodeLinks } : {}),
      };
    });

const poolArb = (min: number, max: number) =>
  fc
    .integer({ min, max })
    .chain((size) => fc.tuple(...Array.from({ length: size }, (_, i) => nodeArb(i))));

const requestArb = (nodeCount: number, maxGpus = 5) =>
  fc
    .record({
      tenantId: fc.constantFrom('acme', 'beta', 'gamma'),
      gpus: fc.integer({ min: 0, max: maxGpus }),
      nic: fc.boolean(),
      vcpu: fc.constantFrom(0, 0, 4, 16, 48),
      labels: fc.constantFrom(undefined, undefined, undefined, undefined, '*', '1.0'),
      exclude: fc.uniqueArray(fc.integer({ min: 0, max: Math.max(0, nodeCount - 1) }), {
        maxLength: 4,
      }),
      topN: fc.integer({ min: 1, max: 6 }),
      weights: fc.record({
        binpack: fc.constantFrom(0, 1, 2),
        spread: fc.constantFrom(0, 1),
        fragmentation: fc.constantFrom(0, 0.25, 1),
        topology: fc.constantFrom(0, 1, 3),
      }),
    })
    .filter((seed) => seed.gpus > 0 || seed.nic || seed.vcpu > 0)
    .map((seed) => ({
      topN: seed.topN,
      weights: seed.weights,
      request: {
        tenantId: seed.tenantId,
        poolId: POOL,
        reservationId: 'rsv_p',
        devices: [
          ...(seed.gpus > 0 ? [{ class: 'gpu' as const, count: seed.gpus }] : []),
          ...(seed.nic ? [{ class: 'nic' as const, count: 1 }] : []),
        ],
        ...(seed.vcpu > 0 ? { resources: { vcpu: seed.vcpu } } : {}),
        excludeNodes: seed.exclude.map((i) => `n_${String(i).padStart(3, '0')}`),
        ...(seed.labels ? { nodeLabels: { 'bc.dev/driver.kata': seed.labels } } : {}),
        during: { start: 0, end: 3_600_000 },
      } satisfies PlacementRequest,
    }));

const caseArb = poolArb(1, 70).chain((nodes) =>
  requestArb(nodes.length).map((request) => ({ nodes, ...request })),
);
// Pools well past the shortlist (48) and small requests, so many nodes fit and its bound decides.
const bigCaseArb = poolArb(60, 180).chain((nodes) =>
  requestArb(nodes.length, 2).map((request) => ({ nodes, ...request })),
);

/** What the shortlist's SQL counts from the tables, computed from the same views. */
function countsFromViews(nodes: readonly NodeView[], request: PlacementRequest): CandidateCounts[] {
  const want = new Map<string, number>();
  for (const device of request.devices)
    want.set(device.class, (want.get(device.class) ?? 0) + device.count);
  const excluded = new Set(request.excludeNodes ?? []);
  const out: CandidateCounts[] = [];
  nodes: for (const node of nodes) {
    if (excluded.has(node.id) || !isSchedulable(node, pool, request.tenantId)) continue;
    if (missingNodeLabel(request.nodeLabels, node.labels) !== undefined) continue;
    for (const [resource, need] of Object.entries(request.resources ?? {})) {
      const scalar = node.resources[resource];
      if (
        need > 0 &&
        (!scalar || scalar.allocated + need > Math.floor(scalar.allocatable * scalar.ratio))
      )
        continue nodes;
    }
    if (want.size === 0) {
      out.push({ nodeId: node.id, free: 0, total: 0 });
      continue;
    }
    let free = 0;
    let total = 0;
    for (const [deviceClass, count] of want) {
      const available = node.free.filter((atom) => atom.class === deviceClass).length;
      if (available < count) continue nodes;
      free += available;
      total += node.devices.filter(
        (device) => device.class === deviceClass && device.bookable,
      ).length;
    }
    out.push({ nodeId: node.id, free, total });
  }
  return out;
}

describe('capacity planning properties', () => {
  it('ranks only sound plans, best first, and accounts for every node once', () => {
    let nonEmpty = 0;
    let onDedicated = 0;
    fc.assert(
      fc.property(caseArb, ({ nodes, request, weights }) => {
        const plan = planPlacement(request, nodes, pool, { weights });
        if (plan.ranked.length > 1) nonEmpty++;
        const byId = new Map(nodes.map((node) => [node.id, node]));
        const excluded = new Set(request.excludeNodes);
        for (const entry of plan.ranked) {
          const node = byId.get(entry.nodeId)!;
          expect(excluded.has(node.id)).toBe(false);
          expect(isSchedulable(node, pool, request.tenantId)).toBe(true);
          expect(missingNodeLabel(request.nodeLabels, node.labels)).toBeUndefined();
          expect(new Set(entry.atoms).size).toBe(entry.atoms.length);
          const free = new Map(node.free.map((atom) => [atom.id, atom]));
          const perClass = new Map<string, number>();
          for (const atom of entry.atoms) {
            expect(free.has(atom)).toBe(true);
            const deviceClass = free.get(atom)!.class;
            perClass.set(deviceClass, (perClass.get(deviceClass) ?? 0) + 1);
          }
          for (const device of request.devices)
            expect(perClass.get(device.class) ?? 0).toBe(device.count);
          expect(perClass.size).toBe(request.devices.length);
          for (const [resource, need] of Object.entries(request.resources ?? {})) {
            const scalar = node.resources[resource]!;
            expect(scalar.allocated + need).toBeLessThanOrEqual(
              Math.floor(scalar.allocatable * scalar.ratio),
            );
          }
        }
        for (let i = 1; i < plan.ranked.length; i++) {
          const [a, b] = [plan.ranked[i - 1]!, plan.ranked[i]!];
          expect(a.score > b.score || (a.score === b.score && a.nodeId < b.nodeId)).toBe(true);
        }
        const seen = [
          ...plan.ranked.map((entry) => entry.nodeId),
          ...plan.rejected.map((r) => r.nodeId),
        ];
        expect([...seen].sort()).toEqual(nodes.map((node) => node.id).sort());
        // A node dedicated to another tenant is never offered.
        for (const entry of plan.ranked)
          for (const reason of byId.get(entry.nodeId)!.noScheduleReasons) {
            expect(reason).toBe(dedicatedTaint(request.tenantId));
            onDedicated++;
          }
      }),
      { numRuns: 300 },
    );
    // The generator reaches the interesting cases.
    expect(nonEmpty).toBeGreaterThan(60);
    expect(onDedicated).toBeGreaterThan(20);
  });

  it('shortlists exactly: whenever it answers, its top N is the whole pool’s', async () => {
    let answered = 0;
    let beyond = 0;
    await fc.assert(
      fc.asyncProperty(bigCaseArb, async ({ nodes, request, weights, topN }) => {
        if (!shortlistable(request, [])) return;
        const full = planPlacement(request, nodes, pool, { weights });
        const byId = new Map(nodes.map((node) => [node.id, node]));
        const short = await shortlistPlan(
          { id: POOL, ownerTenantId: 'root' } as never,
          request,
          request.excludeNodes ?? [],
          { plugins: [], weights, topN },
          {
            counts: () => countsFromViews(nodes, request),
            views: (ids) => ids.map((id) => byId.get(id)!),
            linked: () =>
              new Set(nodes.filter((node) => node.links !== undefined).map((node) => node.id)),
          },
        );
        if (!short) return;
        answered++;
        if (full.ranked.length > short.views.length) beyond++;
        const top = (ranked: typeof full.ranked) =>
          ranked.slice(0, topN).map((entry) => [entry.nodeId, entry.score]);
        expect(top(short.plan.ranked)).toEqual(top(full.ranked));
        // Picking among the top N never leaves it.
        const choice = choosePlan(short.plan.ranked, () => 0.999, topN);
        if (choice)
          expect(full.ranked.slice(0, topN).map((entry) => entry.nodeId)).toContain(choice.nodeId);
      }),
      { numRuns: 1500 },
    );
    expect(answered).toBeGreaterThan(50);
    // …including answers that left fitting nodes outside the shortlist (≈50 of 1,500 runs, 38–59
    // seen over seeds: a coverage floor, well below the spread, not a target).
    expect(beyond).toBeGreaterThan(15);
  });
});
