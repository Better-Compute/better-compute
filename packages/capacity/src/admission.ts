import { ComputeError, type SqlTx } from '@better-compute/core';
import { readQuotas, tenantQuotaScope, type QuotaRow } from './quota.js';

// Admission for every caller (U-02), capacity's half: flavor allowlists on offers and on quota rows,
// and the listing of the offers a tenant holds or inherits. The counters themselves are in quota.ts
// (tenant-level `*` rows, counted `instances`/`sandboxes`).

/** A flavor name, as vps names flavors. */
export const flavorNamePattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;
/** At most this many flavors in one allowlist. */
export const maxAllowedFlavors = 64;

/**
 * A flavor allowlist from an input: 1 to 64 flavor names, deduplicated in order; `null` (where `nullable`) clears
 * the list, which allows every flavor again. Throws `INVALID_INPUT`.
 */
export function parseFlavorAllowlist(
  value: unknown,
  name: string,
  options: { nullable?: boolean } = {},
): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && options.nullable) return null;
  if (!Array.isArray(value) || value.length < 1 || value.length > maxAllowedFlavors)
    throw new ComputeError(
      'INVALID_INPUT',
      `${name} must list 1 to ${maxAllowedFlavors} flavor names${options.nullable ? ', or be null to allow every flavor' : ''}`,
    );
  const flavors: string[] = [];
  for (const flavor of value) {
    if (typeof flavor !== 'string' || !flavorNamePattern.test(flavor))
      throw new ComputeError(
        'INVALID_INPUT',
        `${name}: ${JSON.stringify(flavor)} is not a flavor name`,
      );
    if (!flavors.includes(flavor)) flavors.push(flavor);
  }
  return flavors;
}

/** What an admission asks of the flavor allowlists. */
export interface FlavorEntitlementRequest {
  tenantId: string;
  poolId: string;
  /** The flavor being admitted (a create's, a resize's target, or the flavor an attached machine's type maps to). */
  flavor: string | undefined;
  /** What the admission charges (`instanceDemand`): quota rows of other resources do not restrict it. */
  demand: Readonly<Record<string, number>>;
}

/**
 * Refuses a flavor the tenant is not entitled to, with `QUOTA_EXCEEDED` (`details.reason`):
 * - `flavor-not-offered`: the tenant's offer of the pool lists flavors (`pools.offer({ flavors })`), and not this one;
 * - `flavor-not-allowed`: a quota row the admission would consume, on the pool or tenant-wide (`*`), lists flavors
 *   (`quotas.set({ flavors })`), and not this one. A `gpu` demand consumes the tenant's `gpu.<model>` row too.
 *
 * An admission without a flavor (an attached machine whose type no flavor of the pool offers) is refused by any
 * allowlist that applies to it. Reservations and volumes have no flavor and never call this. Runs in the admission
 * transaction; reads only.
 */
export async function assertFlavorEntitled(
  tx: SqlTx,
  request: FlavorEntitlementRequest,
): Promise<void> {
  const shown = request.flavor ?? '(none)';
  const { rows: offers } = await tx.query<{ flavors: string[] | null }>(
    `SELECT flavors FROM pool_offers WHERE pool_id = $1 AND tenant_id = $2`,
    [request.poolId, request.tenantId],
  );
  const offered = offers[0]?.flavors;
  if (offered && (request.flavor === undefined || !offered.includes(request.flavor)))
    throw new ComputeError(
      'QUOTA_EXCEEDED',
      `Flavor ${shown} is not offered to this tenant in pool ${request.poolId}`,
      undefined,
      {
        reason: 'flavor-not-offered',
        flavor: request.flavor ?? null,
        poolId: request.poolId,
        flavors: offered,
      },
    );
  const consumed = new Set(
    Object.entries(request.demand)
      .filter(([, amount]) => amount > 0)
      .map(([resource]) => resource),
  );
  if (consumed.size === 0) return;
  const { rows } = await tx.query<{ pool_id: string; resource: string; flavors: string[] }>(
    `SELECT q.pool_id, q.resource, q.flavors FROM quota_usage q
      WHERE q.tenant_id = $1 AND q.pool_id IN ($2, $3) AND q.flavors IS NOT NULL
      ORDER BY q.pool_id, q.resource`,
    [request.tenantId, request.poolId, tenantQuotaScope],
  );
  if (rows.length === 0) return;
  let model: string | undefined | null = null;
  for (const row of rows) {
    let applies = consumed.has(row.resource);
    if (
      !applies &&
      row.pool_id === tenantQuotaScope &&
      row.resource.startsWith('gpu.') &&
      consumed.has('gpu')
    ) {
      if (model === null) {
        const { rows: pools } = await tx.query<{ gpu_model: string | null }>(
          `SELECT gpu_model FROM pools WHERE id = $1`,
          [request.poolId],
        );
        model = pools[0]?.gpu_model ?? undefined;
      }
      applies = model !== undefined && row.resource === `gpu.${model}`;
    }
    if (!applies) continue;
    if (request.flavor !== undefined && row.flavors.includes(request.flavor)) continue;
    const tenantWide = row.pool_id === tenantQuotaScope;
    throw new ComputeError(
      'QUOTA_EXCEEDED',
      `Flavor ${shown} may not use the ${row.resource} quota ${tenantWide ? 'across the tenant' : `in pool ${request.poolId}`}`,
      undefined,
      {
        reason: 'flavor-not-allowed',
        flavor: request.flavor ?? null,
        resource: row.resource,
        poolId: row.pool_id,
        scope: tenantWide ? 'tenant' : 'pool',
        flavors: row.flavors,
      },
    );
  }
}

