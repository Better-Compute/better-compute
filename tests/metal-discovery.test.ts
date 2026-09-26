import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { addImageSigner, createProfile, defineProfile, imageSigningInput, registerImage } from '@better-compute/provision';
import {
  discoveredEntries,
  isMatchableUuid,
  metalDiscoveryStatusHandler,
  metalWorkKind,
  normalizeUuid,
  reconcileMetalNode,
  unmetBmcNeeds,
  uuidSpellings,
} from '@better-compute/metal';
import { tickSiteBoot } from '@better-compute/server';
import { createMetalSim, type MetalSim } from './extensions/metal-sim.js';

// PXE discovery and sanboot (PLAN.md §3.5; seams e763001, bcd 0056e1e). A site agent lists the machines it
// saw PXE-booting with no boot entry (StatusReport.discovered). metal stores each agent's list and serves
// it per site (metal.discovered). It fills the PXE MAC of an enrolled machine that has none when its
// product UUID, in any of its byte orders, was seen from exactly one MAC; ambiguous and placeholder UUIDs
// never match. A driver without virtual media (ipmi) boots a catalog ISO with iPXE sanboot from the site
// cache instead of media.insert.

const AGENT = 'node_siteagent00000000000000001';
const OTHER_AGENT = 'node_siteagent00000000000000002';
const HOST = 'node_hostnode000000000000000001';
let sim: MetalSim | undefined;
afterEach(async () => {
  await sim?.close();
  sim = undefined;
});

// A UUID as a BMC (Redfish, `ipmitool mc guid`) prints it, and as DHCP option 97 carries it (SMBIOS ≥ 2.6:
// the first three fields little-endian).
const BMC_UUID = '4c4c4544-0042-3510-8052-b4c04f365931';
const DHCP_UUID = '44454c4c-4200-1035-8052-b4c04f365931';

const seconds = (ms: number) => ({ seconds: BigInt(Math.floor(ms / 1000)), nanos: 0 });
const machine = (mac: string, productUuid = '', extra: Record<string, unknown> = {}) =>
  ({ mac, productUuid, arch: 'x86_64-efi', firstSeen: seconds(Date.now() - 60_000), lastSeen: seconds(Date.now()), count: 3, relay: '', ...extra }) as never;

/** Runs a status report through the handler as the gateway does. */
async function report(s: MetalSim, handler: ReturnType<typeof metalDiscoveryStatusHandler>, nodeId: string, discovered: unknown[]) {
  return s.db.transaction((tx) => handler(tx, { nodeId, events: s.context.events, work: s.context.work }, { discovered } as never));
}

const enrollIpmi = (s: MetalSim, extra: Record<string, unknown> = {}) =>
  s.call('enroll', {
    tenantId: 'root',
    siteId: 'site_a',
    poolId: 'pool_metal',
    bmc: { address: `https://10.20.0.${Math.floor(Math.random() * 200) + 1}`, driver: 'ipmi', credentials: 'secret://root/bmc' },
    ...extra,
  });

