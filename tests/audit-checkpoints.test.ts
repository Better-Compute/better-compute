import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@better-compute/core';
import {
  detachHistoryPartition,
  ensureHistoryPartitions,
  setSimClock,
  useSimClock,
} from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { createAuditSigningKey } from '@better-compute/pki';
import {
  auditMigrations,
  auditModule,
  checkpointAudit,
  markAuditArchived,
  proveAuditEvent,
  verifyAuditCheckpoints,
  verifyAuditProof,
} from '@better-compute/audit';

// Signed per-tenant Merkle checkpoints over audit_events (PLAN.md §13, v0.4).

let db: SqlExecutor;
const signer = createAuditSigningKey();
const trust = { publicKey: signer.publicKey };
let n = 0;

beforeAll(async () => {
  db = pglite();
  await db.migrate([...auditMigrations]);
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  for (const table of ['audit_checkpoints', 'audit_checkpoint_cursor', 'audit_events'])
    await db.query(`DELETE FROM ${table}`);
});

/** Records `count` audit events for a tenant in one transaction. */
const record = (tenantId: string, count = 1) =>
  db.transaction(async (tx) => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `aud_${String(++n).padStart(6, '0')}`;
      ids.push(id);
      await tx.query(
        `INSERT INTO audit_events (id, tenant_id, action, resource_type, resource_id, admission, details)
         VALUES ($1, $2, 'compute:reservations:create', 'reservation', $3, $4::jsonb, $5::jsonb)`,
        [
          id,
          tenantId,
          `rsv_${n}`,
          JSON.stringify({ identityId: 'idn_alice' }),
          JSON.stringify({ gpus: n }),
        ],
      );
    }
    return ids;
  });

const problems = async (tenantId: string, keys = trust) =>
  (await verifyAuditCheckpoints(db, { tenantId, trust: keys })).problems.map((p) => p.code);

describe('checkpointAudit', () => {
  it('seals each tenant’s committed rows into signed, hash-linked checkpoints', async () => {
    await record('ten_a', 12);
    await record('ten_b', 3);
    const first = await checkpointAudit(db, { signer });
    expect(first).toMatchObject({ events: 15, more: false });
    expect(
      first.checkpoints.map((c) => [
        c.body.tenantId,
        c.body.sequence,
        c.body.size,
        c.body.previous,
      ]),
    ).toEqual([
      ['ten_a', 1, 12, null],
      ['ten_b', 1, 3, null],
    ]);
    expect(await checkpointAudit(db, { signer })).toEqual({
      checkpoints: [],
      events: 0,
      more: false,
    });

    await record('ten_a', 5);
    const second = await checkpointAudit(db, { signer });
    expect(second.checkpoints).toHaveLength(1);
    expect(second.checkpoints[0]!.body).toMatchObject({
      sequence: 2,
      size: 5,
      previous: expect.any(String),
    });
    expect(second.checkpoints[0]!.body.from).toBe(first.checkpoints[0]!.body.to);

    const report = await verifyAuditCheckpoints(db, { tenantId: 'ten_a', trust });
    expect(report).toEqual({
      ok: true,
      tenantId: 'ten_a',
      checkpoints: 2,
      events: 17,
      unsealed: 0,
      archived: [],
      archivedMonths: [],
      problems: [],
    });
    await record('ten_a', 2);
    expect((await verifyAuditCheckpoints(db, { tenantId: 'ten_a', trust })).unsealed).toBe(2);
  });

  it('pages large backlogs across passes, with digit-boundary cursors', async () => {
    await record('ten_a', 25);
    const passes: number[] = [];
    for (;;) {
      const pass = await checkpointAudit(db, { signer, limit: 7 });
      passes.push(pass.events);
      if (!pass.more) break;
    }
    expect(passes).toEqual([7, 7, 7, 4]);
    expect(await verifyAuditCheckpoints(db, { tenantId: 'ten_a', trust })).toMatchObject({
      ok: true,
      checkpoints: 4,
      events: 25,
    });
  });
});

describe('verifyAuditCheckpoints finds tampering', () => {
  beforeEach(async () => {
    await record('ten_a', 6);
    await checkpointAudit(db, { signer });
    await record('ten_a', 4);
    await checkpointAudit(db, { signer });
  });

  it('an edited row', async () => {
    await db.query(
      `UPDATE audit_events SET details = '{"gpus":999}' WHERE tenant_id = 'ten_a' AND id = (SELECT min(id) FROM audit_events)`,
    );
    expect(await problems('ten_a')).toEqual(['root']);
  });

  it('a deleted row', async () => {
    await db.query(`DELETE FROM audit_events WHERE id = (SELECT max(id) FROM audit_events)`);
    expect(await problems('ten_a')).toEqual(['size', 'root']);
  });

  it('a row slipped into a sealed range', async () => {
    const { rows } = await db.query<{ txid: string }>(
      `SELECT txid::text AS txid FROM audit_events ORDER BY txid, seq LIMIT 1`,
    );
    await db.query(
      `INSERT INTO audit_events (id, tenant_id, action, resource_type, resource_id, txid, seq)
       VALUES ('aud_forged', 'ten_a', 'compute:nodes:ssh-root', 'node', 'node_x', $1::xid8, 1)`,
      [rows[0]!.txid],
    );
    expect(await problems('ten_a')).toEqual(['size', 'root']);
  });

  it('a removed checkpoint, a rewritten body, and the wrong key', async () => {
    await db.query(`DELETE FROM audit_checkpoints WHERE sequence = 1`);
    expect(await problems('ten_a')).toEqual(['gap', 'chain']);
    await db.query(`UPDATE audit_checkpoints SET body = replace(body, '"size":4', '"size":5')`);
    expect(await problems('ten_a')).toEqual(expect.arrayContaining(['signature', 'size']));
    const other = createAuditSigningKey();
    expect(await problems('ten_a', { publicKey: other.publicKey })).toContain('signature');
  });
});

