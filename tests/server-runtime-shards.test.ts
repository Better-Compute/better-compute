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

async function owners(database: SqlTx) {
  const { rows } = await database.query<{ owner: string; n: number }>(
    `SELECT owner, count(*)::int AS n FROM leases
      WHERE name LIKE 'shard:%' AND expires_at > compute_now() GROUP BY owner`,
  );
  return new Map(rows.map((row) => [row.owner, row.n]));
}
