import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { instanceStatusHandler, setIpPool, vps } from '@better-compute/vps';
import { createDevStack, type DevStack, type FakeDaemon } from '@better-compute/testing';

// PLAN.md §16 v0.3 exit, tests/e2e/vps.test.ts: hosted VPS through the whole stack — the real server
// runtime (placement, NodeSpec, the Instance reconciler, the secret broker), the real gateway (spec
// push, SecretRequest, StatusReport ingestion) and three FakeDaemon VPS hosts with fake hypervisors.
// - 200-instance churn with no leaks: every domain, overlay, seed and tap on a host belongs to a
//   live instance placed there, and every live allocation, IP lease and scalar claim to one that runs;
// - host loss recreates instances where the pool says so, and the old host drops its stale domains
//   when it comes back;
// - no tenant VM runs bcd: the user data a host fetches carries no join token and no daemon.

const INSTANCES = 200;
const IMAGE = {
  url: 'https://images.example/ubuntu-24.04.qcow2',
  sha256: 'ab'.repeat(32),
  format: 'qcow2' as const,
  verified: true,
};
const orphanLogs: string[] = [];
let dev: DevStack;
let api: any;
let tenantId: string;
let siteId: string;
let poolId: string;
let nodes: string[];

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
    await sleep(100);
  }
}
const daemon = (nodeId: string): FakeDaemon => dev.daemons.get(nodeId)!;

interface LiveRow {
  id: string;
  node_id: string | null;
  state: string;
  desired_state: string;
}
async function live(): Promise<LiveRow[]> {
  const { rows } = await dev.database.query<LiveRow>(
    `SELECT id, node_id, state, desired_state FROM instances
      WHERE NOT draft AND state <> 'deleted' ORDER BY id`,
  );
  return rows;
}

/** Every live instance is where it should be: running or stopped as desired, deletions finished. */
async function settled(): Promise<boolean> {
  const rows = await live();
  return rows.every((row) => row.node_id !== null && row.state === row.desired_state);
}

/** The no-leak diff (v0.3 acceptance): what the hosts hold against what the database says. */
async function checkNoLeaks(): Promise<void> {
  const rows = await live();
  for (const nodeId of nodes) {
    const hypervisor = daemon(nodeId).hypervisor!;
    const expected = Object.fromEntries(
      rows.filter((row) => row.node_id === nodeId).map((row) => [row.id, row.desired_state]),
    );
    const held = Object.fromEntries(
      [...hypervisor.domains.values()].map((domain) => [domain.id, domain.state]),
    );
    expect(held, `domains on ${nodeId}`).toEqual(expected);
    expect(
      [...hypervisor.domains.values()].filter((domain) => !domain.managed),
      'unmanaged domains',
    ).toEqual([]);
    for (const [path, owner] of hypervisor.files)
      expect(hypervisor.domains.has(owner), `file ${path}`).toBe(true);
    for (const [tap, owner] of hypervisor.taps)
      expect(hypervisor.domains.has(owner), `tap ${tap}`).toBe(true);
    // Every domain has its overlay, seed and tap.
    expect(hypervisor.files.size).toBe(hypervisor.domains.size * 2);
    expect(hypervisor.taps.size).toBe(hypervisor.domains.size);
  }
  const placed = rows.map((row) => row.id);
  const allocations = await dev.database.query<{ owner_id: string }>(
    `SELECT owner_id FROM allocations WHERE owner_kind = 'instance' AND released_at IS NULL ORDER BY owner_id`,
  );
  expect(
    allocations.rows.map((row) => row.owner_id),
    'live allocations',
  ).toEqual(placed);
  const leases = await dev.database.query<{ instance_id: string }>(
    `SELECT instance_id FROM ip_leases ORDER BY instance_id`,
  );
  expect(
    leases.rows.map((row) => row.instance_id),
    'IP leases',
  ).toEqual(placed);
  const drift = await dev.database.query(
    `SELECT r.node_id, r.resource FROM node_resources r
       LEFT JOIN allocations a ON a.node_id = r.node_id AND a.released_at IS NULL
      WHERE r.node_id = ANY($1)
      GROUP BY r.node_id, r.resource, r.allocated
     HAVING r.allocated <> COALESCE(sum((a.resources->>r.resource)::bigint), 0)`,
    [nodes],
  );
  expect(drift.rows, 'scalar drift').toEqual([]);
  expect(orphanLogs, 'orphans reported by the status handler').toEqual([]);
}

