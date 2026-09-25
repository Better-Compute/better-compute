import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import {
  loadCursor,
  pruneAttestationUses,
  pruneBehindCursors,
  pruneSettledCommands,
  pruneUncursoredAuthzChanges,
  retentionModule,
  runRetention,
  saveCursor,
  setSimClock,
  useSimClock,
} from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';

// core/0009_runtime: durable cursors and retention behind every cursor of a stream (PLAN.md §8.4).

let db: SqlExecutor;
const START = Date.UTC(2026, 8, 1);

async function write(topic: string, n: number) {
  for (let i = 0; i < n; i++)
    await db.query(`INSERT INTO outbox (topic, payload) VALUES ($1, '{"tenantId":"t1"}')`, [topic]);
}
const rows = async () =>
  (
    await db.query<{ seq: number; txid_text: string }>(
      'SELECT seq, txid::text AS txid_text FROM outbox ORDER BY outbox.txid, outbox.seq',
    )
  ).rows;

beforeAll(async () => {
  db = pglite();
  await db.migrate();
  await useSimClock(db, START);
});
afterAll(() => db.close());

describe('cursors', () => {
  it('saves and loads a position', async () => {
    expect(await loadCursor(db, 'sink:webhooks')).toBeUndefined();
    await saveCursor(db, { name: 'sink:webhooks', txid: '123', seq: 4 });
    await saveCursor(db, { name: 'sink:webhooks', txid: '130', seq: 9 });
    expect(await loadCursor(db, 'sink:webhooks')).toEqual({ txid: '130', seq: 9 });
    await db.query('DELETE FROM outbox_cursors');
  });
});

