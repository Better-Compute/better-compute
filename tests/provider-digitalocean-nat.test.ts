import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type ComputeError } from '@better-compute/core';
import {
  natGatewayName,
  networkDescription,
  type DoCompute,
} from '@better-compute/provider-digitalocean';
import { DoEmulator, type RecordedRequest } from './support/do-emulator/index.js';
import { seedNatGateway } from './support/do-emulator/nat-gateways.js';
import { seedVpc } from './support/do-emulator/vpcs.js';
import { build, ctx, doAccount, freshBudgets } from './support/do-harness.js';

// provider-digitalocean NAT gateways (P4) against the emulator: one per subnet (a DO VPC), named
// with this deployment's hash, pending until DO makes it, and a subnet that goes only after its
// gateway (ordered teardown: deleteSubnet deletes the subnet's gateway of ours first).

const t0 = Date.parse('2026-11-05T10:00:00Z');
const emulator = () => new DoEmulator({ now: () => t0 });
const spec = { name: 'bc-nat1', network: 'bc-net1', subnet: 'bc-sub1', region: 'nyc3' };

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
  const vpc = seedVpc(emu.state, {
    name: 'bc-sub1',
    region: 'nyc3',
    ip_range: '10.20.0.0/24',
    description: networkDescription('bc-net1'),
  });
  const impl: DoCompute = await build(emu, { ...doAccount, regions: ['nyc3', 'sfo3'] });
  return { emu, impl, vpc };
}

beforeEach(freshBudgets);

