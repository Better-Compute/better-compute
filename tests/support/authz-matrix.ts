import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  ComputeError,
  manualClock,
  newId,
  type Credential,
  type SqlExecutor,
} from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute } from '@better-compute/server';
import { authzSamples, type MatrixIds } from './authz-samples.js';
import { fakeIam, type FakeIam } from './fake-iam.js';
import { ACME, OTHER, ROOT, options, spyExecutor, type SpyExecutor } from './server.js';

// The runner behind tests/generated/authz-matrix.test.ts (PLAN.md §9.2, §16 "the authz matrix is at
// 100%"). For every registered v0.1 method, one test checks, against a real server:
// 1. the declared action and resource are what IAM is asked (public methods ask nothing);
// 2. a caller from another tenant is refused before any IAM decision or database access;
// 3. list-recipe methods fail closed when the per-item batch fails.

/** One row of the generated matrix: a registered §9.2 method. */
export interface MatrixRow {
  group: string;
  method: string;
  kind: 'read' | 'mutation' | 'public';
  action: string | null;
  /** Every `(action, resource kind)` the row may decide on (its own and its "… or @ …"). */
  targets: readonly { action: string; resource: string }[];
  list: boolean;
}

const USER = 'token-matrix-acme-0123456789';
const OUTSIDER = 'token-matrix-other-0123456789';
const ADMIN = 'token-matrix-root-0123456789';
const START = Date.UTC(2026, 0, 1);
const decisionMethods = new Set(['authorize', 'require', 'authorizeMany']);

type Method = (credential?: Credential, input?: unknown) => Promise<unknown>;

