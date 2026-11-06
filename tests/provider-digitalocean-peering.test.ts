import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type ComputeError, type ProviderPeeringSpec } from '@better-compute/core';
import {
  networkDescription,
  peeringName,
  type DoCompute,
} from '@better-compute/provider-digitalocean';
import { DoEmulator, type Json, type RecordedRequest } from './support/do-emulator/index.js';
import { seedPeering } from './support/do-emulator/vpc-peerings.js';
import { seedVpc } from './support/do-emulator/vpcs.js';
import { build, ctx, doAccount, freshBudgets } from './support/do-harness.js';

// provider-digitalocean VPC peerings (P4) against the emulator: subnets of this deployment's
// networks peered by a name that carries the deployment's hash, asynchronous deletes, and a subnet
// that goes only after its peerings of ours.

const t0 = Date.parse('2026-11-05T10:00:00Z');
const emulator = () => new DoEmulator({ now: () => t0 });
const spec: ProviderPeeringSpec = {
  name: 'bc-peer1',
  network: 'bc-net1',
  subnet: 'bc-sub1',
  region: 'nyc3',
  peer: { network: 'bc-net2', subnet: 'bc-sub2', region: 'sfo3' },
};

async function failure(promise: Promise<unknown>): Promise<ComputeError> {
  try {
    await promise;
  } catch (error) {
    if (isComputeError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

const calls = (emu: DoEmulator, method: string, path: RegExp): RecordedRequest[] =>
  emu.requests.filter((r) => r.method === method && path.test(r.url.pathname));
const writes = (emu: DoEmulator) => emu.requests.filter((r) => r.method !== 'GET');

async function setup(emu = emulator()) {
  const a: Json = seedVpc(emu.state, {
    name: 'bc-sub1',
    region: 'nyc3',
    ip_range: '10.31.0.0/24',
    description: networkDescription('bc-net1'),
  });
  const b: Json = seedVpc(emu.state, {
    name: 'bc-sub2',
    region: 'sfo3',
    ip_range: '10.32.0.0/24',
    description: networkDescription('bc-net2'),
  });
  const impl: DoCompute = await build(emu, { ...doAccount, regions: ['nyc3', 'sfo3'] });
  return { emu, impl, a, b };
}

beforeEach(freshBudgets);

describe('provider-digitalocean VPC peerings', () => {
  it('peers two subnets of ours by name, pending until DO sets it up', async () => {
    const { emu, impl, a, b } = await setup();
    const made = await impl.networks.ensurePeering(spec, ctx());
    expect(made).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      state: 'pending',
      outputs: { networks: [a.id, b.id].sort().join(',') },
    });
    expect(calls(emu, 'POST', /^\/v2\/vpc_peerings$/)[0]!.body).toEqual({
      name: peeringName('bc-peer1', 'default'),
      vpc_ids: [a.id, b.id],
    });
    expect(await impl.networks.ensurePeering(spec, ctx())).toMatchObject({
      id: made.id,
      state: 'ready',
    });
    expect(writes(emu)).toHaveLength(1);
  });

  it('a peering of ours under the name between other subnets is INVALID_STATE (replace)', async () => {
    const { emu, impl, a } = await setup();
    const other = seedVpc(emu.state, { name: 'spare', region: 'nyc3', ip_range: '10.33.0.0/24' });
    seedPeering(emu.state, { name: peeringName('bc-peer1', 'default'), vpc_ids: [a.id, other.id] });
    const error = await failure(impl.networks.ensurePeering(spec, ctx()));
    expect([error.code, error.details?.reason]).toEqual(['INVALID_STATE', 'replace']);
    expect(writes(emu)).toHaveLength(0);
  });

  it('refuses a side without a subnet, a foreign VPC, and one subnet twice, before any write', async () => {
    const { emu, impl } = await setup();
    seedVpc(emu.state, { name: 'tenant-vpc', region: 'sfo3', ip_range: '10.40.0.0/24' });
    const refusals: [ProviderPeeringSpec, string, string][] = [
      [{ ...spec, name: 'Bad' }, 'INVALID_INPUT', 'name'],
      [{ ...spec, subnet: undefined }, 'INVALID_INPUT', 'subnet'],
      [{ ...spec, peer: { network: 'bc-net2' } }, 'INVALID_INPUT', 'subnet'],
      [{ ...spec, peer: { ...spec.peer, region: 'ams3' } }, 'INVALID_INPUT', 'region'],
      [
        { ...spec, peer: { network: 'bc-net2', subnet: 'tenant-vpc', region: 'sfo3' } },
        'INVALID_STATE',
        'subnetNetwork',
      ],
      [
        { ...spec, peer: { network: 'bc-net1', subnet: 'bc-sub1', region: 'nyc3' } },
        'INVALID_INPUT',
        'peer',
      ],
    ];
    for (const [bad, code, reason] of refusals) {
      const error = await failure(impl.networks.ensurePeering(bad, ctx()));
      expect([error.code, error.details?.reason], JSON.stringify(bad)).toEqual([code, reason]);
    }
    expect(writes(emu)).toHaveLength(0);
  });

  it('deletes a peering of ours (deleting, then deleted) and never a hand-made one', async () => {
    const { emu, impl, a, b } = await setup();
    const hand = seedPeering(emu.state, { name: 'bc-peer1', vpc_ids: [a.id, b.id] });
    expect(await impl.networks.deletePeering('bc-peer1', ctx())).toEqual({
      id: 'bc-peer1',
      state: 'deleted',
    });
    expect(emu.state.vpcPeerings.has(hand.id)).toBe(true);
    emu.state.vpcPeerings.delete(hand.id);
    const made = await impl.networks.ensurePeering(spec, ctx());
    await impl.networks.ensurePeering(spec, ctx());
    expect(await impl.networks.deletePeering('bc-peer1', ctx())).toEqual({
      id: made.id,
      state: 'deleting',
    });
    expect(await impl.networks.deletePeering('bc-peer1', ctx())).toMatchObject({
      state: 'deleted',
    });
    expect(calls(emu, 'DELETE', /vpc_peerings/)).toHaveLength(1);
  });

  it('deleteSubnet deletes the peerings of ours that join it first; a foreign one keeps it pending', async () => {
    const { emu, impl, a, b } = await setup();
    await impl.networks.ensurePeering(spec, ctx());
    expect((await impl.networks.deleteSubnet('nyc3', 'bc-sub1', ctx())).state).toBe('pending');
    expect(calls(emu, 'DELETE', /vpc_peerings/)).toHaveLength(1);
    expect((await impl.networks.deleteSubnet('nyc3', 'bc-sub1', ctx())).state).toBe('deleted');
    expect(emu.state.vpcs.has(a.id)).toBe(false);
    const other = seedVpc(emu.state, { name: 'spare', region: 'sfo3', ip_range: '10.34.0.0/24' });
    const hand = seedPeering(emu.state, { name: 'their-peering', vpc_ids: [b.id, other.id] });
    const held = await impl.networks.deleteSubnet('sfo3', 'bc-sub2', ctx());
    expect(held).toMatchObject({ state: 'pending', message: expect.stringContaining(hand.id) });
    expect(emu.state.vpcPeerings.has(hand.id)).toBe(true);
  });
});
