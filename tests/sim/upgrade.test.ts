import { afterEach, describe, expect, it } from 'vitest';
import { manualClock } from '@better-compute/core';
import { buildReleaseManifest, createReleaseSigningKey, releaseArtifact, signReleaseManifest, spkiPin } from '@better-compute/pki';
import { rolloutModule } from '@better-compute/rollout';
import { createQuorumModule } from '@better-compute/server';
import {
  allocationStates,
  assertInvariants,
  createControlPlaneSim,
  disturbances,
  rollGateways,
  upgradeInPlace,
  type ControlPlaneSim,
} from '@better-compute/testing';
import { instanceStatusHandler, setIpPool, vps } from '@better-compute/vps';

// PLAN.md §16 v1.0: "upgrading from v0.5 disturbs no running allocation". The real control plane and
// three gateways under the fleet simulator, with tenants' reservations running and operators' commands
// flowing and VMs (two instances, one sandbox) on two VPS hosts, upgrade in the §7.6 order: expand
// migrations → workers/api → gateways (one at a time) → daemons (a signed Rollout, canary then all).
// No allocation is released, moved or rebound, every reservation stays active, no VM reboots or moves,
// the sandbox keeps its expiry, usage stays continuous (the hour that spans the upgrade bills exactly
// the booked GPU time), and I1/I2/I5/I8 hold.

const MIN = 60_000;
const HOUR = 60 * MIN;
const IMAGE = { url: 'https://images.example/ubuntu-24.04.qcow2', sha256: 'ab'.repeat(32), format: 'qcow2' as const, verified: true };

let rig: ControlPlaneSim | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

