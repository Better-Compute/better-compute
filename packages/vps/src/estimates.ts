import {
  canonicalGpuModel,
  defaultMeterGpuModels,
  type Clock,
  type IamPort,
  type Logger,
  type PoolPolicy,
  type QuoteLine,
  type SqlTx,
} from '@better-compute/core';
import { billingModeOf, meterLinesFor, type BillableShape } from './billing.js';
import type { FlavorRecord } from './flavors.js';

// Tenant price estimates (platform compute billing, D15): what one hour of a flavor costs the caller's tenant,
// priced with `IamPort.quote` (so a negotiated price shows) on the meter lines the flavor would be metered on. Only
// provider pools have them: their instances are metered on `meterLinesFor`'s lines. Estimates are advice: a
// failing IAM call leaves them out, it never fails the request they decorate.

/** One hour of a flavor, priced for a tenant. */
export interface FlavorEstimate {
  /** The sum of the lines; `null` when any line has no price for the tenant. */
  perHourMicros: number | null;
  currency: string;
  /** One line per meter, with the tenant's price or `amountMicros: null`. */
  lines: QuoteLine[];
}

/** How long an estimate is kept, per (tenant, pool). */
export const estimateTtlMs = 5 * 60_000;
/** The most lines one `quote` call carries. */
const quoteChunk = 100;
const cacheLimit = 2_000;

interface Entry {
  at: number;
  /** Keyed `<flavor id>:<version>`: a changed flavor is a new key. */
  flavors: Map<string, FlavorEstimate>;
}

/** Estimates kept five minutes per (tenant, pool). */
export class EstimateCache {
  readonly #entries = new Map<string, Entry>();

  get(key: string, now: number): Entry | undefined {
    const entry = this.#entries.get(key);
    if (entry && now - entry.at < estimateTtlMs && now >= entry.at) return entry;
    this.#entries.delete(key);
    return undefined;
  }

