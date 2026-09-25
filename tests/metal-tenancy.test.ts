import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineProfile } from '@better-compute/provision';
import { teardownTenantMetal } from '@better-compute/metal';
import { createMetalSim, type MetalSim } from './extensions/metal-sim.js';

// A deleted tenant's machines are retired (the tenancy teardown's `tenantDeleted` hook): one legal
// transition per sweep until every machine it owns is `retired`, identity revoked.

const SITE = 'node_s1tea00000000000000000000t';
const deploy = defineProfile({
  id: 'tenant-deploy',
  version: 1,
  target: 'metal',
  role: 'host',
  steps: [{ use: 'metal.ensureRamdisk' }, { use: 'power.setPower', with: { action: 'off' } }],
});

let sim: MetalSim;
let n = 0;
async function enroll(): Promise<string> {
  const { nodeId } = await sim.call('enroll', {
    tenantId: 'ten_gone',
    siteId: 'site_a',
    poolId: 'pool_gone',
    bmc: { address: `https://10.16.0.${++n}`, driver: 'redfish', credentials: 'secret://ten_gone/bmc' },
  });
  return nodeId;
}

beforeAll(async () => {
  sim = await createMetalSim({ profiles: [deploy] });
  await sim.addSiteAgent(SITE, 'site_a');
  await sim.db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, sharing, agent, policy, version)
     VALUES ('pool_gone', 'ten_gone', 'site_a', 'metal-host', 'exclusive', 'bcd', '{}', 1)`,
  );
});
afterAll(() => sim.close());

describe('tenantDeleted', () => {
  it('retires every machine the tenant owns, whatever state it is in, and then answers DONE', async () => {
    const ready = await enroll();
    await sim.settle();
    const deployed = await enroll();
    await sim.settle();
    await sim.call('deploy', { tenantId: 'ten_gone', nodeId: deployed, profileId: 'tenant-deploy', profileVersion: 1 });
    await sim.settle();
    const deploying = await enroll();
    await sim.settle();
    await sim.call('deploy', { tenantId: 'ten_gone', nodeId: deploying, profileId: 'tenant-deploy', profileVersion: 1 });
    // Mid-deploy: its workflow started but never finished.
    await sim.settle(1);
    expect((await sim.state(ready)).provision_state).toBe('ready');
    expect((await sim.state(deployed)).provision_state).toBe('deployed');
    expect((await sim.state(deploying)).provision_state).toBe('deploying');

    const hook = sim.bareMetal.tenantDeleted!;
    let sweeps = 0;
    let answer: string;
    do {
      answer = await hook(sim.context as never, 'ten_gone');
      await sim.settle();
      sweeps++;
    } while (answer !== 'DONE' && sweeps < 10);
    expect(answer).toBe('DONE');
    for (const node of [ready, deployed, deploying]) expect((await sim.state(node)).provision_state).toBe('retired');
    // The deployed machine was wiped on the way (a release before the retire's crypto-erase).
    const released = sim.events.filter((event) => event.subject === `node/${deployed}` && event.type === 'node.provision.releasing');
    expect(released.length).toBeGreaterThan(0);
    // A second call finds nothing left.
    expect(await teardownTenantMetal(sim.context, 'ten_gone')).toEqual({ retiring: 0, releasing: 0, aborted: 0, remaining: 0 });
  });

  it('leaves other tenants alone', async () => {
    const { nodeId } = await sim.call('enroll', {
      tenantId: 'root',
      siteId: 'site_a',
      poolId: 'pool_metal',
      bmc: { address: 'https://10.16.1.1', driver: 'redfish', credentials: 'secret://root/bmc' },
    });
    await sim.settle();
    expect(await sim.bareMetal.tenantDeleted!(sim.context as never, 'ten_gone')).toBe('DONE');
    expect((await sim.state(nodeId)).provision_state).toBe('ready');
  });
});
