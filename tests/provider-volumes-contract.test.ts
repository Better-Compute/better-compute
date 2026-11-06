import { describe, expect, it } from 'vitest';
import {
  ComputeError,
  manifest,
  manualClock,
  type ExternalMachine,
  type ProviderAddresses,
  type ProviderImpl,
  type ProviderResourceState,
  type ProviderVolumes,
} from '@better-compute/core';
import { runConformance } from '@better-compute/core/conformance';
import { defineProvider, providerConformanceCases } from '@better-compute/vps';

// The provider volume and address contracts (DigitalOcean P2): the conformance cases run against a
// minimal in-memory fake (the second implementation next to the DO emulator), and skip providers
// that offer neither member.

const clock = manualClock(Date.UTC(2026, 10, 5, 12));
const volumeCase = 'volumes (when offered): ensure by name, attach, grow-only resize, delete';
const snapshotCase = 'volume snapshots (when offered): snapshot by name, delete idempotently';
const addressCase = 'addresses (when offered): reserve, assign, unassign, delete';

const fail = (code: ConstructorParameters<typeof ComputeError>[0], message: string) =>
  new ComputeError(code, message);

/** A provider with machines, volumes, snapshots and addresses in one region, held in memory. */
function fakeProvider(options: { strict?: boolean } = {}) {
  const strict = options.strict ?? true;
  const machines = new Map<string, ExternalMachine>();
  const volumes = new Map<
    string,
    { name: string; region: string; sizeGiB: number; attachedTo?: string }
  >();
  const snapshots = new Map<string, { name: string; volume: string; sizeGiB: number }>();
  const addresses = new Map<string, { region: string; address: string; assignedTo?: string }>();
  let next = 0;
  const state = (
    id: string,
    value: ProviderResourceState['state'],
    outputs?: Record<string, string>,
  ): ProviderResourceState => ({ id, state: value, ...(outputs ? { outputs } : {}) });
  const volumeOutputs = (id: string) => {
    const v = volumes.get(id)!;
    return {
      region: v.region,
      sizeGiB: String(v.sizeGiB),
      device: `/dev/disk/by-id/fake-${v.name}`,
      ...(v.attachedTo ? { attachedTo: v.attachedTo } : {}),
    };
  };
  const machine = (id: string) => {
    const found = machines.get(id);
    if (!found) throw fail('NOT_FOUND', `machine ${id} does not exist`);
    return found;
  };
  const volumeOf = (id: string) => {
    const found = volumes.get(id);
    if (!found) throw fail('NOT_FOUND', `volume ${id} does not exist`);
    return found;
  };
  const vols: ProviderVolumes = {
    async ensureVolume(spec) {
      if (spec.kind === 'shared') throw fail('UNSUPPORTED', 'no shared volumes');
      for (const [id, v] of volumes)
        if (v.name === spec.name && v.region === spec.region)
          return state(id, 'ready', volumeOutputs(id));
      const id = `vol-${++next}`;
      volumes.set(id, { name: spec.name, region: spec.region, sizeGiB: spec.sizeGiB });
      return state(id, 'pending', volumeOutputs(id));
    },
    async getVolume(id) {
      return volumes.has(id) ? state(id, 'ready', volumeOutputs(id)) : undefined;
    },
    async attachVolume(id, machineId) {
      const v = volumeOf(id);
      const m = machine(machineId);
      if (m.region !== v.region) throw fail('INVALID_INPUT', 'another region');
      if (v.attachedTo === machineId) return state(id, 'ready', volumeOutputs(id));
      if (v.attachedTo) throw fail('CONFLICT', 'attached elsewhere');
      v.attachedTo = machineId;
      return state(id, 'pending', volumeOutputs(id));
    },
    async detachVolume(id, machineId) {
      const v = volumes.get(id);
      if (!v || v.attachedTo !== machineId) return state(id, 'deleted');
      delete v.attachedTo;
      return state(id, 'deleting');
    },
    async resizeVolume(id, sizeGiB) {
      const v = volumeOf(id);
      if (strict && sizeGiB < v.sizeGiB) throw fail('INVALID_INPUT', 'grow only');
      if (sizeGiB === v.sizeGiB) return state(id, 'ready', volumeOutputs(id));
      v.sizeGiB = sizeGiB;
      return state(id, 'updating', volumeOutputs(id));
    },
    async deleteVolume(id) {
      const v = volumes.get(id);
      if (!v) return state(id, 'deleted');
      if (strict && v.attachedTo) throw fail('INVALID_STATE', 'attached');
      volumes.delete(id);
      return state(id, 'deleting');
    },
    async snapshotVolume(id, name) {
      const v = volumeOf(id);
      for (const [sid, s] of snapshots)
        if (s.volume === id && s.name === name) return state(sid, 'ready');
      const sid = `snap-${++next}`;
      snapshots.set(sid, { name, volume: id, sizeGiB: v.sizeGiB });
      return state(sid, 'pending');
    },
    async getSnapshot(id) {
      const s = snapshots.get(id);
      return s ? state(id, 'ready', { volume: s.volume, sizeGiB: String(s.sizeGiB) }) : undefined;
    },
    async deleteSnapshot(id) {
      return snapshots.delete(id) ? state(id, 'deleting') : state(id, 'deleted');
    },
  };
  const addrs: ProviderAddresses = {
    async ensureAddress(spec) {
      if (spec.id !== undefined) {
        const a = addresses.get(spec.id);
        if (!a) throw fail('NOT_FOUND', 'gone');
        return state(spec.id, 'ready', { address: a.address, region: a.region, family: 'ipv4' });
      }
      const id = `203.0.113.${++next}`;
      addresses.set(id, { region: spec.region, address: id });
      return state(id, 'ready', { address: id, region: spec.region, family: spec.family });
    },
    async getAddress(id) {
      const a = addresses.get(id);
      if (!a) return undefined;
      return state(id, 'ready', {
        address: a.address,
        region: a.region,
        family: 'ipv4',
        ...(a.assignedTo ? { assignedTo: a.assignedTo } : {}),
      });
    },
    async assignAddress(id, machineId) {
      const a = addresses.get(id);
      if (!a) throw fail('NOT_FOUND', 'gone');
      if (machine(machineId).region !== a.region) throw fail('INVALID_INPUT', 'another region');
      if (a.assignedTo === machineId) return state(id, 'ready');
      if (a.assignedTo) throw fail('CONFLICT', 'assigned elsewhere');
      a.assignedTo = machineId;
      return state(id, 'pending');
    },
    async unassignAddress(id) {
      const a = addresses.get(id);
      if (!a?.assignedTo) return state(id, 'deleted');
      delete a.assignedTo;
      return state(id, 'deleting');
    },
    async deleteAddress(id) {
      const a = addresses.get(id);
      if (!a) return state(id, 'deleted');
      if (strict && a.assignedTo) throw fail('INVALID_STATE', 'assigned');
      addresses.delete(id);
      return state(id, 'deleted');
    },
  };
  const impl: ProviderImpl = {
    listOffers: async (query) =>
      query.minVcpu && query.minVcpu > 1000
        ? []
        : [{ id: 'o', kind: 'vps', region: 'r1', vcpu: 1, memoryGiB: 1, available: true }],
    create: async (request, ctx) => {
      const id = `m-${ctx.idempotencyKey}`;
      const made: ExternalMachine = machines.get(id) ?? {
        id,
        name: request.name,
        state: 'running',
        region: 'r1',
        addresses: [],
      };
      machines.set(id, made);
      return made;
    },
    get: async (id) => machines.get(id),
    delete: async (id) => {
      machines.delete(id);
    },
    volumes: vols,
    addresses: addrs,
  };
  return defineProvider({
    id: 'volume-fake',
    version: '1.0.0',
    provides: ['vps'],
    config: manifest({}),
    create: () => impl,
  });
}

describe('provider volume and address contracts', () => {
  it('lists conformance cases for volumes, snapshots and addresses', () => {
    const names = providerConformanceCases().map((item) => item.name);
    expect(names).toContain(volumeCase);
    expect(names).toContain(snapshotCase);
    expect(names).toContain(addressCase);
  });

  it('a provider that keeps the contract passes every case', async () => {
    const report = await runConformance(providerConformanceCases(), {
      provider: fakeProvider(),
      config: {},
      offerId: 'o',
      image: 'i',
      volumeGiB: 1,
      context: { clock },
    });
    expect(report.failed.map(({ name, error }) => `${name}: ${String(error)}`)).toEqual([]);
  });

  it('a provider that shrinks volumes or deletes attached ones fails the volume and address cases', async () => {
    const report = await runConformance(providerConformanceCases(), {
      provider: fakeProvider({ strict: false }),
      config: {},
      offerId: 'o',
      image: 'i',
      context: { clock },
    });
    expect(report.failed.map(({ name }) => name).sort()).toEqual([addressCase, volumeCase].sort());
  });
});
