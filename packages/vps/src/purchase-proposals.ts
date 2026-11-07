import {
  ComputeError,
  isComputeError,
  newId,
  parseDuration,
  strictObject,
  type Caller,
  type DeviceRequest,
  type Duration,
  type InputSchema,
  type Migration,
  type ModuleContext,
  type ProviderDefinition,
  type Reconciler,
  type ReservationOffering,
  type ReservationOfferingQuery,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { readAccount } from './accounts.js';
import { isRootCaller } from './billing.js';
import { id, object, tenant } from './input.js';
import type { PurchaseDeps, PurchaseState } from './provider-purchases.js';

// Calendar → Capacity Blocks (AWS A10): a capacity reservation booked ahead on a provider pool that
// the pool cannot place yet (`pending`) gets a purchase proposal 48 hours before it starts, when the
// pool's provider account is one of the platform's and its provider sells capacity ahead of time
// (`listReservationOfferings`). The `vps.purchase-proposals` worker asks the provider (a read; nothing is
// bought) for capacity of the pool's GPU flavor that covers the reservation's whole window, keeps the
// covering offering that starts latest (least capacity paid for before the reservation starts), records
// it in `provider_purchase_proposals` and publishes `provider.purchase.proposed`. Buying stays a person's
// decision: root reads the proposals (`providerAccounts.purchaseProposals`) and buys one through
// `providerAccounts.purchaseReservation`, confirmed, as any other purchase.

/** The work kind of the proposals worker (key `all`, periodic). */
export const purchaseProposalsWork = 'vps.purchase-proposals';

/** How long before a reservation starts its proposal is made. */
export const proposalLeadMs = 48 * 3_600_000;
/** A failed proposal is tried again after this long, at most `maxProposalAttempts` times in all. */
const retryAfterMs = 15 * 60_000;
export const maxProposalAttempts = 5;
/** Reservations proposed per pass (each is one provider read). */
const perPass = 50;
const hour = 3_600_000;
/** A provider read gets this long at most (and never past the run's budget). */
const callBudgetMs = 45_000;
/**
 * How long one run takes reservations (default): under the work queue's claim (15 s), so no other
 * worker claims `all` and repeats the reads while this one still runs (as provider-events).
 */
const defaultBudgetMs = 12_000;

export const purchaseProposalsMigration: Migration = {
  name: 'vps/0113_purchase_proposals',
  sql: `
CREATE TABLE provider_purchase_proposals (
  id text PRIMARY KEY,
  reservation_id text NOT NULL UNIQUE,
  tenant_id text NOT NULL,
  pool_id text NOT NULL,
  account_id text NOT NULL REFERENCES provider_accounts ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('proposed', 'none', 'error')),
  reason text,
  query jsonb,
  offering jsonb,
  error jsonb,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  updated_at timestamptz NOT NULL DEFAULT compute_now()
);
CREATE INDEX provider_purchase_proposals_account ON provider_purchase_proposals (account_id, created_at);
`,
};

/**
 * `proposed`: an offering covers the reservation (`offering`); `none`: nothing to propose (`reason`
 * `no-flavor`, `no-offering`, `unsupported`); `error`: the provider read failed (`error`), tried again
 * on later passes until `maxProposalAttempts`.
 */
export type ProposalState = 'proposed' | 'none' | 'error';

/** A proposal as the API shows it. */
export interface PurchaseProposalView {
  id: string;
  accountId: string;
  reservationId: string;
  poolId: string;
  /** The tenant of the reservation. */
  tenantId: string;
  state: ProposalState;
  reason?: string;
  /** The reservation's window (epoch ms). */
  startsAt: number;
  endsAt: number;
  /** What the provider was asked for. */
  query?: ReservationOfferingQuery;
  /** The offering proposed: pass `offering.id` to `purchaseReservation`. */
  offering?: ReservationOffering;
  /** The provider's account of the offering (what, where, when, what it costs). */
  description?: string;
  error?: { code: string; message: string };
  attempts: number;
  /** The latest purchase of the offering in the account, once root bought it. */
  purchase?: { id: string; state: PurchaseState };
  createdAt: number;
  updatedAt: number;
}

// --- Pure planning -----------------------------------------------------------------------------------

/**
 * Capacity Block durations: whole days up to 14 days, then whole weeks up to 182 days; undefined past
 * that. Providers that sell any whole hour get at most a day or a week more than asked.
 */
export function blockDurationHours(hours: number): number | undefined {
  const whole = Math.max(1, Math.ceil(hours));
  if (whole <= 14 * 24) return Math.ceil(whole / 24) * 24;
  const weeks = Math.ceil(whole / (7 * 24)) * 7 * 24;
  return weeks <= 182 * 24 ? weeks : undefined;
}

/** What a reservation needs, as far as a proposal goes. */
export interface ProposalReservation {
  start: number;
  end: number;
  /** Whole GPUs per member (the request's `gpu` devices). */
  gpus: number;
  /** Members: a gang's size, else 1. */
  machinesPer: number;
}

/** A flavor of the reservation's pool. */
export interface ProposalFlavor {
  name: string;
  gpus: number;
  offerId: string;
}

/** A plain offer (`<zone>/<type>`): not one that names a reservation (`@`) or a market (`:spot`). */
const plainOffer = /^[A-Za-z0-9._-]{1,64}\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;

/**
 * The offering query for a reservation: whole machines of the GPU flavor that wastes the fewest GPUs
 * (then the fewest machines), starting in the day before the reservation (not before `now`) and lasting
 * until it ends. Undefined when no flavor fits or the window is longer than capacity is sold for.
 */
export function proposalQuery(
  reservation: ProposalReservation,
  flavors: readonly ProposalFlavor[],
  now: number,
): ReservationOfferingQuery | undefined {
  if (!(reservation.gpus > 0) || !(reservation.machinesPer > 0)) return undefined;
  let best: { type: string; count: number; waste: number; name: string } | undefined;
  for (const flavor of flavors) {
    const type = plainOffer.exec(flavor.offerId)?.[1];
    if (!type || !(flavor.gpus > 0)) continue;
    const perMember = Math.ceil(reservation.gpus / flavor.gpus);
    const count = perMember * reservation.machinesPer;
    if (count > 1_000) continue;
    const waste = (perMember * flavor.gpus - reservation.gpus) * reservation.machinesPer;
    if (
      !best ||
      waste < best.waste ||
      (waste === best.waste && count < best.count) ||
      (waste === best.waste && count === best.count && flavor.name < best.name)
    )
      best = { type, count, waste, name: flavor.name };
  }
  if (!best) return undefined;
  const earliestStart = Math.max(now, reservation.start - 24 * hour);
  const durationHours = blockDurationHours((reservation.end - earliestStart) / hour);
  if (durationHours === undefined) return undefined;
  return {
    instanceType: best.type,
    count: best.count,
    durationHours,
    earliestStart,
    latestStart: reservation.start,
  };
}

/**
 * The offering to propose: scheduled capacity (it starts after `now`) of the query's type and count
 * that covers the whole reservation; the latest start wins, then the lowest price, then the id.
 */
export function chooseOffering(
  offerings: readonly ReservationOffering[],
  query: ReservationOfferingQuery,
  reservation: Pick<ProposalReservation, 'start' | 'end'>,
  now: number,
): ReservationOffering | undefined {
  return offerings
    .filter(
      (offering) =>
        offering.instanceType === query.instanceType &&
        offering.count === query.count &&
        offering.startsAt > now &&
        offering.startsAt <= reservation.start &&
        offering.endsAt >= reservation.end &&
        Number.isFinite(offering.upfrontPrice),
    )
    .sort(
      (a, b) =>
        b.startsAt - a.startsAt ||
        a.upfrontPrice - b.upfrontPrice ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )[0];
}

// --- Store -------------------------------------------------------------------------------------------

interface ProposalRow {
  id: string;
  reservation_id: string;
  tenant_id: string;
  pool_id: string;
  account_id: string;
  state: ProposalState;
  reason: string | null;
  query: ReservationOfferingQuery | string | null;
  offering: ReservationOffering | string | null;
  error: { code: string; message: string } | string | null;
  starts_at: Date;
  ends_at: Date;
  attempts: number;
  created_at: Date;
  updated_at: Date;
  purchase_id?: string | null;
  purchase_state?: PurchaseState | null;
}

const json = <T>(value: T | string | null | undefined): T | undefined =>
  value === null || value === undefined
    ? undefined
    : typeof value === 'string'
      ? (JSON.parse(value) as T)
      : value;

function describeOffering(
  offeringId: string,
  providers: Iterable<Pick<ProviderDefinition, 'describeOffering'>>,
): string | undefined {
  for (const provider of providers) {
    try {
      const what = provider.describeOffering?.(offeringId);
      if (what) return what.slice(0, 400);
    } catch {
      // A provider that cannot describe the id says nothing.
    }
  }
  return undefined;
}

function viewOf(
  row: ProposalRow,
  providers: Iterable<Pick<ProviderDefinition, 'describeOffering'>>,
): PurchaseProposalView {
  const view: PurchaseProposalView = {
    id: row.id,
    accountId: row.account_id,
    reservationId: row.reservation_id,
    poolId: row.pool_id,
    tenantId: row.tenant_id,
    state: row.state,
    startsAt: row.starts_at.getTime(),
    endsAt: row.ends_at.getTime(),
    attempts: Number(row.attempts),
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
  if (row.reason !== null) view.reason = row.reason;
  const query = json<ReservationOfferingQuery>(row.query);
  if (query) view.query = query;
  const offering = json<ReservationOffering>(row.offering);
  if (offering) {
    view.offering = offering;
    const description = describeOffering(offering.id, providers);
    if (description) view.description = description;
  }
  const error = json<{ code: string; message: string }>(row.error);
  if (error) view.error = error;
  if (row.purchase_id) view.purchase = { id: row.purchase_id, state: row.purchase_state! };
  return view;
}

// --- The worker --------------------------------------------------------------------------------------

export interface PurchaseProposalsOptions {
  /** How often pending reservations are looked at (default `15m`). */
  every?: Duration;
  /**
   * How long one run takes reservations, in ms (default 12 000, at least 1 000): kept under the work
   * claim. No reservation is started past it, and a provider read gets at most what is left; a read
   * the budget cuts short records nothing (the next run asks again), never an error attempt.
   */
  budgetMs?: number;
}

interface CandidateRow {
  id: string;
  tenant_id: string;
  pool_id: string;
  account_id: string;
  request:
    | { start?: number; duration: Duration; devices?: DeviceRequest[]; gang?: { size?: number } }
    | string;
}

/** Pending reservations of the platform's provider pools that start within the lead, not yet proposed. */
async function candidates(tx: SqlTx, rootTenantId: string, now: number): Promise<CandidateRow[]> {
  const { rows } = await tx.query<CandidateRow>(
    `SELECT r.id, r.tenant_id, r.pool_id, p.provider_account_id AS account_id, r.request
       FROM reservations r
       JOIN pools p ON p.id = r.pool_id
       JOIN provider_accounts a ON a.id = p.provider_account_id
      WHERE r.state = 'pending'
        AND p.archived_at IS NULL
        AND a.tenant_id = $3
        AND jsonb_typeof(r.request->'start') = 'number'
        AND (r.request->>'start')::float8 > $1
        AND (r.request->>'start')::float8 <= $2
        AND NOT EXISTS (
          SELECT 1 FROM provider_purchase_proposals x
           WHERE x.reservation_id = r.id
             AND (x.state <> 'error' OR x.attempts >= $4 OR x.updated_at > $5::timestamptz))
      ORDER BY (r.request->>'start')::float8, r.id
      LIMIT ${perPass}`,
    [now, now + proposalLeadMs, rootTenantId, maxProposalAttempts, new Date(now - retryAfterMs)],
  );
  return rows;
}

function safeError(error: unknown): { code: string; message: string } {
  if (isComputeError(error)) return { code: error.code, message: error.message.slice(0, 512) };
  return { code: 'PROVIDER_ERROR', message: 'The provider failed the offering read' };
}

/** The run's own budget or signal ended the read: nothing is recorded, no attempt is spent. */
const cutShort = Symbol('cut-short');

interface Outcome {
  state: ProposalState;
  reason?: string;
  query?: ReservationOfferingQuery;
  offering?: ReservationOffering;
  error?: { code: string; message: string };
}

/** Plans and asks the provider for one reservation, outside any transaction. */
async function propose(
  deps: PurchaseDeps,
  sql: SqlExecutor,
  candidate: CandidateRow,
  reservation: ProposalReservation,
  signal: AbortSignal,
  leftMs: number,
): Promise<Outcome | typeof cutShort> {
  const now = deps.clock.now();
  const flavors = await sql.transaction(async (tx) =>
    (
      await tx.query<{ name: string; gpus: number; offer_id: string }>(
        `SELECT name, gpus, offer_id FROM flavors
          WHERE pool_id = $1 AND NOT archived AND gpus > 0 AND offer_id IS NOT NULL
          ORDER BY name`,
        [candidate.pool_id],
      )
    ).rows.map((row) => ({ name: row.name, gpus: Number(row.gpus), offerId: row.offer_id })),
  );
  const query = proposalQuery(reservation, flavors, now);
  if (!query) return { state: 'none', reason: 'no-flavor' };
  // The read gets the call budget, or what is left of the run's when that is less: then its timing
  // out is the run ending, not the provider failing.
  const byRun = leftMs < callBudgetMs;
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(callBudgetMs, leftMs)));
  try {
    const account = await sql.transaction((tx) => readAccount(tx, candidate.account_id));
    if (!account || account.tenantId !== deps.rootTenantId)
      return { state: 'none', reason: 'unsupported', query };
    const client = await deps.clients.client(account, deps);
    if (typeof client.listReservationOfferings !== 'function')
      return { state: 'none', reason: 'unsupported', query };
    const offerings = await client.listReservationOfferings(query, {
      idempotencyKey: `proposal:${candidate.id}`,
      signal: AbortSignal.any([signal, timeout]),
      clock: deps.clock,
      secrets: deps.secrets,
      log: deps.log,
    });
    const offering = chooseOffering(offerings, query, reservation, now);
    return offering
      ? { state: 'proposed', query, offering }
      : { state: 'none', reason: 'no-offering', query };
  } catch (error) {
    if (signal.aborted || (byRun && timeout.aborted)) return cutShort;
    return { state: 'error', query, error: safeError(error) };
  }
}

