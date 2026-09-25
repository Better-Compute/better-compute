import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { defineProfile } from '@better-compute/provision';
import { metalWorkKind, reconcileMetalNode } from '@better-compute/metal';
import { siteBootLeaseName, siteBootTtlSeconds, tickSiteBoot } from '@better-compute/server';
import { createMetalSim, type MetalSim } from './extensions/metal-sim.js';

// PLAN.md §16 v0.2 exit: "killing the active site agent mid-PXE → the standby takes over boot within
// 30 s". Two site agents share site_a; SiteBoot (the server's tick, every 5 s on the sim clock) gives
// `site:site_a:boot` to the first. A machine PXE-boots only from the live lease holder's boot entry
// (`pxe: 'boot-server'`). The active agent dies right after it power-cycled the machine, while the
// machine is still asking for DHCP: the standby must be promoted once the dead agent's lease runs out,
// hold the machine's boot entry by then, and boot it, without the power cycle being sent again.

const ACTIVE = 'node_s1tea000000000000000000001';
const STANDBY = 'node_s1tea000000000000000000002';

const failoverDeploy = defineProfile({
  id: 'failover-deploy',
  version: 1,
  target: 'metal',
  role: 'host',
  steps: [{ use: 'metal.ensureRamdisk' }, { use: 'disk.wipe', with: { mode: 'quick' } }, { use: 'power.setPower', with: { action: 'off' } }],
});

let sim: MetalSim;
let now = 0;
let ticks = 0;
let n = 0;

/** One simulated second: the SiteBoot tick every 5 s, the agents, the machines' DHCP, the workers. */
async function second(beforeDhcp?: () => Promise<void>) {
  now += 1000;
  await setSimClock(sim.db, now);
  if (ticks++ % 5 === 0) await sim.db.transaction((tx) => tickSiteBoot(tx, 'site_a'));
  await sim.runAgents();
  await beforeDhcp?.();
  const booted = await sim.pxeTick();
  const due = [...sim.queue.values()];
  sim.queue.clear();
  const signal = new AbortController().signal;
  for (const item of due)
    if (item.kind === metalWorkKind) await reconcileMetalNode(sim.context, item.key);
    else if (item.kind === 'workflow') await sim.provision.reconcilers![0]!.run({ ...sim.context, signal } as never, item.key);
  return booted;
}
async function until(done: () => Promise<boolean>, seconds: number, label: string) {
  for (let i = 0; i < seconds; i++) {
    if (await done()) return;
    await second();
  }
  throw new Error(`${label}: not reached within ${seconds} s`);
}
const lease = async () =>
  (
    await sim.db.query<{ owner: string | null; epoch: string; expires_at: Date }>(
      'SELECT owner, epoch::text, expires_at FROM leases WHERE name = $1',
      [siteBootLeaseName('site_a')],
    )
  ).rows[0]!;

async function readyNode(): Promise<string> {
  const { nodeId } = await sim.call('enroll', {
    tenantId: 'root',
    siteId: 'site_a',
    poolId: 'pool_metal',
    bmc: { address: `https://10.12.0.${++n}`, driver: 'redfish', credentials: 'secret://root/bmc' },
  });
  await until(async () => (await sim.state(nodeId)).provision_state === 'ready', 600, 'commissioning');
  // Ready machines sit powered off, out of the ramdisk.
  Object.assign(sim.machineOf(nodeId), { power: 'off', pxeWaiting: false, bootedBy: undefined });
  await sim.disconnect(nodeId);
  return nodeId;
}

async function kill(agent: string) {
  sim.faults.downAgents.add(agent);
  await sim.db.query(`UPDATE nodes SET connectivity = 'unreachable' WHERE id = $1`, [agent]);
  await sim.disconnect(agent);
}

beforeAll(async () => {
  sim = await createMetalSim({ profiles: [failoverDeploy], pxe: 'boot-server' });
  now = Date.now();
  await useSimClock(sim.db, now);
  await sim.addSiteAgent(ACTIVE, 'site_a');
  await sim.addSiteAgent(STANDBY, 'site_a');
  await second();
  expect((await lease()).owner).toBe(ACTIVE);
});
afterAll(() => sim.close());

