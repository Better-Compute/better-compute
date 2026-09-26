import {
  ComputeError,
  draftId,
  isComputeError,
  isId,
  newId,
  parseDuration,
  reservationStateTable,
  transition,
  type AdmissionPlan,
  type AuthzAttributes,
  type AuthzRow,
  type Clock,
  type Condition,
  type DeviceAssignment,
  type DeviceClass,
  type DeviceRequest,
  type EventPublisher,
  type GangSpec,
  type HoldBinding,
  type Json,
  type MethodContext,
  type ModuleContext,
  type NodeBindingSpec,
  type Operation,
  type PlacementContext,
  type Allocation,
  type PlacementOutcome,
  type PlacementRequest,
  type Placer,
  type Reservation,
  type ReservationResources,
  type ReservationSpec,
  type ReservationState,
  type ReservationVerb,
  type ResourceLimits,
  type SchedulerPlugin,
  type SqlTx,
  type TimeRange,
} from '@better-compute/core';
import {
  deferRelease,
  extendAllocation,
  readOwnerAllocations,
  releaseAllocation,
  type AllocationRecord,
} from './bookings.js';
import { chargeQuota, quotaDemand, refundQuota } from './quota.js';
import { formatCpuList, parseCpuList } from './cpulist.js';
import { defaultNodeReserve } from './host-resources.js';
import { dedicatedTaint, schedulableSqlTolerating } from './eligibility.js';
import { assertGang, planGangs } from './gang.js';
import { assertSelector } from './selector.js';
import {
  defaultSpotNoticeMs,
  planPreemption,
  readSpotAllocations,
  truncateAllocation,
} from './spot.js';
import { loadNodeViews, lockPool, readPool, readPoolNodes, type PoolRow } from './store.js';
import {
  archived,
  bulkCommittable,
  commitPlansBulk,
  observePlacement,
  placeFromIndexCounted,
  planOnIndex,
  type PlacementObserver,
} from './placer.js';
import { planPlacement, type NodePlan } from './pipeline.js';
import { PoolIndex, type PoolIndexCache } from './pool-index.js';
import {
  isTenantRootPool,
  leasableSqlFor,
  metalWork,
  nodeBindTimeoutMs,
  placeNodeLease,
} from './node-lease.js';

// Reservations (PLAN.md §3.4, §10.5): request-as-resource drafts decided by IAM, placed by the
// Placer in the second transaction, then driven by the `capacity.reservations` reconciler through
// start → binding → active → releasing → released. Quota is held from placement or pending until the
// reservation is terminal (D9).

/** The work-queue kind of the reservation lifecycle reconciler. */
export const reservationWork = 'capacity.reservations';

const tenantPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const keyPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const profilePattern = /^[A-Za-z0-9._:/-]{1,128}$/;
const deviceClasses: readonly DeviceClass[] = [
  'gpu',
  'gpu.mig',
  'gpu.slot',
  'nic.vf',
  'disk',
  'node',
];
const maxDuration = parseDuration('365d');
const hour = 3_600_000;

/** Validated `reservations.create` input, with the duration in milliseconds. */
export interface CreateReservationInput {
  tenantId: string;
  poolId: string;
  projectId?: string;
  devices: DeviceRequest[];
  topology?: 'any' | 'nvlink-all';
  start?: number;
  /** Milliseconds. */
  duration: number;
  /**
   * `hold` (default), `node` (v0.5: a whole node in a `tenantRoot` pool, deployed by metal) or
   * `kubernetes` (v1.1 §3.8: the devices are advertised to the node's kubelet; pools with
   * `policy.kubernetes`).
   */
  binding: 'hold' | 'node' | 'kubernetes';
  /** (v1.1 §3.8) Host CPU, memory and hugepages per node; absent: the pool's per-GPU share. */
  resources?: ReservationResources;
  /** `binding: 'node'`: the metal profile to deploy (required there, refused otherwise). */
  node?: NodeBindingSpec;
  leaseSeconds?: number;
  idempotencyKey: string;
  wait?: { timeoutMs: number };
  /** Book `gang.size` nodes, each taking `devices`, all or nothing (v0.5). */
  gang?: GangSpec;
  /** Preemptible (v0.5): billed at the spot meter; a non-spot request may take its atoms after a notice. */
  spot?: boolean;
}

function fail(message: string): never {
  throw new ComputeError('INVALID_INPUT', message);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`${what}: unknown field ${JSON.stringify(key)}`);
}

function string(value: unknown, pattern: RegExp, what: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${what} is invalid`);
  return value;
}

function integer(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    fail(`${what} must be an integer from ${min} to ${max}`);
  return value;
}

/** The host resources a reservation may book with its devices (§3.8), and each one's maximum. */
export const hostResourceLimits: Readonly<Record<string, number>> = Object.freeze({
  vcpu: 4096,
  memoryGiB: 65_536,
  hugepages1Gi: 4096,
});

/** Validates `reservations.create` input; rejects unknown fields and phases not yet delivered. */
export function parseCreateReservation(raw: unknown): CreateReservationInput {
  const input = record(raw, 'The request');
  onlyKeys(
    input,
    [
      'tenantId',
      'poolId',
      'projectId',
      'devices',
      'topology',
      'start',
      'duration',
      'binding',
      'node',
      'resources',
      'leaseSeconds',
      'spot',
      'idempotencyKey',
      'wait',
      'gang',
    ],
    'The request',
  );
  const tenantId = string(input.tenantId, tenantPattern, 'tenantId');
  const poolId = input.poolId;
  if (!isId(poolId, 'pool')) fail('poolId must be a pool id');
  if (!Array.isArray(input.devices) || input.devices.length === 0 || input.devices.length > 8)
    fail('devices must list 1 to 8 device requests');
  const devices = input.devices.map((entry, index) => {
    const device = record(entry, `devices[${index}]`);
    onlyKeys(device, ['class', 'count', 'selector', 'topology', 'sharing'], `devices[${index}]`);
    if (!deviceClasses.includes(device.class as DeviceClass))
      fail(`devices[${index}].class must be one of ${deviceClasses.join(', ')}`);
    const request: DeviceRequest = {
      class: device.class as DeviceClass,
      count: integer(device.count, 1, 64, `devices[${index}].count`),
    };
    if (device.selector !== undefined) {
      assertSelector(device.selector);
      request.selector = device.selector;
    }
    if (device.topology !== undefined) {
      if (device.topology !== 'any' && device.topology !== 'nvlink-all')
        fail(`devices[${index}].topology must be any or nvlink-all`);
      request.topology = device.topology;
    }
    if (device.sharing !== undefined) {
      if (!['exclusive', 'mig', 'timeslice', 'mps'].includes(device.sharing as string))
        fail(`devices[${index}].sharing must be exclusive, mig, timeslice or mps`);
      request.sharing = device.sharing as DeviceRequest['sharing'] & string;
    }
    return request;
  });
  if (devices.reduce((sum, device) => sum + device.count, 0) > 64)
    fail('A reservation books at most 64 devices');

  let duration: number;
  try {
    duration =
      typeof input.duration === 'string' || typeof input.duration === 'number'
        ? parseDuration(input.duration)
        : fail('duration is required, e.g. "8h"');
  } catch (error) {
    if (error instanceof ComputeError && error.code === 'INVALID_INPUT') throw error;
    fail('duration must look like 30m, 8h or 7d');
  }
  if (!(duration >= 60_000 && duration <= maxDuration))
    fail('duration must be between 1m and 365d');

  if (
    input.binding !== undefined &&
    input.binding !== 'hold' &&
    input.binding !== 'node' &&
    input.binding !== 'kubernetes'
  )
    throw new ComputeError(
      'UNSUPPORTED',
      `binding ${String(input.binding)} is not a reservation binding (instances: vps.instances.create)`,
    );
  const binding = input.binding === 'node' || input.binding === 'kubernetes' ? input.binding : 'hold';
  if (input.spot !== undefined && typeof input.spot !== 'boolean') fail('spot must be a boolean');
  if (binding === 'node' && input.spot === true) fail('A node binding cannot be spot');
  if ((binding === 'node') !== (input.node !== undefined))
    fail(binding === 'node' ? 'binding node needs node.profileId' : 'node needs binding node');

  const result: CreateReservationInput = {
    tenantId,
    poolId,
    devices,
    duration,
    binding,
    idempotencyKey: string(input.idempotencyKey, keyPattern, 'idempotencyKey'),
  };
  if (input.node !== undefined) {
    const node = record(input.node, 'node');
    onlyKeys(node, ['profileId', 'profileVersion'], 'node');
    result.node = { profileId: string(node.profileId, profilePattern, 'node.profileId') };
    if (node.profileVersion !== undefined)
      result.node.profileVersion = integer(node.profileVersion, 1, 2 ** 31, 'node.profileVersion');
  }
  if (input.resources !== undefined) {
    if (binding === 'node') fail('A node binding books the whole node; resources is refused');
    const resources = record(input.resources, 'resources');
    onlyKeys(resources, Object.keys(hostResourceLimits), 'resources');
    const parsed: ReservationResources = {};
    for (const [name, max] of Object.entries(hostResourceLimits))
      if (resources[name] !== undefined)
        parsed[name] = integer(resources[name], 0, max, `resources.${name}`);
    result.resources = parsed;
  }
  if (input.projectId !== undefined) {
    if (!isId(input.projectId, 'prj')) fail('projectId must be a project id');
    result.projectId = input.projectId;
  }
  if (input.topology !== undefined) {
    if (input.topology !== 'any' && input.topology !== 'nvlink-all')
      fail('topology must be any or nvlink-all');
    result.topology = input.topology;
  }
  if (input.start !== undefined) result.start = integer(input.start, 0, 2 ** 47, 'start');
  if (input.leaseSeconds !== undefined)
    result.leaseSeconds = integer(input.leaseSeconds, 30, 86_400, 'leaseSeconds');
  if (input.wait !== undefined) {
    const wait = record(input.wait, 'wait');
    onlyKeys(wait, ['timeoutMs'], 'wait');
    result.wait = { timeoutMs: integer(wait.timeoutMs, 0, 30_000, 'wait.timeoutMs') };
  }
  if (input.gang !== undefined) {
    assertGang(input.gang);
    result.gang = { size: input.gang.size };
    if (input.gang.topologyKey !== undefined) result.gang.topologyKey = input.gang.topologyKey;
  }
  if (input.spot === true) result.spot = true;
  return result;
}

/** What a reservation stores of its request. */
export function reservationSpec(input: CreateReservationInput): ReservationSpec {
  const spec: ReservationSpec = {
    poolId: input.poolId,
    devices: input.devices,
    duration: `${input.duration}ms`,
    binding: input.binding,
  };
  if (input.projectId !== undefined) spec.projectId = input.projectId;
  if (input.topology !== undefined) spec.topology = input.topology;
  if (input.start !== undefined) spec.start = input.start;
  if (input.leaseSeconds !== undefined) spec.leaseSeconds = input.leaseSeconds;
  if (input.gang !== undefined) spec.gang = { ...input.gang };
  if (input.spot === true) spec.spot = true;
  if (input.node !== undefined) spec.node = { ...input.node };
  if (input.resources !== undefined) spec.resources = { ...input.resources };
  return spec;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

/** Hex sha256 of the canonical request (idempotency: the same key must carry the same request). */
export async function requestHash(input: CreateReservationInput): Promise<string> {
  const { wait: _wait, idempotencyKey: _key, ...rest } = input;
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical(rest)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// --- Rows ------------------------------------------------------------------------------------------

interface RawReservation {
  id: string;
  tenant_id: string;
  pool_id: string;
  project_id: string | null;
  state: ReservationState;
  request: ReservationSpec | string;
  request_hash: string;
  start_ms: number | null;
  end_ms: number | null;
  owner_identity_id: string;
  agent_id: string | null;
  delegation_id: string | null;
  idempotency_key: string;
  lease_ms: number | null;
  conditions: Condition[] | string;
  version: string | number;
}

/** A stored reservation, with the columns the lifecycle needs. */
export interface ReservationRow extends Omit<Reservation, 'binding' | 'operation'> {
  requestHash: string;
}

const reservationColumns = `id, tenant_id, pool_id, project_id, state, request,
  encode(request_hash, 'hex') AS request_hash,
  (extract(epoch FROM lower(during)) * 1000)::float8 AS start_ms,
  (extract(epoch FROM upper(during)) * 1000)::float8 AS end_ms,
  owner_identity_id, agent_id, delegation_id, idempotency_key,
  (extract(epoch FROM lease_expires_at) * 1000)::float8 AS lease_ms, conditions, version`;

const json = <T>(value: T | string): T =>
  typeof value === 'string' ? (JSON.parse(value) as T) : value;

function toReservation(row: RawReservation): ReservationRow {
  const reservation: ReservationRow = {
    id: row.id,
    tenantId: row.tenant_id,
    poolId: row.pool_id,
    state: row.state,
    request: json(row.request),
    requestHash: row.request_hash,
    ownerIdentityId: row.owner_identity_id,
    idempotencyKey: row.idempotency_key,
    conditions: json(row.conditions) ?? [],
    version: Number(row.version),
  };
  if (row.project_id !== null) reservation.projectId = row.project_id;
  if (row.start_ms !== null && row.end_ms !== null)
    reservation.during = { start: Number(row.start_ms), end: Number(row.end_ms) };
  if (row.agent_id !== null) reservation.agentId = row.agent_id;
  if (row.delegation_id !== null) reservation.delegationId = row.delegation_id;
  if (row.lease_ms !== null) reservation.leaseExpiresAt = Number(row.lease_ms);
  return reservation;
}

/** One reservation in a tenant (`lock` takes `FOR UPDATE`). */
export async function readReservation(
  tx: SqlTx,
  tenantId: string,
  id: string,
  options: { lock?: boolean } = {},
): Promise<ReservationRow | undefined> {
  const { rows } = await tx.query<RawReservation>(
    `SELECT ${reservationColumns} FROM reservations WHERE id = $1 AND tenant_id = $2${
      options.lock ? ' FOR UPDATE' : ''
    }`,
    [id, tenantId],
  );
  return rows[0] ? toReservation(rows[0]) : undefined;
}

/**
 * A tenant's reservations in `states` created by `by` (an identity as owner, an agent, or a
 * delegation), oldest first, locked `FOR UPDATE` in id order: what an IAM reaction (an agent
 * suspended, an owner offboarded) walks. `by: {}` selects the tenant's in `states`.
 */
export async function readReservationsBy(
  tx: SqlTx,
  tenantId: string,
  states: readonly ReservationState[],
  by: { ownerIdentityId?: string; agentId?: string; delegationId?: string; anyAgent?: boolean },
): Promise<ReservationRow[]> {
  const { rows } = await tx.query<RawReservation>(
    `SELECT ${reservationColumns} FROM reservations
      WHERE tenant_id = $1 AND state = ANY($2::text[])
        AND ($3::text IS NULL OR owner_identity_id = $3)
        AND ($4::text IS NULL OR agent_id = $4)
        AND ($5::text IS NULL OR delegation_id = $5)
        AND (NOT $6 OR agent_id IS NOT NULL)
      ORDER BY id FOR UPDATE`,
    [
      tenantId,
      [...states],
      by.ownerIdentityId ?? null,
      by.agentId ?? null,
      by.delegationId ?? null,
      by.anyAgent === true,
    ],
  );
  return rows.map(toReservation);
}

async function readReservationById(
  tx: SqlTx,
  id: string,
  lock: boolean,
): Promise<ReservationRow | undefined> {
  const { rows } = await tx.query<RawReservation>(
    `SELECT ${reservationColumns} FROM reservations WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ? toReservation(rows[0]) : undefined;
}