async function seed(sql: SqlExecutor): Promise<MatrixIds> {
  const ids: MatrixIds = {
    tenant: ACME,
    root: ROOT,
    siteId: newId('site'),
    poolId: newId('pool'),
    nodeId: newId('node'),
    projectId: newId('prj'),
    reservationId: newId('rsv'),
  };
  const projection = (type: string, id: string) =>
    sql.query(
      "INSERT INTO authz_projection (type, id, tenant_id, attributes) VALUES ($1, $2, $3, '{}')",
      [type, id, ACME],
    );
  await sql.query(
    "INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, $2, 'custom', 'eu-west-1', 1)",
    [ids.siteId, ACME],
  );
  await sql.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ($1, $2, $3, 'metal-host', 'H100', 'exclusive', 'bcd', '{}', 1)`,
    [ids.poolId, ACME, ids.siteId],
  );
  await sql.query(
    `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
       cordoned, connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen,
       shard, version)
     VALUES ($1, $2, $3, $4, 'host', 'adopted', false, false, 'connected', 'tenant-owned', 1, 1, 1, 0, 0, 1)`,
    [ids.nodeId, ids.siteId, ids.poolId, ACME],
  );
  await sql.query('INSERT INTO node_sessions (node_id, session_epoch) VALUES ($1, 0)', [
    ids.nodeId,
  ]);
  await sql.query(
    "INSERT INTO projects (id, tenant_id, name, state, version) VALUES ($1, $2, 'seeded', 'active', 1)",
    [ids.projectId, ACME],
  );
  // An active reservation of the matrix user, for the reservation item methods and scope 'all'.
  await sql.query(
    `INSERT INTO reservations (id, tenant_id, pool_id, state, request, request_hash, during,
       owner_identity_id, idempotency_key, version)
     VALUES ($1, $2, $3, 'active', $4::jsonb, '\\x00',
       tstzrange(compute_now(), compute_now() + interval '1 hour'), 'id-matrix-user', 'seeded', 1)`,
    [
      ids.reservationId,
      ACME,
      ids.poolId,
      JSON.stringify({
        tenantId: ACME,
        poolId: ids.poolId,
        devices: [{ class: 'gpu', count: 1 }],
        duration: 3_600_000,
        binding: 'hold',
        idempotencyKey: 'seeded',
      }),
    ],
  );
  for (const [type, id] of [
    ['site', ids.siteId],
    ['pool', ids.poolId],
    ['node', ids.nodeId],
    ['project', ids.projectId],
    ['reservation', ids.reservationId],
  ] as const)
    await projection(type, id);
  return ids;
}

/** Declares one test per row, around one server on one PGlite store. */
export function authzMatrix(rows: readonly MatrixRow[]): void {
  let store: SqlExecutor;
  let spy: SpyExecutor;
  let iam: FakeIam;
  let ids: MatrixIds;
  let compute: ReturnType<typeof betterCompute>;

  beforeAll(async () => {
    store = pglite();
    spy = spyExecutor(store);
    iam = fakeIam();
    iam.addCaller(USER, {
      tenantId: ACME,
      identityId: 'id-matrix-user',
      sessionId: 'ses-matrix-user',
    });
    iam.addCaller(OUTSIDER, {
      tenantId: OTHER,
      identityId: 'id-matrix-other',
      sessionId: 'ses-matrix-other',
    });
    iam.addCaller(ADMIN, {
      tenantId: ROOT,
      identityId: 'id-matrix-root',
      sessionId: 'ses-matrix-root',
      mfa: true,
    });
    // IAM allows everything: every refusal checked here must be compute's own.
    iam.allow();
    compute = betterCompute({ ...options(spy, iam), clock: manualClock(START) });
    await compute.initialize();
    await useSimClock(store, START);
    ids = await seed(store);
  });
  afterAll(async () => {
    await compute?.stop().catch(() => undefined);
    await store?.close();
  });
  beforeEach(() => {
    iam.reset();
    spy.log.length = 0;
    compute.caches.clear();
  });

  const decisions = () => iam.calls.filter((call) => decisionMethods.has(call.method));

  for (const row of rows) {
    const path = `${row.group}.${row.method}`;
    const title =
      row.action === null
        ? `${path}: public, decided by nobody`
        : `${path}: ${row.targets.map((target) => `${target.action} @ compute-${target.resource}`).join(' or ')}${row.list ? ' + items' : ''}`;
    it(title, async () => {
      const sample = authzSamples[path];
      if (!sample)
        throw new Error(`No authz sample for ${path}; add one to tests/support/authz-samples.ts`);
      await sample.seed?.(store, ids);
      const input = sample.input(ids);
      const call = (compute.api as unknown as Record<string, Record<string, Method>>)[row.group]![
        row.method
      ]!;

      if (row.action === null) {
        await call(undefined, input);
        expect(iam.calls).toEqual([]);
        return;
      }

      // 1. The declared action and resource are what IAM is asked, in the expected tenant.
      await call({ token: sample.as === 'root' ? ADMIN : USER }, input).catch(() => undefined);
      const first = decisions()[0];
      expect(first, `${path} asked IAM nothing`).toBeDefined();
      expect(first!.method).toBe(row.kind === 'mutation' ? 'require' : 'authorize');
      const decided = {
        action: first!.decision!.action,
        resource: first!.decision!.resource.type.replace(/^compute-/, ''),
      };
      expect(row.targets).toContainEqual(decided);
      expect(first!.decision!.tenantId).toBe(
        decided.resource === 'fleet' ? ROOT : (input.tenantId as string),
      );

      // 2. A caller from another tenant is refused before IAM decides or the store is touched.
      iam.reset();
      spy.log.length = 0;
      const refused = await call({ token: OUTSIDER }, input).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(ComputeError);
      expect((refused as ComputeError).code).toBe('ACCESS_DENIED');
      expect(decisions()).toEqual([]);
      expect(spy.log).toEqual([]);

      // 3. The list recipe fails closed: a failed batch fails the request.
      if (row.list) {
        iam.reset();
        compute.caches.clear();
        const authorizeMany = iam.authorizeMany;
        iam.authorizeMany = async () => {
          throw new ComputeError('INTERNAL_ERROR', 'The IAM lane is unavailable');
        };
        try {
          await expect(call({ token: USER }, input)).rejects.toMatchObject({
            code: 'INTERNAL_ERROR',
            message: 'The IAM lane is unavailable',
          });
        } finally {
          iam.authorizeMany = authorizeMany;
        }
      }
    });
  }
}
