import {
  ComputeError,
  defineMethod,
  describedBy,
  draftId,
  strictObject,
  type EventPublisher,
  type InputSchema,
  type Json,
  type MethodContext,
  type MethodDefinition,
  type Migration,
  type SqlTx,
} from '@better-compute/core';
import { readAccount } from './accounts.js';
import { isRootCaller } from './billing.js';
import {
  canonical,
  fail,
  id,
  int,
  key as keyOf,
  object,
  optional,
  sha256Hex,
  tenant,
} from './input.js';

// Reservation grants (platform compute billing, D7): root commits `slots` of one provider reservation to a tenant
// for `[startsAt, endsAt)`. The tenant is billed every committed slot-hour of the term, used or not (Task 11), and
// admission (`claimReservationSlot`) serves the grantee from its slots first while keeping them from everyone else.
// The reservation row is the referee: creating a grant and admitting an instance both lock it, so the granted slots
// never exceed the reservation's total and an outsider never takes a slot a grant holds.

export const reservationGrantsMigration: Migration = {
  name: 'vps/0031_reservation_grants',
  sql: `
CREATE TABLE reservation_grants (
  id text PRIMARY KEY,
  account_id text NOT NULL, reservation_id text NOT NULL,
  -- The pool the reservation was bound to when granted (its billing tag; the binding may change later).
  pool_id text NOT NULL REFERENCES pools,
  tenant_id text NOT NULL, project_id text,
  slots int NOT NULL CHECK (slots > 0),
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  state text NOT NULL CHECK (state IN ('scheduled', 'active', 'ended', 'cancelled')),
  metered_until timestamptz NOT NULL,
  created_by text NOT NULL, idempotency_key text NOT NULL, request_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  FOREIGN KEY (account_id, reservation_id) REFERENCES provider_reservations (account_id, reservation_id),
  UNIQUE (created_by, idempotency_key)
);
CREATE INDEX reservation_grants_reservation ON reservation_grants (account_id, reservation_id, starts_at);
CREATE INDEX reservation_grants_tenant ON reservation_grants (tenant_id, created_at);
CREATE INDEX reservation_grants_live ON reservation_grants (starts_at) WHERE state IN ('scheduled', 'active');
ALTER TABLE instances ADD COLUMN reservation_grant_id text REFERENCES reservation_grants;
CREATE INDEX instances_reservation_grant ON instances (reservation_grant_id) WHERE reservation_grant_id IS NOT NULL;
`,
};

export type GrantState = 'scheduled' | 'active' | 'ended' | 'cancelled';

/** A grant as the API shows it. Times are epoch ms. */
export interface ReservationGrantView {
  id: string;
  accountId: string;
  reservationId: string;
  poolId: string;
  /** The grantee. */
  tenantId: string;
  projectId?: string;
  slots: number;
  startsAt: number;
  endsAt: number;
  state: GrantState;
  /** How far the grant's slot-hours have been written as usage. */
  meteredUntil: number;
  createdAt: number;
}

export interface CreateGrantInput {
  /** Root's tenant: only the platform grants. */
  tenantId: string;
  accountId: string;
  reservationId: string;
  grantTenantId: string;
  projectId?: string;
  slots: number;
  startsAt: number;
  endsAt: number;
  idempotencyKey: string;
}
export interface GrantRef {
  tenantId: string;
  grantId: string;
}
export interface EndGrantInput extends GrantRef {
  accountId: string;
}
export interface ListGrantsInput {
  tenantId: string;
  /** Root only: every tenant's grants. */
  all?: boolean;
}

/** How far in the past a grant may start (a request that took a moment to arrive). */
export const grantStartSlackMs = 5 * 60_000;
/** The largest number of slots one grant takes. */
const maxSlots = 100_000;
/** The most grants one `list` returns. */
const listLimit = 1000;

// --- Input -------------------------------------------------------------------------------------

