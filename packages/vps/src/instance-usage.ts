import {
  canonicalGpuModel,
  defaultMeterGpuModels,
  knownGpuFamilies,
  newId,
  type ExternalMachine,
  type Migration,
  type PoolPolicy,
  type SqlTx,
} from '@better-compute/core';
import { meterSource, type UsageTags } from '@better-compute/capacity';
import {
  billingModeOf,
  disksOf,
  hasPublicAddress,
  meterLinesFor,
  type DiskRecord,
  type BillableShape,
  type BillingMode,
  type MeterLine,
} from './billing.js';
import { withCondition, withoutCondition, type InstanceRow } from './instances.js';

// Lifecycle usage intervals (platform compute billing, D3): a provider instance's exact running and
// stopped spans, written in the same transactions as the lifecycle changes that start and end them.
// The `vps.provider-usage` reconciler (Task 7) turns them into hourly usage windows and advances
// `metered_until`. Only provider-pool instances have intervals; hosted instances keep allocation
// metering. The database referees: an exclusion constraint refuses two overlapping intervals of one
// instance, so a restarted or racing reconciler can never bill the same span twice.

export const instanceUsageMigration: Migration = {
  name: 'vps/0030_instance_usage',
  sql: `
CREATE TABLE instance_usage_intervals (
  id text PRIMARY KEY,
  instance_id text NOT NULL REFERENCES instances,
  tenant_id text NOT NULL, project_id text, identity_id text,
  pool_id text NOT NULL, region text, provider text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('running', 'stopped')),
  mode text NOT NULL CHECK (mode IN ('metered', 'platform-fee', 'none')),
  -- BillableShape, captured when the interval opened.
  shape jsonb NOT NULL,
  started_at timestamptz NOT NULL, ended_at timestamptz,
  -- How far the usage reconciler has written windows (= started_at initially).
  metered_until timestamptz NOT NULL,
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  EXCLUDE USING gist (instance_id WITH =, tstzrange(started_at, coalesce(ended_at, 'infinity')) WITH &&)
);
CREATE INDEX instance_usage_open ON instance_usage_intervals (metered_until) WHERE ended_at IS NULL OR metered_until < ended_at;
-- D6: an attached instance's billing; NULL = the pool's default.
ALTER TABLE instances ADD COLUMN billing text CHECK (billing IN ('metered', 'none'));
-- A flavor's whole-shape meter ({ "meter": "flavor.<...>.hours" }), set by root; instances snapshot it when created.
ALTER TABLE flavors ADD COLUMN billing jsonb;
`,
};

export type IntervalPhase = 'running' | 'stopped';

/**
 * What the provider reported about the machine when the interval opens: its GPU model, region, addresses (a public
 * one is an `ip.public.hours` line) and disks (`disk.<type>.gib.hours`).
 */
export type ObservedMachine = Pick<
  ExternalMachine,
  'gpus' | 'region' | 'addresses' | 'networks' | 'disks' | 'bootDiskType'
>;

const json = <T>(value: T | string): T =>
  typeof value === 'string' ? (JSON.parse(value) as T) : value;

/** Milliseconds to `timestamptz`, as the rest of vps writes them. */
const at$ = (index: number) => `to_timestamp($${index}::float8 / 1000)`;

/**
 * Closes the instance's open interval at `at`, never before it started and never before what the usage reconciler
 * already wrote for it (`metered_until`, F7-1): a close stamped inside an hour that pass has written ends the interval
 * at the watermark, so no span is billed that the interval did not cover. A no-op when none is open.
 * Called inside the lifecycle transaction that loses, fails, deletes or detaches the instance.
 */
export async function closeOpenInterval(tx: SqlTx, instanceId: string, at: number): Promise<void> {
  await tx.query(
    `UPDATE instance_usage_intervals SET ended_at = GREATEST(started_at, metered_until, ${at$(2)})
      WHERE instance_id = $1 AND ended_at IS NULL`,
    [instanceId, at],
  );
}

/** What opening an interval needs beyond its transaction. */
export interface IntervalDeps {
  /** The IAM root tenant: a provider pool it owns is the platform's (metered); unknown fails closed. */
  rootTenantId?: string | undefined;
  /** The GPU models the deployment's meter catalog names (`vps({ billing: { gpuModels } })`), beside the known families. */
  meterGpuModels?: readonly string[] | undefined;
}

