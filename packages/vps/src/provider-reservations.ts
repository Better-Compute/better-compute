import {
  ComputeError,
  isComputeError,
  parseDuration,
  type CallContext,
  type Clock,
  type Duration,
  type EventPublisher,
  type ExternalReservation,
  type Json,
  type Logger,
  type Migration,
  type ModuleContext,
  type Reconciler,
  type SecretResolver,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { readAccount, type ClientDeps, type ProviderClients } from './accounts.js';
import { createFlavor, deleteFlavor } from './flavors.js';
import { checkGrantCapacity, reservationGone } from './reservation-grants.js';
import { key as keyOf, name, object, optional, tenant, id } from './input.js';

// Provider capacity reservations (GCE reservations and the like): the `vps.reservations` worker
// reads what each account's provider reports into `provider_reservations`, publishes
// `provider.reservation.*` events, and `providerAccounts.bindReservation` turns a reservation into a
// flavor of a provider pool. Admission is refereed by the database: `claimReservationSlot` locks the
// reservation row, so concurrent creates cannot both take the last slot between two polls.

/** The work kind of the reservations worker (keys: `all` or a provider account id). */
export const reservationsWork = 'vps.reservations';

/**
 * `provider_reservations`: what each account's provider reported, per reservation. `provider_reservation`
 * on an instance names the reservation it was admitted against; `provider_reservation_at` is when its
 * machine first became known to better-compute (set by the lifecycle), which tells whether a scan
 * could already have counted it. `provider_reservation_scans` is the worker's next-pass bookkeeping.
 */
export const providerReservationsMigration: Migration = {
  name: 'vps/0025_provider_reservations',
  sql: `
CREATE TABLE provider_reservations (
  account_id text NOT NULL REFERENCES provider_accounts ON DELETE CASCADE,
  reservation_id text NOT NULL,
  reservation jsonb NOT NULL,
  total int NOT NULL,
  in_use int NOT NULL,
  observed_at timestamptz NOT NULL,
  gone_at timestamptz,
  pool_id text REFERENCES pools,
  flavor_id text REFERENCES flavors ON DELETE SET NULL,
  PRIMARY KEY (account_id, reservation_id)
);
CREATE INDEX provider_reservations_offer ON provider_reservations (account_id, (reservation->>'offerId'));
CREATE TABLE provider_reservation_scans (
  account_id text PRIMARY KEY REFERENCES provider_accounts ON DELETE CASCADE,
  next_at timestamptz NOT NULL,
  last_ok_at timestamptz,
  last_error text
);
ALTER TABLE instances ADD COLUMN provider_reservation text;
ALTER TABLE instances ADD COLUMN provider_reservation_at timestamptz;
CREATE INDEX instances_provider_reservation ON instances (provider_account_id, provider_reservation)
  WHERE provider_reservation IS NOT NULL AND state NOT IN ('deleted', 'failed');
`,
};

/** A reservation as the API shows it. */
export interface ProviderReservationView extends ExternalReservation {
  accountId: string;
  /** `total - inUse - pending`, never below 0: slots a new instance can still take. */
  free: number;
  /** Instances admitted against it whose machine the last scan may not have counted yet. */
  pending: number;
  poolId?: string;
  flavorId?: string;
  /** When the provider was last asked (epoch ms). */
  observedAt: number;
  goneAt?: number;
}

export interface ReservationsOptions {
  /** How often each account is scanned (default `5m`). */
  every?: Duration;
}

interface ReservationRow {
  reservation_id: string;
  reservation: ExternalReservation | string;
  total: number;
  in_use: number;
  observed_at: Date;
  gone_at: Date | null;
  pool_id: string | null;
  flavor_id: string | null;
}

const rowColumns = `reservation_id, reservation, total, in_use, observed_at, gone_at, pool_id, flavor_id`;

function reservationOf(row: ReservationRow): ExternalReservation {
  return typeof row.reservation === 'string'
    ? (JSON.parse(row.reservation) as ExternalReservation)
    : row.reservation;
}

/**
 * Instances admitted against a reservation whose machine a scan may not have counted: the machine is
 * not created yet, or it became known (or the instance was admitted) after the scan began. Errored
 * instances that never got a machine hold nothing, nor do ones whose create the provider failed
 * (`ProvisionFailed`: it accepted the create, then refused it).
 */
const pendingCondition = `i.state NOT IN ('deleted', 'failed', 'lost')
  AND NOT (i.state = 'error' AND i.external_id IS NULL)
  AND NOT (i.state = 'error' AND i.conditions @> '[{"type":"ProvisionFailed","status":"true"}]'::jsonb)
  AND (i.external_id IS NULL OR i.created_at > r.observed_at OR i.provider_reservation_at > r.observed_at)`;

async function pendingByReservation(tx: SqlTx, accountId: string): Promise<Map<string, number>> {
  const { rows } = await tx.query<{ reservation_id: string; pending: number | string }>(
    `SELECT r.reservation_id, count(*) AS pending
       FROM provider_reservations r
       JOIN instances i ON i.provider_account_id = r.account_id AND i.provider_reservation = r.reservation_id
      WHERE r.account_id = $1 AND ${pendingCondition}
      GROUP BY r.reservation_id`,
    [accountId],
  );
  return new Map(rows.map((row) => [row.reservation_id, Number(row.pending)]));
}

function viewOf(accountId: string, row: ReservationRow, pending: number): ProviderReservationView {
  const view: ProviderReservationView = {
    ...reservationOf(row),
    // The counts are the scan's, kept as plain columns too; they agree.
    total: Number(row.total),
    inUse: Number(row.in_use),
    accountId,
    free: Math.max(0, Number(row.total) - Number(row.in_use) - pending),
    pending,
    observedAt: row.observed_at.getTime(),
  };
  if (row.pool_id !== null) view.poolId = row.pool_id;
  if (row.flavor_id !== null) view.flavorId = row.flavor_id;
  if (row.gone_at !== null) view.goneAt = row.gone_at.getTime();
  return view;
}

// --- The worker ---------------------------------------------------------------------------------------

/** What the reservations worker needs beyond a transaction. */
export interface ReservationDeps {
  clock: Clock;
  events: EventPublisher;
  work: ModuleContext['work'];
  log: Logger;
  secrets: SecretResolver;
  clients: ProviderClients;
  /** The IAM root tenant: its provider accounts are the platform's (ruling F1). */
  rootTenantId?: string;
  /** The host's workload issuer: provider accounts' identity (`ClientDeps.workload`). */
  workload?: ClientDeps['workload'];
  /** The deployment's GPU meter models (`vps({ billing: { gpuModels } })`): intervals reopened when a reservation goes. */
  meterGpuModels?: readonly string[];
}

/** A pass over one account must stay well inside the reconciler's claim. */
const listBudgetMs = 45_000;
const batchSize = 500;

function everyMs(options: ReservationsOptions): number {
  return parseDuration(options.every ?? '5m');
}

/**
 * Next pass: a little before the periodic `all` tick that follows, so the tick finds the account due
 * (an exact `every` would let the tick arrive just before `next_at`, doubling the period).
 */
const nextAtSql = (param: string) =>
  `compute_now() + make_interval(secs => ${param}::float8 / 1000 * 0.8)`;

/**
 * The reconciler (`shardBy: 'none'`), one name, two key shapes:
 * - `all` (periodic): makes sure every account whose provider implements `listReservations` has a
 *   `provider_reservation_scans` row, and enqueues the accounts that are due;
 * - `<accountId>`: scans that account.
 */
export function providerReservationsReconciler(
  options: ReservationsOptions,
  deps: (context: ModuleContext) => ReservationDeps,
): Reconciler {
  const period = everyMs(options);
  return {
    name: reservationsWork,
    shardBy: 'none',
    periodic: [{ key: 'all', every: options.every ?? '5m' }],
    async run(context, key) {
      const working = deps(context);
      if (key === 'all') await sweepAccounts(working, context.sql);
      else await scanAccount(working, context.sql, key, period, context.signal);
      return 'DONE';
    },
  };
}

async function sweepAccounts(deps: ReservationDeps, sql: SqlExecutor): Promise<void> {
  const ids = await sql.transaction(async (tx) =>
    (await tx.query<{ id: string }>(`SELECT id FROM provider_accounts ORDER BY id`)).rows.map(
      (row) => row.id,
    ),
  );
  const capable: string[] = [];
  for (const accountId of ids) {
    try {
      const account = await sql.transaction((tx) => readAccount(tx, accountId));
      if (!account) continue;
      const client = await deps.clients.client(account, deps);
      if (typeof client.listReservations === 'function') capable.push(accountId);
    } catch (error) {
      // A broken account config is for its owner to fix; it must not stop the others.
      deps.log.warn(`reservations: skipping provider account ${accountId}`, {
        code: isComputeError(error) ? error.code : 'ERROR',
      });
    }
  }
  if (capable.length === 0) return;
  await sql.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO provider_reservation_scans (account_id, next_at)
       SELECT unnest($1::text[]), compute_now() ON CONFLICT (account_id) DO NOTHING`,
      [capable],
    );
    const due = await tx.query<{ account_id: string }>(
      `SELECT account_id FROM provider_reservation_scans
        WHERE account_id = ANY($1::text[]) AND next_at <= compute_now() ORDER BY next_at`,
      [capable],
    );
    const keys = due.rows.map((row) => row.account_id);
    if (keys.length === 0) return;
    if (deps.work.enqueueMany) await deps.work.enqueueMany(tx, reservationsWork, keys);
    else for (const accountId of keys) await deps.work.enqueue(tx, reservationsWork, accountId);
  });
}

async function recordFailure(
  deps: ReservationDeps,
  sql: SqlExecutor,
  accountId: string,
  error: unknown,
  period: number,
): Promise<void> {
  const code = isComputeError(error) ? error.code : 'PROVIDER_ERROR';
  const message = `${code}: ${String((error as Error)?.message ?? error)}`.slice(0, 500);
  const retryAfter =
    isComputeError(error, 'RATE_LIMITED') && error.retryAfterMs !== undefined
      ? Math.max(0, error.retryAfterMs)
      : undefined;
  deps.log.warn(`reservations: scan of ${accountId} failed`, { code });
  await sql.transaction(async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE provider_reservation_scans
          SET last_error = $2, next_at = compute_now() + make_interval(secs => $3::float8 / 1000)
        WHERE account_id = $1`,
      [accountId, message, retryAfter ?? period * 0.8],
    );
    // A rate limit defers this account, not the worker.
    if (rowCount && retryAfter !== undefined)
      await deps.work.enqueue(tx, reservationsWork, accountId, {
        notBefore: deps.clock.now() + retryAfter,
      });
  });
}

