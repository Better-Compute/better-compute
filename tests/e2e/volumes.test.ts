import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { instanceStatusHandler, setIpPool, volumeHeadroomGiB, vps } from '@better-compute/vps';
import {
  DEV_ROOT_TOKEN,
  createDevStack,
  fakeIam,
  type DevStack,
  type FakeHypervisor,
} from '@better-compute/testing';
import { checkNoLeaks, instancesSettled } from './support/vps-leaks.js';

// Agent memory at scale (PLAN.md §3.8 v1.1, extending the §16 v0.5 zero-leak acceptance to volumes), through the
// whole stack: the real server runtime, the real gateway and three FakeDaemon VPS hosts whose fake hypervisors keep
// host volumes (InstancesSection.volumes) on a small volume store they report (StatusReport.volume_storage).
// SANDBOXES sandboxes are created from templates that mount volumes (read-write, and shared read-only) and churned:
// deleted, expiring, their hosts rebooting, their volumes growing and being deleted in between.
// Invariants, checked mid-churn and at the end:
// - the v0.3 no-leak diff (domains, overlays, taps, IP leases, bookings), and no host volume the database does not
//   have (or the other way round), at the size it says;
// - a read-write volume never has two live writers, on the host or in volume_attachments;
// - no host's volume store is overbooked, even after concurrent creates (headroom never below zero);
// - a sandbox always runs on its volumes' host;
// - data survives: what a guest wrote on a volume is there for the next sandbox that attaches it, across reboots.

// 40 in the default suite (about a minute); the nightly's guarded job runs 240.
const SANDBOXES = Number(process.env.E2E_VOLUME_SANDBOXES ?? 40);
const VOLUMES = 12;
const GiB = 2n ** 30n;
const STORE = { totalBytes: 150n * GiB, reservedBytes: 10n * GiB };
const IMAGE = {
  url: 'https://images.example/ubuntu-24.04.qcow2',
  sha256: 'cd'.repeat(32),
  format: 'qcow2' as const,
  verified: true,
};
const orphanLogs: string[] = [];
let dev: DevStack;
let api: any;
let tenantId: string;
let poolId: string;
let nodes: string[];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hypervisor = (node: string): FakeHypervisor => dev.daemons.get(node)!.hypervisor!;
const code = (error: unknown) => (error as { code?: string }).code;

beforeAll(async () => {
  dev = await createDevStack({
    modules: [
      vps({
        images: { resolve: async () => IMAGE },
        runtimes: ['cloud-hypervisor'],
        hostSyncEvery: '1s',
      }),
    ],
    reports: { status: instanceStatusHandler({ log: (message) => orphanLogs.push(message) }) },
    daemon: { instances: { runtimes: ['cloud-hypervisor'], volumeStore: STORE } },
    iam: {
      port: fakeIam({
        callers: {
          [DEV_ROOT_TOKEN]: {
            identityId: 'identity-dev-root',
            identityKind: 'user',
            tenantId: 'tenant-root',
            sessionId: 'session-dev-root',
            sessionKind: 'user',
            mfa: true,
          },
        },
        allow: [{}],
      }),
      rootTenantId: 'tenant-root',
      root: { token: DEV_ROOT_TOKEN },
    },
  });
  api = dev.compute.api;
  tenantId = dev.rootTenantId;
  const site = await api.sites.create(dev.root, {
    tenantId,
    kind: 'shared',
    region: 'dev-1',
    idempotencyKey: 'e2e-vol-site',
  });
  const pool = await api.pools.create(dev.root, {
    tenantId,
    siteId: site.id,
    class: 'vps-host',
    ownerQuota: { vcpu: 100_000, memoryGiB: 1_000_000, diskGiB: 10_000_000 },
    policy: { runtime: 'cloud-hypervisor' },
    idempotencyKey: 'e2e-vol-pool',
  });
  poolId = pool.id;
  await setIpPool(dev.database, { poolId, cidr: '10.24.0.0/21', gateway: '10.24.0.1' });
  await api.flavors.create(dev.root, {
    tenantId,
    poolId,
    name: 'xs',
    vcpu: 1,
    memoryGiB: 1,
    diskGiB: 4,
  });
  nodes = await dev.join({ poolId, count: 3, seed: 'e2e-volumes' });
  await dev.waitFor(nodes, { timeoutMs: 45_000 });
  // Bookable, and each host has reported its volume store and its volumes capability.
  await until('hosts ready for volumes', async () => {
    const { rows } = await dev.database.query<{
      resources: number;
      stores: number;
      capable: number;
    }>(
      `SELECT (SELECT count(*)::int FROM node_resources WHERE node_id = ANY($1)) AS resources,
              (SELECT count(*)::int FROM host_volume_storage WHERE node_id = ANY($1)) AS stores,
              (SELECT count(*)::int FROM node_labels WHERE node_id = ANY($1) AND key = 'bc.dev/cap.instance.volumes' AND source = 'system') AS capable`,
      [nodes],
    );
    return rows[0]!.resources === 9 && rows[0]!.stores === 3 && rows[0]!.capable === 3;
  });
}, 120_000);
afterAll(async () => {
  await dev?.close();
});

