import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Credential } from '@better-compute/core';
import { examplePolicies } from '@better-compute/iam';
import {
  TEST_COMPUTE_AUDIENCE,
  createEmbeddedTestIam,
  type EmbeddedTestIam,
} from '@better-compute/iam/testing';
import { cdiSpecPath, createDevStack, type DevStack } from '@better-compute/testing';

// PLAN.md §16 v0.1 exit, tests/e2e/spine.test.ts: the spine end to end, with nothing scripted between
// the org user and the node. Embedded better-iam holds the §12.6 example policies; three FakeDaemons
// join through the real gateway with sealed tokens, pass diag.nvml and are adopted; an org user bound
// by policy (not root) reserves 4 GPUs from a pool offered to their organization; the daemon's CDI
// spec lists exactly the booked GPU UUIDs, which reservations.get returns; release removes the hold.

let t: EmbeddedTestIam;
let dev: DevStack;
let api: any;
let poolId: string;
let nodes: string[];
let alice: { identityId: string; credential: Credential };
let bob: { identityId: string; credential: Credential };
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

const reserve = (who: Credential, gpus: number, durationHours = 2) =>
  api.reservations.create(who, {
    tenantId: t.acme.tenantId,
    poolId,
    devices: [{ class: 'gpu', count: gpus }],
    duration: durationHours * 3_600_000,
    idempotencyKey: `spine-${++keys}`,
  });
const get = (who: Credential, reservationId: string) =>
  api.reservations.get(who, { tenantId: t.acme.tenantId, reservationId });

beforeAll(async () => {
  t = await createEmbeddedTestIam({ now: () => Date.now() });
  dev = await createDevStack({
    // ReserveBoundedH100 allows eu-west-1 and eu-central-1.
    region: 'eu-west-1',
    iam: {
      port: t.port,
      rootTenantId: t.root.tenantId,
      root: t.root.credential,
      modules: t.bridge.modules,
    },
  });
  api = dev.compute.api;
  // The platform: an H100 pool whose machines must show all 8 GPUs to be adopted.
  ({ poolId } = await dev.createPool({ gpuModel: 'H100', expectGpuCount: 8, key: 'spine' }));
  nodes = await dev.join({ poolId, count: 3, seed: 'spine' });
  await dev.waitFor(nodes, { timeoutMs: 60_000 });
  await api.pools.offer(t.root.credential, {
    tenantId: t.root.tenantId,
    poolId,
    toTenantId: t.acme.tenantId,
    quota: { gpu: 16 },
  });
  // ReserveBoundedH100 needs the tenant flag.
  await t.iam.api.features.create(t.root.credential, {
    tenantId: t.root.tenantId,
    key: 'compute.h100',
    defaultValue: true,
  });
  // alice and bob hold §12.6's policies verbatim; only alice is a user of the pool.
  alice = await t.acme.member('alice');
  bob = await t.acme.member('bob');
  const documents = examplePolicies({ audience: TEST_COMPUTE_AUDIENCE }).map((p) => p.document);
  await t.acme.grant(alice.identityId, ...(documents as never[]));
  await t.acme.grant(bob.identityId, ...(documents as never[]));
  await t.acme.share('compute-pool', poolId, 'user', { identityId: alice.identityId });
}, 180_000);

afterAll(async () => {
  await dev?.close();
  await t?.close();
});

