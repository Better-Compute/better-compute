import { ComputeError, type Migration, type SqlTx } from '@better-compute/core';
import { chargeQuota, refundQuota } from '@better-compute/capacity';

// External quota bookings: capacity's quota (`quota_usage`, PLAN.md §10.3) held by something that is not placed on a
// node, such as a provider-managed inference endpoint on dedicated GPUs (a cloud resource). A booking belongs to one
// owner and records what it charged, so booking again charges only the difference and a release refunds exactly what
// is held, once. Charges are capacity's guarded `used + n <= max` updates: all-or-nothing, `QUOTA_EXCEEDED` with the
// resource, limit and use in its details.
//
// Lock order: the booking row (FOR UPDATE), then quota_usage (capacity's order from there on). Nothing else locks
// quota_bookings, so the order never inverts.

/**
 * `quota_bookings`: one row per owner (`cloud-resource`, …). `resources` is what the owner holds now; a released row
 * holds nothing and keeps what it last held, for audit.
 */
export const quotaBookingsMigration: Migration = {
  name: 'vps/0108_quota_bookings',
  sql: `
CREATE TABLE quota_bookings (
  owner_kind text NOT NULL CHECK (owner_kind ~ '^[a-z][a-z0-9-]{0,31}$'),
  owner_id text NOT NULL,
  tenant_id text NOT NULL,
  pool_id text NOT NULL,
  resources jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT compute_now(),
  updated_at timestamptz NOT NULL DEFAULT compute_now(),
  released_at timestamptz,
  PRIMARY KEY (owner_kind, owner_id)
);
CREATE INDEX quota_bookings_live ON quota_bookings (tenant_id, pool_id) WHERE released_at IS NULL;
`,
};

/** Who holds a booking: a kind of owner (`cloud-resource`) and its id. */
export interface QuotaBookingOwner {
  kind: string;
  id: string;
}

/** One booking as `quota_bookings` records it. */
export interface QuotaBooking {
  owner: QuotaBookingOwner;
  tenantId: string;
  poolId: string;
  /** What it holds now (what it last held, once released). */
  resources: Record<string, number>;
  released: boolean;
}

const ownerKindPattern = /^[a-z][a-z0-9-]{0,31}$/;
const resourcePattern = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

function checkOwner(owner: QuotaBookingOwner): void {
  if (!ownerKindPattern.test(owner.kind) || typeof owner.id !== 'string' || owner.id.length === 0)
    throw new ComputeError(
      'INVALID_INPUT',
      'A quota booking owner is a kind ([a-z0-9-]) and an id',
    );
}

/** The demand without zero entries; INVALID_INPUT for a resource name or an amount that is not a whole count. */
export function bookingDemand(
  demand: Readonly<Record<string, number>> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [resource, amount] of Object.entries(demand ?? {})) {
    if (!resourcePattern.test(resource) || !Number.isSafeInteger(amount) || amount < 0)
      throw new ComputeError(
        'INVALID_INPUT',
        `A quota booking is whole, non-negative counts of quota resources (${JSON.stringify(resource)}: ${String(amount)})`,
        undefined,
        { resource },
      );
    if (amount > 0) out[resource] = amount;
  }
  return out;
}

interface BookingRow {
  owner_kind: string;
  owner_id: string;
  tenant_id: string;
  pool_id: string;
  resources: Record<string, number> | string;
  released: boolean;
}

const toBooking = (row: BookingRow): QuotaBooking => ({
  owner: { kind: row.owner_kind, id: row.owner_id },
  tenantId: row.tenant_id,
  poolId: row.pool_id,
  resources:
    typeof row.resources === 'string'
      ? (JSON.parse(row.resources) as Record<string, number>)
      : row.resources,
  released: row.released,
});

/** An owner's booking, optionally row-locked; undefined when it never booked. */
export async function readQuotaBooking(
  tx: SqlTx,
  owner: QuotaBookingOwner,
  options: { lock?: boolean } = {},
): Promise<QuotaBooking | undefined> {
  const { rows } = await tx.query<BookingRow>(
    `SELECT owner_kind, owner_id, tenant_id, pool_id, resources, released_at IS NOT NULL AS released
       FROM quota_bookings WHERE owner_kind = $1 AND owner_id = $2${options.lock ? ' FOR UPDATE' : ''}`,
    [owner.kind, owner.id],
  );
  return rows[0] ? toBooking(rows[0]) : undefined;
}

/**
 * Makes `owner` hold exactly `demand` of `(tenantId, poolId)`'s quota: the growth over what it holds is charged
 * (all-or-nothing: `QUOTA_EXCEEDED` changes nothing), the shrink refunded. Idempotent: booking the same demand again
 * charges nothing. A released booking is booked afresh. A live booking stays on the tenant and pool it was made on.
 */
export async function setQuotaBooking(
  tx: SqlTx,
  owner: QuotaBookingOwner,
  at: { tenantId: string; poolId: string },
  demand: Readonly<Record<string, number>>,
): Promise<QuotaBooking> {
  checkOwner(owner);
  const wanted = bookingDemand(demand);
  const current = await readQuotaBooking(tx, owner, { lock: true });
  const live = current !== undefined && !current.released;
  if (live && (current.tenantId !== at.tenantId || current.poolId !== at.poolId))
    throw new ComputeError(
      'INVALID_STATE',
      `${owner.kind} ${owner.id} holds quota on pool ${current.poolId}; release it before booking elsewhere`,
    );
  const held = live ? current.resources : {};
  const grow: Record<string, number> = {};
  const shrink: Record<string, number> = {};
  for (const resource of new Set([...Object.keys(held), ...Object.keys(wanted)])) {
    const delta = (wanted[resource] ?? 0) - (held[resource] ?? 0);
    if (delta > 0) grow[resource] = delta;
    if (delta < 0) shrink[resource] = -delta;
  }
  await chargeQuota(tx, at.tenantId, at.poolId, grow);
  await refundQuota(tx, at.tenantId, at.poolId, shrink);
  await tx.query(
    `INSERT INTO quota_bookings (owner_kind, owner_id, tenant_id, pool_id, resources)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (owner_kind, owner_id) DO UPDATE
       SET tenant_id = $3, pool_id = $4, resources = $5::jsonb, released_at = NULL, updated_at = compute_now()`,
    [owner.kind, owner.id, at.tenantId, at.poolId, JSON.stringify(wanted)],
  );
  return { owner: { ...owner }, ...at, resources: wanted, released: false };
}

/** Returns what `owner` holds and marks its booking released. Idempotent: a second release refunds nothing. */
export async function releaseQuotaBooking(tx: SqlTx, owner: QuotaBookingOwner): Promise<void> {
  checkOwner(owner);
  const { rows } = await tx.query<BookingRow>(
    `UPDATE quota_bookings SET released_at = compute_now(), updated_at = compute_now()
      WHERE owner_kind = $1 AND owner_id = $2 AND released_at IS NULL
      RETURNING owner_kind, owner_id, tenant_id, pool_id, resources, false AS released`,
    [owner.kind, owner.id],
  );
  if (!rows[0]) return;
  const booking = toBooking(rows[0]);
  await refundQuota(tx, booking.tenantId, booking.poolId, booking.resources);
}
