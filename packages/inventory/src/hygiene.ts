import type { Duration, EventPublisher, Json, ReconcileContext, Reconciler, SqlExecutor } from '@better-compute/core';
import { PROTOCOL_VERSION } from '@better-compute/protocol';
import { upsertNodeConditions } from './health.js';
import { mergeNoScheduleReasons } from './labels.js';

// Node hygiene (PLAN.md §10.1 last row: "alert, taint"): conditions no single report raises, found
// by a periodic sweep over every node.
// - `DriverMismatch`: the node converged (observed_generation >= generation) on a spec whose
//   `nvidia-driver` unit wants branch B, yet its GPUs report a driver of another branch.
// - `CertExpiring`: the newest unrevoked certificate of the node's identity generation (ramdisk
//   certificates aside) has less than a tenth of its lifetime left, and at least an hour: renewal,
//   which runs well before that, is failing.
// - `DaemonOutdated`: the daemon speaks an older protocol than the control plane, or runs a version
//   below the configured minimum (§7.6 skew window).
// Each raises NoSchedule (the taint) and publishes `node.condition.changed` (the alert); both go
// again when the cause does. Only changes are written.

export const hygieneConditions = ['DriverMismatch', 'CertExpiring', 'DaemonOutdated'] as const;
export type HygieneCondition = (typeof hygieneConditions)[number];

export const hygieneWorkKind = 'inventory.hygiene';

export interface HygieneOptions {
  /** How often the sweep runs (default 5 minutes). */
  every?: Duration;
  /** DaemonOutdated below this daemon version (`x.y.z`); unset: only the protocol check. */
  minDaemonVersion?: string;
  /** The highest protocol version the control plane speaks (default this build's). */
  protocolMax?: number;
  /** CertExpiring below this fraction of the certificate's lifetime (default 0.1). */
  certExpiringFraction?: number;
  /** ...and below this many seconds at least (default 3600). */
  certExpiringMinSeconds?: number;
  /** Nodes per transaction (default 500). */
  batch?: number;
}

interface HygieneRow {
  id: string;
  owner_tenant_id: string;
  no_schedule_reasons: string[];
  converged: boolean;
  want_branch: string | null;
  driver: string | null;
  daemon_version: string | null;
  proto_max: number | null;
  cert_from: Date | null;
  cert_to: Date | null;
  now: Date;
  current: Record<string, string> | null;
}

