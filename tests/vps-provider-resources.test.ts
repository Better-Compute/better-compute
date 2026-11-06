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
}
interface FakeAddress {
  id: string;
  spec: ProviderAddressSpec;
  address: string;
  assignedTo?: string;
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
  reset() {
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
      return { id: machineId, name: machineId, state: 'running', addresses: [] };
    },
    async delete() {},
    volumes: {
      async ensureVolume(spec) {
        cloud.call(`ensureVolume ${spec.name}`);
        const existing = [...cloud.volumes.values()].find((volume) => volume.spec.name === spec.name);
        if (existing) return cloud.volumeState(existing, cloud.running(`create ${spec.name}`) ? 'pending' : 'ready');
        const volume: FakeVolume = { id: `vol-${++cloud.counter}`, spec, sizeGiB: spec.sizeGiB };
        cloud.volumes.set(volume.id, volume);
        return cloud.volumeState(volume, cloud.running(`create ${spec.name}`) ? 'pending' : 'ready');
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
        if (cloud.running(`attach ${volumeId}`)) return { id: volumeId, state: 'pending' };
        volume.attachedTo = machineId;
        return { id: volumeId, state: 'ready' };
      },
      async detachVolume(volumeId, machineId) {
        cloud.call(`detachVolume ${volumeId} ${machineId}`);
        const volume = cloud.volumes.get(volumeId);
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
          if (known) return cloud.addressState(known);
          throw new ComputeError('NOT_FOUND', 'no such address');
        }
        // Like DigitalOcean: no name, so every reserve without an id is a new address.
        const address: FakeAddress = {
          id: `203.0.113.${++cloud.counter}`,
          spec,
          address: `203.0.113.${cloud.counter}`,
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
      async deleteAddress(addressId) {
        cloud.call(`deleteAddress ${addressId}`);
        const address = cloud.addresses.get(addressId);
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
    iam: { rootTenantId: 'root' },
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
  };
};
/** As the envelope runs a method: tenant pre-check, admission, decision on the projected resource, handler. */
async function run(definition: Definition, raw: unknown, who: Caller): Promise<any> {
  const input = definition.validate(raw);
  const tenantId = (input as { tenantId: string }).tenantId;
  const context = (tx: SqlTx) =>
    ({ ...moduleContext(within(tx)), caller: who, requestId: 'req' }) as MethodContext;
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

  it('an address quota of 0 refuses the reserve', async () => {
    await db.transaction((tx) => setQuota(tx, 'root', doPool, 'addresses', 0));
    expect(await codeOf(createAddress())).toBe('QUOTA_EXCEEDED');
  });
});
