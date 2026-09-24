import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IamPort, SqlExecutor, UsageEvent, UsageResult } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import {
  createComputeIamBridge,
  createFlagCache,
  drainIamInbox,
  flushUsageWindows,
  reconcileIamIdentities,
  rememberSuccessor,
  sqlInbox,
  successorLookup,
  successorsMigration,
  type IamInboxEvent,
  type InboxEvent,
} from '@better-compute/iam';
import { closeIamFixtures, iamFixture } from './support/iam.js';

// The iam module's worker jobs on PGlite (PLAN.md §12.7, §12.8): the inbox table, IamInbox, IamReconcile and
// the usage flush, then the whole bridge wired into a real better-iam.

let db: SqlExecutor;
const hour = 3_600_000;

beforeAll(async () => {
  db = pglite();
  await db.migrate([successorsMigration]);
  // Just enough fleet for usage windows and reservations to reference.
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
  await db.query(
    `INSERT INTO allocations (id, tenant_id, pool_id, node_id, owner_kind, owner_id, during, version)
     VALUES ('alloc-1', 'ten_a', 'pool-1', 'node-1', 'reservation', 'rsv-1',
             tstzrange(compute_now() - interval '1 day', compute_now()), 1)`,
  );
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  for (const table of [
    'iam_inbox',
    'iam_successors',
    'usage_windows',
    'usage_dead_letters',
    'reservations',
  ])
    await db.query(`DELETE FROM ${table}`);
});
afterEach(closeIamFixtures);

const inboxEvent = (
  id: string,
  tenantId: string,
  sequence: number,
  action: string,
  body = {},
): InboxEvent => ({
  eventId: id,
  tenantId,
  sequence,
  occurredAt: 1_700_000_000_000 + sequence,
  action,
  body: { id, tenantId, action, outcome: 'allow', ...body },
});

describe('sqlInbox', () => {
  it('stores events once per event id, with the fields the worker orders by', async () => {
    const inbox = sqlInbox(db);
    await inbox.put([inboxEvent('e1', 'ten_a', 3, 'agent:suspend')]);
    await inbox.put([
      inboxEvent('e1', 'ten_a', 3, 'agent:suspend'),
      inboxEvent('e2', 'ten_a', 4, 'feature:update'),
    ]);
    await inbox.put([]);
    const { rows } = await db.query<{
      event_id: string;
      sequence: string;
      occurred_at: Date;
      body: { action: string };
    }>('SELECT event_id, sequence::text, occurred_at, body FROM iam_inbox ORDER BY event_id');
    expect(rows.map((row) => [row.event_id, row.sequence])).toEqual([
      ['e1', '3'],
      ['e2', '4'],
    ]);
    expect(new Date(rows[0]!.occurred_at).getTime()).toBe(1_700_000_000_003);
    expect(rows[1]!.body.action).toBe('feature:update');
  });
});

