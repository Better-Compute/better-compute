import {
  ComputeError,
  manifest,
  type ExternalMachine,
  type ProviderDefinition,
} from '@better-compute/core';
import { closeFixtures, computeFixture, type ComputeFixture } from '@better-compute/testing';
import { defineProvider, vps, type VpsOptions } from '@better-compute/vps';

// A Compute Engine stand-in for the vps tests (ruling P2: no provider-gcp here): an in-memory
// account whose VMs carry GCE-style labels, the ownership label guards of D4, and a log of every
// call, plus a full control plane (computeFixture) with a root-owned account, a provider pool
// offered to tenant acme, and a flavor that creates through the fake.

export const instanceLabel = 'better-compute-instance';
export const managedLabel = 'better-compute-managed';

export interface FakeGce {
  machines: Map<string, ExternalMachine>;
  /** Every call, in order: `discover`, `get <id>`, `create <id>`, `claim <id> <inst> [managed]`, … */
  requests: string[];
  /** Thrown by the next `discover`. */
  failNext?: Error;
}

const copy = (machine: ExternalMachine): ExternalMachine =>
  structuredClone({
    ...machine,
    ...(machine.labels?.[instanceLabel] ? { claimedBy: machine.labels[instanceLabel] } : {}),
  });

/** A running VM in us-central1-a, by default an a3-highgpu-8g with 8×H100. */
export function gceVm(name: string, extra: Partial<ExternalMachine> = {}): ExternalMachine {
  return {
    id: `us-central1-a/${name}`,
    name,
    state: 'running',
    region: 'us-central1',
    zone: 'us-central1-a',
    machineType: 'a3-highgpu-8g',
    vcpu: 208,
    memoryGiB: 1872,
    gpus: { model: 'nvidia-h100-80gb', count: 8 },
    labels: {},
    networks: [{ network: 'default', address: '10.128.0.2' }],
    addresses: ['10.128.0.2'],
    ...extra,
  };
}

export function fakeGceProvider(cloud: FakeGce, id = 'fake-gce'): ProviderDefinition {
  const machine = (machineId: string) => {
    const found = cloud.machines.get(machineId);
    if (!found) throw new ComputeError('NOT_FOUND', `VM ${machineId} not found`);
    return found;
  };
  return defineProvider({
    id,
    version: '1.0.0',
    provides: ['vps'],
    config: manifest({}) as never,
    create: () => ({
      async listOffers() {
        return [];
      },
      async create(request, call) {
        const [zone, machineType] = request.offerId.split('/');
        const vmId = `${zone}/${call.idempotencyKey.replaceAll('_', '-')}`;
        cloud.requests.push(`create ${vmId}`);
        const existing = cloud.machines.get(vmId);
        if (existing) return copy(existing);
        const created = gceVm(call.idempotencyKey.replaceAll('_', '-'), {
          machineType: machineType!,
          vcpu: 12,
          memoryGiB: 85,
          gpus: { model: 'nvidia-a100-40gb', count: 1 },
          labels: { [managedLabel]: 'true', [instanceLabel]: call.idempotencyKey },
        });
        cloud.machines.set(vmId, created);
        return copy(created);
      },
      async get(machineId) {
        cloud.requests.push(`get ${machineId}`);
        const found = cloud.machines.get(machineId);
        return found ? copy(found) : undefined;
      },
      async delete(machineId) {
        cloud.requests.push(`delete ${machineId}`);
        const found = cloud.machines.get(machineId);
        if (!found) return;
        if (found.labels?.[managedLabel] !== 'true')
          throw new ComputeError(
            'INVALID_STATE',
            `VM ${machineId} is not managed by better-compute`,
          );
        cloud.machines.delete(machineId);
      },
      async power(machineId, action, call) {
        cloud.requests.push(`power ${machineId} ${action}`);
        const found = machine(machineId);
        if (found.labels?.[instanceLabel] !== call.idempotencyKey)
          throw new ComputeError(
            'INVALID_STATE',
            `VM ${machineId} is not claimed by ${call.idempotencyKey}`,
          );
        if (action === 'on') found.state = 'running';
        if (action === 'off' || action === 'graceful-off') found.state = 'stopped';
      },
      async *discover() {
        cloud.requests.push('discover');
        const failure = cloud.failNext;
        if (failure) {
          delete cloud.failNext;
          throw failure;
        }
        for (const found of [...cloud.machines.values()]) yield copy(found);
      },
      async claim(machineId, instanceId, _call, options) {
        cloud.requests.push(
          `claim ${machineId} ${instanceId}${options?.managed ? ' managed' : ''}`,
        );
        const found = machine(machineId);
        const owner = found.labels?.[instanceLabel];
        if (owner !== undefined && owner !== instanceId)
          throw new ComputeError('CONFLICT', `VM ${machineId} is claimed by ${owner}`);
        found.labels = {
          ...found.labels,
          [instanceLabel]: instanceId,
          ...(options?.managed ? { [managedLabel]: 'true' } : {}),
        };
        return copy(found);
      },
      async release(machineId, instanceId) {
        cloud.requests.push(`release ${machineId} ${instanceId}`);
        const found = cloud.machines.get(machineId);
        if (!found || found.labels?.[instanceLabel] !== instanceId) return;
        const { [instanceLabel]: _gone, ...rest } = found.labels;
        found.labels = rest;
      },
    }),
  });
}

