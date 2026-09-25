import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineProfile } from '@better-compute/provision';
import { metalProfiles, metalWorkKind, reconcileMetalNode } from '@better-compute/metal';
import { createMetalSim, type MetalSim } from './extensions/metal-sim.js';

// PLAN.md §11.1 "deployed → rescue ⇄ unrescue": rescue boots the ramdisk on a deployed machine;
// unrescue boots it back into its installed OS and only then is the node `deployed` again.

const SITE = 'node_s1tea000000000000000000009';
const deployProfile = defineProfile({
  id: 'rescue-deploy',
  version: 1,
  target: 'metal',
  role: 'host',
  steps: [{ use: 'metal.ensureRamdisk' }, { use: 'power.setPower', with: { action: 'off' } }],
});

let sim: MetalSim;
let n = 0;

beforeAll(async () => {
  sim = await createMetalSim({ profiles: [deployProfile] });
  await sim.addSiteAgent(SITE, 'site_a');
});
afterAll(() => sim.close());

async function deployedNode(): Promise<string> {
  const { nodeId } = await sim.call('enroll', {
    tenantId: 'root',
    siteId: 'site_a',
    poolId: 'pool_metal',
    bmc: { address: `https://10.13.0.${++n}`, driver: 'redfish', credentials: 'secret://root/bmc' },
  });
  await sim.settle();
  await sim.call('deploy', { tenantId: 'root', nodeId, profileId: 'rescue-deploy', profileVersion: 1 });
  await sim.settle();
  expect((await sim.state(nodeId)).provision_state).toBe('deployed');
  // The deploy left an installed OS behind.
  sim.machineOf(nodeId).installed = true;
  return nodeId;
}
const session = async (nodeId: string) =>
  (await sim.db.query<{ role: string }>('SELECT role FROM node_sessions WHERE node_id = $1', [nodeId])).rows[0]?.role;

describe('rescue ⇄ unrescue', () => {
  it('ships the unrescue profile', () => {
    expect(metalProfiles.map((profile) => profile.id)).toContain('metal-unrescue');
  });

  it('rescues into the ramdisk, then unrescues back into the installed OS before it is deployed again', async () => {
    const node = await deployedNode();
    await sim.call('rescue', { tenantId: 'root', nodeId: node });
    await sim.settle();
    expect(await sim.state(node)).toMatchObject({ provision_state: 'rescue' });
    expect(await session(node)).toBe('ramdisk');

    sim.seen.length = 0;
    const unrescuing = await sim.call('unrescue', { tenantId: 'root', nodeId: node });
    expect(unrescuing.provisionState).toBe('rescue');
    // Asking again while it runs is a no-op.
    expect((await sim.call('unrescue', { tenantId: 'root', nodeId: node })).provisionState).toBe('rescue');
    await sim.settle();
    expect(await sim.state(node)).toMatchObject({ provision_state: 'deployed', maintenance: false });
    expect(await session(node)).toBe('node');
    expect(sim.machineOf(node).bootDevice).toBe('disk');
    const bmc = sim.seen.filter((command) => command.kind.startsWith('bmc.')).map((command) => `${command.kind}:${command.payload.operation}`);
    expect(bmc).toEqual(['bmc.boot:management.setBootDevice', 'bmc.power:power.setPower']);
    expect(sim.events.some((event) => event.type === 'node.provision.unrescuing')).toBe(true);
    expect(sim.events.filter((event) => event.type === 'node.provision.deployed').at(-1)?.data).toMatchObject({ from: 'rescue', verb: 'unrescue' });
  });

  it('refuses unrescue outside rescue, and fails the node when the OS does not come back', async () => {
    const node = await deployedNode();
    await expect(sim.call('unrescue', { tenantId: 'root', nodeId: node })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await sim.call('rescue', { tenantId: 'root', nodeId: node });
    await sim.settle();
    await sim.call('unrescue', { tenantId: 'root', nodeId: node });
    // The installed OS never rejoins; its workflow gives up.
    const { rows } = await sim.db.query<{ workflow_id: string }>('SELECT workflow_id FROM metal_nodes WHERE node_id = $1', [node]);
    await sim.db.query(`UPDATE workflows SET state = 'failed', error = '{"code":"REJOIN_TIMEOUT","message":"no OS"}' WHERE id = $1`, [rows[0]!.workflow_id]);
    await reconcileMetalNode(sim.context, node);
    expect(await sim.state(node)).toMatchObject({ provision_state: 'failed', failed_from: 'rescue', maintenance: true });
    // Recover goes back to deployed (core's recover target for rescue).
    expect((await sim.call('recover', { tenantId: 'root', nodeId: node })).provisionState).toBe('deployed');
    sim.queue.delete(`${metalWorkKind}:${node}`);
  });
});
