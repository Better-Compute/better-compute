import { expect } from 'vitest';
import type { DevStack } from '@better-compute/testing';

// The v0.3 no-leak diff (PLAN.md §16), shared by the hosted-VPS end-to-end suites: what the emulated hosts hold
// (domains, overlays and seeds, taps) against what the database says (live instances and where they run), and every
// live allocation, IP lease and scalar claim against the instances that hold them.

export interface LiveInstance {
  id: string;
  node_id: string | null;
  state: string;
  desired_state: string;
}

/** Instances that are admitted and not yet deleted. */
export async function liveInstances(dev: DevStack): Promise<LiveInstance[]> {
  const { rows } = await dev.database.query<LiveInstance>(
    `SELECT id, node_id, state, desired_state FROM instances
      WHERE NOT draft AND state <> 'deleted' ORDER BY id`,
  );
  return rows;
}

/** Every live instance is placed and in its desired state (running, stopped or paused). */
export async function instancesSettled(dev: DevStack): Promise<boolean> {
  return (await liveInstances(dev)).every(
    (row) => row.node_id !== null && row.state === row.desired_state,
  );
}

/**
 * Fails the test on any leak across `nodes`. `orphanLogs` collects what `instanceStatusHandler({ log })` reported
 * (a domain a host holds that the database does not know).
 */
export async function checkNoLeaks(
  dev: DevStack,
  nodes: readonly string[],
  orphanLogs: readonly string[] = [],
): Promise<void> {
  const rows = await liveInstances(dev);
  for (const nodeId of nodes) {
    const hypervisor = dev.daemons.get(nodeId)!.hypervisor!;
    const expected = Object.fromEntries(
      rows.filter((row) => row.node_id === nodeId).map((row) => [row.id, row.desired_state]),
    );
    const held = Object.fromEntries(
      [...hypervisor.domains.values()].map((domain) => [domain.id, domain.state]),
    );
    expect(held, `domains on ${nodeId}`).toEqual(expected);
    expect(
      [...hypervisor.domains.values()].filter((domain) => !domain.managed),
      'unmanaged domains',
    ).toEqual([]);
    for (const [path, owner] of hypervisor.files)
      expect(hypervisor.domains.has(owner), `file ${path}`).toBe(true);
    for (const [tap, owner] of hypervisor.taps)
      expect(hypervisor.domains.has(owner), `tap ${tap}`).toBe(true);
    // Every domain has its overlay, seed and tap.
    expect(hypervisor.files.size).toBe(hypervisor.domains.size * 2);
    expect(hypervisor.taps.size).toBe(hypervisor.domains.size);
  }
  const placed = rows.map((row) => row.id);
  const allocations = await dev.database.query<{ owner_id: string }>(
    `SELECT owner_id FROM allocations WHERE owner_kind = 'instance' AND released_at IS NULL ORDER BY owner_id`,
  );
  expect(
    allocations.rows.map((row) => row.owner_id),
    'live allocations',
  ).toEqual(placed);
  const leases = await dev.database.query<{ instance_id: string }>(
    `SELECT instance_id FROM ip_leases ORDER BY instance_id`,
  );
  expect(
    leases.rows.map((row) => row.instance_id),
    'IP leases',
  ).toEqual(placed);
  const drift = await dev.database.query(
    `SELECT r.node_id, r.resource FROM node_resources r
       LEFT JOIN allocations a ON a.node_id = r.node_id AND a.released_at IS NULL
      WHERE r.node_id = ANY($1)
      GROUP BY r.node_id, r.resource, r.allocated
     HAVING r.allocated <> COALESCE(sum((a.resources->>r.resource)::bigint), 0)`,
    [nodes],
  );
  expect(drift.rows, 'scalar drift').toEqual([]);
  expect(orphanLogs, 'orphans reported by the status handler').toEqual([]);
}
