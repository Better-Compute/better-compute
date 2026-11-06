import { describe, expect, it } from 'vitest';
import {
  ComputeError,
  manifest,
  manualClock,
  type ExternalMachine,
  type ProviderCertificates,
  type ProviderDns,
  type ProviderImpl,
  type ProviderLoadBalancers,
  type ProviderNetworks,
  type ProviderResourceState,
} from '@better-compute/core';
import { runConformance } from '@better-compute/core/conformance';
import { defineProvider, providerConformanceCases } from '@better-compute/vps';

// The edge contracts (DigitalOcean P4): load balancers, DNS and certificates. The conformance cases run against a
// minimal in-memory fake (the second implementation next to the DO emulator); a fake that breaks one rule fails
// that rule's case, and a provider that offers none of the members skips them.

const clock = manualClock(Date.UTC(2026, 10, 5, 12));
const lbCase =
  'load balancers (when offered): a regional one in front of a machine, changed in place, deleted';
const lbRegionCase =
  'load balancers (when offered): a target machine in another region is INVALID_INPUT';
const dnsCase =
  'dns (when offered): a zone, a record found by name, type and data, changed in place, deleted';
const certCase = 'certificates (when offered): a custom certificate by name, deleted idempotently';
const natCase =
  'nat gateways (when offered): one per subnet by name; the subnet goes only after its gateway';
const edgeCases = [lbCase, lbRegionCase, dnsCase, certCase, natCase];

const fail = (code: ConstructorParameters<typeof ComputeError>[0], message: string) =>
  new ComputeError(code, message);

const pem = {
  'secret://t/cert': '-----BEGIN CERTIFICATE-----\nMIIfake\n-----END CERTIFICATE-----\n',
  'secret://t/key': '-----BEGIN PRIVATE KEY-----\nMIIfake\n-----END PRIVATE KEY-----\n',
} as Record<string, string>;
const secrets = {
  resolve: async (ref: string) => {
    const value = pem[ref];
    if (value === undefined) throw fail('NOT_FOUND', `no secret ${ref}`);
    return value;
  },
};

interface Breaks {
  /** Changes `internal` in place instead of refusing it. */
  internalInPlace?: boolean;
  /** Targets machines in any region. */
  anyRegion?: boolean;
  /** Makes a second record for the same name, type and data. */
  duplicateRecords?: boolean;
  /** Reports the private key among a certificate's outputs. */
  leaksKey?: boolean;
  /** Deletes a subnet a NAT gateway still serves. */
  subnetUnderNat?: boolean;
}

