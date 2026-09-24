import type { Json, SqlTx } from '@better-compute/core';

// Usage metering (PLAN.md §12.7, D14): hourly windows per allocation in `usage_windows`, which the
// IAM usage sink sends to `iam.billing` and marks recorded. The basis is reserved time, from the
// moment a reservation is active (bound) until it is released or ends. Windows are written only when
// final (the hour has closed, or the allocation ended), so a window never changes once written, and
// `ON CONFLICT DO NOTHING` on the idempotency key makes every pass safe to repeat.

export const hourMs = 3_600_000;

/** One meter an allocation accrues: `perHour` units for every full hour. */
export interface MeterLine {
  /** `gpu.h100.hours`, `vps.vcpu.hours`, `vps.memory.gib.hours`, … */
  meter: string;
  perHour: number;
}

/** Bounded-cardinality tags only (§12.7): region, pool, gpuModel, project, agent. */
export type UsageTags = Partial<
  Record<'region' | 'pool' | 'gpuModel' | 'project' | 'agent', string>
>;

/** The GPU meter of a model: `gpu.<gpuModel>.hours`, lower-cased. */
export function gpuMeter(gpuModel: string | undefined): string {
  return `gpu.${(gpuModel ?? 'other').toLowerCase()}.hours`;
}

/** The idempotency key of one window: `cmp:<allocId>:<windowStartMs>`, plus `:<meter>` for extra meters. */
export function usageKey(allocationId: string, windowStart: number, meter?: string): string {
  return `cmp:${allocationId}:${windowStart}${meter ? `:${meter}` : ''}`;
}

/** The hour-aligned windows `[from, to)` covers, with the fraction of each hour used. */
export function hourlyWindows(
  from: number,
  to: number,
): { start: number; end: number; fraction: number }[] {
  const windows: { start: number; end: number; fraction: number }[] = [];
  if (!(to > from)) return windows;
  for (let start = Math.floor(from / hourMs) * hourMs; start < to; start += hourMs) {
    const end = start + hourMs;
    const used = Math.min(end, to) - Math.max(start, from);
    if (used > 0) windows.push({ start, end, fraction: used / hourMs });
  }
  return windows;
}

export interface MeterAllocationInput {
  allocationId: string;
  tenantId: string;
  /** The person (delegated work) or the agent (agent keys); absent bills the tenant. */
  identityId?: string;
  lines: readonly MeterLine[];
  tags: UsageTags;
  /** Billing starts here (reservations: when they became active). */
  from: number;
  /** Billing ends here: the release, or the booked end. */
  to: number;
}

/**
 * Writes the final windows of one allocation up to `now` and answers how many were new. A window is
 * final when its hour has closed, or when billing ended inside it (`to <= now`).
 */
export async function meterAllocation(
  tx: SqlTx,
  input: MeterAllocationInput,
  now: number,
): Promise<number> {
  const until = Math.min(input.to, now);
  const lines = input.lines.filter((line) => line.perHour > 0);
  if (lines.length === 0 || !(until > input.from)) return 0;
  const tags = Object.fromEntries(
    Object.entries(input.tags).filter(([, value]) => typeof value === 'string' && value !== ''),
  ) as Record<string, Json>;
  let written = 0;
  for (const window of hourlyWindows(input.from, until)) {
    const final = window.end <= now || input.to <= now;
    if (!final) continue;
    for (const [index, line] of lines.entries()) {
      const quantity = Math.round(line.perHour * window.fraction * 1e6) / 1e6;
      if (quantity <= 0) continue;
      const { rowCount } = await tx.query(
        `INSERT INTO usage_windows (idempotency_key, allocation_id, tenant_id, identity_id, meter, quantity,
                                    window_start, window_end, tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::jsonb)
         ON CONFLICT DO NOTHING`,
        [
          usageKey(input.allocationId, window.start, index === 0 ? undefined : line.meter),
          input.allocationId,
          input.tenantId,
          input.identityId ?? null,
          line.meter,
          quantity,
          new Date(window.start).toISOString(),
          new Date(window.end).toISOString(),
          JSON.stringify(tags),
        ],
      );
      written += rowCount;
    }
  }
  return written;
}

/** Compute slices of a full GPU a MIG profile holds (A100/H100/H200/B200: 7 slices). */
export const migSlicesPerGpu = 7;

/**
 * The share of a whole GPU one atom bills (§10.6): a `gpu` is 1; a time-slice slot is `1/slots`;
 * an MPS slot is `mpsUnits/100`; a MIG instance is its compute slices over 7 (`3g.40gb` → 3/7).
 * `gpuFractionSql` is the same rule in SQL; tests keep the two in agreement.
 */
