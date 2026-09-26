import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  apiMethod,
  ComputeError,
  draftId,
  manualClock,
  newId,
  type Caller,
  type ManualClock,
  type MethodContext,
  type ModuleContext,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { capacityMigrations, capacityModule, createCapacityPort, readQuotas } from '@better-compute/capacity';
import {
  finishVolumeDeletions,
  hostVolumeSpecs,
  instanceSpecs,
  instanceWork,
  meterVolumes,
  reportInstances,
  setIpPool,
  volumeMeter,
  volumeSerial,
  volumeHeadroomGiB,
  volumeStorageSelfCheck,
  volumeStorageStatusHandler,
  volumeWork,
  vps,
  vpsMigrations,
  type VpsApi,
} from '@better-compute/vps';

// Agent memory (PLAN.md §3.8): persistent volumes sandboxes attach across runs. A volume books its disk on
// one host when created (quota, node_resources), sandboxes whose template names it run there, attach it
// by serial, and format it once; one read-write attachment at a time. Deleting it takes it out of the
// host's spec and releases its disk once the host applied that spec. Metered as GiB-hours.

const T0 = Date.UTC(2026, 8, 25, 12);
let db: SqlExecutor;
let clock: ManualClock;
const events: string[] = [];
const invalidated: string[] = [];
const decisions: { action: string; resource: string }[] = [];
const denied = new Set<string>();
const authzOps: { op: string; resource: string; attributes?: Record<string, unknown> | null }[] = [];

const alice: Caller = { identityId: 'usr_alice', identityKind: 'user', tenantId: 'acme', sessionId: 's', sessionKind: 'user', mfa: false };
const root: Caller = { ...alice, identityId: 'usr_root', tenantId: 'root' };
const images = {
  async resolve(_tx: SqlTx, _tenantId: string, imageId: string) {
    return imageId === 'ubuntu-24.04'
      ? { url: 'https://images.example/ubuntu-24.04.qcow2', sha256: 'ab'.repeat(32), format: 'qcow2' as const, verified: true }
      : undefined;
  },
};

