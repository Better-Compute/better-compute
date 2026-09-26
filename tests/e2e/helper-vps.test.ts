import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeTelemetryModule } from '@better-compute/observability';
import { instanceStatusHandler, setIpPool, vps } from '@better-compute/vps';
import {
  DEV_ROOT_TOKEN,
  createDevStack,
  fakeIam,
  helperVpsHost,
  type DevStack,
  type FakeTelemetryExport,
} from '@better-compute/testing';
import { checkNoLeaks, instancesSettled } from './support/vps-leaks.js';

// Sandboxes on VPS hosts whose bcd runs unprivileged under `bcd helper` (PLAN.md §3.8, 7fe74a1), through the whole
// stack: the real server runtime and gateway, and FakeDaemon hosts playing bcd there (`helperVpsHost`: cloud-hypervisor,
// its taps on `[helper] instance_bridges`). The control plane side of a helper-mode host:
// - Hello advertises the runtime, and the gateway labels the node `bc.dev/driver.cloud-hypervisor`;
// - SANDBOXES (12) cold sandboxes run on those hosts, and their live usage (bcd.instance.*) is read on the host and
//   exported to the collector `nodeTelemetryModule` names (never over the Session);
// - deleting them leaves nothing behind (the v0.3 no-leak diff), and the next export has no usage for them.

const SANDBOXES = Number(process.env.E2E_HELPER_SANDBOXES ?? 12);
const OTLP = 'https://otel.e2e.example:4318';
const IMAGE = {
  url: 'https://images.example/ubuntu-24.04.qcow2',
  sha256: 'cd'.repeat(32),
  format: 'qcow2' as const,
  verified: true,
};
const orphanLogs: string[] = [];
/** What the hosts exported, in arrival order (the fake collector). */
const exports: FakeTelemetryExport[] = [];
let dev: DevStack;
let api: any;
let tenantId: string;
let poolId: string;
let nodes: string[];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  what: string,
  probe: () => Promise<T | undefined | false> | T | undefined | false,
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

/** A node's exports from `after` (an index into `exports`) on. */
const exportsOf = (nodeId: string, after = 0) => exports.slice(after).filter((batch) => batch.nodeId === nodeId);
/** The `instance.id` → value points of one series in an export. */
const series = (batch: FakeTelemetryExport, name: string) =>
  new Map(
    (batch.metrics.find((metric) => metric.name === name)?.points ?? []).map((point) => [
      point.attributes['instance.id']!,
      point.value,
    ]),
  );

beforeAll(async () => {
  dev = await createDevStack({
    modules: [
      vps({ images: { resolve: async () => IMAGE }, runtimes: ['cloud-hypervisor'], hostSyncEvery: '1s' }),
      nodeTelemetryModule({ otlpEndpoint: OTLP, intervalSeconds: 5, resourceAttributes: { 'deployment.environment': 'e2e' } }),
    ],
    reports: { status: instanceStatusHandler({ log: (message) => orphanLogs.push(message) }) },
    daemon: { telemetry: { export: (batch) => exports.push(batch) } },
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
    idempotencyKey: 'e2e-helper-site',
  });
  const pool = await api.pools.create(dev.root, {
    tenantId,
    siteId: site.id,
    class: 'vps-host',
    ownerQuota: { vcpu: 100_000, memoryGiB: 1_000_000, diskGiB: 10_000_000 },
    policy: { runtime: 'cloud-hypervisor' },
    idempotencyKey: 'e2e-helper-pool',
  });
  poolId = pool.id;
  await setIpPool(dev.database, { poolId, cidr: '10.24.0.0/22', gateway: '10.24.0.1' });
  await api.flavors.create(dev.root, { tenantId, poolId, name: 'xs', vcpu: 1, memoryGiB: 1, diskGiB: 4 });
  nodes = await dev.join({ poolId, count: 2, seed: 'e2e-helper-vps', daemon: { instances: helperVpsHost() } });
  await dev.waitFor(nodes, { timeoutMs: 45_000 });
}, 120_000);

afterAll(async () => {
  await dev?.close();
});

