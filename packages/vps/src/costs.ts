import {
  ComputeError,
  isComputeError,
  parseDuration,
  type CallContext,
  type Duration,
  type Json,
  type Migration,
  type ModuleContext,
  type ProviderCostRecord,
  type ProviderDefinition,
  type ReconcileContext,
  type Reconciler,
  type SqlTx,
} from '@better-compute/core';
import { readAccount, type PassThroughRule, type ProviderAccount } from './accounts.js';
import { canonical } from './input.js';
import type { InstanceDeps } from './instances.js';

// Provider costs (platform compute billing, D10): the `vps.costs` worker reads each provider account's
// billed cost rows (`ProviderImpl.costs`, e.g. GCP's BigQuery billing export) into `provider_costs`
// and attributes each row to a tenant. Key `all` (periodic, default 6h) seeds one
// `provider_cost_scans` row per account whose client implements `costs` and enqueues the accounts
// that are due; key `<accountId>` runs one account's pass: the last `lookbackDays` (default 3) read
// outside any transaction (45 s budget), then upserted in batches of 500. Rows are keyed by the
// provider's stable row hash, so re-exports are idempotent and a corrected row replaces the stored
// one (a newer export wins; an older one is ignored).

/** The work kind of the cost reconciler (keys: `all`, or a provider account id). */
export const costsWork = 'vps.costs';

/** How long one account's `costs` read may run (a reconciler run stays under claimTtlMs, 60 s). */
export const costsBudgetMs = 45_000;
/** How long a run of one account may take before it stops between write batches (default 50 s). */
export const costsPassBudgetMs = 50_000;
/** The back-off after a rate limit or an outage the provider gave no retry hint for. */
const transientBackoffMs = 5 * 60_000;
/** Rows written per transaction. */
const batchSize = 500;
const dayMs = 86_400_000;
const HOUR = 3_600_000;
/** D18: a month counts as closed once the next one is this many hours old (`vps({ billing: { closeGraceHours } })`). */
export const defaultCloseGraceHours = 6;

/** The first hour of the UTC month holding `at`. */
const monthStartOf = (at: number): number => {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};
/** Whether the UTC month holding `at` has closed at `now` (its end plus the grace has passed). */
const monthClosed = (at: number, now: number, closeGraceHours: number): boolean => {
  const date = new Date(at);
  return now >= Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) + closeGraceHours * HOUR;
};

/** The labels better-compute writes on provider resources, read back from cost rows. */
export const costLabels = {
  instance: 'better-compute-instance',
  tenant: 'better-compute-tenant',
} as const;

/** The condition a row in another currency than the deployment's carries (excluded from pass-through and margins). */
export const currencyMismatch = 'CurrencyMismatch';

export interface CostsOptions {
  /** How often each account's costs are read (default `6h`). */
  every?: Duration;
  /** How far back each pass reads, in days (default 3, at most 31): late and corrected rows land within it. */
  lookbackDays?: number;
  /**
   * Leak detection (D12): an instance whose provider-billed compute hours in a UTC day exceed its metered running
   * hours by more than this raises `billing.leak` (default 1).
   */
  leakToleranceHours?: number;
  /**
   * How long one account's run may take (default 50 s, under the 60 s claim): the read gets what is left of it (at
   * most 45 s), and writing stops between batches once it has passed, continuing in a run enqueued at once.
   */
  passBudgetMs?: number;
}

export const providerCostsMigration: Migration = {
  name: 'vps/0033_provider_costs',
  sql: `
CREATE TABLE provider_costs (
  account_id text NOT NULL REFERENCES provider_accounts ON DELETE CASCADE,
  source_row_id text NOT NULL,
  -- The ProviderCostRecord as last ingested.
  record jsonb NOT NULL,
  usage_start timestamptz NOT NULL, usage_end timestamptz NOT NULL,
  cost_micros bigint NOT NULL, credits_micros bigint NOT NULL, currency text NOT NULL,
  instance_id text, tenant_id text,
  attribution text NOT NULL CHECK (attribution IN ('instance', 'tenant-label', 'account', 'unattributed')),
  -- CurrencyMismatch: stored as received, excluded from pass-through and margins.
  conditions text[] NOT NULL DEFAULT '{}',
  passed_through_at timestamptz, pass_through_key text,
  -- The reported meter the row was passed through on (margins by meter).
  pass_through_meter text,
  ingested_at timestamptz NOT NULL DEFAULT compute_now(), updated_at timestamptz NOT NULL DEFAULT compute_now(),
  PRIMARY KEY (account_id, source_row_id)
);
CREATE INDEX provider_costs_tenant_day ON provider_costs (tenant_id, usage_start);
-- A pass's own rows (pass-through, leak check) and the margins range.
CREATE INDEX provider_costs_account_day ON provider_costs (account_id, usage_start);
CREATE INDEX provider_costs_day ON provider_costs (usage_start);
CREATE TABLE provider_cost_scans (account_id text PRIMARY KEY REFERENCES provider_accounts ON DELETE CASCADE,
  next_at timestamptz NOT NULL, scanned_to timestamptz, last_error text);
-- billing.leak raised (D12): at most once per instance and UTC day.
CREATE TABLE provider_cost_leaks (
  instance_id text NOT NULL, day date NOT NULL,
  account_id text NOT NULL REFERENCES provider_accounts ON DELETE CASCADE,
  provider_hours numeric NOT NULL, metered_hours numeric NOT NULL,
  raised_at timestamptz NOT NULL DEFAULT compute_now(),
  PRIMARY KEY (instance_id, day)
);
-- Pass-through rules (Task 16), validated by vps.
ALTER TABLE provider_accounts ADD COLUMN billing jsonb NOT NULL DEFAULT '{}';
`,
};

