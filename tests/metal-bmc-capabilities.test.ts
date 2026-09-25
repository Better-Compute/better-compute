import { afterEach, describe, expect, it } from 'vitest';
import type { ProfileDocument } from '@better-compute/core';
import {
  builtinBmcDrivers,
  enrollProfile,
  inspectProfile,
  servedBmcOperations,
  tenantRootReleaseProfile,
  unmetBmcNeeds,
} from '@better-compute/metal';
import { createProfile, defineProfile } from '@better-compute/provision';
import { createMetalSim, type MetalSim } from './extensions/metal-sim.js';

// Capability-aware BMC workflows (PLAN.md §3.5, §5.4): an IPMI machine (bcx-ipmi: power, boot device, FRU
// inspection without MACs) enrolls and commissions to ready when its PXE MACs are given; out-of-band
// inspection is optional and skipped when the site agent's driver lacks it; anything that needs an
// operation the driver lacks (virtual media, BIOS, rotation) is refused up front with UNSUPPORTED
// `bmc-driver-unsupported`, before a workflow starts, never DRIVER_ERROR halfway through.

const AGENT = 'node_siteagent00000000000000001';
let sim: MetalSim | undefined;
afterEach(async () => {
  await sim?.close();
  sim = undefined;
});

const node = (driver: string, extra: Partial<Parameters<typeof unmetBmcNeeds>[1]> = {}) => ({
  bmc_driver: driver,
  hardware_profile: null,
  pool_policy: null,
  ...extra,
});

describe('the BMC capability table', () => {
  it('knows Redfish (everything) and bcx-ipmi (power, boot device, inspection without MACs)', () => {
    expect([...servedBmcOperations('ipmi')!].sort()).toEqual(['inspect.inspect', 'management.setBootDevice', 'power.getPower', 'power.setPower']);
    expect(servedBmcOperations('redfish')!.has('inspect.macs')).toBe(true);
    expect(servedBmcOperations('acme-bmc')).toBeUndefined();
    expect(Object.keys(builtinBmcDrivers).sort()).toEqual(['ipmi', 'redfish']);
  });

  it('names what a profile needs that the driver lacks; optional and may-fail steps never count', () => {
    expect(unmetBmcNeeds([enrollProfile, inspectProfile], node('ipmi'))).toEqual([]);
    expect(unmetBmcNeeds([tenantRootReleaseProfile], node('ipmi'))).toEqual([
      { profile: 'metal-tenant-root-release@1', step: 'metal.rotateBmcCredential', operations: ['management.rotateCredential'] },
      { profile: 'metal-tenant-root-release@1', step: 'metal.firmwareCheck', operations: ['firmware.components'] },
    ]);
    expect(unmetBmcNeeds([tenantRootReleaseProfile], node('redfish'))).toEqual([]);
    // A driver nobody knows is not checked in advance.
    expect(unmetBmcNeeds([tenantRootReleaseProfile], node('acme-bmc'))).toEqual([]);
    // What the site agents report narrows the table, and makes an unknown driver checkable.
    expect(unmetBmcNeeds([enrollProfile], node('ipmi'), { reportedKinds: new Set(['power']) })).toEqual([]);
    expect(unmetBmcNeeds([inspectProfile], node('acme-bmc'), { reportedKinds: new Set(['power']) })).toEqual([
      { profile: 'metal-inspect@2', step: 'metal.ensureRamdisk', operations: ['management.setBootDevice'] },
    ]);
  });

  it('counts BIOS and RAID steps only when the hardware profile sets them', () => {
    const hardwareProfiles = { plain: { drivers: {} }, tuned: { drivers: {}, bios: { SriovGlobalEnable: 'Enabled' } } };
    const commission = defineProfile({ id: 'c', version: 1, target: 'metal', steps: [{ use: 'bios.apply' }, { use: 'bios.verify' }] });
    expect(unmetBmcNeeds([commission], node('ipmi', { hardware_profile: 'plain' }), { hardwareProfiles })).toEqual([]);
    expect(unmetBmcNeeds([commission], node('ipmi', { hardware_profile: 'tuned' }), { hardwareProfiles }).map((need) => need.step)).toEqual([
      'bios.apply',
      'bios.verify',
    ]);
  });
});