/** One account: ask the provider outside any transaction, then record the outcome in one. */
async function scanAccount(
  deps: ReservationDeps,
  sql: SqlExecutor,
  accountId: string,
  period: number,
  signal: AbortSignal,
): Promise<void> {
  const account = await sql.transaction((tx) => readAccount(tx, accountId));
  if (!account) return;
  let reported: ExternalReservation[];
  let observedAt: Date;
  try {
    const client = await deps.clients.client(account, deps);
    if (typeof client.listReservations !== 'function') {
      await sql.transaction((tx) =>
        tx.query(`DELETE FROM provider_reservation_scans WHERE account_id = $1`, [accountId]),
      );
      return;
    }
    // The scan describes the provider as of this instant: instances whose machine appeared later
    // are still pending against it.
    observedAt = await sql.transaction(async (tx) => {
      const { rows } = await tx.query<{ now: Date }>(`SELECT compute_now() AS now`);
      return rows[0]!.now;
    });
    const call: CallContext = {
      idempotencyKey: `reservations:${accountId}`,
      signal: AbortSignal.any([signal, AbortSignal.timeout(listBudgetMs)]),
      clock: deps.clock,
      secrets: deps.secrets,
      log: deps.log,
    };
    reported = await client.listReservations(call);
  } catch (error) {
    await recordFailure(deps, sql, accountId, error, period);
    return;
  }
  const seen = new Map<string, ExternalReservation>();
  for (const reservation of reported) seen.set(reservation.id, reservation);
  await sql.transaction(async (tx) => {
    // The account may have been deleted while the provider answered.
    if (!(await readAccount(tx, accountId))) return;
    await applyScan(deps, tx, account.tenantId, accountId, [...seen.values()], observedAt);
    await tx.query(
      `INSERT INTO provider_reservation_scans (account_id, next_at, last_ok_at, last_error)
       VALUES ($1, ${nextAtSql('$2')}, compute_now(), NULL)
       ON CONFLICT (account_id) DO UPDATE SET next_at = EXCLUDED.next_at, last_ok_at = EXCLUDED.last_ok_at, last_error = NULL`,
      [accountId, period],
    );
  });
}