describe('provider-digitalocean NAT gateways', () => {
  it("makes one gateway on the subnet's VPC, pending until DO makes it", async () => {
    const { emu, impl, vpc } = await setup();
    const made = await impl.networks.ensureNatGateway(spec, ctx());
    expect(made).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      state: 'pending',
      outputs: { region: 'nyc3' },
    });
    expect(calls(emu, 'POST', /^\/v2\/nat_gateways$/)[0]!.body).toEqual({
      name: natGatewayName('bc-nat1', 'default'),
      type: 'PUBLIC',
      region: 'nyc3',
      size: 1,
      vpcs: [{ vpc_uuid: vpc.id, default_gateway: true }],
    });
    const ready = await impl.networks.ensureNatGateway(spec, ctx());
    expect(ready).toEqual({
      id: made.id,
      state: 'ready',
      outputs: {
        region: 'nyc3',
        address: expect.stringMatching(/^203\.0\.113\./),
        gateway: '10.20.0.7',
      },
    });
    expect(writes(emu)).toHaveLength(1);
  });

  it('keeps the oldest of two gateways of ours with one name; a hand-made one is never touched', async () => {
    const { emu, impl, vpc } = await setup();
    const other = seedVpc(emu.state, { name: 'spare', region: 'nyc3', ip_range: '10.21.0.0/24' });
    const name = natGatewayName('bc-nat1', 'default');
    const older = seedNatGateway(emu.state, {
      name,
      region: 'nyc3',
      vpc: vpc.id,
      created_at: '2026-11-05T09:00:00Z',
    });
    const younger = seedNatGateway(emu.state, {
      name,
      region: 'nyc3',
      vpc: other.id,
      created_at: '2026-11-05T09:30:00Z',
    });
    const hand = seedNatGateway(emu.state, {
      name: 'bc-nat1',
      region: 'nyc3',
      vpc: uuidLike(),
      created_at: '2026-11-05T08:00:00Z',
    });
    expect((await impl.networks.ensureNatGateway(spec, ctx())).id).toBe(older.id);
    expect(calls(emu, 'DELETE', /nat_gateways/).map((r) => r.url.pathname)).toEqual([
      `/v2/nat_gateways/${younger.id}`,
    ]);
    expect(emu.state.natGateways.has(hand.id)).toBe(true);
  });

  it('a gateway of ours under the name on another subnet is INVALID_STATE (replace)', async () => {
    const { emu, impl } = await setup();
    const other = seedVpc(emu.state, { name: 'spare', region: 'nyc3', ip_range: '10.21.0.0/24' });
    seedNatGateway(emu.state, {
      name: natGatewayName('bc-nat1', 'default'),
      region: 'nyc3',
      vpc: other.id,
    });
    const error = await failure(impl.networks.ensureNatGateway(spec, ctx()));
    expect([error.code, error.details?.reason]).toEqual(['INVALID_STATE', 'replace']);
    expect(writes(emu)).toHaveLength(0);
  });

  it('refuses a bad name, a region the account does not use and a missing subnet before any write', async () => {
    const { emu, impl } = await setup();
    const refusals: [typeof spec, string, string][] = [
      [{ ...spec, name: 'Bad_Name' }, 'INVALID_INPUT', 'name'],
      [{ ...spec, region: 'ams3' }, 'INVALID_INPUT', 'region'],
      [{ ...spec, subnet: 'bc-nope' }, 'INVALID_STATE', 'noSubnet'],
      [{ ...spec, network: 'bc-other' }, 'INVALID_STATE', 'subnetNetwork'],
    ];
    for (const [bad, code, reason] of refusals) {
      const error = await failure(impl.networks.ensureNatGateway(bad, ctx()));
      expect([error.code, error.details?.reason], JSON.stringify(bad)).toEqual([code, reason]);
    }
    expect(writes(emu)).toHaveLength(0);
  });

  it('reports an INVALID gateway as error', async () => {
    const { emu, impl, vpc } = await setup();
    const gateway = seedNatGateway(emu.state, {
      name: natGatewayName('bc-nat1', 'default'),
      region: 'nyc3',
      vpc: vpc.id,
    });
    gateway.state = 'INVALID';
    expect(await impl.networks.ensureNatGateway(spec, ctx())).toMatchObject({
      id: gateway.id,
      state: 'error',
      message: expect.stringContaining('INVALID'),
    });
  });

  it('deletes a gateway of ours by name; a gone one counts as deleted; never a hand-made one', async () => {
    const { emu, impl, vpc } = await setup();
    const hand = seedNatGateway(emu.state, { name: 'bc-nat1', region: 'nyc3', vpc: vpc.id });
    expect(await impl.networks.deleteNatGateway('nyc3', 'bc-nat1', ctx())).toMatchObject({
      state: 'deleted',
    });
    expect(emu.state.natGateways.has(hand.id)).toBe(true);
    emu.state.natGateways.delete(hand.id);
    const made = await impl.networks.ensureNatGateway(spec, ctx());
    expect(await impl.networks.deleteNatGateway('nyc3', 'bc-nat1', ctx())).toEqual({
      id: made.id,
      state: 'deleted',
    });
    expect(emu.state.natGateways.size).toBe(0);
    expect((await impl.networks.deleteNatGateway('nyc3', 'bc-nat1', ctx())).state).toBe('deleted');
    expect(calls(emu, 'DELETE', /nat_gateways/)).toHaveLength(1);
  });

  it('deleteSubnet deletes the subnet gateway of ours first, then the VPC (ordered teardown)', async () => {
    const { emu, impl, vpc } = await setup();
    await impl.networks.ensureNatGateway(spec, ctx());
    const first = await impl.networks.deleteSubnet('nyc3', 'bc-sub1', ctx());
    expect(first.state).toBe('pending');
    expect(emu.state.natGateways.size).toBe(0);
    expect(emu.state.vpcs.has(vpc.id)).toBe(true);
    expect((await impl.networks.deleteSubnet('nyc3', 'bc-sub1', ctx())).state).toBe('deleted');
    expect(emu.state.vpcs.has(vpc.id)).toBe(false);
  });

  it('a gateway that is not ours keeps the subnet pending and is never deleted by it', async () => {
    const { emu, impl, vpc } = await setup();
    const hand = seedNatGateway(emu.state, { name: 'their-nat', region: 'nyc3', vpc: vpc.id });
    for (let i = 0; i < 2; i++)
      expect((await impl.networks.deleteSubnet('nyc3', 'bc-sub1', ctx())).state).toBe('pending');
    expect(emu.state.natGateways.has(hand.id)).toBe(true);
    expect(calls(emu, 'DELETE', /nat_gateways/)).toHaveLength(0);
  });
});

function uuidLike(): string {
  return '0d3db13e-a604-4944-9827-000000000001';
}
