import {
  ComputeError,
  defineMethod,
  defineModule,
  isId,
  newId,
  notImplemented,
  reservationStates,
  type CapacityPort,
  type ComputeModule,
  type Json,
  type MethodContext,
  type MethodDefinition,
  type ModuleContext,
  type Phase,
  type Pool,
  type PoolAgent,
  type PoolClass,
  type PoolPolicy,
  type Reconciler,
  type Reservation,
  type ReservationState,
  type SharingMode,
  type SqlTx,
} from '@better-compute/core';
import { readAllocation, releaseAllocation } from './bookings.js';
import { capacityMigrations } from './migrations.js';
import { planPlacement, summarizeRejections } from './pipeline.js';
import { inlinePlacer } from './placer.js';
import {
  chargeQuota,
  quotaDemand,
  readQuotas,
  refundQuota,
  setQuota,
  type QuotaRow,
} from './quota.js';
import {
  cancelReservation,
  completeCreate,
  completeExtend,
  denyCreate,
  denyPending,
  deviceAssignments,
  listReservations,
  parseCreateReservation,
  parseExtendReservation,
  prepareCreate,
  prepareExtend,
  readReservation,
  reconcileReservation,
  releaseReservation,
  renewReservation,
  reservationView,
  reservationWork,
  type CreateReservationInput,
  type ExtendReservationInput,
  type ExtendResult,
  type PlacementOptions,
  type ReservationDeps,
} from './reservations.js';
import {
  readPoolCapacity,
  readPoolsCapacity,
  rebuildPoolRollup,
  type PoolCapacity,
} from './rollup.js';
import { loadNodeViews, readPool } from './store.js';

// capacityModule (PLAN.md §4.2): the always-on built-in module behind the pools, capacity,
// reservations and quotas groups of §9.2, the reservation lifecycle reconciler, the `devices`
// section of node specs, and the CapacityPort other modules book through.

const tenantPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const poolClasses: readonly PoolClass[] = ['metal-host', 'metal-dedicated', 'vps-host', 'provider'];
const sharingModes: readonly SharingMode[] = ['exclusive', 'mig', 'timeslice', 'mps'];