describe('v1.0 upgrade in place', () => {
  it('disturbs no running allocation: migrations, workers, gateways, then daemons', { timeout: 900_000 }, async () => {
    const key = createReleaseSigningKey();
    const start = Date.UTC(2026, 0, 1);
    rig = await createControlPlaneSim({
      seed: 'v10-upgrade',
      start,
      nodes: 6,
      gateways: 3,
      daemon: { selfUpdate: {} },
      modules: [
        rolloutModule({
          release: { pins: [spkiPin(key.publicKey)] },
          downloadsUrl: 'https://compute.sim.test/api/compute/downloads',
          every: '10s',
        }),
        vps({ images: { resolve: async () => IMAGE }, hostSyncEvery: '10s' }),
      ],
      statusHandlers: [instanceStatusHandler({ log: () => {} })],
      // Two VPS hosts beside the GPU pool: instances and a sandbox run through the upgrade too.
      extraPools: [
        {
          class: 'vps-host',
          count: 2,
          daemon: { instances: { runtimes: ['libvirt-kvm'] } },
          create: { ownerQuota: { vcpu: 1_000, memoryGiB: 10_000, diskGiB: 100_000 } },
          async setup({ poolId, compute, database, root, rootTenantId }) {
            await setIpPool(database, { poolId, cidr: '10.9.0.0/24', gateway: '10.9.0.1' });
            await (compute.api as any).flavors.create(root, { tenantId: rootTenantId, poolId, name: 's', vcpu: 2, memoryGiB: 4, diskGiB: 40 });
          },
        },
      ],
    });
    const sim = rig;
    await sim.run(3 * MIN);
    const root = { token: sim.tenants.root.token };
    const acme = { token: sim.tenants.acme.token };
    const vpsPool = sim.pools[0]!.poolId;
    const vpsApi = sim.compute.api as any;

    // Instances and a sandbox on the VPS hosts, running before the upgrade starts.
    const instances: string[] = [];
    for (let index = 0; index < 2; index++)
      instances.push(
        (
          await sim.api(() =>
            vpsApi.instances.create(root, {
              tenantId: sim.tenants.root.id,
              poolId: vpsPool,
              flavor: 's',
              imageId: 'ubuntu-24.04',
              idempotencyKey: `upgrade-vm-${index}`,
            }),
          )
        ).id,
      );
    const template = await sim.api(() =>
      vpsApi.sandboxTemplates.create(root, { tenantId: sim.tenants.root.id, name: 'ci', poolId: vpsPool, flavor: 's', imageId: 'ubuntu-24.04' }),
    );
    const sandbox = await sim.api(() =>
      vpsApi.sandboxes.create(root, { tenantId: sim.tenants.root.id, templateId: template.id, ttlSeconds: 2 * 3600, idempotencyKey: 'upgrade-sbx' }),
    );
    const vms = async () =>
      (
        await sim.database.query<{ id: string; state: string; node_id: string | null }>(
          'SELECT id, state, node_id FROM instances WHERE id = ANY($1::text[]) ORDER BY id',
          [[...instances, sandbox.instanceId]],
        )
      ).rows;
    for (let waited = 0; waited < 5 * MIN && !(await vms()).every((vm) => vm.state === 'running'); waited += 5_000) await sim.run(5_000);
    expect((await vms()).map((vm) => vm.state)).toEqual([...instances, sandbox.instanceId].map(() => 'running'));
    const boots = async () =>
      Object.fromEntries(
        (await vms()).map((vm) => [vm.id, { node: vm.node_id, boots: sim.sim.daemon(vm.node_id!).hypervisor!.domains.get(vm.id)?.boots }]),
      );
    const bootsBefore = await boots();
    const sandboxBefore = await sim.api(() => vpsApi.sandboxes.get(root, { tenantId: sim.tenants.root.id, sandboxId: sandbox.id }));

    // Tenants' work: six half-node reservations for two hours, all active before the upgrade starts.
    const reservations: string[] = [];
    for (let index = 0; index < 6; index++)
      reservations.push(
        (
          await sim.api(() =>
            sim.compute.api.reservations.create(acme, {
              tenantId: sim.tenants.acme.id,
              poolId: sim.poolId,
              devices: [{ class: 'gpu', count: 4 }],
              duration: '2h',
              idempotencyKey: `upgrade-${index}`,
            } as never),
          )
        ).id,
      );
    const states = async () =>
      (await sim.database.query<{ state: string }>('SELECT state FROM reservations WHERE id = ANY($1::text[]) ORDER BY id', [reservations])).rows.map(
        (row) => row.state,
      );
    for (let waited = 0; waited < 3 * MIN && !(await states()).every((state) => state === 'active'); waited += 5_000) await sim.run(5_000);
    expect(await states()).toEqual(reservations.map(() => 'active'));

    // Operators' work keeps flowing through every step.
    const commands: string[] = [];
    const stop = sim.sim.every(45_000, async () => {
      const nodeId = sim.nodes[commands.length % sim.nodes.length]!.nodeId;
      try {
        const command = await sim.api(() =>
          sim.compute.api.commands.run(root, {
            tenantId: sim.tenants.root.id,
            nodeId,
            kind: 'inventory.refresh',
            payload: { sections: ['gpus'] },
            idempotencyKey: `upgrade-cmd-${commands.length}`,
          } as never),
        );
        commands.push(command.id);
      } catch {
        // The api is down while the workers restart; the operator retries later.
      }
    });

    const api = sim.compute.api as unknown as Record<string, Record<string, (credential: unknown, input: unknown) => Promise<Record<string, unknown>>>>;
    const report = await upgradeInPlace(sim, {
      // The new release's expand migration: additive, applied under load.
      migrations: [{ name: 'upgrade/0001_expand', sql: 'ALTER TABLE reservations ADD COLUMN upgrade_note text' }],
      async rollDaemons(target) {
        const manifest = signReleaseManifest(
          buildReleaseManifest({
            product: 'bcd',
            version: '0.6.0',
            sequence: 1,
            signers: [key],
            clock: manualClock(start),
            artifacts: [releaseArtifact('bcd_0.6.0_linux_amd64', new TextEncoder().encode('bcd 0.6.0'), 'linux-amd64')],
          }),
          [key],
        );
        await target.api(() => api.releases!.register!(root, { tenantId: target.tenants.root.id, manifest }));
        const rollout = await target.api(() =>
          api.rollouts!.create!(root, {
            tenantId: target.tenants.root.id,
            version: '0.6.0',
            waves: [20, 100],
            soakSeconds: 60,
            upgradeTimeoutSeconds: 120,
            idempotencyKey: 'upgrade-rollout',
          }),
        );
        for (let waited = 0; waited < 20 * MIN; waited += 10_000) {
          const state = (await target.api(() => api.rollouts!.get!(root, { tenantId: target.tenants.root.id, rolloutId: rollout.id }))) as { state: string };
          if (state.state !== 'running') break;
          await target.run(10_000);
        }
      },
    });
    stop();

    expect(report.applied).toEqual(['upgrade/0001_expand']);
    expect(report.steps.map((step) => step.name)).toEqual(['migrations', 'workers', 'gateways', 'daemons']);
    // Nothing the tenants hold moved.
    expect(report.before.size).toBe(6);
    expect(report.disturbed).toEqual([]);
    expect(await states()).toEqual(reservations.map(() => 'active'));
    // Every daemon runs the new build.
    const { rows: versions } = await sim.database.query<{ daemon_version: string; count: number }>(
      'SELECT daemon_version, count(*)::int AS count FROM node_sessions GROUP BY 1 ORDER BY 1',
    );
    expect(versions.map((row) => [row.daemon_version, Number(row.count)])).toEqual([['0.6.0', 8]]);
    // No instance restarted: every VM still runs on its host, booted exactly as often as before
    // (the hypervisor outlives its daemon's swap), and the sandbox keeps its expiry.
    expect((await vms()).map((vm) => vm.state)).toEqual([...instances, sandbox.instanceId].map(() => 'running'));
    expect(await boots()).toEqual(bootsBefore);
    const sandboxAfter = await sim.api(() => vpsApi.sandboxes.get(root, { tenantId: sim.tenants.root.id, sandboxId: sandbox.id }));
    expect(sandboxAfter).toMatchObject({ state: 'ready', expiresAt: sandboxBefore.expiresAt, nodeId: sandboxBefore.nodeId });
    // Operators' commands all ran, each once (I2 below checks executions).
    expect(commands.length).toBeGreaterThan(5);
    const { rows: outcomes } = await sim.database.query<{ state: string }>('SELECT state FROM commands WHERE id = ANY($1::text[])', [commands]);
    expect(outcomes.every((row) => row.state === 'succeeded')).toBe(true);

    // Usage is continuous: past the first hour boundary, the window that spans the whole upgrade
    // bills exactly each allocation's booked GPU time up to it.
    await sim.run(Math.max(0, start + HOUR + 10 * MIN - sim.sim.scheduler.now()));
    const { rows: windows } = await sim.database.query<{ allocation_id: string; quantity: number }>(
      `SELECT allocation_id, sum(quantity)::float8 AS quantity FROM usage_windows
        WHERE allocation_id = ANY($1::text[]) AND window_start = $2::timestamptz GROUP BY 1`,
      [[...report.before.keys()], new Date(start).toISOString()],
    );
    const billed = new Map(windows.map((row) => [row.allocation_id, Number(row.quantity)]));
    for (const allocation of report.before.values()) {
      const expected = (allocation.atoms.length * (start + HOUR - allocation.boundAt!)) / HOUR;
      expect(billed.get(allocation.id), allocation.id).toBeCloseTo(expected, 4);
    }
    assertInvariants(await sim.invariants());
  });

  // From a v0.5-era database (before quorum/0001-0007 and trust_bundle_state; signed intent on, trust bundle
  // version 1 without a quorum), with the quorum turned on right after: the §7.6 upgrade (the new build's expand
  // migrations, workers, gateways, daemons), then the operator sets pki.approvers and rolls the control plane
  // again. Nothing running moves, the trust bundle's version bumps exactly once (1 → 2) and every daemon takes the
  // new bundle (quorum and epoch) from its next Welcome, none rejecting it. PLAN.md §13 records what destructive
  // commands queued before approvers were set get: they are sent as before, and the daemon, holding the quorum by
  // then, refuses them (UNBATCHED_LIMIT); a new unbatched one is refused at enqueue (batch-required).
  it('from v0.5 with the quorum turned on: nothing moves, the bundle bumps once, queued destructive commands end clearly', { timeout: 900_000 }, async () => {
    const key = createReleaseSigningKey();
    const start = Date.UTC(2026, 0, 1);
    const newMigrations = createQuorumModule({}).migrations;
    rig = await createControlPlaneSim({
      seed: 'v10-upgrade-quorum',
      start,
      nodes: 5,
      gateways: 2,
      signedIntent: true,
      daemon: { selfUpdate: {} },
      rewind: {
        migrations: newMigrations.map((migration) => migration.name),
        sql: [
          'DROP TABLE command_batch_approvals',
          'DROP TABLE command_batch_members',
          'DROP TABLE command_batch_scope',
          'DROP TABLE command_batches',
          'DROP TABLE trust_bundle_history',
          'DROP TABLE trust_bundle_state',
        ],
      },
      modules: [
        rolloutModule({ release: { pins: [spkiPin(key.publicKey)] }, downloadsUrl: 'https://compute.sim.test/api/compute/downloads', every: '10s' }),
        vps({ images: { resolve: async () => IMAGE }, hostSyncEvery: '10s' }),
      ],
      statusHandlers: [instanceStatusHandler({ log: () => {} })],
      extraPools: [
        {
          class: 'vps-host',
          count: 1,
          daemon: { instances: { runtimes: ['libvirt-kvm'] } },
          create: { ownerQuota: { vcpu: 1_000, memoryGiB: 10_000, diskGiB: 100_000 } },
          async setup({ poolId, compute, database, root, rootTenantId }) {
            await setIpPool(database, { poolId, cidr: '10.9.0.0/24', gateway: '10.9.0.1' });
            await (compute.api as any).flavors.create(root, { tenantId: rootTenantId, poolId, name: 's', vcpu: 2, memoryGiB: 4, diskGiB: 40 });
          },
        },
      ],
    });
    const sim = rig;
    const root = { token: sim.tenants.root.token };
    const acme = { token: sim.tenants.acme.token };
    const tenantId = sim.tenants.root.id;
    const api = () => sim.compute.api as any;
    const table = async (name: string) =>
      (await sim.database.query<{ found: string | null }>('SELECT to_regclass($1)::text AS found', [name])).rows[0]!.found;
    // The v0.5-era schema: no quorum tables, none of their migrations in the ledger.
    expect(await table('trust_bundle_state')).toBeNull();
    expect(await table('command_batches')).toBeNull();
    await sim.run(3 * MIN);

    // A VM and four half-node reservations, running before the upgrade.
    const vm = (
      await sim.api(() =>
        api().instances.create(root, { tenantId, poolId: sim.pools[0]!.poolId, flavor: 's', imageId: 'ubuntu-24.04', idempotencyKey: 'uq-vm' }),
      )
    ).id as string;
    const reservations: string[] = [];
    for (let index = 0; index < 4; index++)
      reservations.push(
        (
          await sim.api(() =>
            sim.compute.api.reservations.create(acme, {
              tenantId: sim.tenants.acme.id,
              poolId: sim.poolId,
              devices: [{ class: 'gpu', count: 4 }],
              duration: '2h',
              idempotencyKey: `uq-${index}`,
            } as never),
          )
        ).id,
      );
    const vmState = async () =>
      (await sim.database.query<{ state: string; node_id: string | null }>('SELECT state, node_id FROM instances WHERE id = $1', [vm])).rows[0]!;
    const states = async () =>
      (await sim.database.query<{ state: string }>('SELECT state FROM reservations WHERE id = ANY($1::text[]) ORDER BY id', [reservations])).rows.map(
        (row) => row.state,
      );
    for (let waited = 0; waited < 5 * MIN; waited += 5_000) {
      if ((await vmState()).state === 'running' && (await states()).every((state) => state === 'active')) break;
      await sim.run(5_000);
    }
    expect((await vmState()).state).toBe('running');
    expect(await states()).toEqual(reservations.map(() => 'active'));
    const host = (await vmState()).node_id!;
    const bootsBefore = sim.sim.daemon(host).hypervisor!.domains.get(vm)?.boots;
    // Allocation rows as a whole: no version (generation) moves, no binding changes.
    const allocationRows = async () =>
      (
        await sim.database.query<{ id: string; version: string; binding: unknown; node_id: string }>(
          'SELECT id, version::text AS version, binding, node_id FROM allocations WHERE released_at IS NULL ORDER BY id',
        )
      ).rows;
    const rowsBefore = await allocationRows();
    expect(rowsBefore.length).toBe(5);
    // The allocations' nodes: their spec generation and every section but `daemon` (the daemon roll's own).
    const nodeSpecs = async () =>
      (
        await sim.database.query<{ id: string; generation: number; rest: unknown }>(
          `SELECT id, generation::int AS generation, spec - 'daemon' AS rest FROM nodes WHERE id = ANY($1::text[]) ORDER BY id`,
          [rowsBefore.map((row) => row.node_id)],
        )
      ).rows;
    const specsBefore = await nodeSpecs();

    const upgrade = await upgradeInPlace(sim, {
      // The new build's expand migrations: the quorum's tables, applied under load.
      migrations: newMigrations,
      restartWorkers: (target) => target.restartControlPlane(),
      rollDaemons: (target) => rollDaemons(target, key, start, '0.6.0'),
    });
    expect(upgrade.applied).toEqual(newMigrations.map((migration) => migration.name));
    expect(upgrade.disturbed).toEqual([]);
    // Each allocation's node moved one generation, the daemon roll's (its `daemon` section); nothing else changed.
    const specsUpgraded = await nodeSpecs();
    expect(specsUpgraded).toEqual(specsBefore.map((spec) => ({ ...spec, generation: spec.generation + 1 })));
    // Upgraded without a quorum: the bundle's first record is the version daemons hold (1), no bump.
    const trustState = async () =>
      (await sim.database.query<{ version: string }>(`SELECT version::text AS version FROM trust_bundle_state WHERE id = 'current'`)).rows[0]?.version;
    expect(await trustState()).toBe('1');

    // A destructive command queued before approvers are set, for a GPU node that holds no allocation and is
    // offline (so it waits in the queue through the change).
    const busy = new Set(rowsBefore.map((row) => row.node_id));
    const idle = sim.nodes.map((node) => node.nodeId).find((nodeId) => !busy.has(nodeId))!;
    expect(idle).toBeDefined();
    sim.sim.isolate(idle);
    await sim.run(2 * MIN);
    const queued = (await sim.api(() =>
      api().commands.run(root, { tenantId, nodeId: idle, kind: 'node.reboot', notAfterSeconds: 3600, idempotencyKey: 'uq-queued-reboot' }),
    )) as { id: string; state: string };
    expect(queued.state).toBe('pending');

    // The operator sets pki.approvers: workers restart with it, then the gateways roll.
    const approversAt = sim.sim.scheduler.now();
    sim.pauseWorkers(true);
    await sim.restartControlPlane({ approvers: { count: 2, threshold: 1 } });
    await sim.run(30_000);
    sim.pauseWorkers(false);
    await rollGateways(sim);
    // Exactly one bump, for the approver set: 1 → 2, both digests on record.
    expect(await trustState()).toBe('2');
    const { rows: history } = await sim.database.query<{ version: string }>('SELECT version::text AS version FROM trust_bundle_history ORDER BY version');
    expect(history.map((row) => row.version)).toEqual(['1', '2']);
    // A new unbatched destructive command is refused at enqueue.
    await expect(
      sim.api(() => api().commands.run(root, { tenantId, nodeId: sim.nodes[0]!.nodeId, kind: 'node.reboot', idempotencyKey: 'uq-new-reboot' })),
    ).rejects.toMatchObject({ code: 'INVALID_STATE', details: { reason: 'batch-required' } });

    // The offline node comes back: its Welcome brings bundle 2 first, then the queued reboot is sent as before,
    // and the daemon, holding the quorum now, refuses it unbatched. It never runs.
    sim.sim.heal(idle);
    const commandState = async (id: string) =>
      (await sim.database.query<{ state: string; reason: string | null }>('SELECT state, reason FROM commands WHERE id = $1', [id])).rows[0]!;
    for (let waited = 0; waited < 5 * MIN && ['pending', 'dispatched', 'acked', 'running'].includes((await commandState(queued.id)).state); waited += 10_000)
      await sim.run(10_000);
    expect(await commandState(queued.id)).toMatchObject({ state: 'rejected', reason: 'unbatched-limit' });
    expect(sim.sim.daemon(idle).executions.get(queued.id) ?? 0).toBe(0);
    await sim.run(2 * MIN);

    // Every daemon holds bundle 2 with the quorum (both keys, threshold 1, the first set's epoch 1), and none
    // refused it.
    const kids = sim.approvers!.keys.map((approver) => approver.key.kid).sort();
    for (const daemon of sim.sim.daemons) {
      const trust = daemon.trust;
      expect(trust.version, daemon.nodeId).toBe(2n);
      expect(trust.quorum?.approverKeys.map((approverKey) => approverKey.kid).sort(), daemon.nodeId).toEqual(kids);
      expect(trust.quorum, daemon.nodeId).toMatchObject({ threshold: 1, unbatchedPerHour: 0, epoch: 1n, trustDomain: sim.approvers!.trustDomain });
    }
    const refusals = sim.sim.log.entries.filter(
      (entry) =>
        entry.t >= approversAt &&
        (entry.event === 'trust.quorum-refused' || (entry.event === 'trust.ignored' && entry.data?.reason !== 'not newer')),
    );
    expect(refusals).toEqual([]);

    // Nothing running moved: the same allocations, versions and bindings; the VM kept running
    // on its host without a reboot; every reservation is still active.
    expect(disturbances(upgrade.before, await allocationStates(sim))).toEqual([]);
    expect(await allocationRows()).toEqual(rowsBefore);
    // Setting approvers moved no generation.
    expect(await nodeSpecs()).toEqual(specsUpgraded);
    expect(await vmState()).toMatchObject({ state: 'running', node_id: host });
    expect(sim.sim.daemon(host).hypervisor!.domains.get(vm)?.boots).toBe(bootsBefore);
    expect(await states()).toEqual(reservations.map(() => 'active'));
    assertInvariants(await sim.invariants());
  });
});