const idOf = (prefix: string, description: string): InputSchema => ({
  type: 'string',
  pattern: `^${prefix}_[0-9a-hjkmnp-tv-z]{26,52}$`,
  maxLength: prefix.length + 53,
  description,
});
const tenantId: InputSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  maxLength: 128,
  description: 'The tenant the call acts in',
};
const epochMs = (description: string): InputSchema => ({
  type: 'integer',
  minimum: 0,
  description,
});
const accountId = idOf('pacct', 'The provider account (root’s) that holds the reservation');
const grantId = idOf('rgrant', 'The grant');

export const grantSchemas = {
  create: strictObject(
    {
      tenantId: { ...tenantId, description: 'The root tenant: only the platform grants' },
      accountId,
      reservationId: {
        type: 'string',
        pattern: '^[A-Za-z0-9._/-]{1,300}$',
        maxLength: 300,
        description: 'The reservation, as providerAccounts.reservations lists it',
      },
      grantTenantId: { ...tenantId, description: 'The tenant the slots are committed to' },
      projectId: idOf('prj', 'Commit the slots to this project of the tenant only'),
      slots: { type: 'integer', minimum: 1, maximum: maxSlots, description: 'Slots committed' },
      startsAt: epochMs('Start of the term, epoch ms; at most 5 minutes in the past'),
      endsAt: epochMs('End of the term (exclusive), epoch ms'),
      idempotencyKey: {
        type: 'string',
        pattern: '^[A-Za-z0-9._:-]{1,128}$',
        maxLength: 128,
        description: 'Scoped to the caller identity: a retry with the same key replays',
      },
    },
    [
      'tenantId',
      'accountId',
      'reservationId',
      'grantTenantId',
      'slots',
      'startsAt',
      'endsAt',
      'idempotencyKey',
    ],
  ),
  get: strictObject({ tenantId, grantId }, ['tenantId', 'grantId']),
  list: strictObject(
    {
      tenantId,
      all: {
        type: 'boolean',
        default: false,
        description: 'Root only (tenantId the root tenant): every tenant’s grants',
      },
    },
    ['tenantId'],
  ),
  end: strictObject({ tenantId, accountId, grantId }, ['tenantId', 'accountId', 'grantId']),
};

const reservationIdPattern = /^[A-Za-z0-9._/-]{1,300}$/;

function epoch(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    fail(`${what} must be a time in epoch milliseconds`);
  return value;
}

export function parseCreateGrant(raw: unknown): CreateGrantInput {
  const input = object(raw, [
    'tenantId',
    'accountId',
    'reservationId',
    'grantTenantId',
    'projectId',
    'slots',
    'startsAt',
    'endsAt',
    'idempotencyKey',
  ]);
  if (typeof input.reservationId !== 'string' || !reservationIdPattern.test(input.reservationId))
    fail('reservationId is invalid');
  const result: CreateGrantInput = {
    tenantId: tenant(input.tenantId),
    accountId: id(input.accountId, 'pacct', 'accountId'),
    reservationId: input.reservationId,
    grantTenantId: tenant(input.grantTenantId, 'grantTenantId'),
    slots: int(input.slots, 'slots', 1, maxSlots),
    startsAt: epoch(input.startsAt, 'startsAt'),
    endsAt: epoch(input.endsAt, 'endsAt'),
    idempotencyKey: keyOf(input.idempotencyKey),
  };
  if (result.endsAt <= result.startsAt) fail('endsAt must be after startsAt');
  const projectId = optional(input.projectId, (value) => id(value, 'prj', 'projectId'));
  if (projectId !== undefined) result.projectId = projectId;
  return result;
}

export function parseGrantRef(raw: unknown): GrantRef {
  const input = object(raw, ['tenantId', 'grantId']);
  return { tenantId: tenant(input.tenantId), grantId: id(input.grantId, 'rgrant', 'grantId') };
}

export function parseEndGrant(raw: unknown): EndGrantInput {
  const input = object(raw, ['tenantId', 'accountId', 'grantId']);
  return {
    tenantId: tenant(input.tenantId),
    accountId: id(input.accountId, 'pacct', 'accountId'),
    grantId: id(input.grantId, 'rgrant', 'grantId'),
  };
}

export function parseListGrants(raw: unknown): ListGrantsInput {
  const input = object(raw, ['tenantId', 'all']);
  const result: ListGrantsInput = { tenantId: tenant(input.tenantId) };
  if (input.all !== undefined) {
    if (typeof input.all !== 'boolean') fail('all must be a boolean');
    if (input.all) result.all = true;
  }
  return result;
}

