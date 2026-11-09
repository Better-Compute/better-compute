import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineProfile } from '@better-compute/provision';
import { createMetalSim, type MetalSim } from './extensions/metal-sim.js';

// metal.ensureRamdisk skips the PXE boot when the machine's ramdisk is already connected. Right after a
// hard power-off the old session still looks connected (the gateway notices a dead peer only after
// its ping, about 20 s), so "connected" must mean: connected since metal last cut the machine's power.

const SITE_AGENT = 'node_s1tea000000000000000000007';
const boot = defineProfile({ id: 'boot-ramdisk', version: 1, target: 'metal', steps: [{ use: 'metal.ensureRamdisk' }] });
const off = defineProfile({ id: 'power-off', version: 1, target: 'metal', steps: [{ use: 'power.setPower', with: { action: 'off' } }] });

let sim: MetalSim;
let node: string;

beforeAll(async () => {
  sim = await createMetalSim({ profiles: [boot, off] });
  await sim.addSiteAgent(SITE_AGENT, 'site_a');
  const enrolled = await sim.call('enroll', {
    tenantId: 'root',
    siteId: 'site_a',
    poolId: 'pool_metal',
    bmc: { address: 'https://10.17.0.1', driver: 'redfish', credentials: 'secret://root/bmc' },
  });
  node = enrolled.nodeId;
  await sim.settle();
  expect((await sim.state(node)).provision_state).toBe('ready');
});
afterAll(() => sim.close());

async function run(profileId: string): Promise<{ state: string; result: unknown }> {
  const { id } = await sim.db.transaction((tx) =>
    sim.context.workflows!.start(tx, { tenantId: 'root', profileId, profileVersion: 1, nodeId: node } as never),
  );
  await sim.settle();
  const { rows } = await sim.db.query<{ state: string; result: unknown }>(
    `SELECT w.state, s.result FROM workflows w JOIN workflow_steps s ON s.workflow_id = w.id WHERE w.id = $1 ORDER BY s.index LIMIT 1`,
    [id],
  );
  return rows[0]!;
}
const cycles = () => sim.seen.filter((c) => c.kind === 'bmc.power' && c.args.action === 'cycle' && c.payload.address === 'https://10.17.0.1').length;
/** The session as the gateway still shows it for some seconds after a hard power-off: connected. */
const gatewayHasNotNoticed = () => sim.db.query('UPDATE node_sessions SET disconnected_at = NULL WHERE node_id = $1', [node]);
const session = async () =>
  (await sim.db.query<{ boot_id: string; live: boolean }>(
    `SELECT boot_id, (connected_at IS NOT NULL AND (disconnected_at IS NULL OR connected_at > disconnected_at)) AS live FROM node_sessions WHERE node_id = $1`,
    [node],
  )).rows[0]!;

describe('metal.ensureRamdisk and a ramdisk session from before a power-off', () => {
  it('does not trust the session of a ramdisk metal has just powered off: it boots the machine again', async () => {
    // Commissioning ended with power off; the ramdisk session of that boot is still on the books.
    const stale = (await session()).boot_id;
    await gatewayHasNotNoticed();
    expect(await session()).toEqual({ boot_id: stale, live: true });
    const before = cycles();
    expect((await run('boot-ramdisk')).state).toBe('succeeded');
    // It PXE-booted the machine (one power cycle) and waited for the ramdisk of that boot.
    expect(cycles()).toBe(before + 1);
    expect((await session()).boot_id).not.toBe(stale);
  });

  it('trusts a ramdisk that connected after the last power cut, without booting it again', async () => {
    const before = cycles();
    expect(await run('boot-ramdisk')).toEqual({ state: 'succeeded', result: { ramdisk: 'connected' } });
    expect(cycles()).toBe(before);
  });

  it('counts a power-off by a step of an earlier workflow', async () => {
    expect((await run('power-off')).state).toBe('succeeded');
    await gatewayHasNotNoticed();
    const before = cycles();
    expect((await run('boot-ramdisk')).state).toBe('succeeded');
    expect(cycles()).toBe(before + 1);
  });
});