const dataOf = (
  reservation: ExternalReservation,
  accountId: string,
  extra: Record<string, Json> = {},
): Record<string, Json> => ({
  accountId,
  reservationId: reservation.id,
  machineType: reservation.machineType,
  ...(reservation.gpus
    ? { gpus: { model: reservation.gpus.model, count: reservation.gpus.count } }
    : {}),
  total: reservation.total,
  state: reservation.state,
  ...(reservation.startsAt !== undefined ? { startsAt: reservation.startsAt } : {}),
  ...extra,
});

/** Writes one scan: upserts what was seen, marks the rest gone, and publishes the differences. */
async function applyScan(
  deps: ReservationDeps,
  tx: SqlTx,
  tenantId: string,
  accountId: string,
  seen: readonly ExternalReservation[],
  observedAt: Date,
): Promise<void> {
  const { rows } = await tx.query<ReservationRow>(
    `SELECT ${rowColumns} FROM provider_reservations WHERE account_id = $1 FOR UPDATE`,
    [accountId],
  );
  const known = new Map(rows.map((row) => [row.reservation_id, row]));
  for (let at = 0; at < seen.length; at += batchSize) {
    const batch = seen.slice(at, at + batchSize);
    await tx.query(
      `INSERT INTO provider_reservations (account_id, reservation_id, reservation, total, in_use, observed_at, gone_at)
       SELECT $1, e->>'id', e->'reservation', (e->>'total')::int, (e->>'inUse')::int, $3, NULL
         FROM jsonb_array_elements($2::jsonb) AS e
       ON CONFLICT (account_id, reservation_id) DO UPDATE
         SET reservation = EXCLUDED.reservation, total = EXCLUDED.total, in_use = EXCLUDED.in_use,
             observed_at = EXCLUDED.observed_at, gone_at = NULL`,
      [
        accountId,
        JSON.stringify(
          batch.map((reservation) => ({
            id: reservation.id,
            reservation,
            total: reservation.total,
            inUse: reservation.inUse,
          })),
        ),
        observedAt,
      ],
    );
  }
  const seenIds = new Set(seen.map((reservation) => reservation.id));
  const gone = rows.filter((row) => row.gone_at === null && !seenIds.has(row.reservation_id));
  let goneAt = 0;
  if (gone.length > 0) {
    const { rows: marked } = await tx.query<{ at: number }>(
      `UPDATE provider_reservations SET gone_at = compute_now()
        WHERE account_id = $1 AND reservation_id = ANY($2::text[])
        RETURNING (extract(epoch FROM gone_at) * 1000)::float8 AS at`,
      [accountId, gone.map((row) => row.reservation_id)],
    );
    goneAt = Math.round(Number(marked[0]?.at ?? deps.clock.now()));
  }
  const pending = await pendingByReservation(tx, accountId);
  const publish = (type: string, data: Record<string, Json>) =>
    deps.events.publish(tx, {
      type,
      tenantId,
      subject: `provider-account/${accountId}`,
      data,
    });
  const scheduledByName = new Map<string, ReservationRow>();
  for (const row of rows) {
    const old = reservationOf(row);
    if (old.state === 'scheduled') scheduledByName.set(old.name, row);
  }
  for (const reservation of seen) {
    const before = known.get(reservation.id);
    const free = Math.max(
      0,
      reservation.total - reservation.inUse - (pending.get(reservation.id) ?? 0),
    );
    if (!before) {
      await publish('provider.reservation.detected', dataOf(reservation, accountId));
      // A future reservation that was fulfilled appears as the on-demand reservation it creates.
      const predecessor = scheduledByName.get(reservation.name);
      if (reservation.state === 'ready' && predecessor)
        await publish('provider.reservation.ready', dataOf(reservation, accountId, { free }));
      continue;
    }
    const old = reservationOf(before);
    const changes: string[] = [];
    if (old.total !== reservation.total) changes.push('total');
    if (old.inUse !== reservation.inUse) changes.push('inUse');
    if (old.state !== reservation.state) changes.push('state');
    if (changes.length > 0)
      await publish(
        'provider.reservation.changed',
        dataOf(reservation, accountId, { free, inUse: reservation.inUse, changes }),
      );
    // Fewer slots than its grants hold (FW-5): root is told once per change; the grants keep billing.
    if (old.total !== reservation.total)
      await checkGrantCapacity(deps, tx, {
        tenantId,
        accountId,
        reservationId: reservation.id,
        total: reservation.total,
      });
    if ((old.state === 'scheduled' || old.state === 'creating') && reservation.state === 'ready')
      await publish('provider.reservation.ready', dataOf(reservation, accountId, { free }));
  }
  for (const row of gone) {
    const reservation = reservationOf(row);
    // Its grants end (or are cancelled) and its instances bill on-demand from now (FW-5).
    await reservationGone(deps, tx, accountId, row.reservation_id, goneAt);
    const extra: Record<string, Json> = {};
    if (row.pool_id !== null) extra.poolId = row.pool_id;
    if (row.flavor_id !== null) extra.flavorId = row.flavor_id;
    if (row.pool_id !== null || row.flavor_id !== null) {
      await tx.query(
        `UPDATE provider_reservations SET pool_id = NULL, flavor_id = NULL
          WHERE account_id = $1 AND reservation_id = $2`,
        [accountId, row.reservation_id],
      );
      if (row.pool_id !== null && row.flavor_id !== null)
        await dropFlavor(tx, tenantId, row.pool_id, row.flavor_id);
    }
    await publish('provider.reservation.gone', {
      accountId,
      reservationId: reservation.id,
      ...extra,
    });
  }
}

