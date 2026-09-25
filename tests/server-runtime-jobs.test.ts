import { afterEach, describe, expect, it } from 'vitest';
import {
  defineModule,
  isComputeError,
  type ComputeModule,
  type ReconcileContext,
} from '@better-compute/core';
import { betterCompute } from '@better-compute/server';
import { closeFixtures, computeFixture, fakeIam } from '@better-compute/testing';
import { pglite } from '@better-compute/postgres/pglite';
import { BASE_URL, SECRET, seedNode, sibling, workRows } from './support/runtime.js';

// compute.jobs (PLAN.md §8.2, §8.4): reconcilers stepped without timers under the sim clock, with
// DONE / SYNC_AGAIN / failure back-off, periodic keys, singleton leases and the level-trigger
// resync; plus module start/stop and the timer loops of start()/stop().

afterEach(closeFixtures);

const START = Date.UTC(2026, 0, 1);

/** A module whose reconciler follows a script per key and records every run with its time. */
function scripted(script: Record<string, ('DONE' | 'SYNC_AGAIN' | 'THROW')[]>) {
  const trace: string[] = [];
  const module = defineModule({
    name: 'scripted',
    reconcilers: [
      {
        name: 'script',
        shardBy: 'pool',
        periodic: [{ key: 'tick-every-minute', every: '1m' }],
        async run(context: ReconcileContext, key: string) {
          const step = script[key]?.shift() ?? 'DONE';
          trace.push(`${context.clock.now() - START}:${key}:${step}`);
          if (step === 'THROW') throw new Error(`scripted failure of ${key}`);
          return step;
        },
      },
    ],
  });
  return { module, trace };
}

async function scenario() {
  const { module, trace } = scripted({
    a: ['DONE'],
    b: ['SYNC_AGAIN', 'DONE'],
    c: ['THROW', 'THROW', 'DONE'],
  });
  const fixture = await computeFixture({ modules: [module], log: quietLog() });
  const { compute, database, advance } = fixture;
  const tick = () => compute.jobs.script!.tick();
  await database.transaction(async (tx) => {
    for (const key of ['c', 'b', 'a']) await compute.context.work.enqueue(tx, 'script', key);
    await compute.context.work.enqueue(tx, 'script', 'later', { notBefore: START + 2_500 });
  });
  const counts: number[] = [];
  counts.push(await tick()); // t=0: a, b, c, and the periodic key seeded at first sight
  counts.push(await tick()); // t=0: nothing due
  await advance(1_000);
  counts.push(await tick()); // t=1s: b (SYNC_AGAIN after 1 s), c (1st back-off 1 s)
  await advance(1_000);
  counts.push(await tick()); // t=2s: nothing (c backs off 2 s now)
  await advance(1_000);
  counts.push(await tick()); // t=3s: later, c
  await advance(60_000);
  counts.push(await tick()); // t=63s: the periodic key again
  return { trace, counts, rows: await workRows(database, 'script') };
}

