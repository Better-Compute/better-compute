import {
  ComputeError,
  defineMethod,
  defineModule,
  draftId,
  fleetResourceId,
  isId,
  newId,
  reservationStates,
  type AdmissionContext,
  type CapacityPort,
  type ComputeModule,
  type Finding,
  type Json,
  type MethodContext,
  type MethodDefinition,
  type ModuleContext,
  type Pool,
  type PoolAgent,
  type PoolClass,
  type PoolPolicy,
  type Placer,
  type PlacementOutcome,
  type PlacementRequest,
  type Reconciler,
  type Reservation,
  type ReservationState,
  type SharingMode,
  type SqlTx,
} from '@better-compute/core';
import { readAllocation, releaseAllocation } from './bookings.js';
import { capacityMigrations } from './migrations.js';
import { planGangs } from './gang.js';
import { planPlacement, summarizeRejections } from './pipeline.js';
import { inlinePlacer, poolLeasePlacer, type PlacementObserver } from './placer.js';
import { freezeMigLayouts, migGateWork, runMigGate } from './mig.js';
import { dedicatedTaintPrefix } from './eligibility.js';
import { describedBy, schemas } from './schemas.js';
import { capacityTenantDeleted } from './tenancy.js';
import { leaseCandidates, leaseGroups } from './node-lease.js';
import { PoolIndexCache } from './pool-index.js';
import { defaultSpotNoticeMs, planPreemption, readSpotAllocations } from './spot.js';
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
  budgetAdmissionCheck,
  budgetExtendCheck,
  denyCreate,
  denyPending,
  deviceAssignments,
  listReservations,
  parseCreateReservation,
  parseExtendReservation,
  placeQueued,
  placerWork,
  prepareCreate,
  prepareExtend,
  readReservation,
  reconcileReservation,
  releaseReservation,
  renewReservation,
  reservationView,
  reservationWork,
  type AllocationBindingCheck,
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
import { meterReservations } from './usage.js';

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
  archived?: boolean;
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
  /** Archived pools take no new work; only their owner still sees them. */
  archived: boolean;
  quotas: QuotaRow[];
}

async function tenantPools(tx: SqlTx, tenantId: string, poolId?: string): Promise<TenantPool[]> {
  const { rows } = await tx.query<RawPoolRow>(
    `SELECT p.id, p.owner_tenant_id, p.site_id, p.class, p.gpu_model, p.sharing, p.agent, p.policy,
            p.provider_account_id, p.version, p.archived_at IS NOT NULL AS archived
       FROM pools p WHERE ${visibleWhere} AND (p.archived_at IS NULL OR p.owner_tenant_id = $1) AND ($2::text IS NULL OR p.id = $2) ORDER BY p.id`,
    [tenantId, poolId ?? null],
  );
  const quotas = await readQuotas(tx, tenantId, poolId);
  return rows.map((row) => ({
    ...toPool(row),
    owned: row.owner_tenant_id === tenantId,
    archived: row.archived === true,
    quotas: quotas.filter((quota) => quota.poolId === row.id),
  }));
}