/**
 * The async operation behind a reservation (§9.1 async-with-wait), the same under both placers:
 * - `running`: queued for its pool-lease batch, the only state worth waiting on;
 * - `pending`: not placeable now (`Unschedulable`, retried every 30 s) or awaiting a person;
 * - `succeeded`: placed, and everything after it;
 * - `failed`: failed, denied, cancelled or expired, with the reason.
 * A `wait` stops as soon as the state is not `running`, so an inline create (placed or
 * Unschedulable at once) and a pool-lease create answer a waiting client alike.
 */
export function reservationOperation(
  row: Pick<ReservationRow, 'id' | 'state' | 'conditions'>,
): Operation {
  const id = row.id;
  const condition = (type: string) => row.conditions.find((entry) => entry.type === type);
  switch (row.state) {
    case 'draft':
      return { id, state: 'running' };
    case 'pending':
      return { id, state: condition('Queued') ? 'running' : 'pending' };
    case 'awaiting-confirmation':
      return { id, state: 'pending' };
    case 'placed':
    case 'binding':
    case 'active':
    case 'releasing':
    case 'released':
      return { id, state: 'succeeded' };
    case 'failed': {
      const why = condition('Unschedulable') ?? condition('BindTimeout');
      return {
        id,
        state: 'failed',
        error: { code: 'CAPACITY_UNAVAILABLE', message: why?.message ?? why?.reason ?? 'failed' },
      };
    }
    case 'denied':
      return { id, state: 'failed', error: { code: 'ACCESS_DENIED', message: 'Access denied' } };
    case 'cancelled':
      return { id, state: 'failed', error: { code: 'INVALID_STATE', message: 'cancelled' } };
    case 'expired':
      return {
        id,
        state: 'failed',
        error: { code: 'INVALID_STATE', message: 'the confirmation request expired' },
      };
  }
}

/** The public view: the row plus the `hold` binding once a node reported it, and its operation. */
export async function reservationView(tx: SqlTx, row: ReservationRow): Promise<Reservation> {
  const { requestHash: _hash, ...reservation } = row;
  const view: Reservation = { ...reservation, operation: reservationOperation(row) };
  if (row.state === 'active' || row.state === 'binding') {
    const { rows } = await tx.query<{ node_id: string; binding: Json | string | null }>(
      `SELECT node_id, binding FROM allocations
        WHERE owner_kind = 'reservation' AND owner_id = $1 AND released_at IS NULL
          AND bound_at IS NOT NULL AND NOT binding ? 'lost' ORDER BY id LIMIT 1`,
      [row.id],
    );
    const bound = rows[0];
    if (bound) {
      const binding = json(bound.binding) as {
        cdiDevices?: string[];
        envFile?: string;
        cgroupParent?: string;
      } | null;
      const hold: HoldBinding = {
        nodeId: bound.node_id,
        cdiDevices: binding?.cdiDevices ?? [],
        envFile: binding?.envFile ?? '',
      };
      if (typeof binding?.cgroupParent === 'string' && binding.cgroupParent !== '')
        hold.cgroupParent = binding.cgroupParent;
      view.binding = hold;
    }
  }
  // A released Kubernetes binding whose pods still hold the devices (deferRelease): booked and billed
  // until its node reports them free, which the tenant should see.
  if (row.state === 'released' && row.request.binding === 'kubernetes') {
    const { rows } = await tx.query<{ node_id: string; since: number | string }>(
      `SELECT node_id, (binding->>'releasing')::float8 AS since FROM allocations
        WHERE owner_kind = 'reservation' AND owner_id = $1 AND released_at IS NULL
          AND binding ? 'releasing' ORDER BY id`,
      [row.id],
    );
    if (rows.length > 0)
      view.conditions = [
        ...row.conditions.filter((entry) => entry.type !== 'DevicesHeld'),
        {
          type: 'DevicesHeld',
          status: 'true',
          reason: 'PodsHoldDevices',
          message: `pods on ${[...new Set(rows.map((entry) => entry.node_id))].join(', ')} still hold the devices; they stay booked and billed until the node reports them free`,
          since: Math.min(...rows.map((entry) => Number(entry.since))),
        },
      ];
  }
  return view;
}

/** Moves a reservation along the §10.5 table with a version-guarded update. */
async function move(
  tx: SqlTx,
  row: ReservationRow,
  verb: ReservationVerb,
  sets: {
    during?: TimeRange | null;
    conditions?: Condition[];
    leaseExpiresAt?: number | null;
  } = {},
  to?: ReservationState,
): Promise<ReservationRow> {
  const next = transition(reservationStateTable, row.state, verb, to);
  const assignments = ['state = $3', 'version = version + 1'];
  const params: unknown[] = [row.id, row.version, next];
  if (sets.during !== undefined) {
    if (sets.during === null) assignments.push('during = NULL');
    else {
      params.push(
        new Date(sets.during.start).toISOString(),
        new Date(sets.during.end).toISOString(),
      );
      assignments.push(
        `during = tstzrange($${params.length - 1}::timestamptz, $${params.length}::timestamptz)`,
      );
    }
  }
  if (sets.conditions !== undefined) {
    params.push(JSON.stringify(sets.conditions));
    assignments.push(`conditions = $${params.length}::jsonb`);
  }
  if (sets.leaseExpiresAt !== undefined) {
    if (sets.leaseExpiresAt === null) assignments.push('lease_expires_at = NULL');
    else {
      params.push(new Date(sets.leaseExpiresAt).toISOString());
      assignments.push(`lease_expires_at = $${params.length}::timestamptz`);
    }
  }
  const { rowCount } = await tx.query(
    `UPDATE reservations SET ${assignments.join(', ')} WHERE id = $1 AND version = $2`,
    params,
  );
  if (rowCount === 0)
    throw new ComputeError('CONFLICT', `Reservation ${row.id} changed concurrently; retry`);
  const updated: ReservationRow = {
    ...row,
    state: next,
    version: row.version + 1,
  };
  if (sets.during === null) delete updated.during;
  else if (sets.during) updated.during = { ...sets.during };
  if (sets.conditions) updated.conditions = sets.conditions;
  if (sets.leaseExpiresAt === null) delete updated.leaseExpiresAt;
  else if (sets.leaseExpiresAt !== undefined) updated.leaseExpiresAt = sets.leaseExpiresAt;
  return updated;
}

function withCondition(
  conditions: readonly Condition[],
  condition: Omit<Condition, 'since'>,
  now: number,
): Condition[] {
  const previous = conditions.find((entry) => entry.type === condition.type);
  const since = previous && previous.status === condition.status ? previous.since : now;
  const next: Condition = { ...condition, since };
  return [...conditions.filter((entry) => entry.type !== condition.type), next];
}

function withoutCondition(conditions: readonly Condition[], type: string): Condition[] {
  return conditions.filter((entry) => entry.type !== type);
}

// --- Pools as a tenant sees them -------------------------------------------------------------------

/** A pool the tenant owns or was offered, with its site region; `undefined` otherwise. */
export async function visiblePool(
  tx: SqlTx,
  tenantId: string,
  poolId: string,
): Promise<
  | {
      id: string;
      ownerTenantId: string;
      gpuModel?: string;
      region: string;
      policy: Json;
      sharing: string;
    }
  | undefined
> {
  const { rows } = await tx.query<{
    id: string;
    owner_tenant_id: string;
    gpu_model: string | null;
    region: string;
    policy: Json | string;
    sharing: string;
  }>(
    `SELECT p.id, p.owner_tenant_id, p.gpu_model, s.region, p.policy, p.sharing
       FROM pools p JOIN sites s ON s.id = p.site_id
      WHERE p.id = $1 AND (p.owner_tenant_id = $2
            OR EXISTS (SELECT 1 FROM pool_offers o WHERE o.pool_id = p.id AND o.tenant_id = $2))
        AND p.archived_at IS NULL`,
    [poolId, tenantId],
  );
  const row = rows[0];
  if (!row) return undefined;
  const pool: {
    id: string;
    ownerTenantId: string;
    gpuModel?: string;
    region: string;
    policy: Json;
    sharing: string;
  } = {
    id: row.id,
    ownerTenantId: row.owner_tenant_id,
    region: row.region,
    policy: json(row.policy),
    sharing: row.sharing,
  };
  if (row.gpu_model !== null) pool.gpuModel = row.gpu_model;
  return pool;
}

/** Whole GPUs a request books (`gpuCount` in policies). */
export function wholeGpus(devices: readonly DeviceRequest[]): number {
  return devices.filter((device) => device.class === 'gpu').reduce((sum, d) => sum + d.count, 0);
}

/** Whether a pool's hosts join a Kubernetes cluster (`policy.kubernetes`, §3.8). */
export function isKubernetesPool(pool: { policy?: unknown }): boolean {
  const kubernetes = policyObject(pool.policy)?.kubernetes;
  return typeof kubernetes === 'object' && kubernetes !== null && !Array.isArray(kubernetes);
}

function policyObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * How many GPUs' worth a request books (§3.8): its whole GPUs, plus each MIG instance or slot as
 * its fraction of a GPU (MIG: 1/7; time-slice/MPS: 1/`policy.sharing.replicas`, default 4 or 10),
 * so fractional work also carries (and is limited to) its share of the host.
 */
export function gpuEquivalent(
  devices: readonly DeviceRequest[],
  pool: { sharing?: string; policy?: unknown },
): number {
  const replicas = policyObject(policyObject(pool.policy)?.sharing)?.replicas;
  const perGpu =
    pool.sharing === 'mig'
      ? 7
      : typeof replicas === 'number' && replicas >= 1
        ? Math.floor(replicas)
        : pool.sharing === 'mps'
          ? 10
          : 4;
  return wholeGpus(devices) + gpuSlices(devices) / perGpu;
}

/**
 * The host CPU and memory a reservation books per node for `gpus` GPUs' worth (`gpuEquivalent`),
 * §3.8: `policy.perGpu`'s values, else the smallest per-GPU share among the pool's GPU hosts
 * (`floor(allocatable × ratio ÷ physical GPUs)`), so the share fits on every host. Hosts without
 * the rows book none.
 */
export async function perGpuShare(
  tx: Pick<SqlTx, 'query'>,
  pool: { id: string; policy?: unknown },
  gpus: number,
): Promise<ReservationResources> {
  if (!(gpus > 0)) return {};
  const perGpu = policyObject(policyObject(pool.policy)?.perGpu);
  const share: ReservationResources = {};
  const derived: string[] = [];
  for (const name of ['vcpu', 'memoryGiB']) {
    const value = perGpu?.[name];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
      share[name] = Math.floor(value * gpus);
    else derived.push(name);
  }
  if (derived.length > 0) {
    // Physical GPUs, bookable or not: a shared pool's GPUs are its slices' parents.
    const { rows } = await tx.query<{ resource: string; share: string }>(
      `SELECT nr.resource, min(nr.allocatable * nr.ratio / g.gpus)::text AS share
         FROM nodes n
         JOIN (SELECT node_id, count(*) AS gpus FROM devices
                WHERE class = 'gpu' AND parent_id IS NULL GROUP BY node_id) g
           ON g.node_id = n.id
         JOIN node_resources nr ON nr.node_id = n.id AND nr.resource = ANY($2::text[])
        WHERE n.pool_id = $1 AND n.deleted_at IS NULL
        GROUP BY nr.resource`,
      [pool.id, derived],
    );
    for (const row of rows) share[row.resource] = Math.floor(Number(row.share) * gpus);
  }
  for (const [name, amount] of Object.entries(share))
    if (amount > 0) share[name] = Math.min(amount, hostResourceLimits[name] ?? 0);
    else delete share[name];
  return share;
}

/** MIG instances and time-slice/MPS slots a request books (`gpuSlices` in policies). */
export function gpuSlices(devices: readonly DeviceRequest[]): number {
  return devices
    .filter((device) => device.class === 'gpu.mig' || device.class === 'gpu.slot')
    .reduce((sum, d) => sum + d.count, 0);
}

/**
 * Whether a request fits a pool's sharing mode (§10.6): slots only in `timeslice`/`mps` pools, MIG
 * instances only in `mig` pools, and a device's explicit `sharing` must be the pool's.
 */
export function assertSharingFits(devices: readonly DeviceRequest[], poolSharing: string): void {
  devices.forEach((device, index) => {
    if (device.class === 'gpu.slot' && poolSharing !== 'timeslice' && poolSharing !== 'mps')
      fail(`devices[${index}]: gpu.slot atoms exist only in timeslice or mps pools`);
    if (device.class === 'gpu.mig' && poolSharing !== 'mig')
      fail(`devices[${index}]: gpu.mig atoms exist only in mig pools`);
    if (
      device.sharing !== undefined &&
      device.sharing !== 'exclusive' &&
      device.sharing !== poolSharing
    )
      fail(`devices[${index}]: the pool shares GPUs as ${poolSharing}, not ${device.sharing}`);
  });
}

/** The attributes IAM policies read on a reservation (§12.3), e.g. `ReserveBoundedH100`. */
export function reservationAttributes(
  spec: ReservationSpec,
  pool: { gpuModel?: string; region: string },
  durationMs: number,
): AuthzAttributes {
  const attributes: AuthzAttributes = {
    gpuModel: pool.gpuModel ?? 'other',
    gpuCount: wholeGpus(spec.devices) * (spec.gang?.size ?? 1),
    gpuSlices: gpuSlices(spec.devices) * (spec.gang?.size ?? 1),
    gangSize: spec.gang?.size ?? 1,
    durationHours: Math.round((durationMs / hour) * 1000) / 1000,
    region: pool.region,
    binding: spec.binding ?? 'hold',
    spot: spec.spot ?? false,
    renewable: spec.leaseSeconds !== undefined,
    // (§3.8) The host CPU and memory it books, over every node of a gang, for policies to bound.
    vcpu: (spec.resources?.vcpu ?? 0) * (spec.gang?.size ?? 1),
    memoryGiB: (spec.resources?.memoryGiB ?? 0) * (spec.gang?.size ?? 1),
  };
  if (spec.projectId !== undefined) attributes.projectId = spec.projectId;
  return attributes;
}

// --- Services ----------------------------------------------------------------------------------

/** What the reservation services need beyond a transaction. */
export interface ReservationDeps {
  clock: Clock;
  events: EventPublisher;
  work: ModuleContext['work'];
  authz: ModuleContext['authz'];
  desired: ModuleContext['desired'];
  placer: Placer;
  /**
   * A placer that answers at once, for placements that cannot wait for a batch (BookingRepair,
   * preemption). Defaults to `placer`; a queuing `placer` must come with one.
   */
  inline?: Placer;
  placement: Omit<PlacementContext, 'clock' | 'admission'>;
  /** The notice a preempted spot reservation gets (default `defaultSpotNoticeMs`, 2 min). */
  spotNoticeMs?: number;
  /** Verifies node-signed `AllocationBound` reports before a binding counts (see `verifyBindings`). */
  attestedBindings?: AllocationBindingCheck;
  /** The pool-lease batch reports each reservation's placement here (§14 metrics). */
  onPlacement?: PlacementObserver;
}

