import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ComputeError,
  manualClock,
  type Caller,
  type ExternalMachine,
  type ManualClock,
  type MethodContext,
  type ModuleContext,
  type ProviderAddressSpec,
  type ProviderResourceState,
  type ProviderVolumeSpec,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { capacityMigrations, capacityModule, setQuota } from '@better-compute/capacity';
import {
  defineProvider,
  meterAncillaries,
  meterProviderResources,
  providerResourceName,
  providerResourcesWork,
  vps,
  vpsMigrations,
  type ProviderAddressView,
  type ProviderSnapshotView,
  type ProviderVolumeView,
  type VpsApi,
} from '@better-compute/vps';

// (DO P2) Provider volumes, snapshots and reserved addresses: `providerVolumes.*`, `providerSnapshots.*` and
// `providerAddresses.*` record what a tenant wants, and the `vps.providerResources` reconciler converges the provider
// through `ProviderImpl.volumes` and `ProviderImpl.addresses`. The provider is an inline fake that keeps volumes,
// snapshots and addresses in memory, like DigitalOcean (volumes by name, addresses by the id a reserve returned).

const T0 = Date.UTC(2026, 10, 5, 12);
const SITE = 'site_01jz0000000000000000000d02';
let db: SqlExecutor;
let clock: ManualClock;

const alice: Caller = {
  identityId: 'usr_alice',
  identityKind: 'user',
  tenantId: 'root',
  sessionId: 's',
  sessionKind: 'user',
  mfa: false,
};
const mallory: Caller = { ...alice, identityId: 'usr_mallory', tenantId: 'other' };

// --- The fake provider -------------------------------------------------------------------------

interface FakeVolume {
  id: string;
  spec: ProviderVolumeSpec;
  sizeGiB: number;
  attachedTo?: string;
  /** An attach action still running at the provider (`slowAttach`), to this machine. */
  attaching?: string;
}
interface FakeAddress {
  id: string;
  spec: ProviderAddressSpec;
  address: string;
  assignedTo?: string;
  /** Like DO's reserved IP project or reservation time: differs for a later reservation at the same IP. */
  fingerprint: string;
}

const cloud = {
  volumes: new Map<string, FakeVolume>(),
  snapshots: new Map<string, { id: string; volume: string; name: string; sizeGiB: number }>(),
  addresses: new Map<string, FakeAddress>(),
  /** The region each machine is in. */
  machines: new Map<string, string>(),
  calls: [] as string[],
  /** The next provider call throws this. */
  failNext: undefined as ComputeError | undefined,
  /** Each volume create, attach, resize and reserve answers `pending` this many times first. */
  pendingTicks: 0,
  progress: new Map<string, number>(),
  counter: 0,
  /** Whether a machine delete also deletes the volumes it names (DO's selective destroy); else they are detached. */
  selective: true,
  /** Like DO: an accepted attach runs on at the provider until `finishAttaches`; a detach meanwhile is `deleting`. */
  slowAttach: false,
  finishAttaches() {
    for (const volume of this.volumes.values())
      if (volume.attaching) {
        volume.attachedTo = volume.attaching;
        delete volume.attaching;
      }
  },
  reset() {
    this.selective = true;
    this.slowAttach = false;
    this.volumes.clear();
    this.snapshots.clear();
    this.addresses.clear();
    this.machines.clear();
    this.calls.length = 0;
    this.failNext = undefined;
    this.pendingTicks = 0;
    this.progress.clear();
  },
  call(label: string): void {
    this.calls.push(label);
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
  },
  /** Whether an operation keyed `label` is still running (answers pending `pendingTicks` times). */
  running(label: string): boolean {
    const asked = (this.progress.get(label) ?? 0) + 1;
    if (asked <= this.pendingTicks) {
      this.progress.set(label, asked);
      return true;
    }
    this.progress.delete(label);
    return false;
  },
  volumeState(volume: FakeVolume, state: ProviderResourceState['state'] = 'ready'): ProviderResourceState {
    return {
      id: volume.id,
      state,
      outputs: {
        region: volume.spec.region,
        sizeGiB: String(volume.sizeGiB),
        device: `/dev/disk/by-id/scsi-0DO_Volume_${volume.spec.name}`,
        ...(volume.attachedTo ? { attachedTo: volume.attachedTo } : {}),
      },
    };
  },
  addressState(address: FakeAddress, state: ProviderResourceState['state'] = 'ready'): ProviderResourceState {
    return {
      id: address.id,
      state,
      outputs: {
        address: address.address,
        family: address.spec.family,
        region: address.spec.region,
        ...(address.assignedTo ? { assignedTo: address.assignedTo } : {}),
        fingerprint: address.fingerprint,
      },
    };
  },
};

