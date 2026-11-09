import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MethodContext } from '@better-compute/core';
import { createMetalSim, type MetalSim } from './extensions/metal-sim.js';

// metal.enroll hands `bmc.credentials` to the site agent, which fetches the secret and presents it to
// `bmc.address`. Both come from the caller, so a tenant may name only its own `secret://<tenant>/<id>`:
// never another tenant's or the platform's secrets, and never the control plane's env:// or vault://.

const ACME = 'tenant-acme';
let sim: MetalSim;
let n = 0;

beforeAll(async () => {
  sim = await createMetalSim();
  await sim.db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, sharing, agent, policy, version)
     VALUES ('pool_acme', $1, 'site_a', 'metal-host', 'exclusive', 'bcd', '{}', 1)`,
    [ACME],
  );
});
afterAll(() => sim.close());

const input = (tenantId: string, credentials: unknown) => ({
  tenantId,
  siteId: 'site_a',
  poolId: tenantId === ACME ? 'pool_acme' : 'pool_metal',
  bmc: { address: `https://10.31.0.${++n}`, driver: 'redfish', credentials },
});
/** Enrolls as the envelope would: `callerTenant` is the caller's own tenant (the pre-check lets root act anywhere). */
function enrollAs(callerTenant: string, tenantId: string, credentials: unknown) {
  const definition = sim.api.metal.enroll;
  const context = { ...sim.context, caller: { tenantId: callerTenant } } as unknown as MethodContext;
  return definition.handler(context, definition.validate(input(tenantId, credentials)));
}
const nodes = async () => Number((await sim.db.query<{ n: string }>('SELECT count(*)::text AS n FROM metal_nodes')).rows[0]!.n);

describe('metal.enroll: whose secret bmc.credentials may name', () => {
  for (const ref of [
    'secret://root/bmc',
    'secret://tenant-other/bmc',
    'secret://tenant-acme',
    'secret://tenant-acme/a/b',
    'env://DATABASE_URL',
    'vault://kv/platform/bmc',
  ])
    it(`refuses a tenant naming ${ref}`, async () => {
      const before = await nodes();
      await expect(enrollAs(ACME, ACME, ref)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
      // The same without a caller on the context (an in-process call): the enrolling tenant decides.
      await expect(sim.call('enroll', input(ACME, ref))).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
      expect(await nodes()).toBe(before);
    });

  it("takes the tenant's own secret, and inline credentials stored as the tenant's", async () => {
    const byRef = await enrollAs(ACME, ACME, 'secret://tenant-acme/bmc');
    expect(byRef.bmc.credentialsSet).toBe(true);
    const inline = await enrollAs(ACME, ACME, { username: 'ops', password: 'p' });
    const { rows } = await sim.db.query<{ ref: string }>('SELECT bmc_credentials AS ref FROM metal_nodes WHERE node_id = $1', [inline.nodeId]);
    expect(rows[0]!.ref).toMatch(/^secret:\/\/tenant-acme\//);
  });

  it('lets a root caller name env:// and vault://, for the platform or for a tenant', async () => {
    await expect(enrollAs('root', 'root', 'env://RACK_BMC')).resolves.toMatchObject({ tenantId: 'root' });
    await expect(enrollAs('root', 'root', 'vault://kv/rack/bmc')).resolves.toMatchObject({ tenantId: 'root' });
    await expect(enrollAs('root', ACME, 'env://RACK_BMC')).resolves.toMatchObject({ tenantId: ACME });
    await expect(enrollAs('root', ACME, 'secret://tenant-acme/bmc')).resolves.toMatchObject({ tenantId: ACME });
  });

  it("refuses even a root caller a secret:// that is not the machine's tenant's", async () => {
    await expect(enrollAs('root', ACME, 'secret://tenant-other/bmc')).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await expect(enrollAs('root', ACME, 'secret://root/rack-bmc')).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it('does not treat a tenant named like the root as root when the deployment names another', async () => {
    const context = { ...sim.context, iam: {}, caller: { tenantId: 'root' } } as unknown as MethodContext;
    const definition = sim.api.metal.enroll;
    await expect(definition.handler(context, definition.validate(input('root', 'env://X')))).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it('never sends a BMC command with a stored ref of another tenant (rows from before the check)', async () => {
    await sim.addSiteAgent('node_s1tea000000000000000000009', 'site_a');
    const enrolled = await enrollAs(ACME, ACME, 'secret://tenant-acme/bmc');
    await sim.db.query(`UPDATE metal_nodes SET bmc_credentials = 'secret://root/bmc' WHERE node_id = $1`, [enrolled.nodeId]);
    await sim.settle();
    expect(sim.seen.filter((command) => command.payload.credentialsRef === 'secret://root/bmc')).toEqual([]);
    expect((await sim.state(enrolled.nodeId)).provision_state).toBe('failed');
    await expect(sim.call('power', { tenantId: ACME, nodeId: enrolled.nodeId, action: 'on' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });
});