/** One pass: every candidate gets a proposal (or a recorded reason there is none). */
export async function reconcilePurchaseProposals(
  deps: PurchaseDeps,
  sql: SqlExecutor,
  signal: AbortSignal,
  budgetMs = defaultBudgetMs,
): Promise<void> {
  const rootTenantId = deps.rootTenantId;
  if (rootTenantId === undefined) return;
  // Wall time, like the claim it stays under (the compute clock may be simulated).
  const deadline = Date.now() + Math.max(1_000, budgetMs);
  const now = deps.clock.now();
  const rows = await sql.transaction((tx) => candidates(tx, rootTenantId, now));
  for (const candidate of rows) {
    if (signal.aborted) return;
    const leftMs = deadline - Date.now();
    if (leftMs <= 0) return;
    const request = json<Exclude<CandidateRow['request'], string>>(candidate.request)!;
    let duration: number;
    try {
      duration = parseDuration(request.duration);
    } catch {
      continue;
    }
    const start = Number(request.start);
    const reservation: ProposalReservation = {
      start,
      end: start + duration,
      gpus: (request.devices ?? [])
        .filter((device) => device.class === 'gpu')
        .reduce((sum, device) => sum + Number(device.count), 0),
      machinesPer: Math.max(1, Number(request.gang?.size ?? 1)),
    };
    const outcome = await propose(deps, sql, candidate, reservation, signal, leftMs);
    if (outcome === cutShort) return;
    await sql.transaction(async (tx) => {
      const { rows: saved } = await tx.query<{ id: string; state: ProposalState }>(
        `INSERT INTO provider_purchase_proposals
           (id, reservation_id, tenant_id, pool_id, account_id, state, reason, query, offering, error,
            starts_at, ends_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12)
         ON CONFLICT (reservation_id) DO UPDATE
           SET state = EXCLUDED.state, reason = EXCLUDED.reason, query = EXCLUDED.query,
               offering = EXCLUDED.offering, error = EXCLUDED.error,
               attempts = provider_purchase_proposals.attempts + 1, updated_at = compute_now()
         WHERE provider_purchase_proposals.state = 'error'
           AND provider_purchase_proposals.attempts < $13
         RETURNING id, state`,
        [
          newId('ppro'),
          candidate.id,
          candidate.tenant_id,
          candidate.pool_id,
          candidate.account_id,
          outcome.state,
          outcome.reason ?? null,
          outcome.query ? JSON.stringify(outcome.query) : null,
          outcome.offering ? JSON.stringify(outcome.offering) : null,
          outcome.error ? JSON.stringify(outcome.error) : null,
          new Date(reservation.start),
          new Date(reservation.end),
          maxProposalAttempts,
        ],
      );
      const proposal = saved[0];
      if (!proposal) return;
      if (proposal.state === 'error')
        deps.log.warn('vps.purchase_proposal_failed', {
          reservationId: candidate.id,
          code: outcome.error?.code,
        });
      if (proposal.state !== 'proposed' || !outcome.offering) return;
      await deps.events.publish(tx, {
        type: 'provider.purchase.proposed',
        subject: `provider-account/${candidate.account_id}`,
        tenantId: rootTenantId,
        data: {
          accountId: candidate.account_id,
          proposalId: proposal.id,
          reservationId: candidate.id,
          poolId: candidate.pool_id,
          offeringId: outcome.offering.id,
          startsAt: outcome.offering.startsAt,
          upfrontPrice: outcome.offering.upfrontPrice,
          currency: outcome.offering.currency,
        },
      });
    });
  }
}

