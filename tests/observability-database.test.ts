import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import { databaseCollector, createMetrics, standardMetrics } from '@better-compute/observability';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';

// The §14 deployment gauges sampled from compute's tables (databaseCollector): due work by kind, backlogs, nodes by
// connectivity and generation lag, GPUs by state, certificate expiry, clock offset and command latency.

const T0 = Date.UTC(2026, 8, 24, 12);
let db: SqlExecutor;

beforeAll(async () => {
  db = pglite();
  await db.migrate();
  await useSimClock(db, T0);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site-1', 'root', 'shared', 'eu', 1)`,
  );
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ('pool-1', 'root', 'site-1', 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
  );
  const node = (id: string, connectivity: string, generation: number, observed: number) =>
    db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
                          connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, 'site-1', 'pool-1', 'root', 'host', 'adopted', false, false, $2, 'platform', $3, $4, 1, 1, 0, 1)`,
      [id, connectivity, generation, observed],
    );
  await node('node-a', 'connected', 2, 2);
  await node('node-b', 'connected', 3, 2);
  await node('node-c', 'unreachable', 1, 1);
});
afterAll(async () => {
  await db.close();
});

const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

describe('databaseCollector', () => {
  it('samples work, nodes, capacity, backlogs, certificates and the clock', async () => {
    // Due and unclaimed: 2 × reservation, 1 × health; not yet due / claimed: not counted.
    for (const [kind, key, notBefore, claimed] of [
      ['capacity.reservations', 'r1', -1_000, null],
      ['capacity.reservations', 'r2', 0, null],
      ['health', 'node-a', -5_000, null],
      ['health', 'node-b', 60_000, null],
      ['workflow', 'w1', -1_000, 30_000],
    ] as const)
      await db.query(
        `INSERT INTO work_queue (kind, key, shard, gen, not_before, claimed_until)
         VALUES ($1, $2, 0, 1, $3::timestamptz, $4::timestamptz)`,
        [kind, key, at(notBefore), claimed === null ? null : at(claimed)],
      );
    await db.query(
      `INSERT INTO pool_capacity_rollup (pool_id, resource, total, allocatable, allocated, reserved,
                                          provisioning, unhealthy, maintenance, unreachable)
       VALUES ('pool-1', 'gpu', 24, 16, 6, 2, 0, 1, 0, 8), ('pool-1', 'cpu', 999, 999, 0, 0, 0, 0, 0, 0)`,
    );
    await db.query(
      `INSERT INTO iam_inbox (event_id, tenant_id, sequence, occurred_at, action, body, received_at, processed_at)
       VALUES ('e1', 't', 1, compute_now(), 'agent:suspend', '{}', compute_now(), NULL),
              ('e2', 't', 2, compute_now(), 'agent:suspend', '{}', compute_now(), compute_now())`,
    );
    for (const [serial, nodeId, notAfterMs] of [
      ['01', 'node-a', 3_600_000],
      ['02', 'node-a', 20 * 3_600_000], // renewed: its newest certificate counts
      ['03', 'node-b', 10 * 3_600_000],
    ] as const)
      await db.query(
        `INSERT INTO node_certs (serial, node_id, role, identity_gen, spki_sha256, der, not_before, not_after)
         VALUES ($1, $2, 'node', 1, '\\x00', '\\x00', compute_now(), $3::timestamptz)`,
        [serial, nodeId, at(notAfterMs)],
      );

    // Two events; the `usage` sink has read the first, the `webhooks` sink none.
    for (const topic of ['node.connected', 'node.disconnected'])
      await db.query(`INSERT INTO outbox (topic, payload) VALUES ($1, '{}')`, [topic]);
    const { rows: first } = await db.query<{ txid: string; seq: string }>(
      'SELECT txid::text AS txid, seq::text AS seq FROM outbox ORDER BY txid, seq LIMIT 1',
    );
    await db.query(
      `INSERT INTO outbox_cursors (name, stream, txid, seq) VALUES ('usage', 'outbox', $1::xid8, $2::bigint),
              ('webhooks', 'outbox', '0'::xid8, 0)`,
      [first[0]!.txid, first[0]!.seq],
    );

    const registry = createMetrics();
    const metrics = standardMetrics(registry);
    const collector = databaseCollector(metrics, {
      sql: db,
      now: () => T0 + 1_500,
      certificates: () => [
        { kind: 'serving', notAfter: T0 + 30 * 86_400_000 },
        { kind: 'serving', notAfter: T0 + 7 * 86_400_000 },
      ],
    });
    await collector.refresh();
    const value = (name: string, labels?: Record<string, string>) => registry.value(name, labels);

    expect(value('work_queue_depth', { kind: 'capacity.reservations' })).toBe(2);
    expect(value('work_queue_depth', { kind: 'health' })).toBe(1);
    expect(value('work_queue_depth', { kind: 'workflow' })).toBeUndefined();
    expect(value('node_connectivity', { state: 'connected' })).toBe(2);
    expect(value('node_connectivity', { state: 'unreachable' })).toBe(1);
    expect(value('generation_lag_nodes')).toBe(1);
    expect(value('pool_gpus', { state: 'total' })).toBe(24);
    expect(value('pool_gpus', { state: 'allocated' })).toBe(6);
    expect(value('pool_gpus', { state: 'unreachable' })).toBe(8);
    expect(value('backlog', { queue: 'iam_inbox' })).toBe(1);
    expect(value('backlog', { queue: 'commands' })).toBe(0);
    expect(value('backlog', { queue: 'outbox:usage' })).toBe(1);
    expect(value('backlog', { queue: 'outbox:webhooks' })).toBe(2);
    expect(value('cert_expiry_seconds', { kind: 'node:node' })).toBe(10 * 3600);
    expect(value('cert_expiry_seconds', { kind: 'serving' })).toBe(7 * 86_400);
    expect(value('clock_offset_seconds')).toBeCloseTo(1.5, 3);
    expect(registry.expose()).toContain('better_compute_work_queue_depth{kind="health"} 1');

    // Work drains: a kind that is gone reads 0 rather than its last value.
    await db.query(`DELETE FROM work_queue WHERE kind = 'health'`);
    await collector.refresh();
    expect(value('work_queue_depth', { kind: 'health' })).toBe(0);
  });

  it('observes command latency once per settled command, from the poll after it started', async () => {
    await db.query(
      'ALTER TABLE commands ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT compute_now()',
    );
    const insert = (
      id: string,
      kind: string,
      state: string,
      createdMs: number,
      updatedMs: number,
    ) =>
      db.query(
        `INSERT INTO commands (id, node_id, seq, kind, body, state, retry_safe, self_terminating, attested,
                               idempotency_key, not_after, created_at, updated_at)
         VALUES ($1, 'node-a', $2, $3, '\\x00', $4, true, false, false, $1, $6::timestamptz + interval '1 hour',
                 $5::timestamptz, $6::timestamptz)`,
        [id, Number(id.slice(4)), kind, state, at(createdMs), at(updatedMs)],
      );
    // Settled before the collector's first poll: never observed.
    await insert('cmd-1', 'diag.nvml', 'succeeded', -10_000, -9_000);

    const registry = createMetrics();
    const collector = databaseCollector(standardMetrics(registry), {
      sql: db,
      laneOf: (kind) => (kind === 'diag.nvml' ? 'control' : undefined),
    });
    await setSimClock(db, T0 + 10_000);
    await collector.refresh();
    await insert('cmd-2', 'diag.nvml', 'succeeded', 10_000, 10_400);
    await insert('cmd-3', 'inventory.refresh', 'failed', 10_000, 12_000);
    await insert('cmd-4', 'diag.nvml', 'pending', 10_000, 10_000);
    await setSimClock(db, T0 + 20_000);
    await collector.refresh();
    await collector.refresh();

    const exposed = registry.expose();
    expect(exposed).toContain(
      'better_compute_command_latency_seconds_count{kind="diag.nvml",lane="control"} 1',
    );
    expect(exposed).toContain(
      'better_compute_command_latency_seconds_sum{kind="diag.nvml",lane="control"} 0.4',
    );
    expect(exposed).toContain(
      'better_compute_command_latency_seconds_count{kind="inventory.refresh",lane="(unknown)"} 1',
    );
    expect(registry.value('backlog', { queue: 'commands' })).toBe(1);
  });

  it('polls on a timer and reports failures without throwing', async () => {
    const errors: unknown[] = [];
    const collector = databaseCollector(standardMetrics(createMetrics()), {
      sql: { query: () => Promise.reject(new Error('database away')) },
      intervalMs: 5,
      onError: (error) => errors.push(error),
    });
    collector.start();
    collector.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    collector.stop();
    expect(errors.length).toBeGreaterThan(0);
    expect((errors[0] as Error).message).toBe('database away');
  });
});