describe('an IPMI machine on the simulated site', () => {
  const enroll = (s: MetalSim, extra: Record<string, unknown> = {}) =>
    s.call('enroll', {
      tenantId: 'root',
      siteId: 'site_a',
      poolId: 'pool_metal',
      bmc: { address: 'https://10.10.0.40', driver: 'ipmi', credentials: 'secret://root/bmc' },
      ...extra,
    });

  it('without its PXE MACs is refused at enroll: IPMI cannot name the host NICs', async () => {
    sim = await createMetalSim();
    await sim.addSiteAgent(AGENT);
    await expect(enroll(sim)).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      details: { reason: 'bmc-driver-unsupported', driver: 'ipmi' },
      message: expect.stringContaining('enroll the machine with macs'),
    });
    expect((await sim.db.query('SELECT 1 FROM metal_nodes')).rowCount).toBe(0);
  });

  it('with its MACs enrolls, inspects (FRU, no MACs) and commissions to ready', async () => {
    sim = await createMetalSim();
    await sim.addSiteAgent(AGENT);
    const mac = '52:54:00:aa:bb:01';
    const enrolled = await enroll(sim, { macs: [mac] });
    await sim.settle();
    expect(await sim.state(enrolled.nodeId)).toMatchObject({ provision_state: 'ready', failed_from: null });
    // The enrolled MAC stands (the IPMI inspection reports none), and the ramdisk booted from it.
    const { rows } = await sim.db.query<{ macs: string[] }>('SELECT macs FROM metal_nodes WHERE node_id = $1', [enrolled.nodeId]);
    expect(rows[0]!.macs).toEqual([mac]);
    const operations = sim.seen.filter((c) => c.kind.startsWith('bmc.')).map((c) => c.payload.operation);
    expect(operations).toContain('inspect.inspect');
    expect(new Set(operations)).toEqual(new Set(['power.getPower', 'inspect.inspect', 'management.setBootDevice', 'power.setPower']));
  });

  it('skips out-of-band inspection when the site agent says its driver lacks it', async () => {
    sim = await createMetalSim();
    await sim.addSiteAgent(AGENT);
    sim.faults.ipmiInspect = false;
    const enrolled = await enroll(sim, { macs: ['52:54:00:aa:bb:02'] });
    await sim.settle();
    expect(await sim.state(enrolled.nodeId)).toMatchObject({ provision_state: 'ready' });
    const { rows } = await sim.db.query<{ result: { skipped?: string } }>(
      `SELECT s.result FROM workflow_steps s JOIN workflows w ON w.id = s.workflow_id
        WHERE w.node_id = $1 AND s.action = 'inspect.oob' AND s.state = 'succeeded'`,
      [enrolled.nodeId],
    );
    expect(rows[0]!.result.skipped).toMatch(/unsupported-driver/);
  });

  it('with a hardware profile that sets BIOS attributes is refused at enroll, naming the steps', async () => {
    sim = await createMetalSim({ hardwareProfiles: { tuned: { drivers: {}, bios: { SriovGlobalEnable: 'Enabled' } } } });
    await sim.addSiteAgent(AGENT);
    const refused = await enroll(sim, { macs: ['52:54:00:aa:bb:03'], hardwareProfile: 'tuned' }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'UNSUPPORTED', details: { reason: 'bmc-driver-unsupported' } });
    expect((refused as { details: { unmet: { step: string }[] } }).details.unmet.map((need) => need.step)).toEqual(['bios.apply', 'bios.verify']);
  });

  it('refuses a deploy that needs virtual media: a stored profile at the call, a shipped one when its workflow starts', async () => {
    const isoDeploy = (id: string): ProfileDocument =>
      defineProfile({
        id,
        version: 1,
        target: 'metal',
        steps: [{ use: 'media.insert', with: { url: 'https://cache.site-a/os.iso' } }, { use: 'power.setPower', with: { action: 'cycle' } }],
      });
    sim = await createMetalSim({ profiles: [isoDeploy('iso-shipped')] });
    await sim.addSiteAgent(AGENT);
    const s = sim;
    const enrolled = await enroll(s, { macs: ['52:54:00:aa:bb:04'] });
    await s.settle();
    expect(await s.state(enrolled.nodeId)).toMatchObject({ provision_state: 'ready' });

    // Stored: refused by metal.deploy itself; the node stays ready.
    await s.db.transaction((tx) => createProfile(tx, undefined, 'root', { document: isoDeploy('iso-stored') }));
    await expect(s.call('deploy', { tenantId: 'root', nodeId: enrolled.nodeId, profileId: 'iso-stored', profileVersion: 1 })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      details: { reason: 'bmc-driver-unsupported', unmet: [{ step: 'media.insert', operations: ['virtual-media.insert'] }] },
    });
    expect(await s.state(enrolled.nodeId)).toMatchObject({ provision_state: 'ready' });

    // Shipped by a module: the reconciler takes the started workflow back and fails the node, naming it.
    await s.call('deploy', { tenantId: 'root', nodeId: enrolled.nodeId, profileId: 'iso-shipped', profileVersion: 1 });
    await s.settle();
    expect(await s.state(enrolled.nodeId)).toMatchObject({ provision_state: 'failed', failed_from: 'deploying' });
    const { rows } = await s.db.query<{ last_error: { code: string; reason: string; unmet: { step: string }[] } }>(
      'SELECT last_error FROM metal_nodes WHERE node_id = $1',
      [enrolled.nodeId],
    );
    expect(rows[0]!.last_error).toMatchObject({ code: 'UNSUPPORTED', reason: 'bmc-driver-unsupported', unmet: [{ step: 'media.insert' }] });
    expect((await s.db.query(`SELECT 1 FROM workflows WHERE profile_id = 'iso-shipped'`)).rowCount).toBe(0);
    // Nothing reached the BMC for it.
    expect(s.seen.some((c) => c.payload.operation === 'virtual-media.insert')).toBe(false);
  });

  it('sends the enrolled driver options with every BMC operation, and refuses ones that are not a small object', async () => {
    sim = await createMetalSim();
    await sim.addSiteAgent(AGENT);
    const s = sim;
    const enrolled = await s.call('enroll', {
      tenantId: 'root',
      siteId: 'site_a',
      poolId: 'pool_metal',
      macs: ['52:54:00:aa:bb:06'],
      bmc: { address: 'https://10.10.0.42', driver: 'ipmi', credentials: 'secret://root/bmc', driverOptions: { cipherSuite: 3 } },
    });
    expect(enrolled.bmc.driverOptions).toEqual({ cipherSuite: 3 });
    await s.settle();
    expect(await s.state(enrolled.nodeId)).toMatchObject({ provision_state: 'ready' });
    const bmcCommands = s.seen.filter((c) => c.kind.startsWith('bmc.'));
    expect(bmcCommands.length).toBeGreaterThan(3);
    expect(new Set(bmcCommands.map((c) => c.payload.driverOptionsJson))).toEqual(new Set(['{"cipherSuite":3}']));

    const bad = (driverOptions: unknown) =>
      s.call('enroll', {
        tenantId: 'root',
        siteId: 'site_a',
        poolId: 'pool_metal',
        macs: ['52:54:00:aa:bb:07'],
        bmc: { address: 'https://10.10.0.43', driver: 'ipmi', credentials: 'secret://root/bmc', driverOptions },
      });
    await expect(bad({ password: 'hunter2' })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('credential') });
    await expect(bad({ blob: 'x'.repeat(2000) })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(bad([3])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it("takes an agentless machine's addresses at enroll, for site.httpProxy, without PXE MACs", async () => {
    sim = await createMetalSim();
    await sim.addSiteAgent(AGENT);
    await sim.db.query(
      `INSERT INTO pools (id, owner_tenant_id, site_id, class, sharing, agent, policy, version)
       VALUES ('pool_agentless', 'root', 'site_a', 'metal-host', 'exclusive', 'none', '{}', 1)`,
    );
    const enrolled = await sim.call('enroll', {
      tenantId: 'root',
      siteId: 'site_a',
      poolId: 'pool_agentless',
      addresses: ['10.30.1.7', '10.30.1.7', 'fd00::7'],
      bmc: { address: 'https://10.10.0.44', driver: 'ipmi', credentials: 'secret://root/bmc' },
    });
    expect(enrolled.addresses).toEqual(['10.30.1.7', 'fd00::7']);
    await sim.settle();
    // The IPMI inspection reports no addresses: the enrolled ones stand.
    const { rows } = await sim.db.query<{ addresses: string[] }>('SELECT addresses FROM metal_nodes WHERE node_id = $1', [enrolled.nodeId]);
    expect(rows[0]!.addresses).toEqual(['10.30.1.7', 'fd00::7']);
    await expect(
      sim.call('enroll', {
        tenantId: 'root',
        siteId: 'site_a',
        poolId: 'pool_agentless',
        addresses: ['machine.example'],
        bmc: { address: 'https://10.10.0.45', driver: 'ipmi', credentials: 'secret://root/bmc' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it("checks a driver the table does not know against what the site's agents report", async () => {
    sim = await createMetalSim();
    await sim.addSiteAgent(AGENT);
    // The agent's Hello says its acme driver serves power only (bc.dev/driver-kind labels, 14ceb1e).
    await sim.db.query(`INSERT INTO node_labels (node_id, key, value, source) VALUES ($1, 'bc.dev/driver-kind.acme.power', '1', 'system')`, [AGENT]);
    await expect(
      sim.call('enroll', {
        tenantId: 'root',
        siteId: 'site_a',
        poolId: 'pool_metal',
        macs: ['52:54:00:aa:bb:05'],
        bmc: { address: 'https://10.10.0.41', driver: 'acme', credentials: 'secret://root/bmc' },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED', details: { reason: 'bmc-driver-unsupported', driver: 'acme' } });
  });
});
