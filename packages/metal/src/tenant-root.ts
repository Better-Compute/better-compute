import type { Json, SqlTx } from '@better-compute/core';

// Dedicated-root leases (PLAN.md §10.5 binding 'node', §13 "Tenant-root bare metal", v0.5). The
// contract with capacity is level-triggered through rows; neither module imports the other:
// - Capacity places a `binding: 'node'` reservation on a whole node of a `policy.tenantRoot` pool.
//   It inserts the allocation (owner_kind 'reservation'), with the tenant's metal profile in
//   `reservations.request.node`, and wakes the node's metal work.
// - Metal starts the lease on a ready node: trust becomes tenant-controlled, the platform identity
//   is revoked (the next join gets a `node-tenant` cert), and the tenant's profile deploys.
// - When the lease's deploy completes, metal marks the allocation bound (`bound_at`, binding
//   `{"node": true}`) and wakes capacity's reservation work, which moves the reservation to active.
// - When the allocation is released (or its time is up), metal runs the tenant-root teardown
//   (profiles.ts): BMC-driven, platform ramdisk, attested secure wipe, GPU check, firmware against
//   the pool's baseline, a new identity generation, and only then `ready` again.

/** Capacity's reservation reconciler (`reservationWork` there), woken when a leased node is deployed. */
export const capacityReservationWorkKind = 'capacity.reservations';

/** Marks the lease's allocation bound, as a bound hold would be, and wakes its reservation. */
export async function markLeaseBound(
  tx: SqlTx,
  work: { enqueue(tx: SqlTx, kind: string, key: string): Promise<void> },
  allocationId: string,
): Promise<boolean> {
  const { rows } = await tx.query<{ owner_id: string }>(
    `UPDATE allocations SET bound_at = COALESCE(bound_at, compute_now()), binding = '{"node": true}'::jsonb
      WHERE id = $1 AND released_at IS NULL RETURNING owner_id`,
    [allocationId],
  );
  if (!rows[0]) return false;
  await work.enqueue(tx, capacityReservationWorkKind, rows[0].owner_id);
  return true;
}

export interface NodeLease {
  allocationId: string;
  reservationId: string;
  tenantId: string;
  profileId: string;
  profileVersion: number;
}

/** The node's current node-binding allocation, if one is due and not released. */
export async function dueNodeLease(tx: SqlTx, nodeId: string): Promise<NodeLease | undefined> {
  const { rows } = await tx.query<{ id: string; owner_id: string; tenant_id: string; node: { profileId?: unknown; profileVersion?: unknown } | null }>(
    `SELECT a.id, a.owner_id, a.tenant_id, r.request->'node' AS node
       FROM allocations a JOIN reservations r ON r.id = a.owner_id
      WHERE a.node_id = $1 AND a.owner_kind = 'reservation' AND a.released_at IS NULL
        AND r.request->>'binding' = 'node'
        AND lower(a.during) <= compute_now() AND upper(a.during) > compute_now()
      ORDER BY lower(a.during), a.id LIMIT 1`,
    [nodeId],
  );
  const row = rows[0];
  if (!row) return undefined;
  const profileId = typeof row.node?.profileId === 'string' ? row.node.profileId : '';
  const profileVersion = Number(row.node?.profileVersion);
  return { allocationId: row.id, reservationId: row.owner_id, tenantId: row.tenant_id, profileId, profileVersion };
}

/** Whether a lease's allocation is over: released, its time up, or gone. */
export async function leaseEnded(tx: SqlTx, allocationId: string): Promise<boolean> {
  const { rows } = await tx.query<{ ended: boolean }>(
    `SELECT (released_at IS NOT NULL OR upper(during) <= compute_now()) AS ended FROM allocations WHERE id = $1`,
    [allocationId],
  );
  return rows[0]?.ended ?? true;
}

/** Revokes the node's live certificates and starts a new identity generation. */
export async function newIdentityGeneration(tx: SqlTx, nodeId: string, reason: string): Promise<number> {
  const revoked = await tx.query(
    `UPDATE node_certs SET revoked_at = compute_now(), revocation_reason = $2 WHERE node_id = $1 AND revoked_at IS NULL`,
    [nodeId, reason],
  );
  await tx.query('UPDATE nodes SET identity_gen = identity_gen + 1 WHERE id = $1', [nodeId]);
  return revoked.rowCount;
}

/** A platform firmware image for one component: what `reflash` writes back. */
export interface FirmwareImage {
  /** https only. */
  url: string;
  /** Hex SHA-256 of the image; the site agent refuses anything else. */
  sha256: string;
}

export interface TenantRootPolicy {
  allowed: boolean;
  /** Component id → the version it must report. */
  firmwareBaseline?: Record<string, string>;
  /** On drift: `quarantine` (default: fail with maintenance on) or `reflash` the baseline images first. */
  firmwareRemediation: 'quarantine' | 'reflash';
  /** Component id → its baseline image, for `reflash`. */
  firmwareImages: Record<string, FirmwareImage>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Pool policy for tenant-root leases: opted in, the firmware every component must match, and what drift does. */
export function tenantRootPolicy(policy: Record<string, unknown> | null): TenantRootPolicy {
  const result: TenantRootPolicy = {
    allowed: policy?.tenantRoot === true,
    firmwareRemediation: policy?.firmwareRemediation === 'reflash' ? 'reflash' : 'quarantine',
    firmwareImages: {},
  };
  const baseline = policy?.firmwareBaseline;
  if (isRecord(baseline))
    result.firmwareBaseline = Object.fromEntries(
      Object.entries(baseline as Record<string, Json>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  const images = policy?.firmwareImages;
  if (isRecord(images))
    for (const [component, image] of Object.entries(images))
      if (isRecord(image) && typeof image.url === 'string' && image.url.startsWith('https://') && typeof image.sha256 === 'string' && /^[0-9a-f]{64}$/.test(image.sha256))
        result.firmwareImages[component] = { url: image.url, sha256: image.sha256 };
  return result;
}
