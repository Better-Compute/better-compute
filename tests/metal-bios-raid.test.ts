import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMetalSim, type MetalSim } from './extensions/metal-sim.js';

// BIOS settings and RAID layout from the hardware profile (PLAN.md §3.5 commissioning, v0.5 drafts):
// commissioning applies what differs, boots, and checks the settings took; a profile without them
// changes nothing.

const hgx = {
  drivers: {},
  bios: { BootMode: 'Uefi', SriovGlobalEnable: 'Enabled' },
  raid: { volumes: [{ level: '1' as const, disks: ['nvme0', 'nvme1'] }] },
};

let sim: MetalSim;
let n = 0;

beforeAll(async () => {
  sim = await createMetalSim({ hardwareProfiles: { hgx, plain: { drivers: {} } } });
  await sim.addSiteAgent('node_s1tea000000000000000000006', 'site_a');
});
afterAll(() => sim.close());

async function enroll(hardwareProfile: string): Promise<string> {
  const node = await sim.call('enroll', {
    tenantId: 'root',
    siteId: 'site_a',
    poolId: 'pool_metal',
    hardwareProfile,
    bmc: { address: `https://10.16.0.${++n}`, driver: 'redfish', credentials: 'secret://root/bmc' },
  });
  await sim.settle();
  return node.nodeId;
}

const stepResult = async (nodeId: string, action: string) =>
  (
    await sim.db.query<{ result: unknown }>(
      `SELECT s.result FROM workflow_steps s JOIN workflows w ON w.id = s.workflow_id
        WHERE w.node_id = $1 AND s.action = $2 ORDER BY w.created_at DESC LIMIT 1`,
      [nodeId, action],
    )
  ).rows[0]?.result;

describe('BIOS and RAID in commissioning', () => {
  it('applies the settings that differ, verifies them after the boot, and builds the RAID layout', async () => {
    const node = await enroll('hgx');
    expect((await sim.state(node)).provision_state).toBe('ready');
    expect(sim.machineOf(node).bios).toMatchObject(hgx.bios);
    expect(sim.machineOf(node).raid).toEqual(['1']);
    expect(await stepResult(node, 'bios.apply')).toEqual({ changed: ['BootMode', 'SriovGlobalEnable'], pendingReboot: true });
    expect(await stepResult(node, 'bios.verify')).toEqual({ verified: 2 });
    expect(await stepResult(node, 'raid.apply')).toEqual({ volumes: ['1'] });
    const storage = sim.seen.filter((c) => c.kind === 'bmc.storage' && c.node === 'node_s1tea000000000000000000006');
    expect(storage.at(-1)!.args).toEqual({ volumes: [{ level: '1', disks: ['nvme0', 'nvme1'] }] });
  });

  it('fails commissioning when the BIOS does not take the settings', async () => {
    sim.faults.biosIgnored = true;
    try {
      const node = await enroll('hgx');
      expect(await sim.state(node)).toMatchObject({ provision_state: 'failed', failed_from: 'commissioning', maintenance: true });
      const error = await sim.db.query<{ last_error: unknown }>('SELECT last_error FROM metal_nodes WHERE node_id = $1', [node]);
      expect(JSON.stringify(error.rows[0]!.last_error)).toContain('BootMode');
    } finally {
      sim.faults.biosIgnored = false;
    }
  });

  it('sends nothing for a profile without BIOS or RAID', async () => {
    const before = sim.seen.length;
    const node = await enroll('plain');
    expect((await sim.state(node)).provision_state).toBe('ready');
    const sent = sim.seen.slice(before).map((c) => `${c.kind}:${c.payload.operation ?? ''}`);
    expect(sent.some((entry) => entry.includes('bios.') || entry.startsWith('bmc.storage'))).toBe(false);
    expect(await stepResult(node, 'bios.apply')).toEqual({ skipped: true });
  });
});
