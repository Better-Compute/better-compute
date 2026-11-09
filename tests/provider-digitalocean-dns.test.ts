import { beforeEach, describe, expect, it } from 'vitest';
import {
  isComputeError,
  type ComputeError,
  type ProviderDnsRecordSpec,
} from '@better-compute/core';
import {
  deploymentHash,
  dnsMarkerName,
  type DoCompute,
} from '@better-compute/provider-digitalocean';
import { seedDomain, seedRecord } from './support/do-emulator/dns.js';
import { DoEmulator, type RecordedRequest } from './support/do-emulator/index.js';
import { build, ctx, doAccount, freshBudgets } from './support/do-harness.js';

// provider-digitalocean DNS zones and records (P4) against the emulator: a zone made here carries a
// marker record naming this deployment, a foreign zone is taken over only with `adopt` and then
// never deleted, records are found by id or by identical name, type and data, and the marker and
// DigitalOcean's own apex records are never touched.

const t0 = Date.parse('2026-11-05T10:00:00Z');
const emulator = () => new DoEmulator({ now: () => t0 });
const marker = `deployment=${deploymentHash('default')}`;

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
const records = (emu: DoEmulator, zone: string) =>
  [...emu.state.domainRecords.values()].filter((r) => r.zone === zone);

async function setup(emu = emulator()): Promise<{ emu: DoEmulator; impl: DoCompute }> {
  return { emu, impl: await build(emu, doAccount) };
}

const a: ProviderDnsRecordSpec = { name: 'ins-1', type: 'A', data: '192.0.2.10', ttlSeconds: 300 };

beforeEach(freshBudgets);