// --- Rows --------------------------------------------------------------------------------------

interface GrantRow {
  id: string;
  account_id: string;
  reservation_id: string;
  pool_id: string;
  tenant_id: string;
  project_id: string | null;
  slots: number;
  starts: number;
  ends: number;
  state: GrantState;
  metered: number;
  created: number;
  request_hash: string;
}

const ms = (column: string) => `(extract(epoch FROM ${column}) * 1000)::float8`;
const grantColumns = `g.id, g.account_id, g.reservation_id, g.pool_id, g.tenant_id, g.project_id, g.slots,
  ${ms('g.starts_at')} AS starts, ${ms('g.ends_at')} AS ends, g.state, ${ms('g.metered_until')} AS metered,
  ${ms('g.created_at')} AS created, encode(g.request_hash, 'hex') AS request_hash`;
const at$ = (index: number) => `to_timestamp($${index}::float8 / 1000)`;

function viewOf(row: GrantRow): ReservationGrantView {
  const view: ReservationGrantView = {
    id: row.id,
    accountId: row.account_id,
    reservationId: row.reservation_id,
    poolId: row.pool_id,
    tenantId: row.tenant_id,
    slots: Number(row.slots),
    startsAt: Math.round(Number(row.starts)),
    endsAt: Math.round(Number(row.ends)),
    state: row.state,
    meteredUntil: Math.round(Number(row.metered)),
    createdAt: Math.round(Number(row.created)),
  };
  if (row.project_id !== null) view.projectId = row.project_id;
  return view;
}

async function readGrant(
  tx: SqlTx,
  grantIdValue: string,
  options: { lock?: boolean } = {},
): Promise<GrantRow | undefined> {
  const { rows } = await tx.query<GrantRow>(
    `SELECT ${grantColumns} FROM reservation_grants g WHERE g.id = $1 ${options.lock ? 'FOR UPDATE' : ''}`,
    [grantIdValue],
  );
  return rows[0];
}

async function dbNow(tx: SqlTx): Promise<number> {
  const { rows } = await tx.query<{ now: number }>(`SELECT ${ms('compute_now()')} AS now`);
  return Math.round(Number(rows[0]!.now));
}

// --- Dependencies and events -------------------------------------------------------------------

/** What the grant API and the `vps.grants` reconciler need beyond a transaction. */
export interface GrantDeps {
  events: EventPublisher;
  /** The IAM root tenant: only it grants; unknown fails closed. */
  rootTenantId?: string | undefined;
}

async function publish(
  deps: Pick<GrantDeps, 'events'>,
  tx: SqlTx,
  row: GrantRow,
  type: string,
  extra: Record<string, Json> = {},
): Promise<void> {
  // The grantee is told: the commitment is what it is billed for.
  await deps.events.publish(tx, {
    type,
    tenantId: row.tenant_id,
    subject: `reservation-grant/${row.id}`,
    data: {
      grantId: row.id,
      poolId: row.pool_id,
      ...(row.project_id !== null ? { projectId: row.project_id } : {}),
      slots: Number(row.slots),
      startsAt: Math.round(Number(row.starts)),
      endsAt: Math.round(Number(row.ends)),
      ...extra,
    },
  });
}

/** Only the platform grants or ends a grant: the caller must be root's, acting in root's tenant (fails closed). */
function requireRoot(context: MethodContext, deps: GrantDeps, tenantIdValue: string): void {
  if (!isRootCaller(context.caller, deps.rootTenantId) || tenantIdValue !== deps.rootTenantId)
    throw new ComputeError(
      'ACCESS_DENIED',
      'Only the platform grants reservation slots',
      undefined,
      { reason: 'grant-not-platform' },
    );
}

// --- State ------------------------------------------------------------------------------------

/**
 * Moves grants to the state their term says at `now`: `scheduled` → `active` at `starts_at`, `active` → `ended` at
 * `ends_at` (a grant whose whole term passed unseen goes through both). Publishes `reservation-grant.active` and
 * `reservation-grant.ended`. `onlyIds` limits it to those grants (the API's own); the reconciler passes none.
 * Returns the grants that ended.
 */
