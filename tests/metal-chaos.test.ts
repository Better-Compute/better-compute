import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineProfile } from '@better-compute/provision';
import { metalWorkKind, reconcileMetalNode } from '@better-compute/metal';
import { createMetalSim, type MetalSim } from './extensions/metal-sim.js';

// Metal chaos (PLAN.md §16 v0.2 exit "metal-chaos"): a worker or the site agent dies mid-deploy and
// the workflow resumes cleanly, with no destructive step run twice; site agents never get another
// site's steps.

const DESTRUCTIVE = ['bmc.power', 'disk.wipe', 'deploy.image', 'boot.kexec'];
const SITE_A = 'node_s1tea000000000000000000001';
const SITE_B = 'node_s1teb000000000000000000001';

// A deploy that PXE-boots the ramdisk, wipes, and powers the machine off: enough destructive steps.
const wipeDeploy = defineProfile({
  id: 'chaos-deploy',
  version: 1,
  target: 'metal',
  role: 'host',
  steps: [
    { use: 'metal.ensureRamdisk' },
    { use: 'disk.wipe', with: { mode: 'quick' } },
    { use: 'power.setPower', with: { action: 'off' } },
  ],
});

let sim: MetalSim;
let n = 0;

beforeAll(async () => {
  sim = await createMetalSim({ profiles: [wipeDeploy] });
  await sim.addSiteAgent(SITE_A, 'site_a');
});
afterAll(() => sim.close());

async function readyNode(): Promise<string> {
  const node = await sim.call('enroll', {
    tenantId: 'root',
    siteId: 'site_a',
    poolId: 'pool_metal',
    bmc: { address: `https://10.11.0.${++n}`, driver: 'redfish', credentials: 'secret://root/bmc' },
  });
  await sim.settle();
  expect((await sim.state(node.nodeId)).provision_state).toBe('ready');
  return node.nodeId;
}

/** Destructive commands per step attempt of the node's deploy workflow: each must be exactly one. */
async function destructiveCommandsPerStep(nodeId: string) {
  const { rows } = await sim.db.query<{ base: string; n: number }>(
    `SELECT regexp_replace(c.idempotency_key, ':(boot-device|boot-entry-\\d+|power-cycle)$', '') AS base, count(*)::int AS n
       FROM commands c
      WHERE c.kind = ANY($1)
        AND c.idempotency_key LIKE ANY (SELECT 'wf:' || w.id || ':%' FROM workflows w WHERE w.node_id = $2 AND w.profile_id = 'chaos-deploy')
      GROUP BY c.idempotency_key`,
    [DESTRUCTIVE, nodeId],
  );
  return rows;
}

/** A new worker after a crash: the in-memory queue is gone; the level-triggered resync re-queues. */
async function crashAndResync(nodeId: string) {
  sim.queue.clear();
  sim.faults.dropNextResults = 0;
  // Commands whose results were lost are redelivered on the agent's next session (journal resume).
  await sim.db.query(`UPDATE commands SET state = 'pending' WHERE state = 'dispatched'`);
  await sim.context.work.enqueue(sim.db, metalWorkKind, nodeId);
  await sim.context.work.enqueue(sim.db, 'workflow', nodeId);
}

describe('a worker dies mid-deploy', () => {
  it('resumes from the persisted workflow; no destructive command is sent twice', async () => {
    const node = await readyNode();
    await sim.call('deploy', { tenantId: 'root', nodeId: node, profileId: 'chaos-deploy', profileVersion: 1 });
    // The worker gets a few rounds in, then dies: its queue is lost and so are two results.
    sim.faults.dropNextResults = 2;
    for (let i = 0; i < 4; i++) {
      await sim.runAgents();
      const due = [...sim.queue.values()];
      sim.queue.clear();
      for (const item of due)
        if (item.kind === 'workflow') await sim.provision.reconcilers![0]!.run({ ...sim.context, signal: new AbortController().signal } as never, item.key);
        else await reconcileMetalNode(sim.context, item.key);
    }
    expect((await sim.state(node)).provision_state).toBe('deploying');
    await crashAndResync(node);
    await sim.settle();
    expect(await sim.state(node)).toMatchObject({ provision_state: 'deployed', maintenance: false });
    const perStep = await destructiveCommandsPerStep(node);
    expect(perStep.length).toBeGreaterThan(0);
    expect(perStep.every((row) => row.n === 1)).toBe(true);
    // No step needed a retry: resumption is not a re-run.
    const retried = await sim.db.query(
      `SELECT 1 FROM workflow_steps s JOIN workflows w ON w.id = s.workflow_id WHERE w.node_id = $1 AND w.profile_id = 'chaos-deploy' AND s.attempt > 0`,
      [node],
    );
    expect(retried.rowCount).toBe(0);
  });

  it('survives dying at every point of the deploy', async () => {
    for (let crashAfter = 1; crashAfter <= 6; crashAfter++) {
      const node = await readyNode();
      await sim.call('deploy', { tenantId: 'root', nodeId: node, profileId: 'chaos-deploy', profileVersion: 1 });
      await sim.settle(crashAfter);
      await crashAndResync(node);
      await sim.settle();
      expect((await sim.state(node)).provision_state, `crash after ${crashAfter} rounds`).toBe('deployed');
      expect((await destructiveCommandsPerStep(node)).every((row) => row.n === 1)).toBe(true);
    }
  });
});

describe('the site agent dies mid-deploy', () => {
  it('holds its steps while it is gone and finishes when it is back, without duplicates', async () => {
    const node = await readyNode();
    await sim.call('deploy', { tenantId: 'root', nodeId: node, profileId: 'chaos-deploy', profileVersion: 1 });
    await sim.settle(2);
    sim.faults.siteAgentDown = true;
    await sim.disconnect(SITE_A);
    await sim.settle(20);
    expect((await sim.state(node)).provision_state).toBe('deploying');
    sim.faults.siteAgentDown = false;
    await sim.connect(SITE_A, 'site', 'site-restarted');
    await crashAndResync(node);
    await sim.settle();
    expect((await sim.state(node)).provision_state).toBe('deployed');
    expect((await destructiveCommandsPerStep(node)).every((row) => row.n === 1)).toBe(true);
  });
});

describe('site isolation', () => {
  it("never routes a machine's site steps to another site's agent", async () => {
    await sim.addSiteAgent(SITE_B, 'site_b');
    const node = await readyNode();
    // Only site_b's agent is up: the machine's site steps wait instead of going there.
    sim.faults.siteAgentDown = true;
    await sim.disconnect(SITE_A);
    await sim.call('deploy', { tenantId: 'root', nodeId: node, profileId: 'chaos-deploy', profileVersion: 1 });
    await sim.settle(20);
    const toB = await sim.db.query('SELECT 1 FROM commands WHERE node_id = $1', [SITE_B]);
    expect(toB.rowCount).toBe(0);
    expect((await sim.state(node)).provision_state).toBe('deploying');
    sim.faults.siteAgentDown = false;
    await sim.connect(SITE_A, 'site', 'site-back');
    await crashAndResync(node);
    await sim.settle();
    expect((await sim.state(node)).provision_state).toBe('deployed');
    expect((await sim.db.query('SELECT 1 FROM commands WHERE node_id = $1', [SITE_B])).rowCount).toBe(0);
  });
});