describe('the v0.1 spine end to end (§16)', () => {
  it('an org user reserves 4 GPUs; the node holds exactly the booked UUIDs reservations.get returns', async () => {
    const created = await reserve(alice.credential, 4);
    expect(['pending', 'placed']).toContain(created.state);
    const active = await until('the reservation to bind', async () => {
      const current = await get(alice.credential, created.id);
      return current.state === 'active' ? current : undefined;
    });
    expect(active.ownerIdentityId).toBe(alice.identityId);
    const binding = active.binding as { nodeId: string; cdiDevices: string[]; envFile: string };
    expect(nodes).toContain(binding.nodeId);
    const returned = binding.cdiDevices.map((name) => name.replace(/^bcd\.dev\/gpu=/, '')).sort();
    expect(returned).toHaveLength(4);

    // What the database booked for it.
    const { rows } = await dev.database.query<{ id: string; device_id: string }>(
      `SELECT a.id, b.device_id FROM allocations a JOIN device_bookings b ON b.allocation_id = a.id
        WHERE a.owner_kind = 'reservation' AND a.owner_id = $1 AND a.released_at IS NULL
        ORDER BY b.device_id`,
      [created.id],
    );
    const allocationId = rows[0]!.id;
    expect(rows.map((row) => row.device_id)).toEqual(returned);

    // What the node holds: its CDI spec lists exactly those UUIDs, all of them its own GPUs.
    const daemon = dev.daemons.get(binding.nodeId)!;
    const spec = JSON.parse(daemon.files.get(cdiSpecPath(allocationId))!) as {
      annotations: Record<string, string>;
      devices: { name: string }[];
    };
    expect(spec.devices.map((device) => device.name).sort()).toEqual(returned);
    expect(spec.annotations['bcd.dev/reservation-id']).toBe(created.id);
    expect([...daemon.assignedDevices()].sort()).toEqual(returned);
    for (const uuid of returned) expect(daemon.hardware.gpuUuids).toContain(uuid);
    expect(daemon.files.get(binding.envFile)).toContain(
      `NVIDIA_VISIBLE_DEVICES=${returned.join(',')}`,
    );

    // Release: the booking ends and the node drops the hold (AllocationReleased).
    await api.reservations.release(alice.credential, {
      tenantId: t.acme.tenantId,
      reservationId: created.id,
    });
    await until(
      'the node to drop the hold',
      async () => !daemon.files.has(cdiSpecPath(allocationId)),
    );
    expect(daemon.assignedDevices().size).toBe(0);
    const released = await get(alice.credential, created.id);
    expect(['released', 'releasing']).toContain(released.state);
  }, 90_000);

  it('holds policy on the real stack: 9 GPUs denied, a non-user denied, another tenant sees nothing', async () => {
    await expect(reserve(alice.credential, 9)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await expect(reserve(alice.credential, 1, 73)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await expect(reserve(bob.credential, 1)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    const mine = await reserve(alice.credential, 1);
    await expect(get(bob.credential, mine.id)).rejects.toMatchObject({
      code: expect.stringMatching(/ACCESS_DENIED|NOT_FOUND/),
    });
    await expect(
      api.reservations.get(t.other.owner, { tenantId: t.acme.tenantId, reservationId: mine.id }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/ACCESS_DENIED|NOT_FOUND|TENANT/) });
    // Nothing of the denied requests was booked.
    const { rows } = await dev.database.query<{ id: string; state: string }>(
      `SELECT id, state FROM reservations WHERE tenant_id = $1 ORDER BY id`,
      [t.acme.tenantId],
    );
    const live = rows.filter((row) => row.id === mine.id);
    // Placed and on its way to active; 'binding' (the node applying the spec) shows with remote IAM's latency.
    expect(live).toEqual([{ id: mine.id, state: expect.stringMatching(/placed|binding|active/) }]);
    expect(rows.filter((row) => row.state === 'denied')).toHaveLength(3);
    const booked = await dev.database.query<{ owner_id: string }>(
      `SELECT DISTINCT a.owner_id FROM allocations a JOIN device_bookings b ON b.allocation_id = a.id
        WHERE a.tenant_id = $1 AND a.released_at IS NULL`,
      [t.acme.tenantId],
    );
    expect(booked.rows.map((row) => row.owner_id)).toEqual([mine.id]);
    await api.reservations.release(alice.credential, {
      tenantId: t.acme.tenantId,
      reservationId: mine.id,
    });
  }, 60_000);
});