describe('provider-digitalocean dns: zones', () => {
  it('makes a zone with a marker record, and finds it again', async () => {
    const { emu, impl } = await setup();
    const zone = await impl.dns.ensureZone({ name: 'Example.COM' }, ctx());
    expect(zone).toEqual({
      id: 'example.com',
      state: 'ready',
      outputs: {
        nameServers: 'ns1.digitalocean.com,ns2.digitalocean.com,ns3.digitalocean.com',
        adopted: 'false',
      },
    });
    expect(calls(emu, 'POST', /^\/v2\/domains$/)[0]!.body).toEqual({ name: 'example.com' });
    expect(calls(emu, 'POST', /\/records$/)[0]!.body).toEqual({
      type: 'TXT',
      name: dnsMarkerName,
      data: marker,
      ttl: 3600,
    });
    expect(await impl.dns.ensureZone({ name: 'example.com' }, ctx())).toEqual(zone);
    expect(await impl.dns.getZone('example.com', ctx())).toEqual(zone);
    expect(writes(emu)).toHaveLength(2);
  });

  it('writes the marker of a zone whose create answer was lost, only when it made the zone', async () => {
    const { emu, impl } = await setup();
    // The create landed but its answer did not: the zone exists without a marker.
    emu.failNext({ method: 'POST', path: /^\/domains$/ }, 500, { id: 'x', message: 'x' });
    expect((await failure(impl.dns.ensureZone({ name: 'example.com' }, ctx()))).code).toBe(
      'UNAVAILABLE',
    );
    // A zone without a marker is never taken without adopt: fail closed.
    seedDomain(emu.state, 'example.com');
    const taken = await failure(impl.dns.ensureZone({ name: 'example.com' }, ctx()));
    expect([taken.code, taken.details?.reason]).toEqual(['CONFLICT', 'zoneExists']);
  });

  it('a marker write that fails takes the just-made zone back, so the next ensure starts over', async () => {
    const { emu, impl } = await setup();
    // The domain is made, then the marker write is rate limited.
    emu.failNext({ method: 'POST', path: /^\/domains\/example\.com\/records$/ }, 429, {
      id: 'too_many_requests',
      message: 'API Rate limit exceeded.',
    });
    const failed = await failure(impl.dns.ensureZone({ name: 'example.com' }, ctx()));
    expect(failed.code).toBe('RATE_LIMITED');
    // The empty domain it made is gone again: nothing is left that no call could manage.
    expect(calls(emu, 'DELETE', /^\/v2\/domains\/example\.com$/)).toHaveLength(1);
    expect(emu.state.domains.has('example.com')).toBe(false);
    expect(records(emu, 'example.com')).toEqual([]);
    // So the retry makes it, marked, and it can be deleted.
    const zone = await impl.dns.ensureZone({ name: 'example.com' }, ctx());
    expect(zone).toMatchObject({ state: 'ready', outputs: { adopted: 'false' } });
    expect(records(emu, 'example.com').some((r) => r.name === dnsMarkerName)).toBe(true);
    expect((await impl.dns.deleteZone('example.com', ctx())).state).toBe('deleted');
  });

  it('when taking the zone back fails too, this client still knows it made the zone: it marks or deletes it', async () => {
    for (const next of ['ensure', 'delete'] as const) {
      const { emu, impl } = await setup();
      emu.failNext({ method: 'POST', path: /^\/domains\/example\.com\/records$/ }, 429, {
        id: 'too_many_requests',
        message: 'API Rate limit exceeded.',
      });
      emu.failNext({ method: 'DELETE', path: /^\/domains\/example\.com$/ }, 429, {
        id: 'too_many_requests',
        message: 'API Rate limit exceeded.',
      });
      expect((await failure(impl.dns.ensureZone({ name: 'example.com' }, ctx()))).code).toBe(
        'RATE_LIMITED',
      );
      // The zone is there without a marker.
      expect(emu.state.domains.has('example.com')).toBe(true);
      expect(records(emu, 'example.com').some((r) => r.name === dnsMarkerName)).toBe(false);
      if (next === 'ensure') {
        const zone = await impl.dns.ensureZone({ name: 'example.com' }, ctx());
        expect(zone).toMatchObject({ state: 'ready', outputs: { adopted: 'false' } });
        expect(
          records(emu, 'example.com').filter((r) => r.name === dnsMarkerName).map((r) => r.data),
        ).toEqual([marker]);
      }
      expect((await impl.dns.deleteZone('example.com', ctx())).state).toBe('deleted');
      expect(emu.state.domains.has('example.com')).toBe(false);
    }
  });

  it('never claims an unmarked zone it made once records it did not write are in it, nor one another client made', async () => {
    const { emu, impl } = await setup();
    emu.failNext({ method: 'POST', path: /^\/domains\/example\.com\/records$/ }, 500, {
      id: 'server_error',
      message: 'x',
    });
    emu.failNext({ method: 'DELETE', path: /^\/domains\/example\.com$/ }, 500, {
      id: 'server_error',
      message: 'x',
    });
    expect((await failure(impl.dns.ensureZone({ name: 'example.com' }, ctx()))).code).toBe(
      'UNAVAILABLE',
    );
    // Someone put a record in it meanwhile: it is no longer the empty zone this client made.
    seedRecord(emu.state, 'example.com', { type: 'A', name: 'www', data: '198.51.100.7' });
    const taken = await failure(impl.dns.ensureZone({ name: 'example.com' }, ctx()));
    expect([taken.code, taken.details?.reason]).toEqual(['CONFLICT', 'zoneExists']);
    const kept = await failure(impl.dns.deleteZone('example.com', ctx()));
    expect([kept.code, kept.details?.reason]).toEqual(['INVALID_STATE', 'notManaged']);
    expect(emu.state.domains.has('example.com')).toBe(true);
    // Another client (a restart) knows nothing of an unmarked zone: fail closed, as before.
    seedDomain(emu.state, 'other.example');
    const fresh = await build(emu, doAccount);
    const refused = await failure(fresh.dns.ensureZone({ name: 'other.example' }, ctx()));
    expect([refused.code, refused.details?.reason]).toEqual(['CONFLICT', 'zoneExists']);
  });

  it('takes over a foreign zone only with adopt, and never deletes an adopted zone', async () => {
    const { emu, impl } = await setup();
    seedDomain(emu.state, 'tenant.example', [{ type: 'A', name: 'www', data: '198.51.100.1' }]);
    const refused = await failure(impl.dns.ensureZone({ name: 'tenant.example' }, ctx()));
    expect([refused.code, refused.details?.reason]).toEqual(['CONFLICT', 'zoneExists']);
    const adopted = await impl.dns.ensureZone({ name: 'tenant.example', adopt: true }, ctx());
    expect(adopted).toMatchObject({
      id: 'tenant.example',
      state: 'ready',
      outputs: { adopted: 'true' },
    });
    expect(writes(emu)).toHaveLength(0);
    const deleted = await failure(impl.dns.deleteZone('tenant.example', ctx()));
    expect([deleted.code, deleted.details?.reason]).toEqual(['INVALID_STATE', 'notManaged']);
    expect(calls(emu, 'DELETE', /domains/)).toHaveLength(0);
  });

  it('never takes over or deletes a zone another deployment made', async () => {
    const { emu, impl } = await setup();
    seedDomain(emu.state, 'other.example', [
      { type: 'TXT', name: dnsMarkerName, data: `deployment=${deploymentHash('other')}` },
    ]);
    for (const adopt of [false, true]) {
      const error = await failure(impl.dns.ensureZone({ name: 'other.example', adopt }, ctx()));
      expect([error.code, error.details?.reason]).toEqual(['CONFLICT', 'otherDeployment']);
    }
    const deleted = await failure(impl.dns.deleteZone('other.example', ctx()));
    expect([deleted.code, deleted.details?.reason]).toEqual(['INVALID_STATE', 'notManaged']);
    expect(writes(emu)).toHaveLength(0);
  });

  it("never makes a zone inside or above a zone on the account that is not this deployment's", async () => {
    const { emu, impl } = await setup();
    // The operator's own domain on the account (no marker) and another deployment's.
    seedDomain(emu.state, 'example.com');
    seedDomain(emu.state, 'other.example', [
      { type: 'TXT', name: dnsMarkerName, data: `deployment=${deploymentHash('other')}` },
    ]);
    for (const name of ['a.example.com', 'deep.a.example.com', 'b.other.example']) {
      const error = await failure(impl.dns.ensureZone({ name }, ctx()));
      expect([error.code, error.details?.reason], name).toEqual(['CONFLICT', 'zoneNested']);
    }
    seedDomain(emu.state, 'shop.operator.example');
    const above = await failure(impl.dns.ensureZone({ name: 'operator.example' }, ctx()));
    expect([above.code, above.details?.reason]).toEqual(['CONFLICT', 'zoneNested']);
    expect(writes(emu)).toHaveLength(0);
    // A zone of this deployment's may hold one nested in it (vps arbitrates between tenants), and a
    // name that only ends alike is no parent.
    await impl.dns.ensureZone({ name: 'tenant.example' }, ctx());
    await impl.dns.ensureZone({ name: 'a.tenant.example' }, ctx());
    await impl.dns.ensureZone({ name: 'notexample.com' }, ctx());
    expect(calls(emu, 'POST', /^\/v2\/domains$/).map((r) => r.body)).toEqual([
      { name: 'tenant.example' },
      { name: 'a.tenant.example' },
      { name: 'notexample.com' },
    ]);
  });

  it('deletes a zone of ours once only its own records are left', async () => {
    const { emu, impl } = await setup();
    await impl.dns.ensureZone({ name: 'example.com' }, ctx());
    seedRecord(emu.state, 'example.com', { type: 'A', name: 'by-hand', data: '198.51.100.7' });
    const busy = await failure(impl.dns.deleteZone('example.com', ctx()));
    expect([busy.code, busy.details?.reason]).toEqual(['CONFLICT', 'zoneNotEmpty']);
    for (const r of records(emu, 'example.com'))
      if (r.name === 'by-hand') emu.state.domainRecords.delete(r.id);
    expect(await impl.dns.deleteZone('example.com', ctx())).toEqual({
      id: 'example.com',
      state: 'deleted',
    });
    expect(emu.state.domains.has('example.com')).toBe(false);
    expect(await impl.dns.deleteZone('example.com', ctx())).toEqual({
      id: 'example.com',
      state: 'deleted',
    });
    expect(await impl.dns.getZone('example.com', ctx())).toBe(undefined);
  });

  it('refuses a zone name that is not a domain before any request', async () => {
    const { emu, impl } = await setup();
    for (const name of [
      '',
      'localhost',
      'a..b.com',
      'exa mple.com',
      'example.com.',
      '../droplets',
    ]) {
      const error = await failure(impl.dns.ensureZone({ name }, ctx()));
      expect([error.code, error.details?.reason], name).toEqual(['INVALID_INPUT', 'zone']);
    }
    expect(await impl.dns.getZone('../droplets', ctx())).toBe(undefined);
    expect(emu.requests).toHaveLength(0);
  });
});

