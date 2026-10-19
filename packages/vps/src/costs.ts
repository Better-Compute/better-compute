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
/** Rows written per transaction. */
const batchSize = 500;
const dayMs = 86_400_000;

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
   * The better-iam deployment currency (default `USD`). A cost row in another currency is stored as received,
   * flagged `CurrencyMismatch`, and excluded from pass-through and margins.
   */
  currency?: string;
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
  ingested_at timestamptz NOT NULL DEFAULT compute_now(), updated_at timestamptz NOT NULL DEFAULT compute_now(),
  PRIMARY KEY (account_id, source_row_id)
);
CREATE INDEX provider_costs_tenant_day ON provider_costs (tenant_id, usage_start);
CREATE TABLE provider_cost_scans (account_id text PRIMARY KEY REFERENCES provider_accounts ON DELETE CASCADE,
  next_at timestamptz NOT NULL, scanned_to timestamptz, last_error text);
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
  return records.map((record) => {
    const conditions =
      record.currency.toUpperCase() === currency.toUpperCase() ? [] : [currencyMismatch];
    const instanceId = record.labels[costLabels.instance];
    const instanceTenant = instanceId !== undefined ? instances.get(instanceId) : undefined;
    if (instanceId !== undefined && instanceTenant !== undefined)
      return { record, instanceId, tenantId: instanceTenant, attribution: 'instance', conditions };
    const tenantLabel = record.labels[costLabels.tenant];
    if (platform && tenantLabel !== undefined && tenantPattern.test(tenantLabel))
      return {
        record,
        instanceId: null,
        tenantId: tenantLabel,
        attribution: 'tenant-label',
        conditions,
      };
    if (!platform)
      return {
        record,
        instanceId: null,
        tenantId: account.tenantId,
        attribution: 'account',
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
): Promise<void> {
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
  if (inserts.length > 0)
    await tx.query(
      `INSERT INTO provider_costs (account_id, source_row_id, record, usage_start, usage_end, cost_micros,
                                   credits_micros, currency, instance_id, tenant_id, attribution, conditions)
       SELECT $1, r->>'id', r->'record', to_timestamp((r->>'usageStart')::float8 / 1000),
              to_timestamp((r->>'usageEnd')::float8 / 1000), (r->>'cost')::bigint, (r->>'credits')::bigint,
              r->>'currency', r->>'instanceId', r->>'tenantId', r->>'attribution',
              ARRAY(SELECT jsonb_array_elements_text(r->'conditions'))
         FROM ${columns}`,
      [account.id, JSON.stringify(inserts.map(rowJson))],
    );
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
  totals.inserted += inserts.length;
  totals.corrected += updates.length;
  for (const cost of inserts)
    if (cost.attribution === 'unattributed')
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
  settings: { everyMs: number; lookbackMs: number; currency: string },
  after?: AfterCostPass,
): Promise<void> {
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
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(costsBudgetMs)]);
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
    const error =
      signal.aborted && !isComputeError(failure)
        ? new ComputeError('UNAVAILABLE', `Reading the costs of ${account.name} took over 45 s`)
        : failure;
    // Rate limited (or a provider job still running): this account again after the provider's back-off.
    const retryAfterMs = isComputeError(error) ? error.retryAfterMs : undefined;
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
    await context.sql.transaction(async (tx) => {
      const batch = await attribute(tx, account, platform, slice, settings.currency);
      for (const cost of batch) {
        if (cost.attribution === 'unattributed') totals.unattributedRows++;
        if (cost.conditions.includes(currencyMismatch)) totals.currencyMismatchRows++;
        else {
          totals.costMicros += cost.record.costMicros;
          totals.creditsMicros += cost.record.creditsMicros;
        }
      }
      await writeBatch(deps, tx, account, batch, totals);
    });
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
}