/** Scheduler plugins, weights, top-N and randomness for the placer. */
export interface PlacementOptions {
  plugins?: readonly SchedulerPlugin[];
  weights?: Readonly<Record<string, number>>;
  topN?: number;
  random?: () => number;
}

async function publish(
  deps: Pick<ReservationDeps, 'events'>,
  tx: SqlTx,
  row: ReservationRow,
  type: string,
  data: Record<string, Json> = {},
): Promise<void> {
  await deps.events.publish(tx, {
    type,
    tenantId: row.tenantId,
    subject: `reservation/${row.id}`,
    data: { state: row.state, poolId: row.poolId, ...data },
  });
}

/**
 * `reservations.create` transaction 1 (§3.4 steps 4–5): the idempotency lookup, the draft row and
 * its authz projection row. Returns what the envelope decides on.
 */
export async function prepareCreate(
  context: MethodContext,
  input: CreateReservationInput,
  tx: SqlTx,
): Promise<AdmissionPlan<Reservation>> {
  const caller = context.caller;
  if (!caller) throw new ComputeError('UNAUTHENTICATED', 'A caller is required');
  const hash = await requestHash(input);
  const { rows } = await tx.query<RawReservation>(
    `SELECT ${reservationColumns} FROM reservations
      WHERE tenant_id = $1 AND owner_identity_id = $2 AND idempotency_key = $3 FOR UPDATE`,
    [input.tenantId, caller.identityId, input.idempotencyKey],
  );
  const existing = rows[0] ? toReservation(rows[0]) : undefined;
  if (existing && existing.requestHash !== hash)
    throw new ComputeError(
      'CONFLICT',
      'This idempotency key was used for a different request',
      undefined,
      { reservationId: existing.id },
    );
  if (existing?.state === 'denied') throw new ComputeError('ACCESS_DENIED', 'Access denied');
  // §3.4 step 7: the agent retries with the same key after a human approved; the approval is keyed
  // by (action, type, id), so the retry is decided afresh on the same draft.
  let draft = existing;
  if (draft?.state === 'awaiting-confirmation') {
    const expiresAt = confirmationExpiry(draft);
    // A retry after the deadline finds the request expired (terminal): it replays as such.
    if (expiresAt !== undefined && expiresAt <= context.clock.now())
      return {
        status: 'replay',
        result: await reservationView(tx, await move(tx, draft, 'expire')),
      };
    draft = await move(tx, draft, 'retry', {
      conditions: withoutCondition(draft.conditions, 'ConfirmationRequired'),
    });
  }
  if (draft && draft.state !== 'draft')
    return { status: 'replay', result: await reservationView(tx, draft) };

  const pool = await visiblePool(tx, input.tenantId, input.poolId);
  if (!pool) throw new ComputeError('NOT_FOUND', `Pool ${input.poolId} not found`);
  assertSharingFits(input.devices, pool.sharing);
  if (input.binding === 'node' && !isTenantRootPool(pool))
    fail(`Pool ${pool.id} does not lease whole nodes (policy.tenantRoot)`);
  if (input.binding === 'kubernetes' && !isKubernetesPool(pool))
    fail(`Pool ${pool.id} does not join a Kubernetes cluster (policy.kubernetes)`);
  // The kubelet hands bound GPUs to any pod of the cluster that asks: the device plugin and DRA
  // cannot tell tenants apart. So a pool's cluster is its owner's, and only the owner books GPUs
  // into it (round-5 review 2, M5); tenants it is offered to use holds or instances.
  if (input.binding === 'kubernetes' && pool.ownerTenantId !== input.tenantId)
    fail(`Pool ${pool.id}'s Kubernetes cluster is its owner's: only the owner books binding kubernetes`);
  const id =
    existing?.id ?? (await draftId('rsv', input.tenantId, caller.identityId, input.idempotencyKey));
  // A retried draft keeps what it resolved the first time (its share may have moved since).
  let spec: ReservationSpec;
  if (existing) spec = existing.request;
  else {
    spec = reservationSpec(input);
    if (input.binding !== 'node') {
      const share = await perGpuShare(tx, pool, gpuEquivalent(input.devices, pool));
      const resources = hostResources(input.resources, share);
      if (Object.keys(resources).length > 0) spec.resources = resources;
      else delete spec.resources;
      // Always recorded, `{}` included (MIG/slot requests, pools with no share): its presence is
      // what makes everything above it chargeable (review 2 found M8 open without it).
      spec.hostShare = share;
    }
  }
  if (!existing)
    await tx.query(
      `INSERT INTO reservations (id, tenant_id, pool_id, project_id, state, request, request_hash,
                                 owner_identity_id, agent_id, delegation_id, idempotency_key, version)
       VALUES ($1, $2, $3, $4, 'draft', $5::jsonb, decode($6, 'hex'), $7, $8, $9, $10, 1)`,
      [
        id,
        input.tenantId,
        input.poolId,
        input.projectId ?? null,
        JSON.stringify(spec),
        hash,
        caller.identityId,
        caller.agentId ?? null,
        caller.delegationId ?? null,
        input.idempotencyKey,
      ],
    );
  const row = {
    type: 'reservation',
    id,
    tenantId: input.tenantId,
    attributes: reservationAttributes(spec, pool, input.duration),
    parentType: 'pool',
    parentId: input.poolId,
    ownerId: caller.identityId,
  };
  await context.authz.upsert(tx, row);
  return { status: 'decide', resource: { type: 'reservation', id } };
}

/**
 * The admission's budget check (`MethodAdmission.check`: after the IAM decision, no transaction
 * open). It runs when the pool asks for it (`policy.admission.budgetCheck: 'meter'`) or when the
 * tenant's offer reacts to a spent budget by stopping new work (`onBudgetExceeded: 'stop-new' |
 * 'drain'`, §12.8), and calls `iam.billingCheck` for the caller. A spent budget refuses with
 * `SPEND_LIMIT_REACHED`; the draft stays, so the same key re-decides once the budget's window
 * resets.
 */
export async function budgetAdmissionCheck(
  context: MethodContext,
  tenantId: string,
  poolId: string,
): Promise<void> {
  const { rows } = await context.sql.query<{
    budget_check: string | null;
    on_budget_exceeded: string | null;
  }>(
    `SELECT p.policy->'admission'->>'budgetCheck' AS budget_check,
            (SELECT o.on_budget_exceeded FROM pool_offers o
              WHERE o.pool_id = p.id AND o.tenant_id = $2) AS on_budget_exceeded
       FROM pools p WHERE p.id = $1`,
    [poolId, tenantId],
  );
  const row = rows[0];
  if (!row) return;
  const wanted =
    row.budget_check === 'meter' ||
    row.on_budget_exceeded === 'stop-new' ||
    row.on_budget_exceeded === 'drain';
  if (!wanted) return;
  const check = await context.iam.billingCheck(
    { tenantId, ...(context.caller ? { identityId: context.caller.identityId } : {}) },
    context.credential,
  );
  if (check.allowed) return;
  const budget = check.blockedBy;
  throw new ComputeError(
    'SPEND_LIMIT_REACHED',
    budget ? `Budget ${budget.name} is spent` : 'A budget covering this request is spent',
    undefined,
    budget ? { budgetId: budget.budgetId, name: budget.name } : {},
  );
}

/** `budgetAdmissionCheck` for `reservations.extend`: a refusal also clears the pending change. */
export async function budgetExtendCheck(
  context: MethodContext,
  input: ExtendReservationInput,
): Promise<void> {
  const { rows } = await context.sql.query<{ pool_id: string }>(
    `SELECT pool_id FROM reservations WHERE id = $1 AND tenant_id = $2`,
    [input.reservationId, input.tenantId],
  );
  if (!rows[0]) return;
  try {
    await budgetAdmissionCheck(context, input.tenantId, rows[0].pool_id);
  } catch (error) {
    await context.sql.transaction((tx) => denyPending(context, input, tx));
    throw error;
  }
}

/** How long a delegated request may wait for a human (§3.4 step 7: ≤30 min). */
export const maxConfirmationMs = 30 * 60_000;

/** The confirmation deadline recorded on an awaiting-confirmation reservation. */
export function confirmationExpiry(row: Pick<ReservationRow, 'conditions'>): number | undefined {
  const condition = row.conditions.find((entry) => entry.type === 'ConfirmationRequired');
  const expiresAt = Number(condition?.message);
  return Number.isFinite(expiresAt) ? expiresAt : undefined;
}

/**
 * `reservations.create` after a refusal. A delegated deny that IAM turned into a confirmation
 * request (`CONFIRMATION_REQUIRED`, §3.4 step 7) parks the draft in `awaiting-confirmation`, with
 * the confirmation id and its deadline (≤30 min) in the `ConfirmationRequired` condition, and wakes
 * the lifecycle at the deadline. Any other refusal makes the draft `denied` (GC after 24 h).
 */
export async function denyCreate(
  context: MethodContext,
  input: CreateReservationInput,
  tx: SqlTx,
  error?: unknown,
): Promise<void> {
  const caller = context.caller;
  if (!caller) return;
  const id = await draftId('rsv', input.tenantId, caller.identityId, input.idempotencyKey);
  const row = await readReservation(tx, input.tenantId, id, { lock: true });
  if (row?.state !== 'draft') return;
  const details = isComputeError(error, 'CONFIRMATION_REQUIRED') ? error.details : undefined;
  const confirmationId = details?.confirmationId;
  if (typeof confirmationId !== 'string' || confirmationId === '') {
    await move(tx, row, 'deny');
    return;
  }
  const now = context.clock.now();
  const requested = Number(details?.expiresAt);
  const expiresAt = Math.min(
    Number.isFinite(requested) && requested > now ? requested : now + maxConfirmationMs,
    now + maxConfirmationMs,
  );
  const awaiting = await move(tx, row, 'awaitConfirmation', {
    conditions: withCondition(
      row.conditions,
      {
        type: 'ConfirmationRequired',
        status: 'true',
        reason: confirmationId,
        message: String(expiresAt),
      },
      now,
    ),
  });
  await context.work.enqueue(tx, reservationWork, id, { notBefore: expiresAt });
  await context.events.publish(tx, {
    type: 'reservation.awaiting-confirmation',
    tenantId: awaiting.tenantId,
    subject: `reservation/${id}`,
    data: { state: awaiting.state, poolId: awaiting.poolId, confirmationId, expiresAt },
  });
}

/**
 * bcd capabilities (Hello, as `bc.dev/cap.<name>` system labels) a reservation's node must have:
 * an older bcd drops DeviceAssignment.limits and Binding.KUBERNETES as unknown, so a workload would
 * run without its host limits, or its GPUs never reach the kubelet (§3.8, N−2 skew).
 */
export const deviceLimitsCapabilityLabel = 'bc.dev/cap.devices.limits';
export const kubernetesBindingCapabilityLabel = 'bc.dev/cap.binding.kubernetes';

export function requiredCapabilities(request: {
  binding?: string;
  resources?: Readonly<Record<string, number>>;
}): Record<string, string> | undefined {
  if (request.binding === 'node') return undefined;
  const labels: Record<string, string> = {};
  if (request.resources && Object.values(request.resources).some((amount) => amount > 0))
    labels[deviceLimitsCapabilityLabel] = '*';
  if (request.binding === 'kubernetes') labels[kubernetesBindingCapabilityLabel] = '*';
  return Object.keys(labels).length > 0 ? labels : undefined;
}

function placementRequest(row: ReservationRow, during: TimeRange) {
  const nodeLabels = requiredCapabilities(row.request);
  return {
    tenantId: row.tenantId,
    poolId: row.poolId,
    ...(row.projectId !== undefined ? { projectId: row.projectId } : {}),
    reservationId: row.id,
    devices: row.request.devices,
    ...(row.request.resources !== undefined && !isNodeBinding(row)
      ? { resources: row.request.resources }
      : {}),
    ...(nodeLabels ? { nodeLabels } : {}),
    ...(row.request.topology !== undefined ? { topology: row.request.topology } : {}),
    ...(row.request.gang !== undefined ? { gang: row.request.gang } : {}),
    during,
  };
}

/**
 * What a reservation charges to quota: its devices, plus the host resources it books above the
 * share its GPUs carry (`hostShare`, §3.8). The share needs no quota row (an offer names device
 * classes); anything more is charged as `vcpu`/`memoryGiB` (hugepages as memory), and a missing row
 * grants 0, so a tenant can't take a host's CPUs and memory with one GPU's quota. A reservation
 * made before `hostShare` existed charges its devices only.
 */
export function reservationDemand(request: ReservationSpec): Record<string, number> {
  const excess: Record<string, number> = {};
  if (request.hostShare !== undefined)
    for (const [name, amount] of Object.entries(request.resources ?? {})) {
      const over = amount - (request.hostShare[name] ?? 0);
      if (over > 0) excess[name] = over;
    }
  return quotaDemand({
    devices: request.devices,
    resources: excess,
    ...(request.gang !== undefined ? { gang: request.gang } : {}),
  });
}

/**
 * The host resources a reservation books (§3.8): what it asked for, never below its GPUs' share, so
 * `resources: {}` cannot book GPUs whose workloads then run without limits.
 */
export function hostResources(
  requested: Readonly<ReservationResources> | undefined,
  share: Readonly<ReservationResources>,
): ReservationResources {
  const resources: ReservationResources = { ...requested };
  for (const [name, amount] of Object.entries(share))
    resources[name] = Math.max(resources[name] ?? 0, amount);
  for (const [name, amount] of Object.entries(resources)) if (!(amount > 0)) delete resources[name];
  return resources;
}

function requestedDuration(row: ReservationRow): number {
  return parseDuration(row.request.duration);
}

/**
 * Places a draft or pending reservation now; `placed` or `pending` (with `Unschedulable`).
 *
 * Scheduler plugins' `admit` hooks run with `admission` — the caller's decision, present only in
 * the request's own transaction (create). Re-placements the system makes of an admitted reservation
 * (pending retries, BookingRepair, bind-timeout re-places, preemption) carry no caller and do not
 * re-admit: filters and scorers still apply to every attempt.
 */
async function attemptPlacement(
  deps: ReservationDeps,
  tx: SqlTx,
  row: ReservationRow,
  admission?: MethodContext['admission'],
): Promise<ReservationRow> {
  const now = deps.clock.now();
  const start = Math.max(row.request.start ?? now, now);
  let during = { start, end: start + requestedDuration(row) };
  const nodeLease = isNodeBinding(row);
  // Node leases do not go through a placer, so their admission hooks run here.
  if (nodeLease && admission)
    for (const plugin of deps.placement.plugins)
      await plugin.admit?.(placementRequest(row, during), admission);
  let outcome = nodeLease
    ? await placeNodeLease(tx, placementRequest(row, during), deps.placement)
    : await deps.placer.place(tx, placementRequest(row, during), {
        ...deps.placement,
        clock: deps.clock,
        ...(admission ? { admission } : {}),
      });
  if (outcome.status === 'pending' && row.request.spot !== true && !nodeLease) {
    const preempted = await preemptFor(deps, tx, row, during);
    if (preempted) ({ outcome, during } = preempted);
  }
  return settlePlacement(deps, tx, row, during, outcome);
}