describe('provider-digitalocean dns: records', () => {
  async function zoned() {
    const { emu, impl } = await setup();
    await impl.dns.ensureZone({ name: 'example.com' }, ctx());
    emu.requests.length = 0;
    return { emu, impl };
  }

  it('makes a record once: a second ensure finds it by name, type and data', async () => {
    const { emu, impl } = await zoned();
    const made = await impl.dns.ensureRecord('example.com', a, ctx());
    expect(made).toEqual({
      id: expect.stringMatching(/^\d+$/),
      state: 'ready',
      outputs: {
        name: 'ins-1',
        type: 'A',
        data: '192.0.2.10',
        fqdn: 'ins-1.example.com',
        ttlSeconds: '300',
      },
    });
    expect(calls(emu, 'POST', /\/records$/)[0]!.body).toEqual({
      type: 'A',
      name: 'ins-1',
      data: '192.0.2.10',
      ttl: 300,
    });
    expect((await impl.dns.ensureRecord('example.com', a, ctx())).id).toBe(made.id);
    const listed = calls(emu, 'GET', /\/records$/).at(-1)!;
    expect(Object.fromEntries(listed.url.searchParams)).toMatchObject({
      name: 'ins-1.example.com',
      type: 'A',
    });
    expect(writes(emu)).toHaveLength(1);
    // Another address under the same name is another record (round robin).
    const second = await impl.dns.ensureRecord('example.com', { ...a, data: '192.0.2.11' }, ctx());
    expect(second.id).not.toBe(made.id);
  });

  it('changes data and TTL in place by id; another name or type at that id is INVALID_STATE', async () => {
    const { emu, impl } = await zoned();
    const { id } = await impl.dns.ensureRecord('example.com', a, ctx());
    const changed = await impl.dns.ensureRecord(
      'example.com',
      { ...a, id, data: '192.0.2.20', ttlSeconds: 60 },
      ctx(),
    );
    expect(changed).toMatchObject({ id, outputs: { data: '192.0.2.20', ttlSeconds: '60' } });
    expect(calls(emu, 'PUT', /records/)[0]!.body).toEqual({
      type: 'A',
      name: 'ins-1',
      data: '192.0.2.20',
      ttl: 60,
    });
    expect(
      (
        await impl.dns.ensureRecord(
          'example.com',
          { ...a, id, data: '192.0.2.20', ttlSeconds: 60 },
          ctx(),
        )
      ).id,
    ).toBe(id);
    expect(calls(emu, 'PUT', /records/)).toHaveLength(1);
    for (const other of [
      { ...a, id, name: 'ins-2' },
      { ...a, id, type: 'AAAA' as const, data: '2001:db8::1' },
    ]) {
      const error = await failure(impl.dns.ensureRecord('example.com', other, ctx()));
      expect([error.code, error.details?.reason]).toEqual(['INVALID_STATE', 'notThisRecord']);
    }
  });

  it('an id that is gone is made again', async () => {
    const { emu, impl } = await zoned();
    const made = await impl.dns.ensureRecord('example.com', { ...a, id: '424242' }, ctx());
    expect(made.id).not.toBe('424242');
    expect(calls(emu, 'POST', /\/records$/)).toHaveLength(1);
  });

  it('maps MX, SRV, CAA, CNAME and TXT fields, comparing host names without the final dot', async () => {
    const { emu, impl } = await zoned();
    const specs: ProviderDnsRecordSpec[] = [
      { name: '@', type: 'MX', data: 'mail.example.com.', priority: 10 },
      {
        name: '_sip._tcp',
        type: 'SRV',
        data: 'sip.example.com.',
        priority: 1,
        port: 5060,
        weight: 5,
      },
      { name: '@', type: 'CAA', data: 'letsencrypt.org', flags: 0, tag: 'issue' },
      { name: 'www', type: 'CNAME', data: 'example.com.' },
      { name: '@', type: 'TXT', data: 'v=spf1 -all' },
    ];
    const ids: string[] = [];
    for (const spec of specs)
      ids.push((await impl.dns.ensureRecord('example.com', spec, ctx())).id);
    expect(calls(emu, 'POST', /\/records$/).map((r) => r.body)).toEqual([
      { type: 'MX', name: '@', data: 'mail.example.com.', priority: 10 },
      {
        type: 'SRV',
        name: '_sip._tcp',
        data: 'sip.example.com.',
        priority: 1,
        port: 5060,
        weight: 5,
      },
      { type: 'CAA', name: '@', data: 'letsencrypt.org', flags: 0, tag: 'issue' },
      { type: 'CNAME', name: 'www', data: 'example.com.' },
      { type: 'TXT', name: '@', data: 'v=spf1 -all' },
    ]);
    // DO may hand host names back without the final dot: still the same record.
    for (const r of records(emu, 'example.com'))
      if (r.type === 'CNAME' || r.type === 'MX') r.data = String(r.data).replace(/\.$/, '');
    for (const [i, spec] of specs.entries())
      expect((await impl.dns.ensureRecord('example.com', spec, ctx())).id).toBe(ids[i]);
    expect(calls(emu, 'POST', /\/records$/)).toHaveLength(5);
  });

  it('refuses a bad record, the marker and the apex NS records before any write', async () => {
    const { emu, impl } = await zoned();
    const refusals: [ProviderDnsRecordSpec, string][] = [
      [{ ...a, data: 'not-an-ip' }, 'data'],
      [{ ...a, type: 'AAAA' }, 'data'],
      [{ ...a, name: 'bad name' }, 'name'],
      [{ ...a, name: 'ins-1.example.com.' }, 'name'],
      [{ ...a, ttlSeconds: 5 }, 'ttl'],
      [{ ...a, type: 'SOA' } as never, 'type'],
      [{ name: '@', type: 'MX', data: 'mail.example.com.' }, 'priority'],
      [{ name: '_s._tcp', type: 'SRV', data: 'x.example.com.', priority: 1 }, 'port'],
      [{ name: '@', type: 'CAA', data: 'letsencrypt.org' }, 'caa'],
      [{ name: dnsMarkerName, type: 'TXT', data: 'deployment=forged' }, 'reservedRecord'],
      [{ name: '@', type: 'NS', data: 'ns.attacker.example.' }, 'reservedRecord'],
      [{ ...a, id: 'x' }, 'recordId'],
    ];
    for (const [bad, reason] of refusals) {
      const error = await failure(impl.dns.ensureRecord('example.com', bad, ctx()));
      expect([error.code, error.details?.reason], JSON.stringify(bad)).toEqual([
        'INVALID_INPUT',
        reason,
      ]);
    }
    expect(writes(emu)).toHaveLength(0);
    const missing = await failure(impl.dns.ensureRecord('nowhere.example', a, ctx()));
    expect([missing.code, missing.details?.reason]).toEqual(['NOT_FOUND', 'zone']);
  });

  it('deletes a record, checks what was expected, and never deletes its own or the apex NS', async () => {
    const { emu, impl } = await zoned();
    const { id } = await impl.dns.ensureRecord('example.com', a, ctx());
    const other = await failure(
      impl.dns.deleteRecord('example.com', id, ctx(), { name: 'ins-1', type: 'AAAA' }),
    );
    expect([other.code, other.details?.reason]).toEqual(['INVALID_STATE', 'notThisRecord']);
    expect(
      await impl.dns.deleteRecord('example.com', id, ctx(), { name: 'ins-1', type: 'A' }),
    ).toEqual({
      id,
      state: 'deleted',
    });
    expect(await impl.dns.deleteRecord('example.com', id, ctx())).toEqual({ id, state: 'deleted' });
    expect(await impl.dns.getRecord('example.com', id, ctx())).toBe(undefined);
    const own = records(emu, 'example.com').filter(
      (r) => r.name === dnsMarkerName || (r.type === 'NS' && r.name === '@'),
    );
    expect(own).toHaveLength(4);
    for (const r of own) {
      const error = await failure(impl.dns.deleteRecord('example.com', String(r.id), ctx()));
      expect([error.code, error.details?.reason]).toEqual(['INVALID_STATE', 'reservedRecord']);
    }
    expect(calls(emu, 'DELETE', /records/)).toHaveLength(1);
    // The zone is gone: its records are deleted with it.
    expect(await impl.dns.deleteRecord('gone.example', '1', ctx())).toEqual({
      id: '1',
      state: 'deleted',
    });
  });
});
