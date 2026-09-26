import { afterEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import { NicsSectionSchema, SystemSectionSchema } from '@better-compute/protocol';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { addImageSigner, createProfile, defineProfile, imageSigningInput, registerImage } from '@better-compute/provision';
import {
  discoveredEntries,
  isMatchableUuid,
  matchDiscoveredMachine,
  metalDiscoveryStatusHandler,
  metalWorkKind,
  normalizeUuid,
  reconcileMetalNode,
  unmetBmcNeeds,
  uuidSpellings,
} from '@better-compute/metal';
import { tickSiteBoot } from '@better-compute/server';
import { createMetalSim, type MetalSim } from './extensions/metal-sim.js';

// PXE discovery and sanboot (PLAN.md §3.5; seams e763001, bcd 0056e1e; review 2 LOW 6).
// - A site agent lists the machines it saw PXE-booting with no boot entry (StatusReport.discovered).
//   metal stores each agent's list and serves it per site (metal.discovered). Storing binds nothing.
// - For a machine enrolled without MACs, metal.ensureRamdisk power-cycles it into PXE with its BMC. A MAC
//   first seen after that cycle under its UUID (any byte order), and the only MAC that UUID was seen from
//   in 24 h, is a candidate. An operator binds it with metal.confirmMac. Only a pool that trusts its
//   provisioning network binds it at once, and then the ramdisk's inventory must match the machine.
// - A driver without virtual media (ipmi) boots a catalog ISO with iPXE sanboot from the site cache.

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
/** A DiscoveredMachine first seen at `at` (default: a minute ago) and last seen now. */
const machine = (mac: string, productUuid = '', extra: Record<string, unknown> = {}, at = Date.now() - 60_000) =>
  ({ mac, productUuid, arch: 'x86_64-efi', firstSeen: seconds(at), lastSeen: seconds(Math.max(at, Date.now())), count: 3, relay: '', ...extra }) as never;

/** Runs a status report through the handler as the gateway does. */
async function report(s: MetalSim, handler: ReturnType<typeof metalDiscoveryStatusHandler>, nodeId: string, discovered: unknown[]) {
  return s.db.transaction((tx) => handler(tx, { nodeId }, { discovered } as never));
}

let bmcs = 0;
const enrollIpmi = (s: MetalSim, extra: Record<string, unknown> = {}) =>
  s.call('enroll', {
    tenantId: 'root',
    siteId: 'site_a',
    poolId: 'pool_metal',
    bmc: { address: `https://10.20.0.${++bmcs}`, driver: 'ipmi', credentials: 'secret://root/bmc' },
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
  it("stores a site agent's list, binds nothing, lists it for the site owner only, and ignores other nodes", async () => {
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
    expect(await report(s, handler, AGENT, [machine('52:54:00:aa:00:01', DHCP_UUID), machine('52:54:00:aa:00:02')])).toEqual({ stored: 2, changed: true });
    expect(await report(s, handler, AGENT, [machine('52:54:00:aa:00:01', DHCP_UUID), machine('52:54:00:aa:00:02')])).toMatchObject({ stored: 2 });
    expect(await report(s, handler, OTHER_AGENT, [machine('52:54:00:aa:00:01', DHCP_UUID, { relay: '10.9.0.1' })])).toEqual({ stored: 1, changed: true });
    const listed = await s.call('discovered', { tenantId: 'root', siteId: 'site_a' });
    expect(listed.machines.map((m: { mac: string }) => m.mac)).toEqual(['52:54:00:aa:00:01', '52:54:00:aa:00:02']);
    expect(listed.machines[0]).toMatchObject({ productUuid: DHCP_UUID, count: 6, relays: ['10.9.0.1'], agentNodeIds: [AGENT, OTHER_AGENT] });
    await expect(s.call('discovered', { tenantId: 'someone-else', siteId: 'site_a' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // A machine enrolled with that UUID later gets no MAC from the list: discovery data alone binds nothing.
    const enrolled = await enrollIpmi(s, { productUuid: BMC_UUID });
    expect(enrolled).toMatchObject({ macs: [], macSource: 'operator' });
    expect(enrolled.discoveredMac).toBeUndefined();
    // The agent's next list replaces its entries; an empty one clears them.
    await report(s, handler, AGENT, [machine('52:54:00:aa:00:02')]);
    await report(s, handler, OTHER_AGENT, []);
    expect((await s.call('discovered', { tenantId: 'root', siteId: 'site_a' })).machines.map((m: { mac: string }) => m.mac)).toEqual(['52:54:00:aa:00:02']);
    expect((await s.db.query('SELECT 1 FROM metal_discovered WHERE agent_node_id = $1', [HOST])).rowCount).toBe(0);
  });
});

describe('matching a machine metal just power-cycled', () => {
  it('proposes only a MAC first seen after the cycle, the only one its UUID came from, of no other machine', async () => {
    sim = await createMetalSim();
    const s = sim;
    await s.addSiteAgent(AGENT);
    const handler = metalDiscoveryStatusHandler();
    const since = new Date();
    const match = (nodeId: string, trust = false) => s.db.transaction((tx) => matchDiscoveredMachine(tx, { nodeId, since, trust }, { events: s.context.events }));
    const node = await enrollIpmi(s, { productUuid: BMC_UUID });
    // Seen only before the power cycle (a spoofer waiting on the network, or a stale entry): no candidate.
    await report(s, handler, AGENT, [machine('52:54:00:aa:02:01', DHCP_UUID, {}, since.getTime() - 3_600_000)]);
    expect(await match(node.nodeId)).toEqual({ bound: false, reason: 'not-seen' });
    // Seen from that MAC before and from a fresh one now: ambiguous, an operator decides.
    await report(s, handler, AGENT, [
      machine('52:54:00:aa:02:01', DHCP_UUID, {}, since.getTime() - 3_600_000),
      machine('52:54:00:aa:02:02', DHCP_UUID, {}, since.getTime() + 5_000),
    ]);
    expect(await match(node.nodeId)).toEqual({ bound: false, reason: 'ambiguous' });
    // Only the fresh MAC: a candidate, published once, never bound without confirmation.
    await report(s, handler, AGENT, [machine('52:54:00:aa:02:02', DHCP_UUID, {}, since.getTime() + 5_000)]);
    expect(await match(node.nodeId)).toEqual({ mac: '52:54:00:aa:02:02', bound: false });
    expect(await match(node.nodeId)).toEqual({ mac: '52:54:00:aa:02:02', bound: false });
    expect(s.events.filter((e) => e.type === 'node.pxe-mac.discovered')).toMatchObject([
      { subject: `node/${node.nodeId}`, data: { mac: '52:54:00:aa:02:02', bound: false, agentNodeId: AGENT } },
    ]);
    const row = await s.db.query<{ macs: string[]; discovered_mac: string }>('SELECT macs, discovered_mac FROM metal_nodes WHERE node_id = $1', [node.nodeId]);
    expect(row.rows[0]).toEqual({ macs: [], discovered_mac: '52:54:00:aa:02:02' });
    expect((await s.call('discovered', { tenantId: 'root', siteId: 'site_a' })).machines[0]).toMatchObject({ candidateFor: node.nodeId });
    // Another enrolled machine with the same UUID: neither gets a candidate.
    const twin = await enrollIpmi(s, { productUuid: DHCP_UUID });
    expect(await match(twin.nodeId)).toEqual({ bound: false, reason: 'shared-uuid' });
    // A placeholder UUID never stands in for the MACs at all.
    await expect(enrollIpmi(s, { productUuid: '03000200-0400-0500-0006-000700080009' })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('binds by hand: metal.confirmMac, audited, refused for a MAC another machine has', async () => {
    sim = await createMetalSim();
    const s = sim;
    await s.addSiteAgent(AGENT);
    const other = await enrollIpmi(s, { macs: ['52:54:00:aa:04:01'] });
    const node = await enrollIpmi(s, { productUuid: BMC_UUID });
    await expect(s.call('confirmMac', { tenantId: 'root', nodeId: node.nodeId, mac: '52:54:00:aa:04:01' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(s.call('confirmMac', { tenantId: 'root', nodeId: node.nodeId, mac: 'nope' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const confirmed = await s.call('confirmMac', { tenantId: 'root', nodeId: node.nodeId, mac: '52-54-00-AA-04-02' });
    expect(confirmed).toMatchObject({ macs: ['52:54:00:aa:04:02'], macSource: 'operator' });
    expect(s.events.find((e) => e.type === 'node.pxe-mac.confirmed')).toMatchObject({ data: { mac: '52:54:00:aa:04:02', discovered: false } });
    await expect(s.call('confirmMac', { tenantId: 'root', nodeId: node.nodeId, mac: '52:54:00:aa:04:03' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(s.call('confirmMac', { tenantId: 'root', nodeId: other.nodeId, mac: '52:54:00:aa:04:04' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('booting a machine known only by its UUID', () => {
  /** A boot-server sim (machines PXE-boot only from a live entry) on the sim clock, with one agent. */
  async function bootServer(policy: Record<string, unknown> = {}) {
    const s = (sim = await createMetalSim({ pxe: 'boot-server' }));
    let now = Date.now();
    await useSimClock(s.db, now);
    await s.addSiteAgent(AGENT);
    await s.db.query(
      `INSERT INTO pools (id, owner_tenant_id, site_id, class, sharing, agent, policy, version)
       VALUES ('pool_uuid', 'root', 'site_a', 'metal-host', 'exclusive', 'bcd', $1::jsonb, 1)`,
      [JSON.stringify(policy)],
    );
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
    const until = async (done: () => Promise<boolean> | boolean, limit = 600) => {
      for (let i = 0; i < limit && !(await done()); i++) await second();
    };
    const enrolled = await enrollIpmi(s, { poolId: 'pool_uuid', productUuid: BMC_UUID });
    const m = s.machineOf(enrolled.nodeId);
    // Until metal's discovery power cycle, the machine is not asking for DHCP.
    await until(() => m.pxeWaiting === true, 120);
    expect(m.pxeWaiting).toBe(true);
    // The site agent sees it PXE-booting (no entry answers it) and lists it, first seen now.
    await report(s, metalDiscoveryStatusHandler(), AGENT, [machine(s.macOf(enrolled.nodeId), DHCP_UUID, {}, now)]);
    return { s, m, nodeId: enrolled.nodeId as string, second, until, now: () => now };
  }
  const nodeRow = (s: MetalSim, nodeId: string) =>
    s.db
      .query<{ macs: string[]; mac_source: string; discovered_mac: string | null; last_error: unknown }>(
        'SELECT macs, mac_source, discovered_mac, last_error FROM metal_nodes WHERE node_id = $1',
        [nodeId],
      )
      .then((r) => r.rows[0]!);

  it('waits for metal.confirmMac by default, then boots the ramdisk from the confirmed MAC', async () => {
    const { s, m, nodeId, until } = await bootServer();
    await until(async () => (await nodeRow(s, nodeId)).discovered_mac !== null, 60);
    expect(await nodeRow(s, nodeId)).toMatchObject({ macs: [], discovered_mac: s.macOf(nodeId) });
    // Nothing boots from a MAC nobody confirmed: no entry, no discovery token.
    await until(() => false, 20);
    expect(s.seen.some((c) => c.kind === 'boot.prepareRamdisk')).toBe(false);
    expect(s.tokenRequests.some((t) => t.role === 'discovery')).toBe(false);
    await s.call('confirmMac', { tenantId: 'root', nodeId, mac: s.macOf(nodeId) });
    await until(async () => (await s.state(nodeId)).provision_state === 'ready');
    expect(await s.state(nodeId)).toMatchObject({ provision_state: 'ready' });
    expect(await nodeRow(s, nodeId)).toMatchObject({ macs: [s.macOf(nodeId)], mac_source: 'operator', discovered_mac: null });
    // Still asking for DHCP after the discovery cycle, it booted the ramdisk from the entry.
    expect(m.bootedBy).toBe(AGENT);
    expect(s.events.find((e) => e.type === 'node.pxe-mac.confirmed')).toMatchObject({ data: { discovered: true } });
  });

  /** The ramdisk's system and nics sections, as the ramdisk reports them after it connected. */
  async function reportInventory(s: MetalSim, nodeId: string, productUuid: string, macs: string[]) {
    const sections = {
      system: toBinary(SystemSectionSchema, create(SystemSectionSchema, { productUuid })),
      nics: toBinary(NicsSectionSchema, create(NicsSectionSchema, { nics: macs.map((mac) => ({ mac })) })),
    };
    for (const [section, content] of Object.entries(sections))
      await s.db.query(
        `INSERT INTO node_inventory_sections (node_id, section, sha256, content) VALUES ($1, $2, $3, $4)
         ON CONFLICT (node_id, section) DO UPDATE SET sha256 = EXCLUDED.sha256, content = EXCLUDED.content, received_at = compute_now()`,
        [nodeId, section, createHash('sha256').update(content).digest('hex'), content],
      );
  }

  it('binds at once on a pool that trusts its provisioning network, and checks the ramdisk is that machine', async () => {
    const { s, m, nodeId, until } = await bootServer({ trustProvisioningNetwork: true });
    await until(() => m.bootedBy === AGENT, 120);
    expect(await nodeRow(s, nodeId)).toMatchObject({ macs: [s.macOf(nodeId)], mac_source: 'discovered' });
    expect(s.events.find((e) => e.type === 'node.pxe-mac.discovered')).toMatchObject({ data: { bound: true } });
    // inventory.refresh waits for the ramdisk's own sections, then compares them.
    await until(() => false, 10);
    expect((await s.state(nodeId)).provision_state).not.toBe('ready');
    await reportInventory(s, nodeId, BMC_UUID, [s.macOf(nodeId), '52:54:00:ff:ff:01']);
    await until(async () => (await s.state(nodeId)).provision_state === 'ready');
    expect(await s.state(nodeId)).toMatchObject({ provision_state: 'ready' });
  });

  it('fails the workflow when the machine that booted from a discovered MAC reports another UUID', async () => {
    const { s, m, nodeId, until } = await bootServer({ trustProvisioningNetwork: true });
    await until(() => m.bootedBy === AGENT, 120);
    await reportInventory(s, nodeId, '11111111-2222-3333-4444-555555555555', [s.macOf(nodeId)]);
    await until(async () => (await s.state(nodeId)).provision_state === 'failed');
    expect(await s.state(nodeId)).toMatchObject({ provision_state: 'failed' });
    expect((await nodeRow(s, nodeId)).last_error).toMatchObject({
      code: 'DRIVER_ERROR',
      message: expect.stringContaining('reports product UUID 11111111-2222-3333-4444-555555555555'),
    });
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