/**
 * The interval's GPU model (ruling F6-4), always as `canonicalGpuModel` names it, from the most stable source: the
 * instance's latest interval (unless it could only say `other`), then what the provider reported now, then the
 * pool's `gpu_model`. A provider read that omits the GPUs therefore never flaps an interval between a model and
 * `other`; one that names a model upgrades an `other` once.
 */
function gpuModelOf(
  stored: string | null,
  observed: ObservedMachine | undefined,
  poolModel: string | null,
  deps: IntervalDeps,
): string {
  const families = [...knownGpuFamilies, ...defaultMeterGpuModels, ...(deps.meterGpuModels ?? [])];
  for (const raw of [stored, observed?.gpus?.model, poolModel]) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const model = canonicalGpuModel(raw, families);
    if (model !== 'other') return model;
  }
  return 'other';
}

interface Billing {
  tenantId: string;
  projectId: string | null;
  identityId: string;
  poolId: string;
  region: string | null;
  provider: string;
  mode: BillingMode;
  shape: BillableShape;
  /** Provider disk types with no meter, metered as `pd-balanced` (the `DiskTypeUnknown` condition). */
  unknownDiskTypes: string[];
}

/**
 * What the instance is billed as right now, from its row, pool and account in this transaction;
 * `undefined` when it is not billed through intervals (not a provider pool, or attached with
 * `billing: 'none'`).
 */
async function billingOf(
  tx: SqlTx,
  instanceId: string,
  at: number,
  deps: IntervalDeps,
  observed: ObservedMachine | undefined,
  phase: IntervalPhase,
): Promise<Billing | undefined> {
  const { rows } = await tx.query<{
    tenant_id: string;
    project_id: string | null;
    owner_identity_id: string;
    pool_id: string;
    flavor: Record<string, unknown> | string;
    origin: string;
    billing: string | null;
    reserved: boolean;
    granted: boolean;
    pool_class: string;
    pool_owner: string;
    policy: PoolPolicy | string;
    site_region: string | null;
    provider: string | null;
    account_tenant: string | null;
    last_model: string | null;
    pool_gpu_model: string | null;
    machine_region: string | null;
    flavor_meter: string | null;
    addresses: string[] | null;
    machine_record: (DiskRecord & Record<string, unknown>) | string | null;
  }>(
    // The account resolves only when it is the pool owner's (ruling R1, as readPoolAccount); its
    // provider names the interval either way. `flavor_meter` is the live flavor's meter, read only for
    // rows whose snapshot predates `billing` (ruling F6-3).
    `SELECT i.tenant_id, i.project_id, i.owner_identity_id, i.pool_id, i.flavor, i.origin, i.billing,
            i.provider_reservation IS NOT NULL AS reserved,
            EXISTS (SELECT 1 FROM reservation_grants g
                     WHERE g.id = i.reservation_grant_id AND g.state <> 'cancelled'
                       AND g.starts_at <= ${at$(2)} AND g.ends_at > ${at$(2)}) AS granted,
            p.class AS pool_class, p.owner_tenant_id AS pool_owner, p.policy, s.region AS site_region,
            a.provider, CASE WHEN a.tenant_id = p.owner_tenant_id THEN a.tenant_id END AS account_tenant,
            m.machine->>'region' AS machine_region, p.gpu_model AS pool_gpu_model,
            (SELECT u.shape->'gpus'->>'model' FROM instance_usage_intervals u
              WHERE u.instance_id = i.id ORDER BY u.started_at DESC LIMIT 1) AS last_model,
            f.billing->>'meter' AS flavor_meter, i.addresses, m.machine AS machine_record
       FROM instances i
       JOIN pools p ON p.id = i.pool_id
       LEFT JOIN sites s ON s.id = p.site_id
       LEFT JOIN provider_accounts a ON a.id = i.provider_account_id
       LEFT JOIN provider_machines m ON m.account_id = i.provider_account_id AND m.external_id = i.external_id
       LEFT JOIN flavors f ON f.id = i.flavor_id
      WHERE i.id = $1`,
    [instanceId, at],
  );
  const row = rows[0];
  if (!row || row.pool_class !== 'provider') return undefined;
  if (row.origin === 'attached' && row.billing === 'none') return undefined;
  const flavor = json(row.flavor) ?? {};
  const count = Number(flavor.gpus ?? 0);
  const model =
    count > 0 ? gpuModelOf(row.last_model, observed, row.pool_gpu_model, deps) : 'other';
  // Ruling F6-3: the meter the instance was admitted with, from its flavor snapshot. Only a snapshot with no
  // `billing` key at all (a row created before snapshots carried it) falls back to the live flavor; a snapshot
  // that says `billing: {}` has no meter, whatever the flavor was given since.
  const snapshotMeter = (flavor.billing as { meter?: unknown } | undefined)?.meter;
  const flavorMeter =
    'billing' in flavor
      ? typeof snapshotMeter === 'string'
        ? snapshotMeter
        : undefined
      : (row.flavor_meter ?? undefined);
  // D9: the disks the provider reports for the machine now (else the last listing), else the flavor's boot disk.
  const { disks, unknownTypes } = disksOf(
    observed?.disks !== undefined || observed?.bootDiskType !== undefined
      ? observed
      : (json(row.machine_record) ?? undefined),
    Number(flavor.diskGiB ?? 0),
  );
  const shape: BillableShape = {
    vcpu: Number(flavor.vcpu ?? 0),
    memoryGiB: Number(flavor.memoryGiB ?? 0),
    ...(count > 0 ? { gpus: { model, count } } : {}),
    // No offer reports spot yet: a flavor (or a later offer field) that says so is read here.
    spot: flavor.spot === true,
    // D8: admitted against a provider reservation (`instances.provider_reservation`, set once by
    // `claimReservationSlot`), so `vm.reserved.*`. Captured here at open: binding, unbinding or losing the
    // reservation later changes no running interval.
    reserved: row.reserved,
    // D7: admitted into a reservation grant whose term covers `at`; the grant's slot-hours bill it, so its
    // lines are the informational `vm.grant.usage.hours` only. When the grant ends, its instances reopen
    // (`reopenGrantIntervals`) as ordinary reserved ones.
    granted: row.granted,
    ...(flavorMeter !== undefined ? { flavorMeter } : {}),
    // D9: a public address the provider reports now (else the addresses the row holds). Only a running instance bills
    // it, so only a running interval carries it, and a change of address closes and reopens the interval.
    ...(phase === 'running' &&
    hasPublicAddress({
      addresses: observed?.addresses ?? row.addresses ?? [],
      networks: observed?.networks,
    })
      ? { publicIp: true }
      : {}),
    disks,
  };
  // Without a known root tenant every provider pool reads as a tenant's own (BYO): fail closed (B8),
  // never charging compute for a pool not known to be the platform's.
  const mode = billingModeOf(
    { ownerTenantId: row.pool_owner, class: row.pool_class, policy: json(row.policy) ?? {} },
    row.account_tenant !== null ? { tenantId: row.account_tenant } : undefined,
    deps.rootTenantId ?? '',
  );
  return {
    tenantId: row.tenant_id,
    projectId: row.project_id,
    identityId: row.owner_identity_id,
    poolId: row.pool_id,
    region: observed?.region ?? row.machine_region ?? row.site_region,
    provider: row.provider ?? 'unknown',
    mode,
    shape,
    unknownDiskTypes: unknownTypes,
  };
}