const standard = {
  '~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) },
};
const doLike = defineProvider({
  id: 'fake-do',
  version: '1.0.0',
  provides: ['vps'],
  config: standard as never,
  create: () => ({
    async listOffers() {
      return [];
    },
    async create(): Promise<ExternalMachine> {
      throw new Error('unused');
    },
    async get(machineId: string): Promise<ExternalMachine | undefined> {
      if (!cloud.machines.has(machineId)) return undefined;
      return { id: machineId, name: machineId, state: 'running', addresses: [] };
    },
    // Like DigitalOcean's (selective) destroy: the named volumes attached to it go with it, every other volume is
    // detached and every address unassigned.
    async delete(machineId: string, _context, options) {
      cloud.call(`delete ${machineId} ${options?.volumes?.join(',') || '-'}`);
      cloud.machines.delete(machineId);
      for (const volume of [...cloud.volumes.values()]) {
        if (volume.attachedTo !== machineId) continue;
        delete volume.attachedTo;
        if (cloud.selective && options?.volumes?.includes(volume.id)) cloud.volumes.delete(volume.id);
      }
      for (const address of cloud.addresses.values())
        if (address.assignedTo === machineId) delete address.assignedTo;
    },
    volumes: {
      async ensureVolume(spec) {
        cloud.call(`ensureVolume ${spec.name}`);
        const existing = [...cloud.volumes.values()].find((volume) => volume.spec.name === spec.name);
        if (existing) return cloud.volumeState(existing, cloud.running(`create ${spec.name}`) ? 'pending' : 'ready');
        const volume: FakeVolume = { id: `vol-${++cloud.counter}`, spec, sizeGiB: spec.sizeGiB };
        cloud.volumes.set(volume.id, volume);
        return cloud.volumeState(volume, cloud.running(`create ${spec.name}`) ? 'pending' : 'ready');
      },
      async findVolume(name, region) {
        cloud.call(`findVolume ${name}`);
        const found = [...cloud.volumes.values()].find(
          (volume) => volume.spec.name === name && volume.spec.region === region,
        );
        return found ? cloud.volumeState(found) : undefined;
      },
      async getVolume(volumeId) {
        cloud.call(`getVolume ${volumeId}`);
        const volume = cloud.volumes.get(volumeId);
        return volume ? cloud.volumeState(volume) : undefined;
      },
      async attachVolume(volumeId, machineId, _context, instanceId) {
        cloud.call(`attachVolume ${volumeId} ${machineId} ${instanceId ?? '-'}`);
        const volume = cloud.volumes.get(volumeId)!;
        if (cloud.machines.get(machineId) !== volume.spec.region)
          throw new ComputeError('INVALID_INPUT', 'another region');
        if (volume.attachedTo && volume.attachedTo !== machineId)
          throw new ComputeError('CONFLICT', 'attached to another droplet');
        if (volume.attachedTo === machineId) return { id: volumeId, state: 'ready' };
        if (cloud.slowAttach || volume.attaching) {
          volume.attaching ??= machineId;
          return { id: volumeId, state: 'pending' };
        }
        if (cloud.running(`attach ${volumeId}`)) return { id: volumeId, state: 'pending' };
        volume.attachedTo = machineId;
        return { id: volumeId, state: 'ready' };
      },
      async detachVolume(volumeId, machineId) {
        cloud.call(`detachVolume ${volumeId} ${machineId}`);
        const volume = cloud.volumes.get(volumeId);
        // An attach still running would attach it after this answer (DoVolumes.detachVolume answers deleting).
        if (volume?.attaching) return { id: volumeId, state: 'deleting' };
        if (volume?.attachedTo === machineId) delete volume.attachedTo;
        return { id: volumeId, state: 'deleted' };
      },
      async resizeVolume(volumeId, sizeGiB) {
        cloud.call(`resizeVolume ${volumeId} ${sizeGiB}`);
        const volume = cloud.volumes.get(volumeId)!;
        if (sizeGiB < volume.sizeGiB) throw new ComputeError('INVALID_INPUT', 'only grows');
        if (cloud.running(`resize ${volumeId}`)) return cloud.volumeState(volume, 'updating');
        volume.sizeGiB = sizeGiB;
        return cloud.volumeState(volume);
      },
      async deleteVolume(volumeId) {
        cloud.call(`deleteVolume ${volumeId}`);
        const volume = cloud.volumes.get(volumeId);
        if (volume?.attachedTo) throw new ComputeError('INVALID_STATE', 'attached');
        cloud.volumes.delete(volumeId);
        return { id: volumeId, state: 'deleted' };
      },
      async snapshotVolume(volumeId, name) {
        cloud.call(`snapshotVolume ${volumeId} ${name}`);
        const existing = [...cloud.snapshots.values()].find((snapshot) => snapshot.name === name);
        const snapshot = existing ?? {
          id: `snap-${++cloud.counter}`,
          volume: volumeId,
          name,
          sizeGiB: cloud.volumes.get(volumeId)!.sizeGiB,
        };
        cloud.snapshots.set(snapshot.id, snapshot);
        return { id: snapshot.id, state: 'ready', outputs: { sizeGiB: String(snapshot.sizeGiB) } };
      },
      async getSnapshot(snapshotId) {
        const snapshot = cloud.snapshots.get(snapshotId);
        return snapshot ? { id: snapshot.id, state: 'ready' } : undefined;
      },
      async deleteSnapshot(snapshotId) {
        cloud.call(`deleteSnapshot ${snapshotId}`);
        cloud.snapshots.delete(snapshotId);
        return { id: snapshotId, state: 'deleted' };
      },
    },
    addresses: {
      async ensureAddress(spec) {
        cloud.call(`ensureAddress ${spec.id ?? 'new'}`);
        if (spec.id) {
          const known = cloud.addresses.get(spec.id);
          if (known && spec.fingerprint !== undefined && spec.fingerprint !== known.fingerprint)
            throw new ComputeError('INVALID_STATE', 'another reservation', undefined, { reason: 'notManaged' });
          if (known) return cloud.addressState(known);
          throw new ComputeError('NOT_FOUND', 'no such address');
        }
        // Like DigitalOcean: no name, so every reserve without an id is a new address.
        const address: FakeAddress = {
          id: `203.0.113.${++cloud.counter}`,
          spec,
          address: `203.0.113.${cloud.counter}`,
          fingerprint: `fp-${cloud.counter}`,
        };
        cloud.addresses.set(address.id, address);
        return cloud.addressState(address);
      },
      async getAddress(addressId) {
        cloud.call(`getAddress ${addressId}`);
        const address = cloud.addresses.get(addressId);
        return address ? cloud.addressState(address) : undefined;
      },
      async assignAddress(addressId, machineId, _context, instanceId) {
        cloud.call(`assignAddress ${addressId} ${machineId} ${instanceId ?? '-'}`);
        const address = cloud.addresses.get(addressId)!;
        if (address.assignedTo && address.assignedTo !== machineId)
          throw new ComputeError('CONFLICT', 'assigned elsewhere');
        address.assignedTo = machineId;
        return { id: addressId, state: 'ready' };
      },
      async unassignAddress(addressId) {
        cloud.call(`unassignAddress ${addressId}`);
        const address = cloud.addresses.get(addressId);
        if (address) delete address.assignedTo;
        return { id: addressId, state: 'deleted' };
      },
      async deleteAddress(addressId, _context, expected) {
        cloud.call(`deleteAddress ${addressId}`);
        const address = cloud.addresses.get(addressId);
        if (address && expected?.fingerprint !== undefined && expected.fingerprint !== address.fingerprint)
          throw new ComputeError('INVALID_STATE', 'another reservation', undefined, { reason: 'notManaged' });
        if (address?.assignedTo) throw new ComputeError('INVALID_STATE', 'assigned');
        cloud.addresses.delete(addressId);
        return { id: addressId, state: 'deleted' };
      },
    },
  }),
});
const bareLike = defineProvider({
  id: 'fake-bare',
  version: '1.0.0',
  provides: ['vps'],
  config: standard as never,
  create: () => ({
    async listOffers() {
      return [];
    },
    async create(): Promise<ExternalMachine> {
      throw new Error('unused');
    },
    async get() {
      return undefined;
    },
    async delete() {},
  }),
});

// --- The module context ------------------------------------------------------------------------

const events: { type: string; subject: string; data: Record<string, unknown> }[] = [];
const authzOps: { op: string; resource: string; row?: Record<string, unknown> }[] = [];
const projected = new Map<string, string>();
const queue = new Map<string, number>();
/** IAM resources (`type/id`) the caller holds no right on: `iam.require` refuses them. */
const deniedResources = new Set<string>();
const required: string[] = [];

function moduleContext(sql: SqlExecutor): ModuleContext {
  return {
    sql,
    clock,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { resolve: async () => 'x' },
    authz: {
      async upsert(_tx: SqlTx, row: { type: string; id: string; tenantId: string }) {
        authzOps.push({ op: 'upsert', resource: `${row.type}/${row.id}`, row });
        projected.set(`${row.type}/${row.id}`, row.tenantId);
      },
      async remove(_tx: SqlTx, ref: { type: string; id: string }) {
        authzOps.push({ op: 'remove', resource: `${ref.type}/${ref.id}` });
        projected.delete(`${ref.type}/${ref.id}`);
      },
      async setPending() {},
    },
    events: {
      async publish(
        _tx: SqlTx,
        event: { type: string; subject: string; data: Record<string, unknown> },
      ) {
        events.push({ type: event.type, subject: event.subject, data: event.data });
      },
    },
    work: {
      async enqueue(_tx: SqlTx, kind: string, key: string, options?: { notBefore?: number }) {
        if (kind === providerResourcesWork) queue.set(key, options?.notBefore ?? clock.now());
      },
    },
    desired: { async invalidate() {} },
    iam: {
      rootTenantId: 'root',
      async require(_credential: unknown, request: { action: string; resource: { type: string; id: string } }) {
        const resource = `${request.resource.type}/${request.resource.id}`;
        required.push(`${request.action} ${resource}`);
        if (deniedResources.has(resource))
          throw new ComputeError('ACCESS_DENIED', `denied ${request.action} on ${resource}`);
      },
    },
  } as unknown as ModuleContext;
}
function within(tx: SqlTx): SqlExecutor {
  return {
    dialect: 'postgres',
    kind: 'pglite',
    query: (text, params) => tx.query(text, params),
    transaction: (fn, options) => db.transaction(fn, options),
    migrate: () => Promise.reject(new Error('no')),
    close: () => Promise.reject(new Error('no')),
  };
}

const module = vps({ providers: [doLike, bareLike], images: { resolve: async () => undefined } });
const api = module.api!({} as ModuleContext) as VpsApi;