/** `x.y.z` (a leading `v` and a `-pre`/`+build` suffix allowed) → comparable numbers, else undefined. */
export function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}
function versionBelow(version: string, minimum: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

/** The hygiene conditions one node's facts imply (true with a reason, or false). */
export function evaluateHygiene(
  row: Pick<HygieneRow, 'converged' | 'want_branch' | 'driver' | 'daemon_version' | 'proto_max' | 'cert_from' | 'cert_to' | 'now'>,
  options: HygieneOptions = {},
): Record<HygieneCondition, { status: boolean; reason?: string }> {
  const branch = row.driver ? row.driver.split('.')[0] : undefined;
  const driver =
    row.converged && row.want_branch && branch && branch !== row.want_branch
      ? { status: true, reason: `driver ${row.driver}, spec wants branch ${row.want_branch}` }
      : { status: false };
  let cert: { status: boolean; reason?: string } = { status: false };
  if (row.cert_from && row.cert_to) {
    const left = row.cert_to.getTime() - row.now.getTime();
    const lifetime = row.cert_to.getTime() - row.cert_from.getTime();
    const window = Math.max((options.certExpiringFraction ?? 0.1) * lifetime, (options.certExpiringMinSeconds ?? 3600) * 1000);
    if (left < window)
      cert = { status: true, reason: left > 0 ? `certificate expires in ${Math.round(left / 60_000)} min` : 'certificate expired' };
  }
  const protocolMax = options.protocolMax ?? PROTOCOL_VERSION.max;
  let daemon: { status: boolean; reason?: string } = { status: false };
  if (row.proto_max !== null && row.proto_max < protocolMax) daemon = { status: true, reason: `protocol ${row.proto_max} < ${protocolMax}` };
  else if (row.daemon_version && options.minDaemonVersion && versionBelow(row.daemon_version, options.minDaemonVersion))
    daemon = { status: true, reason: `bcd ${row.daemon_version} < ${options.minDaemonVersion}` };
  return { DriverMismatch: driver, CertExpiring: cert, DaemonOutdated: daemon };
}

export interface HygieneResult {
  checked: number;
  raised: number;
  cleared: number;
}

/**
 * One hygiene sweep over every node, `batch` nodes per transaction (keyset by id). Writes only
 * conditions whose status changes, updates `no_schedule_reasons` under the node row lock, and
 * publishes `node.condition.changed` for each change.
 */
export async function runHygiene(
  sql: SqlExecutor,
  options: HygieneOptions & { events?: EventPublisher } = {},
): Promise<HygieneResult> {
  const result: HygieneResult = { checked: 0, raised: 0, cleared: 0 };
  const batch = options.batch ?? 500;
  let after = '';
  for (;;) {
    const page = await sql.transaction(async (tx) => {
      const { rows } = await tx.query<HygieneRow>(
        `SELECT n.id, n.owner_tenant_id, n.no_schedule_reasons,
                n.observed_generation >= n.generation AS converged,
                (SELECT (u->>'configJson')::jsonb->>'branch' FROM jsonb_array_elements(n.spec->'host'->'units') u
                  WHERE u->>'unit' = 'nvidia-driver' LIMIT 1) AS want_branch,
                s.sections->'gpus'->>'driverVersion' AS driver,
                ss.daemon_version, ss.proto_max,
                c.not_before AS cert_from, c.not_after AS cert_to, compute_now() AS now,
                (SELECT jsonb_object_agg(nc.type, nc.status) FROM node_conditions nc
                  WHERE nc.node_id = n.id AND nc.type = ANY($3::text[])) AS current
           FROM nodes n
           LEFT JOIN node_inventory ni ON ni.node_id = n.id
           LEFT JOIN inventory_snapshots s ON s.id = ni.applied_snapshot_id
           LEFT JOIN node_sessions ss ON ss.node_id = n.id
           LEFT JOIN LATERAL (
             SELECT not_before, not_after FROM node_certs
              WHERE node_id = n.id AND revoked_at IS NULL AND role <> 'ramdisk' AND identity_gen = n.identity_gen
              ORDER BY not_after DESC LIMIT 1) c ON true
          WHERE n.id > $1 AND n.deleted_at IS NULL AND n.provision_state <> 'retired'
          ORDER BY n.id LIMIT $2`,
        [after, batch, [...hygieneConditions]],
      );
      for (const row of rows) {
        const next = evaluateHygiene(row, options);
        const current = row.current ?? {};
        const changed = hygieneConditions.filter((type) => next[type].status !== (current[type] === 'true') && (next[type].status || type in current));
        if (changed.length === 0) continue;
        const locked = await tx.query<{ no_schedule_reasons: string[] }>('SELECT no_schedule_reasons FROM nodes WHERE id = $1 FOR UPDATE', [row.id]);
        const reasonsNow = locked.rows[0]?.no_schedule_reasons ?? row.no_schedule_reasons;
        await upsertNodeConditions(
          tx,
          row.id,
          changed.map((type) => ({ type, status: next[type].status ? 'true' : 'false', reason: next[type].reason ?? null })),
        );
        const reasons = mergeNoScheduleReasons(
          reasonsNow,
          hygieneConditions,
          hygieneConditions.map((type) => ({ type, status: next[type].status ? 'true' : 'false', noSchedule: next[type].status })),
        );
        if (JSON.stringify(reasons) !== JSON.stringify([...reasonsNow].sort()))
          await tx.query('UPDATE nodes SET no_schedule_reasons = $2, version = version + 1 WHERE id = $1', [row.id, reasons]);
        const events = changed.map((type) => ({
          type: 'node.condition.changed',
          tenantId: row.owner_tenant_id,
          subject: `node/${row.id}`,
          data: { condition: type, status: next[type].status ? 'true' : 'false', reason: next[type].reason ?? null, noSchedule: next[type].status } as Json,
        }));
        if (options.events?.publishMany) await options.events.publishMany(tx, events);
        else for (const event of events) await options.events?.publish(tx, event);
        for (const type of changed) {
          if (next[type].status) result.raised++;
          else result.cleared++;
        }
      }
      return rows;
    });
    result.checked += page.length;
    if (page.length < batch) return result;
    after = page.at(-1)!.id;
  }
}

/** The hygiene sweep as a singleton periodic reconciler (key `all`). */
export function hygieneReconciler(options: HygieneOptions = {}): Reconciler {
  return Object.freeze({
    name: hygieneWorkKind,
    shardBy: 'none' as const,
    periodic: [{ key: 'all', every: options.every ?? '5m' }],
    async run(context: ReconcileContext): Promise<'DONE'> {
      const result = await runHygiene(context.sql, { ...options, ...(context.events ? { events: context.events } : {}) });
      if (result.raised || result.cleared) context.log?.info?.('node hygiene', { ...result });
      return 'DONE';
    },
  });
}