export async function settleGrantStates(
  deps: Pick<GrantDeps, 'events'>,
  tx: SqlTx,
  now: number,
  onlyIds?: readonly string[],
): Promise<GrantRow[]> {
  const { rows } = await tx.query<GrantRow>(
    `SELECT ${grantColumns} FROM reservation_grants g
      WHERE g.state IN ('scheduled', 'active') AND g.starts_at <= ${at$(1)}
        ${onlyIds ? 'AND g.id = ANY($2::text[])' : ''}
      ORDER BY g.starts_at, g.id FOR UPDATE`,
    onlyIds ? [now, onlyIds] : [now],
  );
  const ended: GrantRow[] = [];
  for (const row of rows) {
    const done = Number(row.ends) <= now;
    const state: GrantState = done ? 'ended' : 'active';
    if (state === row.state) continue;
    await tx.query(`UPDATE reservation_grants SET state = $2 WHERE id = $1`, [row.id, state]);
    if (row.state === 'scheduled') await publish(deps, tx, row, 'reservation-grant.active');
    if (done) {
      await publish(deps, tx, row, 'reservation-grant.ended');
      ended.push({ ...row, state });
    }
  }
  return ended;
}

// --- The API ---------------------------------------------------------------------------------

const code = (error: unknown): string | undefined => (error as { code?: string } | undefined)?.code;

const requestHash = (input: CreateGrantInput) =>
  sha256Hex(
    canonical({
      accountId: input.accountId,
      reservationId: input.reservationId,
      grantTenantId: input.grantTenantId,
      projectId: input.projectId,
      slots: input.slots,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
    }),
  );

/** Locks the reservation row: grants and admissions against it are decided one at a time. */
async function lockReservationRow(
  tx: SqlTx,
  accountIdValue: string,
  reservationIdValue: string,
): Promise<
  | {
      total: number;
      pool_id: string | null;
      gone: boolean;
      state: string | null;
    }
  | undefined
> {
  const { rows } = await tx.query<{
    total: number;
    pool_id: string | null;
    gone: boolean;
    state: string | null;
  }>(
    `SELECT total, pool_id, gone_at IS NOT NULL AS gone, reservation->>'state' AS state
       FROM provider_reservations WHERE account_id = $1 AND reservation_id = $2 FOR UPDATE`,
    [accountIdValue, reservationIdValue],
  );
  return rows[0];
}

/**
 * `reservationGrants.create` (root only): commits `slots` of a ready reservation, bound to a pool offered to the
 * grantee, for `[startsAt, endsAt)`. Under the reservation row lock, the slots of every grant (not cancelled) whose
 * term overlaps plus these must fit the reservation's `total`, or `CAPACITY_UNAVAILABLE` `{ total, granted }`.
 * A retry with the same key replays; another request under it is `CONFLICT`.
 */
