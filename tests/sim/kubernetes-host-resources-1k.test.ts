import { afterEach, describe, expect, it } from 'vitest';
import {
  assertInvariants,
  checkHostResources,
  checkKubeAdvertisements,
  createControlPlaneSim,
  type ControlPlaneSim,
  type HostResourceSample,
} from '@better-compute/testing';

// PLAN.md §3.8 at fleet scale: Kubernetes-bound and hold reservations that book host resources (vCPU,
// memory) churn over a 1k-node GPU pool whose hosts are re-inventoried under them. Pods keep a
// released Kubernetes hold's GPUs for a while (bcd reports the release only once they let go).
// Asserted (SIM_K8S_NODES sizes the pool, default 1000):
//   - node_resources never has more allocated than floor(allocatable × ratio), and what is allocated
//     is exactly what the node's live allocations claim, across releases, re-books and host
//     re-inventories (I1, sampled after every step);
//   - the fleet invariants (I1 bookings and bindings, I2–I5, I8).
// Not yet (the second test, expected to fail until capacity changes): no GPU is ever offered to a
// node's kubelet for one allocation while the control plane books it to another (I1, kubelet offers
// against device_bookings). The control plane frees a Kubernetes-bound GPU at release: it re-books
// it before the node withdrew it from its kubelet (one spec delivery) and while pods still hold it,
// so the new allocation fails with overlap on the node. The fix is capacity's: a Kubernetes booking
// ends when the node reports AllocationReleased (bcd reports it once no pod holds the devices).

const SEC = 1_000;
const MIN = 60 * SEC;
const NODES = Number(process.env.SIM_K8S_NODES ?? 1000);
const POD_RELEASE_MS = 45 * SEC;

let rig: ControlPlaneSim | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

interface ChurnResult {
  kubeViolations: number;
  failed: number;
}

