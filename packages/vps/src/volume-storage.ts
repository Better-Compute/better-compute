import { ComputeError, type Finding, type Migration, type SqlExecutor, type SqlTx } from '@better-compute/core';
import type { StatusReport } from '@better-compute/protocol';

// What a runtime host's volume store can really hold (review 2, MED 2). Volumes are sparse files in bcd's
// data directory, and diskGiB (the sum of the node's disks, overcommitted) says nothing about that
// filesystem. So a tenant could book volumes past what it can write and fill the directory other
// tenants' VMs live in. bcd reports the filesystem in StatusReport.volume_storage (37d6d6d):
// total, available (statfs Bavail), reserved (kept from volumes), committed (the sum of its volumes'
// sizes), outstanding (their unwritten, sparse space). It refuses a create or growth beyond
// available − reserved − outstanding, and capacity applies the same rule before booking. Space
// already booked here that bcd has not reported yet counts too (Σ size − committed). A host without a
// report books no volume. Never overcommitted.

export const vpsVolumeStorageMigration: Migration = {
  name: 'vps/0022_volume_storage',
  sql: `
-- A runtime host's volume store (StatusReport.volume_storage), as it last reported it.
CREATE TABLE host_volume_storage (
  node_id text PRIMARY KEY REFERENCES nodes ON DELETE CASCADE,
  total_bytes bigint NOT NULL,
  available_bytes bigint NOT NULL,
  reserved_bytes bigint NOT NULL,
  committed_bytes bigint NOT NULL,
  outstanding_bytes bigint NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT compute_now()
);
`,
};

const GiB = 2 ** 30;
/** A report is written when a value moved by at least this much, or the stored one is this old. */
const writeDeltaBytes = GiB;
const refreshSeconds = 300;

/**
 * `reports.status` for runtime hosts (vps() declares it as a module status handler): keeps the latest
 * `volume_storage` per node. It writes only when a value moved by at least 1 GiB, committed or outstanding
 * changed, or the stored report is five minutes old; a report without it changes nothing.
 */
export function volumeStorageStatusHandler() {
  return async function vpsVolumeStorage(
    tx: SqlTx,
    context: { nodeId: string },
    report: Pick<StatusReport, 'volumeStorage'>,
  ): Promise<boolean> {
    const storage = report.volumeStorage;
    if (!storage || storage.totalBytes === 0n) return false;
    const values = [storage.totalBytes, storage.availableBytes, storage.reservedBytes, storage.committedBytes, storage.outstandingBytes].map(String);
    const { rowCount } = await tx.query(
      `INSERT INTO host_volume_storage AS h (node_id, total_bytes, available_bytes, reserved_bytes, committed_bytes, outstanding_bytes)
       SELECT $1, $2, $3, $4, $5, $6 WHERE EXISTS (SELECT 1 FROM nodes WHERE id = $1)
       ON CONFLICT (node_id) DO UPDATE SET total_bytes = EXCLUDED.total_bytes, available_bytes = EXCLUDED.available_bytes,
         reserved_bytes = EXCLUDED.reserved_bytes, committed_bytes = EXCLUDED.committed_bytes,
         outstanding_bytes = EXCLUDED.outstanding_bytes, reported_at = compute_now()
       WHERE h.committed_bytes <> EXCLUDED.committed_bytes OR h.outstanding_bytes <> EXCLUDED.outstanding_bytes
          OR abs(h.available_bytes - EXCLUDED.available_bytes) >= $7 OR abs(h.reserved_bytes - EXCLUDED.reserved_bytes) >= $7
          OR abs(h.total_bytes - EXCLUDED.total_bytes) >= $7
          OR h.reported_at < compute_now() - make_interval(secs => $8)`,
      [context.nodeId, ...values, writeDeltaBytes, refreshSeconds],
    );
    return rowCount > 0;
  };
}

/**
 * GiB a host's volume store can still promise, by bcd's rule: available − reserved − outstanding, less what
 * the control plane booked on it that bcd has not reported yet (the node's live volumes' sizes beyond its
 * reported committed). `undefined` for a host without a report. `lock` holds the host's row, so concurrent
 * bookings on it are decided one after the other.
 */
export async function volumeHeadroomGiB(tx: SqlTx, nodeIds: readonly string[], options: { lock?: boolean } = {}): Promise<Map<string, number>> {
  if (nodeIds.length === 0) return new Map();
  const { rows } = await tx.query<{ node_id: string; headroom: string }>(
    `WITH h AS (
       SELECT node_id, available_bytes, reserved_bytes, committed_bytes, outstanding_bytes
         FROM host_volume_storage WHERE node_id = ANY($1::text[]) ORDER BY node_id${options.lock ? ' FOR UPDATE' : ''})
     SELECT h.node_id,
            (h.available_bytes - h.reserved_bytes - h.outstanding_bytes
              - GREATEST(0, COALESCE((SELECT sum(v.size_gib) FROM sandbox_volumes v
                                       WHERE v.node_id = h.node_id AND v.state <> 'deleted'), 0) * $2::bigint - h.committed_bytes))::text AS headroom
       FROM h`,
    [nodeIds, GiB],
  );
  return new Map(rows.map((row) => [row.node_id, Math.floor(Number(row.headroom) / GiB)]));
}