/** Records a placement outcome on the reservation: `placed`, `pending` (Unschedulable) or `queued`. */
async function settlePlacement(
  deps: ReservationDeps,
  tx: SqlTx,
  row: ReservationRow,
  during: TimeRange,
  outcome: PlacementOutcome,
): Promise<ReservationRow> {
  const now = deps.clock.now();
  if (outcome.status === 'placed') {
    const conditions = withoutCondition(
      withoutCondition(row.conditions, 'Unschedulable'),
      'Queued',
    );
    const lease =
      row.request.leaseSeconds !== undefined ? now + row.request.leaseSeconds * 1000 : undefined;
    const placed = await move(tx, row, 'place', {
      during,
      conditions,
      ...(lease !== undefined ? { leaseExpiresAt: lease } : {}),
    });
    await deps.work.enqueue(tx, reservationWork, row.id, { notBefore: during.start });
    await publish(deps, tx, placed, 'reservation.placed', {
      nodeIds: outcome.allocations.map((allocation) => allocation.nodeId),
      start: during.start,
      end: during.end,
    });
    return placed;
  }
  // Queued: the pool's batch worker places it; the 30 s retry below re-queues it if that is lost.
  const queued = outcome.status === 'queued';
  if (queued) await deps.work.enqueue(tx, placerWork, row.poolId);
  const reason = outcome.status === 'pending' ? outcome.reason : 'queued for the pool placer';
  const conditions = queued
    ? withCondition(
        row.conditions,
        { type: 'Queued', status: 'true', reason: 'PoolPlacer', message: reason },
        now,
      )
    : withCondition(
        withoutCondition(row.conditions, 'Queued'),
        { type: 'Unschedulable', status: 'true', reason: 'NoFit', message: reason },
        now,
      );
  if (row.state === 'pending') {
    const { rowCount } = await tx.query(
      `UPDATE reservations SET conditions = $3::jsonb, version = version + 1
        WHERE id = $1 AND version = $2`,
      [row.id, row.version, JSON.stringify(conditions)],
    );
    if (rowCount === 0)
      throw new ComputeError('CONFLICT', `Reservation ${row.id} changed concurrently`);
    await deps.work.enqueue(tx, reservationWork, row.id, { notBefore: now + pendingRetryMs });
    return { ...row, conditions, version: row.version + 1 };
  }
  const pending = await move(tx, row, 'defer', { conditions });
  await deps.work.enqueue(tx, reservationWork, row.id, { notBefore: now + pendingRetryMs });
  await publish(deps, tx, pending, queued ? 'reservation.queued' : 'reservation.pending', {
    reason,
  });
  return pending;
}

/** The work kind of the v0.4 pool-lease placer's batch worker (keyed by pool, `shardBy: 'pool'`). */
export const placerWork = 'capacity.placer';

/** Most reservations one batch places (§10.3: ≤64). */
export const maxPlacementBatch = 64;

/**
 * One batch of the v0.4 pool-lease placer (§10.3), run by the worker that owns the pool's shard: the
 * pool is locked once, up to `maxBatch` queued reservations are taken oldest first (`SKIP LOCKED`, so
 * a reservation its own reconciler holds is left for the next batch), and each is placed against one
 * in-memory `PoolIndex` with the usual guarded commits and savepoints. A request that does not fit
 * may still preempt spot work; otherwise it becomes `Unschedulable` and retries like any pending one.
 * `more` says whether queued reservations remain.
 */
export async function placeQueued(
  deps: ReservationDeps,
  tx: SqlTx,
  poolId: string,
  options: { maxBatch?: number; cache?: PoolIndexCache } = {},
): Promise<{ placed: number; pending: number; more: boolean; keep?: () => void }> {
  const limit = Math.min(Math.max(1, options.maxBatch ?? maxPlacementBatch), maxPlacementBatch);
  const pool = await readPool(tx, poolId);
  if (!pool) return { placed: 0, pending: 0, more: false };
  // Reservation rows first, then the index, and only then the pool lock: loading the index (a pool
  // of 10k nodes: ~250 ms on PGlite) never holds the lock that inline placements on the pool wait for.
  // A booking committed between the load and the lock is caught by the guarded commits.
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM reservations
      WHERE pool_id = $1 AND state = 'pending' AND conditions @> '[{"type": "Queued"}]'::jsonb
      ORDER BY created_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`,
    [poolId, limit + 1],
  );
  const batch = rows.slice(0, limit);
  const now = deps.clock.now();
  if (batch.length === 0) return { placed: 0, pending: 0, more: false };
  const checkout = options.cache ? await options.cache.checkout(tx, pool, now) : undefined;
  const index = checkout?.index ?? (await PoolIndex.load(tx, pool, now));
  const locked = await lockPool(tx, poolId);
  const context = { ...deps.placement, clock: deps.clock };
  const { rows: raw } = await tx.query<RawReservation>(
    `SELECT ${reservationColumns} FROM reservations WHERE id = ANY($1::text[])`,
    [batch.map((entry) => entry.id)],
  );
  const byId = new Map(raw.map((entry) => [entry.id, toReservation(entry)]));
  // The index (read before the lock, or cached) may predate an archive: the locked row decides.
  // Nothing new lands in an archived pool; each stays pending with the reason, as inline placement
  // answers, and the index is not handed back.
  if (locked.archived) {
    for (const { id } of batch) {
      const row = byId.get(id);
      if (!row || row.state !== 'pending') continue;
      const start = Math.max(row.request.start ?? now, now);
      await settlePlacement(deps, tx, row, { start, end: start + requestedDuration(row) }, archived);
    }
    return { placed: 0, pending: batch.length, more: rows.length > limit };
  }

  // 1. Plan every simple request on the index (each recorded tentatively for the next ones), then
  //    commit them with set-based statements. The rest, and whatever lost a race, go one by one.
  // `lost`: its bulk commit lost a race (a conflict, reported with its final outcome).
  type Entry = { row: ReservationRow; during: TimeRange; request: PlacementRequest; lost?: true };
  const started = performance.now();
  const planned: (Entry & { plan: NodePlan })[] = [];
  const oneByOne: Entry[] = [];
  for (const { id } of batch) {
    const row = byId.get(id);
    if (!row || row.state !== 'pending') continue;
    const start = Math.max(row.request.start ?? now, now);
    const during = { start, end: start + requestedDuration(row) };
    const request = placementRequest(row, during);
    const plan = bulkCommittable(request)
      ? await planOnIndex(tx, index, request, context)
      : undefined;
    if (plan) planned.push({ row, during, request, plan });
    else oneByOne.push({ row, during, request });
  }
  const committed = await commitPlansBulk(
    tx,
    pool,
    planned.map(({ request, plan }) => ({ request, plan })),
  );
  const settled: { row: ReservationRow; during: TimeRange; allocations: Allocation[] }[] = [];
  planned.forEach((entry, at) => {
    const allocation = committed.placed.get(at);
    if (allocation) {
      settled.push({ row: entry.row, during: entry.during, allocations: [allocation] });
      return;
    }
    index.forget({ atoms: entry.plan.atoms, during: entry.during });
    oneByOne.push({
      row: entry.row,
      during: entry.during,
      request: {
        ...entry.request,
        excludeNodes: [...(entry.request.excludeNodes ?? []), entry.plan.nodeId],
      },
      lost: true,
    });
  });
  await settlePlacedMany(deps, tx, settled);
  // One observation per reservation (§14): the bulk share of the time for those that landed.
  const bulkSeconds = (performance.now() - started) / 1000 / Math.max(1, planned.length);
  for (let n = 0; n < settled.length; n++)
    observePlacement(deps.onPlacement, {
      placer: 'batch',
      outcome: 'placed',
      conflicts: 0,
      seconds: bulkSeconds,
    });

  // 2. One by one: requests with scalars, lost races, and what did not fit (which may preempt spot).
  let placed = settled.length;
  for (const entry of oneByOne) {
    const row = entry.row;
    let during = entry.during;
    const stats = { conflicts: entry.lost ? 1 : 0 };
    const attemptStarted = performance.now();
    let outcome = await placeFromIndexCounted(tx, index, entry.request, context, {}, stats);
    if (outcome.status === 'pending' && row.request.spot !== true) {
      const preempted = await preemptFor(deps, tx, row, during);
      if (preempted) {
        ({ outcome, during } = preempted);
        if (outcome.status === 'placed')
          for (const allocation of outcome.allocations) index.record(allocation);
      }
    }
    const next = await settlePlacement(deps, tx, row, during, outcome);
    if (next.state === 'placed') placed++;
    observePlacement(deps.onPlacement, {
      placer: 'batch',
      outcome: outcome.status,
      conflicts: stats.conflicts,
      seconds: (performance.now() - attemptStarted) / 1000,
    });
  }
  return {
    placed,
    pending: batch.length - placed,
    more: rows.length > limit,
    // Hand the index back to the cache only after this transaction commits.
    ...(checkout ? { keep: checkout.keep } : {}),
  };
}

/** A pending reservation that would fit right now, and where. */
export interface PlaceablePending {
  reservationId: string;
  poolId: string;
  /** The best node (one per gang member). */
  nodeIds: string[];
}

/**
 * I7 (PLAN.md §15: nothing pending that an offline solver can place). Plans every `pending`
 * reservation alone against current capacity for its window, the way its next retry would (the
 * pipeline, gangs on their topology key), and answers those that would fit now. Reservations still
 * waiting for their pool-lease batch (`Queued`) and node leases (metal's) are skipped. Pure reads,
 * no locks: after a quiet period a correct scheduler leaves this empty (retries run every 30 s,
 * releases wake a pool's pending reservations).
 */
export async function placeablePending(
  tx: SqlTx,
  options: {
    now: number;
    poolId?: string;
    plugins?: readonly SchedulerPlugin[];
    weights?: Readonly<Record<string, number>>;
  },
): Promise<PlaceablePending[]> {
  const { rows } = await tx.query<RawReservation>(
    `SELECT ${reservationColumns} FROM reservations
      WHERE state = 'pending' AND ($1::text IS NULL OR pool_id = $1)
        AND NOT conditions @> '[{"type": "Queued"}]'::jsonb
      ORDER BY created_at, id`,
    [options.poolId ?? null],
  );
  const pools = new Map<string, PoolRow | undefined>();
  const views = new Map<string, Awaited<ReturnType<typeof loadNodeViews>>>();
  const out: PlaceablePending[] = [];
  for (const raw of rows) {
    const row = toReservation(raw);
    if (isNodeBinding(row)) continue;
    if (!pools.has(row.poolId)) pools.set(row.poolId, await readPool(tx, row.poolId));
    const pool = pools.get(row.poolId);
    if (!pool || pool.archived) continue;
    const start = Math.max(row.request.start ?? options.now, options.now);
    const during = { start, end: start + requestedDuration(row) };
    const request = placementRequest(row, during);
    const key = `${pool.id}\u0000${during.start}\u0000${during.end}`;
    let window = views.get(key);
    if (!window) views.set(key, (window = await loadNodeViews(tx, pool, during)));
    const plan = planPlacement(request, window, pool, {
      ...(options.plugins ? { plugins: options.plugins } : {}),
      ...(options.weights ? { weights: options.weights } : {}),
    });
    if (request.gang !== undefined) {
      const [best] = planGangs(plan.ranked, window, request.gang).gangs;
      if (best)
        out.push({
          reservationId: row.id,
          poolId: pool.id,
          nodeIds: best.members.map((member) => member.nodeId),
        });
    } else if (plan.ranked[0])
      out.push({ reservationId: row.id, poolId: pool.id, nodeIds: [plan.ranked[0].nodeId] });
  }
  return out;
}

/**
 * `settlePlacement` for many placed reservations at once (the pool-lease batch): one version-guarded
 * UPDATE, the lifecycle wake-ups per start time (`enqueueMany` when the queue has it), and the
 * `reservation.placed` events (`publishMany` when the publisher has it).
 */
async function settlePlacedMany(
  deps: ReservationDeps,
  tx: SqlTx,
  entries: readonly { row: ReservationRow; during: TimeRange; allocations: Allocation[] }[],
): Promise<void> {
  if (entries.length === 0) return;
  const now = deps.clock.now();
  const state = transition(reservationStateTable, 'pending', 'place');
  const updates = entries.map(({ row, during }) => ({
    id: row.id,
    version: row.version,
    s: new Date(during.start).toISOString(),
    e: new Date(during.end).toISOString(),
    conditions: withoutCondition(withoutCondition(row.conditions, 'Unschedulable'), 'Queued'),
    lease:
      row.request.leaseSeconds !== undefined
        ? new Date(now + row.request.leaseSeconds * 1000).toISOString()
        : null,
  }));
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE reservations r
        SET state = $2, during = tstzrange(x.s, x.e), conditions = x.conditions,
            lease_expires_at = COALESCE(x.lease, r.lease_expires_at), version = r.version + 1
       FROM jsonb_to_recordset($1::jsonb)
            AS x(id text, version bigint, s timestamptz, e timestamptz, conditions jsonb, lease timestamptz)
      WHERE r.id = x.id AND r.version = x.version AND r.state = 'pending'
      RETURNING r.id`,
    [JSON.stringify(updates), state],
  );
  if (rows.length !== updates.length)
    throw new ComputeError(
      'CONFLICT',
      'A queued reservation changed concurrently; retry the batch',
    );

  const byStart = new Map<number, string[]>();
  for (const { row, during } of entries)
    byStart.set(during.start, [...(byStart.get(during.start) ?? []), row.id]);
  for (const [start, ids] of byStart)
    if (deps.work.enqueueMany)
      await deps.work.enqueueMany(tx, reservationWork, ids, { notBefore: start });
    else
      for (const id of ids) await deps.work.enqueue(tx, reservationWork, id, { notBefore: start });

  const events = entries.map(({ row, during, allocations }) => ({
    type: 'reservation.placed',
    tenantId: row.tenantId,
    subject: `reservation/${row.id}`,
    data: {
      state,
      poolId: row.poolId,
      nodeIds: allocations.map((allocation) => allocation.nodeId),
      start: during.start,
      end: during.end,
    },
  }));
  if (deps.events.publishMany) await deps.events.publishMany(tx, events);
  else for (const event of events) await deps.events.publish(tx, event);
}

const preemptable: readonly ReservationState[] = ['placed', 'binding', 'active'];

/**
 * Spot preemption for a non-spot request that would go pending (§10.5, v0.5): plans it as if spot
 * bookings were free, gives the spot reservations holding the chosen atoms a notice (see
 * `noticeSpot`), and places the request from the notice deadline on, on the planned nodes. All of
 * it inside one savepoint: if the victims cannot be locked or the placement still fails, nothing
 * changes. Victims locked by another transaction are skipped (`SKIP LOCKED`), never waited on.
 */