interface VolumeRow {
  id: string;
  node_id: string;
  size_gib: number;
  state: string;
}
const volumeRows = async () =>
  (
    await dev.database.query<VolumeRow>(
      `SELECT id, node_id, size_gib::int AS size_gib, state FROM sandbox_volumes WHERE state <> 'deleted' ORDER BY id`,
    )
  ).rows;

/** Everything converged: instances in their desired state and placed, no volume still being deleted. */
async function settle(what: string): Promise<void> {
  await until(
    what,
    async () => {
      if (!(await instancesSettled(dev))) return false;
      const pending = await dev.database.query(
        `SELECT 1 FROM sandbox_volumes WHERE state = 'deleting'
         UNION ALL SELECT 1 FROM sandboxes WHERE deleted_at IS NULL AND deleting_at IS NOT NULL LIMIT 1`,
      );
      if (pending.rowCount) return false;
      // Every host holds exactly the ready volumes the database places on it (bcd converged its spec).
      const rows = await volumeRows();
      return nodes.every((node) => {
        const held = [...hypervisor(node).volumes.keys()].sort();
        return (
          JSON.stringify(held) ===
          JSON.stringify(rows.filter((row) => row.node_id === node).map((row) => row.id))
        );
      });
    },
    180_000,
  );
}

/** Last marker written on each volume (what its next reader must find). */
const expected = new Map<string, string>();

