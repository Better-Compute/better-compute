import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batchSubject, metalBatchScope, metalCommandKinds, releaseProfile, retireProfile } from '@better-compute/metal';
import { defineStep, profileCommandKinds } from '@better-compute/provision';
import { manifest } from '@better-compute/core';
import { commandKinds, isCommandKind } from '@better-compute/protocol';
import { createMetalSim, type MetalSim } from './extensions/metal-sim.js';

// Batches of destructive metal work (PLAN.md §13, the v1.0 quorum): the kinds a profile can send,
// known before it runs (agent steps' `command`, control-plane steps' `sends`, enforced by the engine),
// and the approval scope over the machines, with BMC operations bound to each machine's BMC.

let sim: MetalSim;
const nodes: string[] = [];
const AGENT = 'node_s1tea000000000000000000003';

beforeAll(async () => {
  sim = await createMetalSim();
  await sim.addSiteAgent(AGENT, 'site_a');
  for (const n of [1, 2]) {
    const node = await sim.call('enroll', {
      tenantId: 'root',
      siteId: 'site_a',
      poolId: 'pool_metal',
      bmc: { address: `https://10.20.0.${n}`, driver: 'redfish', credentials: 'secret://root/bmc' },
    });
    nodes.push(node.nodeId as string);
  }
  await sim.settle();
});
afterAll(() => sim.close());

const steps = () => sim.provision.engineOptions.steps;
/** The registry's kind lookup: the protocol's kinds and the ones metal registers, as the server's registry serves them. */
const metalKinds = new Map(metalCommandKinds.map((spec) => [spec.kind, spec]));
const registry = {
  commandKind: (kind: string) => metalKinds.get(kind) ?? (isCommandKind(kind) ? (commandKinds[kind] as never) : undefined),
};