export async function createGrant(
  deps: GrantDeps,
  context: MethodContext,
  input: CreateGrantInput,
): Promise<ReservationGrantView> {
  requireRoot(context, deps, input.tenantId);
  const tx = context.sql;
  const caller = context.caller!;
  const grantIdValue = await draftId(
    'rgrant',
    input.tenantId,
    caller.identityId,
    input.idempotencyKey,
  );
  const hash = await requestHash(input);
  const existing = await readGrant(tx, grantIdValue);
  if (existing) {
    if (existing.request_hash !== hash)
      throw new ComputeError('CONFLICT', 'This idempotency key was used for a different request');
    return viewOf(existing);
  }
  const now = await dbNow(tx);
  if (input.startsAt < now - grantStartSlackMs)
    fail('startsAt must be at most 5 minutes in the past');
  if (!(await readAccount(tx, input.accountId, input.tenantId)))
    throw new ComputeError('NOT_FOUND', `Provider account ${input.accountId} not found`);
  const reservation = await lockReservationRow(tx, input.accountId, input.reservationId);
  if (!reservation)
    throw new ComputeError('NOT_FOUND', `Reservation ${input.reservationId} not found`);
  if (reservation.gone || reservation.state !== 'ready')
    throw new ComputeError(
      'INVALID_STATE',
      `Reservation ${input.reservationId} is ${reservation.gone ? 'gone' : reservation.state}, not ready`,
      undefined,
      { reservationId: input.reservationId, state: reservation.gone ? 'gone' : reservation.state },
    );
  if (reservation.pool_id === null)
    throw new ComputeError(
      'INVALID_STATE',
      `Reservation ${input.reservationId} is not bound to a pool; bindReservation first`,
      undefined,
      { reservationId: input.reservationId, state: 'unbound' },
    );
  const offered = await tx.query(
    `SELECT 1 FROM pool_offers o JOIN pools p ON p.id = o.pool_id
      WHERE o.pool_id = $1 AND o.tenant_id = $2 AND p.archived_at IS NULL`,
    [reservation.pool_id, input.grantTenantId],
  );
  if (offered.rows.length === 0)
    throw new ComputeError(
      'INVALID_INPUT',
      `Pool ${reservation.pool_id} of reservation ${input.reservationId} is not offered to ${input.grantTenantId}`,
      undefined,
      { reason: 'pool-not-offered', poolId: reservation.pool_id },
    );
  // Every grant that is not cancelled counts while its term overlaps, an ended one included (its end is real).
  const { rows: sums } = await tx.query<{ granted: number | string }>(
    `SELECT coalesce(sum(slots), 0) AS granted FROM reservation_grants
      WHERE account_id = $1 AND reservation_id = $2 AND state <> 'cancelled'
        AND starts_at < ${at$(4)} AND ends_at > ${at$(3)}`,
    [input.accountId, input.reservationId, input.startsAt, input.endsAt],
  );
  const granted = Number(sums[0]?.granted ?? 0);
  const total = Number(reservation.total);
  if (granted + input.slots > total)
    throw new ComputeError(
      'CAPACITY_UNAVAILABLE',
      `Reservation ${input.reservationId} has ${Math.max(0, total - granted)} of ${total} slots left to grant over that term`,
      undefined,
      { reservationId: input.reservationId, total, granted },
    );
  try {
    await tx.query(
      `INSERT INTO reservation_grants (id, account_id, reservation_id, pool_id, tenant_id, project_id, slots,
                                       starts_at, ends_at, state, metered_until, created_by, idempotency_key,
                                       request_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, ${at$(8)}, ${at$(9)}, 'scheduled', ${at$(8)}, $10, $11, decode($12, 'hex'))`,
      [
        grantIdValue,
        input.accountId,
        input.reservationId,
        reservation.pool_id,
        input.grantTenantId,
        input.projectId ?? null,
        input.slots,
        input.startsAt,
        input.endsAt,
        caller.identityId,
        input.idempotencyKey,
        hash,
      ],
    );
  } catch (error) {
    if (code(error) === '23505')
      throw new ComputeError(
        'CONFLICT',
        'This idempotency key is already being used by a concurrent request',
      );
    throw error;
  }
  const row = (await readGrant(tx, grantIdValue))!;
  await publish(deps, tx, row, 'reservation-grant.created', {
    accountId: input.accountId,
    reservationId: input.reservationId,
  });
  await settleGrantStates(deps, tx, now, [grantIdValue]);
  return viewOf((await readGrant(tx, grantIdValue))!);
}

/**
 * `reservationGrants.end` (root only): `ends_at` becomes now (never later than it was, never before what was already
 * billed): past hours stay billed and later ones are not. A grant that has not started yet is cancelled instead.
 * Ending an ended or cancelled grant returns it unchanged.
 */
