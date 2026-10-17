import { describe, expect, it } from 'vitest';
import {
  manifest,
  manualClock,
  type CallContext,
  type ExternalMachine,
  type ExternalReservation,
  type ProviderImpl,
  type ProviderNetworks,
} from '@better-compute/core';
import { runConformance } from '@better-compute/core/conformance';
import { defineProvider, providerConformanceCases } from '@better-compute/vps';

// The additive provider contract (discover, claim, release, listReservations, networks, and the
// optional create members): defineProvider keeps accepting and freezing such providers, and the
// conformance cases for the new members skip providers that do not offer them.

const clock = manualClock(Date.UTC(2026, 9, 17, 12));
const context: CallContext = {
  idempotencyKey: 'k',
  signal: new AbortController().signal,
  clock,
  secrets: { resolve: async () => 'secret' },
  log: { debug() {}, info() {}, warn() {}, error() {} },
};

const machine = (id: string, extra: Partial<ExternalMachine> = {}): ExternalMachine => ({
  id,
  state: 'running',
  addresses: ['10.0.0.1'],
  ...extra,
});

const reservation: ExternalReservation = {
  id: 'us-central1-a/res-1',
  name: 'res-1',
  zone: 'us-central1-a',
  region: 'us-central1',
  state: 'ready',
  machineType: 'a3-highgpu-8g',
  vcpu: 208,
  memoryGiB: 1872,
  gpus: { model: 'nvidia-h100-80gb', count: 8 },
  total: 4,
  inUse: 1,
  specificOnly: true,
  shared: false,
  offerId: 'us-central1-a/a3-highgpu-8g@res-1',
};

const networks: ProviderNetworks = {
  ensureNetwork: async (spec) => ({ id: spec.name, state: 'ready' }),
  ensureSubnet: async (spec) => ({ id: spec.name, state: 'pending' }),
  ensureFirewall: async (spec) => ({ id: spec.name, state: 'ready' }),
  deleteNetwork: async (name) => ({ id: name, state: 'deleted' }),
  deleteSubnet: async (_region, name) => ({ id: name, state: 'deleting' }),
  deleteFirewall: async (name) => ({ id: name, state: 'deleted' }),
  setTags: async () => {},
};

const offer = {
  id: 'o',
  kind: 'vps' as const,
  region: 'r',
  vcpu: 2,
  memoryGiB: 4,
  available: true,
};

function full(): ProviderImpl {
  const machines = new Map<string, ExternalMachine>([['vm-1', machine('vm-1')]]);
  return {
    listOffers: async () => [],
    create: async (request) =>
      machine('vm-2', {
        name: request.name,
        labels: request.labels,
        networks: request.network
          ? [{ network: request.network.network, tags: request.network.tags }]
          : undefined,
      }),
    get: async (id) => machines.get(id),
    delete: async () => {},
    async *discover() {
      yield* machines.values();
    },
    claim: async (id, instanceId, _context, options) => {
      const claimed = machine(id, {
        claimedBy: instanceId,
        labels: { managed: String(!!options?.managed) },
      });
      machines.set(id, claimed);
      return claimed;
    },
    release: async (id) => {
      machines.set(id, machine(id));
    },
    listReservations: async () => [reservation],
    networks,
  };
}

describe('provider contract extensions', () => {
  it('defineProvider accepts a provider with discover, claim, release, listReservations and networks', async () => {
    const def = defineProvider({
      id: 'full-fake',
      version: '1.0.0',
      provides: ['vps'],
      config: manifest({}),
      create: () => full(),
    });
    expect(Object.isFrozen(def)).toBe(true);
    const impl = await def.create({}, { clock, secrets: context.secrets, log: context.log });
    expect(typeof impl.discover).toBe('function');
    expect(typeof impl.claim).toBe('function');
    expect(typeof impl.release).toBe('function');
    expect(typeof impl.listReservations).toBe('function');
    expect(typeof impl.networks?.ensureNetwork).toBe('function');

    const claimed = await impl.claim!('vm-1', 'ins_1', context, { managed: true });
    expect(claimed.claimedBy).toBe('ins_1');
    const created = await impl.create(
      {
        offerId: 'o',
        image: 'i',
        userData: '',
        name: 'n',
        network: { network: 'net', subnet: 'sub', tags: ['bc-abc'] },
        labels: { team: 'ml' },
      },
      context,
    );
    expect(created.networks).toEqual([{ network: 'net', tags: ['bc-abc'] }]);
    expect(created.labels).toEqual({ team: 'ml' });
    expect((await impl.listReservations!(context))[0]?.offerId).toBe(reservation.offerId);
  });

  it('conformance skips claim and discover cases for providers without them', async () => {
    const hetznerLike = defineProvider({
      id: 'hetzner-like',
      version: '1.0.0',
      provides: ['vps'],
      config: manifest({}),
      create: () => {
        const machines = new Map<string, ExternalMachine>();
        return {
          listOffers: async (query) => (query.minVcpu && query.minVcpu > 1000 ? [] : [offer]),
          create: async (request, ctx) => {
            const id = `m-${ctx.idempotencyKey}`;
            const made = machine(id, { name: request.name });
            machines.set(id, made);
            return made;
          },
          get: async (id) => machines.get(id),
          delete: async (id) => {
            machines.delete(id);
          },
        };
      },
    });
    const cases = providerConformanceCases();
    const names = cases.map((item) => item.name);
    expect(names).toContain('claim then release round-trips the label');
    expect(names).toContain('discover yields the attachable machine');

    const report = await runConformance(cases, {
      provider: hetznerLike,
      config: {},
      offerId: 'o',
      image: 'ubuntu-24.04',
      context: { clock },
    });
    expect(report.failed.map(({ name, error }) => `${name}: ${String(error)}`)).toEqual([]);
    expect(report.passed).toEqual(names);
  });

  it('runs the claim and discover cases against a provider that offers them', async () => {
    const def = defineProvider({
      id: 'attach-fake',
      version: '1.0.0',
      provides: ['vps'],
      config: manifest({}),
      create: () => {
        const owners = new Map<string, string>();
        const created = new Map<string, ExternalMachine>();
        return {
          listOffers: async (query) => (query.minVcpu && query.minVcpu > 1000 ? [] : [offer]),
          create: async (request, ctx) => {
            const made = machine(`m-${ctx.idempotencyKey}`, { name: request.name });
            created.set(made.id, made);
            return made;
          },
          get: async (id) =>
            id === 'vm-1' ? machine(id, { claimedBy: owners.get(id) }) : created.get(id),
          delete: async (id) => {
            created.delete(id);
          },
          async *discover() {
            yield machine('vm-1', { claimedBy: owners.get('vm-1') });
          },
          claim: async (id, instanceId) => {
            owners.set(id, instanceId);
            return machine(id, { claimedBy: instanceId });
          },
          release: async (id, instanceId) => {
            if (owners.get(id) === instanceId) owners.delete(id);
          },
        } satisfies ProviderImpl;
      },
    });
    const report = await runConformance(providerConformanceCases(), {
      provider: def,
      config: {},
      offerId: 'o',
      image: 'i',
      attachable: 'vm-1',
      context: { clock },
    });
    expect(report.failed.map(({ name, error }) => `${name}: ${String(error)}`)).toEqual([]);
    expect(report.passed).toContain('claim then release round-trips the label');
    expect(report.passed).toContain('discover yields the attachable machine');
  });
});