// --- Offers a tenant holds or inherits ----------------------------------------------------------------------------

/**
 * The tenant's ancestors, nearest first (its parent, then the parent's parent, up to the root), from the host's
 * IAM (`iamTenantAncestors` in `@better-compute/iam`). Called with no transaction open.
 */
export type TenantAncestors = (tenantId: string) => Promise<readonly string[]>;

/** One offer a tenant can see: its own, or an ancestor's made with `includeDescendants`. */
export interface TenantOffer {
  poolId: string;
  /** The tenant the offer was made to: the tenant itself, or the ancestor it inherits from. */
  offeredTo: string;
  /** True when the offer is an ancestor's (`includeDescendants`). */
  inherited: boolean;
  /** 0 for the tenant's own offer, 1 for its parent's, and so on. */
  depth: number;
  includeDescendants: boolean;
  priority: number;
  /** The offer's flavor allowlist; absent: every flavor. */
  flavors?: string[];
  allowedRegions?: string[];
  onBudgetExceeded?: 'notify' | 'stop-new' | 'drain' | 'suspend';
  suspended: boolean;
  /** The pool as the offer shows it. */
  pool: { ownerTenantId: string; siteId: string; class: string; gpuModel?: string };
  /** The offered tenant's quota rows on the pool (an inherited offer's quota is its ancestor's). */
  quotas: QuotaRow[];
}

/**
 * The offers that reach `tenantId`: its own, then those of its ancestors made with `includeDescendants`. One per
 * pool (the nearest wins: an own offer shadows an inherited one), archived pools left out, ordered by priority
 * (highest first), then nearest first, then pool id. Pools the tenant owns are not offers and are not listed.
 */
export async function listTenantOffers(
  sql: SqlTx,
  tenantId: string,
  ancestors: readonly string[],
): Promise<TenantOffer[]> {
  const chain = [tenantId, ...ancestors.filter((id) => id !== tenantId)];
  const { rows } = await sql.query<{
    pool_id: string;
    tenant_id: string;
    include_descendants: boolean;
    priority: number | string | null;
    flavors: string[] | null;
    allowed_regions: string[] | null;
    on_budget_exceeded: TenantOffer['onBudgetExceeded'] | null;
    suspended: boolean;
    owner_tenant_id: string;
    site_id: string;
    class: string;
    gpu_model: string | null;
  }>(
    `SELECT o.pool_id, o.tenant_id, o.include_descendants, o.priority, o.flavors, o.allowed_regions,
            o.on_budget_exceeded, o.suspended_at IS NOT NULL AS suspended,
            p.owner_tenant_id, p.site_id, p.class, p.gpu_model
       FROM pool_offers o JOIN pools p ON p.id = o.pool_id
      WHERE o.tenant_id = ANY($1::text[]) AND p.archived_at IS NULL AND p.owner_tenant_id <> $2
        AND (o.tenant_id = $2 OR o.include_descendants)
      ORDER BY o.pool_id`,
    [chain, tenantId],
  );
  const nearest = new Map<string, (typeof rows)[number] & { depth: number }>();
  for (const row of rows) {
    const depth = chain.indexOf(row.tenant_id);
    const held = nearest.get(row.pool_id);
    if (!held || depth < held.depth) nearest.set(row.pool_id, { ...row, depth });
  }
  const offers: TenantOffer[] = [];
  const quotaCache = new Map<string, QuotaRow[]>();
  for (const row of nearest.values()) {
    let quotas = quotaCache.get(row.tenant_id);
    if (!quotas) {
      quotas = await readQuotas(sql, row.tenant_id);
      quotaCache.set(row.tenant_id, quotas);
    }
    const offer: TenantOffer = {
      poolId: row.pool_id,
      offeredTo: row.tenant_id,
      inherited: row.depth > 0,
      depth: row.depth,
      includeDescendants: row.include_descendants,
      priority: Number(row.priority ?? 0),
      suspended: row.suspended,
      pool: {
        ownerTenantId: row.owner_tenant_id,
        siteId: row.site_id,
        class: row.class,
        ...(row.gpu_model !== null ? { gpuModel: row.gpu_model } : {}),
      },
      quotas: quotas.filter((quota) => quota.poolId === row.pool_id),
    };
    if (row.flavors !== null) offer.flavors = [...row.flavors];
    if (row.allowed_regions !== null) offer.allowedRegions = [...row.allowed_regions];
    if (row.on_budget_exceeded !== null) offer.onBudgetExceeded = row.on_budget_exceeded;
    offers.push(offer);
  }
  return offers.sort(
    (a, b) =>
      b.priority - a.priority ||
      a.depth - b.depth ||
      (a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0),
  );
}
