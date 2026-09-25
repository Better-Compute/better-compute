import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ComputeError,
  draftId,
  manualClock,
  type AdmissionContext,
  type Decision,
} from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute, type BetterCompute } from '@better-compute/server';
import { fleetKey, fleetModule, type FleetConfig } from '@better-compute/fleet';
import { fakeIam, type FakeIam } from './support/fake-iam.js';
import { ACME, ROOT, options } from './support/server.js';
import { countingExecutor, START, type CountingExecutor } from './support/server-api.js';

// fleet.apply through the real envelope (PLAN.md §9.2 `fleet`, core `MethodContext.check/invoke`):
// the fleet module plus the built-in capacity module on PGlite. Phase 1 decides sites.create,
// pools.create and pools.offer for the caller with no transaction open (the two creates are
// replay-only admissions); phase 2 re-plans and runs them in one transaction, each with its own
// audit row. A second apply is a no-op; a plan that moved is CONFIG_DRIFT.

const ADMIN = 'token-fleet-admin-0123456789';
const USER = 'token-fleet-user-0123456789';

let store: ReturnType<typeof pglite>;
let database: CountingExecutor;
let iam: FakeIam;
let compute: BetterCompute<[ReturnType<typeof fleetModule>]>;
/** IAM methods called while a compute transaction was open: must stay empty. */
const insideTransaction: string[] = [];
/** Runs before each `require`, outside every transaction (a concurrent writer between phases). */
let beforeRequire: ((decision: Decision) => Promise<void>) | undefined;

beforeAll(async () => {
  store = pglite();
  database = countingExecutor(store);
  iam = fakeIam();
  iam.addCaller(ADMIN, {
    tenantId: ROOT,
    identityId: 'id-admin',
    sessionId: 'ses-admin',
    mfa: true,
  });
  iam.addCaller(USER, { tenantId: ACME, identityId: 'id-user', sessionId: 'ses-user' });
  iam.allow({ token: ADMIN });
  iam.allow({ token: USER });
  for (const method of ['authenticate', 'require', 'authorize', 'authorizeMany'] as const) {
    const original = iam[method] as (...args: unknown[]) => Promise<unknown>;
    (iam as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      if (database.openTransactions() > 0) insideTransaction.push(method);
      if (method === 'require') await beforeRequire?.(args[1] as Decision);
      return original(...args);
    };
  }
  compute = betterCompute({
    ...options(database, iam),
    clock: manualClock(START),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    modules: [fleetModule()],
  });
  await compute.initialize();
  await useSimClock(store, START);
});
afterAll(async () => {
  await compute.stop();
  await store.close();
});
beforeEach(() => {
  iam.reset();
  compute.caches.clear();
  insideTransaction.length = 0;
  beforeRequire = undefined;
});

const apply = (config: FleetConfig, extra: { planHash?: string } = {}, token = ADMIN) =>
  compute.api.fleet.apply({ token }, { tenantId: ROOT, config, ...extra });
const plan = (config: FleetConfig) =>
  compute.api.fleet.plan({ token: ADMIN }, { tenantId: ROOT, config });
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: unknown) => (error instanceof ComputeError ? error.code : String(error)),
  );
const requires = () =>
  iam.calls
    .filter((call) => call.method === 'require')
    .map(
      (call) =>
        `${call.decision!.action} ${call.decision!.tenantId} ${call.decision!.resource.type}/${call.decision!.resource.id}`,
    );
const auditSince = async (seq: number) =>
  (
    await store.query<{
      seq: string;
      action: string;
      txid_text: string;
      admission: AdmissionContext;
    }>(
      `SELECT seq::text AS seq, action, txid::text AS txid_text, admission FROM audit_events
       WHERE seq > $1 ORDER BY seq`,
      [seq],
    )
  ).rows;
const lastAudit = async () =>
  Number(
    (
      await store.query<{ seq: string }>(
        'SELECT coalesce(max(seq), 0)::text AS seq FROM audit_events',
      )
    ).rows[0]!.seq,
  );
const idOf = (kind: 'site' | 'pool', name: string) =>
  draftId(kind, ROOT, 'id-admin', fleetKey(ROOT, kind, name));
const site = (name: string): NonNullable<FleetConfig['sites']>[number] => ({
  name,
  kind: 'shared',
  region: 'eu-central',
});