async function checkInvariants(stage: string): Promise<void> {
  await checkNoLeaks(dev, nodes, orphanLogs);
  const rows = await volumeRows();
  expect(
    rows.filter((row) => row.state !== 'ready'),
    `${stage}: volumes not ready`,
  ).toEqual([]);
  // Host volumes ⇔ sandbox_volumes, at the booked size.
  for (const node of nodes) {
    const held = Object.fromEntries(
      [...hypervisor(node).volumes.values()].map((v) => [v.id, Number(v.sizeBytes / GiB)]),
    );
    const booked = Object.fromEntries(
      rows.filter((row) => row.node_id === node).map((row) => [row.id, row.size_gib]),
    );
    expect(held, `${stage}: volumes on ${node}`).toEqual(booked);
  }
  // One writer: on the hosts (what is really open) and in the database (live attachments).
  for (const row of rows) {
    const open = nodes.flatMap((node) =>
      hypervisor(node)
        .openBy(row.id)
        .map((o) => ({ ...o, node })),
    );
    expect(
      open.every((o) => o.node === row.node_id),
      `${stage}: ${row.id} open off its host`,
    ).toBe(true);
    const writers = open.filter((o) => !o.readOnly);
    expect(
      writers.length <= 1 && (writers.length === 0 || open.length === 1),
      `${stage}: writers of ${row.id}: ${JSON.stringify(open)}`,
    ).toBe(true);
  }
  const attachments = await dev.database.query<{
    volume_id: string;
    writers: number;
    readers: number;
  }>(
    `SELECT va.volume_id, count(*) FILTER (WHERE NOT va.read_only)::int AS writers, count(*) FILTER (WHERE va.read_only)::int AS readers
       FROM volume_attachments va JOIN instances i ON i.id = va.instance_id WHERE i.state <> 'deleted' GROUP BY va.volume_id`,
  );
  for (const row of attachments.rows)
    expect(
      row.writers <= 1 && (row.writers === 0 || row.readers === 0),
      `${stage}: attachments of ${row.volume_id}`,
    ).toBe(true);
  // A sandbox runs on its volumes' host, and has them open as attached.
  const placed = await dev.database.query<{
    instance_id: string;
    instance_node: string;
    volume_node: string;
    volume_id: string;
    read_only: boolean;
    state: string;
  }>(
    `SELECT va.instance_id, i.node_id AS instance_node, v.node_id AS volume_node, va.volume_id, va.read_only, i.state
       FROM volume_attachments va JOIN instances i ON i.id = va.instance_id JOIN sandbox_volumes v ON v.id = va.volume_id
      WHERE i.state <> 'deleted'`,
  );
  for (const row of placed.rows) {
    expect(row.instance_node, `${stage}: ${row.instance_id} off its volume's host`).toBe(
      row.volume_node,
    );
    if (row.state === 'running')
      expect(hypervisor(row.instance_node).domains.get(row.instance_id)?.volumes).toContainEqual({
        volumeId: row.volume_id,
        readOnly: row.read_only,
      });
  }
  // No volume store is overbooked: the control plane's headroom (bcd's rule) is never below zero.
  for (const [node, free] of await volumeHeadroomGiB(dev.database as never, nodes))
    expect(free, `${stage}: headroom of ${node}`).toBeGreaterThanOrEqual(0);
  for (const node of nodes) {
    const storage = hypervisor(node).volumeStorage()!;
    expect(
      storage.committedBytes + storage.reservedBytes <= storage.totalBytes,
      `${stage}: ${node}'s store`,
    ).toBe(true);
  }
  // Data survives on the host.
  for (const row of rows)
    if (expected.has(row.id))
      expect(hypervisor(row.node_id).volumeContent(row.id), `${stage}: data of ${row.id}`).toBe(
        expected.get(row.id),
      );
}

