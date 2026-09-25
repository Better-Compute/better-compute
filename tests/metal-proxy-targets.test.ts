import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { metalNodeSpec, siteProxyTargets } from '@better-compute/metal';
import { createMetalSim, type MetalSim } from './extensions/metal-sim.js';

// What site.httpProxy may reach through a site agent (review 7, HIGH-1): the agentless machines of its
// site with their own addresses, never a BMC, deterministic for the spec hash.

const AGENT = 'node_s1tea000000000000000000003';
let sim: MetalSim;
let oob: string;
let hosted: string;

beforeAll(async () => {
  sim = await createMetalSim();
  await sim.addSiteAgent(AGENT, 'site_a');
  await sim.db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, sharing, agent, policy, version)
     VALUES ('pool_oob', 'root', 'site_a', 'metal-host', 'exclusive', 'none', '{}', 1)`,
  );
  const enroll = async (poolId: string, n: number) =>
    (
      await sim.call('enroll', {
        tenantId: 'root',
        siteId: 'site_a',
        poolId,
        bmc: { address: `https://10.30.0.${n}`, driver: 'redfish', credentials: 'secret://root/bmc' },
      })
    ).nodeId as string;
  oob = await enroll('pool_oob', 1);
  hosted = await enroll('pool_metal', 2);
  // Inspection found the machines' own addresses (and, by mistake, the BMC's).
  await sim.db.query(`UPDATE metal_nodes SET addresses = $2 WHERE node_id = $1`, [oob, ['10.40.0.9', '10.30.0.1', '10.40.0.8', '10.40.0.9']]);
  await sim.db.query(`UPDATE metal_nodes SET addresses = $2 WHERE node_id = $1`, [hosted, ['10.40.0.20']]);
});
afterAll(() => sim.close());

describe('site.proxyTargets', () => {
  it('lists the agentless machines of the site with their own addresses, sorted, never a BMC', async () => {
    expect(await siteProxyTargets(sim.db, AGENT)).toEqual([{ nodeId: oob, addresses: ['10.40.0.8', '10.40.0.9'] }]);
    // Only site agents get the field.
    expect(await metalNodeSpec(sim.context, { id: AGENT, role: 'site' } as never)).toEqual({
      site: { proxyTargets: [{ nodeId: oob, addresses: ['10.40.0.8', '10.40.0.9'] }] },
    });
    expect(await metalNodeSpec(sim.context, { id: hosted, role: 'host' } as never)).toEqual({});
  });

  it('drops a retired machine, and an agent of another site sees none of these', async () => {
    await sim.db.query(`UPDATE nodes SET provision_state = 'retired' WHERE id = $1`, [oob]);
    expect(await siteProxyTargets(sim.db, AGENT)).toEqual([]);
    expect(await siteProxyTargets(sim.db, hosted)).toEqual([]);
  });
});