/** The condition an instance carries while a disk of a type the rate card lacks is metered as `pd-balanced`. */
export const diskTypeUnknownCondition = 'DiskTypeUnknown';

/**
 * Keeps the `DiskTypeUnknown` condition in step with the disks the provider reports: set (with the type names) while
 * a disk's type has no `disk.<type>.gib.hours` meter, cleared once none is left. Written without a version bump:
 * the caller's row is mid-transaction and nothing a tenant can edit changes.
 */
async function syncDiskCondition(
  tx: SqlTx,
  row: InstanceRow,
  unknownTypes: readonly string[],
  at: number,
): Promise<void> {
  const present = row.conditions.find((entry) => entry.type === diskTypeUnknownCondition);
  let conditions;
  if (unknownTypes.length === 0) {
    if (!present) return;
    conditions = withoutCondition(row.conditions, diskTypeUnknownCondition);
  } else {
    const message = `Disk type ${unknownTypes.map((type) => `"${type}"`).join(', ')} has no disk meter; metered as pd-balanced`;
    if (present?.message === message && present.status === 'true') return;
    conditions = withCondition(
      row.conditions,
      { type: diskTypeUnknownCondition, status: 'true', reason: 'UnknownDiskType', message },
      at,
    );
  }
  await tx.query(`UPDATE instances SET conditions = $2::jsonb WHERE id = $1`, [
    row.id,
    JSON.stringify(conditions),
  ]);
}

