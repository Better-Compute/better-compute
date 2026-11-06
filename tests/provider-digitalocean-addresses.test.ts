import { beforeEach, describe, expect, it } from 'vitest';
import { isComputeError, type ComputeError } from '@better-compute/core';
import {
  deploymentTag,
  labels,
  parseAddressId,
  tagFor,
  type DoCompute,
} from '@better-compute/provider-digitalocean';
import { seedAddress, seedPrefix } from './support/do-emulator/addresses.js';
import { seedDroplet } from './support/do-emulator/droplets.js';
import { DoEmulator, type Json, type RecordedRequest } from './support/do-emulator/index.js';
import { build, ctx, doAccount as doAccountWith, freshBudgets } from './support/do-harness.js';

// provider-digitalocean reserved IPv4 and IPv6 addresses (P2) against the emulator: reserve,
// assign and unassign as non-blocking calls, and the checks that stand in for the tags DO does not
// give a reserved IP.

const t0 = Date.parse('2026-11-05T10:00:00Z');
const emulator = () => new DoEmulator({ now: () => t0 });
const managed = tagFor(labels.managed, 'true');
const deployment = deploymentTag('default');
const instanceTag = (instance: string) => tagFor(labels.instance, instance);
const v4 = { name: 'bc-a1', region: 'nyc3', family: 'ipv4' as const };
const v6 = { name: 'bc-a2', region: 'nyc3', family: 'ipv6' as const };

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

function host(emu: DoEmulator, extra: { region?: string; tags?: string[] } = {}): Json {
  return seedDroplet(emu.state, {
    region: extra.region ?? 'nyc3',
    tags: extra.tags ?? [deployment, instanceTag('ins_1')],
  });
}

async function setup(emu = emulator()): Promise<{ emu: DoEmulator; impl: DoCompute }> {
  return { emu, impl: await build(emu) };
}

beforeEach(freshBudgets);

