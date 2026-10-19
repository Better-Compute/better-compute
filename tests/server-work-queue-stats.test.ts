import { afterEach, describe, expect, it } from 'vitest';
import { apiMethod } from '@better-compute/core';
import { closeFixtures, computeFixture } from '@better-compute/testing';

// U-04: system.workQueue, the work queue's backlog per kind (root only), so a platform reads job health
// through the API rather than from the work_queue table.

afterEach(closeFixtures);

type Api = any;

async function world() {
  const fixture = await computeFixture({ clock: 'sim', start: Date.UTC(2026, 9, 19, 12) });
  const { iam, tenants } = fixture;
  iam.allow({ token: tenants.root.token });
  iam.allow({ token: tenants.acme.token });
  const api = fixture.compute.api as Api;
  const root = { token: tenants.root.token };
  const acme = { token: tenants.acme.token };
  /** A row of `kind` due `dueInMs` from now (negative: overdue), optionally claimed or failing. */
  const row = (
    kind: string,
    key: string,
    dueInMs: number,
    extra: { claimedForMs?: number; attempts?: number } = {},
  ) =>
    fixture.database.query(
      `INSERT INTO work_queue (kind, key, shard, gen, not_before, claimed_until, attempts)
       VALUES ($1, $2, 0, 1, compute_now() + make_interval(secs => $3::float8),
               CASE WHEN $4::float8 IS NULL THEN NULL ELSE compute_now() + make_interval(secs => $4::float8) END, $5)`,
      [
        kind,
        key,
        dueInMs / 1000,
        extra.claimedForMs === undefined ? null : extra.claimedForMs / 1000,
        extra.attempts ?? 0,
      ],
    );
  return { fixture, api, root, acme, row };
}

describe('system.workQueue', () => {
  it('is a fleet-admin read in the system group', () => {
    expect(apiMethod('system', 'workQueue')).toMatchObject({
      module: 'server',
      action: 'compute:fleet:admin',
      resource: 'fleet',
      kind: 'read',
    });
  });

  it('counts queued, due, overdue, claimed and retrying rows per kind', async () => {
    const { fixture, api, root, row } = await world();
    const now = fixture.clock.now();
    await row('u04.a', 'overdue', -10 * 60_000, { attempts: 2 });
    await row('u04.a', 'due', -1_000);
    await row('u04.a', 'later', 30_000);
    await row('u04.a', 'running', -20 * 60_000, { claimedForMs: 60_000 });
    await row('u04.b', 'parked', -1_000, { claimedForMs: 60_000 });

    const stats = await api.system.workQueue(root, { kinds: ['u04.a', 'u04.b', 'u04.none'] });
    expect(stats).toEqual({
      at: now,
      overdueAfterMs: 300_000,
      liveWorkers: expect.any(Number),
      kinds: [
        {
          kind: 'u04.a',
          queued: 4,
          due: 2,
          overdue: 1,
          claimed: 1,
          retrying: 1,
          nextDueAt: now - 10 * 60_000,
        },
        { kind: 'u04.b', queued: 1, due: 0, overdue: 0, claimed: 1, retrying: 0 },
        { kind: 'u04.none', queued: 0, due: 0, overdue: 0, claimed: 0, retrying: 0 },
      ],
    });
    // A shorter threshold counts the row due a second ago as overdue too.
    const strict = await api.system.workQueue(root, { kinds: ['u04.a'], overdueAfterMs: 0 });
    expect(strict.kinds[0]).toMatchObject({ overdue: 2 });
    // Without kinds: every kind queued, sorted.
    const all = await api.system.workQueue(root, {});
    const kinds = all.kinds.map((entry: { kind: string }) => entry.kind);
    expect(kinds).toEqual([...kinds].sort());
    expect(kinds).toEqual(expect.arrayContaining(['u04.a', 'u04.b']));
  });

  it('is root only, and checks its input', async () => {
    const { api, acme, root } = await world();
    await expect(api.system.workQueue(acme, {})).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await expect(api.system.workQueue(root, { kinds: [] })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(api.system.workQueue(root, { kinds: ['bad kind'] })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(api.system.workQueue(root, { overdueAfterMs: -1 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(api.system.workQueue(root, { other: 1 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});
