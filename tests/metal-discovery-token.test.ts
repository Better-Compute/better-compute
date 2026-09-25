import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoveryTokenTtlSeconds } from '@better-compute/metal';
import { createMetalSim, type MetalSim } from './extensions/metal-sim.js';

// The ramdisk's discovery credential (PLAN.md §3.3, §3.5; review finding 8): boot.prepareRamdisk
// mints one single-use `discovery` token per boot entry, bound to that entry's MAC. It reaches the
// site agent only as a secret ref (`ProxyDhcpEntry.discovery_token_ref`), and boot.cleanUp deletes it.

let sim: MetalSim;

beforeAll(async () => {
  sim = await createMetalSim();
  await sim.addSiteAgent('node_s1tea000000000000000000004', 'site_a');
});
afterAll(() => sim.close());

describe('discovery tokens for the ramdisk', () => {
  it('are minted once per entry, bound to its MAC, carried as refs only, and deleted on cleanup', async () => {
    const enrolled = await sim.call('enroll', {
      tenantId: 'root',
      siteId: 'site_a',
      poolId: 'pool_metal',
      bmc: { address: 'https://10.14.0.1', driver: 'redfish', credentials: 'secret://root/bmc' },
    });
    await sim.settle();
    const node = enrolled.nodeId as string;
    expect((await sim.state(node)).provision_state).toBe('ready');

    const { rows } = await sim.db.query<{ macs: string[] }>('SELECT macs FROM metal_nodes WHERE node_id = $1', [node]);
    const mac = rows[0]!.macs[0]!;
    const discovery = sim.tokenRequests.filter((request) => request.role === 'discovery');
    // Inspection boots the ramdisk (commissioning finds it still up): one token per boot entry, not per poll.
    expect(discovery).toHaveLength(1);
    for (const request of discovery)
      expect(request).toMatchObject({
        tenantId: 'root',
        siteId: 'site_a',
        poolId: 'pool_metal',
        ttlSeconds: discoveryTokenTtlSeconds,
        maxUses: 1,
        expect: { mac },
      });

    const entries = sim.seen.filter((command) => command.kind === 'boot.prepareRamdisk');
    expect(entries).toHaveLength(1);
    for (const entry of entries) expect(entry.payload.discoveryTokenRef).toMatch(/^secret:\/\/root\//);
    const minted = sim.tokens.filter((token) => token.startsWith('bcj_discovery'));
    const bodies = await sim.db.query<{ body: Uint8Array }>('SELECT body FROM commands');
    for (const token of minted) expect(bodies.rows.some((row) => Buffer.from(row.body).toString('utf8').includes(token))).toBe(false);
    // The inspection workflow's cleanup removed the entry and deleted its token from the store.
    const ref = entries[0]!.payload.discoveryTokenRef as string;
    expect(sim.secretsStore.has(ref)).toBe(false);
    expect(sim.seen.some((command) => command.kind === 'boot.cleanUp')).toBe(true);
  });
});
