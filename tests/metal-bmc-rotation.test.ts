import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineProfile } from '@better-compute/provision';
import { createMetalSim, type MetalSim } from './extensions/metal-sim.js';

// BMC credential rotation (PLAN.md §3.5, §13), two-phase: the new password becomes current only
// after the site agent applied it, logged in with it and signed that; otherwise the old one stays.

const SITE_AGENT = 'node_s1tea000000000000000000003';
const rotate = defineProfile({ id: 'rotate-bmc', version: 1, target: 'metal', steps: [{ use: 'metal.rotateBmcCredential' }] });
const probe = defineProfile({ id: 'probe-bmc', version: 1, target: 'metal', steps: [{ use: 'power.getPower' }] });

let sim: MetalSim;
let n = 0;

beforeAll(async () => {
  sim = await createMetalSim({ profiles: [rotate, probe] });
  await sim.addSiteAgent(SITE_AGENT, 'site_a');
});
afterAll(() => sim.close());
beforeEach(() => {
  Object.assign(sim.faults, { rotateRejected: false, rotateLoginFails: false, rotateUnsigned: false });
});

async function readyNode(): Promise<string> {
  const node = await sim.call('enroll', {
    tenantId: 'root',
    siteId: 'site_a',
    poolId: 'pool_metal',
    bmc: { address: `https://10.13.0.${++n}`, driver: 'redfish', credentials: 'secret://root/bmc-initial' },
  });
  await sim.settle();
  return node.nodeId;
}

/** Runs a profile on the node, as an operator workflow would, and returns the workflow's end state. */
async function run(nodeId: string, profileId: string): Promise<string> {
  const { id } = await sim.db.transaction((tx) =>
    sim.context.workflows!.start(tx, { tenantId: 'root', profileId, profileVersion: 1, nodeId } as never),
  );
  await sim.settle();
  const { rows } = await sim.db.query<{ state: string }>('SELECT state FROM workflows WHERE id = $1', [id]);
  return rows[0]!.state;
}

const versions = async (nodeId: string) =>
  (
    await sim.db.query<{ version: number; ref: string; state: string; purged: boolean }>(
      'SELECT version, ref, state, purged_at IS NOT NULL AS purged FROM bmc_credential_versions WHERE node_id = $1 ORDER BY version',
      [nodeId],
    )
  ).rows;
const current = async (nodeId: string) =>
  (await sim.db.query<{ ref: string }>('SELECT bmc_credentials AS ref FROM metal_nodes WHERE node_id = $1', [nodeId])).rows[0]!.ref;
const condition = async (nodeId: string) =>
  (
    await sim.db.query<{ status: string; reason: string | null }>(
      `SELECT status, reason FROM node_conditions WHERE node_id = $1 AND type = 'BmcCredentialRotated'`,
      [nodeId],
    )
  ).rows[0];

describe('metal.rotateBmcCredential', () => {
  it('flips to the new password only after a signed, verified login, and purges the old secret', async () => {
    const node = await readyNode();
    expect(await run(node, 'rotate-bmc')).toBe('succeeded');
    const [old, next] = await versions(node);
    expect(old).toMatchObject({ version: 1, ref: 'secret://root/bmc-initial', state: 'superseded', purged: true });
    expect(next).toMatchObject({ version: 2, state: 'current', purged: false });
    expect(await current(node)).toBe(next!.ref);
    expect(await condition(node)).toEqual({ status: 'True', reason: null });
    // The BMC has the new password; the password itself never travelled in a command.
    const password = sim.secretsStore.get(next!.ref)!;
    expect(password).toMatch(/^.{20}$/);
    expect(sim.machineOf(node).bmcPassword).toBe(password);
    const bodies = await sim.db.query<{ body: Uint8Array }>('SELECT body FROM commands');
    expect(bodies.rows.some((row) => Buffer.from(row.body).toString('utf8').includes(password))).toBe(false);
    // Every later BMC operation uses the new ref (and the BMC would refuse the old one).
    expect(await run(node, 'probe-bmc')).toBe('succeeded');
    const drivers = await sim.db.query<{ drivers: string }>('SELECT drivers::text AS drivers FROM nodes WHERE id = $1', [node]);
    expect(drivers.rows[0]!.drivers).not.toContain('bmc-initial');
  });

  it('rotates again from a rotated credential', async () => {
    const node = await readyNode();
    await run(node, 'rotate-bmc');
    expect(await run(node, 'rotate-bmc')).toBe('succeeded');
    expect((await versions(node)).map((v) => v.state)).toEqual(['superseded', 'superseded', 'current']);
    expect(await run(node, 'probe-bmc')).toBe('succeeded');
  });

  for (const [fault, why] of [
    ['rotateRejected', 'the BMC refuses the password'],
    ['rotateLoginFails', 'the login with the new password fails'],
    ['rotateUnsigned', 'the site agent does not sign the result'],
  ] as const)
    it(`keeps the old credential current when ${why}`, async () => {
      const node = await readyNode();
      sim.faults[fault] = true;
      expect(await run(node, 'rotate-bmc')).toBe('failed');
      sim.faults[fault] = false;
      expect(await current(node)).toBe('secret://root/bmc-initial');
      const [kept, failed] = await versions(node);
      expect(kept).toMatchObject({ version: 1, ref: 'secret://root/bmc-initial', state: 'current' });
      // A failed version keeps its secret: the BMC may hold it if only the answer was lost.
      expect(failed).toMatchObject({ version: 2, state: 'failed', purged: false });
      expect(sim.secretsStore.has(failed!.ref)).toBe(true);
      expect((await condition(node))?.status).toBe('False');
      if (fault === 'rotateRejected') expect(await run(node, 'probe-bmc')).toBe('succeeded');
    });
});