function moduleContext(sql: SqlExecutor): ModuleContext {
  return {
    sql,
    clock,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { resolve: async (ref: string) => `resolved:${ref}` },
    capacity: createCapacityPort({ clock }, { random: () => 0, topN: 1 }),
    authz: {
      async upsert(_tx: SqlTx, row: { type: string; id: string; attributes?: Record<string, unknown> }) {
        authzOps.push({ op: 'upsert', resource: `${row.type}/${row.id}`, attributes: row.attributes ?? {} });
      },
      async remove(_tx: SqlTx, ref: { type: string; id: string }) {
        authzOps.push({ op: 'remove', resource: `${ref.type}/${ref.id}` });
      },
      async setPending(_tx: SqlTx, ref: { type: string; id: string }, pending: Record<string, unknown> | null) {
        authzOps.push({ op: 'pending', resource: `${ref.type}/${ref.id}`, attributes: pending });
      },
    },
    events: {
      async publish(_tx, event) {
        events.push(event.type);
      },
    },
    work: { async enqueue() {} },
    desired: {
      async invalidate(_tx, nodeId) {
        invalidated.push(nodeId);
      },
    },
    iam: {
      rootTenantId: 'root',
      // Records every decision; refuses the resources a test denies.
      async require(_credential: unknown, request: { action: string; resource: { type: string; id: string } }) {
        decisions.push({ action: request.action, resource: `${request.resource.type}/${request.resource.id}` });
        if (denied.has(request.resource.id)) throw new ComputeError('ACCESS_DENIED', `denied ${request.action} on ${request.resource.id}`);
      },
      async billingCheck() {
        return { allowed: true };
      },
    },
    commands: {
      async enqueue() {
        return { id: newId('cmd'), seq: 1 };
      },
      async cancel() {},
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

const module = vps({ runtimes: ['cloud-hypervisor'], images });
const api = module.api!(moduleContext(db)) as VpsApi;
const capacityApi = capacityModule({ random: () => 0, topN: 1 }).api!(moduleContext(db)) as Record<string, Record<string, unknown>>;

type Definition = {
  validate(raw: unknown): unknown;
  handler(context: MethodContext, input: unknown): Promise<unknown>;
  admission?: {
    prepare(context: MethodContext, input: unknown, tx: SqlTx): Promise<{ status: string; result?: unknown; resource?: { type: string; id: string } }>;
    check?(context: MethodContext, input: unknown): Promise<void>;
    denied?(context: MethodContext, input: unknown, tx: SqlTx, error: unknown): Promise<void>;
    abandoned?(context: MethodContext, input: unknown, tx: SqlTx, error: unknown): Promise<void>;
  };
};
/** As the envelope runs a method: prepare, the decision on its resource (denied → `denied`), the check, the handler (a throw → `abandoned`). */
async function run(definition: Definition, raw: unknown, who: Caller): Promise<any> {
  const input = definition.validate(raw);
  const context = (tx: SqlTx) => ({ ...moduleContext(within(tx)), caller: who, requestId: 'req' }) as MethodContext;
  const admission = definition.admission;
  if (admission) {
    const plan = await db.transaction((tx) => admission.prepare(context(tx), input, tx));
    if (plan.status === 'replay') return plan.result;
    if (plan.resource && denied.has(plan.resource.id)) {
      const error = new ComputeError('ACCESS_DENIED', `denied on ${plan.resource.type}/${plan.resource.id}`);
      await db.transaction((tx) => admission.denied?.(context(tx), input, tx, error) ?? Promise.resolve());
      throw error;
    }
    await admission.check?.({ ...moduleContext(db), caller: who, credential: { kind: 'session', token: 't' }, requestId: 'req' } as never, input);
  }
  try {
    return await db.transaction((tx) => definition.handler(context(tx), input));
  } catch (error) {
    if (admission?.abandoned) await db.transaction((tx) => admission.abandoned!(context(tx), input, tx, error));
    throw error;
  }
}
const call = (group: keyof VpsApi, method: string, raw: unknown, who: Caller = alice) =>
  run((api[group] as Record<string, Definition>)[method]!, raw, who);
const callCapacity = (group: string, method: string, raw: unknown) => run(capacityApi[group]![method] as Definition, raw, root);

async function reconcile(name: string, key: string): Promise<void> {
  await module.reconcilers!.find((entry) => entry.name === name)!.run({ ...moduleContext(db), signal: new AbortController().signal }, key);
}
/** Every host reports its instances in `state` (absent: none), then they reconcile. */
async function hostsReport(state: 'running' | 'absent'): Promise<void> {
  const { rows } = await db.query<{ id: string; node_id: string }>(
    `SELECT id, node_id FROM instances WHERE node_id IS NOT NULL AND state <> 'deleted' AND NOT draft`,
  );
  for (const node of new Set(rows.map((row) => row.node_id)))
    await db.transaction((tx) =>
      reportInstances(tx, moduleContext(db).work, node, state === 'absent' ? [] : rows.filter((r) => r.node_id === node).map((r) => ({ id: r.id, state })), {
        complete: true,
      }),
    );
  for (const row of rows) await reconcile(instanceWork, row.id);
}

const nodes = ['node_01jz00000000000000000000va', 'node_01jz00000000000000000000vb'];
const GiB = 2n ** 30n;
const storageHandler = volumeStorageStatusHandler();
/** A host's StatusReport.volume_storage, through the vps status handler. */
const storage = (node: string, s: { availableGiB: number; reservedGiB?: number; committedGiB?: number; outstandingGiB?: number }) =>
  db.transaction((tx) =>
    storageHandler(tx, { nodeId: node }, {
      volumeStorage: {
        totalBytes: 2000n * GiB,
        availableBytes: BigInt(s.availableGiB) * GiB,
        reservedBytes: BigInt(s.reservedGiB ?? 20) * GiB,
        committedBytes: BigInt(s.committedGiB ?? 0) * GiB,
        outstandingBytes: BigInt(s.outstandingGiB ?? 0) * GiB,
      },
    } as never),
  );
let pool: string;

beforeAll(async () => {
  db = pglite();
  await db.migrate([...capacityMigrations, ...vpsMigrations]);
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  for (const table of [
    'host_volume_storage',
    'volume_attachments',
    'sandbox_volumes',
    'sandboxes',
    'sandbox_templates',
    'usage_windows',
    'ip_leases',
    'ip_pools',
    'instances',
    'flavors',
    'pool_capacity_rollup',
    'device_bookings',
    'allocations',
    'node_resources',
    'node_labels',
    'quota_usage',
    'nodes',
    'pool_offers',
    'pools',
    'sites',
  ])
    await db.query(`DELETE FROM ${table}`);
  events.length = 0;
  invalidated.length = 0;
  decisions.length = 0;
  denied.clear();
  authzOps.length = 0;
  clock = manualClock(T0);
  await useSimClock(db, T0);
  await db.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_01jz00000000000000000000aa', 'root', 'shared', 'eu', 1)`);
  pool = ((await callCapacity('pools', 'create', { tenantId: 'root', siteId: 'site_01jz00000000000000000000aa', class: 'vps-host' })) as { id: string }).id;
  await callCapacity('pools', 'offer', { tenantId: 'root', poolId: pool, toTenantId: 'acme', quota: { vcpu: 32, memoryGiB: 64, diskGiB: 1000 } });
  for (const node of nodes) {
    await db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
                          connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, 'site_01jz00000000000000000000aa', $2, 'root', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
      [node, pool],
    );
    // What a current bcd advertises in Hello (sandbox guests land only where ssh-from-host is enforced).
    for (const label of ['bc.dev/cap.instance.ssh-host-only', 'bc.dev/cap.instance.network-policy', 'bc.dev/cap.instance.placement', 'bc.dev/cap.instance.volumes', 'bc.dev/driver.libvirt-kvm', 'bc.dev/driver.cloud-hypervisor'])
      await db.query(`INSERT INTO node_labels (node_id, key, value, source) VALUES ($1, $2, '1', 'system')`, [node, label]);
    for (const [resource, allocatable] of [['vcpu', 16], ['memoryGiB', 64], ['diskGiB', 1000]] as const)
      await db.query(`INSERT INTO node_resources (node_id, resource, allocatable, ratio, allocated) VALUES ($1, $2, $3, 1, 0)`, [node, resource, allocatable]);
    // Each host's bcd reports its volume store: 1000 GiB free, 20 GiB kept for itself, no volumes yet.
    await storage(node, { availableGiB: 1000, reservedGiB: 20 });
  }
  await setIpPool(db, { poolId: pool, cidr: '10.0.0.0/28', gateway: '10.0.0.1' });
  await call('flavors', 'create', { tenantId: 'root', poolId: pool, name: 's1.small', vcpu: 2, memoryGiB: 4, diskGiB: 20 }, root);
});

const createVolume = (extra: Record<string, unknown> = {}) =>
  call('sandboxVolumes', 'create', { tenantId: 'acme', poolId: pool, name: 'agent-memory', sizeGiB: 50, idempotencyKey: 'vol-1', ...extra });
const createTemplate = (extra: Record<string, unknown> = {}) =>
  call('sandboxTemplates', 'create', { tenantId: 'acme', name: 'agent', poolId: pool, flavor: 's1.small', imageId: 'ubuntu-24.04', ...extra });
const createSandbox = (templateId: string, key: string) => call('sandboxes', 'create', { tenantId: 'acme', templateId, idempotencyKey: key });
const disk = async (node: string) =>
  Number((await db.query<{ allocated: number }>(`SELECT allocated FROM node_resources WHERE node_id = $1 AND resource = 'diskGiB'`, [node])).rows[0]!.allocated);
const quotaUsed = async () => Object.fromEntries((await readQuotas(db, 'acme', pool)).map((row) => [row.resource, Number(row.used)]));

describe('sandboxVolumes surface', () => {
  it('matches the catalog rows and declares the migration and reconciler', () => {
    for (const [method, definition] of Object.entries(api.sandboxVolumes as Record<string, { action: string; kind: string }>))
      expect(apiMethod('sandboxVolumes', method), method).toMatchObject({ module: 'vps', action: definition.action, kind: definition.kind });
    expect(module.migrations!.map((migration) => migration.name)).toContain('vps/0020_volumes');
    expect(module.reconcilers!.map((reconciler) => reconciler.name)).toContain(volumeWork);
  });
});

describe('sandbox volumes', () => {
  it('book their disk on one host when created, charged to the diskGiB quota, and replay by key', async () => {
    const volume = await createVolume();
    expect(volume).toMatchObject({ name: 'agent-memory', sizeGiB: 50, state: 'ready', poolId: pool });
    expect(volume.id).toMatch(/^vol_/);
    expect(volume.serial).toBe(volumeSerial(volume.id));
    expect(volume.serial).toMatch(/^bcv-[0-9a-z]{16}$/);
    expect(nodes).toContain(volume.nodeId);
    expect(await disk(volume.nodeId)).toBe(50);
    expect((await quotaUsed()).diskGiB).toBe(50);
    expect(invalidated).toContain(volume.nodeId);
    expect(await hostVolumeSpecs(db, volume.nodeId)).toEqual([{ id: volume.id, sizeBytes: 50 * 2 ** 30, serial: volume.serial }]);
    // The same key replays; another request under it, or the same name, conflicts.
    expect(await createVolume()).toMatchObject({ id: volume.id });
    await expect(createVolume({ sizeGiB: 60 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(createVolume({ idempotencyKey: 'vol-2' })).rejects.toMatchObject({ code: 'CONFLICT' });
    // More than the quota's diskGiB: refused, nothing booked.
    await expect(createVolume({ name: 'huge', sizeGiB: 999, idempotencyKey: 'vol-3' })).rejects.toBeInstanceOf(ComputeError);
    expect((await quotaUsed()).diskGiB).toBe(50);
    expect(await call('sandboxVolumes', 'list', { tenantId: 'acme' })).toMatchObject({ items: [{ id: volume.id }] });
  });

  it('pin their sandboxes to their host, attach by serial, and format once', async () => {
    const volume = await createVolume();
    // A warm pool beside volumes is refused, and so is a mount over the system.
    await expect(createTemplate({ warm: { min: 1 }, volumes: [{ name: 'agent-memory', mountPath: '/workspace' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(createTemplate({ volumes: [{ name: 'agent-memory', mountPath: '/etc' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(createTemplate({ volumes: [{ name: 'nope', mountPath: '/workspace' }] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const template = await createTemplate({ volumes: [{ name: 'agent-memory', mountPath: '/workspace' }] });
    expect(template.volumes).toEqual([{ volumeId: volume.id, mountPath: '/workspace', readOnly: false }]);

    const sandbox = await createSandbox(template.id, 'sbx-1');
    const { rows } = await db.query<{ node_id: string; user_data: string }>(`SELECT node_id, user_data FROM instances WHERE id = $1`, [sandbox.instanceId]);
    expect(rows[0]!.node_id).toBe(volume.nodeId);
    expect(rows[0]!.user_data).toContain(`/dev/disk/by-id/virtio-${volume.serial}`);
    expect(rows[0]!.user_data).toContain('overwrite: false');
    expect(rows[0]!.user_data).toContain('"/workspace"');
    const [spec] = await instanceSpecs(db, volume.nodeId);
    expect(spec!.volumes).toEqual([{ volumeId: volume.id }]);

    // One read-write attachment at a time: a second sandbox of the template is refused.
    await expect(createSandbox(template.id, 'sbx-2')).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'volume-in-use' } });
    // Read-only ones share it, but never beside a writer.
    const reader = await createTemplate({ name: 'reader', volumes: [{ volumeId: volume.id, mountPath: '/data', readOnly: true }] });
    await expect(createSandbox(reader.id, 'sbx-3')).rejects.toMatchObject({ code: 'CONFLICT' });

    // Busy: the volume cannot be deleted while attached, nor while a template names it.
    await expect(call('sandboxVolumes', 'delete', { tenantId: 'acme', volumeId: volume.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    await call('sandboxes', 'delete', { tenantId: 'acme', sandboxId: sandbox.id });
    await reconcile(instanceWork, sandbox.instanceId);
    await hostsReport('absent');
    const readers = [await createSandbox(reader.id, 'sbx-4'), await createSandbox(reader.id, 'sbx-5')];
    const readerSpecs = await instanceSpecs(db, volume.nodeId);
    for (const readerSandbox of readers) expect(readerSpecs.find((s) => s.id === readerSandbox.instanceId)!.volumes).toEqual([{ volumeId: volume.id, readOnly: true }]);
  });

  it('are mounted by a template only with a decision on each volume (review 2, MED 1)', async () => {
    const bob: Caller = { ...alice, identityId: 'usr_bob' };
    const volume = await createVolume();
    // Bob may manage templates, but not alice's volume: he cannot mount it, read-write or read-only.
    denied.add(volume.id);
    const asBob = (extra: Record<string, unknown>) =>
      call('sandboxTemplates', 'create', { tenantId: 'acme', name: 'bobs', poolId: pool, flavor: 's1.small', imageId: 'ubuntu-24.04', ...extra }, bob);
    await expect(asBob({ volumes: [{ name: 'agent-memory', mountPath: '/workspace' }] })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await expect(asBob({ volumes: [{ volumeId: volume.id, mountPath: '/data', readOnly: true }] })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(decisions.filter((d) => d.resource === `compute-sandbox-volume/${volume.id}`).map((d) => d.action)).toEqual([
      'compute:sandboxes:manage',
      'compute:sandboxes:read',
    ]);
    denied.clear();
    const template = await createTemplate({ volumes: [{ volumeId: volume.id, mountPath: '/data', readOnly: true }] });
    // An update that hands the volumes to new code (another image, user data) is decided on them again.
    decisions.length = 0;
    await call('sandboxTemplates', 'update', { tenantId: 'acme', templateId: template.id, userData: '#cloud-config\n' });
    expect(decisions).toContainEqual({ action: 'compute:sandboxes:read', resource: `compute-sandbox-volume/${volume.id}` });
    denied.add(volume.id);
    await expect(call('sandboxTemplates', 'update', { tenantId: 'acme', templateId: template.id, userData: '#cloud-config\n# v2\n' })).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    // A TTL change hands nothing new: no volume decision.
    decisions.length = 0;
    await call('sandboxTemplates', 'update', { tenantId: 'acme', templateId: template.id, maxTtlSeconds: 7200 });
    expect(decisions.some((d) => d.resource.startsWith('compute-sandbox-volume/'))).toBe(false);
    denied.clear();
    // What the handler resolves under its lock must be what was decided: a name re-pointed, or a mount made
    // writable, since the check is refused (CONFLICT, retried and decided again).
    const definition = (api.sandboxTemplates as unknown as Record<string, Definition>).update!;
    const widened = definition.validate({ tenantId: 'acme', templateId: template.id, volumes: [{ volumeId: volume.id, mountPath: '/data' }] }) as Record<string, unknown>;
    widened.decidedVolumes = [{ volumeId: volume.id, write: false }];
    await expect(
      db.transaction((tx) => definition.handler({ ...moduleContext(within(tx)), caller: alice, requestId: 'req' } as MethodContext, widened)),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'volumes-changed' } });
  });

  it('are decided with their size: on create, and with the new size pending on resize (review 2, LOW 3)', async () => {
    authzOps.length = 0;
    const volume = await createVolume();
    const resource = `sandbox-volume/${volume.id}`;
    // Create: the decision is on the volume, whose projection row already carries the size (prepare), and
    // the handler writes it again once the volume exists.
    expect(authzOps.filter((op) => op.resource === resource)).toEqual([
      { op: 'upsert', resource, attributes: { sizeGiB: 50 } },
      { op: 'upsert', resource, attributes: { sizeGiB: 50 } },
    ]);
    // Refused: nothing is created, and the staged row goes.
    authzOps.length = 0;
    const refusedId = await draftId('vol', 'acme', alice.identityId, 'vol-denied');
    denied.add(refusedId);
    await expect(createVolume({ name: 'refused', idempotencyKey: 'vol-denied' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(authzOps.map((op) => `${op.op} ${op.resource}`)).toEqual([`upsert sandbox-volume/${refusedId}`, `remove sandbox-volume/${refusedId}`]);
    expect((await db.query('SELECT 1 FROM sandbox_volumes WHERE id = $1', [refusedId])).rowCount).toBe(0);
    // Resize: decided with the new size pending, then the row says it.
    authzOps.length = 0;
    await call('sandboxVolumes', 'resize', { tenantId: 'acme', volumeId: volume.id, sizeGiB: 80 });
    expect(authzOps).toEqual([
      { op: 'pending', resource, attributes: { sizeGiB: 80 } },
      { op: 'pending', resource, attributes: null },
      { op: 'upsert', resource, attributes: { sizeGiB: 80 } },
    ]);
    // A refused resize clears its pending size, and so does one whose handler failed (no room on the host).
    authzOps.length = 0;
    denied.add(volume.id);
    await expect(call('sandboxVolumes', 'resize', { tenantId: 'acme', volumeId: volume.id, sizeGiB: 90 })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    denied.clear();
    await expect(call('sandboxVolumes', 'resize', { tenantId: 'acme', volumeId: volume.id, sizeGiB: 5000 })).rejects.toMatchObject({ code: 'CAPACITY_UNAVAILABLE' });
    expect(authzOps.filter((op) => op.op === 'pending').map((op) => op.attributes)).toEqual([{ sizeGiB: 90 }, null, { sizeGiB: 5000 }, null]);
    const { rows } = await db.query<{ resizing_request: string | null }>('SELECT resizing_request FROM sandbox_volumes WHERE id = $1', [volume.id]);
    expect(rows[0]!.resizing_request).toBeNull();
    // One resize at a time holds the pending size.
    const definition = (api.sandboxVolumes as unknown as Record<string, Definition>).resize!;
    const prepare = (sizeGiB: number) =>
      db.transaction((tx) =>
        definition.admission!.prepare({ ...moduleContext(within(tx)), caller: alice, requestId: 'req' } as MethodContext, definition.validate({ tenantId: 'acme', volumeId: volume.id, sizeGiB }), tx),
      );
    await prepare(100);
    await expect(prepare(120)).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'resize-in-flight' } });
  });

  it("book against what the host's volume store can really hold, never overcommitted (review 2, MED 2)", async () => {
    const [a, b] = nodes as [string, string];
    // Host a's store is nearly full of other volumes' unwritten space; host b has no report (an older bcd).
    await storage(a, { availableGiB: 100, reservedGiB: 20, outstandingGiB: 50 });
    await db.query('DELETE FROM host_volume_storage WHERE node_id = $1', [b]);
    expect((await volumeHeadroomGiB(db as never, [a, b])).get(a)).toBe(30);
    await expect(createVolume({ sizeGiB: 40 })).rejects.toMatchObject({ code: 'CAPACITY_UNAVAILABLE', details: { reason: 'volume-storage' } });
    const small = await createVolume({ sizeGiB: 25 });
    expect(small.nodeId).toBe(a);
    // Booked but not yet reported by bcd (committed 0): counts against the headroom until it is.
    expect((await volumeHeadroomGiB(db as never, [a])).get(a)).toBe(5);
    await expect(createVolume({ name: 'second', sizeGiB: 10, idempotencyKey: 'vol-2' })).rejects.toMatchObject({ code: 'CAPACITY_UNAVAILABLE' });
    await expect(call('sandboxVolumes', 'resize', { tenantId: 'acme', volumeId: small.id, sizeGiB: 40 })).rejects.toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
      details: { reason: 'volume-storage', freeGiB: 5 },
    });
    // bcd reports the volume (committed 25 GiB, all of it unwritten): the same headroom, by bcd's own rule.
    await storage(a, { availableGiB: 100, reservedGiB: 20, outstandingGiB: 75, committedGiB: 25 });
    expect((await volumeHeadroomGiB(db as never, [a])).get(a)).toBe(5);
    // More room on the host (a disk grown): the growth fits and is booked.
    await storage(a, { availableGiB: 300, reservedGiB: 20, outstandingGiB: 75, committedGiB: 25 });
    expect((await call('sandboxVolumes', 'resize', { tenantId: 'acme', volumeId: small.id, sizeGiB: 40 })).sizeGiB).toBe(40);
    // An unchanged report (within 1 GiB) writes nothing.
    expect(await storage(a, { availableGiB: 300, reservedGiB: 20, outstandingGiB: 75, committedGiB: 25 })).toBe(false);

    // Doctor: host b keeps volumes (its label) but never reported; host a's store filled up past its bookings.
    expect((await volumeStorageSelfCheck(db)).map((finding) => finding.check)).toEqual(['vps.volumes.storage-unreported']);
    await storage(a, { availableGiB: 30, reservedGiB: 20, outstandingGiB: 60, committedGiB: 40 });
    const findings = await volumeStorageSelfCheck(db);
    expect(findings.map((finding) => [finding.check, finding.severity])).toEqual([
      ['vps.volumes.storage-unreported', 'warning'],
      ['vps.volumes.storage-full', 'error'],
    ]);
    expect(findings[1]!.message).toContain(`${a} (50 GiB over)`);
    // An hour without a fresh report from a connected host.
    clock.advance(2 * 3_600_000);
    await setSimClock(db, T0 + 2 * 3_600_000);
    expect((await volumeStorageSelfCheck(db)).map((finding) => finding.check)).toContain('vps.volumes.storage-stale');
  });

  it('are listed per caller by default, the whole tenant with scope all', async () => {
    const bob: Caller = { ...alice, identityId: 'usr_bob' };
    const mine = await createVolume();
    const bobs = (await call(
      'sandboxVolumes',
      'create',
      { tenantId: 'acme', poolId: pool, name: 'bob-memory', sizeGiB: 10, idempotencyKey: 'vol-bob' },
      bob,
    )) as { id: string };
    const ids = (result: { items: { id: string }[] }) => result.items.map((volume) => volume.id).sort();
    expect(ids(await call('sandboxVolumes', 'list', { tenantId: 'acme' }))).toEqual([mine.id]);
    expect(ids(await call('sandboxVolumes', 'list', { tenantId: 'acme' }, bob))).toEqual([bobs.id]);
    expect(ids(await call('sandboxVolumes', 'list', { tenantId: 'acme', scope: 'all' }))).toEqual([mine.id, bobs.id].sort());
  });

  it('are deleted once their host applied a spec without them, and release their disk', async () => {
    const volume = await createVolume();
    const template = await createTemplate({ volumes: [{ volumeId: volume.id, mountPath: '/workspace' }] });
    await expect(call('sandboxVolumes', 'delete', { tenantId: 'acme', volumeId: volume.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    await call('sandboxTemplates', 'update', { tenantId: 'acme', templateId: template.id, volumes: [] });
    const deleting = await call('sandboxVolumes', 'delete', { tenantId: 'acme', volumeId: volume.id });
    expect(deleting).toMatchObject({ state: 'deleting' });
    expect(await hostVolumeSpecs(db, volume.nodeId)).toEqual([]);
    // The host has not applied the new spec yet: the disk stays booked.
    await db.transaction((tx) => finishVolumeDeletions(moduleContext(db) as never, tx));
    expect(await disk(volume.nodeId)).toBe(50);
    // A later spec generation, observed.
    await db.query(`UPDATE nodes SET generation = generation + 1, observed_generation = generation + 1 WHERE id = $1`, [volume.nodeId]);
    await reconcile(volumeWork, volume.id);
    expect(await call('sandboxVolumes', 'get', { tenantId: 'acme', volumeId: volume.id })).toMatchObject({ state: 'deleted' });
    expect(await disk(volume.nodeId)).toBe(0);
    expect((await quotaUsed()).diskGiB).toBe(0);
    expect(events).toEqual(expect.arrayContaining(['sandbox.volume.created', 'sandbox.volume.deleting', 'sandbox.volume.deleted']));
    // The name is free again.
    await createVolume({ idempotencyKey: 'vol-again' });
  });

  it('keep their sandboxes on their host when another host scores better', async () => {
    const volume = await createVolume();
    // A third, empty host, and the volume's host made the busiest: a spreading scorer prefers the others.
    const third = 'node_01jz00000000000000000000vc';
    await db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
                          connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, 'site_01jz00000000000000000000aa', $2, 'root', 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
      [third, pool],
    );
    for (const label of ['bc.dev/cap.instance.ssh-host-only', 'bc.dev/cap.instance.volumes', 'bc.dev/driver.libvirt-kvm', 'bc.dev/driver.cloud-hypervisor'])
      await db.query(`INSERT INTO node_labels (node_id, key, value, source) VALUES ($1, $2, '1', 'system')`, [third, label]);
    for (const [resource, allocatable] of [['vcpu', 64], ['memoryGiB', 256], ['diskGiB', 4000]] as const)
      await db.query(`INSERT INTO node_resources (node_id, resource, allocatable, ratio, allocated) VALUES ($1, $2, $3, 1, 0)`, [third, resource, allocatable]);
    await db.query(`UPDATE node_resources SET allocated = 12 WHERE node_id = $1 AND resource = 'vcpu'`, [volume.nodeId]);
    const template = await createTemplate({ volumes: [{ volumeId: volume.id, mountPath: '/workspace' }] });
    const sandbox = await createSandbox(template.id, 'sbx-pinned');
    const { rows } = await db.query<{ node_id: string }>(`SELECT node_id FROM instances WHERE id = $1`, [sandbox.instanceId]);
    expect(rows[0]!.node_id).toBe(volume.nodeId);
    // A host without the volumes capability never takes it (an older bcd drops volumes).
    await db.query(`DELETE FROM node_labels WHERE node_id = $1 AND key = 'bc.dev/cap.instance.volumes'`, [volume.nodeId]);
    await call('sandboxes', 'delete', { tenantId: 'acme', sandboxId: sandbox.id });
    await reconcile(instanceWork, sandbox.instanceId);
    await hostsReport('absent');
    const again = await createSandbox(template.id, 'sbx-again');
    const placed = await db.query<{ node_id: string | null; state: string }>(`SELECT node_id, state FROM instances WHERE id = $1`, [again.instanceId]);
    expect(placed.rows[0]).toMatchObject({ node_id: null, state: 'scheduling' });
  });

  it('grow in place, charged to quota and booked on their host, and never shrink', async () => {
    const volume = await createVolume();
    expect(await call('sandboxVolumes', 'resize', { tenantId: 'acme', volumeId: volume.id, sizeGiB: 80 })).toMatchObject({ sizeGiB: 80 });
    expect(await disk(volume.nodeId)).toBe(80);
    expect((await quotaUsed()).diskGiB).toBe(80);
    expect(await hostVolumeSpecs(db, volume.nodeId)).toEqual([{ id: volume.id, sizeBytes: 80 * 2 ** 30, serial: volume.serial }]);
    await expect(call('sandboxVolumes', 'resize', { tenantId: 'acme', volumeId: volume.id, sizeGiB: 40 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // No room on its host: nothing changes, the quota charge comes back.
    await db.query(`UPDATE node_resources SET allocatable = 100 WHERE node_id = $1 AND resource = 'diskGiB'`, [volume.nodeId]);
    await expect(call('sandboxVolumes', 'resize', { tenantId: 'acme', volumeId: volume.id, sizeGiB: 200 })).rejects.toMatchObject({ code: 'CAPACITY_UNAVAILABLE' });
    expect((await quotaUsed()).diskGiB).toBe(80);
    expect(await call('sandboxVolumes', 'get', { tenantId: 'acme', volumeId: volume.id })).toMatchObject({ sizeGiB: 80 });
    // The next sandbox's guest grows the filesystem to the disk.
    const template = await createTemplate({ volumes: [{ volumeId: volume.id, mountPath: '/workspace' }] });
    const sandbox = await createSandbox(template.id, 'sbx-grown');
    const { rows } = await db.query<{ user_data: string }>(`SELECT user_data FROM instances WHERE id = $1`, [sandbox.instanceId]);
    expect(rows[0]!.user_data).toContain(`resize2fs /dev/disk/by-id/virtio-${volume.serial}`);
  });

  it('meter GiB-hours from creation until they are gone', async () => {
    const volume = await createVolume({ sizeGiB: 10 });
    clock.advance(2 * 3600_000);
    await setSimClock(db, clock.now());
    await db.transaction((tx) => meterVolumes(tx, clock.now()));
    const { rows } = await db.query<{ meter: string; quantity: number }>(
      `SELECT meter, sum(quantity)::float8 AS quantity FROM usage_windows WHERE allocation_id = (SELECT allocation_id FROM sandbox_volumes WHERE id = $1) GROUP BY meter`,
      [volume.id],
    );
    expect(rows).toEqual([{ meter: volumeMeter, quantity: 20 }]);
  });
});