describe('provider-digitalocean addresses: reserve', () => {
  it('reserves an IPv4 and an IPv6 address in the region, and finds each by its id', async () => {
    const { emu, impl } = await setup();
    const a = await impl.addresses.ensureAddress(v4, ctx());
    expect(a).toEqual({
      id: expect.stringMatching(/^198\.51\.100\.\d+$/),
      state: 'ready',
      outputs: {
        address: a.id,
        family: 'ipv4',
        region: 'nyc3',
        fingerprint: expect.stringMatching(/^project:/),
      },
    });
    expect(calls(emu, 'POST', /^\/v2\/reserved_ips$/)[0]!.body).toEqual({ region: 'nyc3' });
    const b = await impl.addresses.ensureAddress(v6, ctx());
    expect(b).toMatchObject({
      state: 'ready',
      outputs: { family: 'ipv6', region: 'nyc3', fingerprint: expect.stringMatching(/^reserved:/) },
    });
    expect(parseAddressId(b.id).family).toBe('ipv6');
    expect(calls(emu, 'POST', /^\/v2\/reserved_ipv6$/)[0]!.body).toEqual({ region_slug: 'nyc3' });

    expect((await impl.addresses.ensureAddress({ ...v4, id: a.id }, ctx())).id).toBe(a.id);
    expect((await impl.addresses.ensureAddress({ ...v6, id: b.id }, ctx())).id).toBe(b.id);
    expect(writes(emu)).toHaveLength(2);
    expect(await impl.addresses.getAddress(a.id, ctx())).toEqual(a);
  });

  it('never releases or takes over an address that is not the reservation it recorded', async () => {
    const { emu, impl } = await setup();
    const a = await impl.addresses.ensureAddress(v4, ctx());
    const fingerprint = a.outputs!.fingerprint!;
    // The address was released out of band and DO handed the IP to a reservation of the account owner.
    emu.state.reservedIps.get(a.id)!.project_id = 'owner-project';
    const takeOver = await failure(
      impl.addresses.ensureAddress({ ...v4, id: a.id, fingerprint }, ctx()),
    );
    expect([takeOver.code, takeOver.details?.reason]).toEqual(['INVALID_STATE', 'notManaged']);
    const release = await failure(impl.addresses.deleteAddress(a.id, ctx(), { region: 'nyc3', fingerprint }));
    expect([release.code, release.details?.reason]).toEqual(['INVALID_STATE', 'notManaged']);
    const elsewhere = await failure(impl.addresses.deleteAddress(a.id, ctx(), { region: 'sfo3' }));
    expect(elsewhere.details?.reason).toBe('notManaged');
    expect(calls(emu, 'DELETE', /reserved_ips/)).toHaveLength(0);
    // What was recorded, matched: released.
    const owner = emu.state.reservedIps.get(a.id)!.project_id as string;
    expect(
      await impl.addresses.deleteAddress(a.id, ctx(), { region: 'nyc3', fingerprint: `project:${owner}` }),
    ).toEqual({ id: a.id, state: 'deleted' });
  });

  it('refuses what it can before any request', async () => {
    const { emu, impl } = await setup();
    const refusals: [Parameters<typeof impl.addresses.ensureAddress>[0], string, string][] = [
      [{ ...v4, source: 'byoip', prefix: '203.0.113.0/29' }, 'UNSUPPORTED', 'preview'],
      [{ ...v4, prefix: '203.0.113.0/29' }, 'UNSUPPORTED', 'preview'],
      [{ ...v4, region: 'sfo3' }, 'INVALID_INPUT', 'region'],
      [{ ...v4, id: 'not-an-ip' }, 'INVALID_INPUT', 'addressId'],
      [{ ...v4, id: '2001:db8::1' }, 'INVALID_INPUT', 'family'],
    ];
    for (const [bad, code, reason] of refusals) {
      const error = await failure(impl.addresses.ensureAddress(bad, ctx()));
      expect([error.code, error.details?.reason], JSON.stringify(bad)).toEqual([code, reason]);
    }
    expect(emu.requests).toHaveLength(0);
  });

  it('an id that is gone is NOT_FOUND, never a fresh address', async () => {
    const { emu, impl } = await setup();
    const error = await failure(impl.addresses.ensureAddress({ ...v4, id: '198.51.100.9' }, ctx()));
    expect([error.code, error.details?.reason]).toEqual(['NOT_FOUND', 'addressGone']);
    expect(writes(emu)).toHaveLength(0);
  });

  it('an address in another region than the spec is INVALID_STATE', async () => {
    const { emu, impl } = await setup();
    const address = seedAddress(emu.state, { region: 'sfo3' });
    const error = await failure(impl.addresses.ensureAddress({ ...v4, id: address.ip }, ctx()));
    expect([error.code, error.details?.reason]).toEqual(['INVALID_STATE', 'region']);
  });

  it('maps the account reserved IP limit to QUOTA_EXCEEDED, and does not retry a lost answer', async () => {
    const emu = emulator();
    emu.reservedIpLimit = 0;
    const { impl } = await setup(emu);
    const limit = await failure(impl.addresses.ensureAddress(v4, ctx()));
    expect([limit.code, limit.details?.reason]).toEqual(['QUOTA_EXCEEDED', 'reservedIpLimit']);
    emu.reservedIpLimit = 10;
    emu.failNext({ method: 'POST', path: /^\/reserved_ips$/ }, 500, { id: 'x', message: 'x' });
    expect((await failure(impl.addresses.ensureAddress(v4, ctx()))).code).toBe('UNAVAILABLE');
    expect(calls(emu, 'POST', /^\/v2\/reserved_ips$/)).toHaveLength(2);
  });

  it('getAddress is undefined for a missing or malformed id', async () => {
    const { emu, impl } = await setup();
    expect(await impl.addresses.getAddress('198.51.100.200', ctx())).toBe(undefined);
    expect(await impl.addresses.getAddress('../droplets', ctx())).toBe(undefined);
    expect(emu.requests).toHaveLength(1);
  });
});