/** Deletes a bound flavor if no instance uses it, else archives it (`deleteFlavor`). */
async function dropFlavor(
  tx: SqlTx,
  tenantId: string,
  poolId: string,
  flavorId: string,
): Promise<void> {
  const { rows } = await tx.query<{ name: string }>(`SELECT name FROM flavors WHERE id = $1`, [
    flavorId,
  ]);
  if (!rows[0]) return;
  try {
    await deleteFlavor(tx, { tenantId, poolId, name: rows[0].name });
  } catch (error) {
    if (!isComputeError(error, 'NOT_FOUND')) throw error;
  }
}

// --- The API ------------------------------------------------------------------------------------------

export interface ReservationsInput {
  tenantId: string;
  accountId: string;
  includeGone?: boolean;
}
export interface BindReservationInput {
  tenantId: string;
  accountId: string;
  reservationId: string;
  poolId: string;
  flavorName?: string;
  idempotencyKey: string;
}
export interface UnbindReservationInput {
  tenantId: string;
  accountId: string;
  reservationId: string;
}

const reservationIdPattern = /^[A-Za-z0-9._/-]{1,300}$/;
function reservationId(value: unknown): string {
  if (typeof value !== 'string' || !reservationIdPattern.test(value))
    throw new ComputeError('INVALID_INPUT', 'reservationId is invalid');
  return value;
}