export async function endGrant(
  deps: GrantDeps,
  context: MethodContext,
  input: EndGrantInput,
): Promise<ReservationGrantView> {
  requireRoot(context, deps, input.tenantId);
  const tx = context.sql;
  const notFound = () => new ComputeError('NOT_FOUND', `Grant ${input.grantId} not found`);
  if (!(await readAccount(tx, input.accountId, input.tenantId))) throw notFound();
  const first = await readGrant(tx, input.grantId);
  if (!first || first.account_id !== input.accountId) throw notFound();
  // The reservation row first, as create and admission take it, then the grant.
  await lockReservationRow(tx, first.account_id, first.reservation_id);
  const row = (await readGrant(tx, input.grantId, { lock: true }))!;
  if (row.state === 'ended' || row.state === 'cancelled') return viewOf(row);
  const now = await dbNow(tx);
  if (Number(row.starts) >= now) {
    await tx.query(`UPDATE reservation_grants SET state = 'cancelled' WHERE id = $1`, [row.id]);
    await publish(deps, tx, row, 'reservation-grant.cancelled');
    return viewOf((await readGrant(tx, row.id))!);
  }
  await tx.query(
    `UPDATE reservation_grants SET ends_at = LEAST(ends_at, GREATEST(metered_until, ${at$(2)})) WHERE id = $1`,
    [row.id, now],
  );
  await settleGrantStates(deps, tx, now, [row.id]);
  return viewOf((await readGrant(tx, row.id))!);
}

/** `reservationGrants.get`: a grant of the tenant, or (root, in root's tenant) any grant. */
export async function getGrant(
  deps: GrantDeps,
  context: MethodContext,
  input: GrantRef,
): Promise<ReservationGrantView> {
  const row = await readGrant(context.sql, input.grantId);
  const root =
    isRootCaller(context.caller, deps.rootTenantId) && input.tenantId === deps.rootTenantId;
  if (!row || (row.tenant_id !== input.tenantId && !root))
    throw new ComputeError('NOT_FOUND', `Grant ${input.grantId} not found`);
  return viewOf(row);
}

/** `reservationGrants.list`: the tenant's grants, newest first; root with `all` sees every tenant's. */
export async function listGrants(
  deps: GrantDeps,
  context: MethodContext,
  input: ListGrantsInput,
): Promise<{ items: ReservationGrantView[] }> {
  if (input.all) requireRoot(context, deps, input.tenantId);
  const { rows } = await context.sql.query<GrantRow>(
    `SELECT ${grantColumns} FROM reservation_grants g
      ${input.all ? '' : 'WHERE g.tenant_id = $2'}
      ORDER BY g.created_at DESC, g.id LIMIT $1`,
    input.all ? [listLimit] : [listLimit, input.tenantId],
  );
  return { items: rows.map(viewOf) };
}

export type ReservationGrantsApi = {
  create: MethodDefinition<CreateGrantInput, ReservationGrantView>;
  get: MethodDefinition<GrantRef, ReservationGrantView>;
  list: MethodDefinition<ListGrantsInput, { items: ReservationGrantView[] }>;
  end: MethodDefinition<EndGrantInput, ReservationGrantView>;
};

const accountResource = <I extends { accountId: string }>(input: I) => ({
  type: 'provider-account',
  id: input.accountId,
});
const tenantResource = <I extends { tenantId: string }>(input: I) => ({
  type: 'tenant',
  id: input.tenantId,
});

/** The `reservationGrants` group. `deps` resolves the events port and the IAM root tenant per call. */
export function reservationGrantsApi(
  deps: (context: MethodContext) => GrantDeps,
): ReservationGrantsApi {
  return {
    create: defineMethod({
      action: 'compute:providers:manage',
      kind: 'mutation',
      resource: accountResource,
      validate: describedBy(grantSchemas.create, parseCreateGrant),
      handler: (context, input) => createGrant(deps(context), context, input),
    }),
    get: defineMethod({
      action: 'compute:quotas:read',
      kind: 'read',
      resource: tenantResource,
      validate: describedBy(grantSchemas.get, parseGrantRef),
      handler: (context, input) => getGrant(deps(context), context, input),
    }),
    list: defineMethod({
      action: 'compute:quotas:read',
      kind: 'read',
      resource: tenantResource,
      validate: describedBy(grantSchemas.list, parseListGrants),
      handler: (context, input) => listGrants(deps(context), context, input),
    }),
    end: defineMethod({
      action: 'compute:providers:manage',
      kind: 'mutation',
      resource: accountResource,
      validate: describedBy(grantSchemas.end, parseEndGrant),
      handler: (context, input) => endGrant(deps(context), context, input),
    }),
  };
}