describe('drainIamInbox', () => {
  it('processes each tenant in sequence order, whatever the arrival order, and marks rows processed', async () => {
    const seen: string[] = [];
    await sqlInbox(db).put([
      inboxEvent('b2', 'ten_b', 2, 'agent:suspend', { resourceId: 'agt_2' }),
      inboxEvent('a9', 'ten_a', 9, 'delegation:revoke', { resourceId: 'dlg_1' }),
      inboxEvent('a4', 'ten_a', 4, 'agent:suspend', { resourceId: 'agt_1', actorId: 'idn_owner' }),
      inboxEvent('b1', 'ten_b', 1, 'binding:deactivate'),
    ]);
    const handler = async (_tx: unknown, event: IamInboxEvent) => {
      seen.push(`${event.eventId}:${event.subjectId ?? '-'}:${event.reactions.join('+')}`);
    };
    const result = await drainIamInbox(db, { handlers: { agent: handler, binding: handler } });
    expect(result).toEqual({ processed: 4, more: false, failures: 0 });
    expect(seen).toEqual([
      'a4:agt_1:agent+sessions',
      'a9:dlg_1:agent+sessions',
      'b1:-:binding+authz',
      'b2:agt_2:agent+sessions',
    ]);
    expect((await drainIamInbox(db)).processed).toBe(0);
  });

  it('remembers successors, invalidates flags, pages, and survives handler failures', async () => {
    await sqlInbox(db).put([
      inboxEvent('o1', 'ten_a', 1, 'identity:offboard', {
        resourceId: 'idn_bob',
        metadata: { reason: 'left', successorId: 'idn_alice' },
      }),
      inboxEvent('o2', 'ten_a', 2, 'identity:offboard', {
        resourceId: 'idn_alice',
        metadata: { successorId: 'idn_carol' },
      }),
      inboxEvent('f1', 'ten_a', 3, 'feature:update'),
    ]);
    let isEnabledCalls = 0;
    const flags = createFlagCache({
      isEnabled: async () => {
        isEnabledCalls++;
        return true;
      },
    });
    await flags.get('ten_a', 'compute.h100');
    const errors: string[] = [];
    const first = await drainIamInbox(db, {
      flags,
      limit: 2,
      handlers: {
        identity: async (_tx, event) => {
          if (event.eventId === 'o1') throw new Error('stream registry down');
        },
        onError: (error, event, reaction) =>
          errors.push(`${event.eventId}/${reaction}/${(error as Error).message}`),
      },
    });
    expect(first).toEqual({ processed: 2, more: true, failures: 1 });
    expect(errors).toEqual(['o1/identity/stream registry down']);
    // Offboarding chains: bob → alice → carol.
    const successorOf = successorLookup(db);
    expect(await successorOf('ten_a', 'idn_bob')).toBe('idn_carol');
    expect(await successorOf('ten_a', 'idn_alice')).toBe('idn_carol');
    expect(await successorOf('ten_a', 'idn_carol')).toBeUndefined();
    expect(await successorOf('ten_b', 'idn_bob')).toBeUndefined();
    expect(await drainIamInbox(db, { flags })).toMatchObject({ processed: 1, more: false });
    await flags.get('ten_a', 'compute.h100');
    expect(isEnabledCalls).toBe(2);
  });

  it('stops at successor cycles', async () => {
    await db.transaction(async (tx) => {
      await rememberSuccessor(tx, 't', 'x', 'y');
      await rememberSuccessor(tx, 't', 'y', 'x');
    });
    expect(await successorLookup(db)('t', 'x')).toBe('y');
  });

  it('prunes processed rows past the retention window', async () => {
    await sqlInbox(db).put([inboxEvent('old', 'ten_a', 1, 'agent:suspend')]);
    await db.query(`UPDATE iam_inbox SET processed_at = compute_now() - interval '8 days'`);
    await drainIamInbox(db);
    expect((await db.query('SELECT 1 FROM iam_inbox')).rows).toEqual([]);
  });
});

describe('reconcileIamIdentities', () => {
  it('re-reads owners of live reservations and hands inactive ones to the identity handler', async () => {
    const reservation = (id: string, owner: string, state: string) =>
      db.query(
        `INSERT INTO reservations (id, tenant_id, pool_id, state, request, request_hash, owner_identity_id,
                                   idempotency_key, version)
         VALUES ($1, 'ten_a', 'pool-1', $2, '{}', '\\x00', $3, $1, 1)`,
        [id, state, owner],
      );
    await reservation('r1', 'idn_alice', 'active');
    await reservation('r2', 'idn_bob', 'pending');
    await reservation('r3', 'idn_bob', 'placed');
    await reservation('r4', 'idn_gone', 'released');
    await reservation('r5', 'idn_dan', 'binding');
    const states: Record<string, 'active' | 'disabled' | 'missing'> = {
      idn_alice: 'active',
      idn_bob: 'disabled',
      idn_dan: 'missing',
    };
    const handled: string[] = [];
    const result = await reconcileIamIdentities(db, {
      readIdentity: async (_tenantId, identityId) => ({ status: states[identityId] ?? 'missing' }),
      handlers: {
        identity: async (_tx, event) => {
          handled.push(`${event.subjectId}:${String(event.metadata.status)}`);
        },
      },
    });
    expect(result.checked).toBe(3);
    expect(result.inactive.map((item) => item.identityId).sort()).toEqual(['idn_bob', 'idn_dan']);
    expect(handled.sort()).toEqual(['idn_bob:disabled', 'idn_dan:missing']);
  });
});

