import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type ComputeError, type ProviderRouteSpec } from '@better-compute/core';
import {
  deploymentHash,
  deploymentTag,
  natGatewayName,
  networkDescription,
  type DoCompute,
} from '@better-compute/provider-digitalocean';
import { seedDroplet } from './support/do-emulator/droplets.js';
import { DoEmulator, type RecordedRequest } from './support/do-emulator/index.js';
import { seedNatGateway } from './support/do-emulator/nat-gateways.js';
import { seedRoute } from './support/do-emulator/vpc-routes.js';
import { seedVpc } from './support/do-emulator/vpcs.js';
import { build, ctx, doAccount, freshBudgets } from './support/do-harness.js';

// provider-digitalocean VPC routes (P4, preview) against the emulator: offered only with
// previews: true, named with this deployment's hash, every next hop checked before any write,
// immutable, and deleted before their subnet.

const t0 = Date.parse('2026-11-05T10:00:00Z');
const emulator = () => new DoEmulator({ now: () => t0 });
const ref = { name: 'bc-rt1', network: 'bc-net1', subnet: 'bc-sub1', region: 'nyc3' };
const spec: ProviderRouteSpec = {
  ...ref,
  destination: '192.0.2.0/24',
  nextHop: { kind: 'address', id: '10.20.0.10' },
};
const doName = `bc-rt1-${deploymentHash('default')}`;

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

async function setup(emu = emulator(), previews = true) {
  const vpc = seedVpc(emu.state, {
    name: 'bc-sub1',
    region: 'nyc3',
    ip_range: '10.20.0.0/24',
    description: networkDescription('bc-net1'),
  });
  const impl: DoCompute = await build(emu, { ...doAccount, regions: ['nyc3', 'sfo3'], previews });
  return { emu, impl, vpc };
}

beforeEach(freshBudgets);