type Definition = {
  action: string | null;
  validate(raw: unknown): unknown;
  resource(input: unknown): { type: string; id: string } | undefined;
  handler(context: MethodContext, input: unknown): Promise<unknown>;
  admission?: {
    prepare(
      context: MethodContext,
      input: unknown,
      tx: SqlTx,
    ): Promise<{ status: string; result?: unknown; resource?: { type: string; id: string } }>;
    denied?(context: MethodContext, input: unknown, tx: SqlTx, error: unknown): Promise<void>;
    abandoned?(context: MethodContext, input: unknown, tx: SqlTx, error: unknown): Promise<void>;
    check?(context: MethodContext, input: unknown, resource: unknown): Promise<void>;
  };
};
/** As the envelope runs a method: tenant pre-check, admission, decision on the projected resource, handler. */
async function run(definition: Definition, raw: unknown, who: Caller): Promise<any> {
  const input = definition.validate(raw);
  const tenantId = (input as { tenantId: string }).tenantId;
  const context = (tx: SqlTx) =>
    ({ ...moduleContext(within(tx)), caller: who, credential: { kind: 'test' }, requestId: 'req' }) as MethodContext;
  if (who.tenantId !== tenantId)
    throw new ComputeError('ACCESS_DENIED', 'The caller belongs to another tenant');
  const admission = definition.admission;
  let resource = definition.resource(input);
  if (admission) {
    const plan = await db.transaction((tx) => admission.prepare(context(tx), input, tx));
    if (plan.status === 'replay') return plan.result;
    resource = plan.resource;
  }
  const home = resource ? projected.get(`${resource.type}/${resource.id}`) : undefined;
  if (resource && home !== undefined && home !== tenantId) {
    const error = new ComputeError('ACCESS_DENIED', `denied on ${resource.type}/${resource.id}`);
    if (admission?.denied)
      await db.transaction((tx) => admission.denied!(context(tx), input, tx, error));
    throw error;
  }
  // The admission's own checks (IAM on other resources), with no transaction open.
  if (admission?.check)
    await admission.check(
      { ...moduleContext(db), caller: who, credential: { kind: 'test' }, requestId: 'req' } as MethodContext,
      input,
      resource,
    );
  try {
    return await db.transaction((tx) => definition.handler(context(tx), input));
  } catch (error) {
    if (admission?.abandoned)
      await db.transaction((tx) => admission.abandoned!(context(tx), input, tx, error));
    throw error;
  }
}
const call = (
  group: 'providerVolumes' | 'providerSnapshots' | 'providerAddresses',
  method: string,
  raw: unknown,
  who: Caller = alice,
) => run((api[group] as unknown as Record<string, Definition>)[method]!, raw, who);
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: { code?: string }) => error.code,
  );

let doPool: string;
let barePool: string;
let doAccount: string;
let keyCounter = 0;

const createVolume = (raw: Record<string, unknown> = {}, who: Caller = alice): Promise<ProviderVolumeView> =>
  call(
    'providerVolumes',
    'create',
    {
      tenantId: who.tenantId,
      poolId: doPool,
      name: `vol-${++keyCounter}`,
      region: 'nyc3',
      sizeGiB: 10,
      idempotencyKey: `k-${keyCounter}`,
      ...raw,
    },
    who,
  );
const createAddress = (raw: Record<string, unknown> = {}, who: Caller = alice): Promise<ProviderAddressView> =>
  call(
    'providerAddresses',
    'create',
    {
      tenantId: who.tenantId,
      poolId: doPool,
      name: `ip-${++keyCounter}`,
      region: 'nyc3',
      idempotencyKey: `k-${keyCounter}`,
      ...raw,
    },
    who,
  );
const getVolume = (volumeId: string): Promise<ProviderVolumeView> =>
  call('providerVolumes', 'get', { tenantId: 'root', volumeId });
const getAddress = (addressId: string): Promise<ProviderAddressView> =>
  call('providerAddresses', 'get', { tenantId: 'root', addressId });

/** A running provider instance (the instances API is not under test here). */
async function insertInstance(
  options: { tenantId?: string; flavor?: string; externalId?: string | null; state?: string } = {},
) {
  const instanceId = `inst_01jz${String(++keyCounter).padStart(22, '0')}`;
  const externalId = options.externalId === null ? null : (options.externalId ?? `droplet-${keyCounter}`);
  await db.query(
    `INSERT INTO instances (id, tenant_id, pool_id, flavor_id, flavor, image_id, runtime, draft, state, desired_state,
                            provider_account_id, external_id, owner_identity_id, idempotency_key, request_hash, version)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, 'img', 'provider', false, $5, 'running', $6, $7, 'usr_alice', $1,
             decode('00', 'hex'), 1)`,
    [
      instanceId,
      options.tenantId ?? 'root',
      doPool,
      options.flavor ?? 'flv_nyc',
      options.state ?? 'running',
      doAccount,
      externalId,
    ],
  );
  if (externalId)
    cloud.machines.set(externalId, options.flavor === 'flv_sfo' ? 'sfo3' : 'nyc3');
  return instanceId;
}

const reconciler = () => module.reconcilers!.find((entry) => entry.name === providerResourcesWork)!;
const runKey = (key: string) =>
  reconciler().run({ ...moduleContext(db), signal: new AbortController().signal } as never, key);
/** The hourly drift pass, with every row it spread across the hour made due at once. */
async function driftNow(): Promise<void> {
  await runKey('drift');
  for (const key of queue.keys()) queue.set(key, clock.now());
}
/** Five seconds pass, then every key that has come due runs once. */
async function tick(): Promise<void> {
  clock.advance(5_000);
  await useSimClock(db, clock.now());
  const due = [...queue].filter(([, at]) => at <= clock.now()).map(([key]) => key);
  for (const key of due) {
    queue.delete(key);
    await runKey(key);
  }
}
async function drain(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks && queue.size > 0; i++) await tick();
}
const quotaUsed = async (resource: string) =>
  Number(
    (
      await db.query<{ used: string }>(
        `SELECT used::text AS used FROM quota_usage WHERE tenant_id = 'root' AND pool_id = $1 AND resource = $2`,
        [doPool, resource],
      )
    ).rows[0]?.used ?? 0,
  );

