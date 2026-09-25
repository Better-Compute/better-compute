import type { SqlTx } from '@better-compute/core';
import {
  gpuMeter,
  hourMs,
  meterAllocation,
  type MeterLine,
  type UsageTags,
} from '@better-compute/capacity';

// Instance metering (PLAN.md §12.7): hosted instances accrue `vps.vcpu.hours`,
// `vps.memory.gib.hours` and, for GPU flavors, `gpu.<model>.hours`, from placement until their
// allocation is released. Provider instances have no allocation and are billed by their provider.
// Warm sandbox instances accrue `vps.sandbox.warm` to the tenant until a sandbox claims them.

/**
 * Warm sandbox capacity (§3.7): warm vCPU-hours of an instance kept for a template's warm pool,
 * billed to the tenant (no identity), from placement until a sandbox claims it or it is drained.
 */
export const warmMeter = 'vps.sandbox.warm';

interface MeterableInstance {
  warm: boolean;
  claimed_ms: number | null;
  allocation_id: string;
  tenant_id: string;
  owner_identity_id: string;
  agent_id: string | null;
  delegation_id: string | null;
  project_id: string | null;
  pool_id: string;
  gpu_model: string | null;
  region: string;
  flavor: { vcpu: number; memoryGiB: number; gpus: number } | string;
  from_ms: number;
  to_ms: number | null;
}

/** One metering pass over hosted instance allocations (the `vps.usage` job). */
export async function meterInstances(
  tx: SqlTx,
  now: number,
  options: { lookbackMs?: number; limit?: number } = {},
): Promise<{ allocations: number; windows: number }> {
  const lookback = options.lookbackMs ?? 48 * hourMs;
  const { rows } = await tx.query<MeterableInstance>(
    `SELECT i.warm_template_id IS NOT NULL AS warm, (extract(epoch FROM i.claimed_at) * 1000)::float8 AS claimed_ms,
            a.id AS allocation_id, i.tenant_id, i.owner_identity_id, i.agent_id, i.delegation_id, i.project_id,
            i.pool_id, p.gpu_model, s.region, i.flavor,
            (extract(epoch FROM lower(a.during)) * 1000)::float8 AS from_ms,
            (extract(epoch FROM a.released_at) * 1000)::float8 AS to_ms
       FROM instances i
       JOIN allocations a ON a.owner_kind = 'instance' AND a.owner_id = i.id
       JOIN pools p ON p.id = i.pool_id
       JOIN sites s ON s.id = p.site_id
      WHERE NOT i.draft AND lower(a.during) < $1::timestamptz
        AND (a.released_at IS NULL OR a.released_at > $1::timestamptz - make_interval(secs => $2 / 1000.0))
      ORDER BY a.id LIMIT $3`,
    [new Date(now).toISOString(), lookback, options.limit ?? 5000],
  );
  let windows = 0;
  for (const row of rows) {
    const flavor = typeof row.flavor === 'string' ? JSON.parse(row.flavor) : row.flavor;
    const lines: MeterLine[] = [
      { meter: 'vps.vcpu.hours', perHour: flavor.vcpu },
      { meter: 'vps.memory.gib.hours', perHour: flavor.memoryGiB },
    ];
    if (flavor.gpus > 0)
      lines.push({ meter: gpuMeter(row.gpu_model ?? undefined), perHour: flavor.gpus });
    const tags: UsageTags = { region: row.region, pool: row.pool_id };
    if (row.gpu_model) tags.gpuModel = row.gpu_model;
    if (row.project_id) tags.project = row.project_id;
    if (row.delegation_id && row.agent_id) tags.agent = row.agent_id;
    const from = Number(row.from_ms);
    const to = row.to_ms === null ? Number.POSITIVE_INFINITY : Number(row.to_ms);
    // A warm sandbox instance (§3.7) is warm capacity until claimed, then its sandbox owner's.
    const claimed = row.claimed_ms === null ? undefined : Number(row.claimed_ms);
    const warmUntil = row.warm ? to : claimed;
    if (warmUntil !== undefined)
      windows += await meterAllocation(
        tx,
        {
          allocationId: row.allocation_id,
          tenantId: row.tenant_id,
          // The first line's idempotency key has no meter suffix and belongs to the claimed phase's
          // first line; the empty line keeps the warm line on its own suffixed key.
          lines: [
            { meter: 'vps.vcpu.hours', perHour: 0 },
            { meter: warmMeter, perHour: flavor.vcpu },
          ],
          tags,
          from,
          to: Math.min(warmUntil, to),
        },
        now,
      );
    if (!row.warm)
      windows += await meterAllocation(
        tx,
        {
          allocationId: row.allocation_id,
          tenantId: row.tenant_id,
          identityId: row.owner_identity_id,
          lines,
          tags,
          from: claimed ?? from,
          to,
        },
        now,
      );
  }
  return { allocations: rows.length, windows };
}