describe('flushUsageWindows', () => {
  const window = (start: number, identity: string | null, meter = 'gpu.h100.hours') =>
    db.query(
      `INSERT INTO usage_windows (idempotency_key, allocation_id, tenant_id, identity_id, meter, quantity,
                                  window_start, window_end, tags)
       VALUES ($1, 'alloc-1', 'ten_a', $2, $3, 8, compute_now() - make_interval(hours => $4),
               compute_now() - make_interval(hours => $4 - 1), '{"pool":"pool-1"}')`,
      [`cmp:alloc-1:${start}`, identity, meter, start],
    );

  it('sends closed windows once, stores outcomes and dead letters', async () => {
    await window(5, 'idn_alice');
    await window(4, 'idn_bob');
    await window(3, 'idn_carol');
    await window(2, 'idn_alice', 'gpu.nope.hours');
    // Still open: not sent.
    await db.query(
      `INSERT INTO usage_windows (idempotency_key, allocation_id, tenant_id, identity_id, meter, quantity,
                                  window_start, window_end)
       VALUES ('cmp:alloc-1:open', 'alloc-1', 'ten_a', 'idn_alice', 'gpu.h100.hours', 1,
               compute_now() - interval '10 minutes', compute_now() + interval '50 minutes')`,
    );
    const sent: UsageEvent[][] = [];
    const iam: Pick<IamPort, 'recordUsage'> = {
      async recordUsage(events) {
        sent.push(events);
        return events.map((event): UsageResult => {
          if (event.identityId === 'idn_bob')
            return {
              idempotencyKey: event.idempotencyKey,
              status: 'reattributed',
              identityId: 'idn_alice',
            };
          if (event.identityId === 'idn_carol')
            return { idempotencyKey: event.idempotencyKey, status: 'reattributed' };
          if (event.meter === 'gpu.nope.hours')
            return {
              idempotencyKey: event.idempotencyKey,
              status: 'dead-lettered',
              error: { code: 'NOT_FOUND', message: 'Unknown billing meter gpu.nope.hours' },
            };
          return { idempotencyKey: event.idempotencyKey, status: 'recorded' };
        });
      },
    };
    expect(await flushUsageWindows(db, iam)).toEqual({ sent: 4, deadLettered: 1, more: false });
    expect(sent[0]!.map((event) => event.idempotencyKey)).toEqual([
      'cmp:alloc-1:5',
      'cmp:alloc-1:4',
      'cmp:alloc-1:3',
      'cmp:alloc-1:2',
    ]);
    expect(sent[0]![0]).toMatchObject({
      quantity: 8,
      tags: { pool: 'pool-1' },
      identityId: 'idn_alice',
    });
    const { rows } = await db.query<{
      idempotency_key: string;
      outcome: string | null;
      identity_id: string | null;
    }>('SELECT idempotency_key, outcome, identity_id FROM usage_windows ORDER BY idempotency_key');
    expect(rows).toEqual([
      { idempotency_key: 'cmp:alloc-1:2', outcome: 'dead-lettered', identity_id: 'idn_alice' },
      { idempotency_key: 'cmp:alloc-1:3', outcome: 'reattributed', identity_id: null },
      { idempotency_key: 'cmp:alloc-1:4', outcome: 'reattributed', identity_id: 'idn_alice' },
      { idempotency_key: 'cmp:alloc-1:5', outcome: 'recorded', identity_id: 'idn_alice' },
      { idempotency_key: 'cmp:alloc-1:open', outcome: null, identity_id: 'idn_alice' },
    ]);
    const letters = await db.query<{
      error_code: string;
      attempts: number;
      event: { meter: string };
    }>('SELECT error_code, attempts, event FROM usage_dead_letters');
    expect(letters.rows).toEqual([
      {
        error_code: 'NOT_FOUND',
        attempts: 1,
        event: expect.objectContaining({ meter: 'gpu.nope.hours' }),
      },
    ]);
    expect(await flushUsageWindows(db, iam)).toEqual({ sent: 0, deadLettered: 0, more: false });
  });

  it('leaves windows unrecorded when IAM fails, for the next pass', async () => {
    await window(3, 'idn_alice');
    await expect(
      flushUsageWindows(db, { recordUsage: () => Promise.reject(new Error('IAM down')) }),
    ).rejects.toThrow('IAM down');
    const { rows } = await db.query('SELECT 1 FROM usage_windows WHERE recorded_at IS NULL');
    expect(rows).toHaveLength(1);
  });
});

