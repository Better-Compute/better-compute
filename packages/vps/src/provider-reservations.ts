import {
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
import { readAccount, type ProviderClients } from './accounts.js';
import { deleteFlavor } from './flavors.js';

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
 * instances that never got a machine hold nothing.
 */
const pendingCondition = `i.state NOT IN ('deleted', 'failed', 'lost')
  AND NOT (i.state = 'error' AND i.external_id IS NULL)
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
  if (gone.length > 0)
    await tx.query(
      `UPDATE provider_reservations SET gone_at = compute_now()
        WHERE account_id = $1 AND reservation_id = ANY($2::text[])`,
      [accountId, gone.map((row) => row.reservation_id)],
    );
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
    if ((old.state === 'scheduled' || old.state === 'creating') && reservation.state === 'ready')
      await publish('provider.reservation.ready', dataOf(reservation, accountId, { free }));
  }
  for (const row of gone) {
    const reservation = reservationOf(row);
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
