import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import type { SqlExecutor, WorkQueue } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import {
  AllocationBoundSchema,
  AllocationFailedSchema,
  AllocationReleasedSchema,
} from '@better-compute/protocol';
import { gatewayReportHandlers } from '@better-compute/server';

// The server's gateway report handlers (§3.4 step 9, §10.5): a node reports only its own
// allocations. Node A's session can neither bind, release nor fail an allocation on node B.

const NODE_A = 'node_01k5w00000000000000000rpta';
const NODE_B = 'node_01k5w00000000000000000rptb';
let db: SqlExecutor;
const woken: string[] = [];
const work = {
  enqueue: async (_tx: unknown, kind: string, key: string) => {
    woken.push(`${kind}:${key}`);
  },
} as unknown as WorkQueue;

beforeAll(async () => {
  db = pglite();
  await db.migrate([]);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_r', 'root', 'shared', 'eu', 1)`,
  );
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ('pool_r', 'root', 'site_r', 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
  );
  for (const id of [NODE_A, NODE_B])
    await db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
         cordoned, connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen,
         shard, version)
       VALUES ($1, 'site_r', 'pool_r', 'root', 'host', 'adopted', false, false, 'connected',
         'platform', 1, 1, 1, 1, 0, 1)`,
      [id],
    );
  for (const id of ['alloc_b1', 'alloc_b2', 'alloc_b3'])
    await db.query(
      `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, during, version)
       VALUES ($1, 'acme', 'pool_r', $2, 'reservation', 'rsv_x', tstzrange(compute_now(), NULL), 1)`,
      [id, NODE_B],
    );
});
afterAll(async () => {
  await db.close();
});

async function allocation(id: string) {
  const { rows } = await db.query<{ bound: boolean; released: boolean; binding: unknown }>(
    `SELECT bound_at IS NOT NULL AS bound, released_at IS NOT NULL AS released, binding
       FROM allocations WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

describe('gateway report handlers', () => {
  it('ignore reports about another node’s allocations', async () => {
    const as = (nodeId: string) => ({ nodeId, work });
    const bound = create(AllocationBoundSchema, {
      allocationId: 'alloc_b1',
      cdiDevices: ['bcd.dev/gpu=GPU-forged'],
    });
    expect(
      await db.transaction((tx) => gatewayReportHandlers.allocationBound(tx, as(NODE_A), bound)),
    ).toBe(false);
    expect(await allocation('alloc_b1')).toMatchObject({ bound: false, binding: null });
    expect(
      await db.transaction((tx) =>
        gatewayReportHandlers.allocationReleased(
          tx,
          as(NODE_A),
          create(AllocationReleasedSchema, { allocationId: 'alloc_b2' }),
        ),
      ),
    ).toBe(false);
    expect(
      await db.transaction((tx) =>
        gatewayReportHandlers.allocationFailed(
          tx,
          as(NODE_A),
          create(AllocationFailedSchema, { allocationId: 'alloc_b3', reason: 'forged' }),
        ),
      ),
    ).toBe(false);
    expect(woken).toEqual([]);

    // The node the allocation is on binds it.
    expect(
      await db.transaction((tx) => gatewayReportHandlers.allocationBound(tx, as(NODE_B), bound)),
    ).toBe(true);
    expect(await allocation('alloc_b1')).toMatchObject({
      bound: true,
      binding: { cdiDevices: ['bcd.dev/gpu=GPU-forged'] },
    });
    expect(woken.length).toBeGreaterThan(0);
  });
});
