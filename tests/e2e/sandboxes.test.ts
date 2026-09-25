import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMetrics,
  databaseCollector,
  standardMetrics,
  type DatabaseCollector,
  type MetricsRegistry,
} from '@better-compute/observability';
import { instanceStatusHandler, setIpPool, vps } from '@better-compute/vps';
import { createDevStack, type DevStack } from '@better-compute/testing';
import { checkNoLeaks, instancesSettled, liveInstances } from './support/vps-leaks.js';

// PLAN.md §16 v0.5 exit, tests/e2e/sandboxes.test.ts (§3.7, D24), through the whole stack: the real server runtime
// (admission, placement, the instance and sandbox reconcilers, the secret broker), the real gateway and three
// FakeDaemon VPS hosts with fake cloud-hypervisor runtimes that pause.
// - a warm claim reaches `ready` without a placement: the paused warm instance is resumed where it is, on the
//   allocation it already had, and the pool refills;
// - SANDBOXES (500) sandboxes with short TTLs expire on their own, and the hosts and the database are left with the
//   same zero-leak diff as v0.3 (domains, overlays, taps, IP leases, bookings);
// - the §14 sandbox series (observability's databaseCollector) saw it: readiness by source and expiry lag;
// - a memory snapshot round trip: guest memory captured on one sandbox comes back in one created fromSnapshot, and
//   the stored object goes with the sandbox.

const SANDBOXES = Number(process.env.E2E_SANDBOXES ?? 500);
const IMAGE = {
  url: 'https://images.example/ubuntu-24.04.qcow2',
  sha256: 'cd'.repeat(32),
  format: 'qcow2' as const,
  verified: true,
};
const orphanLogs: string[] = [];
/** The hosts' shared object store (a snapshot taken on one host restores on another), and what vps deleted. */
const snapshotObjects = new Map<string, Uint8Array>();
const deletedSnapshots: string[] = [];
let dev: DevStack;
let api: any;
let tenantId: string;
let poolId: string;
let nodes: string[];
let registry: MetricsRegistry;
let collector: DatabaseCollector;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

let keys = 0;
const createTemplate = (name: string, extra: Record<string, unknown> = {}) =>
  api.sandboxTemplates.create(dev.root, {
    tenantId,
    name,
    poolId,
    flavor: 'xs',
    imageId: 'ubuntu-24.04',
    ...extra,
  });
const createSandbox = (templateId: string, extra: Record<string, unknown> = {}) =>
  api.sandboxes.create(dev.root, {
    tenantId,
    templateId,
    idempotencyKey: `e2e-sbx-${++keys}`,
    ...extra,
  });

/** The template's unclaimed warm instances, with their allocations. */
async function warmInstances(templateId: string) {
  const { rows } = await dev.database.query<{
    id: string;
    state: string;
    allocation_id: string | null;
    node_id: string | null;
  }>(
    `SELECT id, state, allocation_id, node_id FROM instances
      WHERE warm_template_id = $1 AND desired_state <> 'deleted' ORDER BY id`,
    [templateId],
  );
  return rows;
}

