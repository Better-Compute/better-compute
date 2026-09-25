import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  manualClock,
  type AuthzRow,
  type Caller,
  type ManualClock,
  type MethodContext,
  type ModuleContext,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { capacityMigrations, capacityModule, type CapacityApi } from '@better-compute/capacity';
import {
  applyBudgetPolicy,
  reassignReservations,
  withdrawAgentReservations,
} from '../packages/capacity/src/iam-reactions.js';

// Reservations' reactions to IAM events (PLAN.md §12.7-12.8): an agent withdrawn cancels what it reserved and
// has not started; an offboarded owner's reservations move to the successor (or the unstarted ones are
// cancelled); a spent budget applies the offers' onBudgetExceeded. All in one transaction, all replay-safe.

const T0 = Date.UTC(2026, 8, 24, 12);
let db: SqlExecutor;
let clock: ManualClock;
let recorded: { authz: AuthzRow[]; events: { type: string; subject: string; data: unknown }[] };

beforeAll(async () => {
  db = pglite();
  await db.migrate([...capacityMigrations]);
});
afterAll(async () => {
  await db.close();
});

function moduleContext(sql: SqlExecutor): ModuleContext {
  return {
    sql,
    clock,
    authz: {
      async upsert(_tx: SqlTx, row: AuthzRow) {
        recorded.authz.push(row);
      },
      async remove() {},
      async setPending() {},
    },
    events: {
      async publish(_tx: SqlTx, event: { type: string; subject: string; data: unknown }) {
        recorded.events.push({ type: event.type, subject: event.subject, data: event.data });
      },
    },
    work: { async enqueue() {} },
    desired: { async invalidate() {} },
  } as unknown as ModuleContext;
}

function within(tx: SqlTx): SqlExecutor {
  return {
    dialect: 'postgres',
    kind: 'pglite',
    query: (text, params) => tx.query(text, params),
    transaction: (fn, options) => db.transaction(fn, options),
    migrate: () => Promise.reject(new Error('no')),
    close: () => Promise.reject(new Error('no')),
  };
}

const module = capacityModule({ random: () => 0, topN: 1 });
const api = module.api!(moduleContext(db)) as CapacityApi;
const person = (identityId: string, extra: Partial<Caller> = {}): Caller => ({
  identityId,
  identityKind: 'user',
  tenantId: 'acme',
  sessionId: `ses_${identityId}`,
  sessionKind: 'user',
  mfa: false,
  ...extra,
});
const root = person('usr_root', { tenantId: 'root' });

async function call(group: keyof CapacityApi, method: string, raw: unknown, who: Caller) {
  const definition = (api[group] as Record<string, unknown>)[method] as {
    validate(raw: unknown): unknown;
    handler(context: MethodContext, input: unknown): Promise<unknown>;
    admission?: {
      prepare(context: MethodContext, input: unknown, tx: SqlTx): Promise<{ status: string }>;
    };
  };
  const input = definition.validate(raw);
  const context = (tx: SqlTx) =>
    ({ ...moduleContext(within(tx)), caller: who, requestId: 'req_1' }) as MethodContext;
  if (definition.admission)
    await db.transaction((tx) => definition.admission!.prepare(context(tx), input, tx));
  return db.transaction((tx) => definition.handler(context(tx), input));
}