export function purchaseProposalsReconciler(
  options: PurchaseProposalsOptions,
  depsOf: (context: ModuleContext) => PurchaseDeps,
): Reconciler {
  return {
    name: purchaseProposalsWork,
    shardBy: 'none',
    periodic: [{ key: 'all', every: options.every ?? '15m' }],
    async run(context) {
      await reconcilePurchaseProposals(
        depsOf(context),
        context.sql,
        context.signal,
        options.budgetMs ?? defaultBudgetMs,
      );
      return 'DONE';
    },
  };
}

// --- API ---------------------------------------------------------------------------------------------

export interface ListPurchaseProposalsInput {
  tenantId: string;
  accountId: string;
}

export function parseListPurchaseProposals(raw: unknown): ListPurchaseProposalsInput {
  const input = object(raw, ['tenantId', 'accountId']);
  return {
    tenantId: tenant(input.tenantId),
    accountId: id(input.accountId, 'pacct', 'accountId'),
  };
}

export const purchaseProposalSchemas = {
  purchaseProposals: strictObject(
    {
      tenantId: {
        type: 'string',
        pattern: '^[A-Za-z0-9._:-]{1,128}$',
        maxLength: 128,
        description: 'The tenant that owns the provider account (the platform)',
      },
      accountId: {
        type: 'string',
        pattern: '^pacct_[0-9a-hjkmnp-tv-z]{26,52}$',
        maxLength: 58,
        description: 'The provider account',
      },
    },
    ['tenantId', 'accountId'],
  ),
} satisfies Record<string, InputSchema>;

