import {
  ComputeError,
  isComputeError,
  newId,
  strictObject,
  type CallContext,
  type Caller,
  type Clock,
  type EventPublisher,
  type ExternalReservation,
  type InputSchema,
  type Logger,
  type Migration,
  type ModuleContext,
  type ProviderDefinition,
  type PurchaseAttempt,
  type Reconciler,
  type ReservationOffering,
  type ReservationOfferingQuery,
  type SecretResolver,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { readAccount, type ClientDeps, type ProviderClients } from './accounts.js';
import { isRootCaller } from './billing.js';
import { id, int, key, object, optional, tenant } from './input.js';
import { reservationsWork } from './provider-reservations.js';

// Buying provider capacity (AWS A3, AD11 / AQ5): `providerAccounts.reservationOfferings` reads what
// an account could buy (a provider read, no spend), and `providerAccounts.purchaseReservation` buys
// one offering. A purchase spends money, so it is root-only (action `compute:providers:purchase`),
// needs `confirm: true` in the request (and a person's approval when a delegated agent asks, through
// the admission's description), and runs exactly once: the request writes a `provider_purchases` row
// in its transaction, and the `vps.purchases` reconciler calls the provider outside any transaction
// with a key derived from that row (`purchase:<id>`), so retries of the request or of the reconciler
// never buy twice. The provider makes the same key idempotent on its side.

/** The work kind of the purchases reconciler (key: a purchase id). */
export const purchasesWork = 'vps.purchases';

export const providerPurchasesMigration: Migration = {
  name: 'vps/0087_provider_purchases',
  sql: `
CREATE TABLE provider_purchases (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES provider_accounts ON DELETE CASCADE,
  tenant_id text NOT NULL,
  created_by text NOT NULL,
  idempotency_key text NOT NULL,
  offering_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('requested', 'purchasing', 'purchased', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  reservation_id text,
  reservation jsonb,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  updated_at timestamptz NOT NULL DEFAULT compute_now(),
  UNIQUE (tenant_id, created_by, idempotency_key)
);
CREATE INDEX provider_purchases_account ON provider_purchases (account_id, created_at);
`,
};

/**
 * A purchase whose attempts ran out while an attempt may have bought (its answer was lost) is
 * `unknown`, never `failed`: money may have been spent. `uncertain_since` is when the latest such
 * attempt started; the provider waits for what it may have bought before it buys again.
 */
export const providerPurchasesUnknownMigration: Migration = {
  name: 'vps/0088_provider_purchases_unknown',
  sql: `
ALTER TABLE provider_purchases DROP CONSTRAINT provider_purchases_state_check;
ALTER TABLE provider_purchases ADD CONSTRAINT provider_purchases_state_check
  CHECK (state IN ('requested', 'purchasing', 'purchased', 'failed', 'unknown'));
ALTER TABLE provider_purchases ADD COLUMN uncertain_since timestamptz;
`,
};

/**
 * `attempt_started_at`: when the attempt in flight started, cleared when it settles. A claim that
 * finds it set knows the earlier attempt never settled (the run crashed, lost its lease, or failed
 * to record the provider's answer) and so may have bought: it becomes `uncertain_since`.
 * One reservation is recorded by one purchase only (`provider_purchases_reservation`). Purchases
 * are a record of money spent: they outlive their provider account (no foreign key; deleting an
 * account with a purchase in flight is refused).
 */
export const providerPurchasesAttemptsMigration: Migration = {
  name: 'vps/0089_provider_purchases_attempts',
  sql: `
ALTER TABLE provider_purchases ADD COLUMN attempt_started_at timestamptz;
CREATE UNIQUE INDEX provider_purchases_reservation ON provider_purchases (account_id, reservation_id)
  WHERE reservation_id IS NOT NULL;
ALTER TABLE provider_purchases DROP CONSTRAINT IF EXISTS provider_purchases_account_id_fkey;
`,
};

/** The unique index that keeps one reservation to one purchase. */
const reservationIndex = 'provider_purchases_reservation';

/**
 * `unknown`: the attempts ran out while one may have bought; a person checks the provider account
 * (`providerAccounts.reservations` lists what was bought).
 */
export type PurchaseState = 'requested' | 'purchasing' | 'purchased' | 'failed' | 'unknown';

/** A purchase as the API shows it. */
export interface ProviderPurchaseView {
  id: string;
  accountId: string;
  offeringId: string;
  state: PurchaseState;
  /** Calls made to the provider so far. */
  attempts: number;
  /** The reservation bought (as `providerAccounts.reservations` will list it). */
  reservationId?: string;
  reservation?: ExternalReservation;
  error?: { code: string; message: string };
  createdAt: number;
  updatedAt: number;
}

// --- Input -----------------------------------------------------------------------------------------

export interface ReservationOfferingsInput {
  tenantId: string;
  accountId: string;
  query: ReservationOfferingQuery;
}

export interface PurchaseReservationInput {
  tenantId: string;
  accountId: string;
  offeringId: string;
  idempotencyKey: string;
  confirm?: boolean;
}

export interface ListPurchasesInput {
  tenantId: string;
  accountId: string;
}

const offeringIdPattern = /^[A-Za-z0-9._/:-]{1,300}$/;
const instanceTypePattern = /^[A-Za-z0-9._-]{1,64}$/;
const maxEpochMs = 2 ** 47;

function offeringIdOf(value: unknown): string {
  if (typeof value !== 'string' || !offeringIdPattern.test(value))
    throw new ComputeError('INVALID_INPUT', 'offeringId is invalid');
  return value;
}

export function parseReservationOfferings(raw: unknown): ReservationOfferingsInput {
  const input = object(raw, ['tenantId', 'accountId', 'query']);
  const q = object(input.query, [
    'instanceType',
    'count',
    'durationHours',
    'earliestStart',
    'latestStart',
  ]);
  if (typeof q.instanceType !== 'string' || !instanceTypePattern.test(q.instanceType))
    throw new ComputeError('INVALID_INPUT', 'query.instanceType is invalid');
  const query: ReservationOfferingQuery = {
    instanceType: q.instanceType,
    count: int(q.count, 'query.count', 1, 1000),
    durationHours: int(q.durationHours, 'query.durationHours', 1, 182 * 24),
  };
  const earliest = optional(q.earliestStart, (v) => int(v, 'query.earliestStart', 0, maxEpochMs));
  const latest = optional(q.latestStart, (v) => int(v, 'query.latestStart', 0, maxEpochMs));
  if (earliest !== undefined) query.earliestStart = earliest;
  if (latest !== undefined) query.latestStart = latest;
  if (earliest !== undefined && latest !== undefined && latest < earliest)
    throw new ComputeError('INVALID_INPUT', 'query.latestStart is before query.earliestStart');
  return {
    tenantId: tenant(input.tenantId),
    accountId: id(input.accountId, 'pacct', 'accountId'),
    query,
  };
}

export function parsePurchaseReservation(raw: unknown): PurchaseReservationInput {
  const input = object(raw, ['tenantId', 'accountId', 'offeringId', 'idempotencyKey', 'confirm']);
  if (input.confirm !== undefined && typeof input.confirm !== 'boolean')
    throw new ComputeError('INVALID_INPUT', 'confirm must be a boolean');
  return {
    tenantId: tenant(input.tenantId),
    accountId: id(input.accountId, 'pacct', 'accountId'),
    offeringId: offeringIdOf(input.offeringId),
    idempotencyKey: key(input.idempotencyKey),
    ...(input.confirm !== undefined ? { confirm: input.confirm } : {}),
  };
}

export function parseListPurchases(raw: unknown): ListPurchasesInput {
  const input = object(raw, ['tenantId', 'accountId']);
  return {
    tenantId: tenant(input.tenantId),
    accountId: id(input.accountId, 'pacct', 'accountId'),
  };
}

const tenantField: InputSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._:-]{1,128}$',
  maxLength: 128,
  description: 'The tenant that owns the provider account',
};
const accountField: InputSchema = {
  type: 'string',
  pattern: '^pacct_[0-9a-hjkmnp-tv-z]{26,52}$',
  maxLength: 58,
  description: 'The provider account',
};
const offeringField: InputSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9._/:-]{1,300}$',
  maxLength: 300,
  description: 'The offering, as `reservationOfferings` lists it',
};
const epochMs = (description: string): InputSchema => ({
  type: 'integer',
  minimum: 0,
  maximum: maxEpochMs,
  description,
});