export function parseReservations(raw: unknown): ReservationsInput {
  const input = object(raw, ['tenantId', 'accountId', 'includeGone']);
  const result: ReservationsInput = {
    tenantId: tenant(input.tenantId),
    accountId: id(input.accountId, 'pacct', 'accountId'),
  };
  const includeGone = optional(input.includeGone, (value) => {
    if (typeof value !== 'boolean')
      throw new ComputeError('INVALID_INPUT', 'includeGone must be a boolean');
    return value;
  });
  if (includeGone !== undefined) result.includeGone = includeGone;
  return result;
}

export function parseBindReservation(raw: unknown): BindReservationInput {
  const input = object(raw, [
    'tenantId',
    'accountId',
    'reservationId',
    'poolId',
    'flavorName',
    'idempotencyKey',
  ]);
  const result: BindReservationInput = {
    tenantId: tenant(input.tenantId),
    accountId: id(input.accountId, 'pacct', 'accountId'),
    reservationId: reservationId(input.reservationId),
    poolId: id(input.poolId, 'pool', 'poolId'),
    idempotencyKey: keyOf(input.idempotencyKey),
  };
  const flavorName = optional(input.flavorName, (value) => name(value, 'flavorName'));
  if (flavorName !== undefined) result.flavorName = flavorName;
  return result;
}