/** What the cost reconciler needs beyond its context. */
export interface CostsDeps extends InstanceDeps {
  /** The registered provider definitions, by id. */
  providers: ReadonlyMap<string, ProviderDefinition>;
}

/** How a cost row was attributed (D10's order). */
export type CostAttribution = 'instance' | 'tenant-label' | 'account' | 'unattributed';

/** One record ready to store. */
interface AttributedCost {
  record: ProviderCostRecord;
  instanceId: string | null;
  tenantId: string | null;
  attribution: CostAttribution;
  conditions: string[];
}

interface StoredCost {
  source_row_id: string;
  record: ProviderCostRecord | string;
  cost_micros: string | number;
  credits_micros: string | number;
  passed: boolean;
}

const json = <T>(value: T | string): T =>
  typeof value === 'string' ? (JSON.parse(value) as T) : value;

const tenantPattern = /^[A-Za-z0-9._:-]{1,128}$/;

/** The record minus what a re-export changes without changing the row (its export time). */
const content = (record: ProviderCostRecord): string =>
  canonical({ ...record, exportTime: undefined });

/** Whether an account is the platform's (the IAM root tenant's) rather than a tenant's own (BYO). */
export const isPlatformAccount = (
  account: Pick<ProviderAccount, 'tenantId'>,
  rootTenantId: string | undefined,
): boolean => rootTenantId !== undefined && account.tenantId === rootTenantId;

/**
 * Attributes records of one account (D10): the `better-compute-instance` label when it names an instance of this
 * account (its tenant), then the `better-compute-tenant` label, then the account's tenant when the account is a
 * tenant's own (BYO), else `unattributed`. On a tenant's own account the tenant wrote the labels, so a label never
 * moves a cost to another tenant: an instance label must name an instance of this account, and a tenant label is
 * ignored there (the account's tenant pays).
 */