/**
 * Opens a `phase` interval for a provider instance at `at`, inside the lifecycle transaction that
 * observed it (the provider reported the machine running or stopped). Idempotent: an open interval
 * of the same phase, mode and shape is kept, so steady polls and restarted reconcilers add nothing;
 * any other open interval (the other phase, a resize, a grant or mode change) is closed at `at`
 * first. A new interval never starts before the instance's last one ended, nor before an attached
 * instance's `attached_at`. Instances that are not billed through intervals get none (and any open
 * one closes).
 */
export async function openInterval(
  tx: SqlTx,
  row: InstanceRow,
  phase: IntervalPhase,
  at: number,
  deps: IntervalDeps,
  observed?: ObservedMachine,
): Promise<void> {
  if (row.poolClass !== 'provider') return;
  await openIntervalOf(tx, row.id, phase, at, deps, observed, row);
}

async function openIntervalOf(
  tx: SqlTx,
  instanceId: string,
  phase: IntervalPhase,
  at: number,
  deps: IntervalDeps,
  observed?: ObservedMachine,
  /** The lifecycle row, when a poll opens the interval: its disk condition is kept in step. Grant moves (no row) change no disks. */
  row?: InstanceRow,
): Promise<void> {
  const billing = await billingOf(tx, instanceId, at, deps, observed, phase);
  if (!billing) {
    await closeOpenInterval(tx, instanceId, at);
    return;
  }
  if (row) await syncDiskCondition(tx, row, billing.unknownDiskTypes, at);
  const shape = JSON.stringify(billing.shape);
  const { rows: open } = await tx.query<{ same: boolean }>(
    `SELECT (phase = $2 AND mode = $3 AND shape = $4::jsonb) AS same FROM instance_usage_intervals
      WHERE instance_id = $1 AND ended_at IS NULL`,
    [instanceId, phase, billing.mode, shape],
  );
  if (open[0]?.same) return;
  if (open.length > 0) await closeOpenInterval(tx, instanceId, at);
  await tx.query(
    `WITH start AS (
       SELECT GREATEST(${at$(12)},
                       (SELECT max(ended_at) FROM instance_usage_intervals WHERE instance_id = $2),
                       (SELECT attached_at FROM instances WHERE id = $2 AND origin = 'attached')) AS t
     )
     INSERT INTO instance_usage_intervals (id, instance_id, tenant_id, project_id, identity_id, pool_id,
                                           region, provider, phase, mode, shape, started_at, metered_until)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, t, t FROM start`,
    [
      newId('ivl'),
      instanceId,
      billing.tenantId,
      billing.projectId,
      billing.identityId,
      billing.poolId,
      billing.region,
      billing.provider,
      phase,
      billing.mode,
      shape,
      at,
    ],
  );
}

/**
 * Recomputes the instance's open interval at `at` (a grant it joined or left): an unchanged shape keeps it; any
 * other closes it at `at` (never before what was billed, F7-1) and opens one of the same phase. Nothing for an
 * instance with no open interval (not observed yet): its first interval reads the grant itself. Returns whether one
 * was open.
 */
export async function reopenInterval(
  tx: SqlTx,
  instanceId: string,
  at: number,
  deps: IntervalDeps,
): Promise<boolean> {
  const { rows } = await tx.query<{ phase: IntervalPhase }>(
    `SELECT phase FROM instance_usage_intervals WHERE instance_id = $1 AND ended_at IS NULL`,
    [instanceId],
  );
  if (!rows[0]) return false;
  await openIntervalOf(tx, instanceId, rows[0].phase, at, deps);
  return true;
}

/**
 * A reservation grant ended at `at` (Task 11): every instance of it with an open interval closes that interval at
 * `at` and opens one of the same phase whose shape is no longer `granted` (D7), so the hours after the grant's end
 * are billed at the reservation's rate rather than as part of a commitment nobody pays for any more. An interval
 * that already changed (a lifecycle poll got there first) is left as it is. Returns how many instances it reopened.
 */
export async function reopenGrantIntervals(
  tx: SqlTx,
  grantId: string,
  at: number,
  deps: IntervalDeps,
): Promise<number> {
  const { rows } = await tx.query<{ instance_id: string; phase: IntervalPhase }>(
    `SELECT u.instance_id, u.phase FROM instance_usage_intervals u
       JOIN instances i ON i.id = u.instance_id
      WHERE i.reservation_grant_id = $1 AND u.ended_at IS NULL AND (u.shape->>'granted')::boolean
      ORDER BY u.instance_id`,
    [grantId],
  );
  for (const row of rows) await openIntervalOf(tx, row.instance_id, row.phase, at, deps);
  return rows.length;
}