beforeAll(async () => {
  db = pglite();
  await db.migrate([...capacityMigrations, ...vpsMigrations]);
  clock = manualClock(T0);
  await useSimClock(db, T0);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, 'root', 'shared', 'us', 1)`,
    [SITE],
  );
  const capacity = capacityModule().api!({} as ModuleContext) as unknown as Record<
    string,
    Record<string, Definition>
  >;
  const accounts = api as unknown as Record<string, Record<string, Definition>>;
  const makeAccount = async (provider: string, name: string, config: Record<string, unknown>) =>
    (
      (await run(
        accounts.providerAccounts!.create!,
        { tenantId: 'root', provider, name, config },
        alice,
      )) as { id: string }
    ).id;
  doAccount = await makeAccount('fake-do', 'do-main', { regions: ['nyc3', 'sfo3'] });
  const bareAccount = await makeAccount('fake-bare', 'bare', {});
  const poolOn = async (providerAccountId: string) =>
    (
      (await run(
        capacity.pools!.create!,
        { tenantId: 'root', siteId: SITE, class: 'provider', providerAccountId },
        alice,
      )) as { id: string }
    ).id;
  doPool = await poolOn(doAccount);
  barePool = await poolOn(bareAccount);
  await db.query(
    `INSERT INTO flavors (id, pool_id, name, vcpu, memory_gib, disk_gib, offer_id, version)
     VALUES ('flv_nyc', $1, 'small', 1, 1, 25, 'nyc3/s-1vcpu-1gb', 1),
            ('flv_sfo', $1, 'small-sfo', 1, 1, 25, 'sfo3/s-1vcpu-1gb', 1)`,
    [doPool],
  );
  // The other tenant sees the pool, as an offered tenant does.
  await db.query(`INSERT INTO pool_offers (pool_id, tenant_id) VALUES ($1, 'other')`, [doPool]);
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.query(`DELETE FROM provider_volume_attachments`);
  await db.query(`UPDATE provider_volumes SET source_snapshot_id = NULL`);
  await db.query(`DELETE FROM provider_snapshots`);
  await db.query(`DELETE FROM provider_volumes`);
  await db.query(`DELETE FROM provider_addresses`);
  await db.query(`DELETE FROM instance_usage_intervals`);
  await db.query(`DELETE FROM instances`);
  await db.transaction(async (tx) => {
    await setQuota(tx, 'root', doPool, 'diskGiB', 1000);
    await setQuota(tx, 'root', doPool, 'addresses', 5);
    await tx.query(`UPDATE quota_usage SET used = 0 WHERE pool_id = $1`, [doPool]);
  });
  projected.clear();
  deniedResources.clear();
  required.length = 0;
  events.length = 0;
  authzOps.length = 0;
  queue.clear();
  cloud.reset();
});

describe('api surface', () => {
  it('every list row has a get, so the list recipe knows its item kind', async () => {
    const { apiMethod, apiSurface } = await import('@better-compute/core');
    const groups = ['providerVolumes', 'providerSnapshots', 'providerAddresses'];
    for (const group of groups) {
      expect(apiMethod(group, 'get')?.resource, group).toMatch(/^provider-/);
      const rows = apiSurface.filter((row) => row.group === group);
      expect(Object.keys(api[group as keyof VpsApi] as object).sort(), group).toEqual(
        rows.map((row) => row.method).sort(),
      );
    }
  });
});

describe('providerVolumes', () => {
  it('create records a pending volume, books its GiB and replays under the key', async () => {
    const created = await createVolume({ name: 'data', sizeGiB: 40, idempotencyKey: 'data-1' });
    expect(created).toMatchObject({
      tenantId: 'root',
      poolId: doPool,
      providerAccountId: doAccount,
      name: 'data',
      region: 'nyc3',
      sizeGiB: 40,
      deleteWithInstance: false,
      state: 'pending',
      desiredState: 'present',
    });
    expect(created.id).toMatch(/^pvol_/);
    expect(await quotaUsed('diskGiB')).toBe(40);
    expect(queue.has(created.id)).toBe(true);
    expect(events.map((event) => event.type)).toEqual(['providerVolume.created']);
    expect(events[0]).toMatchObject({
      subject: `provider-volume/${created.id}`,
      data: { volumeId: created.id, sizeGiB: 40 },
    });
    expect(authzOps.filter((op) => op.op === 'upsert').at(-1)!.row).toMatchObject({
      type: 'provider-volume',
      tenantId: 'root',
      parentType: 'tenant',
      ownerId: 'usr_alice',
      attributes: { providerAccountId: doAccount, poolId: doPool, region: 'nyc3' },
    });

    const again = await createVolume({ name: 'data', sizeGiB: 40, idempotencyKey: 'data-1' });
    expect(again.id).toBe(created.id);
    expect(await quotaUsed('diskGiB')).toBe(40);
    expect(await codeOf(createVolume({ name: 'data', sizeGiB: 41, idempotencyKey: 'data-1' }))).toBe(
      'CONFLICT',
    );
    expect(await codeOf(createVolume({ name: 'data', idempotencyKey: 'data-2' }))).toBe('CONFLICT');
    expect(await codeOf(createVolume({ name: 'Bad_Name' }))).toBe('INVALID_INPUT');
    expect(await codeOf(createVolume({ sizeGiB: 0 }))).toBe('INVALID_INPUT');
    expect(await codeOf(createVolume({ region: 'ams3' }))).toBe('INVALID_INPUT');
    expect(await codeOf(createVolume({ poolId: barePool }))).toBe('UNSUPPORTED');
    const listed = await call('providerVolumes', 'list', { tenantId: 'root' });
    expect(listed.items.map((item: ProviderVolumeView) => item.id)).toEqual([created.id]);
    expect((await call('providerVolumes', 'list', { tenantId: 'other' }, mallory)).items).toEqual([]);
  });

  it('fails closed on quota: no diskGiB row grants nothing, and a refused create stages nothing', async () => {
    authzOps.length = 0;
    expect(await codeOf(createVolume({ idempotencyKey: 'other-1' }, mallory))).toBe('QUOTA_EXCEEDED');
    const staged = authzOps.filter((op) => op.resource.startsWith('provider-volume/'));
    expect(staged.map((op) => op.op)).toEqual(['upsert', 'remove']);
    expect(await codeOf(createVolume({ sizeGiB: 1001 }))).toBe('QUOTA_EXCEEDED');
  });

  it('converges a volume to ready, attaches it, grows it and refuses to shrink it', async () => {
    cloud.pendingTicks = 1;
    const instanceId = await insertInstance();
    const volume = await createVolume({ instanceId, sizeGiB: 10 });
    expect(volume.attachment).toMatchObject({ instanceId, state: 'pending', desiredState: 'present' });
    await drain();
    const ready = await getVolume(volume.id);
    expect(ready).toMatchObject({
      state: 'ready',
      device: `/dev/disk/by-id/scsi-0DO_Volume_${providerResourceName(volume.id)}`,
      attachment: { instanceId, state: 'ready' },
    });
    const [providerVolume] = [...cloud.volumes.values()];
    expect(providerVolume).toMatchObject({ attachedTo: `droplet-${keyCounter - 1}`, sizeGiB: 10 });
    expect(cloud.calls).toContain(
      `attachVolume ${providerVolume!.id} droplet-${keyCounter - 1} ${instanceId}`,
    );
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['providerVolume.ready', 'providerVolume.attached']),
    );

    expect(
      await codeOf(call('providerVolumes', 'resize', { tenantId: 'root', volumeId: volume.id, sizeGiB: 9 })),
    ).toBe('INVALID_INPUT');
    const grown = await call('providerVolumes', 'resize', {
      tenantId: 'root',
      volumeId: volume.id,
      sizeGiB: 25,
    });
    expect(grown.sizeGiB).toBe(25);
    expect(await quotaUsed('diskGiB')).toBe(25);
    await drain();
    expect(providerVolume!.sizeGiB).toBe(25);
    expect((await getVolume(volume.id)).state).toBe('ready');
    expect(events.some((event) => event.type === 'providerVolume.resized')).toBe(true);
  });

  it('attach: ACCESS_DENIED for another tenant, INVALID_INPUT in another region, CONFLICT when attached', async () => {
    const volume = await createVolume();
    const theirs = await insertInstance({ tenantId: 'other' });
    const elsewhere = await insertInstance({ flavor: 'flv_sfo' });
    const mine = await insertInstance();
    const other = await insertInstance();
    const attach = (instanceId: string) =>
      call('providerVolumes', 'attach', { tenantId: 'root', volumeId: volume.id, instanceId });
    expect(await codeOf(attach(theirs))).toBe('ACCESS_DENIED');
    expect(await codeOf(attach(elsewhere))).toBe('INVALID_INPUT');
    expect(cloud.calls).toEqual([]);
    expect((await attach(mine)).attachment).toMatchObject({ instanceId: mine });
    expect((await attach(mine)).attachment).toMatchObject({ instanceId: mine });
    expect(await codeOf(attach(other))).toBe('CONFLICT');
    // Another tenant cannot act on the volume at all.
    expect(
      await codeOf(
        call('providerVolumes', 'get', { tenantId: 'other', volumeId: volume.id }, mallory),
      ),
    ).toBe('ACCESS_DENIED');
  });

  it('attach, create attached and assign also decide compute:instances:update on the instance', async () => {
    const instanceId = await insertInstance();
    const volume = await createVolume();
    const address = await createAddress();
    deniedResources.add(`compute-instance/${instanceId}`);
    expect(
      await codeOf(call('providerVolumes', 'attach', { tenantId: 'root', volumeId: volume.id, instanceId })),
    ).toBe('ACCESS_DENIED');
    expect((await getVolume(volume.id)).attachment).toBeUndefined();
    expect(await codeOf(createVolume({ instanceId, sizeGiB: 7 }))).toBe('ACCESS_DENIED');
    expect(
      Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM provider_volumes`)).rows[0]!.n),
    ).toBe(1);
    expect(await quotaUsed('diskGiB')).toBe(10);
    expect(
      await codeOf(call('providerAddresses', 'assign', { tenantId: 'root', addressId: address.id, instanceId })),
    ).toBe('ACCESS_DENIED');
    expect((await getAddress(address.id)).instanceId).toBeUndefined();
    expect(required).toContain(`compute:instances:update compute-instance/${instanceId}`);
    // With the right on the instance, the same calls go through.
    deniedResources.clear();
    expect(
      (await call('providerVolumes', 'attach', { tenantId: 'root', volumeId: volume.id, instanceId })).attachment,
    ).toMatchObject({ instanceId });
    expect(
      (await call('providerAddresses', 'assign', { tenantId: 'root', addressId: address.id, instanceId }))
        .instanceId,
    ).toBe(instanceId);
  });

  it('delete: INVALID_STATE while attached; detach then delete removes it and refunds its quota', async () => {
    const instanceId = await insertInstance();
    const volume = await createVolume({ instanceId, sizeGiB: 30 });
    await drain();
    const ref = { tenantId: 'root', volumeId: volume.id };
    expect(await codeOf(call('providerVolumes', 'delete', ref))).toBe('INVALID_STATE');
    await call('providerVolumes', 'detach', ref);
    await drain();
    expect((await getVolume(volume.id)).attachment).toBeUndefined();
    expect([...cloud.volumes.values()][0]!.attachedTo).toBeUndefined();
    expect(events.some((event) => event.type === 'providerVolume.detached')).toBe(true);

    const deleting = await call('providerVolumes', 'delete', ref);
    expect(deleting).toMatchObject({ state: 'deleting', desiredState: 'deleted' });
    expect(await quotaUsed('diskGiB')).toBe(30);
    await drain();
    expect((await getVolume(volume.id)).state).toBe('deleted');
    expect(cloud.volumes.size).toBe(0);
    expect(await quotaUsed('diskGiB')).toBe(0);
    expect(authzOps.at(-1)).toEqual({ op: 'remove', resource: `provider-volume/${volume.id}` });
    expect(events.at(-1)!.type).toBe('providerVolume.deleted');
    // Its name is free again.
    expect((await createVolume({ name: volume.name })).name).toBe(volume.name);
  });

  it('a detach asked while the provider still runs the attach waits for it, then detaches', async () => {
    const instanceId = await insertInstance();
    const machine = `droplet-${keyCounter}`;
    cloud.slowAttach = true;
    const volume = await createVolume({ instanceId });
    await tick();
    await tick();
    const [providerVolume] = [...cloud.volumes.values()];
    expect(providerVolume!.attaching).toBe(machine);
    expect((await getVolume(volume.id)).attachment).toMatchObject({ state: 'pending' });
    const ref = { tenantId: 'root', volumeId: volume.id };
    await call('providerVolumes', 'detach', ref);
    await tick();
    // The provider was asked, and its attach still runs: the detach is not settled.
    expect(cloud.calls).toContain(`detachVolume ${providerVolume!.id} ${machine}`);
    expect((await getVolume(volume.id)).attachment).toMatchObject({ desiredState: 'deleted', state: 'deleting' });
    // The provider finishes the attach; the next run detaches it.
    cloud.slowAttach = false;
    cloud.finishAttaches();
    expect(providerVolume!.attachedTo).toBe(machine);
    await drain();
    expect(providerVolume!.attachedTo).toBeUndefined();
    expect((await getVolume(volume.id)).attachment).toBeUndefined();
    await call('providerVolumes', 'delete', ref);
    await drain();
    expect((await getVolume(volume.id)).state).toBe('deleted');
    expect(cloud.volumes.size).toBe(0);
  });

  it('a volume on a machine of ours that no attachment names is detached; a machine not ours is left alone', async () => {
    const instanceId = await insertInstance();
    const machine = `droplet-${keyCounter}`;
    const volume = await createVolume();
    const other = await createVolume();
    await drain();
    const byName = (id: string) =>
      [...cloud.volumes.values()].find((entry) => entry.spec.name === providerResourceName(id))!;
    // As if an attach the tenant no longer wanted finished after its detach was settled.
    byName(volume.id).attachedTo = machine;
    byName(other.id).attachedTo = 'droplet-stranger';
    // Settled rows are read again by the hourly drift pass.
    await driftNow();
    await drain();
    expect(byName(volume.id).attachedTo).toBeUndefined();
    expect(cloud.calls).toContain(`detachVolume ${byName(volume.id).id} ${machine}`);
    expect((await getVolume(volume.id)).state).toBe('ready');
    expect(byName(other.id).attachedTo).toBe('droplet-stranger');
    expect(cloud.calls.some((label) => label.includes('droplet-stranger'))).toBe(false);
    // Delete finds it on our machine again: detached first, then deleted.
    byName(volume.id).attachedTo = machine;
    const id = byName(volume.id).id;
    await call('providerVolumes', 'delete', { tenantId: 'root', volumeId: volume.id });
    await drain();
    expect((await getVolume(volume.id)).state).toBe('deleted');
    expect(cloud.volumes.has(id)).toBe(false);
    expect(instanceId).toMatch(/^inst_/);
  });

  it('a create the provider refused is deleted without a provider call, and its quota refunded', async () => {
    const volume = await createVolume({ sizeGiB: 30 });
    cloud.failNext = new ComputeError('QUOTA_EXCEEDED', 'volume limit reached');
    await tick();
    expect(await getVolume(volume.id)).toMatchObject({ state: 'error', message: 'volume limit reached' });
    expect(await quotaUsed('diskGiB')).toBe(30);
    cloud.calls.length = 0;
    await call('providerVolumes', 'delete', { tenantId: 'root', volumeId: volume.id });
    await drain();
    await runKey('all');
    await drain();
    expect((await getVolume(volume.id)).state).toBe('deleted');
    expect(await quotaUsed('diskGiB')).toBe(0);
    expect(cloud.calls).toEqual([]);
    expect(cloud.volumes.size).toBe(0);
  });

  it('a delete after an answer that may have created the volume looks it up by name, never creating one', async () => {
    // An accepted create with no body: the volume may exist.
    const unsure = await createVolume();
    cloud.failNext = new ComputeError('PROVIDER_ERROR', 'accepted a create but returned no volume');
    await tick();
    expect((await getVolume(unsure.id)).state).toBe('error');
    await call('providerVolumes', 'delete', { tenantId: 'root', volumeId: unsure.id });
    cloud.calls.length = 0;
    await drain();
    expect((await getVolume(unsure.id)).state).toBe('deleted');
    expect(cloud.calls).toEqual([`findVolume ${providerResourceName(unsure.id)}`]);

    // A lost answer whose create landed: found, then deleted.
    const landed = await createVolume();
    cloud.failNext = new ComputeError('TIMEOUT', 'the answer was lost');
    await tick();
    const name = providerResourceName(landed.id);
    cloud.volumes.set('vol-landed', {
      id: 'vol-landed',
      spec: { name, region: 'nyc3', sizeGiB: 10, kind: 'block' },
      sizeGiB: 10,
    });
    await call('providerVolumes', 'delete', { tenantId: 'root', volumeId: landed.id });
    cloud.calls.length = 0;
    queue.set(landed.id, clock.now());
    await drain();
    expect((await getVolume(landed.id)).state).toBe('deleted');
    expect(cloud.volumes.size).toBe(0);
    expect(cloud.calls.some((label) => label.startsWith('ensureVolume'))).toBe(false);
    expect(cloud.calls).toContain('deleteVolume vol-landed');
  });

  it('the 5-minute pass wakes only rows that are not settled; the hourly drift pass spreads the settled ones', async () => {
    const instanceId = await insertInstance();
    const ready = await createVolume();
    const attached = await createVolume({ instanceId });
    const address = await createAddress();
    await drain();
    const failing = await createVolume();
    cloud.failNext = new ComputeError('INVALID_INPUT', 'refused');
    await tick();
    expect((await getVolume(failing.id)).state).toBe('error');
    // Wanted elsewhere: an attachment and an assignment not yet where they are wanted.
    const moving = await createAddress();
    await drain();
    await call('providerAddresses', 'assign', { tenantId: 'root', addressId: moving.id, instanceId });
    queue.clear();
    await runKey('all');
    expect([...queue.keys()].sort()).toEqual([failing.id, moving.id].sort());
    queue.clear();
    await runKey('drift');
    const spread = [...queue].sort(([a], [b]) => a.localeCompare(b));
    expect(spread.map(([key]) => key).sort()).toEqual([ready.id, attached.id, address.id].sort());
    const offsets = spread.map(([, at]) => at - clock.now());
    expect(offsets[0]).toBe(0);
    expect(new Set(offsets).size).toBe(3);
    expect(Math.max(...offsets)).toBeLessThan(3_600_000);
  });

  it('a ready volume deleted at the provider outside better-compute is an error, never created again', async () => {
    const instanceId = await insertInstance();
    const volume = await createVolume({ instanceId });
    await drain();
    const ready = await getVolume(volume.id);
    expect(ready).toMatchObject({ state: 'ready', attachment: { state: 'ready' } });
    const externalId = [...cloud.volumes.keys()][0]!;
    // Deleted at the provider by hand (console, API, another tool).
    cloud.volumes.delete(externalId);
    cloud.calls.length = 0;
    events.length = 0;
    await driftNow();
    await drain();
    const after = await getVolume(volume.id);
    expect(after.state).toBe('error');
    expect(after.message).toMatch(/deleted at the provider outside better-compute/);
    expect(cloud.volumes.size).toBe(0);
    expect(cloud.calls.filter((label) => !label.startsWith('getVolume'))).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(['providerVolume.error']);
    const { rows } = await db.query<{ external_id: string }>(
      `SELECT external_id FROM provider_volumes WHERE id = $1`,
      [volume.id],
    );
    expect(rows[0]!.external_id).toBe(externalId);
    // Another pass changes nothing and publishes nothing new.
    await runKey('all');
    await drain();
    expect(cloud.volumes.size).toBe(0);
    expect(events).toHaveLength(1);
    // Its delete finishes without a provider write, and refunds its quota.
    await call('providerVolumes', 'detach', { tenantId: 'root', volumeId: volume.id }).catch(() => undefined);
    await call('providerVolumes', 'delete', { tenantId: 'root', volumeId: volume.id });
    await drain();
    expect((await getVolume(volume.id)).state).toBe('deleted');
    expect(await quotaUsed('diskGiB')).toBe(0);
    expect(cloud.calls.filter((label) => !label.startsWith('getVolume'))).toEqual([]);
  });

  it('a volume never sent to the provider is deleted without a provider call', async () => {
    const volume = await createVolume();
    await call('providerVolumes', 'delete', { tenantId: 'root', volumeId: volume.id });
    await drain();
    expect((await getVolume(volume.id)).state).toBe('deleted');
    expect(cloud.calls).toEqual([]);
  });

  it('a provider that is busy is tried again later; a refusal is an error the next change retries', async () => {
    const volume = await createVolume();
    cloud.failNext = new ComputeError('RATE_LIMITED', 'slow down');
    await tick();
    expect((await getVolume(volume.id)).state).toBe('pending');
    expect(queue.get(volume.id)).toBe(clock.now() + 30_000);
    queue.set(volume.id, clock.now());
    cloud.failNext = new ComputeError('CONFLICT', 'a volume of this name is not ours');
    await tick();
    expect(await getVolume(volume.id)).toMatchObject({
      state: 'error',
      message: 'a volume of this name is not ours',
    });
    expect(events.at(-1)!.type).toBe('providerVolume.error');
    await runKey('all');
    await drain();
    expect((await getVolume(volume.id)).state).toBe('ready');
  });
});

