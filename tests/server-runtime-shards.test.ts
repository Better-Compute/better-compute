import { afterEach, describe, expect, it } from 'vitest';
import { SHARD_COUNT, defineModule, shardOf, type SqlTx } from '@better-compute/core';
import { assignShards, shardOwner } from '@better-compute/server';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { sibling } from './support/runtime.js';

// Shard ownership (PLAN.md §8.5): rendezvous hashing over live workers, `shard:<n>` leases.

afterEach(closeFixtures);

const all = Array.from({ length: SHARD_COUNT }, (_, shard) => shard);

describe('rendezvous assignment', () => {
  it('gives a lone worker every shard', () => {
    expect(assignShards(['wkr-a'], 'wkr-a')).toEqual(all);
    expect(assignShards([], 'wkr-a')).toEqual(all);
  });

  it('partitions the shards among live workers, disjoint and complete', () => {
    const workers = ['wkr-a', 'wkr-b', 'wkr-c'];
    const parts = workers.map((worker) => assignShards(workers, worker));
    expect(parts.flat().sort((a, b) => a - b)).toEqual(all);
    for (const part of parts) expect(part.length).toBeGreaterThan(SHARD_COUNT / 6);
  });

  it('moves only the shards of a worker that joins or leaves', () => {
    const before = ['wkr-a', 'wkr-b', 'wkr-c'];
    const after = [...before, 'wkr-d'];
    for (const shard of all) {
      const was = shardOwner(before, shard);
      const now = shardOwner(after, shard);
      if (now !== 'wkr-d') expect(now).toBe(was);
    }
    const moved = all.filter((shard) => shardOwner(after, shard) === 'wkr-d').length;
    expect(moved).toBeGreaterThan(SHARD_COUNT / 8);
    expect(moved).toBeLessThan(SHARD_COUNT / 2);
  });
});

describe('two workers on one store', () => {
  it('hand shards over through the leases table, then each runs only its own keys', async () => {
    const runs: { worker: string; key: string }[] = [];
    const module = (worker: string) =>
      defineModule({
        name: 'split',
        reconcilers: [
          {
            name: 'split',
            shardBy: 'node',
            run: async (_context, key) => (runs.push({ worker, key }), 'DONE'),
          },
        ],
      });
    const fixture = await computeFixture({ modules: [module('a')] });
    const a = fixture.compute;
    const b = await sibling(fixture, {
      modules: [module('b')],
      worker: { id: 'wkr-b', batchSize: 1000 },
    });
    const { database, advance } = fixture;

    // Alone, the first worker takes every shard.
    await a.jobs.split!.tick();
    const idA = (
      await database.query<{ owner: string }>("SELECT owner FROM leases WHERE name = 'shard:0'")
    ).rows[0]!.owner;
    expect(await owners(database)).toEqual(new Map([[idA, SHARD_COUNT]]));

    // The second one joins: its shards are still held, so it runs nothing yet.
    expect(await b.jobs.split!.tick()).toBe(0);
    expect((await owners(database)).get('wkr-b')).toBeUndefined();

    // On its next membership pass the first lets go of the second's shards; then they are taken.
    await advance(5_000);
    await a.jobs.split!.tick();
    await b.jobs.split!.tick();
    const expectA = assignShards([idA, 'wkr-b'], idA);
    const expectB = assignShards([idA, 'wkr-b'], 'wkr-b');
    const held = await database.query<{ name: string; owner: string }>(
      "SELECT name, owner FROM leases WHERE name LIKE 'shard:%' AND expires_at > compute_now()",
    );
    const byOwner = (owner: string) =>
      held.rows
        .filter((row) => row.owner === owner)
        .map((row) => Number(row.name.slice('shard:'.length)))
        .sort((x, y) => x - y);
    expect(byOwner(idA)).toEqual(expectA);
    expect(byOwner('wkr-b')).toEqual(expectB);
    expect([...expectA, ...expectB].sort((x, y) => x - y)).toEqual(all);

    // Keys land on the worker that holds their shard.
    const keys = Array.from(
      { length: 40 },
      (_, index) => `node_${String(index).padStart(26, '0')}`,
    );
    await database.transaction(async (tx) => {
      for (const key of keys) await a.context.work.enqueue(tx, 'split', key);
    });
    runs.length = 0;
    await a.jobs.split!.tick();
    await b.jobs.split!.tick();
    expect(runs.map((run) => run.key).sort()).toEqual([...keys].sort());
    for (const run of runs)
      expect(run.worker === 'a' ? expectA : expectB).toContain(shardOf(run.key));
  });
});

describe('a silent worker', () => {
  it('loses its shards as their leases expire, not at liveWorkerMs, and gets them back when it returns', async () => {
    const module = defineModule({
      name: 'split',
      reconcilers: [{ name: 'split', shardBy: 'node', run: async () => 'DONE' }],
    });
    const fixture = await computeFixture({ modules: [module] });
    const a = fixture.compute;
    const b = await sibling(fixture, { modules: [module], worker: { id: 'wkr-b' } });
    const { database, advance } = fixture;
    await a.jobs.split!.tick();
    const idA = (
      await database.query<{ owner: string }>("SELECT owner FROM leases WHERE name = 'shard:0'")
    ).rows[0]!.owner;
    await b.jobs.split!.tick();
    await advance(5_000);
    await a.jobs.split!.tick();
    await b.jobs.split!.tick();
    const mine = assignShards([idA, 'wkr-b'], idA);
    expect((await owners(database)).get(idA)).toBe(mine.length);
    const epochs = async () =>
      new Map(
        (
          await database.query<{ name: string; epoch: number }>(
            "SELECT name, epoch::int AS epoch FROM leases WHERE name LIKE 'shard:%'",
          )
        ).rows.map((row) => [row.name, row.epoch]),
      );
    const before = await epochs();

    // A stops renewing (paused, partitioned or dead) but stays live: its heartbeat is < 30 s old.
    // Before its leases expire B leaves them alone; once they have, B takes every one.
    for (let step = 0; step < 2; step++) {
      await advance(5_000);
      await b.jobs.split!.tick();
    }
    expect((await owners(database)).get(idA)).toBe(mine.length);
    await advance(6_000); // 16 s since A last renewed: past the 15 s TTL, A still live until 30 s
    await b.jobs.split!.tick();
    expect(await owners(database)).toEqual(new Map([['wkr-b', SHARD_COUNT]]));
    const after = await epochs();
    for (const shard of mine) expect(after.get(`shard:${shard}`)).toBe(before.get(`shard:${shard}`)! + 1);

    // A returns: it heartbeats, so its shards are no longer orphans; B lets go on its next pass and
    // A takes them back.
    await a.jobs.split!.tick();
    await advance(5_000);
    await b.jobs.split!.tick();
    await a.jobs.split!.tick();
    expect(await owners(database)).toEqual(
      new Map([
        [idA, mine.length],
        ['wkr-b', SHARD_COUNT - mine.length],
      ]),
    );
  });
});

async function owners(database: SqlTx) {
  const { rows } = await database.query<{ owner: string; n: number }>(
    `SELECT owner, count(*)::int AS n FROM leases
      WHERE name LIKE 'shard:%' AND expires_at > compute_now() GROUP BY owner`,
  );
  return new Map(rows.map((row) => [row.owner, row.n]));
}