async function preemptFor(
  deps: ReservationDeps,
  tx: SqlTx,
  row: ReservationRow,
  during: TimeRange,
): Promise<{ outcome: PlacementOutcome; during: TimeRange } | undefined> {
  const pool = await readPool(tx, row.poolId);
  if (!pool || pool.archived) return undefined;
  const now = deps.clock.now();
  const at = Math.max(during.start, now + (deps.spotNoticeMs ?? defaultSpotNoticeMs));
  const window = { start: at, end: at + (during.end - during.start) };
  const request = placementRequest(row, window);
  const spot = await readSpotAllocations(tx, pool.id, window);
  const plan = await planPreemption(tx, pool, request, spot, deps.placement);
  if (!plan) return undefined;

  await tx.query(`SAVEPOINT capacity_preempt`);
  const undo = async () => {
    await tx.query(`ROLLBACK TO SAVEPOINT capacity_preempt`);
    await tx.query(`RELEASE SAVEPOINT capacity_preempt`);
    return undefined;
  };
  try {
    const locked = await tx.query<{ id: string }>(
      `SELECT id FROM reservations WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE SKIP LOCKED`,
      [plan.victims],
    );
    if (locked.rows.length !== plan.victims.length) return await undo();
    for (const id of plan.victims) {
      const victim = await readReservationById(tx, id, false);
      if (!victim?.during || !preemptable.includes(victim.state) || victim.request.spot !== true)
        return await undo();
      await noticeSpot(deps, tx, victim, row, at);
    }
    const planned = new Set(plan.nodeIds);
    const others = (await readPoolNodes(tx, pool.id))
      .map((node) => node.id)
      .filter((nodeId) => !planned.has(nodeId));
    const outcome = await (deps.inline ?? deps.placer).place(
      tx,
      { ...request, excludeNodes: others },
      { ...deps.placement, clock: deps.clock },
    );
    if (outcome.status !== 'placed') return await undo();
    await tx.query(`RELEASE SAVEPOINT capacity_preempt`);
    return { outcome, during: window };
  } catch (error) {
    await undo();
    throw error;
  }
}

/**
 * The notice of a preempted spot reservation. One that starts at or after the deadline has not run:
 * its bookings are released and it goes back to `pending` to be placed again (quota kept). One that
 * has started, or starts before the deadline, is cut back to end at the deadline with a `Preempted`
 * condition; its nodes learn the new end, and at the deadline the lifecycle releases it with reason
 * `preempted`. Either way it is billed only for the time it held the atoms.
 */
async function noticeSpot(
  deps: ReservationDeps,
  tx: SqlTx,
  victim: ReservationRow,
  preemptor: Pick<ReservationRow, 'id' | 'tenantId'>,
  at: number,
): Promise<void> {
  const now = deps.clock.now();
  const allocations = await readOwnerAllocations(tx, { kind: 'reservation', id: victim.id });
  // The victim's tenant learns who preempted it only when it is itself the preemptor's tenant.
  const sameTenant = preemptor.tenantId === victim.tenantId;
  const by: Record<string, Json> = sameTenant ? { by: preemptor.id } : {};
  const message = sameTenant
    ? `preempted by ${preemptor.id}`
    : 'preempted by a non-spot reservation';
  const condition: Omit<Condition, 'since'> = {
    type: 'Preempted',
    status: 'true',
    reason: 'SpotPreempted',
    message,
  };
  if (victim.during!.start >= at) {
    for (const allocation of allocations) {
      await releaseAllocation(tx, allocation.id);
      await deps.desired.invalidate(tx, allocation.nodeId);
    }
    const pending = await move(tx, victim, 'defer', {
      during: null,
      conditions: withCondition(
        victim.conditions,
        {
          type: 'Unschedulable',
          status: 'true',
          reason: 'SpotPreempted',
          message,
        },
        now,
      ),
    });
    await deps.work.enqueue(tx, reservationWork, victim.id, { notBefore: now + pendingRetryMs });
    await publish(deps, tx, pending, 'reservation.preempted', { ...by, requeued: true });
    return;
  }
  for (const allocation of allocations) {
    await truncateAllocation(tx, allocation.id, at);
    await deps.desired.invalidate(tx, allocation.nodeId);
  }
  const conditions = withCondition(victim.conditions, condition, now);
  const { rowCount } = await tx.query(
    `UPDATE reservations SET during = tstzrange(lower(during), $3::timestamptz), conditions = $4::jsonb,
                             version = version + 1
      WHERE id = $1 AND version = $2`,
    [victim.id, victim.version, new Date(at).toISOString(), JSON.stringify(conditions)],
  );
  if (rowCount === 0)
    throw new ComputeError('CONFLICT', `Reservation ${victim.id} changed concurrently`);
  const noticed = { ...victim, conditions, during: { start: victim.during!.start, end: at } };
  await deps.work.enqueue(tx, reservationWork, victim.id, { notBefore: at });
  await publish(deps, tx, noticed, 'reservation.preempting', { ...by, at });
}

/** Whether a reservation leases whole nodes (`binding: 'node'`, deployed by metal). */
export function isNodeBinding(row: Pick<ReservationRow, 'request'>): boolean {
  return row.request.binding === 'node';
}

/** Wakes metal's node reconciler for every node of a node-binding reservation. */
async function wakeMetal(
  deps: Pick<ReservationDeps, 'work'>,
  tx: SqlTx,
  allocations: readonly { nodeId: string }[],
): Promise<void> {
  for (const nodeId of new Set(allocations.map((allocation) => allocation.nodeId)))
    await deps.work.enqueue(tx, metalWork, nodeId);
}

/** Whether a reservation was cut short by spot preemption. */
export function isPreempted(row: Pick<ReservationRow, 'conditions'>): boolean {
  return row.conditions.some((entry) => entry.type === 'Preempted' && entry.status === 'true');
}

/** A pending reservation retries placement this often (§10.5). */
export const pendingRetryMs = 30_000;
/** How long a node has to report `AllocationBound` after the start. */
export const bindTimeoutMs = 5 * 60_000;
/** Bind timeouts tolerated before the reservation fails (§10.5: pending ≤2). */
export const maxBindRetries = 2;
/** Default `maxPending` when the pool policy sets none. */
export const defaultMaxPendingMs = parseDuration('24h');

/**
 * `reservations.create` transaction 2 (allowed): charge quota, then place. `QUOTA_EXCEEDED` is
 * terminal for the request and leaves the draft for the next attempt with the same key.
 */
export async function completeCreate(
  deps: ReservationDeps,
  context: MethodContext,
  input: CreateReservationInput,
): Promise<Reservation> {
  const tx = context.sql;
  const caller = context.caller!;
  const id = await draftId('rsv', input.tenantId, caller.identityId, input.idempotencyKey);
  const row = await readReservation(tx, input.tenantId, id, { lock: true });
  if (!row) throw new ComputeError('NOT_FOUND', `Reservation ${id} not found`);
  if (row.state !== 'draft') return reservationView(tx, row);
  await chargeQuota(tx, row.tenantId, row.poolId, reservationDemand(row.request));
  const next = await attemptPlacement(deps, tx, row, context.admission);
  return reservationView(tx, next);
}

async function releaseBookings(
  tx: SqlTx,
  row: ReservationRow,
  deps: Pick<ReservationDeps, 'desired' | 'work'>,
): Promise<AllocationRecord[]> {
  const allocations = await readOwnerAllocations(tx, { kind: 'reservation', id: row.id });
  // Pods may keep a Kubernetes binding's devices after the kubelet loses them: those stay booked
  // until the node reports AllocationReleased (§3.8, deferRelease).
  const kubernetes = row.request.binding === 'kubernetes';
  for (const allocation of allocations) {
    if (!(kubernetes && (await deferRelease(tx, allocation.id))))
      await releaseAllocation(tx, allocation.id);
    await deps.desired.invalidate(tx, allocation.nodeId);
  }
  // Metal tears a released lease down (tenant-root release) and returns the node to ready.
  if (isNodeBinding(row)) await wakeMetal(deps, tx, allocations);
  return allocations;
}

/**
 * Ends a reservation: bookings released at compute_now() (a bound Kubernetes binding's at the node's
 * AllocationReleased, `deferRelease`), quota refunded, node specs invalidated,
 * and the terminal state recorded. `placed`/`binding`/`active` go through `releasing` to `released`;
 * `pending` is `cancelled`; terminal states are returned unchanged (idempotent).
 */
export async function endReservation(
  deps: ReservationDeps,
  tx: SqlTx,
  row: ReservationRow,
  why: 'release' | 'expired' | 'lease-lapsed' | 'preempted',
): Promise<ReservationRow> {
  if (reservationStateTable.terminal.includes(row.state)) return row;
  if (row.state === 'draft' || row.state === 'awaiting-confirmation')
    throw new ComputeError('INVALID_STATE', `Reservation ${row.id} is ${row.state}`);
  await refundQuota(tx, row.tenantId, row.poolId, reservationDemand(row.request));
  await releaseBookings(tx, row, deps);
  let next: ReservationRow;
  if (row.state === 'pending') next = await move(tx, row, 'cancel');
  else if (row.state === 'releasing') next = await move(tx, row, 'complete');
  else {
    const releasing = await move(tx, row, 'release');
    next = await move(tx, releasing, 'complete');
  }
  await publish(deps, tx, next, `reservation.${next.state}`, { reason: why });
  await wakePendingReservations(tx, deps.work, row.poolId);
  return next;
}

async function failReservation(
  deps: ReservationDeps,
  tx: SqlTx,
  row: ReservationRow,
  condition: Omit<Condition, 'since'>,
): Promise<ReservationRow> {
  await refundQuota(tx, row.tenantId, row.poolId, reservationDemand(row.request));
  await releaseBookings(tx, row, deps);
  const failed = await move(tx, row, 'fail', {
    conditions: withCondition(row.conditions, condition, deps.clock.now()),
  });
  await publish(deps, tx, failed, 'reservation.failed', { reason: condition.reason ?? '' });
  await wakePendingReservations(tx, deps.work, row.poolId);
  return failed;
}

/**
 * `reservations.cancel` (allowed): withdraws a reservation that has not started (`pending` or
 * `placed`), releasing its bookings and quota. Cancelling a cancelled reservation is a no-op.
 */
export async function cancelReservation(
  deps: ReservationDeps,
  tx: SqlTx,
  tenantId: string,
  id: string,
): Promise<Reservation> {
  const row = await readReservation(tx, tenantId, id, { lock: true });
  if (!row || row.state === 'draft')
    throw new ComputeError('NOT_FOUND', `Reservation ${id} not found`);
  if (row.state === 'cancelled') return reservationView(tx, row);
  if (row.state !== 'pending' && row.state !== 'placed')
    throw new ComputeError(
      'INVALID_STATE',
      `Only pending or not-yet-started reservations can be cancelled (${row.state}); release it instead`,
    );
  await refundQuota(tx, row.tenantId, row.poolId, reservationDemand(row.request));
  await releaseBookings(tx, row, deps);
  const cancelled = await move(tx, row, 'cancel');
  await publish(deps, tx, cancelled, 'reservation.cancelled');
  await wakePendingReservations(tx, deps.work, row.poolId);
  return reservationView(tx, cancelled);
}

/**
 * Cancels a reservation that has not started, on the system's behalf (an IAM reaction: an agent
 * suspended or a delegation revoked, an owner offboarded, a budget drained): `pending`, `placed`
 * and `awaiting-confirmation` ones are cancelled with their bookings and quota given back (a parked
 * request was never charged) and `reservation.cancelled { reason }`; started and terminal ones are
 * returned unchanged, for the caller's policy. The caller holds the row lock
 * (`readReservation(…, { lock: true })`). Idempotent.
 */
export async function cancelPendingReservation(
  deps: Pick<ReservationDeps, 'events' | 'work' | 'desired'>,
  tx: SqlTx,
  row: ReservationRow,
  reason: string,
): Promise<ReservationRow> {
  if (row.state !== 'pending' && row.state !== 'placed' && row.state !== 'awaiting-confirmation')
    return row;
  const charged = row.state !== 'awaiting-confirmation';
  if (charged) {
    await refundQuota(tx, row.tenantId, row.poolId, reservationDemand(row.request));
    await releaseBookings(tx, row, deps);
  }
  const cancelled = await move(tx, row, 'cancel');
  await publish(deps, tx, cancelled, 'reservation.cancelled', { reason });
  if (charged) await wakePendingReservations(tx, deps.work, row.poolId);
  return cancelled;
}

/**
 * A reservation's authz projection row (§12.3) as `reservations.create` writes it, owned by
 * `ownerId` (default the current owner): re-upsert it after moving a reservation to another owner.
 */
export async function reservationAuthzRow(
  tx: SqlTx,
  row: ReservationRow,
  ownerId: string = row.ownerIdentityId,
): Promise<AuthzRow> {
  const { rows } = await tx.query<{ gpu_model: string | null; region: string }>(
    `SELECT p.gpu_model, s.region FROM pools p JOIN sites s ON s.id = p.site_id WHERE p.id = $1`,
    [row.poolId],
  );
  const pool = rows[0];
  return {
    type: 'reservation',
    id: row.id,
    tenantId: row.tenantId,
    attributes: reservationAttributes(
      row.request,
      { ...(pool?.gpu_model ? { gpuModel: pool.gpu_model } : {}), region: pool?.region ?? '' },
      requestedDuration(row),
    ),
    parentType: 'pool',
    parentId: row.poolId,
    ownerId,
  };
}

/** `reservations.release` (allowed): see `endReservation`. */
export async function releaseReservation(
  deps: ReservationDeps,
  tx: SqlTx,
  tenantId: string,
  id: string,
): Promise<Reservation> {
  const row = await readReservation(tx, tenantId, id, { lock: true });
  if (!row) throw new ComputeError('NOT_FOUND', `Reservation ${id} not found`);
  return reservationView(tx, await endReservation(deps, tx, row, 'release'));
}

/** Validated `reservations.extend` input: a new end (`until`) or an increment (`by`, ms). */
export interface ExtendReservationInput {
  tenantId: string;
  reservationId: string;
  until?: number;
  by?: number;
  idempotencyKey: string;
  /**
   * Set by `prepare`, never by the caller (the parser keeps known fields only): the hold this
   * admission took on the reservation's pending change, a nonce minted here. Not the request id,
   * which callers choose (`x-request-id`): two extends sharing one would share the hold.
   */
  hold?: string;
}

export function parseExtendReservation(raw: unknown): ExtendReservationInput {
  const input = record(raw, 'The request');
  onlyKeys(input, ['tenantId', 'reservationId', 'until', 'by', 'idempotencyKey'], 'The request');
  if (!isId(input.reservationId, 'rsv')) fail('reservationId must be a reservation id');
  const result: ExtendReservationInput = {
    tenantId: string(input.tenantId, tenantPattern, 'tenantId'),
    reservationId: input.reservationId,
    idempotencyKey: string(input.idempotencyKey, keyPattern, 'idempotencyKey'),
  };
  if ((input.until === undefined) === (input.by === undefined))
    fail('Give exactly one of until or by');
  if (input.until !== undefined) result.until = integer(input.until, 0, 2 ** 47, 'until');
  if (input.by !== undefined) {
    let by: number;
    try {
      by = parseDuration(input.by as string | number);
    } catch {
      fail('by must look like 30m, 8h or 7d');
    }
    if (!(by > 0 && by <= maxDuration)) fail('by must be between 1ms and 365d');
    result.by = by;
  }
  return result;
}

