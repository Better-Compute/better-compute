import { afterEach, describe, expect, it } from 'vitest';
import { defineModule, isComputeError, shardOf, type ReconcileContext } from '@better-compute/core';
import { closeFixtures, computeFixture } from '@better-compute/testing';
import { workRows } from './support/runtime.js';

// The coalescing work queue (PLAN.md §8.4): enqueue in the state-change transaction, claims by
// shard, and completion at the claimed generation, so a key re-dirtied mid-run is never lost.

afterEach(closeFixtures);

describe('WorkQueue.enqueue', () => {
  it('coalesces a key: gen + 1 and the earlier not_before; shard = shardOf(key)', async () => {
    const { compute, database, clock } = await computeFixture();
    const { work } = compute.context;
    const later = clock.now() + 60_000;
    await database.transaction((tx) => work.enqueue(tx, 'probe', 'k1', { notBefore: later }));
    let [row] = await workRows(database, 'probe');
    expect(row).toMatchObject({ key: 'k1', gen: 1, shard: shardOf('k1'), claimed_until: null });
    expect(row!.not_before.getTime()).toBe(later);

    await database.transaction((tx) => work.enqueue(tx, 'probe', 'k1', { notBefore: later + 1 }));
    [row] = await workRows(database, 'probe');
    expect(row).toMatchObject({ gen: 2 });
    expect(row!.not_before.getTime()).toBe(later);

    await database.transaction((tx) => work.enqueue(tx, 'probe', 'k1'));
    [row] = await workRows(database, 'probe');
    expect(row).toMatchObject({ gen: 3 });
    expect(row!.not_before.getTime()).toBe(clock.now());
  });

  it('rolls back with its transaction', async () => {
    const { compute, database } = await computeFixture();
    await expect(
      database.transaction(async (tx) => {
        await compute.context.work.enqueue(tx, 'probe', 'k1');
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await workRows(database, 'probe')).toEqual([]);
  });

  it('checks kinds, keys and not_before', async () => {
    const { compute, database } = await computeFixture();
    const { work } = compute.context;
    for (const call of [
      () => work.enqueue(database, 'Bad Kind', 'k'),
      () => work.enqueue(database, 'probe', ''),
      () => work.enqueue(database, 'probe', 'k', { notBefore: Number.NaN }),
    ])
      await expect(call()).rejects.toSatisfy((error: unknown) =>
        isComputeError(error, 'INVALID_INPUT'),
      );
  });

  it('DesiredState.invalidate enqueues the node for NodeSpec', async () => {
    const { compute, database } = await computeFixture();
    await database.transaction((tx) => compute.context.desired.invalidate(tx, 'node_x'));
    expect(await workRows(database, 'nodespec')).toMatchObject([{ key: 'node_x', gen: 1 }]);
  });
});

describe('claim and complete', () => {
  it('keeps a key re-dirtied while its reconciler ran, then runs it again', async () => {
    const runs: { key: string; gen: number }[] = [];
    let redirty = true;
    const racer = defineModule({
      name: 'racer',
      reconcilers: [
        {
          name: 'race',
          shardBy: 'node',
          async run(context: ReconcileContext, key: string) {
            const gen = (
              await context.sql.query<{ gen: number }>(
                "SELECT gen FROM work_queue WHERE kind = 'race' AND key = $1",
                [key],
              )
            ).rows[0]!.gen;
            runs.push({ key, gen });
            if (redirty) {
              redirty = false;
              // Another transaction dirties the key again while this run is in flight.
              await context.sql.transaction((tx) => context.work.enqueue(tx, 'race', key));
            }
            return 'DONE';
          },
        },
      ],
    });
    const { compute, database } = await computeFixture({ modules: [racer] });
    await database.transaction((tx) => compute.context.work.enqueue(tx, 'race', 'node_a'));

    expect(await compute.jobs.race!.tick()).toBe(1);
    // DELETE at the claimed gen missed: the row survives, unclaimed and due.
    expect(await workRows(database, 'race')).toMatchObject([
      { key: 'node_a', gen: 2, claimed_until: null },
    ]);
    expect(await compute.jobs.race!.tick()).toBe(1);
    expect(await workRows(database, 'race')).toEqual([]);
    expect(runs).toEqual([
      { key: 'node_a', gen: 1 },
      { key: 'node_a', gen: 2 },
    ]);
    expect(await compute.jobs.race!.tick()).toBe(0);
  });

  it('runs a key its reconciler re-enqueued with notBefore at that time, not at once', async () => {
    const runs: number[] = [];
    let clockNow = () => 0;
    const later = defineModule({
      name: 'later',
      reconcilers: [
        {
          name: 'later',
          shardBy: 'none',
          async run(context: ReconcileContext, key: string) {
            runs.push(clockNow());
            // "Look again in 10 minutes" (capacity's reservation lifecycle does this).
            await context.sql.transaction((tx) =>
              context.work.enqueue(tx, 'later', key, { notBefore: context.clock.now() + 600_000 }),
            );
            return 'DONE';
          },
        },
      ],
    });
    const { compute, database, clock, advance } = await computeFixture({ modules: [later] });
    clockNow = () => clock.now();
    const start = clock.now();
    await database.transaction((tx) => compute.context.work.enqueue(tx, 'later', 'k1'));
    expect(await compute.jobs.later!.tick()).toBe(1);
    const [row] = await workRows(database, 'later');
    expect(row).toMatchObject({ key: 'k1', gen: 2, claimed_until: null });
    expect(row!.not_before.getTime()).toBe(start + 600_000);
    expect(await compute.jobs.later!.tick()).toBe(0);
    await advance(600_000);
    expect(await compute.jobs.later!.tick()).toBe(1);
    expect(runs).toEqual([start, start + 600_000]);
  });

  it('does not claim a key another worker holds until its claim expires', async () => {
    const seen: string[] = [];
    const slow = defineModule({
      name: 'slow',
      reconcilers: [
        { name: 'slow', shardBy: 'none', run: async (_context, key) => (seen.push(key), 'DONE') },
      ],
    });
    const { compute, database, advance } = await computeFixture({ modules: [slow] });
    await database.transaction((tx) => compute.context.work.enqueue(tx, 'slow', 'k1'));
    // Someone else's claim, still valid for 30 s.
    await database.query(
      "UPDATE work_queue SET claimed_until = compute_now() + interval '30 seconds' WHERE kind = 'slow'",
    );
    expect(await compute.jobs.slow!.tick()).toBe(0);
    await advance(30_001);
    expect(await compute.jobs.slow!.tick()).toBe(1);
    expect(seen).toEqual(['k1']);
  });
});
