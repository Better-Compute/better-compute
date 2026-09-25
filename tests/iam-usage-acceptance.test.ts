import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { IamPort, SqlExecutor } from '@better-compute/core';
import {
  createComputeIamBridge,
  flushUsageWindows,
  rememberSuccessor,
  successorsMigration,
} from '@better-compute/iam';
import { pglite } from '@better-compute/postgres/pglite';
import { closeIamFixtures, iamFixture } from './support/iam.js';

// PLAN.md §16 v0.1 acceptance: "gpu.h100.hours shows in iam.billing.spend without duplicates across worker
// restarts, even with a deleted identity in a batch". Usage windows are flushed through the embedded IamPort
// into a real better-iam; the worker dies after IAM recorded a batch but before compute marked it, flushes again
// after the restart, and better-iam's own spend report counts every GPU-hour once.

let db: SqlExecutor;

beforeAll(async () => {
  db = pglite();
  await db.migrate([successorsMigration]);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site-1', 'ten_root', 'shared', 'eu-west-1', 1)`,
  );
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ('pool-1', 'ten_root', 'site-1', 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
  );
  await db.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
                        connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ('node-1', 'site-1', 'pool-1', 'ten_root', 'host', 'adopted', false, false, 'connected', 'platform',
             1, 1, 1, 1, 0, 1)`,
  );
});
afterAll(async () => {
  await db.close();
});
afterEach(closeIamFixtures);

describe('usage into better-iam billing', () => {
  it('counts every GPU-hour once across a worker restart, with a deleted identity in the batch', async () => {
    const bridge = createComputeIamBridge();
    const plugin = bridge.plugin();
    const f = await iamFixture({ plugins: [plugin], resolveResource: bridge.resolveResource() });
    const port = bridge.embedded(f.iam, { rootTenantId: f.rootTenantId });
    const [module] = bridge.modules;
    await module.start!({ sql: db } as never);
    try {
      await f.iam.api.billing.createMeter(f.rootCredential, {
        tenantId: f.rootTenantId,
        key: 'gpu.h100.hours',
        name: 'H100 hours',
        unit: 'hour',
      });
      const alice = await f.member('alice');
      const bob = await f.member('bob');
      const tenant = f.tenantId;

      // Two allocations billed hourly: alice 8 GPUs for 3 h, bob 4 GPUs for 2 h.
      for (const [allocation, owner] of [
        ['alloc-a', alice.id],
        ['alloc-b', bob.id],
      ] as const)
        await db.query(
          `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, during, version)
           VALUES ($1, $2, 'pool-1', 'node-1', 'reservation', $3,
                   tstzrange(compute_now() - interval '5 hours', compute_now() - interval '1 hour'), 1)`,
          [allocation, tenant, `rsv-${owner}`],
        );
      const window = (allocation: string, identityId: string, hour: number, quantity: number) =>
        db.query(
          `INSERT INTO usage_windows (idempotency_key, allocation_id, tenant_id, identity_id, meter, quantity,
                                      window_start, window_end, tags)
           VALUES ($1, $2, $3, $4, 'gpu.h100.hours', $5,
                   compute_now() - make_interval(hours => $6 + 1), compute_now() - make_interval(hours => $6),
                   '{"pool":"pool-1"}')`,
          [`cmp:${allocation}:${hour}`, allocation, tenant, identityId, quantity, hour],
        );
      for (const hour of [4, 3, 2]) await window('alloc-a', alice.id, hour, 8);
      for (const hour of [4, 3]) await window('alloc-b', bob.id, hour, 4);

      // bob leaves before the flush; his usage belongs to alice (§12.7).
      await f.iam.api.identities.offboard(f.ownerCredential, {
        tenantId: tenant,
        identityId: bob.id,
        reason: 'left',
        successorId: alice.id,
      });
      await rememberSuccessor(db, tenant, bob.id, alice.id);
      await f.iam.api.identities.delete(f.ownerCredential, {
        tenantId: tenant,
        identityId: bob.id,
      });

      // The worker dies right after IAM recorded the batch, before compute marked it.
      const dying: Pick<IamPort, 'recordUsage'> = {
        async recordUsage(events) {
          await port.recordUsage(events);
          throw new Error('worker killed');
        },
      };
      await expect(flushUsageWindows(db, dying)).rejects.toThrow('worker killed');
      const unrecorded = await db.query('SELECT 1 FROM usage_windows WHERE recorded_at IS NULL');
      expect(unrecorded.rows).toHaveLength(5);

      // The restarted worker sends the same windows again: IAM keeps one of each.
      expect(await flushUsageWindows(db, port)).toEqual({ sent: 5, deadLettered: 0, more: false });
      expect(await flushUsageWindows(db, port)).toEqual({ sent: 0, deadLettered: 0, more: false });
      const { rows } = await db.query<{ outcome: string; count: number }>(
        `SELECT outcome, count(*)::int AS count FROM usage_windows GROUP BY outcome ORDER BY outcome`,
      );
      // IAM recognised every window from the first attempt (its reattribution of bob's two happened then).
      expect(Object.fromEntries(rows.map((row) => [row.outcome, Number(row.count)]))).toEqual({
        duplicate: 5,
      });

      // better-iam's own report: 3 × 8 + 2 × 4 = 32 GPU-hours, all alice's, each event once.
      const byMeter = await f.iam.api.billing.spend(f.rootCredential, {
        tenantId: tenant,
        groupBy: 'meter',
      });
      expect(byMeter.total.events).toBe(5);
      expect(byMeter.rows).toEqual([
        expect.objectContaining({
          key: 'gpu.h100.hours',
          events: 5,
          quantities: { 'gpu.h100.hours': 32 },
        }),
      ]);
      const byIdentity = await f.iam.api.billing.spend(f.rootCredential, {
        tenantId: tenant,
        groupBy: 'identity',
      });
      expect(byIdentity.rows.map((row) => [row.key, row.quantities['gpu.h100.hours']])).toEqual([
        [alice.id, 32],
      ]);
    } finally {
      await module.stop!();
    }
  }, 60_000);
});