describe('providerSnapshots', () => {
  it('snapshots a volume, restores it into a new volume and deletes the snapshot', async () => {
    const volume = await createVolume({ sizeGiB: 20 });
    await drain();
    const snapshot: ProviderSnapshotView = await call('providerVolumes', 'snapshot', {
      tenantId: 'root',
      volumeId: volume.id,
      name: 'nightly',
      idempotencyKey: 'snap-1',
    });
    expect(snapshot).toMatchObject({ volumeId: volume.id, name: 'nightly', state: 'pending' });
    expect(snapshot.id).toMatch(/^psnap_/);
    const restoreRaw = { tenantId: 'root', snapshotId: snapshot.id, name: 'copy', idempotencyKey: 'r-1' };
    expect(await codeOf(call('providerSnapshots', 'restore', restoreRaw))).toBe('INVALID_STATE');
    await drain();
    const listed = await call('providerSnapshots', 'list', { tenantId: 'root', volumeId: volume.id });
    expect(listed.items).toMatchObject([{ id: snapshot.id, state: 'ready', sizeGiB: 20 }]);
    expect(
      await call('providerSnapshots', 'get', { tenantId: 'root', snapshotId: snapshot.id }),
    ).toMatchObject({ id: snapshot.id, state: 'ready' });

    expect(
      await codeOf(call('providerSnapshots', 'restore', { ...restoreRaw, sizeGiB: 10 })),
    ).toBe('INVALID_INPUT');
    const restored: ProviderVolumeView = await call('providerSnapshots', 'restore', restoreRaw);
    expect(restored).toMatchObject({ name: 'copy', sizeGiB: 20, sourceSnapshotId: snapshot.id });
    await drain();
    expect((await getVolume(restored.id)).state).toBe('ready');
    const made = [...cloud.volumes.values()].find(
      (entry) => entry.spec.name === providerResourceName(restored.id),
    );
    expect(made?.spec.snapshotId).toBe([...cloud.snapshots.values()][0]!.id);
    expect(await quotaUsed('diskGiB')).toBe(40);

    await call('providerSnapshots', 'delete', { tenantId: 'root', snapshotId: snapshot.id });
    await drain();
    expect(cloud.snapshots.size).toBe(0);
    expect(
      (await call('providerSnapshots', 'list', { tenantId: 'root', includeDeleted: true })).items,
    ).toMatchObject([{ id: snapshot.id, state: 'deleted' }]);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'providerVolume.snapshot.created',
        'providerVolume.snapshot.ready',
        'providerVolume.snapshot.deleted',
      ]),
    );
  });
});