/** A provider that cannot discover, claim or release (a Hetzner Cloud stand-in). */
export const plainProvider = defineProvider({
  id: 'fake-plain',
  version: '1.0.0',
  provides: ['vps'],
  config: manifest({}) as never,
  create: () => ({
    async listOffers() {
      return [];
    },
    async create() {
      throw new ComputeError('UNSUPPORTED', 'unused');
    },
    async get() {
      return undefined;
    },
    async delete() {},
  }),
});

type Api = any;

export interface GceWorld {
  fixture: ComputeFixture;
  api: Api;
  cloud: FakeGce;
  /** Credentials of the root operator, and of acme's one user. */
  root: { token: string };
  acme: { token: string };
  rootTenant: string;
  acmeTenant: string;
  accountId: string;
  poolId: string;
  /** Runs a reconciler's due keys (twice: a periodic pass enqueues per-account keys). */
  tick(job: string, rounds?: number): Promise<void>;
  /** Moves the sim clock and runs a discovery pass. */
  discover(advanceMs?: number): Promise<void>;
  /** `topic` and `data` of outbox events, oldest first, optionally of one type prefix. */
  events(prefix?: string): Promise<{ type: string; data: any; tenantId: string }[]>;
  close(): Promise<void>;
}

export interface GceWorldOptions extends Pick<VpsOptions, 'discovery'> {
  /** acme's quota on the pool (default: room for one 8-GPU VM and a small one). */
  quota?: Record<string, number>;
  /** Whether iam.rootTenantId names the root tenant, as the IAM bridge sets it (default true). */
  iamRoot?: boolean;
}

export async function gceWorld(options: GceWorldOptions = {}): Promise<GceWorld> {
  const cloud: FakeGce = { machines: new Map(), requests: [] };
  const fixture = await computeFixture({
    clock: 'sim',
    modules: [
      vps({
        providers: [fakeGceProvider(cloud), plainProvider],
        ...(options.discovery !== undefined ? { discovery: options.discovery } : {}),
      }),
    ],
  });
  const { compute, tenants, iam } = fixture;
  // The IAM bridge names the root tenant on its port (`bridge.embedded(iam, { rootTenantId })`).
  if (options.iamRoot !== false) (iam as { rootTenantId?: string }).rootTenantId = tenants.root.id;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  const api = compute.api as Api;
  const root = { token: tenants.root.token };
  const acme = { token: tenants.acme.token };
  const account = await api.providerAccounts.create(root, {
    tenantId: tenants.root.id,
    provider: 'fake-gce',
    name: 'gce-main',
    config: {},
  });
  const site = await api.sites.create(root, {
    tenantId: tenants.root.id,
    kind: 'shared',
    region: 'us-central1',
    idempotencyKey: 'gce-site',
  });
  const pool = await api.pools.create(root, {
    tenantId: tenants.root.id,
    siteId: site.id,
    class: 'provider',
    providerAccountId: account.id,
    idempotencyKey: 'gce-pool',
  });
  await api.pools.offer(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    toTenantId: tenants.acme.id,
    quota: options.quota ?? { vcpu: 512, memoryGiB: 4096, diskGiB: 1000, gpu: 16 },
  });
  await api.flavors.create(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    name: 'a2.highgpu.1g',
    vcpu: 12,
    memoryGiB: 85,
    diskGiB: 100,
    gpus: 1,
    offerId: 'us-central1-a/a2-highgpu-1g',
  });
  const tick = async (job: string, rounds = 2) => {
    for (let round = 0; round < rounds; round++) await compute.jobs[job]!.tick();
  };
  return {
    fixture,
    api,
    cloud,
    root,
    acme,
    rootTenant: tenants.root.id,
    acmeTenant: tenants.acme.id,
    accountId: account.id,
    poolId: pool.id,
    tick,
    async discover(advanceMs = 60_000) {
      await fixture.advance(advanceMs);
      await tick('vps.discovery');
    },
    async events(prefix = '') {
      const { rows } = await fixture.database.query<{
        topic: string;
        payload: { data: unknown; tenantId: string };
      }>(`SELECT topic, payload FROM outbox WHERE topic LIKE $1 ORDER BY seq`, [`${prefix}%`]);
      return rows.map((row) => ({
        type: row.topic,
        data: row.payload.data,
        tenantId: row.payload.tenantId,
      }));
    },
    close: closeFixtures,
  };
}