describe('UUID spellings', () => {
  it('normalizes and spells a UUID in the byte orders a BMC and a PXE client use', () => {
    expect(normalizeUuid('{4C4C4544-0042-3510-8052-B4C04F365931}')).toBe(BMC_UUID);
    expect(normalizeUuid('4c4c454400423510 8052b4c04f365931')).toBeUndefined();
    expect(uuidSpellings(BMC_UUID)).toContain(DHCP_UUID);
    expect(uuidSpellings(DHCP_UUID)).toContain(BMC_UUID);
    expect(uuidSpellings(BMC_UUID)).toContain('3159364f-c0b4-5280-1035-420044454c4c');
    expect(isMatchableUuid('03000200-0400-0500-0006-000700080009')).toBe(false);
    expect(isMatchableUuid('00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(isMatchableUuid(BMC_UUID)).toBe(true);
  });

  it('keeps only well-formed entries of a report, one per MAC', () => {
    const entries = discoveredEntries([
      machine('52:54:00:AA:00:01', DHCP_UUID.toUpperCase(), { relay: '10.1.0.1', arch: 'bios' }),
      machine('52-54-00-aa-00-01'),
      machine('not-a-mac'),
      machine('52:54:00:aa:00:02', 'nonsense', { relay: 'evil.example', arch: 'x'.repeat(40), count: -5 }),
    ]);
    expect(entries.map((e) => e.mac).sort()).toEqual(['52:54:00:aa:00:01', '52:54:00:aa:00:02']);
    const first = entries.find((e) => e.mac === '52:54:00:aa:00:01')!;
    expect(first).toMatchObject({ productUuid: DHCP_UUID, relay: '10.1.0.1', arch: 'bios', count: 3 });
    const second = entries.find((e) => e.mac === '52:54:00:aa:00:02')!;
    expect(second.productUuid).toBeUndefined();
    expect(second.relay).toBeUndefined();
    expect(second).toMatchObject({ arch: '', count: 0 });
  });
});

describe('the discovery status handler', () => {
  it("stores a site agent's list, lists it per site for its owner only, and ignores other nodes", async () => {
    sim = await createMetalSim();
    const s = sim;
    await s.addSiteAgent(AGENT);
    await s.addSiteAgent(OTHER_AGENT);
    await s.db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity, trust,
         generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, 'site_a', 'pool_metal', 'root', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 0, 0, 1)`,
      [HOST],
    );
    const handler = metalDiscoveryStatusHandler();
    // A host listing machines is never stored.
    expect(await report(s, handler, HOST, [machine('52:54:00:aa:00:09', DHCP_UUID)])).toBeUndefined();
    expect(await report(s, handler, AGENT, [machine('52:54:00:aa:00:01', DHCP_UUID), machine('52:54:00:aa:00:02')])).toEqual({ stored: 2, matched: 0 });
    expect(await report(s, handler, OTHER_AGENT, [machine('52:54:00:aa:00:01', DHCP_UUID, { relay: '10.9.0.1' })])).toEqual({ stored: 1, matched: 0 });
    const listed = await s.call('discovered', { tenantId: 'root', siteId: 'site_a' });
    expect(listed.machines.map((m: { mac: string }) => m.mac)).toEqual(['52:54:00:aa:00:01', '52:54:00:aa:00:02']);
    expect(listed.machines[0]).toMatchObject({ productUuid: DHCP_UUID, count: 6, relays: ['10.9.0.1'], agentNodeIds: [AGENT, OTHER_AGENT] });
    await expect(s.call('discovered', { tenantId: 'someone-else', siteId: 'site_a' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The agent's next list replaces its entries; an empty one clears them.
    await report(s, handler, AGENT, [machine('52:54:00:aa:00:02')]);
    await report(s, handler, OTHER_AGENT, []);
    expect((await s.call('discovered', { tenantId: 'root', siteId: 'site_a' })).machines.map((m: { mac: string }) => m.mac)).toEqual(['52:54:00:aa:00:02']);
    expect((await s.db.query('SELECT 1 FROM metal_discovered WHERE agent_node_id = $1', [HOST])).rowCount).toBe(0);
  });

  it('fills the MAC of an IPMI machine enrolled with its UUID only, at enroll, and publishes it', async () => {
    sim = await createMetalSim();
    const s = sim;
    await s.addSiteAgent(AGENT);
    const handler = metalDiscoveryStatusHandler();
    await report(s, handler, AGENT, [machine('52:54:00:aa:01:01', DHCP_UUID)]);
    const enrolled = await enrollIpmi(s, { productUuid: BMC_UUID.toUpperCase() });
    expect(enrolled.macs).toEqual(['52:54:00:aa:01:01']);
    expect(s.events.find((e) => e.type === 'node.pxe-mac.discovered')).toMatchObject({
      subject: `node/${enrolled.nodeId}`,
      data: { mac: '52:54:00:aa:01:01', productUuid: BMC_UUID, agentNodeId: AGENT, siteId: 'site_a' },
    });
    const listed = await s.call('discovered', { tenantId: 'root', siteId: 'site_a' });
    expect(listed.machines[0]).toMatchObject({ mac: '52:54:00:aa:01:01', nodeId: enrolled.nodeId });
  });

  it('never matches a UUID seen from two MACs, a UUID two machines share, or a placeholder UUID', async () => {
    sim = await createMetalSim();
    const s = sim;
    await s.addSiteAgent(AGENT);
    const handler = metalDiscoveryStatusHandler();
    const placeholder = '03000200-0400-0500-0006-000700080009';
    const shared = '11111111-2222-3333-4444-555555555555';
    await report(s, handler, AGENT, [
      machine('52:54:00:aa:02:01', DHCP_UUID),
      machine('52:54:00:aa:02:02', DHCP_UUID),
      machine('52:54:00:aa:02:03', placeholder),
    ]);
    const spoofed = await enrollIpmi(s, { productUuid: BMC_UUID });
    expect(spoofed.macs).toEqual([]);
    // A placeholder UUID can't stand in for the MACs at all.
    await expect(enrollIpmi(s, { productUuid: placeholder })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    const a = await enrollIpmi(s, { productUuid: shared });
    const b = await enrollIpmi(s, { productUuid: shared });
    await report(s, handler, AGENT, [machine('52:54:00:aa:02:04', shared, { count: 9 })]);
    const macs = await s.db.query<{ macs: string[] }>('SELECT macs FROM metal_nodes WHERE node_id = ANY($1::text[])', [[a.nodeId, b.nodeId, spoofed.nodeId]]);
    expect(macs.rows.map((row) => row.macs)).toEqual([[], [], []]);
    expect(s.events.some((e) => e.type === 'node.pxe-mac.discovered')).toBe(false);
  });

  it('boots a machine known by its UUID: one PXE boot to be discovered, then the ramdisk from its boot entry', async () => {
    sim = await createMetalSim({ pxe: 'boot-server' });
    const s = sim;
    let now = Date.now();
    await useSimClock(s.db, now);
    await s.addSiteAgent(AGENT);
    const handler = metalDiscoveryStatusHandler();
    let ticks = 0;
    const second = async () => {
      now += 1000;
      await setSimClock(s.db, now);
      if (ticks++ % 5 === 0) await s.db.transaction((tx) => tickSiteBoot(tx, 'site_a'));
      await s.runAgents();
      await s.pxeTick();
      const due = [...s.queue.values()];
      s.queue.clear();
      const signal = new AbortController().signal;
      for (const item of due)
        if (item.kind === metalWorkKind) await reconcileMetalNode(s.context, item.key);
        else if (item.kind === 'workflow') await s.provision.reconcilers![0]!.run({ ...s.context, signal } as never, item.key);
    };
    const enrolled = await enrollIpmi(s, { productUuid: BMC_UUID });
    expect(enrolled.macs).toEqual([]);
    const m = s.machineOf(enrolled.nodeId);
    // Until the discovery power cycle, the machine is not asking for DHCP.
    for (let i = 0; i < 120 && !m.pxeWaiting; i++) await second();
    expect(m.pxeWaiting).toBe(true);
    expect(s.seen.some((c) => c.kind === 'boot.prepareRamdisk')).toBe(false);
    // The site agent sees it PXE-booting (no entry answers it) and lists it.
    await report(s, handler, AGENT, [machine(s.macOf(enrolled.nodeId), DHCP_UUID)]);
    for (let i = 0; i < 600 && (await s.state(enrolled.nodeId)).provision_state !== 'ready'; i++) await second();
    expect(await s.state(enrolled.nodeId)).toMatchObject({ provision_state: 'ready' });
    const { rows } = await s.db.query<{ macs: string[] }>('SELECT macs FROM metal_nodes WHERE node_id = $1', [enrolled.nodeId]);
    expect(rows[0]!.macs).toEqual([s.macOf(enrolled.nodeId)]);
    const entry = s.seen.find((c) => c.kind === 'boot.prepareRamdisk')!;
    expect(entry.payload).toMatchObject({ mac: s.macOf(enrolled.nodeId), productUuid: BMC_UUID });
    expect(entry.payload.sanbootSha256).toBeUndefined();
    // Still asking for DHCP after the discovery cycle, it booted the ramdisk from the entry.
    expect(m.bootedBy).toBe(AGENT);
    expect(s.seen.filter((c) => c.kind === 'bmc.power' && c.args.action === 'cycle').length).toBeGreaterThanOrEqual(1);
  });
});

describe('sanboot for a driver without virtual media', () => {
  it('counts a catalog iso as bootable over PXE; a bare url still needs virtual media', () => {
    const profile = (with_: Record<string, unknown>) =>
      defineProfile({ id: 'iso', version: 1, target: 'metal', steps: [{ use: 'media.insert', with: with_ }, { use: 'media.eject' }] });
    const node = { bmc_driver: 'ipmi', hardware_profile: null, pool_policy: null };
    expect(unmetBmcNeeds([profile({ image: 'installer@1' })], node)).toEqual([]);
    expect(unmetBmcNeeds([profile({ url: 'https://cache/os.iso' })], node)).toEqual([
      { profile: 'iso@1', step: 'media.insert', operations: ['virtual-media.insert'] },
    ]);
  });

  it('pins the ISO, waits until the site caches it, then sanboots it from PXE and removes the entry at eject', async () => {
    sim = await createMetalSim();
    const s = sim;
    await s.addSiteAgent(AGENT);
    const signer = generateKeyPairSync('ed25519');
    const sha256 = '5a'.repeat(32);
    await s.db.transaction(async (tx) => {
      await addImageSigner(tx, { tenantId: 'root', id: 'platform', algorithm: 'ed25519', publicKey: signer.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
      const input = { ref: 'installer@1', format: 'iso' as const, sha256, source: 'https://images.example.com/installer.iso' };
      await registerImage(tx, undefined, 'root', 'root', {
        ...input,
        signature: sign(null, imageSigningInput(input), signer.privateKey).toString('base64'),
        signerId: 'platform',
      });
    });
    const enrolled = await enrollIpmi(s, { macs: ['52:54:00:aa:03:01'] });
    await s.settle();
    expect(await s.state(enrolled.nodeId)).toMatchObject({ provision_state: 'ready' });
    const isoInstall = defineProfile({
      id: 'iso-install',
      version: 1,
      target: 'metal',
      steps: [
        { use: 'media.insert', with: { image: 'installer@1' } },
        { use: 'management.setBootDevice', with: { device: 'cd' } },
        { use: 'power.setPower', with: { action: 'cycle' } },
        { use: 'media.eject' },
      ],
    });
    await s.db.transaction((tx) => createProfile(tx, undefined, 'root', { document: isoInstall }));
    await s.call('deploy', { tenantId: 'root', nodeId: enrolled.nodeId, profileId: 'iso-install', profileVersion: 1 });
    await s.settle();
    // Pinned at the site (its agents' cacheImages), but no entry until a site agent holds it verified.
    const image = (await s.db.query<{ id: string }>('SELECT id FROM images WHERE sha256 = $1', [sha256])).rows[0]!;
    expect((await s.db.query('SELECT 1 FROM provision_image_pins WHERE image_id = $1 AND site_id = $2', [image.id, 'site_a'])).rowCount).toBe(1);
    expect(s.seen.some((c) => c.kind === 'boot.prepareRamdisk' && c.payload.sanbootSha256)).toBe(false);
    await s.db.query(`INSERT INTO image_locations (image_id, site_id, state) VALUES ($1, 'site_a', 'ready')`, [image.id]);
    // The engine polls a not-ready step again: wake it.
    const { rows: wf } = await s.db.query<{ id: string }>(`SELECT id FROM workflows WHERE profile_id = 'iso-install'`);
    await s.context.work.enqueue(undefined as never, 'workflow', wf[0]!.id);
    await s.settle();
    const entry = s.seen.find((c) => c.kind === 'boot.prepareRamdisk' && c.payload.sanbootSha256)!;
    expect(entry.payload).toMatchObject({ mac: '52:54:00:aa:03:01', sanbootSha256: Buffer.from(sha256, 'hex').toString('base64') });
    expect(entry.payload.discoveryTokenRef).toBeUndefined();
    // No virtual media reached the BMC; the "CD" boot is a PXE boot.
    expect(s.seen.some((c) => c.payload.operation?.startsWith('virtual-media.'))).toBe(false);
    const bootDevices = s.seen.filter((c) => c.payload.operation === 'management.setBootDevice').map((c) => c.args.device);
    expect(bootDevices.at(-1)).toBe('pxe');
    expect(s.seen.some((c) => c.kind === 'boot.cleanUp' && c.payload.workflowId === wf[0]!.id)).toBe(true);
    expect((await s.db.query('SELECT 1 FROM provision_image_pins WHERE workflow_id = $1', [wf[0]!.id])).rowCount).toBe(0);
  });
});