function fakeProvider(breaks: Breaks = {}, members: { edge?: boolean } = {}) {
  const machines = new Map<string, ExternalMachine>();
  const lbs = new Map<
    string,
    { name: string; region: string; internal: boolean; ports: number[]; targets: string[] }
  >();
  const zones = new Set<string>();
  const records = new Map<
    string,
    { zone: string; name: string; type: string; data: string; ttl: number }
  >();
  const certs = new Map<string, { name: string; key: string }>();
  let next = 0;
  const state = (
    id: string,
    value: ProviderResourceState['state'],
    outputs?: Record<string, string>,
  ): ProviderResourceState => ({ id, state: value, ...(outputs ? { outputs } : {}) });

  const lbOutputs = (id: string) => {
    const lb = lbs.get(id)!;
    return { scope: 'regional', region: lb.region, address: `203.0.113.${id.slice(3)}` };
  };
  const loadBalancers: ProviderLoadBalancers = {
    async ensureLoadBalancer(spec) {
      if (spec.scope !== 'regional' || spec.region === undefined)
        throw fail('UNSUPPORTED', 'regional only');
      for (const target of spec.targets.machines ?? []) {
        const m = machines.get(target);
        if (!m) throw fail('NOT_FOUND', `machine ${target}`);
        if (!breaks.anyRegion && m.region !== spec.region)
          throw fail('INVALID_INPUT', 'another region');
      }
      let id = spec.id;
      if (id === undefined) for (const [lbId, lb] of lbs) if (lb.name === spec.name) id = lbId;
      const internal = spec.internal ?? false;
      const ports = spec.forwarding.map((rule) => rule.entryPort);
      const targets = [...(spec.targets.machines ?? [])];
      if (id !== undefined) {
        const lb = lbs.get(id);
        if (!lb) throw fail('NOT_FOUND', `load balancer ${id}`);
        if (lb.region !== spec.region) throw fail('INVALID_STATE', 'another region');
        if (lb.internal !== internal && !breaks.internalInPlace)
          throw fail('INVALID_STATE', 'internal is not changed in place');
        const same = lb.ports.join() === ports.join() && lb.targets.join() === targets.join();
        Object.assign(lb, { internal, ports, targets });
        return state(id, same ? 'ready' : 'updating', lbOutputs(id));
      }
      id = `lb-${++next}`;
      lbs.set(id, { name: spec.name, region: spec.region, internal, ports, targets });
      return state(id, 'pending', lbOutputs(id));
    },
    async getLoadBalancer(id) {
      return lbs.has(id) ? state(id, 'ready', lbOutputs(id)) : undefined;
    },
    async deleteLoadBalancer(id) {
      return lbs.delete(id) ? state(id, 'deleting') : state(id, 'deleted');
    },
  };

  const recordOutputs = (id: string) => {
    const r = records.get(id)!;
    return {
      name: r.name,
      type: r.type,
      data: r.data,
      fqdn: r.name === '@' ? r.zone : `${r.name}.${r.zone}`,
      ttlSeconds: String(r.ttl),
    };
  };
  const dns: ProviderDns = {
    async ensureZone(spec) {
      zones.add(spec.name);
      return state(spec.name, 'ready', { nameServers: 'ns1.fake.,ns2.fake.' });
    },
    async getZone(zone) {
      return zones.has(zone) ? state(zone, 'ready') : undefined;
    },
    async deleteZone(zone) {
      zones.delete(zone);
      for (const [id, r] of records) if (r.zone === zone) records.delete(id);
      return state(zone, 'deleted');
    },
    async ensureRecord(zone, spec) {
      if (!zones.has(zone)) throw fail('NOT_FOUND', `zone ${zone}`);
      const ttl = spec.ttlSeconds ?? 1800;
      if (spec.id !== undefined) {
        const r = records.get(spec.id);
        if (!r) throw fail('NOT_FOUND', `record ${spec.id}`);
        if (r.name !== spec.name || r.type !== spec.type)
          throw fail('INVALID_STATE', 'another record');
        Object.assign(r, { data: spec.data, ttl });
        return state(spec.id, 'ready', recordOutputs(spec.id));
      }
      if (!breaks.duplicateRecords)
        for (const [id, r] of records)
          if (
            r.zone === zone &&
            r.name === spec.name &&
            r.type === spec.type &&
            r.data === spec.data
          )
            return state(id, 'ready', recordOutputs(id));
      const id = String(++next);
      records.set(id, { zone, name: spec.name, type: spec.type, data: spec.data, ttl });
      return state(id, 'ready', recordOutputs(id));
    },
    async getRecord(_zone, id) {
      return records.has(id) ? state(id, 'ready', recordOutputs(id)) : undefined;
    },
    async deleteRecord(_zone, id, _ctx, expected) {
      const r = records.get(id);
      if (!r) return state(id, 'deleted');
      if (expected && (expected.name !== r.name || expected.type !== r.type))
        throw fail('INVALID_STATE', 'not the record expected');
      records.delete(id);
      return state(id, 'deleted');
    },
  };

  const certificates: ProviderCertificates = {
    async ensureCertificate(spec, ctx) {
      for (const [id, c] of certs)
        if (c.name === spec.name)
          return state(id, 'ready', {
            kind: 'custom',
            fingerprint: 'ab12',
            ...(breaks.leaksKey ? { key: c.key } : {}),
          });
      const key = await ctx.secrets.resolve(spec.privateKey!);
      const id = `cert-${++next}`;
      certs.set(id, { name: spec.name, key });
      return state(id, 'pending');
    },
    async getCertificate(id) {
      return certs.has(id) ? state(id, 'ready') : undefined;
    },
    async deleteCertificate(id) {
      certs.delete(id);
      return state(id, 'deleted');
    },
  };

  const subnets = new Set<string>();
  const gateways = new Map<string, string>();
  const networks: ProviderNetworks = {
    ensureNetwork: async (spec) => ({ id: spec.name, state: 'ready' }),
    ensureSubnet: async (spec) => {
      subnets.add(`${spec.region}/${spec.name}`);
      return { id: `${spec.region}/${spec.name}`, state: 'ready' };
    },
    ensureFirewall: async (spec) => ({ id: spec.name, state: 'ready' }),
    deleteNetwork: async (name) => ({ id: name, state: 'deleted' }),
    deleteSubnet: async (region, name) => {
      const id = `${region}/${name}`;
      if (!breaks.subnetUnderNat && [...gateways.values()].includes(id))
        return { id, state: 'pending' };
      subnets.delete(id);
      return { id, state: 'deleted' };
    },
    deleteFirewall: async (name) => ({ id: name, state: 'deleted' }),
    setTags: async () => {},
    ensureNatGateway: async (spec) => {
      const subnet = `${spec.region}/${spec.subnet}`;
      if (!subnets.has(subnet)) throw fail('INVALID_STATE', 'no such subnet');
      const id = `${spec.region}/${spec.name}`;
      const known = gateways.get(id);
      if (known !== undefined && known !== subnet) throw fail('INVALID_STATE', 'another subnet');
      gateways.set(id, subnet);
      return state(id, known ? 'ready' : 'pending', {
        address: '203.0.113.200',
        region: spec.region,
      });
    },
    deleteNatGateway: async (region, name) => {
      gateways.delete(`${region}/${name}`);
      return state(`${region}/${name}`, 'deleted');
    },
  };

  const impl: ProviderImpl = {
    listOffers: async (query) =>
      query.minVcpu && query.minVcpu > 1000
        ? []
        : [
            { id: 'o', kind: 'vps', region: 'r1', vcpu: 1, memoryGiB: 1, available: true },
            { id: 'o2', kind: 'vps', region: 'r2', vcpu: 1, memoryGiB: 1, available: true },
          ],
    create: async (request, ctx) => {
      const id = `m-${ctx.idempotencyKey}`;
      const made: ExternalMachine = machines.get(id) ?? {
        id,
        name: request.name,
        state: 'running',
        region: request.offerId === 'o2' ? 'r2' : 'r1',
        addresses: [],
      };
      machines.set(id, made);
      return made;
    },
    get: async (id) => machines.get(id),
    delete: async (id) => {
      machines.delete(id);
    },
    ...(members.edge === false ? {} : { loadBalancers, dns, certificates, networks }),
  };
  return defineProvider({
    id: 'edge-fake',
    version: '1.0.0',
    provides: ['vps'],
    config: manifest({}),
    create: () => impl,
  });
}