/**
 * Passes an account's attributed cost rows through to their tenants (D11), in the pass's last transaction: each
 * row of the lookback window that is not yet passed through, belongs to a platform account with rules, is
 * attributed to a tenant other than the platform (by instance or tenant label), is in the deployment currency, is
 * regular usage, is no SKU compute meters itself (the provider's `computeSku`/`meteredSku`), matches a rule and
 * has a positive net cost becomes one `cost` usage window (`cost_micros` = (cost + credits) × multiplier) that
 * the normal `iam.usage` flush records (ruling M3), and is marked passed through. A row is passed through at most
 * once: a later correction is reported as `billing.cost-corrected`, never re-emitted.
 */
export async function passThroughCosts(
  deps: Pick<CostsDeps, 'providers' | 'rootTenantId'>,
  tx: SqlTx,
  account: ProviderAccount,
  window: { from: number; to: number },
): Promise<{ passedThroughRows: number; passedThroughMicros: number }> {
  const none = { passedThroughRows: 0, passedThroughMicros: 0 };
  const rules = account.billing?.passThrough ?? [];
  if (rules.length === 0 || !isPlatformAccount(account, deps.rootTenantId)) return none;
  const billing = deps.providers.get(account.provider)?.billing;
  // Without a compute matcher nothing can be told apart from compute: pass nothing (never bill twice).
  const computeSku = billing?.computeSku;
  if (typeof computeSku !== 'function') return none;
  const { rows } = await tx.query<PendingCost>(
    `SELECT source_row_id, record, tenant_id FROM provider_costs
      WHERE account_id = $1 AND passed_through_at IS NULL AND tenant_id IS NOT NULL AND tenant_id <> $2
        AND attribution IN ('instance', 'tenant-label') AND NOT ($3 = ANY(conditions))
        AND usage_start >= to_timestamp($4::float8 / 1000)
      ORDER BY usage_start, source_row_id FOR UPDATE`,
    [account.id, deps.rootTenantId, currencyMismatch, window.from],
  );
  let passed = 0;
  let micros = 0;
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
        record.usageStart,
        Math.max(record.usageEnd, record.usageStart + 1),
        JSON.stringify(tags),
        costMicros,
      ],
    );
    await tx.query(
      `UPDATE provider_costs SET passed_through_at = compute_now(), pass_through_key = $3
        WHERE account_id = $1 AND source_row_id = $2`,
      [account.id, record.sourceRowId, key],
    );
    passed++;
    micros += costMicros;
  }
  return { passedThroughRows: passed, passedThroughMicros: micros };
}

/** The validated settings of `vps({ costs })`. */
export function costSettings(options: CostsOptions): {
  every: Duration;
  everyMs: number;
  lookbackMs: number;
  currency: string;
} {
  const every = options.every ?? '6h';
  const everyMs = parseDuration(every);
  const lookbackDays = options.lookbackDays ?? 3;
  if (!Number.isFinite(lookbackDays) || lookbackDays <= 0 || lookbackDays > 31)
    throw new ComputeError(
      'INVALID_CONFIG',
      'vps({ costs: { lookbackDays } }) must be more than 0 and at most 31',
    );
  const currency = options.currency ?? 'USD';
  if (!/^[A-Za-z]{3}$/.test(currency))
    throw new ComputeError(
      'INVALID_CONFIG',
      'vps({ costs: { currency } }) must be an ISO 4217 code such as USD',
    );
  return { every, everyMs, lookbackMs: lookbackDays * dayMs, currency: currency.toUpperCase() };
}

/**
 * The `vps.costs` reconciler (shardBy none): key `all` every `options.every` (default 6h), and one key per
 * account. `deps` builds what it needs from the run's context.
 */
export function costsReconciler(
  options: CostsOptions,
  deps: (context: ModuleContext) => CostsDeps,
): Reconciler {
  const settings = costSettings(options);
  return {
    name: costsWork,
    shardBy: 'none',
    periodic: [{ key: 'all', every: settings.every }],
    async run(context, key) {
      const resolved = deps(context);
      if (key === 'all') await seedAccounts(resolved, context, settings.everyMs);
      else
        await scanAccount(resolved, context, key, settings, (tx, account, window) =>
          passThroughCosts(resolved, tx, account, window),
        );
      return 'DONE';
    },
  };
}
