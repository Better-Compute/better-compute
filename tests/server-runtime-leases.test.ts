import { afterEach, describe, expect, it } from 'vitest';
import { isComputeError, type SqlTx } from '@better-compute/core';
import { leaseNames } from '@better-compute/server';
import { closeFixtures, computeFixture } from '@better-compute/testing';

// Table leases with fencing epochs (PLAN.md §8.5), through `ctx.leases` on the sim clock.

afterEach(closeFixtures);

const TTL = 15_000;

async function leaseRow(sql: SqlTx, name: string) {
  const { rows } = await sql.query<{ owner: string | null; epoch: number; expires_at: Date }>(
    'SELECT owner, epoch, expires_at FROM leases WHERE name = $1',
    [name],
  );
  return rows[0];
}

describe('LeaseProvider', () => {
  it('inserts a missing lease and hands it to its first owner at epoch 1', async () => {
    const { compute, database, clock } = await computeFixture();
    const { leases } = compute.context;
    const lease = await leases.acquire('shard:7', 'wkr-a', TTL);
    expect(lease).toEqual({
      name: 'shard:7',
      owner: 'wkr-a',
      epoch: 1,
      expiresAt: clock.now() + TTL,
    });
    expect(await leaseRow(database, 'shard:7')).toMatchObject({ owner: 'wkr-a', epoch: 1 });
  });

  it('renews for its owner at the same epoch and refuses another owner until it expires', async () => {
    const { compute, advance, clock } = await computeFixture();
    const { leases } = compute.context;
    await leases.acquire('singleton:sweeper', 'wkr-a', TTL);
    await advance(5_000);
    const renewed = await leases.acquire('singleton:sweeper', 'wkr-a', TTL);
    expect(renewed).toMatchObject({ epoch: 1, expiresAt: clock.now() + TTL });
    expect(await leases.acquire('singleton:sweeper', 'wkr-b', TTL)).toBeUndefined();
    await advance(TTL - 1);
    expect(await leases.acquire('singleton:sweeper', 'wkr-b', TTL)).toBeUndefined();
  });

  it('takes an expired lease over with epoch + 1, which fences the old holder out', async () => {
    const { compute, advance, database } = await computeFixture();
    const { leases } = compute.context;
    const zombie = (await leases.acquire('pool:p1', 'wkr-a', TTL))!;
    await advance(TTL + 1);
    const taken = (await leases.acquire('pool:p1', 'wkr-b', TTL))!;
    expect(taken).toMatchObject({ owner: 'wkr-b', epoch: 2 });

    // The zombie's fenced transaction aborts before writing anything.
    await expect(
      database.transaction(async (tx) => {
        await leases.fence(tx, zombie);
        await tx.query(
          "INSERT INTO workers (id, started_at, heartbeat_at) VALUES ('ghost', compute_now(), compute_now())",
        );
      }),
    ).rejects.toSatisfy((error: unknown) => isComputeError(error, 'CONFLICT'));
    expect((await database.query("SELECT 1 FROM workers WHERE id = 'ghost'")).rowCount).toBe(0);

    // The new holder's passes.
    await database.transaction(async (tx) => {
      await leases.fence(tx, taken);
      await tx.query(
        "INSERT INTO workers (id, started_at, heartbeat_at) VALUES ('live', compute_now(), compute_now())",
      );
    });
    expect((await database.query("SELECT 1 FROM workers WHERE id = 'live'")).rowCount).toBe(1);

    // The old owner coming back is a new owner too: another epoch, never its old one.
    await advance(TTL + 1);
    expect(await leases.acquire('pool:p1', 'wkr-a', TTL)).toMatchObject({ epoch: 3 });
  });

  it('fences out a lease that expired even if nobody took it over', async () => {
    const { compute, advance, database } = await computeFixture();
    const { leases } = compute.context;
    const lease = (await leases.acquire('site:s1:boot', 'agent-1', TTL))!;
    await database.transaction((tx) => leases.fence(tx, lease));
    await advance(TTL);
    await expect(database.transaction((tx) => leases.fence(tx, lease))).rejects.toSatisfy(
      (error: unknown) => isComputeError(error, 'CONFLICT'),
    );
    // Renewing after expiry with no takeover keeps the epoch: nobody else held it in between.
    expect(await leases.acquire('site:s1:boot', 'agent-1', TTL)).toMatchObject({ epoch: 1 });
  });

  it('releases to the next owner at once, with a new epoch', async () => {
    const { compute, database } = await computeFixture();
    const { leases } = compute.context;
    const first = (await leases.acquire('gateway:gw1', 'gw-proc-1', TTL))!;
    await leases.release('gateway:gw1', 'someone-else'); // not the owner: no effect
    expect(await leases.acquire('gateway:gw1', 'gw-proc-2', TTL)).toBeUndefined();
    await leases.release('gateway:gw1', 'gw-proc-1');
    expect(await leaseRow(database, 'gateway:gw1')).toMatchObject({ owner: null });
    await expect(database.transaction((tx) => leases.fence(tx, first))).rejects.toSatisfy(
      (error: unknown) => isComputeError(error, 'CONFLICT'),
    );
    expect(await leases.acquire('gateway:gw1', 'gw-proc-2', TTL)).toMatchObject({ epoch: 2 });
  });

  it('checks names, owners and TTLs', async () => {
    const { compute } = await computeFixture();
    const { leases } = compute.context;
    for (const call of [
      () => leases.acquire('', 'wkr', TTL),
      () => leases.acquire('has space', 'wkr', TTL),
      () => leases.acquire('shard:1', '', TTL),
      () => leases.acquire('shard:1', 'wkr', 0),
      () => leases.acquire('shard:1', 'wkr', 1.5),
    ])
      await expect(call()).rejects.toSatisfy((error: unknown) =>
        isComputeError(error, 'INVALID_INPUT'),
      );
  });

  it('names leases as §8.5 does', () => {
    expect(leaseNames.shard(12)).toBe('shard:12');
    expect(leaseNames.pool('pool_x')).toBe('pool:pool_x');
    expect(leaseNames.siteBoot('site_x')).toBe('site:site_x:boot');
    expect(leaseNames.singleton('command-sweeper')).toBe('singleton:command-sweeper');
    expect(leaseNames.gateway('gw_x')).toBe('gateway:gw_x');
  });
});