describe('providerAddresses', () => {
  it('reserves, assigns, refuses a second instance and another tenant, unassigns and deletes', async () => {
    const instanceId = await insertInstance();
    const address = await createAddress({ name: 'ingress' });
    expect(address).toMatchObject({ name: 'ingress', family: 'ipv4', state: 'pending', assignmentState: 'none' });
    expect(address.id).toMatch(/^paddr_/);
    expect(await quotaUsed('addresses')).toBe(1);
    await drain();
    const ready = await getAddress(address.id);
    expect(ready.state).toBe('ready');
    expect(ready.address).toMatch(/^203\.0\.113\./);

    const ref = { tenantId: 'root', addressId: address.id };
    const theirs = await insertInstance({ tenantId: 'other' });
    expect(await codeOf(call('providerAddresses', 'assign', { ...ref, instanceId: theirs }))).toBe(
      'ACCESS_DENIED',
    );
    await call('providerAddresses', 'assign', { ...ref, instanceId });
    const second = await insertInstance();
    expect(await codeOf(call('providerAddresses', 'assign', { ...ref, instanceId: second }))).toBe(
      'CONFLICT',
    );
    await drain();
    expect(await getAddress(address.id)).toMatchObject({ instanceId, assignmentState: 'ready' });
    expect(cloud.addresses.get(ready.address!)!.assignedTo).toBe(`droplet-${keyCounter - 3}`);
    expect(await codeOf(call('providerAddresses', 'delete', ref))).toBe('INVALID_STATE');

    await call('providerAddresses', 'unassign', ref);
    await drain();
    expect(await getAddress(address.id)).toMatchObject({ assignmentState: 'none' });
    expect(cloud.addresses.get(ready.address!)!.assignedTo).toBeUndefined();
    await call('providerAddresses', 'delete', ref);
    await drain();
    expect((await getAddress(address.id)).state).toBe('deleted');
    expect(cloud.addresses.size).toBe(0);
    expect(await quotaUsed('addresses')).toBe(0);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'providerAddress.created',
        'providerAddress.ready',
        'providerAddress.assigned',
        'providerAddress.unassigned',
        'providerAddress.deleted',
      ]),
    );
  });

  it('never reserves twice after a lost reserve answer', async () => {
    const address = await createAddress();
    cloud.failNext = new ComputeError('TIMEOUT', 'the answer was lost');
    await tick();
    queue.set(address.id, clock.now());
    await tick();
    const after = await getAddress(address.id);
    expect(after.state).toBe('error');
    expect(after.message).toMatch(/answer to the reserve was lost/);
    expect(cloud.calls.filter((label) => label === 'ensureAddress new')).toHaveLength(1);
    // A rate-limited reserve reserved nothing: the next run reserves.
    const other = await createAddress();
    cloud.failNext = new ComputeError('RATE_LIMITED', 'slow down');
    await tick();
    queue.set(other.id, clock.now());
    await tick();
    expect((await getAddress(other.id)).state).toBe('ready');
  });

  it('a delete never releases another reservation at the address it recorded; its row is finished', async () => {
    const address = await createAddress();
    await drain();
    const ip = (await getAddress(address.id)).address!;
    const { rows } = await db.query<{ fingerprint: string | null }>(
      `SELECT fingerprint FROM provider_addresses WHERE id = $1`,
      [address.id],
    );
    expect(rows[0]!.fingerprint).toMatch(/^fp-/);
    // Released out of band; the provider handed the IP to the account owner's own reservation.
    cloud.addresses.set(ip, { ...cloud.addresses.get(ip)!, fingerprint: 'owner', assignedTo: 'droplet-owner' });
    cloud.calls.length = 0;
    await call('providerAddresses', 'delete', { tenantId: 'root', addressId: address.id });
    await drain();
    expect((await getAddress(address.id)).state).toBe('deleted');
    expect(await quotaUsed('addresses')).toBe(0);
    expect(cloud.addresses.get(ip)).toMatchObject({ fingerprint: 'owner', assignedTo: 'droplet-owner' });
    expect(cloud.calls.filter((label) => !label.startsWith('getAddress'))).toEqual([]);
  });

  it('an address quota of 0 refuses the reserve', async () => {
    await db.transaction((tx) => setQuota(tx, 'root', doPool, 'addresses', 0));
    expect(await codeOf(createAddress())).toBe('QUOTA_EXCEEDED');
  });
});