describe('the bridge on better-iam', () => {
  it('carries an offboarding from IAM through the inbox into successor-aware usage', async () => {
    const bridge = createComputeIamBridge();
    const plugin = bridge.plugin();
    const f = await iamFixture({ plugins: [plugin], resolveResource: bridge.resolveResource() });
    const port = bridge.embedded(f.iam, { rootTenantId: f.rootTenantId });
    const [module] = bridge.modules;
    expect(module.name).toBe('iam');
    expect(module.migrations?.map((migration) => migration.name)).toEqual(['iam/0001_successors']);
    expect(module.reconcilers?.map((reconciler) => [reconciler.name, reconciler.periodic])).toEqual(
      [
        ['iam.inbox', [{ key: 'inbox', every: '2s' }]],
        ['iam.reconcile', [{ key: 'identities', every: '5m' }]],
        ['iam.usage', [{ key: 'usage', every: '1h' }]],
      ],
    );
    for (const key of ['gpu.h100.hours'])
      await f.iam.api.billing.createMeter(f.rootCredential, {
        tenantId: f.rootTenantId,
        key,
        name: key,
        unit: 'hour',
      });
    const alice = await f.member('alice');
    const bob = await f.member('bob');

    // Before start(): events spill instead of failing IAM's dispatch.
    await f.iam.api.identities.offboard(f.ownerCredential, {
      tenantId: f.tenantId,
      identityId: bob.id,
      reason: 'left the company',
      successorId: alice.id,
    });
    await f.iam.events.dispatch();
    expect(plugin.stats().pending).toBeGreaterThan(0);
    expect((await module.selfCheck!({} as never)).map((finding) => finding.check)).toEqual(
      expect.arrayContaining(['iam.projection', 'iam.inbox-spill']),
    );

    await module.start({ sql: db });
    try {
      expect(bridge.bound).toBe(true);
      expect(plugin.stats().pending).toBe(0);
      const handled: IamInboxEvent[] = [];
      bridge.setHandlers({
        identity: async (_tx, event) => {
          handled.push(event);
        },
      });
      const inbox = module.reconcilers!.find((reconciler) => reconciler.name === 'iam.inbox')!;
      expect(await inbox.run({ sql: db } as never, 'inbox')).toBe('DONE');
      expect(handled.map((event) => [event.action, event.subjectId])).toContainEqual([
        'identity:offboard',
        bob.id,
      ]);
      expect(await successorLookup(db)(f.tenantId, bob.id)).toBe(alice.id);

      // bob is then deleted; his late usage is recorded under alice.
      await f.iam.api.identities.delete(f.ownerCredential, {
        tenantId: f.tenantId,
        identityId: bob.id,
      });
      const [result] = await port.recordUsage([
        {
          tenantId: f.tenantId,
          meter: 'gpu.h100.hours',
          quantity: 4,
          identityId: bob.id,
          occurredAt: f.now() - hour,
          tags: { pool: 'pool-1' },
          idempotencyKey: 'cmp:alloc-9:0',
        },
      ]);
      expect(result).toEqual({
        idempotencyKey: 'cmp:alloc-9:0',
        status: 'reattributed',
        identityId: alice.id,
      });
      expect(await module.selfCheck!({} as never)).toEqual([]);
    } finally {
      await module.stop();
    }
    expect(bridge.projection.ready).toBe(false);
  });

  it('refuses a second embedded() and reports an unbound inbox as a spill, not an IAM failure', async () => {
    const bridge = createComputeIamBridge({ rootTenantId: 'ten_root' });
    await expect(
      bridge.localInbox().put([inboxEvent('x', 't', 1, 'agent:suspend')]),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    const f = await iamFixture();
    bridge.embedded(f.iam);
    expect(() => bridge.embedded(f.iam)).toThrow(/already called/);
  });
});