describe('the active site agent dies mid-PXE', () => {
  it('the standby takes over boot within 30 s and the machine boots from it; nothing destructive runs twice', async () => {
    const node = await readyNode();
    const machine = sim.machineOf(node);
    await sim.call('deploy', { tenantId: 'root', nodeId: node, profileId: 'failover-deploy', profileVersion: 1 });

    // Run until the active agent power-cycled the machine; it dies before answering its DHCP.
    let killedAt: number | undefined;
    let leaseAtKill: Awaited<ReturnType<typeof lease>> | undefined;
    for (let i = 0; i < 120 && killedAt === undefined; i++)
      await second(async () => {
        if (machine.pxeWaiting && killedAt === undefined) {
          killedAt = now;
          leaseAtKill = await lease();
          await kill(ACTIVE);
        }
      });
    expect(killedAt, 'the machine was power-cycled for PXE').toBeDefined();
    expect(leaseAtKill!.owner).toBe(ACTIVE);

    await until(async () => machine.bootedBy !== undefined, 60, 'ramdisk boot');
    const tookOver = now - killedAt!;
    expect(machine.bootedBy).toBe(STANDBY);
    expect(tookOver).toBeLessThanOrEqual(30_000);
    // Promotion waited for the dead agent's lease (live only while expires_at > now): two boot
    // servers never overlap. Bound: the 15 s TTL from the last renewal, plus one 5 s SiteBoot tick.
    expect(now).toBeGreaterThanOrEqual(leaseAtKill!.expires_at.getTime());
    expect(tookOver).toBeLessThanOrEqual(siteBootTtlSeconds * 1000 + 5_000);
    const promoted = await lease();
    expect(promoted.owner).toBe(STANDBY);
    expect(Number(promoted.epoch)).toBe(Number(leaseAtKill!.epoch) + 1);

    await until(async () => (await sim.state(node)).provision_state === 'deployed', 300, 'deploy');

    // The BMC commands of the boot step ran once, on the agent that was active; the standby got its
    // own copy of the boot entry (it must serve it) and nothing else of that step.
    const { rows } = await sim.db.query<{ node_id: string; kind: string; key: string; state: string }>(
      `SELECT c.node_id, c.kind, regexp_replace(c.idempotency_key, '^.*#\\d+:', '') AS key, c.state
         FROM commands c JOIN workflow_steps s ON c.idempotency_key LIKE s.idempotency_key || '#%'
         JOIN workflows w ON w.id = s.workflow_id
        WHERE w.node_id = $1 AND w.profile_id = 'failover-deploy' AND s.action = 'metal.ensureRamdisk'
        ORDER BY c.seq`,
      [node],
    );
    const on = (agent: string) => rows.filter((row) => row.node_id === agent).map((row) => `${row.kind}:${row.key}:${row.state}`);
    expect(on(ACTIVE)).toEqual(['bmc.boot:boot-device:succeeded', 'boot.prepareRamdisk:boot-entry-0:succeeded', 'bmc.power:power-cycle:succeeded']);
    expect(on(STANDBY)).toEqual(['boot.prepareRamdisk:boot-entry-0:succeeded']);
    // Each entry carried its own single-use discovery token.
    const tokens = sim.tokenRequests.filter((request) => request.role === 'discovery' && (request.expect as { mac?: string })?.mac);
    expect(tokens.length).toBeGreaterThanOrEqual(2);
  });

  it('holds the boot while no site agent can serve it, and boots once one is back', async () => {
    // Now STANDBY is the only live agent. It dies as well: nobody can serve the next PXE boot.
    const node = await (async () => {
      sim.faults.downAgents.delete(ACTIVE);
      // ACTIVE comes back first (as a standby), so the commissioning of this node can run.
      await sim.db.query(`UPDATE nodes SET connectivity = 'connected' WHERE id = $1`, [ACTIVE]);
      await sim.connect(ACTIVE, 'site', 'site-back');
      return readyNode();
    })();
    const machine = sim.machineOf(node);
    await sim.call('deploy', { tenantId: 'root', nodeId: node, profileId: 'failover-deploy', profileVersion: 1 });
    let killedAt: number | undefined;
    for (let i = 0; i < 120 && killedAt === undefined; i++)
      await second(async () => {
        if (machine.pxeWaiting && killedAt === undefined) {
          killedAt = now;
          const holder = (await lease()).owner!;
          await kill(holder);
          // ...and the other one is down too.
          await kill(holder === ACTIVE ? STANDBY : ACTIVE);
        }
      });
    expect(killedAt).toBeDefined();
    for (let i = 0; i < 40; i++) await second();
    expect(machine.bootedBy).toBeUndefined();
    expect((await sim.state(node)).provision_state).toBe('deploying');
    // One agent returns: it takes the lease and serves the waiting machine.
    sim.faults.downAgents.delete(ACTIVE);
    await sim.db.query(`UPDATE nodes SET connectivity = 'connected' WHERE id = $1`, [ACTIVE]);
    await sim.connect(ACTIVE, 'site', 'site-back-2');
    await until(async () => machine.bootedBy !== undefined, 60, 'ramdisk boot after recovery');
    expect(machine.bootedBy).toBe(ACTIVE);
    await until(async () => (await sim.state(node)).provision_state === 'deployed', 300, 'deploy');
  });
});
