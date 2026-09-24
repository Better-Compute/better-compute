import {
  ComputeError,
  draftId,
  isComputeError,
  isId,
  parseDuration,
  reservationStateTable,
  transition,
  type AdmissionPlan,
  type AuthzAttributes,
  type Clock,
  type Condition,
  type DeviceClass,
  type DeviceRequest,
  type EventPublisher,
  type HoldBinding,
  type Json,
  type MethodContext,
  type ModuleContext,
  type PlacementContext,
  type Placer,
  type Reservation,
  type ReservationSpec,
  type ReservationState,
  type ReservationVerb,
  type SchedulerPlugin,
  type SqlTx,
  type TimeRange,
} from '@better-compute/core';
import {
  extendAllocation,
  readOwnerAllocations,
  releaseAllocation,
  type AllocationRecord,
} from './bookings.js';
import { chargeQuota, quotaDemand, refundQuota } from './quota.js';
import { assertSelector } from './selector.js';

// Reservations (PLAN.md §3.4, §10.5): request-as-resource drafts decided by IAM, placed by the
// Placer in the second transaction, then driven by the `capacity.reservations` reconciler through
// start → binding → active → releasing → released. Quota is held from placement or pending until the
// reservation is terminal (D9).

/** The work-queue kind of the reservation lifecycle reconciler. */
export const reservationWork = 'capacity.reservations';

const tenantPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const keyPattern = /^[A-Za-z0-9._:-]{1,128}$/;
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
  binding: 'hold';
  leaseSeconds?: number;
  idempotencyKey: string;
  wait?: { timeoutMs: number };
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
      'leaseSeconds',
      'spot',
      'idempotencyKey',
      'wait',
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
    if (device.sharing !== undefined && device.sharing !== 'exclusive')
      throw new ComputeError('UNSUPPORTED', 'Shared GPUs (mig, timeslice, mps) arrive in v0.5');
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

  if (input.binding !== undefined && input.binding !== 'hold')
    throw new ComputeError(
      'UNSUPPORTED',
      `binding ${String(input.binding)} arrives later (instance: v0.3, node: v0.5)`,
    );
  if (input.spot !== undefined && input.spot !== false)
    throw new ComputeError('UNSUPPORTED', 'Spot reservations arrive in v0.5');

  const result: CreateReservationInput = {
    tenantId,
    poolId,
    devices,
    duration,
    binding: 'hold',
    idempotencyKey: string(input.idempotencyKey, keyPattern, 'idempotencyKey'),
  };
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