/** The outcome of `reservations.extend`: extended, or the latest end the bookings can reach. */
export interface ExtendResult {
  reservation: Reservation;
  extended: boolean;
  /** Set when another booking blocks the extension: the reachable end. */
  availableUntil?: number;
}

const extendable: readonly ReservationState[] = ['placed', 'binding', 'active'];

function targetEnd(row: ReservationRow, input: ExtendReservationInput): number {
  const end = row.during!.end;
  return input.until ?? end + input.by!;
}

/**
 * `reservations.extend` transaction 1 (§10.5): the pending change goes into the authz projection so
 * `BoundedExtend` sees the total duration after the change. A request whose end is already reached
 * replays without a decision.
 */
export async function prepareExtend(
  context: MethodContext,
  input: ExtendReservationInput,
  tx: SqlTx,
): Promise<AdmissionPlan<ExtendResult>> {
  const row = await readReservation(tx, input.tenantId, input.reservationId, { lock: true });
  if (!row) throw new ComputeError('NOT_FOUND', `Reservation ${input.reservationId} not found`);
  if (!extendable.includes(row.state) || !row.during)
    throw new ComputeError('INVALID_STATE', `Reservation ${row.id} is ${row.state}`);
  const end = targetEnd(row, input);
  if (input.until !== undefined && end <= row.during.end)
    return {
      status: 'replay',
      result: { reservation: await reservationView(tx, row), extended: false },
    };
  // The handler applies this absolute end, not "current + by" again, and the approval text names it.
  input.until = end;
  delete input.by;
  const gpuCount = wholeGpus(row.request.devices) * (row.request.gang?.size ?? 1);
  const hold = newId('hold');
  await holdExtend(tx, row.id, hold);
  input.hold = hold;
  await context.authz.setPending(
    tx,
    { type: 'reservation', id: row.id, tenantId: row.tenantId },
    {
      durationHours: Math.round(((end - row.during.start) / hour) * 1000) / 1000,
      gpuCount,
      idempotencyKey: input.idempotencyKey,
    },
  );
  return { status: 'decide', resource: { type: 'reservation', id: row.id } };
}

/**
 * One extend at a time stages a reservation's pending change: the projection holds a single pending
 * value, so a second extend overwriting it would have the first decided on the second's duration (a
 * short one), then apply its own (a long one). Another request's hold older than `extendHoldMs` (its
 * caller gave up between the transactions) is taken over.
 */
const extendHoldMs = 60_000;

async function holdExtend(tx: SqlTx, reservationId: string, hold: string): Promise<void> {
  // The database's clock: replicas' clocks may disagree about when a hold went stale.
  const { rowCount } = await tx.query(
    `INSERT INTO capacity_extend_holds AS h (reservation_id, request_id, held_at)
     VALUES ($1, $2, compute_now())
     ON CONFLICT (reservation_id) DO UPDATE SET request_id = EXCLUDED.request_id, held_at = EXCLUDED.held_at
      WHERE h.held_at < EXCLUDED.held_at - make_interval(secs => $3::float8)`,
    [reservationId, hold, extendHoldMs / 1000],
  );
  if (rowCount === 0)
    throw new ComputeError(
      'CONFLICT',
      `Another extend of reservation ${reservationId} is being decided; retry once it settles (a stalled one is taken over after ${extendHoldMs / 1000} s)`,
      undefined,
      { reservationId, reason: 'extend-in-flight', retryAfterSeconds: extendHoldMs / 1000 },
    );
}

/** `reservations.extend` refused, or its handler threw: clear the pending change if it is still ours. */
export async function denyPending(
  context: MethodContext,
  input: { tenantId: string; reservationId: string; hold?: string },
  tx: SqlTx,
): Promise<void> {
  if (input.hold === undefined) return;
  const { rowCount } = await tx.query(
    `DELETE FROM capacity_extend_holds WHERE reservation_id = $1 AND request_id = $2`,
    [input.reservationId, input.hold],
  );
  if (rowCount === 0) return;
  await context.authz.setPending(
    tx,
    { type: 'reservation', id: input.reservationId, tenantId: input.tenantId },
    null,
  );
}

/**
 * `reservations.extend` transaction 2 (allowed): raises `upper(during)` on every allocation; the
 * EXCLUDE constraint decides. The pending change is folded into the projection or cleared.
 */