export const purchaseSchemas = {
  reservationOfferings: strictObject(
    {
      tenantId: tenantField,
      accountId: accountField,
      query: strictObject(
        {
          instanceType: {
            type: 'string',
            pattern: '^[A-Za-z0-9._-]{1,64}$',
            maxLength: 64,
            description: 'The machine type, e.g. p5.48xlarge',
          },
          count: { type: 'integer', minimum: 1, maximum: 1000, description: 'Machines' },
          durationHours: {
            type: 'integer',
            minimum: 1,
            maximum: 182 * 24,
            description: 'How long the capacity is held',
          },
          earliestStart: epochMs('The earliest start, epoch milliseconds'),
          latestStart: epochMs('The latest start, epoch milliseconds'),
        },
        ['instanceType', 'count', 'durationHours'],
      ),
    },
    ['tenantId', 'accountId', 'query'],
  ),
  purchaseReservation: strictObject(
    {
      tenantId: tenantField,
      accountId: accountField,
      offeringId: offeringField,
      idempotencyKey: {
        type: 'string',
        pattern: '^[A-Za-z0-9._:-]{1,128}$',
        maxLength: 128,
        description:
          'Scoped to (tenant, caller identity): a retry with the same key replays and never buys twice',
      },
      confirm: {
        type: 'boolean',
        description: 'Must be true: buying capacity spends money',
      },
    },
    ['tenantId', 'accountId', 'offeringId', 'idempotencyKey'],
  ),
  purchases: strictObject({ tenantId: tenantField, accountId: accountField }, [
    'tenantId',
    'accountId',
  ]),
} satisfies Record<string, InputSchema>;