// --- The vps.provider-usage reconciler (Task 7) ----------------------------------------------------

/** What metering the intervals needs beyond its transaction. */
export interface MeteringDeps extends Pick<IntervalDeps, 'meterGpuModels'> {
  /** An ended hour is written only this long after it ended (default 5 minutes, F7-1). */
  meterGraceMs?: number | undefined;
}

/** The default `MeteringDeps.meterGraceMs`: lifecycle transactions stamped inside an hour commit within it. */
export const defaultMeterGraceMs = 5 * 60_000;

interface DueInterval {
  id: string;
  instance_id: string;
  tenant_id: string;
  project_id: string | null;
  identity_id: string | null;
  pool_id: string;
  region: string | null;
  provider: string;
  phase: IntervalPhase;
  mode: BillingMode;
  shape: BillableShape | string;
  started: number;
  ended: number | null;
  metered: number;
  flavor: string | null;
  flavor_disk: string | null;
  machine_record: DiskRecord | string | null;
}

/** The part of an interval one pass bills: `[from, until)` with the lines and tags to bill it by. */
interface Segment {
  from: number;
  until: number;
  startedAt: number;
  tenantId: string;
  identityId: string | null;
  lines: readonly MeterLine[];
  tags: UsageTags;
}

const hourMs = 3_600_000;

/**
 * One metering pass over the intervals with unbilled whole hours (`vps.provider-usage`): at most `limit` intervals,
 * oldest first, running ones before stopped ones. For each instance the pass writes `instance` windows (`meterSource`,
 * key `cmp:instance:<id>:<windowStartMs>:<meter>`) for every hour that has ended, then advances each interval's
 * `metered_until` to what it covered, in the same transaction (the retention contract of `meterSource`: an hour
 * already written is never derived again). The rows are locked, so a lifecycle change closing one waits for the pass.
 *
 * The window key names the instance, hour and meter, not the interval, so every interval of an instance that touches
 * an hour is summed into that hour's one window: a VM stopped and started again inside one hour, or a resize that
 * splits it, would otherwise lose all but the first interval's share to `ON CONFLICT DO NOTHING`.
 *
 * - `running`: the lines of `meterLinesFor(shape, mode, 'running', { gpuModels })`, `perHour` x the part of the hour
 *   the interval covered. An interval with no lines is marked metered without windows.
 * - `stopped`: through `meterLinesFor(shape, mode, 'stopped')`: the disk lines only (D9, a stopped VM keeps its disks).
 *   An interval opened before disks were captured has them derived here (ruling F7-3), so its backlog is billed.
 * - An interval that ended where it started (nothing to bill) never qualifies: its `metered_until` is its end.
 */