describe('pruneBehindCursors', () => {
  it('never prunes a stream without cursors', async () => {
    await write('a', 3);
    await setSimClock(db, START + 2 * 3600_000);
    expect(await pruneBehindCursors(db, 'outbox')).toBe(0);
  });

  it('prunes only what every cursor passed, and only past the minimum age', async () => {
    const all = await rows();
    // Two readers: the slow one is at the second row, the fast one at the last.
    await saveCursor(db, { name: 'slow', txid: all[1]!.txid_text, seq: all[1]!.seq });
    await saveCursor(db, { name: 'fast', txid: all[2]!.txid_text, seq: all[2]!.seq });
    expect(await pruneBehindCursors(db, 'outbox', { minAgeSeconds: 3 * 3600 })).toBe(0); // too young
    expect(await pruneBehindCursors(db, 'outbox', { minAgeSeconds: 3600 })).toBe(2);
    expect((await rows()).map((r) => r.seq)).toEqual([all[2]!.seq]);
  });

  it('works in batches and keeps the authz_changes stream separate', async () => {
    await write('b', 5);
    const all = await rows();
    await saveCursor(db, { name: 'slow', txid: all.at(-1)!.txid_text, seq: all.at(-1)!.seq });
    await saveCursor(db, { name: 'fast', txid: all.at(-1)!.txid_text, seq: all.at(-1)!.seq });
    await setSimClock(db, START + 5 * 3600_000);
    expect(await pruneBehindCursors(db, 'outbox', { batch: 2 })).toBe(2);
    expect(await pruneBehindCursors(db, 'outbox', { batch: 2 })).toBe(2);
    expect(await pruneBehindCursors(db, 'outbox', { batch: 2 })).toBe(2);
    expect(await rows()).toEqual([]);
    await db.query(
      `INSERT INTO authz_changes (type, id, tenant_id, op) VALUES ('pool', 'p1', 't1', 'upsert')`,
    );
    expect(await pruneBehindCursors(db, 'authz_changes', { minAgeSeconds: 0 })).toBe(0); // no authz cursor
    await expect(pruneBehindCursors(db, 'webhooks' as never)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('adds work_queue.attempts, commands.owner and the tenant indexes', async () => {
    const { rows: columns } = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name, column_name) IN (('work_queue', 'attempts'), ('commands', 'owner'), ('outbox', 'created_at'))
        ORDER BY table_name`,
    );
    expect(columns.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
      'commands.owner',
      'outbox.created_at',
      'work_queue.attempts',
    ]);
    const { rows: indexes } = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname IN ('outbox_tenant_cursor', 'usage_windows_tenant', 'join_tokens_tenant_pool') ORDER BY 1`,
    );
    expect(indexes.map((i) => i.indexname)).toEqual([
      'join_tokens_tenant_pool',
      'outbox_tenant_cursor',
      'usage_windows_tenant',
    ]);
  });
});

describe('retentionModule', () => {
  it('is a periodic singleton, and one pass drains every job', async () => {
    const module = retentionModule({ every: '10m' });
    expect(module.reconcilers).toEqual([
      expect.objectContaining({
        name: 'core.retention',
        shardBy: 'none',
        periodic: [{ key: 'pass', every: '10m' }],
      }),
    ]);
    await db.query(
      `INSERT INTO attestation_uses (attestor, subject, expires_at) VALUES ('discovery', $1, compute_now() - interval '1 minute')`,
      [new Uint8Array(32).fill(9)],
    );
    const pass = await runRetention(db, { minAgeSeconds: 0 });
    expect(pass.attestationUses).toBe(1);
    expect(pass).toMatchObject({ joinRequestsExpired: 0 });
    expect(await runRetention(db)).toEqual({
      outbox: 0,
      authzChanges: 0,
      commands: 0,
      attestationUses: 0,
      joinRequestsExpired: 0,
      partitionsCreated: 0,
      inventorySnapshots: 0,
      usageWindows: 0,
      partitionsDropped: 0,
    });
  });
});

describe('pruneAttestationUses (core/0011)', () => {
  const subject = (n: number) => new Uint8Array(32).fill(n);
  it('admits evidence once, and drops only expired rows', async () => {
    const use = (attestor: string, n: number, expiresInSeconds: number | null) =>
      db.query(
        `INSERT INTO attestation_uses (attestor, subject, expires_at)
         VALUES ($1, $2, CASE WHEN $3::int IS NULL THEN NULL ELSE compute_now() + make_interval(secs => $3::int) END)
         ON CONFLICT DO NOTHING`,
        [attestor, subject(n), expiresInSeconds],
      );
    expect((await use('discovery', 1, 60)).rowCount).toBe(1);
    expect((await use('discovery', 1, 60)).rowCount).toBe(0); // a replay is refused
    expect((await use('cloud-iid', 1, null)).rowCount).toBe(1); // another attestor's namespace
    await use('discovery', 2, 3600);
    await setSimClock(db, START + 5 * 3600_000 + 120_000); // two minutes after the uses above
    expect(await pruneAttestationUses(db)).toBe(1);
    const { rows: left } = await db.query<{ attestor: string }>(
      'SELECT attestor FROM attestation_uses ORDER BY attestor',
    );
    expect(left.map((row) => row.attestor)).toEqual(['cloud-iid', 'discovery']);
    await expect(
      db.query(`INSERT INTO attestation_uses (attestor, subject) VALUES ('x', '\\x00')`),
    ).rejects.toThrow();
  });
});

describe('authz_changes without cursors, and settled commands', () => {
  const DAY = 86_400_000;
  let now = START + 6 * 3600_000;

  it('ages out authz_changes only while no reader keeps a cursor', async () => {
    await db.query(`INSERT INTO authz_changes (type, id, tenant_id, op) VALUES ('pool', 'p2', 't1', 'upsert')`);
    await expect(pruneUncursoredAuthzChanges(db, { olderThanSeconds: 60 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await pruneUncursoredAuthzChanges(db)).toBe(0); // younger than a day
    now += 2 * DAY;
    await setSimClock(db, now);
    await db.query(`INSERT INTO authz_changes (type, id, tenant_id, op) VALUES ('pool', 'p3', 't1', 'upsert')`);
    expect(await pruneUncursoredAuthzChanges(db)).toBe(2); // p1 (earlier test) and p2; p3 is fresh
    // A durable reader appears: from now on only its cursor decides.
    await saveCursor(db, { name: 'projection', stream: 'authz_changes', txid: '0', seq: 0 });
    now += 2 * DAY;
    await setSimClock(db, now);
    expect(await pruneUncursoredAuthzChanges(db)).toBe(0);
    await db.query(`DELETE FROM outbox_cursors WHERE name = 'projection'`);
  });

  it('prunes settled commands past the window, never open ones', async () => {
    const command = (id: string, state: string, updatedDaysAgo: number) =>
      db.query(
        `INSERT INTO commands (id, node_id, seq, kind, body, state, not_after, retry_safe, self_terminating, attested,
           idempotency_key, updated_at)
         VALUES ($1, 'node_a', $2, 'diag.nvml', '\\x00', $3, compute_now() + interval '1 day', true, false, false, $1,
           compute_now() - make_interval(days => $4))`,
        [id, Number(id.slice(4)), state, updatedDaysAgo],
      );
    await command('cmd_1', 'succeeded', 40);
    await command('cmd_2', 'failed', 31);
    await command('cmd_3', 'expired', 5);
    await command('cmd_4', 'running', 90); // open: never pruned, however old
    await command('cmd_5', 'cancelled', 45);
    await expect(pruneSettledCommands(db, { olderThanDays: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await pruneSettledCommands(db, { batch: 2 })).toBe(2);
    expect(await pruneSettledCommands(db)).toBe(1);
    const { rows: left } = await db.query<{ id: string }>('SELECT id FROM commands ORDER BY id');
    expect(left.map((row) => row.id)).toEqual(['cmd_3', 'cmd_4']);
    expect(await runRetention(db, { commandsOlderThanDays: 1 })).toMatchObject({ commands: 1 });
    expect(await runRetention(db, { commandsOlderThanDays: false, authzChangesMaxAgeSeconds: false })).toMatchObject({ commands: 0, authzChanges: 0 });
  });
});
