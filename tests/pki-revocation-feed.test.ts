import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { createRevocationFeed, createRevocationSet } from '@better-compute/pki';

// The per-gateway revocation feed: node_certs.revoked_at (the truth) → the process RevocationSet.

const now = Date.UTC(2026, 8, 24, 12);
const hour = 3_600_000;
let db: SqlExecutor;
let serial = 0x1000;

beforeAll(async () => {
  db = pglite();
  await db.migrate();
  await useSimClock(db, now);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_r', 'org_r', 'shared', 'eu', 1)`,
  );
  await db.query(
    `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
       trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
     VALUES ('node_r', 'site_r', 'org_r', 'unassigned', 'adopted', false, false, 'connected', 'platform',
       0, 0, 1, 1, 0, 1)`,
  );
});
afterAll(async () => {
  await db.close();
});

async function cert(options: { revokedAt?: number; notAfter?: number } = {}) {
  const s = (serial++).toString(16);
  await db.query(
    `INSERT INTO node_certs (serial, node_id, role, identity_gen, spki_sha256, der, not_before, not_after,
       revoked_at, revocation_reason)
     VALUES ($1, 'node_r', 'node', 1, '\\x00', '\\x00', $2, $3, $4, $5)`,
    [
      s,
      new Date(now - 2 * hour),
      new Date(options.notAfter ?? now + 20 * hour),
      options.revokedAt === undefined ? null : new Date(options.revokedAt),
      options.revokedAt === undefined ? null : 'test',
    ],
  );
  return s;
}

const revoke = (s: string, at: number) =>
  db.query(
    `UPDATE node_certs SET revoked_at = $2, revocation_reason = 'key compromise' WHERE serial = $1`,
    [s, new Date(at)],
  );

describe('revocation feed', () => {
  it('seeds the unexpired revoked set, then learns each new revocation once', async () => {
    const early = await cert({ revokedAt: now - hour });
    const expired = await cert({ revokedAt: now - 3 * hour, notAfter: now - hour });
    const live = await cert();
    const revocations = createRevocationSet();
    const learned: string[] = [];
    const feed = createRevocationFeed({
      sql: db,
      revocations,
      clock: { now: () => now },
      onRevoked: (entries) => learned.push(...entries.map((e) => e.serial)),
    });
    expect(await feed.poll()).toBe(1);
    expect(revocations.has(early)).toBe(true);
    expect(revocations.has(expired)).toBe(false); // an expired cert can't connect anyway
    expect(revocations.get(early)).toMatchObject({ reason: 'test', notAfter: now + 20 * hour });

    await revoke(live, now);
    expect(await feed.poll()).toBe(1);
    expect(await feed.poll()).toBe(0); // the overlap window re-reads it: no second notice
    expect(revocations.has(live)).toBe(true);
    expect(learned).toEqual([early, live]);
  });

  it('catches a revocation that commits late with an earlier timestamp (inside the lookback)', async () => {
    const revocations = createRevocationSet();
    // The feed's clock is the database's simulated one (never the wall clock: the certificates expire 20 h after
    // this test's fixed time).
    let clock = now;
    const feed = createRevocationFeed({ sql: db, revocations, lookbackMs: 60_000, clock: { now: () => clock } });
    await feed.poll();
    const a = await cert();
    const b = await cert();
    clock = now + 10_000;
    await setSimClock(db, now + 10_000);
    await revoke(a, now + 10_000);
    expect(await feed.poll()).toBe(1);
    // b's transaction took compute_now() earlier but committed only now.
    await revoke(b, now + 2_000);
    expect(await feed.poll()).toBe(1);
    expect(revocations.has(b)).toBe(true);
  });

  it('learns a revocation that commits behind the lookback at the next full reload', async () => {
    const revocations = createRevocationSet();
    let clock = now + 20_000;
    await setSimClock(db, clock);
    const feed = createRevocationFeed({
      sql: db,
      revocations,
      lookbackMs: 60_000,
      fullReloadMs: 300_000,
      clock: { now: () => clock },
    });
    await feed.poll();
    const recent = await cert();
    const late = await cert();
    clock += 200_000;
    await setSimClock(db, clock);
    await revoke(recent, clock);
    expect(await feed.poll()).toBe(1);
    // A long transaction: it took its time 150 s ago, well behind the 60 s window, and commits now.
    await revoke(late, clock - 150_000);
    expect(await feed.poll()).toBe(0);
    expect(revocations.has(late)).toBe(false);
    // The windowed polls never see it; the full reload does, within fullReloadMs of the last one.
    clock += 100_001;
    await setSimClock(db, clock);
    expect(await feed.poll()).toBe(1);
    expect(revocations.has(late)).toBe(true);
    // With full reloads off it is the old behaviour: only the window.
    const windowOnly = createRevocationSet();
    const noReload = createRevocationFeed({
      sql: db,
      revocations: windowOnly,
      lookbackMs: 60_000,
      fullReloadMs: 0,
      clock: { now: () => clock },
    });
    await noReload.poll();
    const missed = await cert();
    clock += 600_000;
    await setSimClock(db, clock);
    await revoke(await cert(), clock);
    await noReload.poll();
    await revoke(missed, clock - 400_000);
    expect(await noReload.poll()).toBe(0);
    expect(windowOnly.has(missed)).toBe(false);
  });

  it('keeps polling through failures and backs off; a running feed closes the gap within a tick', async () => {
    const revocations = createRevocationSet();
    let broken = true;
    const errors: unknown[] = [];
    const flaky = {
      query: ((text: string, params?: unknown[]) =>
        broken ? Promise.reject(new Error('db down')) : db.query(text, params)) as typeof db.query,
    };
    const feed = createRevocationFeed({
      sql: flaky,
      revocations,
      intervalMs: 20,
      onError: (e) => errors.push(e),
    });
    feed.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(feed.consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(errors.length).toBe(feed.consecutiveFailures);
    feed.stop();

    broken = false;
    const target = await cert();
    const seen = new Promise<number>((resolve) => revocations.subscribe(() => resolve(Date.now())));
    const running = createRevocationFeed({ sql: db, revocations, intervalMs: 20 });
    running.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const revokedAt = Date.now();
    await revoke(target, now + 20_000);
    const at = await seen;
    running.stop();
    expect(at - revokedAt).toBeLessThan(1_000);
    expect(running.consecutiveFailures).toBe(0);
  });
});
