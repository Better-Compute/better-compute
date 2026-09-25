import { ComputeError, type SqlExecutor } from '@better-compute/core';

// Delivery history retention: settled webhook deliveries (delivered or cancelled) and dead letters are deleted once
// old enough, in bounded batches. Pending deliveries are never touched, whatever their age.

export interface DeliveryRetention {
  /** Delivered and cancelled deliveries are kept this many days (default 30). */
  deliveredDays?: number;
  /** Dead letters are kept longer, for redelivery after an endpoint is fixed (default 90). */
  deadDays?: number;
}

const days = (value: number | undefined, fallback: number, name: string): number => {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < 1)
    throw new ComputeError('INVALID_CONFIG', `retention.${name} must be at least 1 day`);
  return result;
};

/** The retention with its defaults filled in; throws INVALID_CONFIG for a period under one day. */
export function deliveryRetention(retention: DeliveryRetention = {}): Required<DeliveryRetention> {
  return {
    deliveredDays: days(retention.deliveredDays, 30, 'deliveredDays'),
    deadDays: days(retention.deadDays, 90, 'deadDays'),
  };
}

/**
 * Deletes up to `limit` expired deliveries (default 5000); returns how many. Call again while it returns `limit`.
 */
export async function pruneWebhookDeliveries(
  sql: Pick<SqlExecutor, 'query'>,
  retention: DeliveryRetention = {},
  limit = 5_000,
): Promise<number> {
  const { deliveredDays: delivered, deadDays: dead } = deliveryRetention(retention);
  const { rowCount } = await sql.query(
    `DELETE FROM webhook_deliveries WHERE id IN (
       SELECT id FROM webhook_deliveries
        WHERE (state IN ('delivered', 'cancelled') AND created_at < compute_now() - make_interval(days => $1))
           OR (state = 'dead' AND created_at < compute_now() - make_interval(days => $2))
        LIMIT $3)`,
    [delivered, dead, limit],
  );
  return rowCount ?? 0;
}