async function attribute(
  tx: SqlTx,
  account: ProviderAccount,
  platform: boolean,
  records: readonly ProviderCostRecord[],
  currency: string,
): Promise<AttributedCost[]> {
  const labelled = [
    ...new Set(
      records
        .map((record) => record.labels[costLabels.instance])
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  ];
  const instances = new Map<string, string>();
  if (labelled.length > 0) {
    const { rows } = await tx.query<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id FROM instances WHERE provider_account_id = $1 AND id = ANY($2::text[])`,
      [account.id, labelled],
    );
    for (const row of rows) instances.set(row.id, row.tenant_id);
  }
  // A tenant label names a tenant compute knows (it owns or is offered a pool, or holds instances, accounts or
  // projects); any other is unattributed, never billed to a name nobody checked.
  const known = new Set<string>();
  const tenantLabels = platform
    ? [
        ...new Set(
          records
            .map((record) => record.labels[costLabels.tenant])
            .filter(
              (value): value is string => typeof value === 'string' && tenantPattern.test(value),
            ),
        ),
      ]
    : [];
  if (tenantLabels.length > 0) {
    const { rows } = await tx.query<{ tenant: string }>(
      `SELECT t AS tenant FROM unnest($1::text[]) AS t
        WHERE EXISTS (SELECT 1 FROM pool_offers o WHERE o.tenant_id = t)
           OR EXISTS (SELECT 1 FROM pools p WHERE p.owner_tenant_id = t)
           OR EXISTS (SELECT 1 FROM instances i WHERE i.tenant_id = t)
           OR EXISTS (SELECT 1 FROM provider_accounts a WHERE a.tenant_id = t)
           OR EXISTS (SELECT 1 FROM projects j WHERE j.tenant_id = t)`,
      [tenantLabels],
    );
    for (const row of rows) known.add(row.tenant);
  }
  return records.map((record) => {
    const conditions =
      record.currency.toUpperCase() === currency.toUpperCase() ? [] : [currencyMismatch];
    const instanceId = record.labels[costLabels.instance];
    const instanceTenant = instanceId !== undefined ? instances.get(instanceId) : undefined;
    if (!platform)
      // A tenant's own account: the tenant pays the provider for every row, whoever runs on it (its pool may be
      // offered to another tenant); the instance is kept only when it is the account tenant's own.
      return {
        record,
        instanceId:
          instanceId !== undefined && instanceTenant === account.tenantId ? instanceId : null,
        tenantId: account.tenantId,
        attribution: 'account',
        conditions,
      };
    if (instanceId !== undefined && instanceTenant !== undefined)
      return { record, instanceId, tenantId: instanceTenant, attribution: 'instance', conditions };
    const tenantLabel = record.labels[costLabels.tenant];
    if (tenantLabel !== undefined && known.has(tenantLabel))
      return {
        record,
        instanceId: null,
        tenantId: tenantLabel,
        attribution: 'tenant-label',
        conditions,
      };
    return { record, instanceId: null, tenantId: null, attribution: 'unattributed', conditions };
  });
}

/** Totals of one account's pass, published as `billing.cost-ingested`. */
interface PassTotals {
  rows: number;
  inserted: number;
  corrected: number;
  unchanged: number;
  stale: number;
  /** Σ cost / credits over rows in the deployment currency. */
  costMicros: number;
  creditsMicros: number;
  unattributedRows: number;
  currencyMismatchRows: number;
}

async function publish(
  deps: CostsDeps,
  tx: SqlTx,
  account: ProviderAccount,
  type: string,
  data: Record<string, Json>,
): Promise<void> {
  await deps.events.publish(tx, {
    type,
    tenantId: account.tenantId,
    subject: `provider-account/${account.id}`,
    data: { accountId: account.id, ...data },
  });
}

const rowJson = (cost: AttributedCost) => ({
  id: cost.record.sourceRowId,
  record: cost.record,
  usageStart: cost.record.usageStart,
  usageEnd: cost.record.usageEnd,
  cost: cost.record.costMicros,
  credits: cost.record.creditsMicros,
  currency: cost.record.currency,
  instanceId: cost.instanceId,
  tenantId: cost.tenantId,
  attribution: cost.attribution,
  conditions: cost.conditions,
});

/**
 * Writes one batch of an account's records (in its transaction): new rows are inserted, rows whose content changed
 * in a newer export replace the stored row (`billing.cost-corrected` when the cost or credits changed), older
 * exports and unchanged rows are left alone. `billing.unattributed` is published once per row, when it is first
 * stored.
 */
async function writeBatch(
  deps: CostsDeps,
  tx: SqlTx,
  account: ProviderAccount,
  batch: readonly AttributedCost[],
  totals: PassTotals,
): Promise<boolean> {
  const { rows } = await tx.query<StoredCost>(
    `SELECT source_row_id, record, cost_micros, credits_micros, passed_through_at IS NOT NULL AS passed
       FROM provider_costs WHERE account_id = $1 AND source_row_id = ANY($2::text[]) FOR UPDATE`,
    [account.id, batch.map((cost) => cost.record.sourceRowId)],
  );
  const stored = new Map(rows.map((row) => [row.source_row_id, row]));
  const inserts: AttributedCost[] = [];
  const updates: { cost: AttributedCost; before: StoredCost }[] = [];
  for (const cost of batch) {
    const before = stored.get(cost.record.sourceRowId);
    if (!before) inserts.push(cost);
    else {
      const previous = json(before.record);
      if (cost.record.exportTime < previous.exportTime) totals.stale++;
      else if (content(cost.record) === content(previous)) totals.unchanged++;
      else updates.push({ cost, before });
    }
  }
  const columns = `jsonb_array_elements($2::jsonb) AS r`;
  // Rows a concurrent pass stored first are not inserted twice, and not announced twice.
  const inserted = new Set<string>();
  if (inserts.length > 0) {
    const { rows: written } = await tx.query<{ source_row_id: string }>(
      `INSERT INTO provider_costs (account_id, source_row_id, record, usage_start, usage_end, cost_micros,
                                   credits_micros, currency, instance_id, tenant_id, attribution, conditions)
       SELECT $1, r->>'id', r->'record', to_timestamp((r->>'usageStart')::float8 / 1000),
              to_timestamp((r->>'usageEnd')::float8 / 1000), (r->>'cost')::bigint, (r->>'credits')::bigint,
              r->>'currency', r->>'instanceId', r->>'tenantId', r->>'attribution',
              ARRAY(SELECT jsonb_array_elements_text(r->'conditions'))
         FROM ${columns}
       ON CONFLICT (account_id, source_row_id) DO NOTHING
       RETURNING source_row_id`,
      [account.id, JSON.stringify(inserts.map(rowJson))],
    );
    for (const row of written) inserted.add(row.source_row_id);
  }
  if (updates.length > 0)
    await tx.query(
      `UPDATE provider_costs c
          SET record = r->'record', usage_start = to_timestamp((r->>'usageStart')::float8 / 1000),
              usage_end = to_timestamp((r->>'usageEnd')::float8 / 1000), cost_micros = (r->>'cost')::bigint,
              credits_micros = (r->>'credits')::bigint, currency = r->>'currency', instance_id = r->>'instanceId',
              tenant_id = r->>'tenantId', attribution = r->>'attribution',
              conditions = ARRAY(SELECT jsonb_array_elements_text(r->'conditions')), updated_at = compute_now()
         FROM ${columns}
        WHERE c.account_id = $1 AND c.source_row_id = r->>'id'`,
      [account.id, JSON.stringify(updates.map(({ cost }) => rowJson(cost)))],
    );
  totals.inserted += inserted.size;
  totals.unchanged += inserts.length - inserted.size;
  totals.corrected += updates.length;
  for (const cost of inserts)
    if (cost.attribution === 'unattributed' && inserted.has(cost.record.sourceRowId))
      await publish(deps, tx, account, 'billing.unattributed', {
        sourceRowId: cost.record.sourceRowId,
        service: cost.record.service,
        sku: cost.record.sku,
        ...(cost.record.resourceName !== undefined
          ? { resourceName: cost.record.resourceName }
          : {}),
        usageStart: cost.record.usageStart,
        costMicros: cost.record.costMicros,
        creditsMicros: cost.record.creditsMicros,
        currency: cost.record.currency,
      });
  for (const { cost, before } of updates) {
    const previousMicros = Number(before.cost_micros);
    const previousCredits = Number(before.credits_micros);
    if (previousMicros === cost.record.costMicros && previousCredits === cost.record.creditsMicros)
      continue;
    await publish(deps, tx, account, 'billing.cost-corrected', {
      sourceRowId: cost.record.sourceRowId,
      previousMicros,
      costMicros: cost.record.costMicros,
      previousCreditsMicros: previousCredits,
      creditsMicros: cost.record.creditsMicros,
      currency: cost.record.currency,
      passedThrough: before.passed,
    });
  }
  return inserted.size > 0 || updates.length > 0;
}

/** Whether a client reads the account's costs. */
const readsCosts = (client: { costs?: unknown }): boolean => typeof client.costs === 'function';

/** How early an account counts as due (see discovery's `dueSlackMs`). */
const dueSlackMs = (everyMs: number) => Math.min(everyMs / 10, 30_000);

/** Key `all`: seeds a row per account whose client reads costs, then enqueues the accounts that are due. */
async function seedAccounts(
  deps: CostsDeps,
  context: ReconcileContext,
  everyMs: number,
): Promise<void> {
  const { rows } = await context.sql.query<{ id: string }>(
    `SELECT id FROM provider_accounts ORDER BY id`,
  );
  const costing: string[] = [];
  for (const { id } of rows) {
    // Building a client validates the config and calls no provider API.
    try {
      const account = await context.sql.transaction((tx) => readAccount(tx, id));
      if (account && readsCosts(await deps.clients.client(account, deps))) costing.push(id);
    } catch (error) {
      deps.log.warn('vps.costs: skipping a provider account whose client cannot be built', {
        accountId: id,
        error: String((error as Error)?.message ?? error),
      });
    }
  }
  await context.sql.transaction(async (tx) => {
    if (costing.length > 0)
      await tx.query(
        `INSERT INTO provider_cost_scans (account_id, next_at)
         SELECT a, compute_now() FROM unnest($1::text[]) AS a ON CONFLICT DO NOTHING`,
        [costing],
      );
    const due = await tx.query<{ account_id: string }>(
      `SELECT account_id FROM provider_cost_scans
        WHERE next_at <= compute_now() + make_interval(secs => $2::float8)
          AND account_id = ANY($1::text[]) ORDER BY account_id`,
      [costing, dueSlackMs(everyMs) / 1000],
    );
    const ids = due.rows.map((row) => row.account_id);
    if (ids.length === 0) return;
    if (context.work.enqueueMany) await context.work.enqueueMany(tx, costsWork, ids);
    else for (const id of ids) await context.work.enqueue(tx, costsWork, id);
  });
}

async function recordFailure(
  tx: SqlTx,
  accountId: string,
  error: unknown,
  retryInMs: number,
): Promise<void> {
  const code = isComputeError(error) ? error.code : 'PROVIDER_ERROR';
  const message = String((error as Error)?.message ?? error).slice(0, 500);
  await tx.query(
    `UPDATE provider_cost_scans
        SET next_at = compute_now() + make_interval(secs => $2::float8), last_error = $3
      WHERE account_id = $1`,
    [accountId, retryInMs / 1000, `${code}: ${message}`],
  );
}

/** What runs after an account's rows are stored, in the pass's last transaction (pass-through, leak check). */
export type AfterCostPass = (
  tx: SqlTx,
  account: ProviderAccount,
  window: { from: number; to: number },
) => Promise<Record<string, Json> | void>;

/** Key `<accountId>`: one cost pass of one account. */
async function scanAccount(
  deps: CostsDeps,
  context: ReconcileContext,
  accountId: string,
  settings: { everyMs: number; lookbackMs: number; currency: string; passBudgetMs: number },
  after?: AfterCostPass,
): Promise<void> {
  // One deadline for the run (it stays under claimTtlMs, 60 s): the read gets what is left of it, at most 45 s,
  // and writing stops between batches once it has passed, leaving the rest to a run enqueued at once.
  const deadline = performance.now() + settings.passBudgetMs;
  const left = () => deadline - performance.now();
  const account = await context.sql.transaction((tx) => readAccount(tx, accountId));
  if (!account) return;
  const client = await deps.clients.client(account, deps);
  if (!client.costs) return;
  const { rows: started } = await context.sql.query<{ at: string }>(
    `SELECT compute_now()::text AS at`,
  );
  const startedAt = started[0]!.at;
  const now = deps.clock.now();
  const window = { from: now - settings.lookbackMs, to: now };
  const readBudgetMs = Math.max(1, Math.min(costsBudgetMs, left()));
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(readBudgetMs)]);
  const call: CallContext = {
    idempotencyKey: `costs:${account.id}`,
    signal,
    clock: deps.clock,
    secrets: deps.secrets,
    log: deps.log,
  };
  // Read everything before writing anything; one row per id, the newest export winning.
  const records = new Map<string, ProviderCostRecord>();
  try {
    for await (const record of client.costs(window, call)) {
      if (signal.aborted)
        throw new ComputeError(
          'UNAVAILABLE',
          `Reading the costs of ${account.name} took over 45 s`,
        );
      const seen = records.get(record.sourceRowId);
      if (!seen || record.exportTime >= seen.exportTime) records.set(record.sourceRowId, record);
    }
  } catch (failure) {
    // The worker is stopping (not our budget): nothing to record, the run is retried as it is.
    if (context.signal.aborted) throw failure;
    const error =
      signal.aborted && !isComputeError(failure)
        ? new ComputeError('UNAVAILABLE', `Reading the costs of ${account.name} took over 45 s`)
        : failure;
    // Rate limited (or a provider job still running): this account again after the provider's back-off; a
    // transient failure without a hint backs off 5 minutes, anything else waits for the next period.
    const retryAfterMs = isComputeError(error)
      ? (error.retryAfterMs ??
        (isComputeError(error, 'RATE_LIMITED') || isComputeError(error, 'UNAVAILABLE')
          ? transientBackoffMs
          : undefined))
      : undefined;
    await context.sql.transaction(async (tx) => {
      if (retryAfterMs !== undefined) {
        await recordFailure(tx, account.id, error, retryAfterMs);
        await context.work.enqueue(tx, costsWork, account.id, {
          notBefore: deps.clock.now() + retryAfterMs,
        });
      } else await recordFailure(tx, account.id, error, settings.everyMs);
    });
    deps.log.warn("vps.costs: reading a provider account's costs failed", {
      accountId: account.id,
      error: String((error as Error)?.message ?? error),
    });
    return;
  }

  const platform = isPlatformAccount(account, deps.rootTenantId);
  const totals: PassTotals = {
    rows: records.size,
    inserted: 0,
    corrected: 0,
    unchanged: 0,
    stale: 0,
    costMicros: 0,
    creditsMicros: 0,
    unattributedRows: 0,
    currencyMismatchRows: 0,
  };
  const all = [...records.values()];
  for (let start = 0; start < all.length; start += batchSize) {
    const slice = all.slice(start, start + batchSize);
    const wrote = await context.sql.transaction(async (tx) => {
      const batch = await attribute(tx, account, platform, slice, settings.currency);
      for (const cost of batch) {
        if (cost.attribution === 'unattributed') totals.unattributedRows++;
        if (cost.conditions.includes(currencyMismatch)) totals.currencyMismatchRows++;
        else {
          totals.costMicros += cost.record.costMicros;
          totals.creditsMicros += cost.record.creditsMicros;
        }
      }
      return writeBatch(deps, tx, account, batch, totals);
    });
    // Out of time with rows left: stop here and let a run enqueued now go on (it finds the rows written so far
    // unchanged). Only a batch that wrote something stops the run, so every run makes progress.
    if (wrote && left() <= 0 && start + batchSize < all.length) {
      await context.sql.transaction((tx) =>
        context.work.enqueue(tx, costsWork, account.id, { notBefore: deps.clock.now() }),
      );
      deps.log.info('vps.costs: pass out of time, continuing in another run', {
        accountId: account.id,
        written: start + batchSize,
        rows: all.length,
      });
      return;
    }
  }
  await context.sql.transaction(async (tx) => {
    const extra = (await after?.(tx, account, window)) ?? {};
    await tx.query(
      `UPDATE provider_cost_scans
          SET next_at = $3::timestamptz + make_interval(secs => $2::float8),
              scanned_to = to_timestamp($4::float8 / 1000), last_error = NULL
        WHERE account_id = $1`,
      [account.id, settings.everyMs / 1000, startedAt, window.to],
    );
    await publish(deps, tx, account, 'billing.cost-ingested', {
      from: window.from,
      to: window.to,
      currency: settings.currency.toUpperCase(),
      ...totals,
      ...extra,
    });
  });
}

// --- Pass-through (D11) ----------------------------------------------------------------------------------------

/** The usage source id of a passed-through row: unique per account and row. */
const costSourceId = (accountId: string, sourceRowId: string) => `${accountId}:${sourceRowId}`;

/** The idempotency key of a passed-through row (D11): `costx:<accountId>:<sourceRowId>`. */
export const passThroughKey = (accountId: string, sourceRowId: string) =>
  `costx:${accountId}:${sourceRowId}`;

/** The first rule whose pattern is a case-insensitive substring of the row's SKU id or description. */
export function passThroughRule(
  rules: readonly PassThroughRule[],
  record: Pick<ProviderCostRecord, 'sku' | 'skuDescription'>,
): PassThroughRule | undefined {
  const sku = record.sku.toLowerCase();
  const description = (record.skuDescription ?? '').toLowerCase();
  return rules.find((rule) => {
    const pattern = rule.skuPattern.toLowerCase();
    return sku.includes(pattern) || description.includes(pattern);
  });
}

interface PendingCost {
  source_row_id: string;
  record: ProviderCostRecord | string;
  tenant_id: string;
  pool_id: string | null;
}

/**
 * Passes an account's attributed cost rows through to their tenants (D11), in the pass's last transaction: each
 * row of the lookback window that is not yet passed through, belongs to a platform account with rules, is
 * attributed to a tenant other than the platform (by instance or tenant label), is in the deployment currency, is
 * regular usage, is no SKU compute meters itself (the provider's `computeSku`/`meteredSku`), matches a rule and
 * has a positive net cost becomes one `cost` usage window (`cost_micros` = (cost + credits) × multiplier) that
 * the normal `iam.usage` flush records (ruling M3), and is marked passed through. A row is passed through at most
 * once: a later correction is reported as `billing.cost-corrected`, never re-emitted. A row whose usage month has
 * already closed (`closeGraceHours` after its end, D18) is a late charge: its window is the first hour of the
 * current UTC month (same key; `provider_costs.usage_start` unchanged), so it is invoiced next month instead of
 * being refused by a closed period.
 */
export async function passThroughCosts(
  deps: Pick<CostsDeps, 'providers' | 'rootTenantId'> & { clock?: CostsDeps['clock'] },
  tx: SqlTx,
  account: ProviderAccount,
  window: { from: number; to: number },
  closeGraceHours: number = defaultCloseGraceHours,
): Promise<{ passedThroughRows: number; passedThroughMicros: number }> {
  const none = { passedThroughRows: 0, passedThroughMicros: 0 };
  const rules = account.billing?.passThrough ?? [];
  if (rules.length === 0 || !isPlatformAccount(account, deps.rootTenantId)) return none;
  const billing = deps.providers.get(account.provider)?.billing;
  // Without a compute matcher nothing can be told apart from compute: pass nothing (never bill twice).
  const computeSku = billing?.computeSku;
  if (typeof computeSku !== 'function') return none;
  const { rows } = await tx.query<PendingCost>(
    `SELECT c.source_row_id, c.record, c.tenant_id,
            (SELECT i.pool_id FROM instances i WHERE i.id = c.instance_id) AS pool_id
       FROM provider_costs c
      WHERE c.account_id = $1 AND c.passed_through_at IS NULL AND c.tenant_id IS NOT NULL AND c.tenant_id <> $2
        AND c.attribution IN ('instance', 'tenant-label') AND NOT ($3 = ANY(c.conditions))
        AND c.usage_start >= to_timestamp($4::float8 / 1000)
        -- An instance root bills nothing for (billing 'none'), or whose pool is not metered (none, platform-fee,
        -- or another tenant's pool, which defaults to platform-fee), passes nothing through either.
        AND NOT EXISTS (
          SELECT 1 FROM instances i JOIN pools p ON p.id = i.pool_id
           WHERE i.id = c.instance_id
             AND (i.billing = 'none'
                  OR p.policy->'billing'->>'mode' IN ('none', 'platform-fee')
                  OR (p.policy->'billing'->>'mode' IS NULL AND p.class = 'provider' AND p.owner_tenant_id <> $2)))
      ORDER BY c.usage_start, c.source_row_id FOR UPDATE OF c`,
    [account.id, deps.rootTenantId, currencyMismatch, window.from],
  );
  let passed = 0;
  let micros = 0;
  const now = deps.clock?.now() ?? window.to;
  for (const row of rows) {
    const record = json(row.record);
    if (record.costType !== undefined && record.costType !== 'regular') continue;
    if (computeSku(record) || billing?.meteredSku?.(record) === true) continue;
    const rule = passThroughRule(rules, record);
    if (!rule) continue;
    const net = record.costMicros + record.creditsMicros;
    if (!(net > 0) || !(record.quantity >= 0)) continue;
    const costMicros = Math.round(net * rule.multiplier);
    const key = passThroughKey(account.id, record.sourceRowId);
    const tags: Record<string, string> = { provider: account.provider, source: 'cost' };
    if (record.region) tags.region = record.region;
    // The instance's pool, so revenue by pool (spend by the `pool` tag) includes pass-through.
    if (row.pool_id) tags.pool = row.pool_id;
    // A closed month takes no more usage: the charge lands in the current month's first hour (occurredAt is the
    // window start, as always).
    const late = monthClosed(record.usageStart, now, closeGraceHours);
    const windowStart = late ? monthStartOf(now) : record.usageStart;
    const windowEnd = late ? windowStart + HOUR : Math.max(record.usageEnd, record.usageStart + 1);
    await tx.query(
      `INSERT INTO usage_windows (idempotency_key, source_kind, source_id, tenant_id, identity_id, meter, quantity,
                                  window_start, window_end, tags, cost_micros)
       VALUES ($1, 'cost', $2, $3, NULL, $4, $5, to_timestamp($6::float8 / 1000), to_timestamp($7::float8 / 1000),
               $8::jsonb, $9)
       ON CONFLICT DO NOTHING`,
      [
        key,
        costSourceId(account.id, record.sourceRowId),
        row.tenant_id,
        rule.meter,
        record.quantity,
        windowStart,
        windowEnd,
        JSON.stringify(tags),
        costMicros,
      ],
    );
    await tx.query(
      `UPDATE provider_costs SET passed_through_at = compute_now(), pass_through_key = $3,
              pass_through_meter = $4
        WHERE account_id = $1 AND source_row_id = $2`,
      [account.id, record.sourceRowId, key, rule.meter],
    );
    passed++;
    micros += costMicros;
  }
  return { passedThroughRows: passed, passedThroughMicros: micros };
}

// --- Leak detection (D12) -----------------------------------------------------------------------------------

interface LeakRow {
  instance_id: string;
  tenant_id: string | null;
  service: string | null;
  sku: string | null;
  sku_description: string | null;
  start_ms: number;
  end_ms: number;
}

/** The UTC day (`YYYY-MM-DD`) of a time. */
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The leak check (D12), in the pass's last transaction: per instance and UTC day of the window, the hours the
 * provider billed compute for (hour slots covered by regular rows of its `computeSku`, attributed to the
 * instance) against the hours of those slots a `running` usage interval of the instance overlaps. When the
 * provider's exceed the metered by more than `toleranceHours`, `billing.leak` is published, at most once per
 * instance-day (`provider_cost_leaks`). Providers without `computeSku` are not checked.
 */
export async function detectLeaks(
  deps: Pick<CostsDeps, 'providers' | 'events' | 'clock' | 'rootTenantId'>,
  tx: SqlTx,
  account: ProviderAccount,
  window: { from: number; to: number },
  toleranceHours: number,
): Promise<{ leaks: number }> {
  // Platform accounts only: a tenant's own account is the tenant's cost, not the platform's.
  if (!isPlatformAccount(account, deps.rootTenantId)) return { leaks: 0 };
  const computeSku = deps.providers.get(account.provider)?.billing?.computeSku;
  if (typeof computeSku !== 'function') return { leaks: 0 };
  // Only the columns the check reads, of regular usage rows attributed to an instance root bills (an instance
  // with billing 'none' has no intervals by design).
  const { rows } = await tx.query<LeakRow>(
    `SELECT c.instance_id, c.tenant_id, c.record->>'service' AS service, c.record->>'sku' AS sku,
            c.record->>'skuDescription' AS sku_description,
            (extract(epoch FROM c.usage_start) * 1000)::float8 AS start_ms,
            (extract(epoch FROM c.usage_end) * 1000)::float8 AS end_ms
       FROM provider_costs c JOIN instances i ON i.id = c.instance_id
      WHERE c.account_id = $1 AND c.instance_id IS NOT NULL
        AND c.usage_start >= to_timestamp($2::float8 / 1000) AND c.usage_start < to_timestamp($3::float8 / 1000)
        AND COALESCE(c.record->>'costType', 'regular') = 'regular'
        AND (c.record->>'quantity')::float8 > 0
        AND i.billing IS DISTINCT FROM 'none'`,
    [account.id, window.from, window.to],
  );
  // instance → day → billed hour slots (slot start ms)
  const billed = new Map<string, { tenantId: string | null; days: Map<string, Set<number>> }>();
  for (const row of rows) {
    const sku = {
      service: row.service ?? '',
      sku: row.sku ?? '',
      ...(row.sku_description !== null ? { skuDescription: row.sku_description } : {}),
    };
    if (!computeSku(sku)) continue;
    const entry = billed.get(row.instance_id) ?? { tenantId: row.tenant_id, days: new Map() };
    billed.set(row.instance_id, entry);
    const usageStart = Number(row.start_ms);
    const usageEnd = Number(row.end_ms);
    const first = Math.floor(usageStart / HOUR) * HOUR;
    for (let slot = first; slot < usageEnd; slot += HOUR) {
      const day = dayOf(slot);
      const slots = entry.days.get(day) ?? new Set<number>();
      entry.days.set(day, slots);
      slots.add(slot);
    }
  }
  if (billed.size === 0) return { leaks: 0 };
  const { rows: intervals } = await tx.query<{
    instance_id: string;
    started_ms: number;
    ended_ms: number | null;
  }>(
    `SELECT instance_id, (extract(epoch FROM started_at) * 1000)::float8 AS started_ms,
            (extract(epoch FROM ended_at) * 1000)::float8 AS ended_ms
       FROM instance_usage_intervals
      WHERE instance_id = ANY($1::text[]) AND phase = 'running'
        AND started_at < to_timestamp($3::float8 / 1000)
        AND (ended_at IS NULL OR ended_at > to_timestamp($2::float8 / 1000) - interval '1 day')`,
    [[...billed.keys()], window.from, window.to + dayMs],
  );
  const now = deps.clock.now();
  let leaks = 0;
  for (const [instanceId, { tenantId, days }] of billed) {
    const running = intervals
      .filter((interval) => interval.instance_id === instanceId)
      .map((interval) => ({
        start: Number(interval.started_ms),
        end: interval.ended_ms === null ? now : Number(interval.ended_ms),
      }));
    for (const [day, slots] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
      const providerHours = slots.size;
      let meteredHours = 0;
      for (const slot of slots)
        if (running.some((span) => span.start < slot + HOUR && span.end > slot)) meteredHours++;
      if (providerHours - meteredHours <= toleranceHours) continue;
      const { rows: raised } = await tx.query(
        `INSERT INTO provider_cost_leaks (instance_id, day, account_id, provider_hours, metered_hours)
         VALUES ($1, $2::date, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING instance_id`,
        [instanceId, day, account.id, providerHours, meteredHours],
      );
      if (raised.length === 0) continue;
      leaks++;
      await deps.events.publish(tx, {
        type: 'billing.leak',
        tenantId: account.tenantId,
        subject: `provider-account/${account.id}`,
        data: {
          accountId: account.id,
          instanceId,
          tenantId,
          day,
          providerHours,
          meteredHours,
        },
      });
    }
  }
  return { leaks };
}

// --- Margins (D12) -------------------------------------------------------------------------------------------

/** What `billing.margins` groups by. */
export type MarginGroup = 'tenant' | 'pool' | 'account' | 'meter';

/** The key of attributed cost that has no value for the grouping (a tenant-label row has no pool, say). */
export const noGroupKey = '(none)';

/**
 * Provider cost (cost + credits, micros) over `[from, to)` of usage start, in the deployment currency only
 * (`CurrencyMismatch` rows excluded): attributed cost by group, and the unattributed total. Pools come from the
 * row's instance; meters are the reported meters rows were passed through on.
 */
export async function providerCostTotals(
  sql: { query: SqlTx['query'] },
  input: {
    from: number;
    to: number;
    groupBy: MarginGroup;
    currency: string;
    /** Only the platform's (this tenant's) accounts count: a tenant's own account is not platform cost. */
    rootTenantId: string | undefined;
  },
): Promise<{ groups: Map<string, number>; unattributedMicros: number }> {
  if (input.rootTenantId === undefined) return { groups: new Map(), unattributedMicros: 0 };
  const groupExpr = {
    tenant: 'c.tenant_id',
    account: 'c.account_id',
    pool: `COALESCE(i.pool_id, '${noGroupKey}')`,
    meter: `COALESCE(c.pass_through_meter, '${noGroupKey}')`,
  }[input.groupBy];
  const join = input.groupBy === 'pool' ? 'LEFT JOIN instances i ON i.id = c.instance_id' : '';
  const { rows } = await sql.query<{ key: string | null; micros: string | number }>(
    `SELECT CASE WHEN c.tenant_id IS NULL THEN NULL ELSE ${groupExpr} END AS key,
            SUM(c.cost_micros + c.credits_micros)::text AS micros
       FROM provider_costs c JOIN provider_accounts a ON a.id = c.account_id AND a.tenant_id = $5 ${join}
      WHERE c.usage_start >= to_timestamp($1::float8 / 1000) AND c.usage_start < to_timestamp($2::float8 / 1000)
        AND upper(c.currency) = $3 AND NOT ($4 = ANY(c.conditions))
      GROUP BY 1`,
    [input.from, input.to, input.currency.toUpperCase(), currencyMismatch, input.rootTenantId],
  );
  const groups = new Map<string, number>();
  let unattributedMicros = 0;
  for (const row of rows) {
    if (row.key === null) unattributedMicros += Number(row.micros);
    else groups.set(row.key, Number(row.micros));
  }
  return { groups, unattributedMicros };
}

/** The validated settings of `vps({ costs })`. */
export function costSettings(
  options: CostsOptions,
  /** The deployment currency, validated by `vps()` (`vps({ billing: { currency } })`). */
  currency: string = 'USD',
): {
  every: Duration;
  everyMs: number;
  lookbackMs: number;
  currency: string;
  leakToleranceHours: number;
  passBudgetMs: number;
} {
  const every = options.every ?? '6h';
  const everyMs = parseDuration(every);
  const lookbackDays = options.lookbackDays ?? 3;
  if (!Number.isFinite(lookbackDays) || lookbackDays <= 0 || lookbackDays > 31)
    throw new ComputeError(
      'INVALID_CONFIG',
      'vps({ costs: { lookbackDays } }) must be more than 0 and at most 31',
    );
  const leakToleranceHours = options.leakToleranceHours ?? 1;
  if (!Number.isFinite(leakToleranceHours) || leakToleranceHours < 0)
    throw new ComputeError(
      'INVALID_CONFIG',
      'vps({ costs: { leakToleranceHours } }) must be a number of hours of at least 0',
    );
  const passBudgetMs = options.passBudgetMs ?? costsPassBudgetMs;
  if (!Number.isFinite(passBudgetMs) || passBudgetMs < 0 || passBudgetMs > 55_000)
    throw new ComputeError(
      'INVALID_CONFIG',
      'vps({ costs: { passBudgetMs } }) must be from 0 to 55000 (a run stays under the 60 s claim)',
    );
  return {
    every,
    everyMs,
    lookbackMs: lookbackDays * dayMs,
    currency: currency.toUpperCase(),
    leakToleranceHours,
    passBudgetMs,
  };
}

/**
 * The `vps.costs` reconciler (shardBy none): key `all` every `options.every` (default 6h), and one key per
 * account. `deps` builds what it needs from the run's context.
 */
export function costsReconciler(
  options: CostsOptions,
  deps: (context: ModuleContext) => CostsDeps,
  /** The deployment currency: a cost row in another one is stored as received, flagged `CurrencyMismatch`, and excluded from pass-through and margins. */
  currency?: string,
  /** D18's grace (`vps({ billing: { closeGraceHours } })`, validated by `vps()`): when a month counts as closed. */
  closeGraceHours: number = defaultCloseGraceHours,
): Reconciler {
  const settings = costSettings(options, currency);
  return {
    name: costsWork,
    shardBy: 'none',
    periodic: [{ key: 'all', every: settings.every }],
    async run(context, key) {
      const resolved = deps(context);
      if (key === 'all') await seedAccounts(resolved, context, settings.everyMs);
      else
        await scanAccount(resolved, context, key, settings, async (tx, account, window) => ({
          ...(await passThroughCosts(resolved, tx, account, window, closeGraceHours)),
          ...(await detectLeaks(resolved, tx, account, window, settings.leakToleranceHours)),
        }));
      return 'DONE';
    },
  };
}