describe('provider-digitalocean addresses: assign and unassign', () => {
  for (const spec of [v4, v6])
    it(`assigns an ${spec.family} address to an instance Droplet and unassigns it`, async () => {
      const { emu, impl } = await setup();
      const droplet = host(emu);
      const { id } = await impl.addresses.ensureAddress(spec, ctx());
      const assigned = await impl.addresses.assignAddress(id, String(droplet.id), ctx(), 'ins_1');
      expect(assigned).toMatchObject({
        state: 'ready',
        outputs: { assignedTo: String(droplet.id) },
      });
      expect(calls(emu, 'POST', /\/actions$/)[0]!.body).toEqual({
        type: 'assign',
        droplet_id: droplet.id,
      });
      expect((await impl.addresses.assignAddress(id, String(droplet.id), ctx())).state).toBe(
        'ready',
      );
      const deleting = await failure(impl.addresses.deleteAddress(id, ctx()));
      expect([deleting.code, deleting.details?.reason]).toEqual(['INVALID_STATE', 'assigned']);
      expect(await impl.addresses.unassignAddress(id, ctx())).toEqual({ id, state: 'deleted' });
      expect((await impl.addresses.unassignAddress(id, ctx())).state).toBe('deleted');
      expect(calls(emu, 'POST', /\/actions$/)).toHaveLength(2);
      expect(await impl.addresses.deleteAddress(id, ctx())).toEqual({ id, state: 'deleted' });
      expect(await impl.addresses.deleteAddress(id, ctx())).toEqual({ id, state: 'deleted' });
    });

  for (const spec of [v4, v6])
    it(`is non-blocking for ${spec.family}: pending while the action runs, one action`, async () => {
      const emu = emulator();
      emu.addressActionReads = 3;
      const { impl } = await setup(emu);
      const droplet = host(emu);
      const { id } = await impl.addresses.ensureAddress(spec, ctx());
      const seen: string[] = [];
      for (let i = 0; i < 5; i++)
        seen.push((await impl.addresses.assignAddress(id, String(droplet.id), ctx())).state);
      expect(seen[0]).toBe('pending');
      expect(seen.at(-1)).toBe('ready');
      // One action started: v4 shows it as `locked`; v6 answers a second POST with the 422
      // `has a pending event`, which reads as pending and starts nothing.
      const started = [...emu.state.actions.values()].filter((a) => a.type === 'assign_ip');
      expect(started).toHaveLength(1);
      if (spec.family === 'ipv4') expect(calls(emu, 'POST', /\/actions$/)).toHaveLength(1);
      const unassigning: string[] = [];
      for (let i = 0; i < 5; i++)
        unassigning.push((await impl.addresses.unassignAddress(id, ctx())).state);
      expect(unassigning[0]).toBe('deleting');
      expect(unassigning.at(-1)).toBe('deleted');
    });

  it('refuses a Droplet in another region, or not of this deployment, before any write', async () => {
    const { emu, impl } = await setup();
    const { id } = await impl.addresses.ensureAddress(v4, ctx());
    const far = host(emu, { region: 'sfo3' });
    const region = await failure(impl.addresses.assignAddress(id, String(far.id), ctx()));
    expect([region.code, region.details?.reason]).toEqual(['INVALID_INPUT', 'region']);
    for (const [droplet, instance] of [
      [host(emu, { tags: [instanceTag('ins_1')] }), undefined],
      [host(emu, { tags: [deployment] }), undefined],
      [host(emu, { tags: [deployment, instanceTag('ins_2')] }), 'ins_1'],
    ] as const) {
      const error = await failure(
        impl.addresses.assignAddress(id, String(droplet.id), ctx(), instance),
      );
      expect([error.code, error.details?.reason]).toEqual(['INVALID_STATE', 'notInstance']);
    }
    expect((await failure(impl.addresses.assignAddress(id, '999999', ctx()))).code).toBe(
      'NOT_FOUND',
    );
    expect(calls(emu, 'POST', /\/actions$/)).toHaveLength(0);
  });

  it('never moves an address assigned elsewhere', async () => {
    const { emu, impl } = await setup();
    const first = host(emu);
    const second = host(emu);
    const { id } = await impl.addresses.ensureAddress(v4, ctx());
    await impl.addresses.assignAddress(id, String(first.id), ctx());
    const error = await failure(impl.addresses.assignAddress(id, String(second.id), ctx()));
    expect([error.code, error.details?.reason]).toEqual(['CONFLICT', 'assignedElsewhere']);
    expect(calls(emu, 'POST', /\/actions$/)).toHaveLength(1);
  });

  it('never unassigns an address from a Droplet that is not this deployment instance', async () => {
    const { emu, impl } = await setup();
    const theirs = seedDroplet(emu.state, { tags: ['team:ops'] });
    const address = seedAddress(emu.state, { droplet: theirs });
    const error = await failure(impl.addresses.unassignAddress(address.ip, ctx()));
    expect([error.code, error.details?.reason]).toEqual(['INVALID_STATE', 'notInstance']);
    const del = await failure(impl.addresses.deleteAddress(address.ip, ctx()));
    expect(del.code).toBe('INVALID_STATE');
    expect(writes(emu)).toHaveLength(0);
  });

  it('a deleted Droplet leaves its address unassigned', async () => {
    const { emu, impl } = await setup();
    const droplet = host(emu, { tags: [managed, deployment, instanceTag('ins_1')] });
    const { id } = await impl.addresses.ensureAddress(v4, ctx());
    await impl.addresses.assignAddress(id, String(droplet.id), ctx());
    await impl.delete(String(droplet.id), ctx());
    expect((await impl.addresses.getAddress(id, ctx()))?.outputs?.assignedTo).toBe(undefined);
  });

  it('malformed ids are INVALID_INPUT', async () => {
    const { emu, impl } = await setup();
    for (const call of [
      () => impl.addresses.assignAddress('x/../y', '1', ctx()),
      () => impl.addresses.assignAddress('198.51.100.1', 'droplet', ctx()),
      () => impl.addresses.unassignAddress('nope', ctx()),
      () => impl.addresses.deleteAddress('1.2.3', ctx()),
    ])
      expect((await failure(call())).code).toBe('INVALID_INPUT');
    expect(emu.requests).toHaveLength(0);
  });
});