describe('instance delete', () => {
  const instanceReconciler = () => module.reconcilers!.find((entry) => entry.name === 'vps.instances')!;
  /** Asks for the instance's delete and runs its controller until it is deleted. */
  async function deleteInstance(instanceId: string, onDelete?: 'detach'): Promise<void> {
    await db.query(
      `UPDATE instances SET desired_state = 'deleted', version = version + 1,
              origin = CASE WHEN $2::text IS NULL THEN origin ELSE 'attached' END,
              on_delete = coalesce($2::text, on_delete),
              provider_claimed_at = CASE WHEN $2::text IS NULL THEN provider_claimed_at ELSE compute_now() END
        WHERE id = $1`,
      [instanceId, onDelete ?? null],
    );
    for (let i = 0; i < 5; i++) {
      await instanceReconciler().run(
        { ...moduleContext(db), signal: new AbortController().signal } as never,
        instanceId,
      );
      const { rows } = await db.query<{ state: string }>(`SELECT state FROM instances WHERE id = $1`, [instanceId]);
      if (rows[0]?.state === 'deleted') return;
    }
    throw new Error(`instance ${instanceId} was not deleted`);
  }
  const attachmentsOf = async (instanceId: string) =>
    (
      await db.query<{ volume_id: string; state: string; desired_state: string }>(
        `SELECT volume_id, state, desired_state FROM provider_volume_attachments WHERE instance_id = $1
          ORDER BY volume_id`,
        [instanceId],
      )
    ).rows;

  it('deletes its deleteWithInstance volumes with its machine, detaches the others and keeps its addresses', async () => {
    const instanceId = await insertInstance();
    const machine = `droplet-${keyCounter}`;
    const keep = await createVolume({ instanceId, sizeGiB: 10 });
    const gone = await createVolume({ instanceId, sizeGiB: 20, deleteWithInstance: true });
    const address = await createAddress();
    await call('providerAddresses', 'assign', { tenantId: 'root', addressId: address.id, instanceId });
    await drain();
    expect((await getVolume(gone.id)).attachment).toMatchObject({ state: 'ready' });
    expect(await getAddress(address.id)).toMatchObject({ assignmentState: 'ready' });
    const goneExternal = [...cloud.volumes.values()].find(
      (volume) => volume.spec.name === providerResourceName(gone.id),
    )!.id;

    await deleteInstance(instanceId);
    // One machine delete names the volume to go with it (DO's selective destroy, DO-D16).
    expect(cloud.calls.filter((label) => label.startsWith('delete '))).toEqual([
      `delete ${machine} ${goneExternal}`,
    ]);
    // The instance's attachments are no longer wanted, and every resource it had is woken.
    expect((await attachmentsOf(instanceId)).map((row) => row.desired_state)).toEqual(['deleted', 'deleted']);
    expect([...queue.keys()].sort()).toEqual([address.id, gone.id, keep.id].sort());
    expect(await getVolume(gone.id)).toMatchObject({ desiredState: 'deleted', state: 'deleting' });
    await drain();

    expect(await getVolume(keep.id)).toMatchObject({ state: 'ready', desiredState: 'present' });
    expect((await getVolume(keep.id)).attachment).toBeUndefined();
    expect((await getVolume(gone.id)).state).toBe('deleted');
    expect(cloud.volumes.size).toBe(1);
    expect(await quotaUsed('diskGiB')).toBe(10);
    // The address is unassigned and kept.
    expect(await getAddress(address.id)).toMatchObject({ state: 'ready', assignmentState: 'none' });
    expect((await getAddress(address.id)).instanceId).toBeUndefined();
    expect(cloud.addresses.size).toBe(1);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'providerVolume.detached',
        'providerVolume.deleted',
        'providerAddress.unassigned',
      ]),
    );
    expect(cloud.calls).not.toContain(`deleteVolume ${goneExternal}`);
  });

  it('a provider without selective destroy: the volume is deleted after the machine', async () => {
    cloud.selective = false;
    const instanceId = await insertInstance();
    const gone = await createVolume({ instanceId, deleteWithInstance: true });
    await drain();
    await deleteInstance(instanceId);
    await drain();
    expect((await getVolume(gone.id)).state).toBe('deleted');
    expect(cloud.volumes.size).toBe(0);
    expect(cloud.calls.some((label) => label.startsWith('deleteVolume '))).toBe(true);
    expect(await quotaUsed('diskGiB')).toBe(0);
  });

  it('while the instance is being deleted, its deleteWithInstance volume waits without a provider call', async () => {
    const instanceId = await insertInstance();
    const gone = await createVolume({ instanceId, deleteWithInstance: true });
    await drain();
    await db.query(`UPDATE instances SET state = 'deleting', desired_state = 'deleted' WHERE id = $1`, [
      instanceId,
    ]);
    // The machine's delete took the volume (its answer not yet applied): the volume is never made again.
    cloud.volumes.clear();
    cloud.calls.length = 0;
    queue.set(gone.id, clock.now());
    await tick();
    expect(cloud.calls).toEqual([]);
    expect(await getVolume(gone.id)).toMatchObject({ desiredState: 'present', state: 'ready' });
  });

  it('a deleteWithInstance volume is not detached once its instance is being deleted', async () => {
    const instanceId = await insertInstance();
    const gone = await createVolume({ instanceId, deleteWithInstance: true });
    const kept = await createVolume({ instanceId });
    await drain();
    await db.query(`UPDATE instances SET desired_state = 'deleted' WHERE id = $1`, [instanceId]);
    expect(
      await codeOf(call('providerVolumes', 'detach', { tenantId: 'root', volumeId: gone.id })),
    ).toBe('INVALID_STATE');
    // One without deleteWithInstance may still be detached first.
    expect(
      (await call('providerVolumes', 'detach', { tenantId: 'root', volumeId: kept.id })).attachment,
    ).toMatchObject({ desiredState: 'deleted' });
  });

  it('a deleteWithInstance volume detached before the instance delete is kept', async () => {
    const instanceId = await insertInstance();
    const machine = `droplet-${keyCounter}`;
    const volume = await createVolume({ instanceId, deleteWithInstance: true });
    await drain();
    // Detached, the detach not settled yet when the instance is deleted.
    await call('providerVolumes', 'detach', { tenantId: 'root', volumeId: volume.id });
    queue.clear();
    await deleteInstance(instanceId);
    expect(cloud.calls.filter((label) => label.startsWith('delete '))).toEqual([`delete ${machine} -`]);
    await drain();
    expect(await getVolume(volume.id)).toMatchObject({ state: 'ready', desiredState: 'present' });
    expect((await getVolume(volume.id)).attachment).toBeUndefined();
    expect(cloud.volumes.size).toBe(1);
  });

  it('a machine the instance leaves running keeps its volumes: detached, never deleted', async () => {
    const instanceId = await insertInstance();
    const kept = await createVolume({ instanceId, deleteWithInstance: true });
    await drain();
    await deleteInstance(instanceId, 'detach');
    expect(cloud.calls.filter((label) => label.startsWith('delete '))).toEqual([]);
    await drain();
    expect(await getVolume(kept.id)).toMatchObject({ state: 'ready', desiredState: 'present' });
    expect((await getVolume(kept.id)).attachment).toBeUndefined();
    expect(cloud.volumes.size).toBe(1);
  });
});

