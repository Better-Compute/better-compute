import type { Json, SqlTx } from '@better-compute/core';

// Usage metering (PLAN.md §12.7, D14): hourly windows per allocation in `usage_windows`, which the
// IAM usage sink sends to `iam.billing` and marks recorded. The basis is reserved time, from the
// moment a reservation is active (bound) until it is released or ends. Windows are written only when
// final (the hour has closed, or the allocation ended), so a window never changes once written, and
// `ON CONFLICT DO NOTHING` on the idempotency key makes every pass safe to repeat. Spot reservations
// bill `gpu.<model>.spot.hours`; a preempted one is cut back to its notice deadline, and one that is
// re-queued never bound its first allocation, so a preempt + re-place bills each hour once.

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

/** The GPU meter of a model: `gpu.<gpuModel>.hours`, lower-cased; spot: `gpu.<gpuModel>.spot.hours`. */
export function gpuMeter(gpuModel: string | undefined, options: { spot?: boolean } = {}): string {
  return `gpu.${(gpuModel ?? 'other').toLowerCase()}${options.spot ? '.spot' : ''}.hours`;
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
  /** Per-window lines (keyed by the window start), overriding `lines`: e.g. a lease's healthy GPUs. */
  linesAt?: (windowStart: number) => readonly MeterLine[];
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
  if (!(until > input.from)) return 0;
  const tags = Object.fromEntries(
    Object.entries(input.tags).filter(([, value]) => typeof value === 'string' && value !== ''),
  ) as Record<string, Json>;
  let written = 0;
  for (const window of hourlyWindows(input.from, until)) {
    const final = window.end <= now || input.to <= now;
    if (!final) continue;
    // Line order is stable per allocation: the first line's key has no meter suffix.
    const lines = input.linesAt?.(window.start) ?? input.lines;
    for (const [index, line] of lines.entries()) {
      if (!(line.perHour > 0)) continue;
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
  healthy_gpus: string | number;
  spot: boolean;
  node_lease: boolean;
  from_ms: number;
  to_ms: number;
}

/** What one allocation holds in one usage window, for the pricing rule. */
export interface BillableInput {
  gpuModel?: string;
  spot: boolean;
  /** A `binding: 'node'` lease (the whole node, deployed by metal). */
  nodeLease: boolean;
  /** GPU fractions booked (`gpuFraction` summed over the atoms). */
  gpus: number;
  /** Of those, healthy at the window's start (node leases). */
  healthyGpus: number;
}

/** The meter of a node lease: one per lease-hour, on top of its GPUs. */
export const nodeLeaseMeter = 'node.metal.hours';

/**
 * The pricing rule, in one place (§12.7): what an allocation bills per hour of one window.
 * - A reservation bills every GPU it booked, at the spot meter when spot.
 * - A node lease bills `node.metal.hours` plus its GPUs that were healthy at the window's start. The
 *   unhealthy ones are booked only to keep others off the node, and cost the lessee nothing.
 * Line order is stable per allocation (usage keys depend on it).
 */
export function billableLines(input: BillableInput): MeterLine[] {
  const gpu = gpuMeter(input.gpuModel, { spot: input.spot });
  if (!input.nodeLease) return [{ meter: gpu, perHour: input.gpus }];
  return [
    { meter: nodeLeaseMeter, perHour: 1 },
    { meter: gpu, perHour: input.healthyGpus },
  ];
}

/**
 * Snapshots the healthy GPUs of every live, bound node lease for the window open at `now`, once per
 * window (`ON CONFLICT DO NOTHING`). The usage job runs every few minutes, so the snapshot is taken
 * shortly after the window starts; a window without one bills the health seen when it is written.
 */
export async function snapshotLeaseHealth(tx: SqlTx, now: number): Promise<number> {
  const windowStart = Math.floor(now / hourMs) * hourMs;
  const { rows } = await tx.query<{ allocation_id: string }>(
    `INSERT INTO capacity_lease_health (allocation_id, window_start, healthy_gpus)
     SELECT a.id, $2::timestamptz,
            (SELECT COALESCE(sum(${gpuFractionSql('d')}) FILTER (WHERE d.healthy), 0)
               FROM unnest(a.atoms) atom JOIN devices d ON d.id = atom)
       FROM allocations a JOIN reservations r ON r.id = a.owner_id AND a.owner_kind = 'reservation'
      WHERE r.request->>'binding' = 'node' AND a.bound_at IS NOT NULL AND a.released_at IS NULL
        AND a.during @> $1::timestamptz
     ON CONFLICT DO NOTHING RETURNING allocation_id`,
    [new Date(now).toISOString(), new Date(windowStart).toISOString()],
  );
  if (rows.length > 0)
    await markUnhealthyAtoms(
      tx,
      rows.map((row) => row.allocation_id),
      now,
    );
  return rows.length;
}

interface StoredCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  since: number;
}

/**
 * The `UnhealthyAtoms` condition of a node lease (§12.7): the GPUs it holds but does not pay for,
 * refreshed with each window's health snapshot and removed once all are healthy. The reservation
 * is its owner tenant's, so the message may name the atoms.
 */
async function markUnhealthyAtoms(
  tx: SqlTx,
  allocationIds: readonly string[],
  now: number,
): Promise<void> {
  const { rows } = await tx.query<{
    reservation_id: string;
    version: string | number;
    conditions: StoredCondition[] | string | null;
    unhealthy: string[] | null;
    total: string | number;
  }>(
    `SELECT r.id AS reservation_id, r.version, r.conditions,
            array_agg(d.id ORDER BY d.id) FILTER (WHERE NOT d.healthy AND d.class LIKE 'gpu%') AS unhealthy,
            count(d.id) FILTER (WHERE d.class LIKE 'gpu%') AS total
       FROM allocations a JOIN reservations r ON r.id = a.owner_id AND a.owner_kind = 'reservation'
       JOIN devices d ON d.id = ANY(a.atoms)
      WHERE a.id = ANY($1::text[])
      GROUP BY r.id, r.version, r.conditions
      ORDER BY r.id`,
    [allocationIds],
  );
  for (const row of rows) {
    const conditions: StoredCondition[] =
      typeof row.conditions === 'string' ? JSON.parse(row.conditions) : (row.conditions ?? []);
    const previous = conditions.find((entry) => entry.type === 'UnhealthyAtoms');
    const others = conditions.filter((entry) => entry.type !== 'UnhealthyAtoms');
    const unhealthy = row.unhealthy ?? [];
    const next =
      unhealthy.length === 0
        ? others
        : [
            ...others,
            {
              type: 'UnhealthyAtoms',
              status: 'true',
              reason: 'NotBilled',
              message: `${unhealthy.length} of ${Number(row.total)} GPUs unhealthy, not billed: ${unhealthy.slice(0, 16).join(', ')}`,
              since: previous?.since ?? now,
            },
          ];
    if (JSON.stringify(next) === JSON.stringify(conditions)) continue;
    // A lifecycle step holding the row wins; the next window refreshes the condition.
    await tx.query(
      `UPDATE reservations SET conditions = $3::jsonb, version = version + 1 WHERE id = $1 AND version = $2`,
      [row.reservation_id, row.version, JSON.stringify(next)],
    );
  }
}

/**
 * One metering pass over reservation allocations (the `capacity.usage` job): every allocation that
 * went active, is live or ended within `lookbackMs`, and whose windows are not all written yet.
 * Node leases are billed by `billableLines` per window, from the health snapshots.
 */
export async function meterReservations(
  tx: SqlTx,
  now: number,
  options: { lookbackMs?: number; limit?: number } = {},
): Promise<{ allocations: number; windows: number }> {
  await snapshotLeaseHealth(tx, now);
  const lookback = options.lookbackMs ?? 48 * hourMs;
  const { rows } = await tx.query<MeterableReservation>(
    `SELECT a.id AS allocation_id, a.tenant_id, r.owner_identity_id, r.delegation_id, r.agent_id,
            r.project_id, a.pool_id, p.gpu_model, s.region,
            (SELECT COALESCE(sum(${gpuFractionSql('d')}), 0) FROM unnest(a.atoms) atom
               JOIN devices d ON d.id = atom) AS gpus,
            (SELECT COALESCE(sum(${gpuFractionSql('d')}) FILTER (WHERE d.healthy), 0)
               FROM unnest(a.atoms) atom JOIN devices d ON d.id = atom) AS healthy_gpus,
            COALESCE((r.request->>'spot')::boolean, false) AS spot,
            r.request->>'binding' IS NOT DISTINCT FROM 'node' AS node_lease,
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
  const leases = rows.filter((row) => row.node_lease === true).map((row) => row.allocation_id);
  const snapshots = new Map<string, number>();
  if (leases.length > 0) {
    const { rows: health } = await tx.query<{
      allocation_id: string;
      start_ms: number;
      healthy_gpus: string | number;
    }>(
      `SELECT allocation_id, (extract(epoch FROM window_start) * 1000)::float8 AS start_ms, healthy_gpus
         FROM capacity_lease_health WHERE allocation_id = ANY($1::text[])`,
      [leases],
    );
    for (const entry of health)
      snapshots.set(`${entry.allocation_id}@${Number(entry.start_ms)}`, Number(entry.healthy_gpus));
  }
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
    const billable = (windowStart: number) =>
      billableLines({
        ...(row.gpu_model ? { gpuModel: row.gpu_model } : {}),
        spot: row.spot === true,
        nodeLease: row.node_lease === true,
        gpus: Number(row.gpus),
        healthyGpus:
          snapshots.get(`${row.allocation_id}@${windowStart}`) ?? Number(row.healthy_gpus),
      });
    windows += await meterAllocation(
      tx,
      {
        allocationId: row.allocation_id,
        tenantId: row.tenant_id,
        identityId: row.owner_identity_id,
        lines: billable(Number(row.from_ms)),
        linesAt: billable,
        tags,
        from: Number(row.from_ms),
        to: Number(row.to_ms),
      },
      now,
    );
  }
  return { allocations: rows.length, windows };
}