let keys = 0;
const createInstance = (extra: Record<string, unknown> = {}) =>
  api.instances.create(dev.root, {
    tenantId,
    poolId,
    flavor: 's',
    imageId: 'ubuntu-24.04',
    sshKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE2e alice@laptop'],
    idempotencyKey: `e2e-${++keys}`,
    ...extra,
  });

beforeAll(async () => {
  dev = await createDevStack({
    modules: [
      vps({
        images: { resolve: async () => IMAGE },
        runtimes: ['libvirt-kvm', 'containerd'],
        hostSyncEvery: '1s',
      }),
    ],
    reports: { status: instanceStatusHandler({ log: (message) => orphanLogs.push(message) }) },
    daemon: { instances: { runtimes: ['libvirt-kvm'] } },
  });
  api = dev.compute.api;
  tenantId = dev.rootTenantId;
  const site = await api.sites.create(dev.root, {
    tenantId,
    kind: 'shared',
    region: 'dev-1',
    idempotencyKey: 'e2e-vps-site',
  });
  siteId = site.id;
  const pool = await api.pools.create(dev.root, {
    tenantId,
    siteId,
    class: 'vps-host',
    ownerQuota: { vcpu: 10_000, memoryGiB: 100_000, diskGiB: 1_000_000 },
    policy: { recreateOnHostLoss: true },
    idempotencyKey: 'e2e-vps-pool',
  });
  poolId = pool.id;
  await setIpPool(dev.database, { poolId, cidr: '10.8.0.0/22', gateway: '10.8.0.1' });
  for (const [name, vcpu, memoryGiB, diskGiB] of [
    ['s', 2, 4, 40],
    ['m', 4, 16, 80],
  ] as const)
    await api.flavors.create(dev.root, { tenantId, poolId, name, vcpu, memoryGiB, diskGiB });
  nodes = await dev.join({ poolId, count: 3, seed: 'e2e-vps' });
  await dev.waitFor(nodes, { timeoutMs: 45_000 });
  // vps.hosts derives each host's vCPU, memory and disk from its inventory.
  await until('host capacity', async () => {
    const { rows } = await dev.database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM node_resources WHERE node_id = ANY($1)`,
      [nodes],
    );
    return rows[0]!.count === 9;
  });
}, 120_000);

afterAll(async () => {
  await dev?.close();
});

describe('hosted VPS end to end (§16 v0.3)', () => {
  it('boots an instance with its user data fetched through the broker, never a join token', async () => {
    const instance = await createInstance();
    expect(instance.nodeId).toBeDefined();
    await until('first instance running', async () => {
      const row = (await live()).find((candidate) => candidate.id === instance.id);
      return row?.state === 'running';
    });
    const domain = daemon(instance.nodeId).hypervisor!.domains.get(instance.id)!;
    expect(domain).toMatchObject({ managed: true, state: 'running', runtime: 'libvirt-kvm' });
    expect(domain.userData).toMatch(/^#cloud-config\n/);
    expect(domain.userData).toContain('alice@laptop');
    // No tenant VM runs bcd (§13): no join token, no daemon, no IAM key in what the guest boots.
    expect(domain.userData).not.toMatch(/bcjt_|biam_|\bbcd\b|join-encryption/);
    expect(domain.addresses).toEqual([expect.stringMatching(/^10\.8\.[0-3]\.\d+\/22$/)]);
    expect(domain.macs).toEqual([expect.stringMatching(/^02(:[0-9a-f]{2}){5}$/)]);
    // The spec named only the ref; the value came as a JWE to the host's one-time key.
    const { rows } = await dev.database.query<{ user_data: string }>(
      `SELECT user_data FROM instances WHERE id = $1`,
      [instance.id],
    );
    expect(rows[0]!.user_data).toMatch(/^secret:\/\//);
    const sent = daemon(instance.nodeId).spec?.instances?.instances ?? [];
    expect(sent.find((spec) => spec.instanceId === instance.id)?.userDataRef).toBe(
      rows[0]!.user_data,
    );
    expect(
      JSON.stringify(sent, (_key, value) => (typeof value === 'bigint' ? String(value) : value)),
    ).not.toContain('alice@laptop');
    await api.instances.delete(dev.root, { tenantId, instanceId: instance.id });
    await until('first instance deleted', async () => !(await live()).length);
  }, 60_000);

  it(`churns ${INSTANCES} instances on 3 hosts without leaking anything`, async () => {
    let seed = 0x5eed;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alive: string[] = [];
    let created = 0;
    let deleted = 0;
    while (created < INSTANCES) {
      const roll = random();
      if (roll < 0.6 || alive.length < 5) {
        const instance = await createInstance({ flavor: random() < 0.7 ? 's' : 'm' });
        created++;
        alive.push(instance.id);
      } else if (roll < 0.85) {
        const [id] = alive.splice(Math.floor(random() * alive.length), 1);
        await api.instances.delete(dev.root, { tenantId, instanceId: id });
        deleted++;
      } else {
        const id = alive[Math.floor(random() * alive.length)]!;
        await api.instances[random() < 0.5 ? 'stop' : 'start'](dev.root, {
          tenantId,
          instanceId: id,
        }).catch(() => undefined);
      }
    }
    expect(deleted).toBeGreaterThan(40);
    await until('the churn to settle', settled, 180_000);
    const rows = await live();
    expect(rows.length).toBe(alive.length);
    expect(new Set(rows.map((row) => row.node_id)).size).toBe(3);
    expect(rows.some((row) => row.state === 'stopped')).toBe(true);
    await checkNoLeaks();
  }, 300_000);

  it('recreates instances of a lost host elsewhere, and the host drops them when it returns', async () => {
    const before = await live();
    const victim = nodes[0]!;
    const onVictim = before.filter((row) => row.node_id === victim).map((row) => row.id);
    expect(onVictim.length).toBeGreaterThan(0);
    // The host dies; Liveness then declares it lost (its own timing is covered by its suites).
    daemon(victim).crash('host power loss');
    await dev.database.query(`UPDATE nodes SET connectivity = 'lost' WHERE id = $1`, [victim]);
    await until(
      'instances recreated on the other hosts',
      async () => {
        const rows = await live();
        return onVictim.every((id) => {
          const row = rows.find((candidate) => candidate.id === id);
          return (
            row && row.node_id !== victim && row.node_id !== null && row.state === row.desired_state
          );
        });
      },
      120_000,
    );
    // The host comes back: its spec no longer names them, so bcd removes the stale domains.
    await dev.database.query(`UPDATE nodes SET connectivity = 'connected' WHERE id = $1`, [victim]);
    daemon(victim).restart();
    await until('the returning host to drop its stale domains', async () => {
      const held = [...daemon(victim).hypervisor!.domains.keys()];
      return held.every((id) => !onVictim.includes(id));
    });
    await until('the fleet to settle', settled, 60_000);
    await checkNoLeaks();
  }, 240_000);

  it('rejects multi-tenant container offers (§13: containers run only in single-tenant pools)', async () => {
    const containers = await api.pools.create(dev.root, {
      tenantId,
      siteId,
      class: 'vps-host',
      policy: { runtime: 'containerd', singleTenant: true },
      idempotencyKey: 'e2e-containers',
    });
    const quota = { vcpu: 8, memoryGiB: 32, diskGiB: 200 };
    await api.pools.offer(dev.root, {
      tenantId,
      poolId: containers.id,
      toTenantId: 'tenant-a',
      quota,
    });
    await expect(
      api.pools.offer(dev.root, { tenantId, poolId: containers.id, toTenantId: 'tenant-b', quota }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(
      api.pools.offer(dev.root, {
        tenantId,
        poolId: containers.id,
        toTenantId: 'tenant-a',
        quota,
        includeDescendants: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    // A container pool that is not single-tenant runs nothing.
    const shared = await api.pools.create(dev.root, {
      tenantId,
      siteId,
      class: 'vps-host',
      policy: { runtime: 'containerd' },
      ownerQuota: quota,
      idempotencyKey: 'e2e-containers-shared',
    });
    await api.flavors.create(dev.root, {
      tenantId,
      poolId: shared.id,
      name: 's',
      vcpu: 1,
      memoryGiB: 1,
      diskGiB: 10,
    });
    await expect(createInstance({ poolId: shared.id })).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
  });

  it('deletes everything and leaves nothing behind', async () => {
    for (const row of await live())
      await api.instances.delete(dev.root, { tenantId, instanceId: row.id });
    await until('every instance deleted', async () => (await live()).length === 0, 120_000);
    await checkNoLeaks();
    for (const nodeId of nodes) {
      const hypervisor = daemon(nodeId).hypervisor!;
      expect(hypervisor.domains.size + hypervisor.files.size + hypervisor.taps.size).toBe(0);
    }
    const { rows } = await dev.database.query(
      `SELECT 1 FROM node_resources WHERE node_id = ANY($1) AND allocated <> 0`,
      [nodes],
    );
    expect(rows).toEqual([]);
  }, 180_000);
});