let poolId: string;
let keys = 0;
beforeEach(async () => {
  for (const table of [
    'usage_windows',
    'capacity_device_links',
    'pool_capacity_rollup',
    'device_bookings',
    'allocations',
    'reservations',
    'node_resources',
    'devices',
    'quota_usage',
    'nodes',
    'pool_offers',
    'pools',
    'sites',
  ])
    await db.query(`DELETE FROM ${table}`);
  recorded = { authz: [], events: [] };
  clock = manualClock(T0);
  await useSimClock(db, T0);
  await setSimClock(db, T0);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_01jz00000000000000000000aa', 'root', 'shared', 'eu-central', 1)`,
  );
  poolId = (
    (await call(
      'pools',
      'create',
      {
        tenantId: 'root',
        siteId: 'site_01jz00000000000000000000aa',
        class: 'metal-host',
        gpuModel: 'H100',
      },
      root,
    )) as { id: string }
  ).id;
  await call(
    'pools',
    'offer',
    { tenantId: 'root', poolId, toTenantId: 'acme', quota: { gpu: 16 } },
    root,
  );
  for (const node of ['na', 'nb']) {
    const id = `node_01jz00000000000000000000${node}`;
    await db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance,
                          cordoned, connectivity, trust, generation, observed_generation, next_cmd_seq,
                          identity_gen, shard, version)
       VALUES ($1, 'site_01jz00000000000000000000aa', $2, 'root', 'host', 'adopted', false, false,
               'connected', 'platform', 1, 1, 1, 1, 0, 1)`,
      [id, poolId],
    );
    for (let index = 0; index < 4; index++)
      await db.query(
        `INSERT INTO devices (id, node_id, class, bookable, healthy, attributes)
         VALUES ($1, $2, 'gpu', true, true, '{"gpuModel":"H100","vramGiB":80}')`,
        [`GPU-${node}-${index}`, id],
      );
  }
  recorded = { authz: [], events: [] };
});

const reserve = async (who: Caller, gpus = 2) =>
  (await call(
    'reservations',
    'create',
    {
      tenantId: 'acme',
      poolId,
      devices: [{ class: 'gpu', count: gpus }],
      duration: '2h',
      idempotencyKey: `k-${++keys}`,
    },
    who,
  )) as { id: string; state: string };

const states = async () => {
  const { rows } = await db.query<{ id: string; state: string; owner_identity_id: string }>(
    'SELECT id, state, owner_identity_id FROM reservations ORDER BY id',
  );
  return new Map(rows.map((row) => [row.id, row]));
};
const used = async () =>
  Number(
    (
      await db.query<{ used: number }>(
        `SELECT coalesce(sum(used), 0)::int AS used FROM quota_usage WHERE tenant_id = 'acme'`,
      )
    ).rows[0]!.used,
  );
const deps = () => moduleContext(db);
const tx = <T>(fn: (tx: SqlTx) => Promise<T>) => db.transaction(fn);

describe('withdrawAgentReservations', () => {
  it('cancels what a revoked delegation or suspended agent reserved and has not started, once', async () => {
    const viaD1 = await reserve(
      person('usr_alice', { sessionKind: 'delegated', agentId: 'agt_1', delegationId: 'dlg_1' }),
    );
    const viaD2 = await reserve(
      person('usr_alice', { sessionKind: 'delegated', agentId: 'agt_1', delegationId: 'dlg_2' }),
    );
    const otherAgent = await reserve(
      person('usr_alice', { sessionKind: 'delegated', agentId: 'agt_2', delegationId: 'dlg_3' }),
    );
    const hers = await reserve(person('usr_alice'));
    expect([viaD1, viaD2, otherAgent, hers].map((r) => r.state)).toEqual([
      'placed',
      'placed',
      'placed',
      'placed',
    ]);
    expect(await used()).toBe(8);

    const revoked = await tx((t) =>
      withdrawAgentReservations(t, deps(), {
        tenantId: 'acme',
        delegationId: 'dlg_1',
        agentId: 'agt_1',
        reason: 'delegation revoked',
      }),
    );
    expect(revoked.cancelled).toEqual([viaD1.id]);
    expect((await states()).get(viaD1.id)!.state).toBe('cancelled');
    expect(await used()).toBe(6);
    expect(recorded.events).toContainEqual(
      expect.objectContaining({
        type: 'reservation.cancelled',
        data: expect.objectContaining({ reason: 'delegation revoked' }),
      }),
    );

    // Replayed: nothing more.
    expect(
      (
        await tx((t) =>
          withdrawAgentReservations(t, deps(), {
            tenantId: 'acme',
            delegationId: 'dlg_1',
            reason: 'again',
          }),
        )
      ).cancelled,
    ).toEqual([]);
    // The agent itself suspended: its other delegation's reservation goes; agt_2's and alice's own stay.
    expect(
      (
        await tx((t) =>
          withdrawAgentReservations(t, deps(), {
            tenantId: 'acme',
            agentId: 'agt_1',
            reason: 'suspended',
          }),
        )
      ).cancelled,
    ).toEqual([viaD2.id]);
    // Every agent of the tenant.
    expect(
      (
        await tx((t) =>
          withdrawAgentReservations(t, deps(), {
            tenantId: 'acme',
            allAgents: true,
            reason: 'incident',
          }),
        )
      ).cancelled,
    ).toEqual([otherAgent.id]);
    expect((await states()).get(hers.id)!.state).toBe('placed');
    // Another tenant's filter, or one naming nothing, touches nothing.
    expect(
      (
        await tx((t) =>
          withdrawAgentReservations(t, deps(), { tenantId: 'other', allAgents: true, reason: 'x' }),
        )
      ).cancelled,
    ).toEqual([]);
    expect(
      (await tx((t) => withdrawAgentReservations(t, deps(), { tenantId: 'acme', reason: 'x' })))
        .cancelled,
    ).toEqual([]);
  });
});

describe('reassignReservations', () => {
  it('moves an offboarded owner’s live reservations to the successor, with the authz row', async () => {
    const first = await reserve(person('usr_bob'));
    const second = await reserve(person('usr_bob'));
    const alices = await reserve(person('usr_alice'));
    const result = await tx((t) =>
      reassignReservations(t, deps(), {
        tenantId: 'acme',
        identityId: 'usr_bob',
        successorId: 'usr_carol',
        reason: 'offboarded',
      }),
    );
    expect(result.reassigned.sort()).toEqual([first.id, second.id].sort());
    const now = await states();
    expect(now.get(first.id)).toMatchObject({ state: 'placed', owner_identity_id: 'usr_carol' });
    expect(now.get(alices.id)!.owner_identity_id).toBe('usr_alice');
    expect(recorded.authz.map((row) => [row.id, row.ownerId, row.parentId])).toEqual(
      expect.arrayContaining([
        [first.id, 'usr_carol', poolId],
        [second.id, 'usr_carol', poolId],
      ]),
    );
    expect(recorded.authz[0]!.attributes).toMatchObject({ gpuModel: 'H100', gpuCount: 2 });
    expect(recorded.events.filter((e) => e.type === 'reservation.reassigned')).toHaveLength(2);
    expect(await used()).toBe(6);
    // Replayed: bob owns nothing any more.
    expect(
      (
        await tx((t) =>
          reassignReservations(t, deps(), {
            tenantId: 'acme',
            identityId: 'usr_bob',
            successorId: 'usr_carol',
            reason: 'again',
          }),
        )
      ).reassigned,
    ).toEqual([]);
  });

  it('without a successor, cancels the unstarted ones', async () => {
    const hers = await reserve(person('usr_dora'));
    const result = await tx((t) =>
      reassignReservations(t, deps(), {
        tenantId: 'acme',
        identityId: 'usr_dora',
        reason: 'deleted',
      }),
    );
    expect(result).toEqual({ cancelled: [hers.id], reassigned: [] });
    expect(await used()).toBe(0);
  });
});

describe('applyBudgetPolicy', () => {
  it('notify publishes; drain also cancels the tenant’s unstarted reservations in the pool', async () => {
    const one = await reserve(person('usr_alice'));
    const two = await reserve(person('usr_bob'));
    const alert = {
      tenantId: 'acme',
      budgetId: 'bud_1',
      name: 'GPU monthly',
      exceeded: true,
      spentMicros: 21,
      amountMicros: 20,
    };

    // No policy on the offer: nothing happens.
    expect(await tx((t) => applyBudgetPolicy(t, deps(), alert))).toEqual({
      cancelled: [],
      reassigned: [],
      pools: [],
    });

    await db.query(`UPDATE pool_offers SET on_budget_exceeded = 'notify' WHERE tenant_id = 'acme'`);
    const notified = await tx((t) => applyBudgetPolicy(t, deps(), alert));
    expect(notified).toEqual({
      cancelled: [],
      reassigned: [],
      pools: [{ poolId, policy: 'notify' }],
    });
    expect(recorded.events.filter((e) => e.type === 'quota.budget-exceeded')).toEqual([
      {
        type: 'quota.budget-exceeded',
        subject: `pool/${poolId}`,
        data: { poolId, budgetId: 'bud_1', policy: 'notify', spentMicros: 21, amountMicros: 20 },
      },
    ]);
    // Below 100 %: nothing.
    expect(
      (await tx((t) => applyBudgetPolicy(t, deps(), { ...alert, exceeded: false }))).pools,
    ).toEqual([]);

    await db.query(`UPDATE pool_offers SET on_budget_exceeded = 'drain' WHERE tenant_id = 'acme'`);
    const drained = await tx((t) => applyBudgetPolicy(t, deps(), alert));
    expect(drained.cancelled.sort()).toEqual([one.id, two.id].sort());
    expect(await used()).toBe(0);
    expect(recorded.events).toContainEqual(
      expect.objectContaining({
        type: 'reservation.cancelled',
        data: expect.objectContaining({ reason: 'budget GPU monthly exceeded' }),
      }),
    );
    // Replayed: nothing more to cancel.
    expect((await tx((t) => applyBudgetPolicy(t, deps(), alert))).cancelled).toEqual([]);
  });
});
