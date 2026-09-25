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

beforeAll(async () => {
  sim = await createMetalSim();
  await sim.addSiteAgent('node_s1tea000000000000000000003', 'site_a');
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
    expect(scope).toEqual([
      { subject: 'bmc:https://10.20.0.1', kind: 'bmc.power' },
      { subject: 'bmc:https://10.20.0.2', kind: 'bmc.power' },
      { subject: nodes[0], kind: 'disk.wipe' },
      { subject: nodes[1], kind: 'disk.wipe' },
    ].sort((a, b) => (a.subject < b.subject ? -1 : 1)));
    // Non-destructive kinds (boot entries, boot device) are not held by the quorum.
    expect(scope.some((leaf) => leaf.kind === 'bmc.boot' || leaf.kind.startsWith('boot.'))).toBe(false);
    await expect(sim.db.transaction((tx) => metalBatchScope(tx, registry, ['node_not_metal'], kinds))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(batchSubject('site.httpProxy', { nodeId: 'node_x', bmcAddress: 'x' })).toBe('node:node_x');
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