async function ownedPool(
  tx: SqlTx,
  tenantId: string,
  poolId: string,
  lock = false,
): Promise<Pool & { archived: boolean }> {
  const { rows } = await tx.query<RawPoolRow>(
    `SELECT id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version,
            provider_account_id, archived_at IS NOT NULL AS archived
       FROM pools WHERE id = $1 AND owner_tenant_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [poolId, tenantId],
  );
  if (!rows[0]) throw new ComputeError('NOT_FOUND', `Pool ${poolId} not found`);
  return { ...toPool(rows[0]), archived: rows[0].archived === true };
}

async function findOwnedPool(
  tx: SqlTx,
  tenantId: string,
  poolId: string,
): Promise<(Pool & { archived: boolean }) | undefined> {
  try {
    return await ownedPool(tx, tenantId, poolId);
  } catch (error) {
    if (error instanceof ComputeError && error.code === 'NOT_FOUND') return undefined;
    throw error;
  }
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
  /**
   * Makes the pool id deterministic (`draftId('pool', tenant, caller, key)`), as `sites.create` does:
   * a retry returns the pool, a different request under the key is `CONFLICT`. FleetConfig computes
   * the id up front so a plan can offer and size a pool it has not created yet.
   */
  idempotencyKey?: string;
}

/** Idempotency keys (the server's `sites.create` grammar). */
const idempotencyKeyPattern = /^[A-Za-z0-9._~:/+=-]{1,128}$/;

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
    'idempotencyKey',
  ]);
  if (
    input.idempotencyKey !== undefined &&
    (typeof input.idempotencyKey !== 'string' || !idempotencyKeyPattern.test(input.idempotencyKey))
  )
    fail('idempotencyKey is invalid');
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
  const agent = (input.agent ?? (input.class === 'provider' ? 'none' : 'bcd')) as PoolAgent;
  if (agent !== 'bcd' && agent !== 'none') fail('agent must be bcd or none');
  if (
    input.gpuModel !== undefined &&
    (typeof input.gpuModel !== 'string' || !/^[A-Za-z0-9-]{1,32}$/.test(input.gpuModel))
  )
    fail('gpuModel is invalid');
  if (input.policy !== undefined) checkPolicy(input.policy);
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
  if (input.idempotencyKey !== undefined) result.idempotencyKey = input.idempotencyKey as string;
  return result;
}

/** The pool id `pools.create` uses: derived from the key when one is given. */
async function createdPoolId(context: MethodContext, input: CreatePoolInput): Promise<string> {
  if (input.idempotencyKey === undefined) return newId('pool');
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  return draftId('pool', input.tenantId, caller.identityId, input.idempotencyKey);
}

/** Whether a stored pool was created by this request (the fields `pools.update` never changes). */
function samePoolRequest(pool: Pool, input: CreatePoolInput): boolean {
  return (
    pool.siteId === input.siteId &&
    pool.class === input.class &&
    pool.sharing === input.sharing &&
    pool.agent === input.agent &&
    (pool.providerAccountId ?? null) === (input.providerAccountId ?? null)
  );
}

const keyReused = () =>
  new ComputeError('CONFLICT', 'This idempotency key was used for a different request');

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
 * The offering validator (§10.2, §10.6, §13): a pool holding `tenant-owned` nodes, or a
 * single-tenant sharing mode (`timeslice`, `mps`), may be offered only to its owner. A
 * `policy.singleTenant` pool (container runtimes share the host kernel) may be offered to one tenant
 * besides its owner, without descendants. The caller holds the pool row lock.
 */
export async function assertOfferable(
  tx: SqlTx,
  pool: Pool,
  toTenantId: string,
  options: { includeDescendants?: boolean } = {},
): Promise<void> {
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
  if (pool.policy.singleTenant !== true) return;
  if (options.includeDescendants)
    throw new ComputeError(
      'INVALID_STATE',
      `Pool ${pool.id} is single-tenant: offer it without includeDescendants`,
    );
  const other = (await offeredTenants(tx, pool)).find((tenantId) => tenantId !== toTenantId);
  if (other !== undefined)
    throw new ComputeError(
      'INVALID_STATE',
      `Pool ${pool.id} is single-tenant and already offered to ${other}`,
    );
}

/** The tenants other than the owner that hold an offer of a pool, sorted. */
async function offeredTenants(tx: SqlTx, pool: Pool): Promise<string[]> {
  const { rows } = await tx.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM pool_offers WHERE pool_id = $1 AND tenant_id <> $2 ORDER BY tenant_id`,
    [pool.id, pool.ownerTenantId],
  );
  return rows.map((row) => row.tenant_id);
}

/** `pools.update` may turn `singleTenant` on only while at most one tenant, without descendants, holds an offer. */
async function assertSingleTenantable(tx: SqlTx, pool: Pool): Promise<void> {
  const tenants = await offeredTenants(tx, pool);
  if (tenants.length > 1)
    throw new ComputeError(
      'INVALID_STATE',
      `Pool ${pool.id} is offered to ${tenants.length} tenants (${tenants.join(', ')}); unoffer all but one before setting singleTenant`,
    );
  const { rows } = await tx.query(
    `SELECT 1 FROM pool_offers WHERE pool_id = $1 AND tenant_id <> $2 AND include_descendants LIMIT 1`,
    [pool.id, pool.ownerTenantId],
  );
  if (rows.length > 0)
    throw new ComputeError(
      'INVALID_STATE',
      `Pool ${pool.id} is offered with includeDescendants; offer it without before setting singleTenant`,
    );
}

// --- API types ---------------------------------------------------------------------------------

type TenantInput = { tenantId: string };
type PoolInput = { tenantId: string; poolId: string };
type ReservationInput = { tenantId: string; reservationId: string };
type ListReservationsInput = {
  tenantId: string;
  /** `mine` (the default): only the caller's own; `all`: the tenant's, for admins (§9.2). */
  scope: 'mine' | 'all';
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
  /**
   * When it does not fit now but would by preempting spot work (a regular request only): how many
   * spot reservations would get a notice, and when the request would start (after the notice).
   */
  preemptible?: { reservations: number; startsAt: number };
}

export type CapacityApi = {
  pools: {
    list: MethodDefinition<TenantInput, { items: TenantPool[] }>;
    get: MethodDefinition<PoolInput, TenantPool>;
    create: MethodDefinition<CreatePoolInput, Pool>;
    capacity: MethodDefinition<PoolInput, PoolCapacity[]>;
    offer: MethodDefinition<OfferPoolInput, TenantPool>;
    unoffer: MethodDefinition<PoolInput & { toTenantId: string }, { removed: boolean }>;
    update: MethodDefinition<UpdatePoolInput, Pool>;
    archive: MethodDefinition<PoolInput, Pool>;
  };
  capacity: {
    summary: MethodDefinition<TenantInput, CapacitySummary>;
    byPool: MethodDefinition<PoolInput, PoolCapacity[]>;
    preview: MethodDefinition<CreateReservationInput, CapacityPreview>;
    timeline: MethodDefinition<TimelineInput, CapacityTimeline>;
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
    set: MethodDefinition<SetQuotaInput, QuotaRow>;
  };
};

export interface UpdatePoolInput {
  tenantId: string;
  poolId: string;
  policy?: PoolPolicy;
  gpuModel?: string;
}