const subject = (provider: ReturnType<typeof fakeProvider>) => ({
  provider,
  config: {},
  offerId: 'o',
  otherRegionOfferId: 'o2',
  image: 'i',
  dnsZone: 'conformance.example',
  certificate: {
    certificate: 'secret://t/cert' as const,
    privateKey: 'secret://t/key' as const,
  },
  context: { clock, secrets },
});

async function failedCases(breaks: Breaks): Promise<string[]> {
  const report = await runConformance(providerConformanceCases(), subject(fakeProvider(breaks)));
  return report.failed.map(({ name }) => name);
}

describe('provider edge contracts', () => {
  it('lists conformance cases for load balancers, DNS and certificates', () => {
    const names = providerConformanceCases().map((item) => item.name);
    for (const name of edgeCases) expect(names).toContain(name);
  });

  it('a provider that keeps the contracts passes every case', async () => {
    const report = await runConformance(providerConformanceCases(), subject(fakeProvider()));
    expect(report.failed.map(({ name, error }) => `${name}: ${String(error)}`)).toEqual([]);
  });

  it('a provider without the edge members skips their cases', async () => {
    const report = await runConformance(
      providerConformanceCases(),
      subject(fakeProvider({}, { edge: false })),
    );
    expect(report.failed.map(({ name, error }) => `${name}: ${String(error)}`)).toEqual([]);
  });

  it('a load balancer that turns internal in place fails the load balancer case', async () => {
    expect(await failedCases({ internalInPlace: true })).toEqual([lbCase]);
  });

  it('a load balancer that targets another region fails the region case', async () => {
    expect(await failedCases({ anyRegion: true })).toEqual([lbRegionCase]);
  });

  it('a second record for the same name, type and data fails the DNS case', async () => {
    expect(await failedCases({ duplicateRecords: true })).toEqual([dnsCase]);
  });

  it('a certificate that reports its key fails the certificate case', async () => {
    expect(await failedCases({ leaksKey: true })).toEqual([certCase]);
  });

  it('a subnet deleted while its NAT gateway exists fails the NAT case', async () => {
    expect(await failedCases({ subnetUnderNat: true })).toEqual([natCase]);
  });
});
