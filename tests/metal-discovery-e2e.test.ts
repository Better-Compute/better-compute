import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anyUnpack } from '@bufbuild/protobuf/wkt';
import { AgentRole, Lane, protocolRegistry, type site } from '@better-compute/protocol';
import { metal } from '@better-compute/metal';
import { provisionModule } from '@better-compute/provision';
import { createDevStack, type DevStack, type FakeKind } from '@better-compute/testing';
import { fakeMetalSite, type FakeMetalSite } from './support/metal-fake-site.js';

// PXE discovery end to end (PLAN.md §3.5; review 2 LOW 6), with the real control plane, the real gateway and
// a site agent that is a FakeDaemon:
// 1. An IPMI machine is enrolled with only its product UUID. Its BMC cannot name its NICs.
// 2. metal.ensureRamdisk power-cycles it into PXE with the BMC.
// 3. The site agent reports seeing it (StatusReport.discovered, FakeDaemon.setDiscovered). metal's module
//    status handler, composed into the dev stack's gateway, stores the report.
// 4. The MAC first seen after that cycle becomes a candidate. It gets no boot entry and no token.
// 5. An operator confirms it (metal.confirmMac). Only then does the site agent get the machine's boot entry,
//    with its discovery token.
// The dev stack has no ramdisk to join, so the walkthrough stops at the boot entry (the sim covers the rest:
// tests/metal-discovery.test.ts).

const BMC = 'https://10.20.0.9';
const BMC_UUID = '4c4c4544-0042-3510-8052-b4c04f365931';
// As DHCP option 97 carries it: SMBIOS ≥ 2.6 stores the first three fields little-endian.
const DHCP_UUID = '44454c4c-4200-1035-8052-b4c04f365931';
const MAC = '3c:ec:ef:00:12:34';

let stack: DevStack;
let world: FakeMetalSite;
let siteId: string;
let poolId: string;
let agentId: string;
/** The boot entries the site agent was given (boot.prepareRamdisk), as it decoded them. */
const entries: site.ProxyDhcpEntry[] = [];

beforeAll(async () => {
  const bareMetal = metal();
  stack = await createDevStack({ modules: [provisionModule({ modules: [bareMetal] }), bareMetal] });
  ({ siteId, poolId } = await stack.createPool({ key: 'pxe-discovery' }));
  world = fakeMetalSite();
  const bootEntry: FakeKind = {
    lane: Lane.CONTROL,
    roles: [AgentRole.SITE],
    durationMs: 10,
    run(context) {
      entries.push(anyUnpack(context.body.payload!, protocolRegistry) as site.ProxyDhcpEntry);
      return { outcome: 'succeeded', result: new Uint8Array() };
    },
  };
  [agentId] = (await stack.joinSite({
    siteId,
    kinds: { ...world.kinds, 'boot.prepareRamdisk': bootEntry },
  })) as [string];
}, 90_000);
afterAll(() => stack?.close());

async function until<T>(
  what: string,
  read: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) {
      const commands = await stack.database.query(
        'SELECT kind, state, reason FROM commands ORDER BY seq',
      );
      const workflows = await stack.database.query(
        'SELECT profile_id, state, step_id, error FROM workflows',
      );
      throw new Error(
        `${what}: timed out; commands=${JSON.stringify(commands.rows)} workflows=${JSON.stringify(workflows.rows)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('PXE discovery through the real gateway', () => {
  it('proposes the MAC seen after the BMC power cycle, and boots it only once an operator confirms it', async () => {
    const machine = world.machine(BMC, { macs: [] });
    const api = stack.compute.api as any;
    const enrolled = await api.metal.enroll(stack.root, {
      tenantId: stack.rootTenantId,
      siteId,
      poolId,
      productUuid: BMC_UUID,
      bmc: { address: BMC, driver: 'ipmi', credentials: 'secret://tenant-root/bmc-ipmi' },
    });
    expect(enrolled).toMatchObject({ macs: [], macSource: 'operator' });

    // ensureRamdisk: PXE as the next boot, then the discovery power cycle.
    await until(
      'the discovery power cycle',
      () => machine.bootDevice === 'pxe' && machine.power === 'on',
    );
    // The site agent sees it asking for DHCP from a MAC with no boot entry.
    const now = Date.now();
    stack.daemons
      .get(agentId)!
      .setDiscovered([
        {
          mac: MAC,
          productUuid: DHCP_UUID,
          arch: 'x86_64-efi',
          firstSeen: now,
          lastSeen: now,
          count: 2,
        },
      ]);

    // Stored through the gateway, then proposed as the machine's candidate: not bound, no boot entry.
    const listed = await until('the candidate', async () => {
      const page = await api.metal.discovered(stack.root, { tenantId: stack.rootTenantId, siteId });
      return page.machines.find(
        (m: { mac: string; candidateFor?: string }) =>
          m.mac === MAC && m.candidateFor === enrolled.nodeId,
      );
    });
    expect(listed).toMatchObject({ productUuid: DHCP_UUID, agentNodeIds: [agentId] });
    const row = await stack.database.query<{ macs: string[]; discovered_mac: string | null }>(
      'SELECT macs, discovered_mac FROM metal_nodes WHERE node_id = $1',
      [enrolled.nodeId],
    );
    expect(row.rows[0]).toEqual({ macs: [], discovered_mac: MAC });
    // A few more seconds of polling: still nothing boots from a MAC nobody confirmed.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(entries).toEqual([]);

    // The operator's decision, then the boot entry for exactly that MAC, with its single-use discovery token.
    const confirmed = await api.metal.confirmMac(stack.root, {
      tenantId: stack.rootTenantId,
      nodeId: enrolled.nodeId,
      mac: MAC,
    });
    expect(confirmed).toMatchObject({ macs: [MAC], macSource: 'operator' });
    const entry = await until('the boot entry', () => entries.find((e) => e.mac === MAC));
    expect(entry.discoveryTokenRef).toMatch(/^secret:\/\//);
    expect(entry.sanbootSha256.length).toBe(0);
    expect(entries.every((e) => e.mac === MAC)).toBe(true);
    // Every metal command crossed the gateway to the site agent and came back.
    const { rows } = await stack.database.query<{ kind: string; state: string }>(
      `SELECT kind, state FROM commands WHERE kind LIKE 'bmc.%' OR kind = 'boot.prepareRamdisk'`,
    );
    expect(rows.map((r) => r.kind)).toEqual(
      expect.arrayContaining(['bmc.boot', 'bmc.power', 'boot.prepareRamdisk']),
    );
    expect(rows.every((r) => r.state === 'succeeded')).toBe(true);
  }, 120_000);
});