export interface TimelineInput {
  tenantId: string;
  poolId: string;
  /** Epoch ms; default: the current hour. */
  from?: number;
  /** Epoch ms; default: `from` + 24 h. At most 7 days and 336 buckets. */
  to?: number;
  /** Bucket width in minutes (default 60). */
  stepMinutes?: number;
}

/** `capacity.timeline`: GPUs booked per bucket, for calendar views and future reservations. */
export interface CapacityTimeline {
  poolId: string;
  /** Schedulable, healthy GPUs now (the rollup's `allocatable`). */
  allocatable: number;
  buckets: { start: number; end: number; booked: number; free: number }[];
}

export interface SetQuotaInput {
  tenantId: string;
  poolId: string;
  resource: string;
  max: number;
}

/** A pool policy object; the fields capacity enforces are type-checked. */
function checkPolicy(policy: unknown): PoolPolicy {
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy))
    fail('policy must be an object');
  const singleTenant = (policy as Record<string, unknown>).singleTenant;
  if (singleTenant !== undefined && typeof singleTenant !== 'boolean')
    fail('policy.singleTenant must be true or false');
  return policy as PoolPolicy;
}

function parseUpdatePool(raw: unknown): UpdatePoolInput {
  const input = object(raw, ['tenantId', 'poolId', 'policy', 'gpuModel']);
  const result: UpdatePoolInput = {
    tenantId: tenant(input.tenantId),
    poolId: id(input.poolId, 'pool', 'poolId'),
  };
  if (input.policy !== undefined) result.policy = checkPolicy(input.policy);
  if (input.gpuModel !== undefined) {
    if (typeof input.gpuModel !== 'string' || !/^[A-Za-z0-9-]{1,32}$/.test(input.gpuModel))
      fail('gpuModel is invalid');
    result.gpuModel = input.gpuModel;
  }
  if (result.policy === undefined && result.gpuModel === undefined) fail('Nothing to update');
  return result;
}

const hourMs = 3_600_000;

function parseTimeline(raw: unknown): TimelineInput {
  const input = object(raw, ['tenantId', 'poolId', 'from', 'to', 'stepMinutes']);
  const result: TimelineInput = {
    tenantId: tenant(input.tenantId),
    poolId: id(input.poolId, 'pool', 'poolId'),
  };
  const from = optionalInt(input.from, 'from', 0, 2 ** 47);
  const to = optionalInt(input.to, 'to', 0, 2 ** 47);
  const step = optionalInt(input.stepMinutes, 'stepMinutes', 5, 24 * 60);
  if (from !== undefined) result.from = from;
  if (to !== undefined) result.to = to;
  if (step !== undefined) result.stepMinutes = step;
  return result;
}

function parseSetQuota(raw: unknown): SetQuotaInput {
  const input = object(raw, ['tenantId', 'poolId', 'resource', 'max']);
  if (typeof input.resource !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(input.resource))
    fail('resource is invalid');
  const max = optionalInt(input.max, 'max', 0, Number.MAX_SAFE_INTEGER);
  if (max === undefined) fail('max is required');
  return {
    tenantId: tenant(input.tenantId),
    poolId: id(input.poolId, 'pool', 'poolId'),
    resource: input.resource,
    max,
  };
}

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
  const input = object(raw, ['tenantId', 'scope', 'state', 'poolId', 'limit', 'cursor']);
  if (input.scope !== undefined && input.scope !== 'mine' && input.scope !== 'all')
    fail('scope must be mine or all');
  const result: ListReservationsInput = {
    tenantId: tenant(input.tenantId),
    scope: (input.scope as 'mine' | 'all' | undefined) ?? 'mine',
  };
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

// --- Module ------------------------------------------------------------------------------------

export interface CapacityModuleOptions extends PlacementOptions {
  /** Placement attempts per admission (default 3). */
  maxAttempts?: number;
  /** How often the rollup job rebuilds every pool (default `5m`). */
  rollupEvery?: `${number}${'s' | 'm' | 'h'}`;
  /** How often the usage job writes closed hourly windows (default `5m`). */
  usageEvery?: `${number}${'s' | 'm' | 'h'}`;
  /** The notice a preempted spot reservation gets before its atoms are taken (default 2 min). */
  spotNoticeMs?: number;
  /**
   * `inline` (v0.1, default): reservations are placed in the admission transaction. `pool-lease`
   * (v0.4): they are queued and placed in batches by the worker owning the pool (`capacity.placer`),
   * so `reservations.create` answers `pending` with a `Queued` condition until the batch runs.
   */
  placer?: 'inline' | 'pool-lease';
  /** Reservations per pool-lease batch (≤64, default 64). */
  maxBatch?: number;
  /**
   * (v0.2, P14) Verify node-signed `AllocationBound` reports before a reservation goes active; an
   * unsigned or forged report never counts (`reservation.binding-rejected`). Off by default; hosts
   * that sign commands turn it on with the server's pki-backed check.
   */
  attestedBindings?: AllocationBindingCheck;
  /**
   * Called once per placement by every placer this module runs, and by `createCapacityPort` (§14):
   * hosts map it to `placements_total{outcome}` and `booking_conflicts_total`. Never throws into
   * placement.
   */
  onPlacement?: PlacementObserver;
}

