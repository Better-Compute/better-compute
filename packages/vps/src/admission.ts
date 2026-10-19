import { assertFlavorEntitled } from '@better-compute/capacity';
import type {
  AdmissionPolicy,
  AdmissionPolicyRequest,
  AuthzAttributes,
  SqlTx,
} from '@better-compute/core';

// Admission for every caller (U-02), vps's half. Every instance and sandbox admission (instances.create, attach and
// resize, sandboxes.create) runs the same steps inside its transaction, whoever calls (the console, the raw API, an
// MCP agent, auto-attach): the flavor allowlists of the tenant's offer and quota rows (`assertFlavorEntitled`), then
// the host's `admissionPolicy`, then the quota charge, counted resources included (`instances`, `sandboxes`).

/** Where an instance runs, as IAM policies read it (`resource.poolId`, `resource.flavor`, …). */
export interface InstancePlacementAttributes {
  poolId: string;
  /** The flavor name; an attached machine's is the flavor whose offer is its type, when one is. */
  flavor?: string;
  /** The region of the pool's site. */
  region?: string;
  /** The provider of the pool's account (provider pools). */
  provider?: string;
  /** The instance's labels; each becomes `labels.<key>`. */
  labels?: Readonly<Record<string, string>>;
}

/** At most this many attributes on one authz projection row (better-iam's limit per resource). */
export const maxAuthzAttributes = 64;

/**
 * The IAM attributes of `placement`, added to `base` (the instance's shape attributes): poolId, flavor, region,
 * provider, then one `labels.<key>` per label, in key order, while the row has room (64 attributes). When some
 * labels do not fit, the last slot says so: `labelsTruncated: true`, so a policy can refuse what it cannot see.
 */
export function placementAttributes(
  placement: InstancePlacementAttributes,
  base: AuthzAttributes = {},
): AuthzAttributes {
  const attributes: AuthzAttributes = { ...base, poolId: placement.poolId };
  if (placement.flavor !== undefined) attributes.flavor = placement.flavor;
  if (placement.region !== undefined) attributes.region = placement.region;
  if (placement.provider !== undefined) attributes.provider = placement.provider;
  const labels = Object.entries(placement.labels ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const room = maxAuthzAttributes - Object.keys(attributes).length;
  const fits = labels.length <= room;
  for (const [key, value] of fits ? labels : labels.slice(0, Math.max(0, room - 1)))
    attributes[`labels.${key}`] = value;
  if (!fits) attributes.labelsTruncated = true;
  return attributes;
}

/** The region of a pool's site and the provider of its account (a provider pool's account must be its owner's). */
export async function poolPlacement(
  tx: SqlTx,
  poolId: string,
): Promise<{ region?: string; provider?: string }> {
  const { rows } = await tx.query<{ region: string | null; provider: string | null }>(
    `SELECT s.region, CASE WHEN a.tenant_id = p.owner_tenant_id THEN a.provider END AS provider
       FROM pools p JOIN sites s ON s.id = p.site_id
       LEFT JOIN provider_accounts a ON a.id = p.provider_account_id
      WHERE p.id = $1`,
    [poolId],
  );
  const row = rows[0];
  return {
    ...(row?.region ? { region: row.region } : {}),
    ...(row?.provider ? { provider: row.provider } : {}),
  };
}

/** The placement attributes of an instance that exists (or is a draft), read from its pool. */
export async function instancePlacement(
  tx: SqlTx,
  instance: { poolId: string; flavor?: string; labels?: Readonly<Record<string, string>> },
): Promise<InstancePlacementAttributes> {
  return {
    poolId: instance.poolId,
    ...(instance.flavor !== undefined ? { flavor: instance.flavor } : {}),
    ...(await poolPlacement(tx, instance.poolId)),
    ...(instance.labels && Object.keys(instance.labels).length > 0
      ? { labels: instance.labels }
      : {}),
  };
}

/**
 * The flavor of the pool whose provider offer is the machine's type (attach): an offer id of `<zone>/<type>` in the
 * machine's zone first, then `<type>` alone, then `<any zone>/<type>`, by name among the live flavors; or none.
 * Flavor allowlists and IAM's `resource.flavor` judge an attached machine by it.
 */
export async function flavorForMachineType(
  tx: SqlTx,
  poolId: string,
  machine: { machineType?: string; zone?: string } | undefined,
): Promise<string | undefined> {
  const type = machine?.machineType;
  if (type === undefined) return undefined;
  const zoned = machine?.zone !== undefined ? `${machine.zone}/${type}` : null;
  const { rows } = await tx.query<{ name: string }>(
    `SELECT name FROM flavors
      WHERE pool_id = $1 AND NOT archived
        AND (offer_id = $2 OR offer_id = $3 OR right(offer_id, length($2) + 1) = '/' || $2)
      ORDER BY (offer_id = $3) IS TRUE DESC, offer_id = $2 DESC, name LIMIT 1`,
    [poolId, type, zoned],
  );
  return rows[0]?.name;
}

/**
 * Runs the admission checks of one instance or sandbox in the admission transaction: the flavor allowlists, then
 * the host's policy. Quota is charged after this, by the caller.
 */
export async function admitInstance(
  tx: SqlTx,
  policy: AdmissionPolicy | undefined,
  request: AdmissionPolicyRequest,
): Promise<void> {
  await assertFlavorEntitled(tx, {
    tenantId: request.tenantId,
    poolId: request.poolId,
    flavor: request.flavor,
    demand: request.demand,
  });
  if (policy) await policy(tx, request);
}