export function parseUnbindReservation(raw: unknown): UnbindReservationInput {
  const input = object(raw, ['tenantId', 'accountId', 'reservationId']);
  return {
    tenantId: tenant(input.tenantId),
    accountId: id(input.accountId, 'pacct', 'accountId'),
    reservationId: reservationId(input.reservationId),
  };
}

async function requireAccount(tx: SqlTx, tenantId: string, accountId: string) {
  const account = await readAccount(tx, accountId, tenantId);
  if (!account) throw new ComputeError('NOT_FOUND', `Provider account ${accountId} not found`);
  return account;
}

/** `providerAccounts.reservations`: the account's reservations with free and pending slots. */
export async function listProviderReservations(
  tx: SqlTx,
  input: ReservationsInput,
): Promise<{ items: ProviderReservationView[] }> {
  await requireAccount(tx, input.tenantId, input.accountId);
  const { rows } = await tx.query<ReservationRow>(
    `SELECT ${rowColumns} FROM provider_reservations
      WHERE account_id = $1 ${input.includeGone ? '' : 'AND gone_at IS NULL'}
      ORDER BY reservation_id`,
    [input.accountId],
  );
  const pending = await pendingByReservation(tx, input.accountId);
  return {
    items: rows.map((row) => viewOf(input.accountId, row, pending.get(row.reservation_id) ?? 0)),
  };
}

async function lockReservation(
  tx: SqlTx,
  accountId: string,
  reservationIdValue: string,
): Promise<ReservationRow> {
  const { rows } = await tx.query<ReservationRow>(
    `SELECT ${rowColumns} FROM provider_reservations
      WHERE account_id = $1 AND reservation_id = $2 FOR UPDATE`,
    [accountId, reservationIdValue],
  );
  if (!rows[0]) throw new ComputeError('NOT_FOUND', `Reservation ${reservationIdValue} not found`);
  return rows[0];
}

/**
 * `providerAccounts.bindReservation`: creates a flavor of the pool for the reservation (through the
 * ordinary flavor path) and remembers the binding. Repeating it for the same pool returns the binding.
 */
export async function bindReservation(
  tx: SqlTx,
  input: BindReservationInput,
): Promise<{ poolId: string; flavorId: string }> {
  const account = await requireAccount(tx, input.tenantId, input.accountId);
  const row = await lockReservation(tx, input.accountId, input.reservationId);
  const pool = await tx.query<{
    class: string;
    provider_account_id: string | null;
    owner_tenant_id: string;
    archived: boolean;
  }>(
    `SELECT class, provider_account_id, owner_tenant_id, archived_at IS NOT NULL AS archived
       FROM pools WHERE id = $1`,
    [input.poolId],
  );
  const target = pool.rows[0];
  if (!target || target.owner_tenant_id !== input.tenantId)
    throw new ComputeError('NOT_FOUND', `Pool ${input.poolId} not found`);
  if (target.class !== 'provider' || target.provider_account_id !== input.accountId)
    throw new ComputeError(
      'INVALID_INPUT',
      `Pool ${input.poolId} is not a provider pool of account ${input.accountId}`,
    );
  if (target.archived) throw new ComputeError('INVALID_STATE', `Pool ${input.poolId} is archived`);
  if (row.pool_id !== null) {
    if (row.pool_id === input.poolId && row.flavor_id !== null)
      return { poolId: row.pool_id, flavorId: row.flavor_id };
    throw new ComputeError(
      'CONFLICT',
      `Reservation ${input.reservationId} is already bound to pool ${row.pool_id}`,
    );
  }
  const reservation = reservationOf(row);
  if (row.gone_at !== null)
    throw new ComputeError(
      'INVALID_STATE',
      `Reservation ${input.reservationId} is gone`,
      undefined,
      {
        reservationId: input.reservationId,
        state: 'gone',
      },
    );
  // Only a ready reservation is bound: a future (scheduled) one is fulfilled under a new id, which
  // would orphan the binding.
  if (reservation.state !== 'ready')
    throw new ComputeError(
      'INVALID_STATE',
      `Reservation ${input.reservationId} is ${reservation.state}; bind it once it is ready`,
      undefined,
      { reservationId: input.reservationId, state: reservation.state },
    );
  const diskGiB =
    typeof account.config.diskGiB === 'number' && Number.isSafeInteger(account.config.diskGiB)
      ? account.config.diskGiB
      : 100;
  const flavor = await createFlavor(tx, {
    tenantId: input.tenantId,
    poolId: input.poolId,
    name: input.flavorName ?? `rsv-${reservation.name}`,
    vcpu: reservation.vcpu,
    memoryGiB: reservation.memoryGiB,
    diskGiB,
    gpus: reservation.gpus?.count ?? 0,
    offerId: reservation.offerId,
  });
  await tx.query(
    `UPDATE provider_reservations SET pool_id = $3, flavor_id = $4
      WHERE account_id = $1 AND reservation_id = $2`,
    [input.accountId, input.reservationId, input.poolId, flavor.id],
  );
  return { poolId: input.poolId, flavorId: flavor.id };
}