export async function completeExtend(
  deps: ReservationDeps,
  context: MethodContext,
  input: ExtendReservationInput,
): Promise<ExtendResult> {
  const tx = context.sql;
  const row = await readReservation(tx, input.tenantId, input.reservationId, { lock: true });
  if (!row) throw new ComputeError('NOT_FOUND', `Reservation ${input.reservationId} not found`);
  const ref = { type: 'reservation', id: row.id, tenantId: row.tenantId };
  // The decision was made on this request's pending change only while it held the reservation:
  // after a takeover, IAM may have seen another request's.
  const { rowCount: held } =
    input.hold === undefined
      ? { rowCount: 0 }
      : await tx.query(
          `DELETE FROM capacity_extend_holds WHERE reservation_id = $1 AND request_id = $2`,
          [row.id, input.hold],
        );
  if (held === 0)
    throw new ComputeError(
      'CONFLICT',
      `Another extend of reservation ${row.id} took over while this one was decided; retry`,
      undefined,
      { reservationId: row.id, reason: 'extend-in-flight' },
    );
  if (!extendable.includes(row.state) || !row.during) {
    await context.authz.setPending(tx, ref, null);
    throw new ComputeError('INVALID_STATE', `Reservation ${row.id} is ${row.state}`);
  }
  const end = targetEnd(row, input);
  if (end <= row.during.end) {
    await context.authz.setPending(tx, ref, null);
    return { reservation: await reservationView(tx, row), extended: false };
  }
  // Pools before devices (§10 lock order): without the pool lock, a gang's extend updating d1 then
  // d2 and a batch commit inserting d2 then d1 wait on each other's uncommitted bookings.
  await lockPool(tx, row.poolId);
  const allocations = await readOwnerAllocations(tx, { kind: 'reservation', id: row.id });
  const savepoint = 'capacity_extend_reservation';
  await tx.query(`SAVEPOINT ${savepoint}`);
  let blocked: number | undefined;
  try {
    for (const allocation of allocations) {
      const outcome = await extendAllocation(tx, allocation.id, end);
      if (outcome.status === 'conflict') {
        blocked = Math.min(blocked ?? Infinity, outcome.availableUntil);
      }
    }
  } catch (error) {
    await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
  if (blocked !== undefined) {
    // All or nothing: allocations that did extend go back to the old end.
    await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
    await context.authz.setPending(tx, ref, null);
    return {
      reservation: await reservationView(tx, row),
      extended: false,
      availableUntil: blocked,
    };
  }
  await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
  const during = { start: row.during.start, end };
  const extended = await move(tx, row, 'extend', { during });
  const pool = await visiblePool(tx, row.tenantId, row.poolId);
  if (pool)
    await context.authz.upsert(tx, {
      type: 'reservation',
      id: row.id,
      tenantId: row.tenantId,
      attributes: reservationAttributes(row.request, pool, end - row.during.start),
      parentType: 'pool',
      parentId: row.poolId,
      ownerId: row.ownerIdentityId,
    });
  await context.authz.setPending(tx, ref, null);
  for (const allocation of allocations) await deps.desired.invalidate(tx, allocation.nodeId);
  await deps.work.enqueue(tx, reservationWork, row.id, { notBefore: end });
  await publish(deps, tx, extended, 'reservation.extended', { end });
  return { reservation: await reservationView(tx, extended), extended: true };
}

/**
 * `reservations.renew` (allowed): moves the lease deadline of a renewable reservation to
 * `now + leaseSeconds`; `during` is unchanged. The lease reaper releases lapsed ones.
 */
export async function renewReservation(
  deps: ReservationDeps,
  tx: SqlTx,
  tenantId: string,
  id: string,
): Promise<Reservation> {
  const row = await readReservation(tx, tenantId, id, { lock: true });
  if (!row) throw new ComputeError('NOT_FOUND', `Reservation ${id} not found`);
  if (row.request.leaseSeconds === undefined)
    throw new ComputeError('INVALID_STATE', `Reservation ${id} is not renewable`);
  if (!extendable.includes(row.state))
    throw new ComputeError('INVALID_STATE', `Reservation ${id} is ${row.state}`);
  const lease = deps.clock.now() + row.request.leaseSeconds * 1000;
  const renewed = await move(tx, row, 'renew', { leaseExpiresAt: lease });
  await deps.work.enqueue(tx, reservationWork, row.id, { notBefore: lease });
  return reservationView(tx, renewed);
}

// --- Lifecycle ---------------------------------------------------------------------------------

/** A node's signed `AllocationBound`, as the gateway received it (`AttestedReport`). */
export interface BindingEvidence {
  /** The serialized `AttestedReportBody`. */
  body: Uint8Array;
  /** `node_sig`: the key id and the signature over the body. */
  kid: string;
  sig: Uint8Array;
}

/**
 * Records a node's `AllocationBound` report (the gateway calls it) and wakes the lifecycle. The
 * signed report, when there is one, is stored as received (`bound_report`, `bound_sig_kid`,
 * `bound_sig`; core/0017): with `attestedBindings` configured the reservation worker verifies it
 * before the reservation goes active (P14). With `nodeId` (the session's node), a report about
 * another node's allocation is refused. Returns `false` when the allocation is unknown, released or
 * not on `nodeId`.
 */
export async function markAllocationBound(
  tx: SqlTx,
  work: ModuleContext['work'],
  allocationId: string,
  binding: { cdiDevices: readonly string[]; envFile?: string; cgroupParent?: string },
  options: { nodeId?: string; evidence?: BindingEvidence } = {},
): Promise<boolean> {
  // The slice bcd bound a hold into (§3.8): exactly this allocation's, never another name.
  const slice = binding.cgroupParent === `bcd-alloc-${allocationId}.slice` ? binding.cgroupParent : undefined;
  const { rows } = await tx.query<{ owner_id: string; owner_kind: string }>(
    `UPDATE allocations SET binding = $2::jsonb, bound_at = COALESCE(bound_at, compute_now()),
                            bound_report = $4, bound_sig_kid = $5, bound_sig = $6,
                            version = version + 1
      WHERE id = $1 AND released_at IS NULL AND ($3::text IS NULL OR node_id = $3)
      RETURNING owner_id, owner_kind`,
    [
      allocationId,
      JSON.stringify({
        cdiDevices: [...binding.cdiDevices],
        envFile: binding.envFile ?? '',
        ...(slice ? { cgroupParent: slice } : {}),
      }),
      options.nodeId ?? null,
      options.evidence?.body ?? null,
      options.evidence?.kid ?? null,
      options.evidence?.sig ?? null,
    ],
  );
  return wakeOwner(tx, work, rows[0]);
}

/**
 * Verifies a stored `AllocationBound` (`CapacityModuleOptions.attestedBindings`): the node's
 * signature over the body, from a certificate of that node, and a body that reports exactly this
 * allocation bound. Answers the signed binding, or why it does not hold; never throws for a bad
 * report. `@better-compute/server` builds the pki-backed one.
 */
export type AllocationBindingCheck = (
  tx: SqlTx,
  report: { allocationId: string; nodeId: string; evidence: BindingEvidence },
) => Promise<
  { ok: true; cdiDevices: readonly string[]; envFile: string } | { ok: false; reason: string }
>;

/**
 * With `attestedBindings`: checks every bound allocation of a reservation not yet verified since its
 * last report. A good report replaces the binding with the signed one (`attested`). A bad or unsigned
 * one never counts: in `binding` its `bound_at` is cleared (nothing is billed; the reservation waits
 * for a real report or its bind timeout), in `active` the binding is marked lost (`Degraded`). Each
 * rejection publishes `reservation.binding-rejected`.
 */
async function verifyBindings(
  deps: ReservationDeps,
  tx: SqlTx,
  row: ReservationRow,
): Promise<void> {
  const check = deps.attestedBindings;
  // Node leases are bound by metal's own worker once the deploy workflow verified it, not by a report.
  if (!check || isNodeBinding(row)) return;
  const { rows } = await tx.query<{
    id: string;
    node_id: string;
    bound_report: Uint8Array | null;
    bound_sig_kid: string | null;
    bound_sig: Uint8Array | null;
  }>(
    `SELECT id, node_id, bound_report, bound_sig_kid, bound_sig FROM allocations
      WHERE owner_kind = 'reservation' AND owner_id = $1 AND released_at IS NULL
        AND bound_at IS NOT NULL AND NOT (binding ? 'attested') AND NOT (binding ? 'lost')
      ORDER BY id FOR UPDATE`,
    [row.id],
  );
  for (const allocation of rows) {
    let outcome: Awaited<ReturnType<AllocationBindingCheck>>;
    if (!allocation.bound_report || !allocation.bound_sig_kid || !allocation.bound_sig)
      outcome = { ok: false, reason: 'unsigned report' };
    else
      try {
        outcome = await check(tx, {
          allocationId: allocation.id,
          nodeId: allocation.node_id,
          evidence: {
            body: new Uint8Array(allocation.bound_report),
            kid: allocation.bound_sig_kid,
            sig: new Uint8Array(allocation.bound_sig),
          },
        });
      } catch {
        outcome = { ok: false, reason: 'verification failed' };
      }
    if (outcome.ok) {
      await tx.query(
        `UPDATE allocations SET binding = $2::jsonb, version = version + 1 WHERE id = $1`,
        [
          allocation.id,
          JSON.stringify({
            cdiDevices: [...outcome.cdiDevices],
            envFile: outcome.envFile,
            attested: true,
          }),
        ],
      );
      continue;
    }
    const reason = outcome.reason.slice(0, 200);
    await tx.query(
      row.state === 'binding'
        ? `UPDATE allocations SET bound_at = NULL, binding = jsonb_build_object('rejected', $2::text),
                                  version = version + 1 WHERE id = $1`
        : `UPDATE allocations SET binding = COALESCE(binding, '{}'::jsonb)
                                  || jsonb_build_object('lost', true, 'rejected', $2::text),
                                  version = version + 1 WHERE id = $1`,
      [allocation.id, reason],
    );
    await publish(deps, tx, row, 'reservation.binding-rejected', {
      allocationId: allocation.id,
      nodeId: allocation.node_id,
      reason,
    });
  }
}

async function wakeOwner(
  tx: SqlTx,
  work: ModuleContext['work'],
  owner: { owner_id: string; owner_kind: string } | undefined,
): Promise<boolean> {
  if (!owner) return false;
  if (owner.owner_kind === 'reservation') await work.enqueue(tx, reservationWork, owner.owner_id);
  return true;
}

/**
 * Records a node's `AllocationFailed` report: it could not expose the devices. The reservation
 * treats it as an immediate bind failure (re-placed up to `maxBindRetries` times, then failed).
 * Returns `false` for an unknown, released or already bound allocation.
 */
export async function markAllocationFailed(
  tx: SqlTx,
  work: ModuleContext['work'],
  allocationId: string,
  failure: { reason: string },
): Promise<boolean> {
  const { rows } = await tx.query<{ owner_id: string; owner_kind: string }>(
    `UPDATE allocations SET binding = jsonb_build_object('failed', $2::text), version = version + 1
      WHERE id = $1 AND released_at IS NULL AND bound_at IS NULL RETURNING owner_id, owner_kind`,
    [allocationId, failure.reason.slice(0, 500)],
  );
  return wakeOwner(tx, work, rows[0]);
}

/**
 * Records a node's `AllocationReleased` report. For a released allocation that is the expected
 * acknowledgement (`false`). For a live, bound one the node lost the assignment: the reservation
 * gets `Degraded` (`BindingLost`) until the node reports it bound again. For one whose release was
 * deferred (`deferRelease`, a Kubernetes binding) it is the end: no pod holds the devices any more,
 * so the bookings end now, the scalars are returned and the pool's pending reservations retry.
 */
export async function markAllocationReleased(
  tx: SqlTx,
  work: ModuleContext['work'],
  allocationId: string,
): Promise<boolean> {
  const releasing = await tx.query<{ pool_id: string }>(
    `SELECT pool_id FROM allocations WHERE id = $1 AND released_at IS NULL AND binding ? 'releasing'`,
    [allocationId],
  );
  if (releasing.rows[0]) {
    if (!(await releaseAllocation(tx, allocationId))) return false;
    await wakePendingReservations(tx, work, releasing.rows[0].pool_id);
    return true;
  }
  const { rows } = await tx.query<{ owner_id: string; owner_kind: string }>(
    `UPDATE allocations SET binding = COALESCE(binding, '{}'::jsonb) || '{"lost": true}'::jsonb,
                            version = version + 1
      WHERE id = $1 AND released_at IS NULL AND bound_at IS NOT NULL AND NOT binding ? 'lost'
      RETURNING owner_id, owner_kind`,
    [allocationId],
  );
  return wakeOwner(tx, work, rows[0]);
}

/** How far a stuck Kubernetes release's booking is carried past its end at a time. */
export const stuckReleaseStepMs = 5 * 60_000;

/**
 * Ends the deferred releases (`deferRelease`) no report will end: the node is lost, or the booking
 * reached its end and could not be carried on because another allocation booked those devices
 * next (that one may then fail on the node until the pods let go). While the node is reachable
 * and the devices are free, a booking about to end is carried `stuckReleaseStepMs` further, so a
 * GPU pods still hold is never offered again. Run by the hosts pass (§3.8); answers how many it
 * ended. A later AllocationReleased for one is the usual acknowledgement.
 */
export async function finishStaleReleases(
  tx: SqlTx,
  work: ModuleContext['work'],
  limit = 500,
): Promise<number> {
  // Pods still holding the devices at the booking's end (bcd: KubernetesReleaseStuck) keep them
  // booked, a step at a time, while the node is reachable and no one else booked them next.
  const { rows: due } = await tx.query<{ id: string }>(
    `SELECT a.id FROM allocations a JOIN nodes n ON n.id = a.node_id
      WHERE a.released_at IS NULL AND a.binding ? 'releasing' AND n.connectivity <> 'lost'
        AND (SELECT max(upper(b.during)) FROM device_bookings b WHERE b.allocation_id = a.id)
            <= compute_now() + make_interval(secs => $2 / 1000.0)
      ORDER BY a.id LIMIT $1 FOR UPDATE OF a`,
    [limit, stuckReleaseStepMs / 2],
  );
  for (const allocation of due) {
    // The booked devices (atoms, and any parent a fraction books) are locked as the placer does.
    await tx.query(
      `SELECT 1 FROM devices WHERE id IN (SELECT device_id FROM device_bookings WHERE allocation_id = $1)
        ORDER BY id FOR UPDATE`,
      [allocation.id],
    );
    await tx.query(
      `WITH last AS (
         SELECT max(upper(during)) AS until,
                tstzrange(max(upper(during)), compute_now() + make_interval(secs => $2 / 1000.0)) AS step
           FROM device_bookings WHERE allocation_id = $1
       )
       UPDATE device_bookings b SET during = tstzrange(lower(b.during), upper(last.step))
         FROM last
        WHERE b.allocation_id = $1 AND upper(b.during) = last.until
          AND NOT EXISTS (SELECT 1 FROM device_bookings o
                           WHERE o.allocation_id <> $1 AND o.during && last.step
                             AND o.device_id IN (SELECT device_id FROM device_bookings
                                                  WHERE allocation_id = $1))`,
      [allocation.id, stuckReleaseStepMs],
    );
  }
  const { rows } = await tx.query<{ id: string; pool_id: string }>(
    `SELECT a.id, a.pool_id FROM allocations a JOIN nodes n ON n.id = a.node_id
      WHERE a.released_at IS NULL AND a.binding ? 'releasing'
        AND (n.connectivity = 'lost'
             OR NOT EXISTS (SELECT 1 FROM device_bookings b
                             WHERE b.allocation_id = a.id AND upper(b.during) > compute_now()))
      ORDER BY a.id LIMIT $1`,
    [limit],
  );
  const pools = new Set<string>();
  let ended = 0;
  for (const row of rows)
    if (await releaseAllocation(tx, row.id)) {
      ended++;
      pools.add(row.pool_id);
    }
  for (const poolId of [...pools].sort()) await wakePendingReservations(tx, work, poolId);
  return ended;
}

async function setConditions(
  tx: SqlTx,
  row: ReservationRow,
  conditions: Condition[],
): Promise<ReservationRow> {
  if (JSON.stringify(conditions) === JSON.stringify(row.conditions)) return row;
  const { rowCount } = await tx.query(
    `UPDATE reservations SET conditions = $3::jsonb, version = version + 1
      WHERE id = $1 AND version = $2`,
    [row.id, row.version, JSON.stringify(conditions)],
  );
  if (rowCount === 0)
    throw new ComputeError('CONFLICT', `Reservation ${row.id} changed concurrently`);
  return { ...row, conditions, version: row.version + 1 };
}

function maxPendingMs(policy: Json): number {
  const value =
    policy && typeof policy === 'object' && !Array.isArray(policy)
      ? (policy as Record<string, Json>).maxPending
      : undefined;
  if (typeof value === 'string' || typeof value === 'number') {
    try {
      return parseDuration(value);
    } catch {
      return defaultMaxPendingMs;
    }
  }
  return defaultMaxPendingMs;
}

/**
 * One level-triggered step of the reservation lifecycle (§10.5), run by the `capacity.reservations`
 * reconciler in one transaction. Returns the next time to look again, or `undefined` when terminal.
 */
export async function reconcileReservation(
  deps: ReservationDeps,
  tx: SqlTx,
  id: string,
): Promise<number | undefined> {
  const row = await readReservationById(tx, id, true);
  if (!row || reservationStateTable.terminal.includes(row.state)) return undefined;
  const now = deps.clock.now();

  if (row.state === 'awaiting-confirmation') {
    const expiresAt = confirmationExpiry(row) ?? now;
    if (expiresAt > now) return expiresAt;
    const expired = await move(tx, row, 'expire');
    await publish(deps, tx, expired, 'reservation.expired', { reason: 'confirmation expired' });
    return undefined;
  }
  if (row.state === 'draft') return undefined;

  if (row.state === 'pending') {
    const { rows } = await tx.query<{ created_ms: number }>(
      `SELECT (extract(epoch FROM created_at) * 1000)::float8 AS created_ms FROM reservations WHERE id = $1`,
      [id],
    );
    const pool = await visiblePool(tx, row.tenantId, row.poolId);
    const limit = maxPendingMs(pool?.policy ?? null);
    if (!pool || now - Number(rows[0]?.created_ms ?? now) >= limit) {
      await failReservation(deps, tx, row, {
        type: 'Unschedulable',
        status: 'true',
        reason: pool ? 'MaxPendingExceeded' : 'PoolGone',
        message: pool ? `pending longer than ${limit} ms` : 'the pool is no longer offered',
      });
      return undefined;
    }
    const next = await attemptPlacement(deps, tx, row);
    return next.state === 'placed' ? next.during!.start : now + pendingRetryMs;
  }

  if (row.state === 'releasing') {
    await endReservation(deps, tx, row, 'release');
    return undefined;
  }
  if (!row.during) return undefined;

  if (row.leaseExpiresAt !== undefined && row.leaseExpiresAt <= now) {
    await endReservation(deps, tx, row, 'lease-lapsed');
    return undefined;
  }
  if (row.during.end <= now) {
    await endReservation(deps, tx, row, isPreempted(row) ? 'preempted' : 'expired');
    return undefined;
  }
  const wake = (at: number) =>
    Math.min(at, row.during!.end, row.leaseExpiresAt ?? Number.POSITIVE_INFINITY);

  if (row.state === 'placed') {
    // BookingRepair (§10.5): from T−15 min, a booking that went bad is re-placed before it starts.
    if (row.during.start - now > repairLeadMs) return wake(row.during.start - repairLeadMs);
    // A node lease whose window has begun is metal's to deploy; its node stops being leasable then.
    const repaired =
      isNodeBinding(row) && row.during.start <= now ? row : await repairBooking(deps, tx, row);
    if (repaired.state !== 'placed') return now + pendingRetryMs;
    if (row.during.start > now) return wake(row.during.start);
    const binding = await move(tx, repaired, 'start');
    const allocations = await readOwnerAllocations(tx, { kind: 'reservation', id });
    for (const allocation of allocations) await deps.desired.invalidate(tx, allocation.nodeId);
    // A node lease is deployed by metal from its start, never earlier.
    if (isNodeBinding(row)) await wakeMetal(deps, tx, allocations);
    await publish(deps, tx, binding, 'reservation.binding');
    // A report that arrived while the reservation was still `placed` (early, stale or forged) is
    // judged now, not after the bind timeout.
    const { rows: early } = await tx.query(
      `SELECT 1 FROM allocations WHERE owner_kind = 'reservation' AND owner_id = $1
          AND released_at IS NULL AND (bound_at IS NOT NULL OR binding ? 'failed') LIMIT 1`,
      [id],
    );
    if (early.length > 0) return now;
    return wake(now + (isNodeBinding(row) ? nodeBindTimeoutMs : bindTimeoutMs));
  }

  if (row.state === 'binding') {
    await verifyBindings(deps, tx, row);
    // With attested bindings only verified ones count: a report that committed after the check
    // above waits for the next run.
    const attested = deps.attestedBindings !== undefined && !isNodeBinding(row);
    const { rows } = await tx.query<{
      total: string | number;
      bound: string | number;
      failed: string | number;
    }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE bound_at IS NOT NULL AND (NOT $2 OR binding ? 'attested')) AS bound,
              count(*) FILTER (WHERE binding ? 'failed') AS failed
         FROM allocations
        WHERE owner_kind = 'reservation' AND owner_id = $1 AND released_at IS NULL`,
      [id, attested],
    );
    const total = Number(rows[0]?.total ?? 0);
    const bound = Number(rows[0]?.bound ?? 0);
    const rejected = Number(rows[0]?.failed ?? 0) > 0;
    if (total > 0 && bound === total) {
      const active = await move(tx, row, 'bind', {
        conditions: withoutCondition(row.conditions, 'BindTimeout'),
      });
      await publish(deps, tx, active, 'reservation.active');
      return wake(row.during.end);
    }
    const timeout = isNodeBinding(row) ? nodeBindTimeoutMs : bindTimeoutMs;
    if (!rejected && now - row.during.start < timeout) return wake(row.during.start + timeout);
    const previous = row.conditions.find((entry) => entry.type === 'BindTimeout');
    const attempts = Number(previous?.message ?? 0) + 1;
    const condition = {
      type: 'BindTimeout',
      status: 'true' as const,
      reason: rejected ? 'NodeRejectedBinding' : 'NodeDidNotBind',
      message: String(attempts),
    };
    // A half-deployed node is not followed by a second deploy elsewhere: node leases fail at once.
    if (attempts > maxBindRetries || isNodeBinding(row)) {
      await failReservation(deps, tx, row, condition);
      return undefined;
    }
    await releaseBookings(tx, row, deps);
    const pending = await move(tx, row, 'defer', {
      during: null,
      conditions: withCondition(row.conditions, condition, now),
    });
    await publish(deps, tx, pending, 'reservation.pending', { reason: 'bind timeout' });
    return now;
  }

  // active (§10.5): conditions only, never a release (P6). `Degraded` while a node reports it lost
  // an assignment it had bound (or re-reports it bound without a valid signature), else while a
  // booked atom is unhealthy; `NodeUnreachable` while a node of it is not connected.
  await verifyBindings(deps, tx, row);
  const { rows } = await tx.query<{
    lost: string | number;
    unhealthy: string[] | null;
    unreachable: string[] | null;
    exposed: string[] | null;
  }>(
    `WITH live AS (
       SELECT id, node_id, atoms, binding FROM allocations
        WHERE owner_kind = 'reservation' AND owner_id = $1 AND released_at IS NULL)
     SELECT (SELECT count(*) FROM live WHERE binding ? 'lost') AS lost,
            (SELECT array_agg(d.id ORDER BY d.id) FROM live l JOIN devices d ON d.id = ANY(l.atoms)
              WHERE NOT d.healthy) AS unhealthy,
            (SELECT array_agg(DISTINCT n.id ORDER BY n.id) FROM live l JOIN nodes n ON n.id = l.node_id
              WHERE n.connectivity <> 'connected') AS unreachable,
            (SELECT array_agg(DISTINCT c.node_id ORDER BY c.node_id) FROM live l
               JOIN node_conditions c ON c.node_id = l.node_id
              WHERE c.type = 'ForeignGpuExposure' AND c.status = 'true') AS exposed`,
    [id],
  );
  const state = rows[0];
  const degraded: Omit<Condition, 'since'> | undefined =
    Number(state?.lost ?? 0) > 0
      ? {
          type: 'Degraded',
          status: 'true',
          reason: 'BindingLost',
          message: 'a node dropped the devices',
        }
      : state?.exposed?.length
        ? {
            // Another path on the node (the GPU operator's device plugin, env-var access) can give
            // these GPUs to someone else: not exclusively the tenant's any more (review 2, M4).
            type: 'Degraded',
            status: 'true',
            reason: 'ForeignGpuExposure',
            message: `GPUs exposed outside bcd on ${state.exposed.join(', ')}`,
          }
        : state?.unhealthy?.length
          ? {
              type: 'Degraded',
              status: 'true',
              reason: 'AtomUnhealthy',
              message: `unhealthy: ${state.unhealthy.join(', ')}`,
            }
          : undefined;
  let conditions = degraded
    ? withCondition(row.conditions, degraded, now)
    : withoutCondition(row.conditions, 'Degraded');
  conditions = state?.unreachable?.length
    ? withCondition(
        conditions,
        {
          type: 'NodeUnreachable',
          status: 'true',
          reason: 'Unreachable',
          message: state.unreachable.join(', '),
        },
        now,
      )
    : withoutCondition(conditions, 'NodeUnreachable');
  await setConditions(tx, row, conditions);
  // Node edges wake it (`wakeStartedOnNode`); the recheck keeps it level-triggered without them.
  return wake(now + activeRecheckMs);
}

/** How often an active reservation re-reads its nodes and atoms when no edge wakes it. */
export const activeRecheckMs = 15 * 60_000;

/**
 * Wakes the started reservations (`binding`, `active`) with a live allocation on a node, so their
 * conditions follow the node's connectivity and atom health (node-controller and health edges).
 * Inventory, which cannot import capacity, mirrors this as `wakeStartedReservations` (6f19d5d):
 * change the rule or the work kind (`capacity.reservations`) there too.
 */
export async function wakeStartedOnNode(
  tx: SqlTx,
  work: ModuleContext['work'],
  nodeId: string,
): Promise<number> {
  const { rows } = await tx.query<{ owner_id: string }>(
    `SELECT DISTINCT a.owner_id FROM allocations a JOIN reservations r ON r.id = a.owner_id
      WHERE a.node_id = $1 AND a.owner_kind = 'reservation' AND a.released_at IS NULL
        AND r.state IN ('binding', 'active')
      ORDER BY a.owner_id`,
    [nodeId],
  );
  for (const row of rows) await work.enqueue(tx, reservationWork, row.owner_id);
  return rows.length;
}

/**
 * The `devices` section of a node's spec (§7.3): CDI assignments for every reservation that has
 * started on it (`binding` or `active`), each ending at the booking's end, with the host resources
 * booked with the devices as limits (§3.8, `assignmentLimits`).
 */
export async function deviceAssignments(tx: SqlTx, nodeId: string): Promise<DeviceAssignment[]> {
  const { rows } = await tx.query<{
    id: string;
    atoms: string[];
    end_ms: number;
    resources: Record<string, number> | string | null;
  }>(
    `SELECT a.id, a.atoms, (extract(epoch FROM upper(a.during)) * 1000)::float8 AS end_ms, a.resources
       FROM allocations a JOIN reservations r ON r.id = a.owner_id AND a.owner_kind = 'reservation'
      WHERE a.node_id = $1 AND a.released_at IS NULL AND r.state IN ('binding', 'active')
        AND cardinality(a.atoms) > 0 AND r.request->>'binding' IS DISTINCT FROM 'node'
      ORDER BY a.id`,
    [nodeId],
  );
  const booked = rows.map((row) => ({
    row,
    resources: (typeof row.resources === 'string'
      ? JSON.parse(row.resources)
      : (row.resources ?? {})) as Record<string, number>,
  }));
  const topology = booked.some(({ resources }) => hostBooked(resources))
    ? await readNodeTopology(tx, nodeId, [...new Set(rows.flatMap((row) => row.atoms))])
    : undefined;
  return booked.map(({ row, resources }) => {
    const assignment: DeviceAssignment = {
      allocationId: row.id,
      deviceIds: [...row.atoms],
      until: Number(row.end_ms),
    };
    const limits = topology ? assignmentLimits(resources, row.atoms, topology) : undefined;
    if (limits) assignment.limits = limits;
    return assignment;
  });
}

const hostBooked = (resources: Readonly<Record<string, number>>): boolean =>
  (resources.vcpu ?? 0) > 0 || (resources.memoryGiB ?? 0) > 0 || (resources.hugepages1Gi ?? 0) > 0;

/**
 * A host's NUMA nodes (applied inventory), the NUMA node of each of some devices, the CPUs the
 * kernel isolates (`cpu.isolatedCpus`) and the CPUs kept for the host itself (§3.8): the lowest-
 * numbered non-isolated CPUs, as many as the pool's `policy.hostReserve.vcpu` (default 2), which
 * no cpuset or pinned guest is given.
 */
export interface NodeTopology {
  numa: ReadonlyMap<number, { cpus: readonly number[]; memoryBytes: number }>;
  deviceNuma: ReadonlyMap<string, number>;
  isolated?: ReadonlySet<number>;
  reserved?: ReadonlySet<number>;
}

export async function readNodeTopology(
  tx: Pick<SqlTx, 'query'>,
  nodeId: string,
  deviceIds: readonly string[],
): Promise<NodeTopology> {
  // proto3 JSON leaves a zero id out: NUMA node 0 has no `id`.
  const numaRows = await tx.query<{
    id: string | null;
    cpus: string | null;
    memory: string | null;
    isolated: string | null;
    reserve: string | null;
  }>(
    `SELECT e->>'id' AS id, e->>'cpus' AS cpus, e->>'memoryBytes' AS memory,
            s.sections->'cpu'->>'isolatedCpus' AS isolated,
            (SELECT p.policy->'hostReserve'->>'vcpu' FROM nodes n JOIN pools p ON p.id = n.pool_id
              WHERE n.id = ni.node_id) AS reserve
       FROM node_inventory ni JOIN inventory_snapshots s ON s.id = ni.applied_snapshot_id,
            jsonb_array_elements(CASE WHEN jsonb_typeof(s.sections->'cpu'->'numaNodes') = 'array'
                                      THEN s.sections->'cpu'->'numaNodes' ELSE '[]'::jsonb END) e
      WHERE ni.node_id = $1`,
    [nodeId],
  );
  const deviceRows = await tx.query<{ id: string; numa: string | null }>(
    `SELECT id, attributes->>'numaNode' AS numa FROM devices WHERE node_id = $1 AND id = ANY($2::text[])`,
    [nodeId, deviceIds],
  );
  const numa = new Map<number, { cpus: number[]; memoryBytes: number }>();
  for (const row of numaRows.rows)
    numa.set(Number(row.id ?? 0), {
      cpus: parseCpuList(row.cpus ?? ''),
      memoryBytes: Number(row.memory ?? 0),
    });
  const deviceNuma = new Map<string, number>();
  for (const row of deviceRows.rows)
    if (row.numa !== null && /^\d+$/.test(row.numa)) deviceNuma.set(row.id, Number(row.numa));
  const first = numaRows.rows[0];
  const isolated = new Set(parseCpuList(first?.isolated ?? ''));
  const count = Number(first?.reserve);
  const reserve =
    first?.reserve !== null && first?.reserve !== undefined && Number.isFinite(count) && count >= 0
      ? Math.floor(count)
      : defaultNodeReserve.vcpu;
  const reserved = new Set(
    [...numa.values()]
      .flatMap((entry) => entry.cpus)
      .filter((cpu) => !isolated.has(cpu))
      .sort((a, b) => a - b)
      .slice(0, reserve),
  );
  return { numa, deviceNuma, isolated, reserved };
}

/**
 * The limits bcd applies to an allocation (§3.8): `cpu.max` from `vcpu`, `memory.max` from
 * `memoryGiB`, 1 GiB hugepages as booked, and a cpuset on the devices' NUMA nodes: `cpus` when those
 * nodes have at least `vcpu` CPUs, `mems` when they hold at least the booked memory (else memory may
 * come from any node rather than OOM on a local one). Undefined when nothing is booked.
 */
export function assignmentLimits(
  resources: Readonly<Record<string, number>>,
  deviceIds: readonly string[],
  topology: NodeTopology,
): ResourceLimits | undefined {
  if (!hostBooked(resources)) return undefined;
  const limits: ResourceLimits = {};
  const vcpu = resources.vcpu ?? 0;
  const memoryBytes = (resources.memoryGiB ?? 0) * 2 ** 30;
  if (vcpu > 0) limits.cpuMillis = vcpu * 1000;
  if (memoryBytes > 0) limits.memoryBytes = memoryBytes;
  if ((resources.hugepages1Gi ?? 0) > 0) limits.hugepages1Gi = resources.hugepages1Gi!;
  const nodes = [...new Set(deviceIds.map((id) => topology.deviceNuma.get(id)))];
  const local = nodes.every((node) => node !== undefined && topology.numa.has(node))
    ? (nodes as number[]).sort((a, b) => a - b).map((node) => [node, topology.numa.get(node)!] as const)
    : [];
  if (local.length > 0) {
    // The host's own CPUs never go to an allocation.
    const cpus = local.flatMap(([, entry]) => entry.cpus).filter((cpu) => !topology.reserved?.has(cpu));
    if (vcpu > 0 && cpus.length >= vcpu) limits.cpus = formatCpuList(cpus);
    const localBytes = local.reduce((sum, [, entry]) => sum + entry.memoryBytes, 0);
    if (memoryBytes > 0 && localBytes >= memoryBytes)
      limits.mems = local.map(([node]) => String(node)).join(',');
  }
  return limits;
}

/**
 * A tenant's reservations, newest first, optionally filtered by state, pool and owner (§9.2: owner-
 * scoped kinds list the caller's own by default). Draft-derived ids are not time-ordered, so pages
 * follow `(created_at, id)`; the cursor is the last reservation's id.
 */
export async function listReservations(
  tx: SqlTx,
  input: {
    tenantId: string;
    state?: ReservationState;
    poolId?: string;
    ownerIdentityId?: string;
    limit?: number;
    cursor?: string;
  },
): Promise<{ items: Reservation[]; cursor?: string }> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const { rows } = await tx.query<RawReservation>(
    `SELECT ${reservationColumns} FROM reservations
      WHERE tenant_id = $1 AND state <> 'draft'
        AND ($2::text IS NULL OR state = $2) AND ($3::text IS NULL OR pool_id = $3)
        AND ($6::text IS NULL OR owner_identity_id = $6)
        AND ($4::text IS NULL OR (created_at, id) <
             (SELECT created_at, id FROM reservations WHERE id = $4 AND tenant_id = $1))
      ORDER BY created_at DESC, id DESC LIMIT $5`,
    [
      input.tenantId,
      input.state ?? null,
      input.poolId ?? null,
      input.cursor ?? null,
      limit + 1,
      input.ownerIdentityId ?? null,
    ],
  );
  const page = rows.slice(0, limit).map(toReservation);
  const items: Reservation[] = [];
  for (const row of page) items.push(await reservationView(tx, row));
  const result: { items: Reservation[]; cursor?: string } = { items };
  if (rows.length > limit) result.cursor = page[page.length - 1]!.id;
  return result;
}

/**
 * Wakes a pool's pending reservations now instead of at their 30 s backoff: capacity freed (a
 * release, cancel or failure) or appeared (a node converged its first spec, was uncordoned or
 * adopted). Capacity calls it on its own releases; node controllers call it on their edges. Oldest
 * first, at most `limit` (placement re-checks everything, so a spurious wake-up is harmless).
 */
export async function wakePendingReservations(
  tx: SqlTx,
  work: ModuleContext['work'],
  poolId: string,
  limit = 50,
): Promise<number> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM reservations WHERE pool_id = $1 AND state = 'pending'
      ORDER BY created_at, id LIMIT $2`,
    [poolId, limit],
  );
  for (const row of rows) await work.enqueue(tx, reservationWork, row.id);
  return rows.length;
}