// --- Store -----------------------------------------------------------------------------------------

interface PurchaseRow {
  id: string;
  account_id: string;
  tenant_id: string;
  created_by: string;
  idempotency_key: string;
  offering_id: string;
  state: PurchaseState;
  attempts: number;
  reservation_id: string | null;
  reservation: ExternalReservation | string | null;
  error: { code: string; message: string } | string | null;
  uncertain_since: Date | null;
  attempt_started_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const columns = `id, account_id, tenant_id, created_by, idempotency_key, offering_id, state, attempts,
  reservation_id, reservation, error, uncertain_since, attempt_started_at, created_at, updated_at`;

const json = <T>(value: T | string | null): T | undefined =>
  value === null ? undefined : typeof value === 'string' ? (JSON.parse(value) as T) : value;

function viewOf(row: PurchaseRow): ProviderPurchaseView {
  const view: ProviderPurchaseView = {
    id: row.id,
    accountId: row.account_id,
    offeringId: row.offering_id,
    state: row.state,
    attempts: Number(row.attempts),
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
  if (row.reservation_id !== null) view.reservationId = row.reservation_id;
  const reservation = json<ExternalReservation>(row.reservation);
  if (reservation) view.reservation = reservation;
  const error = json<{ code: string; message: string }>(row.error);
  if (error) view.error = error;
  return view;
}

async function byKey(
  tx: SqlTx,
  tenantId: string,
  createdBy: string,
  idempotencyKey: string,
): Promise<PurchaseRow | undefined> {
  const { rows } = await tx.query<PurchaseRow>(
    `SELECT ${columns} FROM provider_purchases
      WHERE tenant_id = $1 AND created_by = $2 AND idempotency_key = $3`,
    [tenantId, createdBy, idempotencyKey],
  );
  return rows[0];
}

function sameRequest(row: PurchaseRow, input: PurchaseReservationInput): boolean {
  return row.account_id === input.accountId && row.offering_id === input.offeringId;
}

// --- Deps ------------------------------------------------------------------------------------------

export interface PurchaseDeps {
  clock: Clock;
  events: EventPublisher;
  work: ModuleContext['work'];
  log: Logger;
  secrets: SecretResolver;
  clients: ProviderClients;
  rootTenantId?: string;
  workload?: ClientDeps['workload'];
}

/** A provider read or purchase gets this long, well inside the reconciler's claim. */
const callBudgetMs = 45_000;

function callContext(deps: PurchaseDeps, idempotencyKey: string, signal: AbortSignal): CallContext {
  return {
    idempotencyKey,
    signal: AbortSignal.any([signal, AbortSignal.timeout(callBudgetMs)]),
    clock: deps.clock,
    secrets: deps.secrets,
    log: deps.log,
  };
}

function rootOnly(caller: Caller | undefined, rootTenantId: string | undefined): void {
  if (!isRootCaller(caller, rootTenantId))
    throw new ComputeError(
      'ACCESS_DENIED',
      'Only the platform (root tenant) buys provider capacity',
    );
}

// --- API -------------------------------------------------------------------------------------------

/**
 * `providerAccounts.reservationOfferings`: what the account could buy. A provider read; no spend.
 * Root-only, on the platform's own accounts (like buying), and declared `transaction: 'manual'`:
 * `sql` is the read-only executor, so the provider calls run with no transaction open.
 */
export async function listReservationOfferings(
  deps: PurchaseDeps,
  sql: SqlTx,
  input: ReservationOfferingsInput,
  caller: Caller | undefined,
  signal: AbortSignal,
): Promise<{ items: ReservationOffering[] }> {
  rootOnly(caller, deps.rootTenantId);
  const account = await readAccount(sql, input.accountId, input.tenantId);
  if (!account)
    throw new ComputeError('NOT_FOUND', `Provider account ${input.accountId} not found`);
  if (account.tenantId !== deps.rootTenantId)
    throw new ComputeError(
      'ACCESS_DENIED',
      "Capacity is bought only in the platform's own provider accounts",
    );
  const client = await deps.clients.client(account, deps);
  if (typeof client.listReservationOfferings !== 'function')
    throw new ComputeError(
      'UNSUPPORTED',
      `Provider ${account.provider} sells no capacity ahead of time`,
    );
  return {
    items: await client.listReservationOfferings(
      input.query,
      callContext(deps, `offerings:${input.accountId}`, signal),
    ),
  };
}

/**
 * The provider of the account each admitted request names, as `preparePurchase` read it: the
 * approver's text comes from that provider only (`describePurchaseFor`), never from another plugin
 * that claims the offering id. Keyed by the request's input object, which the admission passes to
 * `prepare` and then `describe`.
 */
const accountProviders = new WeakMap<PurchaseReservationInput, string>();

/** The admission's first transaction: a finished request with the same key replays. */
export async function preparePurchase(
  tx: SqlTx,
  input: PurchaseReservationInput,
  caller: Caller | undefined,
): Promise<ProviderPurchaseView | undefined> {
  if (!caller) return undefined;
  const existing = await byKey(tx, input.tenantId, caller.identityId, input.idempotencyKey);
  if (!existing) {
    const account = await readAccount(tx, input.accountId, input.tenantId);
    if (account) accountProviders.set(input, account.provider);
    return undefined;
  }
  if (!sameRequest(existing, input))
    throw new ComputeError('CONFLICT', 'This idempotency key was used for a different purchase');
  return viewOf(existing);
}

/**
 * The approver's text for an admitted request: described by the provider of the account
 * `preparePurchase` read, and by no other; the raw id when there is none.
 */
export function describePurchaseFor(
  input: PurchaseReservationInput,
  providers: ReadonlyMap<string, Pick<ProviderDefinition, 'describeOffering'>>,
): string {
  const name = accountProviders.get(input);
  const provider = name === undefined ? undefined : providers.get(name);
  return describePurchase(input, provider ? [provider] : []);
}

/**
 * What a person asked to approve the purchase reads: the provider's own account of the offering
 * (what, where, when, what it costs) when one of `providers` describes it, else the raw id.
 */
export function describePurchase(
  input: PurchaseReservationInput,
  providers: Iterable<Pick<ProviderDefinition, 'describeOffering'>> = [],
): string {
  let what: string | undefined;
  for (const provider of providers) {
    try {
      what = provider.describeOffering?.(input.offeringId);
    } catch {
      what = undefined;
    }
    if (what) break;
  }
  const summary = what ? `${what.slice(0, 400)} (offering ${input.offeringId})` : input.offeringId;
  return `Buy provider capacity: ${summary}, in provider account ${input.accountId}. This spends money.`;
}

/**
 * `providerAccounts.purchaseReservation`: records the purchase and wakes the reconciler, which buys.
 * Root-only, `confirm: true`, an account whose provider can buy; a retry with the same key returns
 * the same purchase.
 */
export async function requestPurchase(
  deps: PurchaseDeps,
  tx: SqlTx,
  input: PurchaseReservationInput,
  caller: Caller | undefined,
): Promise<ProviderPurchaseView> {
  rootOnly(caller, deps.rootTenantId);
  const existing = await byKey(tx, input.tenantId, caller!.identityId, input.idempotencyKey);
  if (existing) {
    if (!sameRequest(existing, input))
      throw new ComputeError('CONFLICT', 'This idempotency key was used for a different purchase');
    return viewOf(existing);
  }
  if (input.confirm !== true)
    throw new ComputeError(
      'CONFIRMATION_REQUIRED',
      'Buying capacity spends money: retry with confirm: true and the same idempotencyKey',
      undefined,
      { reason: 'confirm-spend', offeringId: input.offeringId, accountId: input.accountId },
    );
  const account = await readAccount(tx, input.accountId, input.tenantId);
  if (!account)
    throw new ComputeError('NOT_FOUND', `Provider account ${input.accountId} not found`);
  // Only the platform's own accounts are spent from, never a tenant's.
  if (account.tenantId !== deps.rootTenantId)
    throw new ComputeError(
      'ACCESS_DENIED',
      "Capacity is bought only in the platform's own provider accounts",
    );
  // Building the client validates its config; it calls no provider API.
  const client = await deps.clients.client(account, deps);
  if (typeof client.purchaseReservation !== 'function')
    throw new ComputeError(
      'UNSUPPORTED',
      `Provider account ${account.id} cannot buy capacity: provider ${account.provider} sells none, or the account does not allow purchases`,
      undefined,
      { reason: 'purchases-unavailable', accountId: account.id },
    );
  const purchaseId = newId('ppur');
  // A concurrent request with the same key may insert first: replay its purchase.
  const { rows } = await tx.query<PurchaseRow>(
    `INSERT INTO provider_purchases (id, account_id, tenant_id, created_by, idempotency_key, offering_id, state)
     VALUES ($1, $2, $3, $4, $5, $6, 'requested')
     ON CONFLICT (tenant_id, created_by, idempotency_key) DO NOTHING
     RETURNING ${columns}`,
    [
      purchaseId,
      input.accountId,
      input.tenantId,
      caller!.identityId,
      input.idempotencyKey,
      input.offeringId,
    ],
  );
  if (!rows[0]) {
    const winner = await byKey(tx, input.tenantId, caller!.identityId, input.idempotencyKey);
    if (!winner) throw new ComputeError('CONFLICT', 'The purchase changed underneath; retry');
    if (!sameRequest(winner, input))
      throw new ComputeError('CONFLICT', 'This idempotency key was used for a different purchase');
    return viewOf(winner);
  }
  await deps.work.enqueue(tx, purchasesWork, purchaseId);
  await deps.events.publish(tx, {
    type: 'provider.purchase.requested',
    subject: `provider-account/${input.accountId}`,
    tenantId: account.tenantId,
    data: { accountId: input.accountId, purchaseId, offeringId: input.offeringId },
  });
  return viewOf(rows[0]!);
}

/** The `poll` of `purchaseReservation`: done once the purchase settled. */
export const purchasePoll = {
  done: (output: ProviderPurchaseView): boolean =>
    output.state === 'purchased' || output.state === 'failed' || output.state === 'unknown',
  async refresh(
    context: { sql: SqlTx },
    _input: PurchaseReservationInput,
    output: ProviderPurchaseView,
  ): Promise<ProviderPurchaseView> {
    const { rows } = await context.sql.query<PurchaseRow>(
      `SELECT ${columns} FROM provider_purchases WHERE id = $1`,
      [output.id],
    );
    return rows[0] ? viewOf(rows[0]) : output;
  },
};

/** `providerAccounts.purchases`: the account's purchases, newest first (root-only). */
export async function listPurchases(
  deps: Pick<PurchaseDeps, 'rootTenantId'>,
  tx: SqlTx,
  input: ListPurchasesInput,
  caller: Caller | undefined,
): Promise<{ items: ProviderPurchaseView[] }> {
  rootOnly(caller, deps.rootTenantId);
  const { rows } = await tx.query<PurchaseRow>(
    `SELECT ${columns} FROM provider_purchases
      WHERE account_id = $1 AND tenant_id = $2
      ORDER BY created_at DESC, id DESC LIMIT 500`,
    [input.accountId, input.tenantId],
  );
  return { items: rows.map(viewOf) };
}

// --- The reconciler --------------------------------------------------------------------------------

/** Errors worth another attempt: the provider may not have bought, or may not show it yet. */
const retryable = new Set(['UNAVAILABLE', 'RATE_LIMITED', 'TIMEOUT']);

/**
 * The provider's own answer that this attempt bought nothing: it waits for what an earlier attempt
 * may have bought to show. It leaves the purchase as uncertain as it was.
 */
function propagating(error: unknown): boolean {
  return (
    isComputeError(error, 'UNAVAILABLE') &&
    (error.details as { reason?: unknown } | undefined)?.reason === 'purchase-propagating'
  );
}
/**
 * The provider's own statement that the attempt failed before it sent the purchase request (a
 * throttled read, a credential refresh that failed): it provably bought nothing, so the purchase is
 * retried and stays as uncertain as it was. A provider says so only for failures raised before the
 * request left; anything else that is retried may have bought.
 */
function notSent(error: unknown): boolean {
  return (
    isComputeError(error) &&
    (error.details as { reason?: unknown } | undefined)?.reason === 'purchase-not-sent'
  );
}
const maxAttempts = 20;
const retryMs = (attempt: number) => Math.min(15 * 60_000, 15_000 * 2 ** Math.min(attempt, 6));

function safeError(error: unknown): { code: string; message: string } {
  if (isComputeError(error)) return { code: error.code, message: error.message.slice(0, 512) };
  return { code: 'PROVIDER_ERROR', message: 'The provider failed the purchase' };
}

/** How far back recorded reservations are left out of a purchase's search (clock skew included). */
const excludeWindowMs = 10 * 60_000;

/**
 * One purchase: claim it (requested → purchasing, attempts + 1, `attempt_started_at` now) in a
 * transaction, buy outside any transaction with the purchase's own key, then record the outcome in
 * one. A purchase found in `purchasing` (a crash, a lost lease, a failed settle or a retryable
 * failure) is bought again with the same key: the provider answers with what it already bought.
 * An earlier attempt that never settled (`attempt_started_at` still set) may have bought, so the
 * claim makes it `uncertain_since` and the provider waits for what it bought before buying again.
 * Returns when to run again, if at all.
 */
export async function reconcilePurchase(
  deps: PurchaseDeps,
  sql: SqlExecutor,
  purchaseId: string,
  signal: AbortSignal,
): Promise<number | undefined> {
  const startedAt = deps.clock.now();
  const claim = await sql.transaction(async (tx) => {
    const { rows } = await tx.query<PurchaseRow>(
      `UPDATE provider_purchases
          SET uncertain_since = CASE WHEN state = 'purchasing' AND attempt_started_at IS NOT NULL
                THEN GREATEST(COALESCE(uncertain_since, attempt_started_at), attempt_started_at)
                ELSE uncertain_since END,
              attempt_started_at = $2::timestamptz,
              state = 'purchasing', attempts = attempts + 1, updated_at = compute_now()
        WHERE id = $1 AND state IN ('requested', 'purchasing')
        RETURNING ${columns}`,
      [purchaseId, new Date(startedAt)],
    );
    const row = rows[0];
    if (!row) return undefined;
    // What other purchases of the account recorded since this one was requested: never ours.
    const recorded = await tx.query<{ reservation_id: string }>(
      `SELECT reservation_id FROM provider_purchases
        WHERE account_id = $1 AND id <> $2 AND reservation_id IS NOT NULL AND updated_at >= $3
        ORDER BY updated_at, id LIMIT 200`,
      [row.account_id, row.id, new Date(row.created_at.getTime() - excludeWindowMs)],
    );
    return { row, exclude: recorded.rows.map((r) => r.reservation_id) };
  });
  if (!claim) return undefined;
  const claimed = claim.row;
  const account = await sql.transaction((tx) => readAccount(tx, claimed.account_id));
  if (!account) return undefined;
  let bought: ExternalReservation;
  /** Whether the provider was asked to buy: a failure before that bought nothing. */
  let asked = false;
  try {
    // Purchases stay the platform's even if the account changed hands since the request.
    if (
      deps.rootTenantId === undefined ||
      account.tenantId !== claimed.tenant_id ||
      account.tenantId !== deps.rootTenantId
    )
      throw new ComputeError(
        'ACCESS_DENIED',
        'The provider account changed since the purchase was requested',
      );
    const client = await deps.clients.client(account, deps);
    if (typeof client.purchaseReservation !== 'function')
      throw new ComputeError('UNSUPPORTED', `Provider ${account.provider} cannot buy capacity`);
    const attempt: PurchaseAttempt = {
      attempt: Number(claimed.attempts),
      requestedAt: claimed.created_at.getTime(),
      ...(claimed.uncertain_since ? { uncertainSince: claimed.uncertain_since.getTime() } : {}),
      ...(claim.exclude.length ? { excludeReservationIds: claim.exclude } : {}),
    };
    const context = callContext(deps, `purchase:${claimed.id}`, signal);
    asked = true;
    bought = await client.purchaseReservation(claimed.offering_id, context, attempt);
  } catch (error) {
    const failure = safeError(error);
    // A failure that is not the provider's answer (a timeout, a dropped connection) may or may not
    // have bought: try again with the same key, which the provider makes idempotent, and tell it
    // when this attempt started (it waits for what it may have bought before buying again).
    const retry = !isComputeError(error) || retryable.has(error.code);
    // Uncertain unless it provably bought nothing: the provider was never asked, it says the
    // purchase request was not sent, or it says it only waited for an earlier attempt. Marking an
    // attempt that sent nothing uncertain would hold every later attempt back while the provider
    // waits for a purchase that never happened. Anything else that is retried stays uncertain.
    const uncertain = retry && asked && !propagating(error) && !notSent(error);
    const again = retry && Number(claimed.attempts) < maxAttempts;
    // Settled while this or an earlier attempt may have bought (out of attempts, or refused after
    // one whose answer was lost): money may have been spent, so 'unknown', never 'failed'.
    const state = again
      ? undefined
      : (retry && uncertain) || claimed.uncertain_since
        ? 'unknown'
        : 'failed';
    const settled = await sql.transaction(async (tx) => {
      // Only this attempt settles (a later claim owns the purchase now).
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE provider_purchases
            SET state = COALESCE($3, state), error = $2::jsonb,
                uncertain_since = CASE WHEN $4::boolean THEN $5::timestamptz ELSE uncertain_since END,
                attempt_started_at = NULL, updated_at = compute_now()
          WHERE id = $1 AND state = 'purchasing' AND attempts = $6
          RETURNING id`,
        [
          claimed.id,
          JSON.stringify(failure),
          state ?? null,
          uncertain,
          new Date(startedAt),
          Number(claimed.attempts),
        ],
      );
      // Only the run that settled the purchase says so (a concurrent run may have recorded it).
      if (!state || !rows[0]) return false;
      await deps.events.publish(tx, {
        type: state === 'unknown' ? 'provider.purchase.unknown' : 'provider.purchase.failed',
        subject: `provider-account/${claimed.account_id}`,
        tenantId: claimed.tenant_id,
        data: {
          accountId: claimed.account_id,
          purchaseId: claimed.id,
          offeringId: claimed.offering_id,
          code: failure.code,
        },
      });
      return true;
    });
    if (settled)
      deps.log.warn(state === 'unknown' ? 'vps.purchase_unknown' : 'vps.purchase_failed', {
        purchaseId: claimed.id,
        code: failure.code,
      });
    return again ? deps.clock.now() + retryMs(Number(claimed.attempts)) : undefined;
  }
  // The provider's answer is authoritative: it is recorded even when another run settled the
  // purchase failed or unknown meanwhile (this run's lease expired while the provider sold).
  const unrecorded = { purchaseId: claimed.id, reservationId: bought.id };
  let recorded: boolean;
  try {
    recorded = await sql.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE provider_purchases
            SET state = 'purchased', reservation_id = $2, reservation = $3::jsonb, error = NULL,
                attempt_started_at = NULL, updated_at = compute_now()
          WHERE id = $1 AND state IN ('purchasing', 'failed', 'unknown')
          RETURNING id`,
        [claimed.id, bought.id, JSON.stringify(bought)],
      );
      if (!rows[0]) return false;
      // The reservations worker reads the account at once, so the bought reservation can be bound.
      await deps.work.enqueue(tx, reservationsWork, claimed.account_id);
      await deps.events.publish(tx, {
        type: 'provider.purchase.completed',
        subject: `provider-account/${claimed.account_id}`,
        tenantId: claimed.tenant_id,
        data: {
          accountId: claimed.account_id,
          purchaseId: claimed.id,
          offeringId: claimed.offering_id,
          reservationId: bought.id,
          state: bought.state,
        },
      });
      return true;
    });
  } catch (error) {
    // Another purchase recorded this reservation: the provider took it for this purchase's (its
    // search by what a block is cannot tell them apart). Not this purchase's: retry, leaving the
    // attempt unsettled (uncertain) and the recorded reservation out of the next search.
    if (
      (error as { code?: unknown } | null)?.code === '23505' &&
      (error as { constraint?: unknown }).constraint === reservationIndex
    ) {
      deps.log.warn('vps.purchase_duplicate', unrecorded);
      return Number(claimed.attempts) < maxAttempts
        ? deps.clock.now() + retryMs(Number(claimed.attempts))
        : undefined;
    }
    // Not recorded (the transaction failed or was refused): the attempt stays unsettled, so the
    // next one is uncertain and finds what was bought; a person can reconcile from this line.
    deps.log.warn('vps.purchase_unrecorded', unrecorded);
    throw error;
  }
  if (!recorded) {
    const { rows } = await sql.transaction((tx) =>
      tx.query<{ state: string; reservation_id: string | null }>(
        `SELECT state, reservation_id FROM provider_purchases WHERE id = $1`,
        [claimed.id],
      ),
    );
    // Already recorded with this reservation by another run: nothing lost.
    if (rows[0]?.state !== 'purchased' || rows[0].reservation_id !== bought.id)
      deps.log.warn('vps.purchase_unrecorded', unrecorded);
  }
  return undefined;
}

export function providerPurchasesReconciler(
  depsOf: (context: ModuleContext) => PurchaseDeps,
): Reconciler {
  return {
    name: purchasesWork,
    shardBy: 'none',
    async run(context, purchaseId) {
      const deps = depsOf(context);
      const next = await reconcilePurchase(deps, context.sql, purchaseId, context.signal);
      if (next !== undefined)
        await context.sql.transaction((tx) =>
          context.work.enqueue(tx, purchasesWork, purchaseId, { notBefore: next }),
        );
      return 'DONE';
    },
  };
}