/** The hosts of a pool whose volume store can take `sizeGiB` more (locked for this transaction), best first. */
export async function volumeStorageNodes(tx: SqlTx, poolId: string, sizeGiB: number): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM nodes WHERE pool_id = $1 AND role = 'host' AND deleted_at IS NULL ORDER BY id`,
    [poolId],
  );
  const headroom = await volumeHeadroomGiB(
    tx,
    rows.map((row) => row.id),
    { lock: true },
  );
  return [...headroom].filter(([, free]) => free >= sizeGiB).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
}

/** `CAPACITY_UNAVAILABLE` unless `nodeId`'s volume store can take `growGiB` more (the row stays locked). */
export async function assertVolumeStorage(tx: SqlTx, nodeId: string, growGiB: number, what: string): Promise<void> {
  const free = (await volumeHeadroomGiB(tx, [nodeId], { lock: true })).get(nodeId);
  if (free === undefined)
    throw new ComputeError('CAPACITY_UNAVAILABLE', `Host ${nodeId} has not reported its volume store; ${what} waits for it`, undefined, {
      reason: 'volume-storage-unknown',
      nodeId,
    });
  if (free < growGiB)
    throw new ComputeError('CAPACITY_UNAVAILABLE', `Host ${nodeId}'s volume store has ${Math.max(free, 0)} GiB free; ${what} needs ${growGiB}`, undefined, {
      reason: 'volume-storage',
      nodeId,
      freeGiB: Math.max(free, 0),
      neededGiB: growGiB,
    });
}

/**
 * Doctor findings (vps selfCheck) about volume stores:
 * - `vps.volumes.storage-unreported` (warning): hosts whose bcd keeps volumes (`bc.dev/cap.instance.volumes`)
 *   but never reported its store. No volume can be booked there (an older bcd).
 * - `vps.volumes.storage-stale` (warning): connected hosts whose last report is over an hour old.
 * - `vps.volumes.storage-full` (error): hosts whose booked volumes exceed what their store can hold, e.g.
 *   after the filesystem filled up. Growth and new volumes there are refused until space comes back.
 */
export async function volumeStorageSelfCheck(sql: Pick<SqlExecutor, 'query'>): Promise<Finding[]> {
  const present = await sql.query<{ found: string | null }>(`SELECT to_regclass('host_volume_storage')::text AS found`);
  if (!present.rows[0]?.found) return [];
  const { rows } = await sql.query<{ unreported: string[] | null; stale: string[] | null }>(
    `SELECT
       (SELECT array_agg(n.id ORDER BY n.id) FROM nodes n
         WHERE n.deleted_at IS NULL AND n.role = 'host'
           AND EXISTS (SELECT 1 FROM node_labels l WHERE l.node_id = n.id AND l.key = 'bc.dev/cap.instance.volumes' AND l.source = 'system')
           AND NOT EXISTS (SELECT 1 FROM host_volume_storage h WHERE h.node_id = n.id)) AS unreported,
       (SELECT array_agg(h.node_id ORDER BY h.node_id) FROM host_volume_storage h JOIN nodes n ON n.id = h.node_id
         WHERE n.deleted_at IS NULL AND n.connectivity = 'connected' AND h.reported_at < compute_now() - interval '1 hour') AS stale`,
  );
  const all = await sql.query<{ node_id: string }>('SELECT node_id FROM host_volume_storage ORDER BY node_id');
  const headroom = await volumeHeadroomGiB(sql as SqlTx, all.rows.map((row) => row.node_id));
  const full = [...headroom].filter(([, free]) => free < 0).map(([node, free]) => `${node} (${-free} GiB over)`);
  const findings: Finding[] = [];
  const unreported = rows[0]?.unreported ?? [];
  if (unreported.length)
    findings.push({
      check: 'vps.volumes.storage-unreported',
      severity: 'warning',
      message: `${unreported.length} host(s) keep volumes but never reported their volume store, so no volume can be booked there: ${unreported.slice(0, 10).join(', ')}`,
      fix: 'Update bcd on those hosts to one that reports StatusReport.volume_storage',
      count: unreported.length,
    });
  const stale = rows[0]?.stale ?? [];
  if (stale.length)
    findings.push({
      check: 'vps.volumes.storage-stale',
      severity: 'warning',
      message: `${stale.length} connected host(s) have not refreshed their volume store report in over an hour: ${stale.slice(0, 10).join(', ')}`,
      fix: 'Check that the gateway composes vps() status handlers (serve does) and that the hosts send status reports',
      count: stale.length,
    });
  if (full.length)
    findings.push({
      check: 'vps.volumes.storage-full',
      severity: 'error',
      message: `${full.length} host(s) have more volume space booked than their store can hold: ${full.slice(0, 10).join(', ')}`,
      fix: 'Free or add space in the data directory of those hosts, or move volumes off them; new volumes and growth there are refused until then',
      count: full.length,
    });
  return findings;
}