/** `providerAccounts.unbindReservation`: removes the unused flavor, or archives one instances use. */
export async function unbindReservation(
  tx: SqlTx,
  input: UnbindReservationInput,
): Promise<{ reservationId: string }> {
  await requireAccount(tx, input.tenantId, input.accountId);
  const row = await lockReservation(tx, input.accountId, input.reservationId);
  // A grant's instances are created through the bound flavor: a live grant keeps the reservation bound (F10-4).
  const { rows: live } = await tx.query<{ id: string }>(
    `SELECT id FROM reservation_grants
      WHERE account_id = $1 AND reservation_id = $2 AND state IN ('scheduled', 'active') ORDER BY id`,
    [input.accountId, input.reservationId],
  );
  if (live.length > 0)
    throw new ComputeError(
      'INVALID_STATE',
      `Reservation ${input.reservationId} has live grants; end them first`,
      undefined,
      { reservationId: input.reservationId, grantIds: live.map((grant) => grant.id) },
    );
  if (row.pool_id !== null) {
    await tx.query(
      `UPDATE provider_reservations SET pool_id = NULL, flavor_id = NULL
        WHERE account_id = $1 AND reservation_id = $2`,
      [input.accountId, input.reservationId],
    );
    if (row.flavor_id !== null) await dropFlavor(tx, input.tenantId, row.pool_id, row.flavor_id);
  }
  return { reservationId: input.reservationId };
}

// --- Admission ----------------------------------------------------------------------------------------

/** Instances (alias `i`) that hold a slot of their reservation (the pending ones, counted or not by a scan). */
export const holdingCondition = `i.state NOT IN ('deleted', 'failed', 'lost')
  AND NOT (i.state = 'error' AND i.external_id IS NULL)
  AND NOT (i.state = 'error' AND i.conditions @> '[{"type":"ProvisionFailed","status":"true"}]'::jsonb)`;

/** Where an admitted instance goes: the reservation, and the grant whose slot it takes (if any). */
export interface ReservationClaim {
  reservationId: string;
  grantId?: string;
}

/**
 * Admission against a reservation-backed offer (`<zone>/<machineType>@<reservation>`): locks the
 * reservation's row (so concurrent creates and grants are serialized by the database), refuses
 * unless it is ready and has a slot for this tenant, and returns the reservation id to store in
 * `instances.provider_reservation` (with the grant to store in `reservation_grant_id`). `undefined`
 * for an offer that is not a reservation's.
 *
 * Reservation grants (D7): a grant in its term holds its slots for its tenant (and project, when
 * it names one). The tenant is admitted into its grant while the grant has a slot its instances do
 * not hold; otherwise, as everyone else, only into what neither the scan (`in_use`), the instances
 * it has not counted yet (`pending`) nor the unused slots of grants take:
 * `total - in_use - pending - unused grant slots`. A grant slot is also refused when the reservation
 * is physically full (`total - in_use - pending < 1`): VMs outside better-compute count too.
 */