/** `wakePendingReservations` for every pool a node belongs to (node-controller edges). */
export async function wakePendingForNode(
  tx: SqlTx,
  work: ModuleContext['work'],
  nodeId: string,
): Promise<number> {
  const { rows } = await tx.query<{ pool_id: string | null }>(
    `SELECT pool_id FROM nodes WHERE id = $1`,
    [nodeId],
  );
  const poolId = rows[0]?.pool_id;
  return poolId ? wakePendingReservations(tx, work, poolId) : 0;
}

/** How long before its start a placed reservation's booking is checked and repaired (§10.5). */
export const repairLeadMs = 15 * 60_000;

/**
 * BookingRepair (§10.5, v0.5): checks that every allocation of a placed reservation still sits on a
 * schedulable node with healthy, bookable atoms. A bad booking is released and placed again for the
 * same window, avoiding the bad nodes, with the quota charge kept; if nothing fits, the reservation
 * goes `pending` (`Unschedulable`, reason `BookingRepairFailed`) and retries like any pending one.
 * The pool is locked first, keeping capacity's lock order (pools before node_resources).
 */
export async function repairBooking(
  deps: ReservationDeps,
  tx: SqlTx,
  row: ReservationRow,
): Promise<ReservationRow> {
  if (!row.during) return row;
  await tx.query(`SELECT 1 FROM pools WHERE id = $1 FOR UPDATE`, [row.poolId]);
  // A node lease is judged by leasability; its atoms are all the node's, healthy or not.
  const nodeLease = isNodeBinding(row);
  const { rows } = await tx.query<{ node_id: string; node_ok: boolean; atoms_ok: boolean }>(
    `SELECT a.node_id,
            EXISTS (SELECT 1 FROM nodes n JOIN pools p ON p.id = n.pool_id
                     WHERE n.id = a.node_id
                       AND ${nodeLease ? leasableSqlFor('$2::text[]') : schedulableSqlTolerating('$2::text[]')}) AS node_ok,
            ${nodeLease ? 'true OR ' : ''}NOT EXISTS (SELECT 1 FROM devices d WHERE d.id = ANY(a.atoms)
                         AND NOT (d.healthy AND d.bookable)) AS atoms_ok
       FROM allocations a
      WHERE a.owner_kind = 'reservation' AND a.owner_id = $1 AND a.released_at IS NULL`,
    [row.id, [dedicatedTaint(row.tenantId)]],
  );
  const bad = rows
    .filter((entry) => !entry.node_ok || !entry.atoms_ok)
    .map((entry) => entry.node_id);
  if (rows.length > 0 && bad.length === 0) return row;

  const now = deps.clock.now();
  const allocations = await readOwnerAllocations(tx, { kind: 'reservation', id: row.id });
  for (const allocation of allocations) {
    await releaseAllocation(tx, allocation.id);
    await deps.desired.invalidate(tx, allocation.nodeId);
  }
  const again = { ...placementRequest(row, row.during), excludeNodes: [...new Set(bad)] };
  const outcome = nodeLease
    ? await placeNodeLease(tx, again, deps.placement)
    : await (deps.inline ?? deps.placer).place(tx, again, { ...deps.placement, clock: deps.clock });
  if (outcome.status === 'placed') {
    const conditions = withoutCondition(row.conditions, 'Unschedulable');
    const { rowCount } = await tx.query(
      `UPDATE reservations SET conditions = $3::jsonb, version = version + 1 WHERE id = $1 AND version = $2`,
      [row.id, row.version, JSON.stringify(conditions)],
    );
    if (rowCount === 0)
      throw new ComputeError('CONFLICT', `Reservation ${row.id} changed concurrently`);
    const repaired = { ...row, conditions, version: row.version + 1 };
    await publish(deps, tx, repaired, 'reservation.repaired', {
      from: [...new Set(bad)],
      nodeIds: outcome.allocations.map((allocation) => allocation.nodeId),
    });
    return repaired;
  }
  const reason = outcome.status === 'pending' ? outcome.reason : 'queued';
  const pending = await move(tx, row, 'defer', {
    during: null,
    conditions: withCondition(
      row.conditions,
      { type: 'Unschedulable', status: 'true', reason: 'BookingRepairFailed', message: reason },
      now,
    ),
  });
  await deps.work.enqueue(tx, reservationWork, row.id, { notBefore: now + pendingRetryMs });
  await publish(deps, tx, pending, 'reservation.pending', { reason: 'booking repair failed' });
  return pending;
}