/** The public view: the row plus the `hold` binding once a node reported it. */
export async function reservationView(tx: SqlTx, row: ReservationRow): Promise<Reservation> {
  const { requestHash: _hash, ...reservation } = row;
  const view: Reservation = { ...reservation };
  if (row.state === 'active' || row.state === 'binding') {
    const { rows } = await tx.query<{ node_id: string; binding: Json | string | null }>(
      `SELECT node_id, binding FROM allocations
        WHERE owner_kind = 'reservation' AND owner_id = $1 AND released_at IS NULL
          AND bound_at IS NOT NULL ORDER BY id LIMIT 1`,
      [row.id],
    );
    const bound = rows[0];
    if (bound) {
      const binding = json(bound.binding) as { cdiDevices?: string[]; envFile?: string } | null;
      const hold: HoldBinding = {
        nodeId: bound.node_id,
        cdiDevices: binding?.cdiDevices ?? [],
        envFile: binding?.envFile ?? '',
      };
      view.binding = hold;
    }
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
  { id: string; ownerTenantId: string; gpuModel?: string; region: string; policy: Json } | undefined
> {
  const { rows } = await tx.query<{
    id: string;
    owner_tenant_id: string;
    gpu_model: string | null;
    region: string;
    policy: Json | string;
  }>(
    `SELECT p.id, p.owner_tenant_id, p.gpu_model, s.region, p.policy
       FROM pools p JOIN sites s ON s.id = p.site_id
      WHERE p.id = $1 AND (p.owner_tenant_id = $2
            OR EXISTS (SELECT 1 FROM pool_offers o WHERE o.pool_id = p.id AND o.tenant_id = $2))`,
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
  } = {
    id: row.id,
    ownerTenantId: row.owner_tenant_id,
    region: row.region,
    policy: json(row.policy),
  };
  if (row.gpu_model !== null) pool.gpuModel = row.gpu_model;
  return pool;
}

/** The attributes IAM policies read on a reservation (§12.3), e.g. `ReserveBoundedH100`. */
export function reservationAttributes(
  spec: ReservationSpec,
  pool: { gpuModel?: string; region: string },
  durationMs: number,
): AuthzAttributes {
  const attributes: AuthzAttributes = {
    gpuModel: pool.gpuModel ?? 'other',
    gpuCount: spec.devices
      .filter((device) => device.class.startsWith('gpu'))
      .reduce((sum, device) => sum + device.count, 0),
    durationHours: Math.round((durationMs / hour) * 1000) / 1000,
    region: pool.region,
    binding: spec.binding ?? 'hold',
    spot: spec.spot ?? false,
    renewable: spec.leaseSeconds !== undefined,
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
  placement: Omit<PlacementContext, 'clock' | 'admission'>;
}

/** Scheduler plugins, weights, top-N and randomness for the placer. */
export interface PlacementOptions {
  plugins?: readonly SchedulerPlugin[];
  weights?: Readonly<Record<string, number>>;
  topN?: number;
  random?: () => number;
}

async function publish(
  deps: ReservationDeps,
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
  const id =
    existing?.id ?? (await draftId('rsv', input.tenantId, caller.identityId, input.idempotencyKey));
  const spec = reservationSpec(input);
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

function placementRequest(row: ReservationRow, during: TimeRange) {
  return {
    tenantId: row.tenantId,
    poolId: row.poolId,
    ...(row.projectId !== undefined ? { projectId: row.projectId } : {}),
    reservationId: row.id,
    devices: row.request.devices,
    ...(row.request.topology !== undefined ? { topology: row.request.topology } : {}),
    during,
  };
}

function requestedDuration(row: ReservationRow): number {
  return parseDuration(row.request.duration);
}

/** Places a draft or pending reservation now; `placed` or `pending` (with `Unschedulable`). */
async function attemptPlacement(
  deps: ReservationDeps,
  tx: SqlTx,
  row: ReservationRow,
  admission?: MethodContext['admission'],
): Promise<ReservationRow> {
  const now = deps.clock.now();
  const start = Math.max(row.request.start ?? now, now);
  const during = { start, end: start + requestedDuration(row) };
  const outcome = await deps.placer.place(tx, placementRequest(row, during), {
    ...deps.placement,
    clock: deps.clock,
    ...(admission ? { admission } : {}),
  });
  if (outcome.status === 'placed') {
    const conditions = withoutCondition(row.conditions, 'Unschedulable');
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
  const reason = outcome.status === 'pending' ? outcome.reason : 'queued for the pool placer';
  const conditions = withCondition(
    row.conditions,
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
  await publish(deps, tx, pending, 'reservation.pending', { reason });
  return pending;
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
  await chargeQuota(tx, row.tenantId, row.poolId, quotaDemand(row.request));
  const next = await attemptPlacement(deps, tx, row, context.admission);
  return reservationView(tx, next);
}

async function releaseBookings(
  tx: SqlTx,
  row: ReservationRow,
  deps: ReservationDeps,
): Promise<AllocationRecord[]> {
  const allocations = await readOwnerAllocations(tx, { kind: 'reservation', id: row.id });
  for (const allocation of allocations) {
    await releaseAllocation(tx, allocation.id);
    await deps.desired.invalidate(tx, allocation.nodeId);
  }
  return allocations;
}

/**
 * Ends a reservation: bookings released at compute_now(), quota refunded, node specs invalidated,
 * and the terminal state recorded. `placed`/`binding`/`active` go through `releasing` to `released`;
 * `pending` is `cancelled`; terminal states are returned unchanged (idempotent).
 */
export async function endReservation(
  deps: ReservationDeps,
  tx: SqlTx,
  row: ReservationRow,
  why: 'release' | 'expired' | 'lease-lapsed',
): Promise<ReservationRow> {
  if (reservationStateTable.terminal.includes(row.state)) return row;
  if (row.state === 'draft' || row.state === 'awaiting-confirmation')
    throw new ComputeError('INVALID_STATE', `Reservation ${row.id} is ${row.state}`);
  await refundQuota(tx, row.tenantId, row.poolId, quotaDemand(row.request));
  await releaseBookings(tx, row, deps);
  let next: ReservationRow;
  if (row.state === 'pending') next = await move(tx, row, 'cancel');
  else if (row.state === 'releasing') next = await move(tx, row, 'complete');
  else {
    const releasing = await move(tx, row, 'release');
    next = await move(tx, releasing, 'complete');
  }
  await publish(deps, tx, next, `reservation.${next.state}`, { reason: why });
  return next;
}

async function failReservation(
  deps: ReservationDeps,
  tx: SqlTx,
  row: ReservationRow,
  condition: Omit<Condition, 'since'>,
): Promise<ReservationRow> {
  await refundQuota(tx, row.tenantId, row.poolId, quotaDemand(row.request));
  await releaseBookings(tx, row, deps);
  const failed = await move(tx, row, 'fail', {
    conditions: withCondition(row.conditions, condition, deps.clock.now()),
  });
  await publish(deps, tx, failed, 'reservation.failed', { reason: condition.reason ?? '' });
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
  await refundQuota(tx, row.tenantId, row.poolId, quotaDemand(row.request));
  await releaseBookings(tx, row, deps);
  const cancelled = await move(tx, row, 'cancel');
  await publish(deps, tx, cancelled, 'reservation.cancelled');
  return reservationView(tx, cancelled);
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
  const gpuCount = row.request.devices
    .filter((device) => device.class.startsWith('gpu'))
    .reduce((sum, device) => sum + device.count, 0);
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

/** `reservations.extend` after a refusal: clear the pending change. */
export async function denyPending(
  context: MethodContext,
  input: { tenantId: string; reservationId: string },
  tx: SqlTx,
): Promise<void> {
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
  if (!extendable.includes(row.state) || !row.during) {
    await context.authz.setPending(tx, ref, null);
    throw new ComputeError('INVALID_STATE', `Reservation ${row.id} is ${row.state}`);
  }
  const end = targetEnd(row, input);
  if (end <= row.during.end) {
    await context.authz.setPending(tx, ref, null);
    return { reservation: await reservationView(tx, row), extended: false };
  }
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

/**
 * Records a node's `AllocationBound` report (the gateway calls it) and wakes the lifecycle.
 * Returns `false` when the allocation is unknown or released.
 */
export async function markAllocationBound(
  tx: SqlTx,
  work: ModuleContext['work'],
  allocationId: string,
  binding: { cdiDevices: readonly string[]; envFile?: string },
): Promise<boolean> {
  const { rows } = await tx.query<{ owner_id: string; owner_kind: string }>(
    `UPDATE allocations SET binding = $2::jsonb, bound_at = COALESCE(bound_at, compute_now()),
                            version = version + 1
      WHERE id = $1 AND released_at IS NULL RETURNING owner_id, owner_kind`,
    [
      allocationId,
      JSON.stringify({ cdiDevices: [...binding.cdiDevices], envFile: binding.envFile ?? '' }),
    ],
  );
  return wakeOwner(tx, work, rows[0]);
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
 * gets `Degraded` (`BindingLost`) until the node reports it bound again.
 */
export async function markAllocationReleased(
  tx: SqlTx,
  work: ModuleContext['work'],
  allocationId: string,
): Promise<boolean> {
  const { rows } = await tx.query<{ owner_id: string; owner_kind: string }>(
    `UPDATE allocations SET binding = COALESCE(binding, '{}'::jsonb) || '{"lost": true}'::jsonb,
                            bound_at = NULL, version = version + 1
      WHERE id = $1 AND released_at IS NULL AND bound_at IS NOT NULL RETURNING owner_id, owner_kind`,
    [allocationId],
  );
  return wakeOwner(tx, work, rows[0]);
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
    await endReservation(deps, tx, row, 'expired');
    return undefined;
  }
  const wake = (at: number) =>
    Math.min(at, row.during!.end, row.leaseExpiresAt ?? Number.POSITIVE_INFINITY);

  if (row.state === 'placed') {
    if (row.during.start > now) return wake(row.during.start);
    const binding = await move(tx, row, 'start');
    const allocations = await readOwnerAllocations(tx, { kind: 'reservation', id });
    for (const allocation of allocations) await deps.desired.invalidate(tx, allocation.nodeId);
    await publish(deps, tx, binding, 'reservation.binding');
    return wake(now + bindTimeoutMs);
  }

  if (row.state === 'binding') {
    const { rows } = await tx.query<{
      total: string | number;
      bound: string | number;
      failed: string | number;
    }>(
      `SELECT count(*) AS total, count(bound_at) AS bound,
              count(*) FILTER (WHERE binding ? 'failed') AS failed
         FROM allocations
        WHERE owner_kind = 'reservation' AND owner_id = $1 AND released_at IS NULL`,
      [id],
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
    if (!rejected && now - row.during.start < bindTimeoutMs)
      return wake(row.during.start + bindTimeoutMs);
    const previous = row.conditions.find((entry) => entry.type === 'BindTimeout');
    const attempts = Number(previous?.message ?? 0) + 1;
    const condition = {
      type: 'BindTimeout',
      status: 'true' as const,
      reason: rejected ? 'NodeRejectedBinding' : 'NodeDidNotBind',
      message: String(attempts),
    };
    if (attempts > maxBindRetries) {
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

  // active: Degraded while a node reports it lost an assignment it had bound.
  const { rows } = await tx.query<{ lost: string | number }>(
    `SELECT count(*) FILTER (WHERE binding ? 'lost' AND bound_at IS NULL) AS lost FROM allocations
      WHERE owner_kind = 'reservation' AND owner_id = $1 AND released_at IS NULL`,
    [id],
  );
  const conditions =
    Number(rows[0]?.lost ?? 0) > 0
      ? withCondition(
          row.conditions,
          {
            type: 'Degraded',
            status: 'true',
            reason: 'BindingLost',
            message: 'a node dropped the devices',
          },
          now,
        )
      : withoutCondition(row.conditions, 'Degraded');
  await setConditions(tx, row, conditions);
  return wake(row.during.end);
}

/**
 * The `devices` section of a node's spec (§7.3): CDI assignments for every reservation that has
 * started on it (`binding` or `active`), each ending at the booking's end.
 */
export async function deviceAssignments(
  tx: SqlTx,
  nodeId: string,
): Promise<{ allocationId: string; deviceIds: string[]; until: number }[]> {
  const { rows } = await tx.query<{ id: string; atoms: string[]; end_ms: number }>(
    `SELECT a.id, a.atoms, (extract(epoch FROM upper(a.during)) * 1000)::float8 AS end_ms
       FROM allocations a JOIN reservations r ON r.id = a.owner_id AND a.owner_kind = 'reservation'
      WHERE a.node_id = $1 AND a.released_at IS NULL AND r.state IN ('binding', 'active')
        AND cardinality(a.atoms) > 0
      ORDER BY a.id`,
    [nodeId],
  );
  return rows.map((row) => ({
    allocationId: row.id,
    deviceIds: [...row.atoms],
    until: Number(row.end_ms),
  }));
}

/** A tenant's reservations, newest first, optionally filtered by state; keyset-paginated by id. */
export async function listReservations(
  tx: SqlTx,
  input: {
    tenantId: string;
    state?: ReservationState;
    poolId?: string;
    limit?: number;
    cursor?: string;
  },
): Promise<{ items: Reservation[]; cursor?: string }> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const { rows } = await tx.query<RawReservation>(
    `SELECT ${reservationColumns} FROM reservations
      WHERE tenant_id = $1 AND state <> 'draft'
        AND ($2::text IS NULL OR state = $2) AND ($3::text IS NULL OR pool_id = $3)
        AND ($4::text IS NULL OR id < $4)
      ORDER BY id DESC LIMIT $5`,
    [input.tenantId, input.state ?? null, input.poolId ?? null, input.cursor ?? null, limit + 1],
  );
  const page = rows.slice(0, limit).map(toReservation);
  const items: Reservation[] = [];
  for (const row of page) items.push(await reservationView(tx, row));
  const result: { items: Reservation[]; cursor?: string } = { items };
  if (rows.length > limit) result.cursor = page[page.length - 1]!.id;
  return result;
}