function fail(message: string): never {
  throw new ComputeError('INVALID_INPUT', message);
}
function object(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    fail('The request must be an object');
  for (const key of Object.keys(raw))
    if (!allowed.includes(key)) fail(`Unknown field ${JSON.stringify(key)}`);
  return raw as Record<string, unknown>;
}
function tenant(value: unknown, name = 'tenantId'): string {
  if (typeof value !== 'string' || !tenantPattern.test(value)) fail(`${name} is invalid`);
  return value;
}
function id(value: unknown, prefix: string, name: string): string {
  if (!isId(value, prefix)) fail(`${name} must be a ${prefix}_ id`);
  return value;
}
function quotaMap(value: unknown, name: string): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(`${name} must map resources to limits`);
  const result: Record<string, number> = {};
  for (const [resource, limit] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(resource)) fail(`${name}: bad resource ${resource}`);
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0)
      fail(`${name}.${resource} must be a non-negative integer`);
    result[resource] = limit;
  }
  return result;
}
function optionalInt(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    fail(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

// --- Pools ------------------------------------------------------------------------------------

interface RawPoolRow {
  id: string;
  owner_tenant_id: string;
  site_id: string;
  class: PoolClass;
  gpu_model: string | null;
  sharing: SharingMode;
  agent: PoolAgent;
  policy: PoolPolicy | string;
  provider_account_id?: string | null;
  version: string | number;
}

function toPool(row: RawPoolRow): Pool {
  const pool: Pool = {
    id: row.id,
    ownerTenantId: row.owner_tenant_id,
    siteId: row.site_id,
    class: row.class,
    sharing: row.sharing,
    agent: row.agent,
    policy: typeof row.policy === 'string' ? (JSON.parse(row.policy) as PoolPolicy) : row.policy,
    version: Number(row.version),
  };
  if (row.gpu_model !== null) pool.gpuModel = row.gpu_model;
  if (row.provider_account_id) pool.providerAccountId = row.provider_account_id;
  return pool;
}

const visibleWhere = `(p.owner_tenant_id = $1
  OR EXISTS (SELECT 1 FROM pool_offers o WHERE o.pool_id = p.id AND o.tenant_id = $1))`;

/** A pool as one tenant sees it: the pool, whether it owns it, and its own quota rows. */
export interface TenantPool extends Pool {
  owned: boolean;
  quotas: QuotaRow[];
}

async function tenantPools(tx: SqlTx, tenantId: string, poolId?: string): Promise<TenantPool[]> {
  const { rows } = await tx.query<RawPoolRow>(
    `SELECT p.id, p.owner_tenant_id, p.site_id, p.class, p.gpu_model, p.sharing, p.agent, p.policy,
            p.provider_account_id, p.version
       FROM pools p WHERE ${visibleWhere} AND ($2::text IS NULL OR p.id = $2) ORDER BY p.id`,
    [tenantId, poolId ?? null],
  );
  const quotas = await readQuotas(tx, tenantId, poolId);
  return rows.map((row) => ({
    ...toPool(row),
    owned: row.owner_tenant_id === tenantId,
    quotas: quotas.filter((quota) => quota.poolId === row.id),
  }));
}

async function ownedPool(tx: SqlTx, tenantId: string, poolId: string, lock = false): Promise<Pool> {
  const { rows } = await tx.query<RawPoolRow>(
    `SELECT id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version
       FROM pools WHERE id = $1 AND owner_tenant_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [poolId, tenantId],
  );
  if (!rows[0]) throw new ComputeError('NOT_FOUND', `Pool ${poolId} not found`);
  return toPool(rows[0]);
}

async function poolAuthzRow(tx: SqlTx, pool: Pool, tenantId: string) {
  const { rows } = await tx.query<{ region: string }>(`SELECT region FROM sites WHERE id = $1`, [
    pool.siteId,
  ]);
  return {
    type: 'pool',
    id: pool.id,
    tenantId,
    attributes: {
      gpuModel: pool.gpuModel ?? 'other',
      class: pool.class,
      sharing: pool.sharing,
      region: rows[0]?.region ?? '',
      owned: pool.ownerTenantId === tenantId,
    },
    parentType: 'site',
    parentId: pool.siteId,
  };
}

/** Default owner quota on pool creation: effectively unlimited GPUs for the pool's owner. */
export const ownerQuotaDefault: Readonly<Record<string, number>> = Object.freeze({
  gpu: 2_147_483_647,
});

export interface CreatePoolInput {
  tenantId: string;
  siteId: string;
  class: PoolClass;
  gpuModel?: string;
  sharing: SharingMode;
  agent: PoolAgent;
  policy: PoolPolicy;
  ownerQuota: Record<string, number>;
  /** `class: 'provider'` pools: the provider account (vps) that backs them; `agent` is then `none`. */
  providerAccountId?: string;
}

export function parseCreatePool(raw: unknown): CreatePoolInput {
  const input = object(raw, [
    'tenantId',
    'siteId',
    'class',
    'gpuModel',
    'sharing',
    'agent',
    'policy',
    'ownerQuota',
    'providerAccountId',
  ]);
  if (input.class === 'provider') {
    if (input.providerAccountId === undefined) fail('A provider pool needs providerAccountId');
    if (input.agent !== undefined && input.agent !== 'none')
      fail("A provider pool's machines are reached through the provider: agent must be none");
  } else if (input.providerAccountId !== undefined)
    fail('Only provider pools take providerAccountId');
  if (!poolClasses.includes(input.class as PoolClass))
    fail(`class must be one of ${poolClasses.join(', ')}`);
  const sharing = (input.sharing ?? 'exclusive') as SharingMode;
  if (!sharingModes.includes(sharing)) fail(`sharing must be one of ${sharingModes.join(', ')}`);
  if (sharing !== 'exclusive')
    throw new ComputeError('UNSUPPORTED', 'Shared GPU pools (mig, timeslice, mps) arrive in v0.5');
  const agent = (input.agent ?? (input.class === 'provider' ? 'none' : 'bcd')) as PoolAgent;
  if (agent !== 'bcd' && agent !== 'none') fail('agent must be bcd or none');
  if (
    input.gpuModel !== undefined &&
    (typeof input.gpuModel !== 'string' || !/^[A-Za-z0-9-]{1,32}$/.test(input.gpuModel))
  )
    fail('gpuModel is invalid');
  if (
    input.policy !== undefined &&
    (typeof input.policy !== 'object' || input.policy === null || Array.isArray(input.policy))
  )
    fail('policy must be an object');
  const result: CreatePoolInput = {
    tenantId: tenant(input.tenantId),
    siteId: id(input.siteId, 'site', 'siteId'),
    class: input.class as PoolClass,
    sharing,
    agent,
    policy: (input.policy ?? {}) as PoolPolicy,
    ownerQuota:
      input.ownerQuota === undefined
        ? { ...ownerQuotaDefault }
        : quotaMap(input.ownerQuota, 'ownerQuota'),
  };
  if (input.gpuModel !== undefined) result.gpuModel = input.gpuModel as string;
  if (input.providerAccountId !== undefined)
    result.providerAccountId = id(input.providerAccountId, 'pacct', 'providerAccountId');
  return result;
}

export interface OfferPoolInput {
  tenantId: string;
  poolId: string;
  toTenantId: string;
  quota: Record<string, number>;
  includeDescendants: boolean;
  priority?: number;
}

export function parseOfferPool(raw: unknown): OfferPoolInput {
  const input = object(raw, [
    'tenantId',
    'poolId',
    'toTenantId',
    'quota',
    'includeDescendants',
    'priority',
  ]);
  if (input.includeDescendants !== undefined && typeof input.includeDescendants !== 'boolean')
    fail('includeDescendants must be true or false');
  const result: OfferPoolInput = {
    tenantId: tenant(input.tenantId),
    poolId: id(input.poolId, 'pool', 'poolId'),
    toTenantId: tenant(input.toTenantId, 'toTenantId'),
    quota: quotaMap(input.quota, 'quota'),
    includeDescendants: input.includeDescendants === true,
  };
  const priority = optionalInt(input.priority, 'priority', -1000, 1000);
  if (priority !== undefined) result.priority = priority;
  return result;
}

/**
 * The offering validator (§10.2, §10.6): a pool holding `tenant-owned` nodes, or a single-tenant
 * sharing mode (`timeslice`, `mps`), may be offered only to its owner.
 */
export async function assertOfferable(tx: SqlTx, pool: Pool, toTenantId: string): Promise<void> {
  if (toTenantId === pool.ownerTenantId) return;
  if (pool.sharing === 'timeslice' || pool.sharing === 'mps')
    throw new ComputeError('INVALID_STATE', `${pool.sharing} pools are single-tenant`);
  const { rows } = await tx.query(
    `SELECT 1 FROM nodes WHERE pool_id = $1 AND trust = 'tenant-owned' LIMIT 1`,
    [pool.id],
  );
  if (rows.length > 0)
    throw new ComputeError(
      'INVALID_STATE',
      `Pool ${pool.id} holds tenant-owned nodes and can be offered only to its owner`,
    );
}

// --- API types ---------------------------------------------------------------------------------

type TenantInput = { tenantId: string };
type PoolInput = { tenantId: string; poolId: string };
type ReservationInput = { tenantId: string; reservationId: string };
type ListReservationsInput = {
  tenantId: string;
  state?: ReservationState;
  poolId?: string;
  limit?: number;
  cursor?: string;
};

/** What `capacity.summary` returns: the tenant's visible pools with their rollups, by GPU model. */
export interface CapacitySummary {
  pools: { poolId: string; gpuModel: string; owned: boolean; capacity: PoolCapacity[] }[];
  byGpuModel: Record<
    string,
    { total: number; allocatable: number; allocated: number; reserved: number; available: number }
  >;
}

/** What `capacity.preview` returns: whether a request would fit now, without booking anything. */
export interface CapacityPreview {
  fits: boolean;
  candidates: { nodeId: string; atoms: string[]; score: number }[];
  reason?: string;
}

export type CapacityApi = {
  pools: {
    list: MethodDefinition<TenantInput, { items: TenantPool[] }>;
    get: MethodDefinition<PoolInput, TenantPool>;
    create: MethodDefinition<CreatePoolInput, Pool>;
    capacity: MethodDefinition<PoolInput, PoolCapacity[]>;
    offer: MethodDefinition<OfferPoolInput, TenantPool>;
    unoffer: MethodDefinition<PoolInput & { toTenantId: string }, { removed: boolean }>;
    update: MethodDefinition<PoolInput, Pool>;
    archive: MethodDefinition<PoolInput, Pool>;
  };
  capacity: {
    summary: MethodDefinition<TenantInput, CapacitySummary>;
    byPool: MethodDefinition<PoolInput, PoolCapacity[]>;
    preview: MethodDefinition<CreateReservationInput, CapacityPreview>;
    timeline: MethodDefinition<PoolInput, never>;
  };
  reservations: {
    create: MethodDefinition<CreateReservationInput, Reservation>;
    get: MethodDefinition<ReservationInput, Reservation>;
    list: MethodDefinition<ListReservationsInput, { items: Reservation[]; cursor?: string }>;
    release: MethodDefinition<ReservationInput, Reservation>;
    cancel: MethodDefinition<ReservationInput, Reservation>;
    extend: MethodDefinition<ExtendReservationInput, ExtendResult>;
    renew: MethodDefinition<ReservationInput, Reservation>;
  };
  quotas: {
    get: MethodDefinition<TenantInput & { poolId?: string }, { items: QuotaRow[] }>;
    set: MethodDefinition<TenantInput, never>;
  };
};

function parseTenant(raw: unknown): TenantInput {
  const input = object(raw, ['tenantId']);
  return { tenantId: tenant(input.tenantId) };
}
function parsePool(raw: unknown): PoolInput {
  const input = object(raw, ['tenantId', 'poolId']);
  return { tenantId: tenant(input.tenantId), poolId: id(input.poolId, 'pool', 'poolId') };
}
function parseReservation(raw: unknown): ReservationInput {
  const input = object(raw, ['tenantId', 'reservationId']);
  return {
    tenantId: tenant(input.tenantId),
    reservationId: id(input.reservationId, 'rsv', 'reservationId'),
  };
}
function parseListReservations(raw: unknown): ListReservationsInput {
  const input = object(raw, ['tenantId', 'state', 'poolId', 'limit', 'cursor']);
  const result: ListReservationsInput = { tenantId: tenant(input.tenantId) };
  if (input.state !== undefined) {
    if (!reservationStates.includes(input.state as ReservationState)) fail('state is invalid');
    result.state = input.state as ReservationState;
  }
  if (input.poolId !== undefined) result.poolId = id(input.poolId, 'pool', 'poolId');
  const limit = optionalInt(input.limit, 'limit', 1, 200);
  if (limit !== undefined) result.limit = limit;
  if (input.cursor !== undefined) result.cursor = id(input.cursor, 'rsv', 'cursor');
  return result;
}

function tenantResource<I extends { tenantId: string }>(input: I) {
  return { type: 'tenant', id: input.tenantId };
}
function poolResource<I extends { poolId: string }>(input: I) {
  return { type: 'pool', id: input.poolId };
}
function reservationResource<I extends { reservationId: string }>(input: I) {
  return { type: 'reservation', id: input.reservationId };
}

function later<I>(
  name: string,
  phase: Phase,
  action: `compute:${string}`,
  kind: 'read' | 'mutation',
  resource: (input: I) => { type: string; id: string },
  validate: (raw: unknown) => I,
): MethodDefinition<I, never> {
  return defineMethod<I, never>({
    action,
    kind,
    resource,
    validate,
    handler: async () => {
      throw notImplemented(name, phase);
    },
  });
}

// --- Module ------------------------------------------------------------------------------------

export interface CapacityModuleOptions extends PlacementOptions {
  /** Placement attempts per admission (default 3). */
  maxAttempts?: number;
  /** How often the rollup job rebuilds every pool (default `5m`). */
  rollupEvery?: `${number}${'s' | 'm' | 'h'}`;
}

function depsFrom(
  context: ModuleContext,
  placer: ReservationDeps['placer'],
  options: CapacityModuleOptions,
): ReservationDeps {
  return {
    clock: context.clock,
    events: context.events,
    work: context.work,
    authz: context.authz,
    desired: context.desired,
    placer,
    placement: {
      random: options.random ?? Math.random,
      plugins: options.plugins ?? [],
      weights: options.weights ?? {},
      topN: options.topN ?? 5,
    },
  };
}

/** Transactions inside a method: the envelope's executor turns nested ones into savepoints. */
function inTx<T>(context: ModuleContext, fn: (tx: SqlTx) => Promise<T>): Promise<T> {
  return context.sql.transaction(fn);
}

function buildApi(options: CapacityModuleOptions, placer: ReservationDeps['placer']): CapacityApi {
  const deps = (context: MethodContext) => depsFrom(context, placer, options);

  const pools: CapacityApi['pools'] = {
    list: defineMethod({
      action: 'compute:pools:read',
      kind: 'read',
      resource: tenantResource,
      validate: parseTenant,
      handler: async (context, input) => ({
        items: await tenantPools(context.sql, input.tenantId),
      }),
    }),
    get: defineMethod({
      action: 'compute:pools:read',
      kind: 'read',
      resource: poolResource,
      validate: parsePool,
      handler: async (context, input) => {
        const [pool] = await tenantPools(context.sql, input.tenantId, input.poolId);
        if (!pool) throw new ComputeError('NOT_FOUND', `Pool ${input.poolId} not found`);
        return pool;
      },
    }),
    create: defineMethod({
      action: 'compute:pools:create',
      kind: 'mutation',
      resource: tenantResource,
      validate: parseCreatePool,
      handler: async (context, input) => {
        const tx = context.sql;
        const site = await tx.query<{ owner_tenant_id: string }>(
          `SELECT owner_tenant_id FROM sites WHERE id = $1`,
          [input.siteId],
        );
        if (site.rows[0]?.owner_tenant_id !== input.tenantId)
          throw new ComputeError('NOT_FOUND', `Site ${input.siteId} not found`);
        const pool: Pool = {
          id: newId('pool'),
          ownerTenantId: input.tenantId,
          siteId: input.siteId,
          class: input.class,
          sharing: input.sharing,
          agent: input.agent,
          policy: input.policy,
          version: 1,
        };
        if (input.gpuModel !== undefined) pool.gpuModel = input.gpuModel;
        if (input.providerAccountId !== undefined) pool.providerAccountId = input.providerAccountId;
        await tx.query(
          `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy,
                              provider_account_id, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 1)`,
          [
            pool.id,
            pool.ownerTenantId,
            pool.siteId,
            pool.class,
            pool.gpuModel ?? null,
            pool.sharing,
            pool.agent,
            JSON.stringify(pool.policy),
            pool.providerAccountId ?? null,
          ],
        );
        for (const [resource, max] of Object.entries(input.ownerQuota))
          await setQuota(tx, input.tenantId, pool.id, resource, max);
        await rebuildPoolRollup(tx, pool);
        await context.authz.upsert(tx, await poolAuthzRow(tx, pool, input.tenantId));
        await context.events.publish(tx, {
          type: 'pool.created',
          tenantId: input.tenantId,
          subject: `pool/${pool.id}`,
          data: { siteId: pool.siteId, class: pool.class, gpuModel: pool.gpuModel ?? null },
        });
        return pool;
      },
    }),
    capacity: defineMethod({
      action: 'compute:capacity:read',
      kind: 'read',
      resource: poolResource,
      validate: parsePool,
      handler: async (context, input) => {
        const [pool] = await tenantPools(context.sql, input.tenantId, input.poolId);
        if (!pool) throw new ComputeError('NOT_FOUND', `Pool ${input.poolId} not found`);
        return readPoolCapacity(context.sql, input.poolId);
      },
    }),
    offer: defineMethod({
      action: 'compute:pools:share',
      kind: 'mutation',
      resource: poolResource,
      validate: parseOfferPool,
      handler: async (context, input) => {
        const tx = context.sql;
        const pool = await ownedPool(tx, input.tenantId, input.poolId, true);
        await assertOfferable(tx, pool, input.toTenantId);
        await tx.query(
          `INSERT INTO pool_offers (pool_id, tenant_id, include_descendants, priority)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (pool_id, tenant_id) DO UPDATE
             SET include_descendants = EXCLUDED.include_descendants, priority = EXCLUDED.priority`,
          [pool.id, input.toTenantId, input.includeDescendants, input.priority ?? 0],
        );
        for (const [resource, max] of Object.entries(input.quota))
          await setQuota(tx, input.toTenantId, pool.id, resource, max);
        await context.authz.upsert(tx, await poolAuthzRow(tx, pool, input.toTenantId));
        await context.events.publish(tx, {
          type: 'pool.offered',
          tenantId: input.tenantId,
          subject: `pool/${pool.id}`,
          data: { toTenantId: input.toTenantId, quota: input.quota as Json },
        });
        const [view] = await tenantPools(tx, input.toTenantId, pool.id);
        return view!;
      },
    }),
    unoffer: defineMethod({
      action: 'compute:pools:share',
      kind: 'mutation',
      resource: poolResource,
      validate: (raw) => {
        const input = object(raw, ['tenantId', 'poolId', 'toTenantId']);
        return {
          tenantId: tenant(input.tenantId),
          poolId: id(input.poolId, 'pool', 'poolId'),
          toTenantId: tenant(input.toTenantId, 'toTenantId'),
        };
      },
      handler: async (context, input) => {
        const tx = context.sql;
        const pool = await ownedPool(tx, input.tenantId, input.poolId, true);
        if (input.toTenantId === pool.ownerTenantId)
          throw new ComputeError('INVALID_INPUT', 'A pool cannot be unoffered from its owner');
        const { rowCount } = await tx.query(
          `DELETE FROM pool_offers WHERE pool_id = $1 AND tenant_id = $2`,
          [pool.id, input.toTenantId],
        );
        // Live reservations keep their charge; nothing new fits (max drops to what is in use).
        for (const quota of await readQuotas(tx, input.toTenantId, pool.id))
          await setQuota(tx, input.toTenantId, pool.id, quota.resource, 0);
        await context.authz.remove(tx, { type: 'pool', id: pool.id, tenantId: input.toTenantId });
        if (rowCount > 0)
          await context.events.publish(tx, {
            type: 'pool.unoffered',
            tenantId: input.tenantId,
            subject: `pool/${pool.id}`,
            data: { toTenantId: input.toTenantId },
          });
        return { removed: rowCount > 0 };
      },
    }),
    update: later(
      'pools.update',
      'v0.2',
      'compute:pools:manage',
      'mutation',
      poolResource,
      parsePool,
    ),
    archive: later(
      'pools.archive',
      'v0.2',
      'compute:pools:manage',
      'mutation',
      poolResource,
      parsePool,
    ),
  };

  const capacity: CapacityApi['capacity'] = {
    summary: defineMethod({
      action: 'compute:capacity:read',
      kind: 'read',
      resource: tenantResource,
      validate: parseTenant,
      handler: async (context, input) => {
        const visible = await tenantPools(context.sql, input.tenantId);
        const rollups = await readPoolsCapacity(
          context.sql,
          visible.map((pool) => pool.id),
        );
        const summary: CapacitySummary = { pools: [], byGpuModel: {} };
        for (const pool of visible) {
          const rows = rollups.filter((row) => row.poolId === pool.id);
          const gpuModel = pool.gpuModel ?? 'other';
          summary.pools.push({ poolId: pool.id, gpuModel, owned: pool.owned, capacity: rows });
          const gpu = rows.find((row) => row.resource === 'gpu');
          if (!gpu) continue;
          const entry = (summary.byGpuModel[gpuModel] ??= {
            total: 0,
            allocatable: 0,
            allocated: 0,
            reserved: 0,
            available: 0,
          });
          entry.total += gpu.total;
          entry.allocatable += gpu.allocatable;
          entry.allocated += gpu.allocated;
          entry.reserved += gpu.reserved;
          entry.available += gpu.available;
        }
        return summary;
      },
    }),
    byPool: defineMethod({
      action: 'compute:capacity:read',
      kind: 'read',
      resource: poolResource,
      validate: parsePool,
      handler: async (context, input) => {
        const [pool] = await tenantPools(context.sql, input.tenantId, input.poolId);
        if (!pool) throw new ComputeError('NOT_FOUND', `Pool ${input.poolId} not found`);
        return readPoolCapacity(context.sql, input.poolId);
      },
    }),
    preview: defineMethod({
      action: 'compute:capacity:read',
      kind: 'read',
      resource: poolResource,
      validate: parseCreateReservation,
      handler: async (context, input) => {
        const tx = context.sql;
        const [visible] = await tenantPools(tx, input.tenantId, input.poolId);
        if (!visible) throw new ComputeError('NOT_FOUND', `Pool ${input.poolId} not found`);
        const pool = (await readPool(tx, input.poolId))!;
        const now = context.clock.now();
        const start = Math.max(input.start ?? now, now);
        const during = { start, end: start + input.duration };
        const views = await loadNodeViews(tx, pool, during);
        const plan = planPlacement(
          {
            tenantId: input.tenantId,
            poolId: input.poolId,
            reservationId: 'rsv_preview',
            devices: input.devices,
            ...(input.topology !== undefined ? { topology: input.topology } : {}),
            during,
          },
          views,
          pool,
          { plugins: options.plugins ?? [], weights: options.weights ?? {} },
        );
        const preview: CapacityPreview = {
          fits: plan.ranked.length > 0,
          candidates: plan.ranked
            .slice(0, 10)
            .map(({ nodeId, atoms, score }) => ({ nodeId, atoms, score })),
        };
        if (!preview.fits) preview.reason = summarizeRejections(plan.rejected);
        return preview;
      },
    }),
    timeline: later(
      'capacity.timeline',
      'v0.2',
      'compute:capacity:read',
      'read',
      poolResource,
      parsePool,
    ),
  };

  const reservations: CapacityApi['reservations'] = {
    create: defineMethod<CreateReservationInput, Reservation>({
      action: 'compute:reservations:create',
      kind: 'mutation',
      // The envelope decides on the draft `prepare` returns; this names the draft's kind.
      resource: (input) => ({ type: 'reservation', id: `draft:${input.idempotencyKey}` }),
      validate: parseCreateReservation,
      admission: {
        prepare: (context, input, tx) => prepareCreate(context, input, tx),
        denied: (context, input, tx) => denyCreate(context, input, tx),
      },
      handler: (context, input) => completeCreate(deps(context), context, input),
    }),
    get: defineMethod({
      action: 'compute:reservations:read',
      kind: 'read',
      resource: reservationResource,
      validate: parseReservation,
      handler: async (context, input) => {
        const row = await readReservation(context.sql, input.tenantId, input.reservationId);
        if (!row || row.state === 'draft')
          throw new ComputeError('NOT_FOUND', `Reservation ${input.reservationId} not found`);
        return reservationView(context.sql, row);
      },
    }),
    list: defineMethod({
      action: 'compute:reservations:read',
      kind: 'read',
      resource: tenantResource,
      validate: parseListReservations,
      handler: (context, input) => listReservations(context.sql, input),
    }),
    release: defineMethod({
      action: 'compute:reservations:release',
      kind: 'mutation',
      resource: reservationResource,
      validate: parseReservation,
      handler: (context, input) =>
        releaseReservation(deps(context), context.sql, input.tenantId, input.reservationId),
    }),
    cancel: defineMethod({
      action: 'compute:reservations:release',
      kind: 'mutation',
      resource: reservationResource,
      validate: parseReservation,
      handler: (context, input) =>
        cancelReservation(deps(context), context.sql, input.tenantId, input.reservationId),
    }),
    extend: defineMethod<ExtendReservationInput, ExtendResult>({
      action: 'compute:reservations:extend',
      kind: 'mutation',
      resource: reservationResource,
      validate: parseExtendReservation,
      admission: {
        prepare: (context, input, tx) => prepareExtend(context, input, tx),
        denied: (context, input, tx) => denyPending(context, input, tx),
      },
      handler: (context, input) => completeExtend(deps(context), context, input),
    }),
    renew: defineMethod({
      action: 'compute:reservations:extend',
      kind: 'mutation',
      resource: reservationResource,
      validate: parseReservation,
      handler: (context, input) =>
        renewReservation(deps(context), context.sql, input.tenantId, input.reservationId),
    }),
  };

  const quotas: CapacityApi['quotas'] = {
    get: defineMethod({
      action: 'compute:quotas:read',
      kind: 'read',
      resource: tenantResource,
      validate: (raw) => {
        const input = object(raw, ['tenantId', 'poolId']);
        const result: TenantInput & { poolId?: string } = { tenantId: tenant(input.tenantId) };
        if (input.poolId !== undefined) result.poolId = id(input.poolId, 'pool', 'poolId');
        return result;
      },
      handler: async (context, input) => ({
        items: await readQuotas(context.sql, input.tenantId, input.poolId),
      }),
    }),
    set: later(
      'quotas.set',
      'v0.2',
      'compute:quotas:manage',
      'mutation',
      () => ({ type: 'fleet', id: 'fleet' }),
      parseTenant,
    ),
  };

  return { pools, capacity, reservations, quotas };
}

/**
 * The CapacityPort other modules book through (`context.capacity`): quota and placement together,
 * all-or-nothing. A request that does not fit gets its charge back and answers `pending`.
 */
export function createCapacityPort(
  context: Pick<ModuleContext, 'clock'>,
  options: CapacityModuleOptions = {},
): CapacityPort {
  const placer = inlinePlacer(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {});
  return {
    async reserve(tx, request) {
      const demand = quotaDemand(request);
      await chargeQuota(tx, request.tenantId, request.poolId, demand);
      const outcome = await placer.place(tx, request, {
        clock: context.clock,
        random: options.random ?? Math.random,
        plugins: options.plugins ?? [],
        weights: options.weights ?? {},
        topN: options.topN ?? 5,
      });
      if (outcome.status !== 'placed')
        await refundQuota(tx, request.tenantId, request.poolId, demand);
      return outcome;
    },
    async release(tx, allocationId) {
      // Lock order matches reserve (quota before rollup), so the two never deadlock.
      const allocation = await readAllocation(tx, allocationId, { lock: true });
      if (!allocation) throw new ComputeError('NOT_FOUND', `Allocation ${allocationId} not found`);
      if (allocation.released) return;
      const { rows } = await tx.query<{ class: string; count: string | number }>(
        `SELECT class, count(*) AS count FROM devices WHERE id = ANY($1::text[]) GROUP BY class`,
        [allocation.atoms],
      );
      const demand: Record<string, number> = { ...allocation.resources };
      for (const row of rows) demand[row.class] = (demand[row.class] ?? 0) + Number(row.count);
      await refundQuota(tx, allocation.tenantId, allocation.poolId, demand);
      await releaseAllocation(tx, allocationId);
    },
  };
}

/**
 * The always-on built-in capacity module. The server registers it right after `inventoryModule`.
 * Scheduler options (plugins, weights, top-N, a seeded `random` in the simulator) shape placement.
 */
export function capacityModule(
  options: CapacityModuleOptions = {},
): ComputeModule<'capacity', CapacityApi> {
  const placer = inlinePlacer(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {});
  const reservationsReconciler: Reconciler = {
    name: reservationWork,
    shardBy: 'none',
    async run(context, key) {
      const deps = depsFrom(context, placer, options);
      await inTx(context, async (tx) => {
        const next = await reconcileReservation(deps, tx, key);
        if (next !== undefined)
          await context.work.enqueue(tx, reservationWork, key, { notBefore: next });
      });
      return 'DONE';
    },
  };
  const rollupReconciler: Reconciler = {
    name: 'capacity.rollup',
    shardBy: 'none',
    periodic: [{ key: 'all', every: options.rollupEvery ?? '5m' }],
    async run(context) {
      const { rows } = await context.sql.query<{ id: string; owner_tenant_id: string }>(
        `SELECT id, owner_tenant_id FROM pools ORDER BY id`,
      );
      for (const row of rows)
        await inTx(context, (tx) =>
          rebuildPoolRollup(tx, { id: row.id, ownerTenantId: row.owner_tenant_id }),
        );
      return 'DONE';
    },
  };
  return defineModule({
    name: 'capacity',
    migrations: [...capacityMigrations],
    api: () => buildApi(options, placer),
    reconcilers: [reservationsReconciler, rollupReconciler],
    async nodeSpec(context, node) {
      const assignments = await deviceAssignments(context.sql, node.id);
      return { devices: { assignments } };
    },
    async selfCheck(context) {
      const { rows } = await context.sql.query<{ count: string | number }>(
        `SELECT count(*) AS count FROM reservations
          WHERE state IN ('placed', 'binding', 'active') AND upper(during) < compute_now() - interval '10 minutes'`,
      );
      const stale = Number(rows[0]?.count ?? 0);
      return stale > 0
        ? [
            {
              check: 'capacity.reservations.stale',
              severity: 'warning',
              message: `${stale} reservations are past their end but not released`,
              fix: 'Check that a worker runs the capacity.reservations reconciler',
              count: stale,
            },
          ]
        : [];
    },
  });
}