describe('inclusion proofs', () => {
  it('prove one event to a third party offline, and fail for anything altered', async () => {
    const ids = await record('ten_a', 9);
    await record('ten_b', 2);
    await expect(
      proveAuditEvent(db, { tenantId: 'ten_a', eventId: ids[4]! }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await checkpointAudit(db, { signer });
    for (const id of ids) {
      const proof = JSON.parse(
        JSON.stringify(await proveAuditEvent(db, { tenantId: 'ten_a', eventId: id })),
      );
      expect(verifyAuditProof(proof, trust), id).toBe(true);
    }
    const proof = await proveAuditEvent(db, { tenantId: 'ten_a', eventId: ids[4]! });
    expect(proof).toMatchObject({ index: 4, event: { id: ids[4], tenantId: 'ten_a' } });
    expect(
      verifyAuditProof({ ...proof, event: { ...proof.event, details: { gpus: 0 } } }, trust),
    ).toBe(false);
    expect(verifyAuditProof({ ...proof, index: 5 }, trust)).toBe(false);
    expect(verifyAuditProof(proof, { publicKey: createAuditSigningKey().publicKey })).toBe(false);
    await expect(
      proveAuditEvent(db, { tenantId: 'ten_b', eventId: ids[0]! }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('archived months', () => {
  it('reports sealed months detached after markAuditArchived as archived, and catches the rest', async () => {
    const store = pglite();
    try {
      await store.migrate([...auditMigrations]);
      await useSimClock(store, Date.UTC(2026, 0, 10));
      await store.transaction((tx) => ensureHistoryPartitions(tx, { monthsAhead: 2 }));
      let k = 0;
      const recordAt = async (day: string, count: number) => {
        for (let i = 0; i < count; i++)
          await store.query(
            `INSERT INTO audit_events (id, tenant_id, occurred_at, action, resource_type, resource_id, details)
             VALUES ($1, 'ten_a', $2::timestamptz, 'compute:nodes:cordon', 'node', 'node_1', $3::jsonb)`,
            [`arc_${++k}`, `${day}T12:00:00Z`, JSON.stringify({ k })],
          );
      };
      await recordAt('2026-01-12', 4);
      await checkpointAudit(store, { signer });
      await setSimClock(store, Date.UTC(2026, 1, 10));
      await recordAt('2026-02-11', 3);
      await checkpointAudit(store, { signer });
      await setSimClock(store, Date.UTC(2026, 2, 5));
      const verify = () => verifyAuditCheckpoints(store, { tenantId: 'ten_a', trust });

      // Only past months whose rows are all sealed can be archived.
      await expect(markAuditArchived(store, { month: '2026-03' })).rejects.toMatchObject({
        code: 'INVALID_STATE',
      });
      await recordAt('2026-02-20', 1);
      await expect(markAuditArchived(store, { month: '2026-02' })).rejects.toThrow(/not sealed/);
      await expect(markAuditArchived(store, { month: '2026-1' })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      await checkpointAudit(store, { signer });
      expect(await markAuditArchived(store, { month: '2026-01', by: 'ops' })).toMatchObject({
        month: '2026-01',
      });
      await markAuditArchived(store, { month: '2026-01' });

      // Marked but still attached: verified as usual, so an edited row still shows.
      expect(await verify()).toMatchObject({ ok: true, archived: [], archivedMonths: ['2026-01'] });
      await store.query(`UPDATE audit_events SET details = '{"k":99}' WHERE id = 'arc_1'`);
      expect((await verify()).problems.map((p) => p.code)).toEqual(['root']);
      await store.query(`UPDATE audit_events SET details = '{"k":1}' WHERE id = 'arc_1'`);

      // Detached: January's checkpoint is archived (chain and signature still checked), February verifies.
      await store.transaction((tx) =>
        detachHistoryPartition(tx, 'audit_events', 'audit_events_p202601'),
      );
      const report = await verify();
      expect(report).toMatchObject({
        ok: true,
        checkpoints: 3,
        events: 4,
        archived: [{ sequence: 1, months: ['2026-01'], partial: false }],
      });

      // A month detached without being marked archived is missing rows, as tampering would be.
      await store.transaction((tx) =>
        detachHistoryPartition(tx, 'audit_events', 'audit_events_p202602'),
      );
      expect((await verify()).problems.map((p) => [p.code, p.sequence])).toEqual([
        ['size', 2],
        ['root', 2],
        ['size', 3],
        ['root', 3],
      ]);
    } finally {
      await store.close();
    }
  });
});

describe('auditModule', () => {
  it('runs hourly checkpoints and warns about rows left unsealed', async () => {
    const module = auditModule({ signer });
    expect(module.name).toBe('audit');
    expect(module.migrations?.map((m) => m.name)).toEqual([
      'audit/0001_checkpoints',
      'audit/0002_archives',
    ]);
    const [reconciler] = module.reconcilers!;
    expect(reconciler).toMatchObject({
      name: 'audit.checkpoint',
      shardBy: 'none',
      periodic: [{ key: 'checkpoint', every: '1h' }],
    });
    await record('ten_a', 3);
    await db.query(`UPDATE audit_events SET occurred_at = occurred_at - interval '4 hours'`);
    expect((await module.selfCheck!({ sql: db } as never)).map((f) => f.check)).toEqual([
      'audit.checkpoints',
    ]);
    expect(await reconciler!.run({ sql: db } as never, 'checkpoint')).toBe('DONE');
    expect(await module.selfCheck!({ sql: db } as never)).toEqual([]);
  });
});
