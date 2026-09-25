import { afterEach, describe, expect, it } from 'vitest';
import { defineModule, type ComputeModule, type SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute, type BetterCompute } from '@better-compute/server';
import { fakeIam, probeLeases } from '@better-compute/testing';

// Worker HA (PLAN.md §8.5, v0.4 exit): two workers on one store, on the wall clock. Worker A takes the shard and
// singleton leases; then its process "dies": its database connection fails (no release, nothing it runs commits).
// Worker B must take every lease A held within the TTL plus a renewal period, and no reconcile key may run on both
// workers at once: of the runs that committed, no two for the same key overlap in time.

interface Run {
  key: string;
  worker: string;
  start: number;
  end: number;
}

/** A module whose reconcilers record their committed runs: `ha.keyed` (sharded by node) and `ha.singleton`. */
function haModule(worker: string, runs: Run[]): ComputeModule {
  const record = async (context: { sql: SqlExecutor }, key: string) => {
    const start = Date.now();
    await context.sql.transaction(async (tx) => {
      await tx.query('INSERT INTO ha_runs (key, worker) VALUES ($1, $2)', [key, worker]);
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    runs.push({ key, worker, start, end: Date.now() });
    return 'DONE' as const;
  };
  return defineModule({
    name: 'ha',
    migrations: [
      {
        name: 'ha/0001_runs',
        sql: 'CREATE TABLE ha_runs (key text NOT NULL, worker text NOT NULL, at timestamptz NOT NULL DEFAULT now())',
      },
    ],
    reconcilers: [
      { name: 'ha.keyed', shardBy: 'node', run: (context, key) => record(context, key) },
      {
        name: 'ha.singleton',
        shardBy: 'none',
        periodic: [{ key: 'tick', every: '1s' }],
        run: (context, key) => record(context, key),
      },
    ],
  });
}

/** A store connection that can die: every statement after `crash()` fails, including inside open transactions. */
function crashable(db: SqlExecutor): { db: SqlExecutor; crash(): void } {
  let dead = false;
  const check = () => {
    if (dead) throw new Error('connection terminated');
  };
  return {
    crash: () => {
      dead = true;
    },
    db: {
      dialect: db.dialect,
      kind: db.kind,
      async query(text, params) {
        check();
        return db.query(text, params);
      },
      async transaction(fn, options) {
        check();
        return db.transaction(
          (tx) =>
            fn({
              ...tx,
              query: async (text: string, params?: readonly unknown[]) => {
                check();
                return tx.query(text, params as never);
              },
            } as typeof tx),
          options,
        );
      },
      migrate: (extra) => db.migrate(extra),
      close: async () => {},
    } as SqlExecutor,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
});

describe('worker lease HA', () => {
  it('moves every lease of a dead worker to the survivor within TTL + renewal, never running a key twice at once', async () => {
    const raw = pglite();
    cleanups.push(() => raw.close());
    const runs: Run[] = [];
    const worker = (id: string, db: SqlExecutor): BetterCompute =>
      betterCompute({
        database: db,
        iam: fakeIam(),
        secret: 'better-compute-lease-ha-secret-0123456789',
        baseURL: 'https://compute.lease-ha.test',
        rootTenantId: 'tenant-root',
        worker: { id, pollMs: 20 },
        modules: [haModule(id, runs)],
      }) as unknown as BetterCompute;

    const a = crashable(raw);
    const workerA = worker('wkr_a', a.db);
    await workerA.initialize();
    await workerA.start({ roles: ['controllers'] });
    cleanups.push(() => Promise.race([workerA.stop(), sleep(2_000)]).then(() => undefined));
    const probe = probeLeases(raw, { intervalMs: 50 });

    // Keys spread over many shards, enqueued continuously for the whole run.
    const keys = Array.from(
      { length: 48 },
      (_, index) => `node_ha${String(index).padStart(3, '0')}`,
    );
    let feeding = true;
    const feeder = (async () => {
      while (feeding) {
        await raw
          .transaction(async (tx) => {
            for (const key of keys) await workerA.context.work.enqueue(tx, 'ha.keyed', key);
          })
          .catch(() => {});
        await sleep(200);
      }
    })();

    await sleep(3_000);
    const heldByA = await raw.query<{ name: string }>(
      "SELECT name FROM leases WHERE owner = 'wkr_a' AND expires_at > now() AND (name LIKE 'shard:%' OR name LIKE 'singleton:%')",
    );
    expect(heldByA.rows.length).toBeGreaterThan(0);
    const workerB = worker('wkr_b', raw);
    await workerB.initialize();
    await workerB.start({ roles: ['controllers'] });
    cleanups.push(() => workerB.stop());
    await sleep(2_000);

    // Worker A's process dies.
    const crashedAt = Date.now();
    a.crash();
    const names = heldByA.rows.map((row) => row.name);
    let takenOverAt: number | undefined;
    while (Date.now() - crashedAt < 45_000) {
      const { rows } = await raw.query<{ taken: number }>(
        "SELECT count(*)::int AS taken FROM leases WHERE name = ANY($1::text[]) AND owner = 'wkr_b' AND expires_at > now()",
        [names],
      );
      if (rows[0]!.taken === names.length) {
        takenOverAt = Date.now();
        break;
      }
      await sleep(100);
    }
    await sleep(2_000);
    feeding = false;
    await feeder;
    const leases = await probe.stop();

    // B holds everything A held, within TTL (15 s) + renewal (5 s) + detection slack.
    expect(takenOverAt).toBeDefined();
    const takeoverMs = takenOverAt! - crashedAt;
    // B keeps working after the takeover.
    expect(runs.some((run) => run.worker === 'wkr_b' && run.start > takenOverAt!)).toBe(true);
    // No key ran on both workers at once (committed runs only; A's in-flight run at the crash never commits).
    const byKey = new Map<string, Run[]>();
    for (const run of runs) byKey.set(run.key, [...(byKey.get(run.key) ?? []), run]);
    const overlaps: string[] = [];
    for (const [key, list] of byKey) {
      list.sort((x, y) => x.start - y.start);
      for (let index = 1; index < list.length; index++)
        if (
          list[index]!.start < list[index - 1]!.end &&
          list[index]!.worker !== list[index - 1]!.worker
        )
          overlaps.push(`${key}: ${list[index - 1]!.worker} and ${list[index]!.worker}`);
    }
    expect(overlaps).toEqual([]);
    // The probe saw the takeovers from A to B and renewals with headroom while both were healthy.
    expect(
      leases.takeovers.some((takeover) => takeover.from === 'wkr_a' && takeover.to === 'wkr_b'),
    ).toBe(true);
    expect(leases.renewals).toBeGreaterThan(0);
    const movedAt = (prefix: string) =>
      Math.max(
        ...leases.takeovers
          .filter(
            (takeover) =>
              takeover.name.startsWith(prefix) &&
              takeover.from === 'wkr_a' &&
              takeover.to === 'wkr_b',
          )
          .map((takeover) => takeover.at - crashedAt),
      );
    console.log(
      JSON.stringify({
        takeoverMs,
        singletonsMs: movedAt('singleton:'),
        shardsMs: movedAt('shard:'),
        leases: names.length,
        renewalGapMs: leases.gapMs,
        minHeadroomMs: leases.minHeadroomMs,
        lapses: leases.lapses,
        runs: {
          a: runs.filter((run) => run.worker === 'wkr_a').length,
          b: runs.filter((run) => run.worker === 'wkr_b').length,
        },
      }),
    );
    // Singletons move as soon as the dead owner's lease expires (TTL 15 s + one renewal period).
    expect(movedAt('singleton:')).toBeLessThan(15_000 + 5_000 + 2_000);
    // Shards too: a worker silent for a lease TTL loses them as they expire, not at liveWorkerMs (30 s).
    expect(movedAt('shard:')).toBeLessThan(15_000 + 5_000 + 2_000);
    // Renewals run on their own timer, every renewMs (5 s), whatever the reconcilers are doing.
    expect(leases.gapMs.p99).toBeLessThan(5_000 + 1_500);
  }, 90_000);
});