function depsFrom(
  context: ModuleContext,
  placers: Placers,
  options: CapacityModuleOptions,
): ReservationDeps {
  return {
    clock: context.clock,
    events: context.events,
    work: context.work,
    authz: context.authz,
    desired: context.desired,
    placer: placers.placer,
    inline: placers.inline,
    placement: {
      random: options.random ?? Math.random,
      plugins: options.plugins ?? [],
      weights: options.weights ?? {},
      topN: options.topN ?? 5,
    },
    ...(options.spotNoticeMs !== undefined ? { spotNoticeMs: options.spotNoticeMs } : {}),
    ...(options.attestedBindings ? { attestedBindings: options.attestedBindings } : {}),
    ...(options.onPlacement ? { onPlacement: options.onPlacement } : {}),
  };
}

/** Transactions inside a method: the envelope's executor turns nested ones into savepoints. */
function inTx<T>(context: ModuleContext, fn: (tx: SqlTx) => Promise<T>): Promise<T> {
  return context.sql.transaction(fn);
}

interface Placers {
  placer: Placer;
  inline: Placer;
}

function placersFor(options: CapacityModuleOptions): Placers {
  const settings = {
    ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.onPlacement ? { onPlacement: options.onPlacement } : {}),
  };
  const inline = inlinePlacer(settings);
  return { inline, placer: options.placer === 'pool-lease' ? poolLeasePlacer(settings) : inline };
}