  put(key: string, now: number): Entry {
    if (this.#entries.size >= cacheLimit)
      for (const [existing, entry] of this.#entries)
        if (now - entry.at >= estimateTtlMs || now < entry.at) this.#entries.delete(existing);
    if (this.#entries.size >= cacheLimit) this.#entries.clear();
    const entry: Entry = { at: now, flavors: new Map() };
    this.#entries.set(key, entry);
    return entry;
  }
}

export interface EstimateDeps {
  /** Absent in a host that builds contexts without an IAM port: then there are no estimates. */
  iam: (Pick<IamPort, 'quote'> & { rootTenantId?: string | undefined }) | undefined;
  clock: Clock;
  log: Logger;
  cache: EstimateCache;
  /** The deployment currency (`vps({ billing: { currency } })`, default USD). */
  currency: string;
  /** The GPU models the meter catalog names (default `defaultMeterGpuModels`). */
  gpuModels?: readonly string[] | undefined;
}

interface PoolBilling {
  class: string;
  ownerTenantId: string;
  policy: PoolPolicy;
  gpuModel: string | null;
  accountTenant: string | null;
}

async function readPool(tx: SqlTx, poolId: string): Promise<PoolBilling | undefined> {
  const { rows } = await tx.query<{
    class: string;
    owner_tenant_id: string;
    policy: PoolPolicy | string;
    gpu_model: string | null;
    account_tenant: string | null;
  }>(
    // The account counts only when it is the pool owner's (ruling R1), as billing resolves the pool's mode.
    `SELECT p.class, p.owner_tenant_id, p.policy, p.gpu_model,
            CASE WHEN a.tenant_id = p.owner_tenant_id THEN a.tenant_id END AS account_tenant
       FROM pools p LEFT JOIN provider_accounts a ON a.id = p.provider_account_id
      WHERE p.id = $1`,
    [poolId],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    class: row.class,
    ownerTenantId: row.owner_tenant_id,
    policy: (typeof row.policy === 'string' ? JSON.parse(row.policy) : row.policy) ?? {},
    gpuModel: row.gpu_model,
    accountTenant: row.account_tenant,
  };
}

/** The shape a flavor's instances are metered as (what `instance-usage` captures when one opens its interval). */
function shapeOfFlavor(
  flavor: FlavorRecord,
  pool: PoolBilling,
  gpuModels: readonly string[],
): BillableShape {
  const model =
    flavor.gpus > 0 && pool.gpuModel ? canonicalGpuModel(pool.gpuModel, gpuModels) : 'other';
  return {
    vcpu: flavor.vcpu,
    memoryGiB: flavor.memoryGiB,
    ...(flavor.gpus > 0 ? { gpus: { model, count: flavor.gpus } } : {}),
    // No flavor or offer says Spot yet (ruling F6-2); an offer on a reservation is metered as reserved.
    spot: false,
    reserved: flavor.offerId?.includes('@') === true,
    granted: false,
    ...(flavor.billing?.meter !== undefined ? { flavorMeter: flavor.billing.meter } : {}),
  };
}

/**
 * The estimates of `flavors` of `poolId` for `tenantId`, by flavor id. Nothing for a port without `quote`, a pool that
 * is not a provider pool, or when IAM cannot answer. Runs no provider call, and its one IAM call (per 100 lines)
 * happens outside any transaction: pass a read-only executor, not an open transaction.
 */
export async function flavorEstimates(
  deps: EstimateDeps,
  sql: SqlTx,
  tenantId: string,
  poolId: string,
  flavors: readonly FlavorRecord[],
): Promise<Map<string, FlavorEstimate>> {
  const out = new Map<string, FlavorEstimate>();
  const quote = deps.iam?.quote;
  if (typeof quote !== 'function' || flavors.length === 0) return out;
  const pool = await readPool(sql, poolId);
  if (!pool || pool.class !== 'provider') return out;

  const now = deps.clock.now();
  const cacheKey = `${tenantId}\u0000${poolId}`;
  const entry = deps.cache.get(cacheKey, now) ?? deps.cache.put(cacheKey, now);
  const keyOf = (flavor: FlavorRecord) => `${flavor.id}:${flavor.version}`;
  const missing: FlavorRecord[] = [];
  for (const flavor of flavors) {
    const cached = entry.flavors.get(keyOf(flavor));
    if (cached) out.set(flavor.id, cached);
    else missing.push(flavor);
  }
  if (missing.length === 0) return out;

  const gpuModels = deps.gpuModels ?? defaultMeterGpuModels;
  // Without a known root tenant every provider pool reads as a tenant's own: fail closed, as metering does.
  const mode = billingModeOf(
    { ownerTenantId: pool.ownerTenantId, class: pool.class, policy: pool.policy },
    pool.accountTenant !== null ? { tenantId: pool.accountTenant } : undefined,
    deps.iam?.rootTenantId ?? '',
  );
  const wanted = missing.map((flavor) => ({
    flavor,
    lines: meterLinesFor(shapeOfFlavor(flavor, pool, gpuModels), mode, 'running', { gpuModels }),
  }));
  const asked = wanted.flatMap((item) =>
    item.lines.map((line) => ({ meter: line.meter, quantity: line.perHour })),
  );
  const answers: QuoteLine[] = [];
  try {
    for (let from = 0; from < asked.length; from += quoteChunk) {
      const chunk = asked.slice(from, from + quoteChunk);
      const lines = await quote.call(deps.iam, { tenantId, lines: chunk });
      if (lines.length !== chunk.length)
        throw new Error('quote answered a different number of lines');
      answers.push(...lines);
    }
  } catch (error) {
    deps.log.warn('vps.estimate_unavailable', {
      poolId,
      error: error instanceof Error ? error.message : String(error),
    });
    return out;
  }
  let next = 0;
  for (const item of wanted) {
    const lines = answers.slice(next, next + item.lines.length);
    next += item.lines.length;
    const priced = lines.every((line) => line.amountMicros !== null);
    const estimate: FlavorEstimate = {
      perHourMicros: priced ? lines.reduce((sum, line) => sum + (line.amountMicros ?? 0), 0) : null,
      currency: deps.currency,
      lines,
    };
    entry.flavors.set(keyOf(item.flavor), estimate);
    out.set(item.flavor.id, estimate);
  }
  return out;
}