export async function meterIntervals(
  tx: SqlTx,
  now: number,
  deps: MeteringDeps = {},
  options: { limit?: number } = {},
): Promise<{ intervals: number; windows: number }> {
  // Whole hours only, and only once they are `meterGraceMs` old (F7-1): a lifecycle change stamped inside an hour
  // may commit a little after it, and the window key leaves no room for a late share.
  const grace = Math.max(0, deps.meterGraceMs ?? defaultMeterGraceMs);
  const floorNow = Math.floor((now - grace) / hourMs) * hourMs;
  // What is unbilled lies before the cutoff (or the interval's end). The two plain comparisons repeat it so the
  // `instance_usage_open` index applies (F7-2).
  const due = (alias: string) =>
    `${alias}.metered_until < ${at$(2)} AND (${alias}.ended_at IS NULL OR ${alias}.metered_until < ${alias}.ended_at)
     AND ${alias}.metered_until < LEAST(coalesce(${alias}.ended_at, ${at$(1)}), ${at$(2)})`;
  const { rows } = await tx.query<DueInterval>(
    `SELECT u.id, u.instance_id, u.tenant_id, u.project_id, u.identity_id, u.pool_id, u.region, u.provider,
            u.phase, u.mode, u.shape,
            (extract(epoch FROM u.started_at) * 1000)::float8 AS started,
            (extract(epoch FROM u.ended_at) * 1000)::float8 AS ended,
            (extract(epoch FROM u.metered_until) * 1000)::float8 AS metered,
            i.flavor->>'name' AS flavor, i.flavor->>'diskGiB' AS flavor_disk, m.machine AS machine_record
       FROM instance_usage_intervals u
       JOIN instances i ON i.id = u.instance_id
       LEFT JOIN provider_machines m ON m.account_id = i.provider_account_id AND m.external_id = i.external_id
      WHERE ${due('u')}
        AND u.instance_id IN (
              SELECT d.instance_id FROM instance_usage_intervals d
               WHERE ${due('d')}
               ORDER BY (d.phase = 'stopped'), d.metered_until, d.id LIMIT $3)
      ORDER BY u.instance_id, u.started_at
        FOR UPDATE OF u`,
    [now, floorNow, options.limit ?? 5000],
  );
  if (rows.length === 0) return { intervals: 0, windows: 0 };

  const meterOptions = deps.meterGpuModels ? { gpuModels: deps.meterGpuModels } : {};
  const byInstance = new Map<string, DueInterval[]>();
  for (const row of rows)
    byInstance.set(row.instance_id, [...(byInstance.get(row.instance_id) ?? []), row]);

  const advance: { id: string; until: number; done: boolean }[] = [];
  let windows = 0;
  for (const [instanceId, list] of byInstance) {
    const segments: Segment[] = [];
    for (const row of list) {
      const from = Math.round(Number(row.metered));
      const ended = row.ended === null ? null : Math.round(Number(row.ended));
      const until = Math.min(ended ?? floorNow, floorNow);
      let shape = json<BillableShape>(row.shape);
      // An interval opened before disks were captured (F7-3) gets them derived now, as at open: the machine record,
      // else the flavor's boot disk. Disks do not change while a VM is stopped, so its backlog is billed, not dropped.
      if (shape.disks === undefined)
        shape = {
          ...shape,
          disks: disksOf(json(row.machine_record) ?? undefined, Number(row.flavor_disk ?? 0)).disks,
        };
      const lines = meterLinesFor(shape, row.mode, row.phase, meterOptions);
      // An interval with no lines (a `none` or `platform-fee` stopped one, a stopped VM with no disk) has nothing to
      // bill and never will: it is advanced, not left due forever (F7-2).
      advance.push({ id: row.id, until, done: ended !== null && until === ended });
      if (lines.length === 0 || !(until > from)) continue;
      const tags: UsageTags = { pool: row.pool_id, provider: row.provider, source: 'instance' };
      if (row.region) tags.region = row.region;
      if (row.project_id) tags.project = row.project_id;
      if (shape.gpus && shape.gpus.count > 0) tags.gpuModel = shape.gpus.model;
      if (row.flavor) tags.flavor = row.flavor;
      segments.push({
        from,
        until,
        startedAt: Math.round(Number(row.started)),
        tenantId: row.tenant_id,
        identityId: row.identity_id,
        lines,
        tags,
      });
    }
    if (segments.length === 0) continue;

    const first =
      Math.floor(Math.min(...segments.map((segment) => segment.from)) / hourMs) * hourMs;
    const last = Math.max(...segments.map((segment) => segment.until));
    for (let hour = first; hour < last; hour += hourMs) {
      const quantities = new Map<string, number>();
      let latest: Segment | undefined;
      for (const segment of segments) {
        const used = Math.min(segment.until, hour + hourMs) - Math.max(segment.from, hour);
        if (used <= 0) continue;
        for (const line of segment.lines)
          quantities.set(
            line.meter,
            (quantities.get(line.meter) ?? 0) + (line.perHour * used) / hourMs,
          );
        if (!latest || segment.startedAt > latest.startedAt) latest = segment;
      }
      if (!latest) continue;
      // The window is the whole hour (fraction 1): the quantities already hold each interval's share of it.
      windows += await meterSource(
        tx,
        {
          sourceKind: 'instance',
          sourceId: instanceId,
          tenantId: latest.tenantId,
          ...(latest.identityId !== null ? { identityId: latest.identityId } : {}),
          lines: [...quantities].map(([meter, perHour]) => ({ meter, perHour })),
          from: hour,
          to: hour + hourMs,
          tags: latest.tags,
        },
        now,
      );
    }
  }

  if (advance.length > 0)
    await tx.query(
      `UPDATE instance_usage_intervals u
          SET metered_until = CASE WHEN v.done THEN u.ended_at ELSE to_timestamp(v.until / 1000) END
         FROM unnest($1::text[], $2::float8[], $3::bool[]) AS v(id, until, done)
        WHERE u.id = v.id`,
      [advance.map((a) => a.id), advance.map((a) => a.until), advance.map((a) => a.done)],
    );
  return { intervals: rows.length, windows };
}