describe('batch scope', () => {
  it('knows every kind a profile can send, from its steps’ declarations', async () => {
    expect(await profileCommandKinds(releaseProfile, steps())).toEqual(['bmc.boot', 'bmc.power', 'boot.cleanUp', 'boot.prepareRamdisk', 'disk.wipe']);
    expect(await profileCommandKinds(retireProfile, steps())).toContain('disk.wipe');
  });

  it('scopes the destructive kinds per machine, BMC operations to the machine’s BMC', async () => {
    const kinds = await profileCommandKinds(releaseProfile, steps());
    const scope = await sim.db.transaction((tx) => metalBatchScope(tx, registry, nodes, kinds));
    // The boot device counts: attacker boot media plus any power cycle is a reimage (review #6).
    // BMC leaves name the relaying site agent (addresses are site-local): one per agent of the site.
    expect(scope).toEqual(
      [
        { subject: `bmc:${AGENT}/https://10.20.0.1`, kind: 'bmc.boot' },
        { subject: `bmc:${AGENT}/https://10.20.0.1`, kind: 'bmc.power' },
        { subject: `bmc:${AGENT}/https://10.20.0.2`, kind: 'bmc.boot' },
        { subject: `bmc:${AGENT}/https://10.20.0.2`, kind: 'bmc.power' },
        { subject: nodes[0]!, kind: 'disk.wipe' },
        { subject: nodes[1]!, kind: 'disk.wipe' },
      ].sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : a.kind < b.kind ? -1 : 1)),
    );
    // Non-destructive kinds (the site's boot entries) are not held by the quorum.
    expect(scope.some((leaf) => leaf.kind.startsWith('boot.'))).toBe(false);
    await expect(sim.db.transaction((tx) => metalBatchScope(tx, registry, ['node_not_metal'], kinds))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(batchSubject('site.httpProxy', { nodeId: 'node_x', bmcAddress: 'x' })).toBe('node:node_x');
    expect(() => batchSubject('bmc.power', { nodeId: 'node_x', bmcAddress: 'x' })).toThrow(/site agent/);
  });

  it('metal.bulk: one batch over the verb’s chain, carried by its destructive commands only, until the nodes rest', async () => {
    expect((await Promise.all(nodes.map((id) => sim.state(id)))).map((s) => s.provision_state)).toEqual(['ready', 'ready']);
    // Enrolling already ran each machine's workflows under a batch of their own (one node each).
    const before = sim.batches.length;
    expect(before).toBeGreaterThan(0);
    expect(sim.batches.every((batch) => new Set(batch.input.scope.map((leaf) => leaf.subject.replace(/^bmc:[^/]+\//, ''))).size <= 2)).toBe(true);
    const result = await sim.call('bulk', { tenantId: 'root', poolId: 'pool_metal', verb: 'retire', nodeIds: nodes, reason: 'decommission rack 7' });
    expect(result.batch).toMatchObject({ held: false });
    const batchId = result.batch.batchId as string;
    expect(sim.batches).toHaveLength(before + 1);
    expect(result.nodes.map((node: { provisionState: string }) => node.provisionState)).toEqual(['retiring', 'retiring']);
    const created = sim.batches.at(-1);
    expect(created!.batchId).toBe(batchId);
    expect(created!.input).toMatchObject({ tenantId: 'root', reason: 'decommission rack 7' });
    // The retire profile's destructive kinds, per machine: boot device and power through its BMC, the wipe on it.
    expect(created!.input.scope).toHaveLength(6);
    const { rows: parked } = await sim.db.query<{ batch_id: string | null }>('SELECT batch_id FROM metal_nodes WHERE node_id = ANY($1::text[])', [nodes]);
    expect(parked.map((row) => row.batch_id)).toEqual([batchId, batchId]);

    await sim.settle();
    expect((await Promise.all(nodes.map((id) => sim.state(id)))).map((s) => s.provision_state)).toEqual(['retired', 'retired']);
    // Every destructive command of the workflows carried the batch, nothing else did, and all fit its scope.
    const { rows: sent } = await sim.db.query<{ id: string; kind: string }>(
      `SELECT c.id, c.kind FROM commands c JOIN workflows w ON c.idempotency_key LIKE 'wf:' || w.id || ':%'
        WHERE w.node_id = ANY($1::text[]) AND w.batch_id = $2`,
      [nodes, batchId],
    );
    const { rows: runs } = await sim.db.query<{ profile_id: string }>('SELECT profile_id FROM workflows WHERE batch_id = $1', [batchId]);
    expect(runs.map((run) => run.profile_id)).toEqual(['metal-retire', 'metal-retire']);
    const destructive = new Set(['bmc.boot', 'bmc.power', 'disk.wipe']);
    expect(sent.some((command) => destructive.has(command.kind))).toBe(true);
    for (const command of sent) expect(sim.commandBatches.get(command.id), command.kind).toBe(destructive.has(command.kind) ? batchId : undefined);
    // The bulk batch replaced the per-workflow one: no batch of its own was made for these runs.
    expect(sim.batches).toHaveLength(before + 1);
    const { rows: rested } = await sim.db.query<{ batch_id: string | null }>('SELECT batch_id FROM metal_nodes WHERE node_id = ANY($1::text[])', [nodes]);
    expect(rested.map((row) => row.batch_id)).toEqual([null, null]);
  });

  it('metal.bulk refuses a verb a node’s state does not allow, before anything changes', async () => {
    const before = sim.batches.length;
    await expect(sim.call('bulk', { tenantId: 'root', poolId: 'pool_metal', verb: 'rescue', nodeIds: nodes, reason: 'x' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(sim.batches).toHaveLength(before);
    await expect(sim.call('bulk', { tenantId: 'root', poolId: 'pool_metal', verb: 'retire', nodeIds: [nodes[0], nodes[0]], reason: 'x' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('takes sends on control-plane steps only (the engine enforces it: provision-engine.test.ts)', () => {
    expect(
      () => defineStep({ id: 'test.agent', runsOn: 'node', command: 'node.reboot', sends: ['x.y'], timeout: '1m', retrySafe: true, input: manifest({}) } as never),
    ).toThrow(/sends/);
    expect(() => defineStep({ id: 'test.bad', runsOn: 'control-plane', sends: ['not a kind'], timeout: '1m', retrySafe: true, input: manifest({}), run: async () => null })).toThrow(
      /sends\[0\]/,
    );
  });
});