function buildApi(options: CapacityModuleOptions, placers: Placers): CapacityApi {
  const deps = (context: MethodContext) => depsFrom(context, placers, options);

  const pools: CapacityApi['pools'] = {
    list: defineMethod({
      action: 'compute:pools:read',
      kind: 'read',
      resource: tenantResource,
      validate: describedBy(schemas.tenant, parseTenant),
      handler: async (context, input) => ({
        items: await tenantPools(context.sql, input.tenantId),
      }),
    }),
    get: defineMethod({
      action: 'compute:pools:read',
      kind: 'read',
      resource: poolResource,
      validate: describedBy(schemas.pool, parsePool),
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
      validate: describedBy(schemas.createPool, parseCreatePool),
      // With an idempotency key, a finished request replays without a second decision (§3.4 step 4).
      admission: {
        async prepare(context, input, tx) {
          const decide = { status: 'decide' as const, resource: tenantResource(input) };
          if (input.idempotencyKey === undefined) return decide;
          const existing = await findOwnedPool(
            tx,
            input.tenantId,
            await createdPoolId(context, input),
          );
          if (!existing) return decide;
          if (!samePoolRequest(existing, input)) throw keyReused();
          return { status: 'replay', result: existing };
        },
      },
      handler: async (context, input) => {
        const tx = context.sql;
        const poolId = await createdPoolId(context, input);
        if (input.idempotencyKey !== undefined) {
          const existing = await findOwnedPool(tx, input.tenantId, poolId);
          if (existing) {
            if (!samePoolRequest(existing, input)) throw keyReused();
            return existing;
          }
        }
        const site = await tx.query<{ owner_tenant_id: string }>(
          `SELECT owner_tenant_id FROM sites WHERE id = $1`,
          [input.siteId],
        );
        if (site.rows[0]?.owner_tenant_id !== input.tenantId)
          throw new ComputeError('NOT_FOUND', `Site ${input.siteId} not found`);
        const pool: Pool = {
          id: poolId,
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
        const inserted = await tx.query(
          `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy,
                              provider_account_id, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 1)
           ON CONFLICT (id) DO NOTHING`,
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
        if (inserted.rowCount === 0) {
          // A concurrent request with the same key committed first.
          const winner = await findOwnedPool(tx, input.tenantId, pool.id);
          if (!winner || !samePoolRequest(winner, input)) throw keyReused();
          return winner;
        }
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
      validate: describedBy(schemas.pool, parsePool),
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
      validate: describedBy(schemas.offerPool, parseOfferPool),
      handler: async (context, input) => {
        const tx = context.sql;
        const pool = await ownedPool(tx, input.tenantId, input.poolId, true);
        if (pool.archived) throw new ComputeError('INVALID_STATE', `Pool ${pool.id} is archived`);
        await assertOfferable(tx, pool, input.toTenantId, {
          includeDescendants: input.includeDescendants,
        });
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
      validate: describedBy(schemas.unofferPool, (raw) => {
        const input = object(raw, ['tenantId', 'poolId', 'toTenantId']);
        return {
          tenantId: tenant(input.tenantId),
          poolId: id(input.poolId, 'pool', 'poolId'),
          toTenantId: tenant(input.toTenantId, 'toTenantId'),
        };
      }),
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
    update: defineMethod({
      action: 'compute:pools:manage',
      kind: 'mutation',
      resource: poolResource,
      validate: describedBy(schemas.updatePool, parseUpdatePool),
      handler: async (context, input) => {
        const tx = context.sql;
        const pool = await ownedPool(tx, input.tenantId, input.poolId, true);
        const next: Pool = { ...pool, version: pool.version + 1 };
        if (input.policy !== undefined) next.policy = input.policy;
        if (next.policy.singleTenant === true && pool.policy.singleTenant !== true)
          await assertSingleTenantable(tx, pool);
        if (input.gpuModel !== undefined) next.gpuModel = input.gpuModel;
        await tx.query(
          `UPDATE pools SET policy = $2::jsonb, gpu_model = $3, version = version + 1 WHERE id = $1`,
          [pool.id, JSON.stringify(next.policy), next.gpuModel ?? null],
        );
        // A new MIG layout never repartitions booked GPUs: each node keeps its layout until its
        // GPUs are idle (the capacity.mig gate).
        const [before, after] = [pool.policy.migLayout, next.policy.migLayout];
        if (
          pool.sharing === 'mig' &&
          typeof before === 'string' &&
          typeof after === 'string' &&
          before !== after
        )
          await freezeMigLayouts(tx, context.work, pool.id, before, after);
        // The site agents' image caches prewarm from the pool policy (§11.5): recompute their specs
        // now rather than at the level-triggered resync.
        const prewarm = (policy: PoolPolicy) =>
          JSON.stringify((policy as Record<string, unknown>).prewarmImages ?? null);
        if (prewarm(pool.policy) !== prewarm(next.policy)) {
          const { rows: agents } = await tx.query<{ id: string }>(
            `SELECT id FROM nodes WHERE site_id = $1 AND role = 'site' AND deleted_at IS NULL ORDER BY id`,
            [pool.siteId],
          );
          for (const agent of agents) await context.desired.invalidate(tx, agent.id);
        }
        // Every tenant view of the pool carries the new attributes.
        const offers = await tx.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM pool_offers WHERE pool_id = $1`,
          [pool.id],
        );
        for (const viewer of new Set([
          pool.ownerTenantId,
          ...offers.rows.map((row) => row.tenant_id),
        ]))
          await context.authz.upsert(tx, await poolAuthzRow(tx, next, viewer));
        await context.events.publish(tx, {
          type: 'pool.updated',
          tenantId: input.tenantId,
          subject: `pool/${pool.id}`,
          data: { version: next.version },
        });
        return next;
      },
    }),
    // Archiving withdraws a pool from every tenant it was offered to and stops new work; live
    // reservations and instances keep their bookings until they end (quota max drops to used).
    archive: defineMethod({
      action: 'compute:pools:manage',
      kind: 'mutation',
      resource: poolResource,
      validate: describedBy(schemas.pool, parsePool),
      handler: async (context, input) => {
        const tx = context.sql;
        const pool = await ownedPool(tx, input.tenantId, input.poolId, true);
        if (pool.archived) return pool;
        const offers = await tx.query<{ tenant_id: string }>(
          `DELETE FROM pool_offers WHERE pool_id = $1 RETURNING tenant_id`,
          [pool.id],
        );
        for (const { tenant_id: viewer } of offers.rows) {
          if (viewer === pool.ownerTenantId) continue;
          for (const quota of await readQuotas(tx, viewer, pool.id))
            await setQuota(tx, viewer, pool.id, quota.resource, 0);
          await context.authz.remove(tx, { type: 'pool', id: pool.id, tenantId: viewer });
        }
        await tx.query(
          `UPDATE pools SET archived_at = compute_now(), version = version + 1 WHERE id = $1`,
          [pool.id],
        );
        await context.events.publish(tx, {
          type: 'pool.archived',
          tenantId: input.tenantId,
          subject: `pool/${pool.id}`,
          data: { unoffered: offers.rows.map((row) => row.tenant_id) },
        });
        return { ...pool, archived: true, version: pool.version + 1 };
      },
    }),
  };

  const capacity: CapacityApi['capacity'] = {
    summary: defineMethod({
      action: 'compute:capacity:read',
      kind: 'read',
      resource: tenantResource,
      validate: describedBy(schemas.tenant, parseTenant),
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
      validate: describedBy(schemas.pool, parsePool),
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
      validate: describedBy(schemas.createReservation, parseCreateReservation),
      handler: async (context, input) => {
        const tx = context.sql;
        const [visible] = await tenantPools(tx, input.tenantId, input.poolId);
        if (!visible) throw new ComputeError('NOT_FOUND', `Pool ${input.poolId} not found`);
        const pool = (await readPool(tx, input.poolId))!;
        const now = context.clock.now();
        const start = Math.max(input.start ?? now, now);
        const during = { start, end: start + input.duration };
        const request = {
          tenantId: input.tenantId,
          poolId: input.poolId,
          reservationId: 'rsv_preview',
          devices: input.devices,
          ...(input.topology !== undefined ? { topology: input.topology } : {}),
          ...(input.gang !== undefined ? { gang: input.gang } : {}),
          during,
        };
        if (input.binding === 'node') {
          // A node lease takes whole leasable nodes; show the ones it would take.
          const { candidates, labels } = await leaseCandidates(tx, pool.id, request);
          const chosen = leaseGroups(request, candidates, labels);
          const preview: CapacityPreview = {
            fits: chosen !== undefined,
            candidates: (chosen ?? []).map((fit) => ({
              nodeId: fit.nodeId,
              atoms: fit.atoms.map((atom) => atom.id),
              score: 0,
            })),
          };
          if (!chosen)
            preview.reason = `${candidates.length} leasable node(s) fit, ${input.gang?.size ?? 1} needed`;
          return preview;
        }
        const views = await loadNodeViews(tx, pool, during);
        const plan = planPlacement(request, views, pool, {
          plugins: options.plugins ?? [],
          weights: options.weights ?? {},
        });
        const toCandidate = ({ nodeId, atoms, score }: (typeof plan.ranked)[number]) => ({
          nodeId,
          atoms,
          score,
        });
        if (input.gang !== undefined) {
          // A gang fits when one topology group holds `size` fitting nodes: show the best gang.
          const { gangs, reason } = planGangs(plan.ranked, views, input.gang);
          const best = gangs[0];
          const preview: CapacityPreview = {
            fits: best !== undefined,
            candidates: best ? best.members.map(toCandidate) : [],
          };
          if (!best)
            preview.reason =
              plan.ranked.length === 0
                ? summarizeRejections(plan.rejected)
                : plan.rejected.length > 0
                  ? `${reason!}; ${summarizeRejections(plan.rejected)}`
                  : reason!;
          return preview;
        }
        const preview: CapacityPreview = {
          fits: plan.ranked.length > 0,
          candidates: plan.ranked.slice(0, 10).map(toCandidate),
        };
        if (!preview.fits) {
          preview.reason = summarizeRejections(plan.rejected);
          if (input.spot !== true) {
            // Would it fit by preempting spot work? A count only: never another tenant's ids.
            const at = Math.max(start, now + (options.spotNoticeMs ?? defaultSpotNoticeMs));
            const window = { start: at, end: at + input.duration };
            const spot = await readSpotAllocations(tx, pool.id, window);
            const preemption = await planPreemption(
              tx,
              pool,
              { ...request, during: window },
              spot,
              {
                plugins: options.plugins ?? [],
                weights: options.weights ?? {},
              },
            );
            if (preemption)
              preview.preemptible = { reservations: preemption.victims.length, startsAt: at };
          }
        }
        return preview;
      },
    }),
    timeline: defineMethod({
      action: 'compute:capacity:read',
      kind: 'read',
      resource: poolResource,
      validate: describedBy(schemas.timeline, parseTimeline),
      handler: async (context, input) => {
        const tx = context.sql;
        const [visible] = await tenantPools(tx, input.tenantId, input.poolId);
        if (!visible) throw new ComputeError('NOT_FOUND', `Pool ${input.poolId} not found`);
        const step = (input.stepMinutes ?? 60) * 60_000;
        const from = input.from ?? Math.floor(context.clock.now() / hourMs) * hourMs;
        const to = input.to ?? from + 24 * hourMs;
        if (!(to > from)) fail('to must be after from');
        if (to - from > 7 * 24 * hourMs || Math.ceil((to - from) / step) > 336)
          fail('A timeline spans at most 7 days and 336 buckets');
        const { rows } = await tx.query<{ start_ms: number; booked: string | number }>(
          `SELECT (extract(epoch FROM g.t) * 1000)::float8 AS start_ms,
                  count(DISTINCT b.device_id) AS booked
             FROM generate_series($2::timestamptz, $3::timestamptz - make_interval(secs => $4 / 1000.0),
                                  make_interval(secs => $4 / 1000.0)) AS g(t)
             LEFT JOIN device_bookings b
               ON b.during && tstzrange(g.t, g.t + make_interval(secs => $4 / 1000.0))
              AND b.device_id IN (SELECT d.id FROM devices d JOIN nodes n ON n.id = d.node_id
                                   WHERE n.pool_id = $1 AND d.class = 'gpu')
            GROUP BY g.t ORDER BY g.t`,
          [input.poolId, new Date(from).toISOString(), new Date(to).toISOString(), step],
        );
        const gpu = (await readPoolCapacity(tx, input.poolId)).find(
          (row) => row.resource === 'gpu',
        );
        const allocatable = gpu?.allocatable ?? 0;
        return {
          poolId: input.poolId,
          allocatable,
          buckets: rows.map((row) => {
            const start = Number(row.start_ms);
            const booked = Number(row.booked);
            return {
              start,
              end: Math.min(start + step, to),
              booked,
              free: Math.max(0, allocatable - booked),
            };
          }),
        };
      },
    }),
  };

  const reservations: CapacityApi['reservations'] = {
    create: defineMethod<CreateReservationInput, Reservation>({
      action: 'compute:reservations:create',
      kind: 'mutation',
      // The envelope decides on the draft `prepare` returns; this names the draft's kind.
      resource: (input) => ({ type: 'reservation', id: `draft:${input.idempotencyKey}` }),
      validate: describedBy(schemas.createReservation, parseCreateReservation),
      admission: {
        prepare: (context, input, tx) => prepareCreate(context, input, tx),
        denied: (context, input, tx, error) => denyCreate(context, input, tx, error),
        check: (context, input) => budgetAdmissionCheck(context, input.tenantId, input.poolId),
      },
      handler: (context, input) => completeCreate(deps(context), context, input),
      // §9.1 async-with-wait: `wait` holds the answer while the pool-lease batch runs.
      poll: {
        done: (output) => output.operation?.state !== 'running',
        refresh: async (context, input, output) => {
          const row = await readReservation(context.sql, input.tenantId, output.id);
          return row ? reservationView(context.sql, row) : output;
        },
      },
    }),
    get: defineMethod({
      action: 'compute:reservations:read',
      kind: 'read',
      resource: reservationResource,
      validate: describedBy(schemas.reservation, parseReservation),
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
      validate: describedBy(schemas.listReservations, parseListReservations),
      handler: (context, input) => {
        const { scope, ...filters } = input;
        return listReservations(context.sql, {
          ...filters,
          ...(scope === 'mine' ? { ownerIdentityId: context.caller?.identityId ?? '' } : {}),
        });
      },
    }),
    release: defineMethod({
      action: 'compute:reservations:release',
      kind: 'mutation',
      resource: reservationResource,
      validate: describedBy(schemas.reservation, parseReservation),
      handler: (context, input) =>
        releaseReservation(deps(context), context.sql, input.tenantId, input.reservationId),
    }),
    cancel: defineMethod({
      action: 'compute:reservations:release',
      kind: 'mutation',
      resource: reservationResource,
      validate: describedBy(schemas.reservation, parseReservation),
      handler: (context, input) =>
        cancelReservation(deps(context), context.sql, input.tenantId, input.reservationId),
    }),
    extend: defineMethod<ExtendReservationInput, ExtendResult>({
      action: 'compute:reservations:extend',
      kind: 'mutation',
      resource: reservationResource,
      validate: describedBy(schemas.extendReservation, parseExtendReservation),
      admission: {
        prepare: (context, input, tx) => prepareExtend(context, input, tx),
        denied: (context, input, tx) => denyPending(context, input, tx),
        check: (context, input) => budgetExtendCheck(context, input),
      },
      handler: (context, input) => completeExtend(deps(context), context, input),
    }),
    renew: defineMethod({
      action: 'compute:reservations:extend',
      kind: 'mutation',
      resource: reservationResource,
      validate: describedBy(schemas.reservation, parseReservation),
      handler: (context, input) =>
        renewReservation(deps(context), context.sql, input.tenantId, input.reservationId),
    }),
  };

  const quotas: CapacityApi['quotas'] = {
    get: defineMethod({
      action: 'compute:quotas:read',
      kind: 'read',
      resource: tenantResource,
      validate: describedBy(schemas.quotasGet, (raw) => {
        const input = object(raw, ['tenantId', 'poolId']);
        const result: TenantInput & { poolId?: string } = { tenantId: tenant(input.tenantId) };
        if (input.poolId !== undefined) result.poolId = id(input.poolId, 'pool', 'poolId');
        return result;
      }),
      handler: async (context, input) => ({
        items: await readQuotas(context.sql, input.tenantId, input.poolId),
      }),
    }),
    // A fleet operation (§9.2 `quotas:manage` @ fleet): set any tenant's limit on any pool.
    set: defineMethod({
      action: 'compute:quotas:manage',
      kind: 'mutation',
      resource: () => ({ type: 'fleet', id: fleetResourceId }),
      validate: describedBy(schemas.setQuota, parseSetQuota),
      handler: async (context, input) => {
        const tx = context.sql;
        const pool = await readPool(tx, input.poolId);
        if (!pool) throw new ComputeError('NOT_FOUND', `Pool ${input.poolId} not found`);
        await setQuota(tx, input.tenantId, input.poolId, input.resource, input.max);
        await context.events.publish(tx, {
          type: 'quota.updated',
          tenantId: input.tenantId,
          subject: `pool/${input.poolId}`,
          data: { resource: input.resource, max: input.max },
        });
        const rows = await readQuotas(tx, input.tenantId, input.poolId);
        return rows.find((row) => row.resource === input.resource)!;
      },
    }),
  };

  return { pools, capacity, reservations, quotas };
}

/**
 * The CapacityPort other modules book through (`context.capacity`): quota and placement together,
 * all-or-nothing. A request that does not fit gets its charge back and answers `pending`. A caller
 * booking inside a request's own transaction passes its `admission` (e.g. `instances.create`), so
 * scheduler plugins' `admit` hooks run; its own later retries pass none (§10.3).
 */
export function createCapacityPort(
  context: Pick<ModuleContext, 'clock'>,
  options: CapacityModuleOptions = {},
): CapacityPort & {
  reserve(
    tx: SqlTx,
    request: PlacementRequest,
    booking?: { admission?: AdmissionContext },
  ): Promise<PlacementOutcome>;
} {
  const placer = inlinePlacer({
    ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.onPlacement ? { onPlacement: options.onPlacement } : {}),
  });
  return {
    async reserve(
      tx: SqlTx,
      request: PlacementRequest,
      booking: { admission?: AdmissionContext } = {},
    ) {
      const demand = quotaDemand(request);
      await chargeQuota(tx, request.tenantId, request.poolId, demand);
      const outcome = await placer.place(tx, request, {
        clock: context.clock,
        random: options.random ?? Math.random,
        plugins: options.plugins ?? [],
        weights: options.weights ?? {},
        topN: options.topN ?? 5,
        ...(booking.admission ? { admission: booking.admission } : {}),
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
  const placers = placersFor(options);
  const reservationsReconciler: Reconciler = {
    name: reservationWork,
    shardBy: 'none',
    async run(context, key) {
      const deps = depsFrom(context, placers, options);
      await inTx(context, async (tx) => {
        const next = await reconcileReservation(deps, tx, key);
        if (next !== undefined)
          await context.work.enqueue(tx, reservationWork, key, { notBefore: next });
      });
      return 'DONE';
    },
  };
  // v0.4 pool-lease placer: one batch per pool key, by the worker owning the pool's shard.
  const indexes = new PoolIndexCache();
  const placerReconciler: Reconciler = {
    name: placerWork,
    shardBy: 'pool',
    // Placers scale apart from the controllers (§8.1): their own membership and shard leases.
    role: 'scheduler',
    async run(context, poolId) {
      const deps = depsFrom(context, placers, options);
      const { more, keep } = await inTx(context, (tx) =>
        placeQueued(deps, tx, poolId, {
          cache: indexes,
          ...(options.maxBatch ? { maxBatch: options.maxBatch } : {}),
        }),
      );
      // Committed: the index (with this batch's records) serves the next batch.
      keep?.();
      return more ? 'SYNC_AGAIN' : 'DONE';
    },
  };
  // §12.7: hourly usage windows for the IAM usage sink, which flushes hourly before closePeriod.
  const usageReconciler: Reconciler = {
    name: 'capacity.usage',
    shardBy: 'none',
    periodic: [{ key: 'all', every: options.usageEvery ?? '5m' }],
    async run(context) {
      await inTx(context, (tx) => meterReservations(tx, context.clock.now()));
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
    api: () => buildApi(options, placers),
    reconcilers: [
      reservationsReconciler,
      rollupReconciler,
      usageReconciler,
      { name: migGateWork, shardBy: 'node', run: runMigGate },
      ...(options.placer === 'pool-lease' ? [placerReconciler] : []),
    ],
    async nodeSpec(context, node) {
      const assignments = await deviceAssignments(context.sql, node.id);
      return { devices: { assignments } };
    },
    // §12.8: a deleted tenant's reservations end, offers to it and pools it owns are withdrawn.
    tenantDeleted: (context, tenantId) => capacityTenantDeleted(context, tenantId),
    async selfCheck(context) {
      const count = async (sql: string) =>
        Number((await context.sql.query<{ count: string | number }>(sql)).rows[0]?.count ?? 0);
      const findings: Finding[] = [];
      const stale = await count(
        `SELECT count(*) AS count FROM reservations
          WHERE state IN ('placed', 'binding', 'active') AND upper(during) < compute_now() - interval '10 minutes'`,
      );
      if (stale > 0)
        findings.push({
          check: 'capacity.reservations.stale',
          severity: 'warning',
          message: `${stale} reservations are past their end but not released`,
          fix: 'Check that a worker runs the capacity.reservations reconciler',
          count: stale,
        });
      const stuck = await count(
        `SELECT count(*) AS count FROM capacity_mig_layouts
          WHERE (pending_layout IS NOT NULL OR granted_generation IS NOT NULL)
            AND updated_at < compute_now() - interval '24 hours'`,
      );
      if (stuck > 0)
        findings.push({
          check: 'capacity.mig.stuck',
          severity: 'warning',
          message: `${stuck} nodes have waited over 24 h for a MIG layout change (booked GPUs, or a node that never converged)`,
          fix: 'Look at the nodes in capacity_mig_layouts: their GPUs stay held from the change time until the node converges',
          count: stuck,
        });
      const orphaned = await count(
        `SELECT count(*) AS count
           FROM nodes n JOIN pools p ON p.id = n.pool_id, unnest(n.no_schedule_reasons) AS r(reason)
          WHERE n.deleted_at IS NULL AND r.reason LIKE '${dedicatedTaintPrefix}%'
            AND substr(r.reason, ${dedicatedTaintPrefix.length + 1}) <> p.owner_tenant_id
            AND NOT EXISTS (SELECT 1 FROM pool_offers o
                             WHERE o.pool_id = p.id AND o.tenant_id = substr(r.reason, ${dedicatedTaintPrefix.length + 1}))`,
      );
      if (orphaned > 0)
        findings.push({
          check: 'capacity.dedicated.unoffered',
          severity: 'warning',
          message: `${orphaned} nodes are dedicated to a tenant their pool is not offered to: nobody can use them`,
          fix: 'Offer the pool to that tenant (pools.offer), or remove the dedicated=<tenant> taint',
          count: orphaned,
        });
      const drift = await count(
        `WITH agg AS (
           SELECT node_id, class, count(*) AS bookable, count(*) FILTER (WHERE healthy) AS healthy
             FROM devices WHERE bookable GROUP BY node_id, class)
         SELECT count(*) AS count
           FROM agg a FULL JOIN capacity_device_counts c ON c.node_id = a.node_id AND c.class = a.class
          WHERE COALESCE(a.bookable, 0) <> COALESCE(c.bookable, 0)
             OR COALESCE(a.healthy, 0) <> COALESCE(c.healthy, 0)`,
      );
      if (drift > 0)
        findings.push({
          check: 'capacity.device_counts.drift',
          severity: 'error',
          message: `${drift} node/class device counts disagree with the devices table; placement shortlists rank on them`,
          fix: 'Check the capacity_device_counts trigger on devices (capacity/0003); a TRUNCATE bypasses it',
          count: drift,
        });
      return findings;
    },
  });
}