/** Registers a signed bcd release and rolls every daemon to it (canary 20 %, then all). */
async function rollDaemons(target: ControlPlaneSim, key: ReturnType<typeof createReleaseSigningKey>, start: number, version: string): Promise<void> {
  const root = { token: target.tenants.root.token };
  const api = target.compute.api as any;
  const manifest = signReleaseManifest(
    buildReleaseManifest({
      product: 'bcd',
      version,
      sequence: 1,
      signers: [key],
      clock: manualClock(start),
      artifacts: [releaseArtifact(`bcd_${version}_linux_amd64`, new TextEncoder().encode(`bcd ${version}`), 'linux-amd64')],
    }),
    [key],
  );
  await target.api(() => api.releases.register(root, { tenantId: target.tenants.root.id, manifest }));
  const rollout = await target.api(() =>
    api.rollouts.create(root, {
      tenantId: target.tenants.root.id,
      version,
      waves: [20, 100],
      soakSeconds: 60,
      upgradeTimeoutSeconds: 120,
      idempotencyKey: `rollout-${version}`,
    }),
  );
  for (let waited = 0; waited < 20 * MIN; waited += 10_000) {
    const state = (await target.api(() => api.rollouts.get(root, { tenantId: target.tenants.root.id, rolloutId: rollout.id }))) as { state: string };
    if (state.state !== 'running') break;
    await target.run(10_000);
  }
}