describe('usage', () => {
  const HOUR = 3_600_000;
  const windows = async (kind: string, sourceId: string) =>
    (
      await db.query<{ meter: string; quantity: string; tags: Record<string, string> | string; key: string }>(
        `SELECT meter, quantity::text, tags, idempotency_key AS key FROM usage_windows
          WHERE source_kind = $1 AND source_id = $2 ORDER BY window_start`,
        [kind, sourceId],
      )
    ).rows.map((row) => ({
      ...row,
      quantity: Number(row.quantity),
      tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
    }));
  const total = (list: { quantity: number }[]) =>
    Math.round(list.reduce((sum, row) => sum + row.quantity, 0) * 1e6) / 1e6;
  const meter = (kinds?: ('volume' | 'snapshot' | 'address')[]) =>
    db.transaction((tx) =>
      meterProviderResources(tx, clock.now(), { rootTenantId: 'root', meterGraceMs: 0 }, kinds ? { kinds } : {}),
    );
  async function advanceTo(at: number): Promise<void> {
    clock.advance(at - clock.now());
    await useSimClock(db, clock.now());
  }

  it('bills a snapshot from ready until deleted, by default, once per hour', async () => {
    const volume = await createVolume({ sizeGiB: 8 });
    await drain();
    const snapshot = await call('providerVolumes', 'snapshot', {
      tenantId: 'root',
      volumeId: volume.id,
      name: `snap-${keyCounter}`,
      idempotencyKey: `s-${keyCounter}`,
    });
    await drain();
    const readyAt = Date.parse(
      (
        await db.query<{ ready_at: string }>(`SELECT ready_at::text FROM provider_snapshots WHERE id = $1`, [
          snapshot.id,
        ])
      ).rows[0]!.ready_at,
    );
    const top = Math.floor(clock.now() / HOUR) * HOUR;
    await advanceTo(top + 2 * HOUR + 60_000);
    // The ancillary pass meters provider snapshots, volumes and addresses.
    await db.transaction((tx) => meterAncillaries(tx, clock.now(), { rootTenantId: 'root', meterGraceMs: 0 }));
    const written = await windows('snapshot', snapshot.id);
    expect(written.map((row) => row.meter)).toEqual(['vps.snapshot.gib.hours', 'vps.snapshot.gib.hours']);
    expect(total(written)).toBe(Math.round(((8 * (top + 2 * HOUR - readyAt)) / HOUR) * 1e6) / 1e6);
    expect(written[0]!.tags).toEqual({
      pool: doPool,
      source: 'provider-snapshot',
      region: 'nyc3',
      provider: 'fake-do',
    });
    expect(written[0]!.key).toBe(`cmp:snapshot:${snapshot.id}:${top}:vps.snapshot.gib.hours`);
    expect((await windows('volume', volume.id)).map((row) => row.meter)).toEqual([
      'vps.volume.gib.hours',
      'vps.volume.gib.hours',
    ]);
    // Again: nothing new.
    expect((await meter()).windows).toBe(0);

    await call('providerSnapshots', 'delete', { tenantId: 'root', snapshotId: snapshot.id });
    await drain();
    await advanceTo(clock.now() + 3 * HOUR);
    await meter();
    // It bills until it was deleted, not after.
    const deletedAt = Date.parse(
      (
        await db.query<{ deleted_at: string }>(`SELECT deleted_at::text FROM provider_snapshots WHERE id = $1`, [
          snapshot.id,
        ])
      ).rows[0]!.deleted_at,
    );
    // Each window is rounded to the micro-unit: the sum may differ from the rounded whole by one in the last place.
    expect(total(await windows('snapshot', snapshot.id))).toBeCloseTo((8 * (deletedAt - readyAt)) / HOUR, 5);
  });

  it('bills volumes in GiB-hours and addresses in hours, by default (core/0044 accepts their kinds)', async () => {
    const meterAll = () =>
      db.transaction((tx) => meterAncillaries(tx, clock.now(), { rootTenantId: 'root', meterGraceMs: 0 }));
    const volume = await createVolume({ sizeGiB: 12 });
    const address = await createAddress();
    const never = await createVolume({ sizeGiB: 5 });
    await drain();
    // One that never became ready never bills.
    await db.query(`UPDATE provider_volumes SET ready_at = NULL, state = 'error' WHERE id = $1`, [never.id]);
    const top = Math.floor(clock.now() / HOUR) * HOUR;
    await advanceTo(top + HOUR + 1_000);
    await meterAll();
    const volumeWindows = await windows('volume', volume.id);
    expect(volumeWindows).toHaveLength(1);
    expect(volumeWindows[0]).toMatchObject({ meter: 'vps.volume.gib.hours', tags: { source: 'provider-volume' } });
    expect(volumeWindows[0]!.quantity).toBeGreaterThan(11);
    expect(volumeWindows[0]!.quantity).toBeLessThan(12);
    const addressWindows = await windows('address', address.id);
    expect(addressWindows).toHaveLength(1);
    expect(addressWindows[0]).toMatchObject({ meter: 'vps.address.hours', tags: { source: 'provider-address' } });
    expect(addressWindows[0]!.quantity).toBeLessThan(1);
    expect(await windows('volume', never.id)).toEqual([]);
    await advanceTo(top + 2 * HOUR + 1_000);
    await meterAll();
    expect((await windows('volume', volume.id))[1]!.quantity).toBe(12);
    expect((await windows('address', address.id))[1]!.quantity).toBe(1);
  });

  it('volume and address windows are accepted with the kubernetes module installed after vps', async () => {
    const { kubernetesMigrations } = await import('@better-compute/kubernetes');
    const fresh = pglite();
    try {
      await fresh.migrate([...capacityMigrations, ...vpsMigrations, ...kubernetesMigrations]);
      const insert = (kind: string) =>
        fresh.query(
          `INSERT INTO usage_windows (idempotency_key, source_kind, source_id, tenant_id, meter, quantity,
                                      window_start, window_end)
           VALUES ($1, $2, 'x', 'root', 'm', 1, $3, $4)`,
          [`cmp:${kind}:x:0`, kind, new Date(T0).toISOString(), new Date(T0 + HOUR).toISOString()],
        );
      for (const kind of ['volume', 'address', 'snapshot', 'kubernetes']) await insert(kind);
      await expect(insert('bogus')).rejects.toThrow(/usage_windows_source_kind_ck/);
    } finally {
      await fresh.close();
    }
  });

  it('a BYO pool (platform-fee) bills nothing but advances the watermark', async () => {
    const volume = await createVolume({ sizeGiB: 4 });
    const snapshot = await call('providerVolumes', 'snapshot', {
      tenantId: 'root',
      volumeId: volume.id,
      name: `snap-${keyCounter}`,
      idempotencyKey: `s-${keyCounter}`,
    });
    await drain();
    await advanceTo(Math.floor(clock.now() / HOUR) * HOUR + 2 * HOUR);
    // Another root tenant id: the pool's owner is then a tenant with its own account.
    await db.transaction((tx) =>
      meterProviderResources(tx, clock.now(), { rootTenantId: 'platform', meterGraceMs: 0 }),
    );
    expect(await windows('snapshot', snapshot.id)).toEqual([]);
    const { rows } = await db.query<{ metered_until: string | null }>(
      `SELECT metered_until::text FROM provider_snapshots WHERE id = $1`,
      [snapshot.id],
    );
    expect(rows[0]!.metered_until).not.toBeNull();
  });
});