describe('agent memory at scale (§3.8 v1.1, the v0.5 zero-leak shape with volumes)', () => {
  it(`${SANDBOXES} sandboxes churn over volumes without leaks, double writers, overbooking or lost data`, async () => {
    const random = prng(0x70f);
    // Concurrent creates: a dozen volumes at once, then more than the stores can take.
    const created = await Promise.all(
      Array.from({ length: VOLUMES }, (_, i) =>
        api.sandboxVolumes.create(dev.root, {
          tenantId,
          poolId,
          name: `mem-${i}`,
          sizeGiB: 8 + (i % 5) * 2,
          idempotencyKey: `e2e-vol-${i}`,
        }),
      ),
    );
    expect(new Set(created.map((v: { nodeId: string }) => v.nodeId)).size).toBe(3);
    const overAsk = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        api.sandboxVolumes.create(dev.root, {
          tenantId,
          poolId,
          name: `big-${i}`,
          sizeGiB: 40,
          idempotencyKey: `e2e-big-${i}`,
        }),
      ),
    );
    expect(
      overAsk.some((r) => r.status === 'rejected' && code(r.reason) === 'CAPACITY_UNAVAILABLE'),
      'the stores ran out',
    ).toBe(true);
    const volumes: { id: string; name: string; alive: boolean }[] = [
      ...created.map((v: { id: string; name: string }) => ({
        id: v.id,
        name: v.name,
        alive: true,
      })),
      ...overAsk.flatMap((r) =>
        r.status === 'fulfilled' ? [{ id: r.value.id, name: r.value.name, alive: true }] : [],
      ),
    ];
    for (const [node, free] of await volumeHeadroomGiB(dev.database as never, nodes))
      expect(free, `headroom of ${node}`).toBeGreaterThanOrEqual(0);
    await settle('volumes on their hosts');

    // Templates: each volume read-write; the first four also shared read-only.
    const templates: { id: string; volumeId: string; readOnly: boolean; alive: boolean }[] = [];
    for (const [i, volume] of volumes.entries()) {
      const rw = await api.sandboxTemplates.create(dev.root, {
        tenantId,
        name: `rw-${i}`,
        poolId,
        flavor: 'xs',
        imageId: 'ubuntu-24.04',
        defaultTtlSeconds: 600,
        maxTtlSeconds: 3600,
        volumes: [{ volumeId: volume.id, mountPath: '/workspace' }],
      });
      templates.push({ id: rw.id, volumeId: volume.id, readOnly: false, alive: true });
      if (i < 4) {
        const ro = await api.sandboxTemplates.create(dev.root, {
          tenantId,
          name: `ro-${i}`,
          poolId,
          flavor: 'xs',
          imageId: 'ubuntu-24.04',
          defaultTtlSeconds: 600,
          maxTtlSeconds: 3600,
          volumes: [{ volumeId: volume.id, mountPath: '/data', readOnly: true }],
        });
        templates.push({ id: ro.id, volumeId: volume.id, readOnly: true, alive: true });
      }
    }

    const live: { id: string; template: (typeof templates)[number] }[] = [];
    let sandboxes = 0;
    let conflicts = 0;
    let writes = 0;
    let grows = 0;
    let reboots = 0;
    let retired = 0;
    let key = 0;
    const createFrom = async (template: (typeof templates)[number], ttlSeconds?: number) => {
      try {
        const sandbox = await api.sandboxes.create(dev.root, {
          tenantId,
          templateId: template.id,
          idempotencyKey: `e2e-vsbx-${++key}`,
          ...(ttlSeconds ? { ttlSeconds } : {}),
        });
        sandboxes++;
        live.push({ id: sandbox.id, template });
        return sandbox;
      } catch (error) {
        // One writer, or readers beside a writer: refused at admission, never double-attached.
        if (code(error) === 'CONFLICT') {
          conflicts++;
          return undefined;
        }
        throw error;
      }
    };
    const removeSandbox = async (index: number) => {
      const [entry] = live.splice(index, 1);
      await api.sandboxes
        .delete(dev.root, { tenantId, sandboxId: entry!.id })
        .catch((error: unknown) => {
          if (code(error) !== 'NOT_FOUND') throw error;
        });
    };

    // Reboots and volume retirements at fixed points of the churn; the rest at random.
    const due = (count: number, fractions: readonly number[]) =>
      count < fractions.length && sandboxes >= SANDBOXES * fractions[count]!;
    for (let step = 0; sandboxes < SANDBOXES; step++) {
      const roll = due(reboots, [0.3, 0.6]) ? 0.97 : due(retired, [0.45, 0.75]) ? 0.99 : random();
      const aliveTemplates = templates.filter((t) => t.alive);
      if (roll < 0.5 || live.length < 4) {
        // Some expire on their own (60 s), the rest are deleted.
        await createFrom(
          aliveTemplates[Math.floor(random() * aliveTemplates.length)]!,
          random() < 0.15 ? 60 : undefined,
        );
      } else if (roll < 0.8 && live.length) {
        await removeSandbox(Math.floor(random() * live.length));
      } else if (roll < 0.92) {
        // A running read-write sandbox writes its marker.
        const writers = live.filter((entry) => !entry.template.readOnly);
        const entry = writers[Math.floor(random() * writers.length)];
        if (entry) {
          const view = await api.sandboxes.get(dev.root, { tenantId, sandboxId: entry.id });
          const domain = view.nodeId
            ? hypervisor(view.nodeId).domains.get(view.instanceId)
            : undefined;
          if (view.state === 'ready' && domain?.state === 'running') {
            const marker = `${entry.template.volumeId}#${++writes}`;
            hypervisor(view.nodeId).writeVolume(
              view.instanceId,
              entry.template.volumeId,
              marker,
              256n << 20n,
            );
            expected.set(entry.template.volumeId, marker);
          }
        }
      } else if (roll < 0.96 || (roll < 0.98 && reboots >= 2) || (roll >= 0.98 && retired >= 2)) {
        const volume = volumes.filter((v) => v.alive)[
          Math.floor(random() * volumes.filter((v) => v.alive).length)
        ];
        if (volume) {
          const current = await api.sandboxVolumes.get(dev.root, { tenantId, volumeId: volume.id });
          await api.sandboxVolumes
            .resize(dev.root, { tenantId, volumeId: volume.id, sizeGiB: current.sizeGiB + 2 })
            .then(() => grows++)
            .catch((error: unknown) => {
              if (!['CAPACITY_UNAVAILABLE', 'CONFLICT'].includes(code(error) ?? '')) throw error;
            });
        }
      } else if (roll < 0.98) {
        // A host loses power and comes back: its domains stop, its volumes and their data stay.
        dev.daemons.get(nodes[reboots % nodes.length]!)!.reboot({ durationMs: 500 });
        reboots++;
      } else {
        // A volume is retired: its sandboxes go, then its templates, then the volume itself.
        const volume = volumes.find(
          (v) => v.alive && !templates.some((t) => t.volumeId === v.id && t.readOnly),
        );
        if (volume) {
          for (let i = live.length - 1; i >= 0; i--)
            if (live[i]!.template.volumeId === volume.id) await removeSandbox(i);
          for (const template of templates.filter((t) => t.volumeId === volume.id && t.alive)) {
            await api.sandboxTemplates.delete(dev.root, { tenantId, templateId: template.id });
            template.alive = false;
          }
          await until(`volume ${volume.id} deletable`, async () =>
            api.sandboxVolumes.delete(dev.root, { tenantId, volumeId: volume.id }).then(
              () => true,
              (error: unknown) => {
                if (code(error) !== 'CONFLICT') throw error;
                return false;
              },
            ),
          );
          volume.alive = false;
          expected.delete(volume.id);
          retired++;
        }
      }
      if (step % 25 === 24) {
        await settle(`mid-churn step ${step}`);
        await checkInvariants(`step ${step}`);
      }
    }
    await settle('the end of the churn');
    await checkInvariants('after the churn');
    expect(conflicts, 'writers refused beside another').toBeGreaterThan(0);
    expect(writes).toBeGreaterThan(5);
    expect(reboots).toBe(2);
    expect(retired).toBe(2);
    expect(grows).toBeGreaterThan(0);

    // Data survives: a new sandbox of a volume's template finds what the last writer wrote.
    for (const [volumeId, marker] of [...expected].slice(0, 3)) {
      for (let i = live.length - 1; i >= 0; i--)
        if (live[i]!.template.volumeId === volumeId) await removeSandbox(i);
      await settle(`${volumeId} free`);
      const template = templates.find((t) => t.volumeId === volumeId && !t.readOnly && t.alive)!;
      const sandbox = await until(`a new writer of ${volumeId}`, async () => createFrom(template));
      const view = await until(`${sandbox.id} ready`, async () => {
        const v = await api.sandboxes.get(dev.root, { tenantId, sandboxId: sandbox.id });
        return v.state === 'ready' && v.nodeId && v;
      });
      expect(hypervisor(view.nodeId).domains.get(view.instanceId)!.volumes).toContainEqual({
        volumeId,
        readOnly: false,
      });
      expect(
        hypervisor(view.nodeId).volumeContent(volumeId),
        `${volumeId} after reboots and new sandboxes`,
      ).toBe(marker);
    }

    // Everything goes: sandboxes, templates, volumes. Nothing is left on the hosts or booked.
    while (live.length) await removeSandbox(live.length - 1);
    for (const template of templates.filter((t) => t.alive))
      await api.sandboxTemplates.delete(dev.root, { tenantId, templateId: template.id });
    for (const volume of volumes.filter((v) => v.alive))
      await until(`volume ${volume.id} deleted`, async () =>
        api.sandboxVolumes.delete(dev.root, { tenantId, volumeId: volume.id }).then(
          () => true,
          (error: unknown) => {
            if (code(error) !== 'CONFLICT') throw error;
            return false;
          },
        ),
      );
    expected.clear();
    await settle('everything deleted');
    await checkInvariants('after everything was deleted');
    for (const node of nodes)
      expect(hypervisor(node).volumes.size, `volumes left on ${node}`).toBe(0);
    const booked = await dev.database.query(
      `SELECT 1 FROM allocations WHERE owner_kind = 'volume' AND released_at IS NULL`,
    );
    expect(booked.rowCount, 'live volume bookings').toBe(0);
  }, 1_200_000);
});
