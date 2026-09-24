import {
  newId,
  shardOf,
  type ComputeModule,
  type ComputePlugin,
  type Notifier,
  type SqlTx,
} from '@better-compute/core';
import { betterCompute, type ComputeOptions } from '@better-compute/server';
import type { ComputeFixture } from '@better-compute/testing';

// Shared pieces of the server runtime tests (tests/server-runtime-*.test.ts).

export const SECRET = 'better-compute-runtime-tests-secret-0123456789';
export const BASE_URL = 'https://compute.example.test';

/**
 * Another control plane on a fixture's store and clock: a second worker process, or one with
 * options the fixture does not take (notifier, sinks, worker tuning).
 */
export async function sibling<M extends readonly ComputeModule[] = []>(
  fixture: ComputeFixture<any, any>,
  extra: Partial<ComputeOptions<M, readonly ComputePlugin[]>> = {},
) {
  const compute = betterCompute({
    database: fixture.database,
    iam: fixture.iam,
    secret: SECRET,
    baseURL: BASE_URL,
    rootTenantId: fixture.tenants.root.id,
    clock: fixture.clock,
    ...extra,
  } as ComputeOptions<M, []>);
  await compute.initialize();
  return compute;
}

export interface SeededNode {
  id: string;
  siteId: string;
  tenantId: string;
  shard: number;
}

/** A site (once), a node with `next_cmd_seq = 1`, and its session row on `gatewayId` (if any). */
export async function seedNode(
  sql: SqlTx,
  options: { tenantId: string; id?: string; siteId?: string; gatewayId?: string },
): Promise<SeededNode> {
  const id = options.id ?? newId('node');
  const siteId = options.siteId ?? 'site_test';
  await sql.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version)
     VALUES ($1, $2, 'shared', 'eu-1', 1) ON CONFLICT (id) DO NOTHING`,
    [siteId, options.tenantId],
  );
  await sql.query(
    `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
       connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ($1, $2, $3, 'host', 'adopted', false, false, 'connected', 'platform', 0, 0, 1, 0, $4, 1)`,
    [id, siteId, options.tenantId, shardOf(id)],
  );
  await sql.query(
    `INSERT INTO node_sessions (node_id, gateway_id, session_epoch) VALUES ($1, $2, 1)`,
    [id, options.gatewayId ?? null],
  );
  return { id, siteId, tenantId: options.tenantId, shard: shardOf(id) };
}

/** A notifier that records what was published, in order. */
export function recordingNotifier(): Notifier & {
  published: { channel: string; message?: string }[];
} {
  const published: { channel: string; message?: string }[] = [];
  return {
    published,
    async publish(channel, message) {
      published.push({ channel, ...(message === undefined ? {} : { message }) });
    },
    async subscribe() {
      return async () => {};
    },
  };
}

/** Rows of a work kind, oldest first. */
export async function workRows(sql: SqlTx, kind: string) {
  return (
    await sql.query<{
      key: string;
      shard: number;
      gen: number;
      not_before: Date;
      claimed_until: Date | null;
    }>(
      `SELECT key, shard, gen, not_before, claimed_until FROM work_queue WHERE kind = $1
        ORDER BY not_before, key`,
      [kind],
    )
  ).rows;
}