function quietLog() {
  const entries: string[] = [];
  const at = (level: string) => (message: string) => void entries.push(`${level}:${message}`);
  return { entries, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

describe('jobs.<reconciler>.tick()', () => {
  it('runs ready keys in (not_before, key) order with DONE, SYNC_AGAIN and back-off', async () => {
    const { trace, counts, rows } = await scenario();
    expect(trace).toEqual([
      '0:a:DONE',
      '0:b:SYNC_AGAIN',
      '0:c:THROW',
      '0:tick-every-minute:DONE',
      '1000:b:DONE',
      '1000:c:THROW',
      // `later` was due at 2.5 s, c only at 3 s (second back-off: 2 s).
      '3000:later:DONE',
      '3000:c:DONE',
      '63000:tick-every-minute:DONE',
    ]);
    expect(counts).toEqual([4, 0, 2, 0, 2, 1]);
    // Only the periodic key stays queued, due a minute after its last run.
    expect(rows.map((row) => [row.key, row.not_before.getTime() - START])).toEqual([
      ['tick-every-minute', 123_000],
    ]);
  });

  it('replays identically: same inputs, same trace', async () => {
    const first = await scenario();
    await closeFixtures();
    const second = await scenario();
    expect(second.trace).toEqual(first.trace);
    expect(second.counts).toEqual(first.counts);
  });

  it('runs a shardBy none reconciler under its singleton lease only', async () => {
    const seen: string[] = [];
    const module = defineModule({
      name: 'solo',
      reconcilers: [
        { name: 'solo', shardBy: 'none', run: async (_c, key) => (seen.push(key), 'DONE') },
      ],
    });
    const fixture = await computeFixture({ modules: [module] });
    const { compute, database } = fixture;
    await database.query(
      `INSERT INTO leases (name, owner, epoch, expires_at)
       VALUES ('singleton:solo', 'someone-else', 4, compute_now() + interval '15 seconds')`,
    );
    await database.transaction((tx) => compute.context.work.enqueue(tx, 'solo', 'k'));
    expect(await compute.jobs.solo!.tick()).toBe(0);
    await fixture.advance(15_001);
    expect(await compute.jobs.solo!.tick()).toBe(1);
    expect(seen).toEqual(['k']);
    const lease = await database.query<{ epoch: number }>(
      "SELECT epoch FROM leases WHERE name = 'singleton:solo'",
    );
    expect(lease.rows[0]!.epoch).toBe(5);
  });

  it('re-enqueues the nodes of owned shards every 5-10 minutes (level trigger)', async () => {
    const seen: string[] = [];
    const module = defineModule({
      name: 'nodewatch',
      reconcilers: [
        { name: 'nodewatch', shardBy: 'node', run: async (_c, key) => (seen.push(key), 'DONE') },
      ],
    });
    const fixture = await computeFixture({ modules: [module] });
    const { compute, database } = fixture;
    const node = await seedNode(database, { tenantId: fixture.tenants.root.id });
    expect(await compute.jobs.nodewatch!.tick()).toBe(0);
    await fixture.advance(4 * 60_000);
    expect(await compute.jobs.nodewatch!.tick()).toBe(0);
    await fixture.advance(6 * 60_000 + 1);
    expect(await compute.jobs.nodewatch!.tick()).toBe(1);
    expect(seen).toEqual([node.id]);
  });

  it('fences a reconciler transaction by the lease it runs under', async () => {
    let stolen = false;
    const module = defineModule({
      name: 'fenced',
      reconcilers: [
        {
          name: 'fenced',
          shardBy: 'none',
          async run(context, key) {
            if (!stolen) {
              stolen = true;
              // Another process takes the lease over (as after a partition) mid-run.
              await context.sql.query(
                "UPDATE leases SET owner = 'thief', epoch = epoch + 1 WHERE name = 'singleton:fenced'",
              );
            }
            await context.sql.transaction((tx) =>
              tx.query(
                'INSERT INTO workers (id, started_at, heartbeat_at) VALUES ($1, compute_now(), compute_now())',
                [key],
              ),
            );
            return 'DONE';
          },
        },
      ],
    });
    const log = quietLog();
    const { compute, database } = await computeFixture({ modules: [module], log });
    await database.transaction((tx) => compute.context.work.enqueue(tx, 'fenced', 'w-1'));
    expect(await compute.jobs.fenced!.tick()).toBe(1);
    expect((await database.query("SELECT 1 FROM workers WHERE id = 'w-1'")).rowCount).toBe(0);
    expect(log.entries).toContain('warn:A reconciler run failed; backing off');
    expect(await workRows(database, 'fenced')).toMatchObject([{ key: 'w-1', claimed_until: null }]);
  });

  it('exposes the built-in jobs next to each reconciler', async () => {
    const { compute } = await computeFixture();
    expect(Object.keys(compute.jobs)).toEqual(
      expect.arrayContaining([
        'command-sweeper',
        'event-subscribers',
        'inventory',
        'outbox-dispatch',
      ]),
    );
    expect(Object.isFrozen(compute.jobs)).toBe(true);
  });

  it('runs host IAM jobs as iam:<name>, each under its singleton lease', async () => {
    const fixture = await computeFixture();
    const runs: string[] = [];
    const compute = await sibling(fixture, {
      iamJobs: [
        { name: 'dispatch-audit-hooks', everyMs: 1_000, run: async () => void runs.push('hooks') },
        { name: 'sweep-expired', everyMs: 60_000, run: async () => void runs.push('sweep') },
      ],
    });
    await fixture.database.query(
      `INSERT INTO leases (name, owner, epoch, expires_at)
       VALUES ('singleton:iam:sweep-expired', 'another-iam-host', 1, compute_now() + interval '1 minute')`,
    );
    expect(await compute.jobs['iam:dispatch-audit-hooks']!.tick()).toBe(1);
    expect(await compute.jobs['iam:sweep-expired']!.tick()).toBe(0);
    expect(runs).toEqual(['hooks']);
    expect(() =>
      betterCompute({
        database: fixture.database,
        iam: fixture.iam,
        secret: SECRET,
        baseURL: BASE_URL,
        rootTenantId: 'tenant-root',
        iamJobs: [{ name: 'Bad Name', everyMs: 1_000, run: async () => {} }],
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});

describe('reconciler registration', () => {
  const run = async () => 'DONE' as const;
  const withReconcilers = (...reconcilers: NonNullable<ComputeModule['reconcilers']>) =>
    defineModule({ name: 'bad', reconcilers });
  const build = (modules: ComputeModule[]) => () =>
    betterCompute({
      database: pglite(),
      iam: fakeIam(),
      secret: SECRET,
      baseURL: BASE_URL,
      rootTenantId: 'tenant-root',
      modules,
    });

  it.each([
    ['a bad name', withReconcilers({ name: 'Bad Name', shardBy: 'node', run })],
    ['a built-in job name', withReconcilers({ name: 'command-sweeper', shardBy: 'none', run })],
    ['an unknown shardBy', withReconcilers({ name: 'x', shardBy: 'rack' as never, run })],
    ['no run', withReconcilers({ name: 'x', shardBy: 'node' } as never)],
    [
      'a short period',
      withReconcilers({ name: 'x', shardBy: 'none', run, periodic: [{ key: 'k', every: '10ms' }] }),
    ],
    [
      'a duplicate periodic key',
      withReconcilers({
        name: 'x',
        shardBy: 'none',
        run,
        periodic: [
          { key: 'k', every: '1m' },
          { key: 'k', every: '2m' },
        ],
      }),
    ],
    [
      'a name taken by the inventory module',
      withReconcilers({ name: 'inventory', shardBy: 'node', run }),
    ],
  ])('refuses %s (INVALID_CONFIG)', (_label, module) => {
    let error: unknown;
    try {
      build([module])();
    } catch (caught) {
      error = caught;
    }
    expect(isComputeError(error, 'INVALID_CONFIG')).toBe(true);
  });
});

describe('lifecycle', () => {
  it('starts modules after migrations in order, and stops them in reverse', async () => {
    const calls: string[] = [];
    const tracked = (name: string) =>
      defineModule({
        name,
        async start(context) {
          const { rowCount } = await context.sql.query(
            "SELECT 1 FROM compute_migrations WHERE name = 'core/0002_base'",
          );
          calls.push(`start ${name} migrated=${rowCount === 1}`);
        },
        async stop() {
          calls.push(`stop ${name}`);
        },
      });
    const fixture = await computeFixture({ modules: [tracked('first'), tracked('second')] });
    expect(calls).toEqual(['start first migrated=true', 'start second migrated=true']);
    await fixture.compute.stop();
    expect(calls.slice(2)).toEqual(['stop second', 'stop first']);
  });

  it('runs reconcilers on timers after start() and releases everything on stop()', async () => {
    const seen: string[] = [];
    const module = defineModule({
      name: 'live',
      reconcilers: [
        { name: 'live', shardBy: 'node', run: async (_c, key) => (seen.push(key), 'DONE') },
      ],
    });
    const database = pglite();
    const compute = betterCompute({
      database,
      iam: fakeIam(),
      secret: SECRET,
      baseURL: BASE_URL,
      rootTenantId: 'tenant-root',
      modules: [module],
      worker: { id: 'wkr-live', pollMs: 20 },
    });
    try {
      await compute.initialize();
      await compute.start({ roles: ['controllers'] });
      await database.transaction((tx) => compute.context.work.enqueue(tx, 'live', 'node_1'));
      const deadline = Date.now() + 10_000;
      while (!seen.length && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(seen).toEqual(['node_1']);
      const count = async () =>
        (
          await database.query<{ shards: number; singletons: number }>(
            `SELECT count(*) FILTER (WHERE name LIKE 'shard:%')::int AS shards,
                    count(*) FILTER (WHERE name LIKE 'singleton:%')::int AS singletons
               FROM leases WHERE owner = 'wkr-live'`,
          )
        ).rows[0];
      // The only worker holds all 256 shards, and singleton leases (the CommandSweeper's, …).
      const held = await count();
      expect(held!.shards).toBe(256);
      expect(held!.singletons).toBeGreaterThanOrEqual(1);
      const sweeper = await database.query(
        "SELECT 1 FROM leases WHERE name = 'singleton:command-sweeper' AND owner = 'wkr-live'",
      );
      expect(sweeper.rowCount).toBe(1);
      await compute.stop();
      expect(await count()).toEqual({ shards: 0, singletons: 0 });
      expect((await database.query("SELECT 1 FROM workers WHERE id = 'wkr-live'")).rowCount).toBe(
        0,
      );
    } finally {
      await compute.stop();
      await database.close();
    }
  });

  it('runs scheduler reconcilers only under the scheduler role, on their own shard leases', async () => {
    const seen: string[] = [];
    const module = defineModule({
      name: 'live',
      reconcilers: [
        { name: 'live', shardBy: 'node', run: async (_c, key) => (seen.push(`live:${key}`), 'DONE') },
        { name: 'place', shardBy: 'pool', role: 'scheduler', run: async (_c, key) => (seen.push(`place:${key}`), 'DONE') },
      ],
    });
    const database = pglite();
    const compute = betterCompute({
      database,
      iam: fakeIam(),
      secret: SECRET,
      baseURL: BASE_URL,
      rootTenantId: 'tenant-root',
      modules: [module],
      worker: { id: 'wkr-sched', pollMs: 20 },
    });
    const waitFor = async (entry: string) => {
      const deadline = Date.now() + 10_000;
      while (!seen.includes(entry) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    };
    const shardLeases = async () =>
      (
        await database.query<{ controllers: number; scheduler: number }>(
          `SELECT count(*) FILTER (WHERE name LIKE 'shard:%')::int AS controllers,
                  count(*) FILTER (WHERE name LIKE 'scheduler/shard:%')::int AS scheduler
             FROM leases WHERE expires_at > compute_now() AND owner IS NOT NULL`,
        )
      ).rows[0];
    try {
      await compute.initialize();
      await compute.start({ roles: ['controllers'] });
      await database.transaction(async (tx) => {
        await compute.context.work.enqueue(tx, 'live', 'node_1');
        await compute.context.work.enqueue(tx, 'place', 'pool_1');
      });
      await waitFor('live:node_1');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(seen).toEqual(['live:node_1']);
      expect(await shardLeases()).toEqual({ controllers: 256, scheduler: 0 });

      await compute.start({ roles: ['scheduler'] });
      await waitFor('place:pool_1');
      expect(seen).toEqual(['live:node_1', 'place:pool_1']);
      expect(await shardLeases()).toEqual({ controllers: 256, scheduler: 256 });
      await compute.stop();
      expect(await shardLeases()).toEqual({ controllers: 0, scheduler: 0 });
    } finally {
      await compute.stop();
      await database.close();
    }
  });
});