export async function claimReservationSlot(
  tx: SqlTx,
  input: { accountId: string; offerId: string; tenantId: string; projectId?: string },
): Promise<ReservationClaim | undefined> {
  if (input.offerId.indexOf('@') < 0) return undefined;
  // An offer id names the reservation by its own spelling (a name, or a shared-in path); the stored
  // reservation says which offer id it answers to.
  const { rows } = await tx.query<ReservationRow>(
    `SELECT ${rowColumns} FROM provider_reservations
      WHERE account_id = $1 AND reservation->>'offerId' = $2
      ORDER BY gone_at NULLS FIRST, reservation_id
      LIMIT 1 FOR UPDATE`,
    [input.accountId, input.offerId],
  );
  const row = rows[0];
  const refuse = (message: string, details: Record<string, Json>): never => {
    throw new ComputeError('CAPACITY_UNAVAILABLE', message, undefined, details);
  };
  if (!row)
    return refuse(`Reservation of offer ${input.offerId} is not known`, {
      reservationId: input.offerId.slice(input.offerId.indexOf('@') + 1),
      state: 'missing',
    });
  const reservation = reservationOf(row);
  if (row.gone_at !== null)
    return refuse(`Reservation ${row.reservation_id} is gone`, {
      reservationId: row.reservation_id,
      state: 'gone',
    });
  if (reservation.state !== 'ready')
    return refuse(`Reservation ${row.reservation_id} is ${reservation.state}, not ready`, {
      reservationId: row.reservation_id,
      state: reservation.state,
    });
  const { rows: counted } = await tx.query<{ pending: number | string }>(
    `SELECT count(*) AS pending
       FROM provider_reservations r
       JOIN instances i ON i.provider_account_id = r.account_id AND i.provider_reservation = r.reservation_id
      WHERE r.account_id = $1 AND r.reservation_id = $2 AND ${pendingCondition}`,
    [input.accountId, row.reservation_id],
  );
  const pending = Number(counted[0]?.pending ?? 0);
  const total = Number(row.total);
  const inUse = Number(row.in_use);
  // The grants in their term now, with the slots their instances hold.
  const { rows: grants } = await tx.query<{
    id: string;
    tenant_id: string;
    project_id: string | null;
    slots: number;
    used: number | string;
    consuming: number | string;
  }>(
    `SELECT g.id, g.tenant_id, g.project_id, g.slots,
            (SELECT count(*) FROM instances i WHERE i.reservation_grant_id = g.id AND ${holdingCondition}) AS used,
            (SELECT count(*) FROM instances i
              WHERE i.reservation_grant_id = g.id AND ${holdingCondition} AND i.state <> 'stopped') AS consuming
       FROM reservation_grants g
      WHERE g.account_id = $1 AND g.reservation_id = $2 AND g.state IN ('scheduled', 'active')
        AND g.starts_at <= compute_now() AND g.ends_at > compute_now()
      ORDER BY (g.project_id IS NULL), g.ends_at, g.id`,
    [input.accountId, row.reservation_id],
  );
  // A grant's stopped instances hold their grant slot for the grantee, but the provider counts no stopped VM in
  // `in_use`: the slots they do not consume stay unused for everyone else (F10-2).
  const unused = grants.reduce(
    (sum, grant) => sum + Math.max(0, Number(grant.slots) - Number(grant.consuming)),
    0,
  );
  const physical = total - inUse - pending;
  const details = {
    reservationId: row.reservation_id,
    total,
    inUse,
    pending,
    ...(unused > 0 ? { granted: unused } : {}),
  };
  const own = grants.find(
    (grant) =>
      grant.tenant_id === input.tenantId &&
      (grant.project_id === null || grant.project_id === input.projectId) &&
      Number(grant.used) < Number(grant.slots),
  );
  if (own) {
    if (physical < 1) return refuse(`Reservation ${row.reservation_id} has no free slot`, details);
    return { reservationId: row.reservation_id, grantId: own.id };
  }
  if (physical - unused < 1)
    return refuse(`Reservation ${row.reservation_id} has no free slot`, details);
  return { reservationId: row.reservation_id };
}