/**
 * `providerAccounts.purchaseProposals`: the account's purchase proposals, newest first (at most 500).
 * Root-only, like buying: they name other tenants' reservations and what the platform could spend.
 */
export async function listPurchaseProposals(
  deps: Pick<PurchaseDeps, 'rootTenantId'>,
  tx: SqlTx,
  input: ListPurchaseProposalsInput,
  caller: Caller | undefined,
  providers: Iterable<Pick<ProviderDefinition, 'describeOffering'>> = [],
): Promise<{ items: PurchaseProposalView[] }> {
  if (!isRootCaller(caller, deps.rootTenantId))
    throw new ComputeError(
      'ACCESS_DENIED',
      'Only the platform (root tenant) reads purchase proposals',
    );
  const account = await readAccount(tx, input.accountId, input.tenantId);
  if (!account)
    throw new ComputeError('NOT_FOUND', `Provider account ${input.accountId} not found`);
  const { rows } = await tx.query<ProposalRow>(
    `SELECT x.id, x.reservation_id, x.tenant_id, x.pool_id, x.account_id, x.state, x.reason, x.query,
            x.offering, x.error, x.starts_at, x.ends_at, x.attempts, x.created_at, x.updated_at,
            pp.id AS purchase_id, pp.state AS purchase_state
       FROM provider_purchase_proposals x
       LEFT JOIN LATERAL (
         SELECT id, state FROM provider_purchases
          WHERE account_id = x.account_id AND offering_id = x.offering->>'id'
          ORDER BY created_at DESC, id DESC LIMIT 1) pp ON true
      WHERE x.account_id = $1
      ORDER BY x.created_at DESC, x.id DESC LIMIT 500`,
    [account.id],
  );
  const known = [...providers];
  return { items: rows.map((row) => viewOf(row, known)) };
}
