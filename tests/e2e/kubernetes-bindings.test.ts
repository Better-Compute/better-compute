import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cdiSpecPath, createDevStack, type DevStack } from '@better-compute/testing';

// PLAN.md §3.8 Kubernetes: a reservation with binding 'kubernetes' on a pool whose machines are
// Kubernetes workers is held on the node like any hold, but its CDI spec is marked for bcd's kubelet
// device plugin (bcd.dev/binding=kubernetes) and carries no NVIDIA_VISIBLE_DEVICES (the plugin sets it
// per pod); a plain hold on the same pool is not marked. Release removes the hold, and with it the
// devices the plugin advertises.

let dev: DevStack;
let api: any;
let poolId: string;
let nodes: string[];
let keys = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const pin = 'sha256:' + '0123456789abcdef'.repeat(4);

beforeAll(async () => {
  dev = await createDevStack();
  api = dev.compute.api;
  const site = await api.sites.create(dev.root, {
    tenantId: dev.rootTenantId,
    kind: 'shared',
    region: 'eu-west-1',
    idempotencyKey: 'k8s-site',
  });
  ({ id: poolId } = await api.pools.create(dev.root, {
    tenantId: dev.rootTenantId,
    siteId: site.id,
    class: 'metal-host',
    gpuModel: 'H100',
    policy: {
      acceptance: [{ kind: 'diag.nvml' }],
      kubernetes: {
        apiServer: 'https://k8s.example.com:6443',
        caCertSha256: pin,
        joinTokenRef: 'secret://root/k8s-bootstrap',
        labels: { team: 'ml' },
      },
    },
    idempotencyKey: 'k8s-pool',
  }));
  nodes = await dev.join({ poolId, count: 2, seed: 'k8s' });
  await dev.waitFor(nodes, { timeoutMs: 60_000 });
  await api.pools.offer(dev.root, {
    tenantId: dev.rootTenantId,
    poolId,
    toTenantId: dev.rootTenantId,
    quota: { gpu: 16 },
  });
}, 180_000);

afterAll(async () => {
  await dev?.close();
});

const reserve = (binding: 'kubernetes' | 'hold', gpus: number) =>
  api.reservations.create(dev.root, {
    tenantId: dev.rootTenantId,
    poolId,
    devices: [{ class: 'gpu', count: gpus }],
    duration: 3_600_000,
    ...(binding === 'kubernetes' ? { binding } : {}),
    idempotencyKey: `k8s-${++keys}`,
  });

const active = (reservationId: string) =>
  until('the reservation to bind', async () => {
    const current = await api.reservations.get(dev.root, {
      tenantId: dev.rootTenantId,
      reservationId,
    });
    return current.state === 'active' ? current : undefined;
  });

const holdOf = async (reservationId: string) => {
  const { rows } = await dev.database.query<{ id: string; node_id: string }>(
    `SELECT a.id, a.node_id FROM allocations a WHERE a.owner_kind = 'reservation' AND a.owner_id = $1 AND a.released_at IS NULL`,
    [reservationId],
  );
  const daemon = dev.daemons.get(rows[0]!.node_id)!;
  return {
    allocationId: rows[0]!.id,
    daemon,
    spec: JSON.parse(daemon.files.get(cdiSpecPath(rows[0]!.id))!),
  };
};