export function gpuFraction(
  deviceClass: string,
  attributes: Readonly<Record<string, string | number | boolean>>,
): number {
  if (deviceClass === 'gpu') return 1;
  if (deviceClass === 'gpu.slot') {
    if (typeof attributes.mpsUnits === 'number') return attributes.mpsUnits / 100;
    const slots = Number(attributes.slots);
    return slots > 0 ? 1 / slots : 0;
  }
  if (deviceClass === 'gpu.mig') {
    const slices = /^(\d+)g/.exec(String(attributes.migProfile ?? ''));
    return (slices ? Number(slices[1]) : 1) / migSlicesPerGpu;
  }
  return 0;
}

/** `gpuFraction` over a `devices` row aliased `d`. */
export function gpuFractionSql(d: string): string {
  return `CASE WHEN ${d}.class = 'gpu' THEN 1
    WHEN ${d}.class = 'gpu.slot' AND ${d}.attributes ? 'mpsUnits'
      THEN (${d}.attributes->>'mpsUnits')::numeric / 100
    WHEN ${d}.class = 'gpu.slot' AND (${d}.attributes->>'slots')::numeric > 0
      THEN 1 / (${d}.attributes->>'slots')::numeric
    WHEN ${d}.class = 'gpu.mig'
      THEN COALESCE(substring(${d}.attributes->>'migProfile' from '^(\\d+)g')::numeric, 1) / ${migSlicesPerGpu}
    ELSE 0 END`;
}

interface MeterableReservation {
  allocation_id: string;
  tenant_id: string;
  owner_identity_id: string;
  delegation_id: string | null;
  agent_id: string | null;
  project_id: string | null;
  pool_id: string;
  gpu_model: string | null;
  region: string;
  gpus: string | number;
  from_ms: number;
  to_ms: number;
}

/**
 * One metering pass over reservation allocations (the `capacity.usage` job): every allocation that
 * went active, is live or ended within `lookbackMs`, and whose windows are not all written yet.
 */
export async function meterReservations(
  tx: SqlTx,
  now: number,
  options: { lookbackMs?: number; limit?: number } = {},
): Promise<{ allocations: number; windows: number }> {
  const lookback = options.lookbackMs ?? 48 * hourMs;
  const { rows } = await tx.query<MeterableReservation>(
    `SELECT a.id AS allocation_id, a.tenant_id, r.owner_identity_id, r.delegation_id, r.agent_id,
            r.project_id, a.pool_id, p.gpu_model, s.region,
            (SELECT COALESCE(sum(${gpuFractionSql('d')}), 0) FROM unnest(a.atoms) atom
               JOIN devices d ON d.id = atom) AS gpus,
            (extract(epoch FROM a.bound_at) * 1000)::float8 AS from_ms,
            (extract(epoch FROM LEAST(COALESCE(a.released_at, upper(a.during)), upper(a.during))) * 1000)::float8 AS to_ms
       FROM allocations a
       JOIN reservations r ON r.id = a.owner_id AND a.owner_kind = 'reservation'
       JOIN pools p ON p.id = a.pool_id
       JOIN sites s ON s.id = p.site_id
      WHERE a.bound_at IS NOT NULL AND a.bound_at < $1::timestamptz
        AND COALESCE(a.released_at, upper(a.during)) > $1::timestamptz - make_interval(secs => $2 / 1000.0)
      ORDER BY a.id LIMIT $3`,
    [new Date(now).toISOString(), lookback, options.limit ?? 5000],
  );
  let windows = 0;
  for (const row of rows) {
    const tags: UsageTags = {
      region: row.region,
      pool: row.pool_id,
      gpuModel: row.gpu_model ?? 'other',
    };
    if (row.project_id) tags.project = row.project_id;
    // Delegated work bills the person and tags the agent (§12.7 attribution).
    if (row.delegation_id && row.agent_id) tags.agent = row.agent_id;
    windows += await meterAllocation(
      tx,
      {
        allocationId: row.allocation_id,
        tenantId: row.tenant_id,
        identityId: row.owner_identity_id,
        lines: [{ meter: gpuMeter(row.gpu_model ?? undefined), perHour: Number(row.gpus) }],
        tags,
        from: Number(row.from_ms),
        to: Number(row.to_ms),
      },
      now,
    );
  }
  return { allocations: rows.length, windows };
}