describe('fleet.apply through check/invoke', () => {
  it('creates a site, a pool and an offer, each decided for the caller, in one transaction', async () => {
    const before = await lastAudit();
    const config: FleetConfig = {
      version: 1,
      sites: [site('fra')],
      pools: [
        {
          name: 'gpu-fra',
          site: 'fra',
          class: 'metal-host',
          gpuModel: 'H100',
          policy: { maxDuration: 'P7D' },
          offers: [{ tenant: ACME, quota: { gpu: 2 } }],
        },
      ],
    };
    const result = await apply(config);
    expect(result.applied).toBe(3);
    expect(result.plan.calls.map((call) => call.path)).toEqual([
      'sites/create',
      'pools/create',
      'pools/offer',
    ]);

    const siteId = await idOf('site', 'fra');
    const poolId = await idOf('pool', 'gpu-fra');
    // The composite's decision, then one per sub-call, none inside a transaction.
    expect(requires()).toEqual([
      `compute:fleet:admin ${ROOT} compute-fleet/global`,
      `compute:sites:manage ${ROOT} compute-fleet/global`,
      `compute:pools:create ${ROOT} compute-tenant/${ROOT}`,
      `compute:pools:share ${ROOT} compute-pool/${poolId}`,
    ]);
    expect(insideTransaction).toEqual([]);

    const sites = await store.query('SELECT owner_tenant_id, kind FROM sites WHERE id = $1', [
      siteId,
    ]);
    expect(sites.rows).toEqual([{ owner_tenant_id: ROOT, kind: 'shared' }]);
    const pools = await store.query('SELECT site_id, gpu_model FROM pools WHERE id = $1', [poolId]);
    expect(pools.rows).toEqual([{ site_id: siteId, gpu_model: 'H100' }]);
    const offers = await store.query('SELECT tenant_id FROM pool_offers WHERE pool_id = $1', [
      poolId,
    ]);
    expect(offers.rows).toEqual([{ tenant_id: ACME }]);
    const visible = await store.query<{ type: string; tenant_id: string }>(
      `SELECT type, tenant_id FROM authz_projection WHERE id IN ($1, $2) ORDER BY type, tenant_id`,
      [siteId, poolId],
    );
    expect(visible.rows).toEqual([
      { type: 'pool', tenant_id: ACME },
      { type: 'pool', tenant_id: ROOT },
      { type: 'site', tenant_id: ROOT },
    ]);
    const names = await store.query<{ kind: string; name: string; object_id: string }>(
      `SELECT kind, name, object_id FROM fleet_names WHERE name IN ('fra', 'gpu-fra') ORDER BY kind`,
    );
    expect(names.rows).toEqual([
      { kind: 'pool', name: 'gpu-fra', object_id: poolId },
      { kind: 'site', name: 'fra', object_id: siteId },
    ]);

    // Sub-call audit rows in the apply transaction, as the caller; fleet.apply's own after it.
    const rows = await auditSince(before);
    expect(rows.map((row) => row.action)).toEqual([
      'compute:sites:manage',
      'compute:pools:create',
      'compute:pools:share',
      'compute:fleet:admin',
    ]);
    for (const row of rows) expect(row.admission).toMatchObject({ identityId: 'id-admin' });
    expect(rows[1]!.admission.resource).toEqual({ type: 'compute-tenant', id: ROOT });
    expect(new Set(rows.slice(0, 3).map((row) => row.txid_text)).size).toBe(1);
    expect(rows[3]!.txid_text).not.toBe(rows[0]!.txid_text);

    // The same document again: nothing to do, no sub-call decisions, only fleet.apply's own row.
    iam.reset();
    const mark = await lastAudit();
    const again = await apply(config);
    expect(again.applied).toBe(0);
    expect(again.plan.calls).toEqual([]);
    expect(requires()).toEqual([`compute:fleet:admin ${ROOT} compute-fleet/global`]);
    expect((await auditSince(mark)).map((row) => row.action)).toEqual(['compute:fleet:admin']);
    expect((await store.query('SELECT 1 FROM pools WHERE id = $1', [poolId])).rows).toHaveLength(1);
    expect(insideTransaction).toEqual([]);
  });

  it('refuses a reviewed plan that no longer matches with CONFIG_DRIFT', async () => {
    const config: FleetConfig = {
      version: 1,
      sites: [site('ams')],
      pools: [{ name: 'gpu-ams', site: 'ams', class: 'metal-host' }],
    };
    const reviewed = await plan(config);
    expect(reviewed.calls.map((call) => call.path)).toEqual(['sites/create', 'pools/create']);
    expect((await apply(config, { planHash: reviewed.planHash })).applied).toBe(2);

    // Applied since: the reviewed plan is stale, and the refusal comes before any sub-call decision.
    iam.reset();
    const mark = await lastAudit();
    expect(await codeOf(apply(config, { planHash: reviewed.planHash }))).toBe('CONFIG_DRIFT');
    expect(requires()).toEqual([`compute:fleet:admin ${ROOT} compute-fleet/global`]);
    expect(await auditSince(mark)).toEqual([]);
  });

  it('applies nothing when the fleet moves between the phases (CONFIG_DRIFT)', async () => {
    const base: FleetConfig = {
      version: 1,
      sites: [site('waw')],
      pools: [
        { name: 'gpu-waw', site: 'waw', class: 'metal-host', policy: { maxDuration: 'P7D' } },
      ],
    };
    await apply(base);
    const gpuWaw = await idOf('pool', 'gpu-waw');
    const next: FleetConfig = {
      ...base,
      pools: [
        { ...base.pools![0]!, offers: [{ tenant: ACME, quota: { gpu: 1 } }] },
        { name: 'cpu-waw', site: 'waw', class: 'metal-host' },
      ],
    };
    // Someone edits gpu-waw while phase 1 is deciding the new pool.
    beforeRequire = async (decision) => {
      if (decision.action === 'compute:pools:create')
        await store.query(
          `UPDATE pools SET policy = '{"maxDuration":"P1D"}'::jsonb WHERE id = $1`,
          [gpuWaw],
        );
    };
    iam.reset();
    const mark = await lastAudit();
    expect(await codeOf(apply(next))).toBe('CONFIG_DRIFT');
    // Every call was decided first; then the re-plan inside the transaction saw the change.
    expect(requires()).toEqual([
      `compute:fleet:admin ${ROOT} compute-fleet/global`,
      `compute:pools:create ${ROOT} compute-tenant/${ROOT}`,
      `compute:pools:share ${ROOT} compute-pool/${gpuWaw}`,
    ]);
    expect(await auditSince(mark)).toEqual([]);
    const cpuWaw = await idOf('pool', 'cpu-waw');
    expect((await store.query('SELECT 1 FROM pools WHERE id = $1', [cpuWaw])).rows).toEqual([]);
    expect(
      (await store.query('SELECT 1 FROM pool_offers WHERE pool_id = $1', [gpuWaw])).rows,
    ).toEqual([]);
    expect(insideTransaction).toEqual([]);
  });

  it('writes nothing when IAM refuses one sub-call', async () => {
    const limited = 'token-fleet-limited-0123456789';
    iam.addCaller(limited, { tenantId: ROOT, identityId: 'id-limited' });
    iam.allow({ token: limited });
    iam.deny({ token: limited, action: 'compute:pools:share' });
    const config: FleetConfig = {
      version: 1,
      sites: [site('lis')],
      pools: [
        {
          name: 'gpu-lis',
          site: 'lis',
          class: 'metal-host',
          offers: [{ tenant: ACME, quota: { gpu: 1 } }],
        },
      ],
    };
    const mark = await lastAudit();
    expect(await codeOf(apply(config, {}, limited))).toBe('ACCESS_DENIED');
    const siteId = await draftId('site', ROOT, 'id-limited', fleetKey(ROOT, 'site', 'lis'));
    expect((await store.query('SELECT 1 FROM sites WHERE id = $1', [siteId])).rows).toEqual([]);
    expect(await auditSince(mark)).toEqual([]);
  });

  it('is decided in the root tenant: a tenant caller is refused before any read', async () => {
    const config: FleetConfig = { version: 1, sites: [site('nyc')] };
    expect(await codeOf(apply(config, {}, USER))).toBe('ACCESS_DENIED');
    expect(iam.calls.map((call) => call.method)).toEqual(['authenticate']);
  });
});