describe('sandboxes on VPS hosts under bcd helper', () => {
  it('advertise cloud-hypervisor in Hello and export to the configured collector', async () => {
    const { rows } = await dev.database.query<{ node_id: string; value: string }>(
      `SELECT node_id, value FROM node_labels
        WHERE node_id = ANY($1) AND key = 'bc.dev/driver.cloud-hypervisor' AND source = 'system' ORDER BY node_id`,
      [nodes],
    );
    expect(rows.map((row) => row.node_id)).toEqual([...nodes].sort());
    for (const nodeId of nodes) {
      const first = await until(`${nodeId}'s first export`, () => exportsOf(nodeId)[0]);
      expect(first.endpoint).toBe(OTLP);
      expect(first.resource).toMatchObject({
        'service.name': 'bcd',
        'bcd.node.id': nodeId,
        'deployment.environment': 'e2e',
      });
    }
  }, 60_000);

  it(`${SANDBOXES} sandboxes run there, their usage read on the host, and leave nothing behind`, async () => {
    const template = await api.sandboxTemplates.create(dev.root, {
      tenantId,
      name: 'helper',
      poolId,
      flavor: 'xs',
      imageId: 'ubuntu-24.04',
      defaultTtlSeconds: 3600,
    });
    const created: { id: string; instanceId: string }[] = [];
    for (let index = 0; index < SANDBOXES; index++)
      created.push(
        await api.sandboxes.create(dev.root, { tenantId, templateId: template.id, idempotencyKey: `e2e-helper-${index}` }),
      );
    const ready = await until(
      'every sandbox ready',
      async () => {
        const views = await Promise.all(
          created.map((sandbox) => api.sandboxes.get(dev.root, { tenantId, sandboxId: sandbox.id })),
        );
        return views.every((view) => view.state === 'ready' && view.nodeId) && views;
      },
      120_000,
    );
    const onNode = new Map<string, string[]>(nodes.map((nodeId) => [nodeId, []]));
    for (const [index, view] of ready.entries()) {
      expect(nodes).toContain(view.nodeId);
      onNode.get(view.nodeId)!.push(created[index]!.instanceId);
      // Root's ch.taps made its tap on br0 (the helper's instance bridge), and the VMM runs.
      const domain = dev.daemons.get(view.nodeId)!.hypervisor!.domains.get(created[index]!.instanceId)!;
      expect(domain).toMatchObject({ runtime: 'cloud-hypervisor', state: 'running', boots: 1 });
    }

    // The next export of each host carries its sandboxes' live usage, read on that host.
    const mark = exports.length;
    for (const [nodeId, instanceIds] of onNode) {
      const batch = await until(`${nodeId}'s next export`, () => exportsOf(nodeId, mark)[0], 15_000);
      const cpu = series(batch, 'bcd.instance.cpu.time');
      const memory = series(batch, 'bcd.instance.memory.used');
      expect([...cpu.keys()].sort()).toEqual([...instanceIds].sort());
      for (const id of instanceIds) {
        expect(cpu.get(id)).toBe(1); // one boot of the fake guest: a CPU second
        expect(memory.get(id)).toBe(2 ** 29); // half its GiB
      }
      expect(series(batch, 'bcd.instance.vcpu').size).toBe(instanceIds.length);
    }

    // A guest's work shows up in its host's next export, attributed to its instance.
    const busy = ready[0]!;
    const busyInstance = created[0]!.instanceId;
    dev.daemons.get(busy.nodeId)!.hypervisor!.setUsage(busyInstance, {
      cpuSeconds: 321.5,
      netRxBytes: 5_000_000n,
      ioWriteBytes: 1n << 30n,
    });
    const after = exports.length;
    const next = await until('the busy guest in an export', () => exportsOf(busy.nodeId, after)[0], 15_000);
    expect(series(next, 'bcd.instance.cpu.time').get(busyInstance)).toBe(321.5);
    expect(series(next, 'bcd.instance.network.receive').get(busyInstance)).toBe(5_000_000);
    expect(series(next, 'bcd.instance.io.write').get(busyInstance)).toBe(2 ** 30);

    for (const sandbox of created) await api.sandboxes.delete(dev.root, { tenantId, sandboxId: sandbox.id });
    await until(
      'every sandbox deleted',
      async () => {
        const { rows } = await dev.database.query<{ count: number }>(
          `SELECT count(deleted_at)::int AS count FROM sandboxes WHERE id = ANY($1)`,
          [created.map((sandbox) => sandbox.id)],
        );
        return rows[0]!.count === SANDBOXES;
      },
      120_000,
    );
    await until('the hosts to settle', () => instancesSettled(dev), 60_000);
    await checkNoLeaks(dev, nodes, orphanLogs);
    // Gone from the hosts, gone from their exports.
    const end = exports.length;
    for (const nodeId of nodes) {
      const batch = await until(`${nodeId}'s export after the deletes`, () => exportsOf(nodeId, end)[0], 15_000);
      expect(series(batch, 'bcd.instance.cpu.time').size).toBe(0);
    }
  }, 360_000);
});