beforeAll(async () => {
  dev = await createDevStack({
    modules: [
      vps({
        images: { resolve: async () => IMAGE },
        runtimes: ['cloud-hypervisor'],
        hostSyncEvery: '1s',
        snapshots: {
          presign: async ({ snapshotId }) => ({
            uploadUrl: `https://snapshots.e2e.example/put/${snapshotId}?sig=e2e`,
            url: `https://snapshots.e2e.example/${snapshotId}`,
          }),
          delete: async ({ snapshotId }) => {
            deletedSnapshots.push(snapshotId);
          },
        },
      }),
    ],
    reports: { status: instanceStatusHandler({ log: (message) => orphanLogs.push(message) }) },
    daemon: { instances: { runtimes: ['cloud-hypervisor'], snapshotStore: snapshotObjects } },
  });
  api = dev.compute.api;
  tenantId = dev.rootTenantId;
  const site = await api.sites.create(dev.root, {
    tenantId,
    kind: 'shared',
    region: 'dev-1',
    idempotencyKey: 'e2e-sbx-site',
  });
  const pool = await api.pools.create(dev.root, {
    tenantId,
    siteId: site.id,
    class: 'vps-host',
    ownerQuota: { vcpu: 100_000, memoryGiB: 1_000_000, diskGiB: 10_000_000 },
    policy: { runtime: 'cloud-hypervisor' },
    idempotencyKey: 'e2e-sbx-pool',
  });
  poolId = pool.id;
  await setIpPool(dev.database, { poolId, cidr: '10.16.0.0/21', gateway: '10.16.0.1' });
  await api.flavors.create(dev.root, {
    tenantId,
    poolId,
    name: 'xs',
    vcpu: 1,
    memoryGiB: 1,
    diskGiB: 4,
  });
  nodes = await dev.join({ poolId, count: 3, seed: 'e2e-sandboxes' });
  await dev.waitFor(nodes, { timeoutMs: 45_000 });
  await until('host capacity', async () => {
    const { rows } = await dev.database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM node_resources WHERE node_id = ANY($1)`,
      [nodes],
    );
    return rows[0]!.count === 9;
  });
  // The §14 series from here on (the first poll anchors them).
  registry = createMetrics();
  collector = databaseCollector(standardMetrics(registry), {
    sql: dev.database,
    latencyLease: false,
  });
  await collector.refresh();
}, 120_000);

afterAll(async () => {
  await dev?.close();
});

describe('sandboxes end to end (§16 v0.5)', () => {
  let warmTemplate: { id: string };

  it('a warm claim reaches ready without a placement, resumed where it was paused', async () => {
    warmTemplate = await createTemplate('warm', { warm: { min: 2, max: 2 } });
    const warm = await until(
      'two paused warm instances',
      async () => {
        const rows = await warmInstances(warmTemplate.id);
        return rows.length === 2 && rows.every((row) => row.state === 'paused') && rows;
      },
      90_000,
    );
    const { rows: before } = await dev.database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM allocations WHERE owner_kind = 'instance'`,
    );
    const sandbox = await createSandbox(warmTemplate.id, { ttlSeconds: 600 });
    expect(sandbox.warm).toBe(true);
    const claimed = warm.find((row) => row.id === sandbox.instanceId);
    expect(claimed, 'the sandbox drives one of the warm instances').toBeDefined();
    const ready = await until('the warm sandbox ready', async () => {
      const view = await api.sandboxes.get(dev.root, { tenantId, sandboxId: sandbox.id });
      return view.state === 'ready' && view.readyAt !== undefined && view;
    });
    expect(ready.readyAt).toBeGreaterThanOrEqual(ready.createdAt);
    // No placement: the same node and allocation, and the domain resumed rather than booted again.
    const { rows: after } = await dev.database.query<{
      allocation_id: string;
      node_id: string;
      state: string;
    }>(`SELECT allocation_id, node_id, state FROM instances WHERE id = $1`, [sandbox.instanceId]);
    expect(after[0]).toMatchObject({
      allocation_id: claimed!.allocation_id,
      node_id: claimed!.node_id,
      state: 'running',
    });
    const domain = dev.daemons.get(claimed!.node_id!)!.hypervisor!.domains.get(sandbox.instanceId)!;
    expect(domain).toMatchObject({ state: 'running', boots: 1 });
    const { rows: claims } = await dev.database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM allocations WHERE owner_kind = 'instance'`,
    );
    // Only the refill may have placed since (its own allocation), never the claim.
    expect(claims[0]!.count - before[0]!.count).toBeLessThanOrEqual(1);
    // The pool refills to warm.min.
    await until(
      'the warm pool refilled',
      async () => {
        const rows = await warmInstances(warmTemplate.id);
        return rows.length === 2 && rows.every((row) => row.state === 'paused');
      },
      90_000,
    );
    await api.sandboxes.delete(dev.root, { tenantId, sandboxId: sandbox.id });
    await until(
      'the warm sandbox deleted',
      async () =>
        (await api.sandboxes.get(dev.root, { tenantId, sandboxId: sandbox.id })).state ===
        'deleted',
    );
  }, 240_000);

  it(`${SANDBOXES} sandboxes with short TTLs expire on their own and leave nothing behind`, async () => {
    const template = await createTemplate('short', { defaultTtlSeconds: 60, maxTtlSeconds: 600 });
    const ids: string[] = [];
    for (let index = 0; index < SANDBOXES; index++) ids.push((await createSandbox(template.id)).id);
    const counts = async () => {
      const { rows } = await dev.database.query<{
        ready: number;
        expired: number;
        deleted: number;
      }>(
        `SELECT count(ready_at)::int AS ready, count(expired_at)::int AS expired,
                count(deleted_at)::int AS deleted FROM sandboxes WHERE id = ANY($1)`,
        [ids],
      );
      return rows[0]!;
    };
    // Every one runs, then expires (the TTL is a minute; the expiry pass runs every 15 s) and is deleted through
    // the instance lifecycle.
    await until('every sandbox ready', async () => (await counts()).ready === SANDBOXES, 240_000);
    await until(
      'every sandbox expired and deleted',
      async () => {
        const now = await counts();
        return now.expired === SANDBOXES && now.deleted === SANDBOXES;
      },
      300_000,
    );
    // sandbox.expired comes before the delete, once each.
    const { rows: events } = await dev.database.query<{ topic: string; count: number }>(
      `SELECT topic, count(DISTINCT payload->>'subject')::int AS count FROM outbox
        WHERE topic IN ('sandbox.expired', 'sandbox.deleted') AND payload->>'subject' = ANY($1)
        GROUP BY topic ORDER BY topic`,
      [ids.map((id) => `sandbox/${id}`)],
    );
    expect(events).toEqual([
      { topic: 'sandbox.deleted', count: SANDBOXES },
      { topic: 'sandbox.expired', count: SANDBOXES },
    ]);
    await until('the hosts to settle', async () => instancesSettled(dev), 120_000);
    // What is left is the warm pool alone, and it leaks nothing.
    const live = await liveInstances(dev);
    expect(live.map((row) => row.id).sort()).toEqual(
      (await warmInstances(warmTemplate.id)).map((row) => row.id).sort(),
    );
    await checkNoLeaks(dev, nodes, orphanLogs);

    // §14: every sandbox's readiness was observed once, by source, and every expiry's lag.
    await collector.refresh();
    expect(registry.value('sandbox_ready_seconds', { source: 'cold' })).toBe(SANDBOXES);
    expect(registry.value('sandbox_ready_seconds', { source: 'warm' })).toBe(1);
    expect(registry.value('sandbox_expiry_lag_seconds')).toBe(SANDBOXES);
    expect(registry.value('sandbox_warm_deficit')).toBe(0);
  }, 900_000);

  it('a memory snapshot round trip restores guest memory into a new sandbox', async () => {
    const template = await createTemplate('snap', { defaultTtlSeconds: 600 });
    const readyView = (sandboxId: string, what: string) =>
      until(
        what,
        async () => {
          const view = await api.sandboxes.get(dev.root, { tenantId, sandboxId });
          return view.state === 'ready' && view.nodeId !== undefined && view;
        },
        90_000,
      );
    const domainOf = (nodeId: string, instanceId: string) =>
      dev.daemons.get(nodeId)!.hypervisor!.domains.get(instanceId)!;
    const source = await createSandbox(template.id);
    const running = await readyView(source.id, 'the source sandbox ready');
    // What the guest has in memory (the fake hypervisor's stand-in).
    domainOf(running.nodeId, source.instanceId).memory = 'guest-heap-at-step-42';

    const snapshot = await api.sandboxes.snapshot(dev.root, {
      tenantId,
      sandboxId: source.id,
      idempotencyKey: 'e2e-snap-1',
    });
    expect(snapshot).toMatchObject({ state: 'pending', includeMemory: true });
    const stored = await until(
      'the snapshot ready',
      async () => {
        const view = await api.sandboxes.get(dev.root, { tenantId, sandboxId: source.id });
        const found = view.snapshots?.find((item: { id: string }) => item.id === snapshot.id);
        return found?.state === 'ready' && found;
      },
      90_000,
    );
    expect(stored.sizeBytes).toBeGreaterThan(0);

    const restored = await createSandbox(template.id, { fromSnapshot: snapshot.id });
    expect(restored).toMatchObject({ fromSnapshot: snapshot.id, warm: false });
    const back = await readyView(restored.id, 'the restored sandbox ready');
    const domain = domainOf(back.nodeId, restored.instanceId);
    expect(domain.memory).toBe('guest-heap-at-step-42');
    expect(domain.restoredFrom).toMatch(/^[0-9a-f]{64}$/);

    // Snapshots hold memory: without keep they go with their sandbox, stored object included.
    for (const sandboxId of [source.id, restored.id])
      await api.sandboxes.delete(dev.root, { tenantId, sandboxId });
    await until(
      'both sandboxes deleted',
      async () => {
        for (const sandboxId of [source.id, restored.id])
          if ((await api.sandboxes.get(dev.root, { tenantId, sandboxId })).state !== 'deleted')
            return false;
        return true;
      },
      90_000,
    );
    await until('the stored snapshot deleted', async () => deletedSnapshots.includes(snapshot.id));
  }, 300_000);

  it('deleting the warm template drains its pool: the hosts end empty', async () => {
    await api.sandboxTemplates.delete(dev.root, { tenantId, templateId: warmTemplate.id });
    await until(
      'every instance deleted',
      async () => (await liveInstances(dev)).length === 0,
      120_000,
    );
    await checkNoLeaks(dev, nodes, orphanLogs);
    for (const nodeId of nodes) {
      const hypervisor = dev.daemons.get(nodeId)!.hypervisor!;
      expect(hypervisor.domains.size + hypervisor.files.size + hypervisor.taps.size).toBe(0);
    }
    const { rows } = await dev.database.query(
      `SELECT 1 FROM node_resources WHERE node_id = ANY($1) AND allocated <> 0`,
      [nodes],
    );
    expect(rows).toEqual([]);
  }, 180_000);
});