describe('provider-digitalocean addresses: BYOIP (preview)', () => {
  const previews = { ...doAccountWith, previews: true };
  const byoip = (prefix: string) => ({ ...v4, source: 'byoip' as const, prefix });

  it('draws an address from an active prefix of the account, found by CIDR or uuid', async () => {
    const emu = emulator();
    const prefix = seedPrefix(emu.state);
    const impl = await build(emu, previews);
    const a = await impl.addresses.ensureAddress(byoip('203.0.113.0/29'), ctx());
    expect(a).toMatchObject({
      id: '203.0.113.1',
      state: 'ready',
      outputs: { address: '203.0.113.1', family: 'ipv4', region: 'nyc3', source: 'byoip', prefix: '203.0.113.0/29' },
    });
    const b = await impl.addresses.ensureAddress(byoip(prefix.uuid), ctx());
    expect(b.id).toBe('203.0.113.2');
    const reserves = calls(emu, 'POST', /^\/v2\/reserved_ips$/);
    expect(reserves.map((r) => r.body)).toEqual([
      { region: 'nyc3', byoip_prefix_uuid: prefix.uuid },
      { region: 'nyc3', byoip_prefix_uuid: prefix.uuid },
    ]);
    // Re-ensure by id checks the address still lies in the prefix and writes nothing.
    const before = writes(emu).length;
    expect((await impl.addresses.ensureAddress({ ...byoip('203.0.113.0/29'), id: a.id }, ctx())).state).toBe('ready');
    expect(writes(emu)).toHaveLength(before);
  });

  it('refuses a prefix that is not usable, before any write', async () => {
    const emu = emulator();
    seedPrefix(emu.state, { prefix: '203.0.113.8/29', status: 'pending' });
    seedPrefix(emu.state, { prefix: '203.0.113.16/29', region: 'sfo3' });
    const impl = await build(emu, previews);
    const refusals: [Parameters<typeof impl.addresses.ensureAddress>[0], string, string][] = [
      [{ ...v4, source: 'byoip' }, 'INVALID_INPUT', 'prefix'],
      [{ ...v4, source: 'pool', prefix: '203.0.113.0/29' }, 'INVALID_INPUT', 'prefix'],
      [{ ...v6, source: 'byoip', prefix: '203.0.113.0/29' }, 'INVALID_INPUT', 'family'],
      [byoip('198.51.100.0/24'), 'INVALID_INPUT', 'prefix'],
      [byoip('203.0.113.8/29'), 'INVALID_STATE', 'prefixNotActive'],
      [byoip('203.0.113.16/29'), 'INVALID_INPUT', 'region'],
    ];
    for (const [bad, code, reason] of refusals) {
      const error = await failure(impl.addresses.ensureAddress(bad, ctx()));
      expect([error.code, error.details?.reason], JSON.stringify(bad)).toEqual([code, reason]);
    }
    expect(writes(emu)).toHaveLength(0);
  });

  it('an id outside the named prefix is INVALID_STATE', async () => {
    const emu = emulator();
    seedPrefix(emu.state);
    const pooled = seedAddress(emu.state, {});
    const impl = await build(emu, previews);
    const error = await failure(
      impl.addresses.ensureAddress({ ...byoip('203.0.113.0/29'), id: pooled.ip }, ctx()),
    );
    expect([error.code, error.details?.reason]).toEqual(['INVALID_STATE', 'prefix']);
  });

  it('an answer outside the prefix is PROVIDER_ERROR and is not handed out', async () => {
    const emu = emulator();
    const prefix = seedPrefix(emu.state);
    const impl = await build(emu, previews);
    emu.failNext({ method: 'POST', path: /^\/reserved_ips$/ }, 202, {
      reserved_ip: { ip: '198.51.100.7', region: { slug: 'nyc3' }, droplet: null, locked: false },
    });
    const error = await failure(impl.addresses.ensureAddress(byoip(prefix.uuid), ctx()));
    expect([error.code, error.details?.reason]).toEqual(['PROVIDER_ERROR', 'badBody']);
  });

  it('a full prefix fails without retrying the reserve', async () => {
    const emu = emulator();
    seedPrefix(emu.state, { prefix: '203.0.113.0/30' });
    const impl = await build(emu, previews);
    await impl.addresses.ensureAddress(byoip('203.0.113.0/30'), ctx());
    await impl.addresses.ensureAddress(byoip('203.0.113.0/30'), ctx());
    await failure(impl.addresses.ensureAddress(byoip('203.0.113.0/30'), ctx()));
    expect(calls(emu, 'POST', /^\/v2\/reserved_ips$/)).toHaveLength(3);
  });
});
