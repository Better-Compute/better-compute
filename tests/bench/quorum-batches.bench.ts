import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { manualClock, shardOf, type SqlExecutor } from '@better-compute/core';
import { useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { postgres } from '@better-compute/postgres';
import {
  createApproverKey,
  createCommandSigningAuthority,
  createNodeCa,
  createSigningKey,
  generateP256KeyPair,
  signBatchApproval,
} from '@better-compute/pki';
import { betterCompute, pkiJoinCrypto } from '@better-compute/server';
import { fakeIam } from '@better-compute/testing';
import { ACME, options } from '../support/server.js';

// The v1.0 destructive-batch quorum at fleet scale (PLAN.md §13): one batch over BENCH_BATCH_LEAVES nodes
// (node.reboot each), then one held command per leaf, then the approval that releases them. Reports the time
// of createBatch (the ownership query plus chunked inserts), enqueue per command (scope membership, signing,
// member row), and the approval (signature checks, releasing every held member). Gate: createBatch well
// under a second at 10k leaves (BENCH_BATCH_GATE_MS, default 1000).
//
//   pnpm bench:scale tests/bench/quorum-batches.bench.ts          PGlite (indicative)
//   BETTER_COMPUTE_POSTGRES_URL=postgres://… pnpm bench:scale …    Postgres
//
// Knobs: BENCH_BATCH_LEAVES (10000), BENCH_BATCH_ENQUEUE (how many members to enqueue, default all).

const postgresUrl = process.env.BETTER_COMPUTE_POSTGRES_URL;
const leaves = Number(process.env.BENCH_BATCH_LEAVES ?? 10_000);
const enqueueCount = Math.min(leaves, Number(process.env.BENCH_BATCH_ENQUEUE ?? leaves));
const gateMs = Number(process.env.BENCH_BATCH_GATE_MS ?? 1000);
const T0 = Date.UTC(2026, 8, 25, 12);
const TOKEN = 'op-token';

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};

describe('§13 batches at fleet scale', () => {
  let db: SqlExecutor;
  let compute: any;
  const approver = createApproverKey();
  const result: Record<string, unknown> = {};

  beforeAll(async () => {
    db = postgresUrl ? postgres({ url: postgresUrl }) : pglite();
    const iam = fakeIam({ callers: { [TOKEN]: { tenantId: ACME, identityId: 'usr_ops' } }, allow: [{}] });
    compute = betterCompute({
      ...options(db, iam),
      clock: manualClock(T0),
      pki: {
        commandSigning: createCommandSigningAuthority({ clock: manualClock(T0 - 60_000) }),
        join: pkiJoinCrypto({
          trustDomain: 'compute.bench',
          nodeCa: createNodeCa({ clock: manualClock(T0 - 60_000) }),
          signingKey: createSigningKey({ clock: manualClock(T0 - 60_000) }),
          encryptionKey: generateP256KeyPair().privateKey,
        }),
        approvers: { keys: [approver.key.spkiDer], threshold: 1 },
      },
    } as never);
    await compute.initialize();
    await useSimClock(db, T0);
    await db.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ('site_bench', $1, 'shared', 'eu', 1)`, [ACME]);
    await db.query(
      `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned, connectivity,
         trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       SELECT 'node_' || lpad(i::text, 26, '0'), 'site_bench', $2, 'host', 'ready', false, false, 'disconnected',
              'platform', 0, 0, 1, 1, $3, 1
         FROM generate_series(1, $1::int) i`,
      [leaves, ACME, shardOf('node_0')],
    );
  }, 600_000);

  afterAll(async () => {
    if (Object.keys(result).length) {
      const report = {
        suite: 'quorum-batches',
        time: new Date().toISOString(),
        database: postgresUrl ? 'postgres' : 'pglite',
        leaves,
        host: { cpus: cpus().length, memoryGiB: Math.round(totalmem() / 2 ** 30) },
        ...result,
      };
      mkdirSync('bench/quorum-batches/results', { recursive: true });
      writeFileSync(
        `bench/quorum-batches/results/${report.time.replace(/[:.]/g, '-')}-${report.database}-${leaves}.json`,
        `${JSON.stringify(report, null, 2)}\n`,
      );
      console.log(JSON.stringify(report, null, 2));
    }
    await compute?.stop?.().catch(() => {});
    await db?.close();
  });

  it(`creates a ${leaves}-leaf batch, enqueues its members held, and releases them with one approval`, async () => {
    const node = (i: number) => `node_${String(i).padStart(26, '0')}`;
    const scope = Array.from({ length: leaves }, (_, i) => ({ subject: node(i + 1), kind: 'node.reboot' }));

    const created0 = performance.now();
    const batch = await db.transaction((tx) =>
      compute.context.commands.createBatch(tx, { tenantId: ACME, scope, reason: `reboot ${leaves} nodes`, notAfterMs: T0 + 3_600_000 }),
    );
    const createMs = performance.now() - created0;
    expect(batch).toMatchObject({ held: true, size: leaves });

    const latencies: number[] = [];
    const enqueue0 = performance.now();
    for (let i = 1; i <= enqueueCount; i++) {
      const started = performance.now();
      await db.transaction((tx) =>
        compute.context.commands.enqueue(tx, {
          nodeId: node(i),
          kind: 'node.reboot',
          payload: undefined,
          idempotencyKey: `bench-${i}`,
          notAfter: T0 + 600_000,
          batchId: batch.batchId,
        }),
      );
      latencies.push(performance.now() - started);
    }
    const enqueueMs = performance.now() - enqueue0;
    const { rows: held } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM commands WHERE not_before = 'infinity'`);
    expect(Number(held[0]!.n)).toBe(enqueueCount);

    const view = await compute.api.commandBatches.get({ token: TOKEN }, { tenantId: ACME, batchId: batch.batchId });
    const sig = signBatchApproval(
      {
        batchId: view.batchId,
        scopeRoot: new Uint8Array(Buffer.from(view.scopeRoot, 'hex')),
        scopeSize: view.scopeSize,
        notAfter: view.notAfter,
        trustDomain: view.trustDomain,
      },
      approver.privateKey,
    );
    const approve0 = performance.now();
    await compute.api.commandBatches.approve(
      { token: TOKEN },
      { tenantId: ACME, batchId: batch.batchId, signature: { kid: sig.kid, sig: Buffer.from(sig.sig).toString('base64url') } },
    );
    const approveMs = performance.now() - approve0;
    const { rows: still } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM commands WHERE not_before = 'infinity'`);
    expect(Number(still[0]!.n)).toBe(0);

    Object.assign(result, {
      createBatchMs: Math.round(createMs),
      enqueue: {
        count: enqueueCount,
        totalMs: Math.round(enqueueMs),
        perSecond: Math.round((enqueueCount / enqueueMs) * 1000),
        p50Ms: +percentile(latencies, 50).toFixed(2),
        p99Ms: +percentile(latencies, 99).toFixed(2),
      },
      approveMs: Math.round(approveMs),
      gate: { createBatchUnderMs: gateMs, met: createMs < gateMs },
    });
    if (process.env.BENCH_BATCH_GATE_MS !== undefined) expect(createMs).toBeLessThan(gateMs);
  }, 1_800_000);
});
