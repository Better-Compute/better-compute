import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineProfile, provisionFindings } from '@better-compute/provision';
import { metalFindings } from '@better-compute/metal';
import { createMetalSim, type MetalSim } from './extensions/metal-sim.js';

// doctor findings (PLAN.md §14) for the workflow engine and bare metal.

const SITE = 'node_s1tea00000000000000000000f';
const deploy = defineProfile({
  id: 'findings-deploy',
  version: 1,
  target: 'metal',
  role: 'host',
  steps: [{ use: 'metal.ensureRamdisk' }, { use: 'power.setPower', with: { action: 'off' } }],
});

let sim: MetalSim;
let n = 0;
async function readyNode() {
  const { nodeId } = await sim.call('enroll', {
    tenantId: 'root',
    siteId: 'site_a',
    poolId: 'pool_metal',
    bmc: { address: `https://10.15.0.${++n}`, driver: 'redfish', credentials: 'secret://root/bmc' },
  });
  await sim.settle();
  return nodeId as string;
}

beforeAll(async () => {
  sim = await createMetalSim({ profiles: [deploy] });
  await sim.addSiteAgent(SITE, 'site_a');
});
afterAll(() => sim.close());

describe('doctor findings', () => {
  it('is quiet for a healthy site, and names failed machines with their codes', async () => {
    const node = await readyNode();
    expect(await metalFindings(sim.db)).toEqual([]);
    expect(await provisionFindings(sim.db)).toEqual([]);
    expect(await sim.bareMetal.selfCheck!({ sql: sim.db } as never)).toEqual([]);
    // An unsigned wipe fails the release: the machine waits in maintenance.
    await sim.call('deploy', { tenantId: 'root', nodeId: node, profileId: 'findings-deploy', profileVersion: 1 });
    await sim.settle();
    sim.faults.attestWipe = false;
    await sim.call('undeploy', { tenantId: 'root', nodeId: node });
    await sim.settle();
    sim.faults.attestWipe = true;
    const findings = await metalFindings(sim.db);
    expect(findings).toEqual([expect.objectContaining({ check: 'metal-failed', count: 1, severity: 'warning' })]);
    expect(findings[0]!.message).toContain('UNVERIFIED_WIPE');
    await sim.call('recover', { tenantId: 'root', nodeId: node });
    await sim.settle();
    expect(await metalFindings(sim.db)).toEqual([]);
  });

  it('reports machines and workflows nobody is advancing', async () => {
    const node = await readyNode();
    // A deploy is accepted, but no worker runs (the queue is dropped), and time passes.
    await sim.call('deploy', { tenantId: 'root', nodeId: node, profileId: 'findings-deploy', profileVersion: 1 });
    sim.queue.clear();
    await sim.db.query(`UPDATE metal_nodes SET updated_at = compute_now() - interval '1 hour' WHERE node_id = $1`, [node]);
    expect((await metalFindings(sim.db)).map((finding) => [finding.check, finding.count])).toEqual([['metal-stalled', 1]]);
    // A worker comes back (its resync re-queues the node): the workflow starts, so the machine is no
    // longer stalled; a step stuck past its deadline is.
    await sim.context.work.enqueue(sim.db, 'metal', node);
    await sim.settle(2);
    const { rows } = await sim.db.query<{ workflow_id: string }>('SELECT workflow_id FROM metal_nodes WHERE node_id = $1', [node]);
    expect((await metalFindings(sim.db)).map((finding) => finding.check)).not.toContain('metal-stalled');
    await sim.db.query(
      `UPDATE workflow_steps SET deadline = compute_now() - interval '1 hour' WHERE workflow_id = $1 AND state IN ('running', 'waiting')`,
      [rows[0]!.workflow_id],
    );
    expect((await provisionFindings(sim.db)).map((finding) => [finding.check, finding.count])).toEqual([['workflows-stuck', 1]]);
    expect(await sim.provision.selfCheck!({ sql: sim.db } as never)).toHaveLength(1);
    // The engine fails the overdue step when it next looks; the failure shows up as info.
    await sim.settle();
    const after = await provisionFindings(sim.db);
    expect(after.map((finding) => finding.check)).toEqual(['workflows-failed']);
    expect(after[0]!.severity).toBe('info');
  });
});