describe('Kubernetes-bound reservations (§3.8)', () => {
  it("hands a 'kubernetes' reservation's GPUs to the device plugin, and only those", async () => {
    const kube = await reserve('kubernetes', 2);
    const plain = await reserve('hold', 1);
    await active(kube.id);
    await active(plain.id);

    const k = await holdOf(kube.id);
    expect(k.spec.annotations['bcd.dev/binding']).toBe('kubernetes');
    expect(k.spec.devices).toHaveLength(2);
    expect(k.spec.containerEdits.env).toEqual([`BCD_ALLOCATION_ID=${k.allocationId}`]);
    const p = await holdOf(plain.id);
    expect(p.spec.annotations['bcd.dev/binding']).toBeUndefined();
    expect(p.spec.containerEdits.env).toContain(`NVIDIA_VISIBLE_DEVICES=${p.spec.devices[0].name}`);

    // The node's spec says so too: BINDING_KUBERNETES (4) on the assignment, with its booked limits.
    const { rows } = await dev.database.query<{ spec: any }>(
      `SELECT spec FROM nodes WHERE id = $1`,
      [k.daemon.nodeId],
    );
    const assignment = (rows[0]!.spec.devices?.assignments ?? []).find(
      (a: { allocationId: string }) => a.allocationId === k.allocationId,
    );
    expect(assignment).toMatchObject({ binding: 'BINDING_KUBERNETES' });
    // With booked host resources, the kubelet's slice of the machine rides along as limits (once
    // capacity's host reconciler has written the machines' CPU and memory rows).
    await until(
      'host resources',
      async () =>
        (
          await dev.database.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM node_resources WHERE resource = 'vcpu'`,
          )
        ).rows[0]!.n >= 2,
      60_000,
    );
    const sized = await api.reservations.create(dev.root, {
      tenantId: dev.rootTenantId,
      poolId,
      devices: [{ class: 'gpu', count: 1 }],
      resources: { vcpu: 4, memoryGiB: 32 },
      duration: 3_600_000,
      binding: 'kubernetes',
      idempotencyKey: `k8s-${++keys}`,
    });
    await active(sized.id);
    const s = await holdOf(sized.id);
    const specs = await dev.database.query<{ spec: any }>(`SELECT spec FROM nodes WHERE id = $1`, [
      s.daemon.nodeId,
    ]);
    const sizedAssignment = (specs.rows[0]!.spec.devices?.assignments ?? []).find(
      (a: { allocationId: string }) => a.allocationId === s.allocationId,
    );
    // What was booked: the request, floored at the GPU's share of the host (a21c1c1 + review M7).
    const booked = (
      (await api.reservations.get(dev.root, {
        tenantId: dev.rootTenantId,
        reservationId: sized.id,
      })) as { request: { resources: { vcpu: number; memoryGiB: number } } }
    ).request.resources;
    expect(booked.vcpu).toBeGreaterThanOrEqual(4);
    expect(booked.memoryGiB).toBeGreaterThanOrEqual(32);
    expect(sizedAssignment).toMatchObject({
      binding: 'BINDING_KUBERNETES',
      limits: {
        cpuMillis: booked.vcpu * 1000,
        memoryBytes: String(booked.memoryGiB * 2 ** 30),
      },
    });
    expect(s.spec.annotations['bcd.dev/binding']).toBe('kubernetes');

    await api.reservations.release(dev.root, {
      tenantId: dev.rootTenantId,
      reservationId: kube.id,
    });
    await until(
      'the Kubernetes hold to go',
      async () => !k.daemon.files.has(cdiSpecPath(k.allocationId)),
    );
    expect(p.daemon.files.has(cdiSpecPath(p.allocationId))).toBe(true);
  }, 120_000);

  it('an XID on a Kubernetes-bound GPU degrades its reservation, and releases nothing', async () => {
    const created = await reserve('kubernetes', 1);
    await active(created.id);
    const k = await holdOf(created.id);
    const gpu = k.spec.devices[0].name as string;
    (k.daemon as any).injectXid(gpu, 48);
    const degraded = await until(
      'the reservation to be Degraded',
      async () => {
        const current = await api.reservations.get(dev.root, { tenantId: dev.rootTenantId, reservationId: created.id });
        return current.conditions?.find((c: { type: string }) => c.type === 'Degraded') ? current : undefined;
      },
      60_000,
    );
    expect(degraded.state).toBe('active');
    expect(degraded.conditions.find((c: { type: string }) => c.type === 'Degraded')).toMatchObject({
      reason: 'AtomUnhealthy',
      message: expect.stringContaining(gpu),
    });
    const { rows } = await dev.database.query<{ healthy: boolean }>(`SELECT healthy FROM devices WHERE id = $1`, [gpu]);
    expect(rows[0]!.healthy).toBe(false);
    // P6: the node keeps the hold (bcd's plugins mark the GPU Unhealthy; nothing is released).
    expect(k.daemon.files.has(cdiSpecPath(k.allocationId))).toBe(true);
    await api.reservations.release(dev.root, { tenantId: dev.rootTenantId, reservationId: created.id });
  }, 120_000);

  it("refuses binding 'kubernetes' on a pool that is not a cluster's", async () => {
    const { poolId: plainPool } = await dev.createPool({ key: 'no-k8s' });
    await expect(
      api.reservations.create(dev.root, {
        tenantId: dev.rootTenantId,
        poolId: plainPool,
        devices: [{ class: 'gpu', count: 1 }],
        duration: 3_600_000,
        binding: 'kubernetes',
        idempotencyKey: 'k8s-refused',
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/INVALID_INPUT|INVALID_STATE|FAILED_PRECONDITION/),
    });
  });
});