async function churn(nodes: number, strict: boolean): Promise<ChurnResult> {
  rig = await createControlPlaneSim({
    seed: 'kubernetes-host-resources',
    nodes: 1,
    workerPasses: 10,
    up: { latencyMs: 5, jitterMs: 20, drop: 0.0005, dropMode: 'reset' },
    down: { latencyMs: 5, jitterMs: 20, drop: 0.0005, dropMode: 'reset' },
    chaos: { everyMs: 30 * SEC, crash: 0.1, partition: 0.1, reset: 0.1 },
    extraPools: [
      {
        class: 'metal-host',
        count: nodes,
        create: { gpuModel: 'H100' },
        policy: {
          acceptance: [{ kind: 'diag.nvml' }],
          kubernetes: {
            apiServer: 'https://k8s.sim:6443',
            caCertSha256: 'sha256:' + '0123456789abcdef'.repeat(4),
            joinTokenRef: 'secret://root/k8s-bootstrap',
            platformOperated: true,
          },
        },
        daemon: { knobs: { kubePodReleaseMs: POD_RELEASE_MS } },
      },
    ],
  });
  const { compute, tenants, api, database } = rig;
  const root = { token: tenants.root.token };
  const pool = rig.pools[0]!;
  await api(() =>
    compute.api.pools.offer(root, {
      tenantId: tenants.root.id,
      poolId: pool.poolId,
      toTenantId: tenants.root.id,
      quota: { gpu: 1_000_000, vcpu: 100_000_000, memoryGiB: 1_000_000_000 },
    } as never),
  );
  await rig.run(3 * MIN);

  const samples: HostResourceSample[] = [];
  const sample = async () => {
    const at = rig!.sim.scheduler.now();
    const { rows } = await database.query<{
      node_id: string;
      resource: string;
      allocatable: string;
      ratio: string;
      allocated: string;
      claimed: string;
    }>(
      `SELECT r.node_id, r.resource, r.allocatable::text, r.ratio::text, r.allocated::text,
                COALESCE((SELECT sum((a.resources->>r.resource)::numeric) FROM allocations a
                           WHERE a.node_id = r.node_id AND a.released_at IS NULL), 0)::text AS claimed
           FROM node_resources r WHERE r.node_id = ANY($1::text[])`,
      [pool.nodeIds],
    );
    for (const row of rows)
      samples.push({
        at,
        nodeId: row.node_id,
        resource: row.resource,
        allocatable: Number(row.allocatable),
        ratio: Number(row.ratio),
        allocated: Number(row.allocated),
        claimed: Number(row.claimed),
      });
  };
  await sample();
  expect(samples.some((s) => s.resource === 'vcpu')).toBe(true);

  // Churn: every 30 s a wave of reservations (Kubernetes-bound and holds, 1–4 GPUs with a vCPU and
  // memory share each); each is released a minute after it turned active, so the placer re-books
  // released GPUs while pods may still hold them. Every third wave a busy host is re-inventoried
  // with less CPU and memory (and restored three waves later).
  const live: { id: string; activeAt?: number }[] = [];
  const shrunk: string[] = [];
  let created = 0;
  let released = 0;
  let key = 0;
  for (let step = 0; step < 20; step++) {
    await rig.run(30 * SEC);
    for (let i = 0; i < 12; i++) {
      const gpus = 1 + ((step + i) % 4);
      const reservation = await api(() =>
        compute.api.reservations.create(root, {
          tenantId: tenants.root.id,
          poolId: pool.poolId,
          devices: [{ class: 'gpu', count: gpus }],
          resources: { vcpu: 8 * gpus, memoryGiB: 32 * gpus },
          duration: '1h',
          ...(i % 2 === 0 ? { binding: 'kubernetes' } : {}),
          idempotencyKey: `k8s-churn-${++key}`,
        } as never),
      );
      created++;
      live.push({ id: reservation.id });
    }
    const now = rig.sim.scheduler.now();
    const { rows } = await database.query<{ id: string; state: string }>(
      'SELECT id, state FROM reservations WHERE id = ANY($1::text[])',
      [live.map((entry) => entry.id)],
    );
    for (const row of rows) {
      const entry = live.find((item) => item.id === row.id)!;
      if (row.state === 'active') entry.activeAt ??= now;
      if (entry.activeAt !== undefined && now - entry.activeAt >= MIN) {
        await api(() =>
          compute.api.reservations.release(root, {
            tenantId: tenants.root.id,
            reservationId: row.id,
          } as never),
        );
        released++;
        live.splice(live.indexOf(entry), 1);
      }
    }
    if (step % 3 === 2) {
      const busy = await database.query<{ node_id: string }>(
        `SELECT node_id FROM allocations WHERE pool_id = $1 AND released_at IS NULL ORDER BY node_id LIMIT 1`,
        [pool.poolId],
      );
      const nodeId = busy.rows[0]?.node_id;
      if (nodeId) await reinventory(rig, nodeId, 'shrink', step);
      if (nodeId) shrunk.push(nodeId);
    }
    if (step % 3 === 2 && shrunk.length > 1)
      await reinventory(rig, shrunk.shift()!, 'restore', step);
    await sample();
  }
  rig.sim.quiesce();
  // Let pods let go, releases report, and capacity.usage meter a full window.
  await rig.run(6 * MIN);
  await sample();

  expect(created).toBe(240);
  expect(released).toBeGreaterThan(60);
  const fleet = rig.sim.facts;
  expect(fleet.advertisements.length).toBeGreaterThan(0);
  await rig.facts.refresh();
  const facts = rig.facts.facts();
  assertInvariants(checkHostResources(samples));
  assertInvariants(await rig.invariants({ flushedUpTo: rig.sim.scheduler.now() - 60 * MIN }));
  const kube = checkKubeAdvertisements({
    bookings: facts.bookings,
    advertisements: fleet.advertisements,
  });
  if (strict) assertInvariants(kube);
  const failed = await database.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM reservations WHERE state = 'failed'`,
  );
  const why = await database.query<{ binding: string | null; reason: string | null; n: number }>(
    `SELECT request->>'binding' AS binding, conditions->0->>'reason' AS reason, count(*)::int AS n
       FROM reservations WHERE state = 'failed' GROUP BY 1, 2 ORDER BY 3 DESC`,
  );
  console.log(`failed reservations by binding and reason: ${JSON.stringify(why.rows)}`);
  return { kubeViolations: kube.length, failed: failed.rows[0]!.n };
}

describe('Kubernetes and host-resource reservations under churn at fleet scale', () => {
  it('never overbooks a host across releases, re-books and re-inventories', async () => {
    const result = await churn(NODES, false);
    // Recorded, not asserted: see the test below.
    console.log(
      `kubelet offers of GPUs booked elsewhere: ${result.kubeViolations}; failed reservations: ${result.failed}`,
    );
  }, 3_600_000);

  // Fails today (see the header): flip to `it` once capacity ends a Kubernetes booking at the node's
  // AllocationReleased.
  it.fails(
    'never offers a kubelet a GPU the control plane booked to another allocation',
    async () => {
      await churn(12, true);
    },
    900_000,
  );
});

/** Re-inventories a host: less (or its original) CPU and memory, picked up by a rescan. */
async function reinventory(
  rig: ControlPlaneSim,
  nodeId: string,
  how: 'shrink' | 'restore',
  step: number,
): Promise<void> {
  const daemon = rig.sim.daemon(nodeId);
  const hw = daemon.hardware;
  const original = (rig.nodes.find((n) => n.nodeId === nodeId) ?? { hardware: hw }).hardware;
  const inventory = structuredClone(how === 'restore' ? original.inventory : hw.inventory);
  if (how === 'shrink' && inventory.cpu && inventory.memory) {
    inventory.cpu.threads = 96;
    inventory.memory.totalBytes = inventory.memory.totalBytes / 4n;
  }
  daemon.setHardware({ ...hw, inventory });
  await rig.api(() =>
    rig.compute.api.commands.run({ token: rig.tenants.root.token }, {
      tenantId: rig.tenants.root.id,
      nodeId,
      kind: 'inventory.refresh',
      payload: { sections: ['cpu', 'memory'], rescan: true },
      idempotencyKey: `reinventory-${how}-${nodeId}-${step}`,
    } as never),
  );
}