describe('provider-digitalocean VPC routes (preview)', () => {
  it('is offered only on an account with previews: true', async () => {
    const off = await setup(emulator(), false);
    expect(off.impl.networks.ensureRoute).toBeUndefined();
    expect(off.impl.networks.deleteRoute).toBeUndefined();
    const on = await setup();
    expect(typeof on.impl.networks.ensureRoute).toBe('function');
  });

  it("adds a route to the subnet's VPC, pending until DO applies it, idempotent by name", async () => {
    const { emu, impl, vpc } = await setup();
    const made = await impl.networks.ensureRoute!(spec, ctx());
    expect(made).toEqual({
      id: expect.any(String),
      state: 'pending',
      outputs: { destination: '192.0.2.0/24', nextHop: 'ip:10.20.0.10' },
    });
    expect(calls(emu, 'POST', /\/routes$/)[0]!.body).toEqual({
      name: doName,
      destination: '192.0.2.0/24',
      next_hop: { type: 'ip', ip: '10.20.0.10' },
    });
    expect(calls(emu, 'POST', /\/routes$/)[0]!.url.pathname).toBe(`/v2/vpcs/${vpc.id}/routes`);
    const again = await impl.networks.ensureRoute!(spec, ctx());
    expect(again).toMatchObject({ id: made.id, state: 'ready' });
    expect(writes(emu)).toHaveLength(1);
  });

  it('refuses a changed route in place (replace), and a bad spec before any write', async () => {
    const { emu, impl } = await setup();
    await impl.networks.ensureRoute!(spec, ctx());
    const changed = await failure(
      impl.networks.ensureRoute!({ ...spec, destination: '198.51.100.0/24' }, ctx()),
    );
    expect([changed.code, changed.details?.reason]).toEqual(['INVALID_STATE', 'replace']);
    const before = writes(emu).length;
    const refusals: [ProviderRouteSpec, string, string][] = [
      [{ ...spec, name: 'Bad Name' }, 'INVALID_INPUT', 'name'],
      [{ ...spec, region: 'ams3' }, 'INVALID_INPUT', 'region'],
      [{ ...spec, destination: '192.0.2.1/24' }, 'INVALID_INPUT', 'destination'],
      [{ ...spec, destination: 'everywhere' }, 'INVALID_INPUT', 'destination'],
      [{ ...spec, nextHop: { kind: 'address', id: '10.99.0.1' } }, 'INVALID_INPUT', 'nextHop'],
      [{ ...spec, nextHop: { kind: 'address', id: 'gateway' } }, 'INVALID_INPUT', 'nextHop'],
      [{ ...spec, subnet: 'bc-none' }, 'INVALID_STATE', 'noSubnet'],
    ];
    for (const [bad, code, reason] of refusals) {
      const error = await failure(impl.networks.ensureRoute!(bad, ctx()));
      expect([error.code, error.details?.reason], JSON.stringify(bad)).toEqual([code, reason]);
    }
    expect(writes(emu)).toHaveLength(before);
  });

  it("routes only through this deployment's NAT gateway or Droplet in the subnet", async () => {
    const { emu, impl, vpc } = await setup();
    const ours = seedNatGateway(emu.state, {
      name: natGatewayName('bc-nat1', 'default'),
      region: 'nyc3',
      vpc: vpc.id,
    });
    const theirs = seedNatGateway(emu.state, {
      name: 'ops-nat',
      region: 'nyc3',
      vpc: vpc.id,
    });
    const mine = seedDroplet(emu.state, { tags: [deploymentTag('default')], vpc_uuid: vpc.id });
    const stranger = seedDroplet(emu.state, { tags: ['team:ops'], vpc_uuid: vpc.id });
    const viaNat = await impl.networks.ensureRoute!(
      { ...spec, name: 'bc-rt2', destination: '0.0.0.0/0', nextHop: { kind: 'natGateway', id: ours.id } },
      ctx(),
    );
    expect(viaNat.outputs?.nextHop).toBe(`nat_gateway:${ours.id}`);
    const viaDroplet = await impl.networks.ensureRoute!(
      { ...spec, name: 'bc-rt3', nextHop: { kind: 'machine', id: String(mine.id) } },
      ctx(),
    );
    expect(viaDroplet.outputs?.nextHop).toBe(`droplet:${mine.id}`);
    const before = writes(emu).length;
    for (const hop of [
      { kind: 'natGateway' as const, id: theirs.id },
      { kind: 'natGateway' as const, id: '00000000-0000-0000-0000-000000000000' },
      { kind: 'machine' as const, id: String(stranger.id) },
    ]) {
      const error = await failure(
        impl.networks.ensureRoute!({ ...spec, name: 'bc-rt4', destination: '203.0.113.0/24', nextHop: hop }, ctx()),
      );
      expect([error.code, error.details?.reason], JSON.stringify(hop)).toEqual(['INVALID_STATE', 'nextHop']);
    }
    expect(writes(emu)).toHaveLength(before);
  });

  it('deletes idempotently and never touches a route without our suffix', async () => {
    const { emu, impl, vpc } = await setup();
    const handMade = seedRoute(emu.state, {
      name: 'bc-rt1',
      vpc_uuid: vpc.id,
      destination: '198.51.100.0/24',
      next_hop: { type: 'ip', ip: '10.20.0.9' },
    });
    await impl.networks.ensureRoute!(spec, ctx());
    expect((await impl.networks.deleteRoute!(ref, ctx())).state).toBe('deleted');
    expect((await impl.networks.deleteRoute!(ref, ctx())).state).toBe('deleted');
    expect(emu.state.vpcRoutes.has(handMade.id)).toBe(true);
    expect(calls(emu, 'DELETE', /\/routes\//)).toHaveLength(1);
    expect((await impl.networks.deleteRoute!({ ...ref, subnet: 'bc-gone' }, ctx())).state).toBe(
      'deleted',
    );
  });

  it('a subnet goes only after its routes: ours are deleted first, a foreign one holds it', async () => {
    const { emu, impl, vpc } = await setup();
    await impl.networks.ensureRoute!(spec, ctx());
    const first = await impl.networks.deleteSubnet('nyc3', 'bc-sub1', ctx());
    expect(first.state).toBe('pending');
    expect(emu.state.vpcRoutes.size).toBe(0);
    expect((await impl.networks.deleteSubnet('nyc3', 'bc-sub1', ctx())).state).toBe('deleted');

    const held = await setup();
    const foreign = seedRoute(held.emu.state, {
      name: 'ops-route',
      vpc_uuid: held.vpc.id,
      destination: '198.51.100.0/24',
      next_hop: { type: 'ip', ip: '10.20.0.9' },
    });
    const blocked = await held.impl.networks.deleteSubnet('nyc3', 'bc-sub1', ctx());
    expect(blocked).toMatchObject({ state: 'pending', message: expect.stringContaining(`route ${foreign.id}`) });
    expect(held.emu.state.vpcs.has(held.vpc.id)).toBe(true);
    void vpc;
  });

  it('without previews, deleteSubnet reads no routes', async () => {
    const { emu, impl } = await setup(emulator(), false);
    expect((await impl.networks.deleteSubnet('nyc3', 'bc-sub1', ctx())).state).toBe('deleted');
    expect(calls(emu, 'GET', /\/routes$/)).toHaveLength(0);
  });
});
