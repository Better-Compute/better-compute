import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { create, toBinary } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { shardOf, type EventPublisher, type SqlExecutor, type SqlTx, type WorkQueue } from '@better-compute/core';
import {
  applyInventory,
  ingestInventorySections,
  recordInventoryHashesMany,
  sha256Hex,
} from '@better-compute/inventory';
import { postgres } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  CpuSectionSchema,
  GpuSchema,
  GpusSectionSchema,
  MemorySectionSchema,
  NicSchema,
  NicsSectionSchema,
  NumaNodeSchema,
  OsSectionSchema,
  SystemSectionSchema,
  type InventorySectionName,
} from '@better-compute/protocol';

// Inventory ingestion at fleet size (bench/inventory-ingest/README.md, PLAN §10.1), the path a Hello
// and every 10th heartbeat take: the gateway batches hash reports (recordInventoryHashesMany) and
// pulled sections (ingestInventorySections), and the Inventory reconciler applies each node's set in
// its own transaction (applyInventory: snapshot, diff, devices, health, labels, conditions, events).
// Measured over BENCH_INV_NODES nodes of 8 H100s each:
//
//   join storm   every node reports, is asked for every section, sends them, and is applied
//   steady       every node reports the same hashes again (nothing to pull, nothing to apply)
//   change       one GPU section changes on every node (a driver update): report, pull, apply
//
// with the rate, latency percentiles and SQL statements per node of each step, and with
// BENCH_INV_PROFILE=1 the time per statement of applyInventory. The steady need: a heartbeat every
// 10 s and a hash report every 10th, so nodes/100 reports/s.
//
//   pnpm bench:scale -- tests/bench/inventory-ingest.bench.ts
//   BETTER_COMPUTE_POSTGRES_URL=postgres://… pnpm bench:scale -- tests/bench/inventory-ingest.bench.ts

const postgresUrl = process.env.BETTER_COMPUTE_POSTGRES_URL;
const nodes = Number(process.env.BENCH_INV_NODES ?? 10_000);
const batch = Number(process.env.BENCH_INV_BATCH ?? 500);
const profile = process.env.BENCH_INV_PROFILE === '1';
const TENANT = 'tenant-bench';
const SITE = 'site_bench';
const POOL = 'pool_bench';
const reportEverySeconds = 100;

const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0;
const round = (n: number, digits = 2) => Number(n.toFixed(digits));

function commit(): string {
  const git = `${process.env.LOCALAPPDATA ?? ''}\\GitHubDesktop\\app-3.6.5\\resources\\app\\git\\cmd\\git.exe`;
  for (const bin of ['git', git])
    try {
      return execFileSync(bin, ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
      // try the next one
    }
  return 'unknown';
}

/** Counts (and with `profile` times) every statement, by its first 80 characters. */
function instrumented(db: SqlExecutor) {
  const statements = new Map<string, { count: number; ms: number }>();
  let total = 0;
  const timed = (tx: SqlTx): SqlTx => ({
    async query(text, params) {
      total++;
      if (!profile) return tx.query(text, params);
      const before = performance.now();
      try {
        return await tx.query(text, params);
      } finally {
        const key = text.replace(/\s+/g, ' ').trim().slice(0, 80);
        const entry = statements.get(key) ?? { count: 0, ms: 0 };
        entry.count++;
        entry.ms += performance.now() - before;
        statements.set(key, entry);
      }
    },
  });
  const wrapped: SqlExecutor = {
    dialect: db.dialect,
    kind: db.kind,
    query: (text, params) => timed(db).query(text, params),
    transaction: (fn, options) => db.transaction((tx) => fn(timed(tx)), options),
    migrate: (extra) => db.migrate(extra),
    close: () => db.close(),
  };
  return {
    db: wrapped,
    statements,
    take() {
      const n = total;
      total = 0;
      return n;
    },
  };
}

// The work queue and outbox as the server's SQL implementations write them (one row per key; a row per event).
const work: WorkQueue = {
  async enqueue(tx, kind, key) {
    await tx.query(
      `INSERT INTO work_queue (kind, key, shard, gen, not_before) VALUES ($1, $2, 0, 1, compute_now())
       ON CONFLICT (kind, key) DO UPDATE SET gen = work_queue.gen + 1`,
      [kind, key],
    );
  },
  async enqueueMany(tx, kind, keys) {
    await tx.query(
      `INSERT INTO work_queue (kind, key, shard, gen, not_before) SELECT $1, k, 0, 1, compute_now() FROM unnest($2::text[]) AS k
       ON CONFLICT (kind, key) DO UPDATE SET gen = work_queue.gen + 1`,
      [kind, keys],
    );
  },
};
const events: EventPublisher = {
  async publish(tx, event) {
    await tx.query('INSERT INTO outbox (topic, payload) VALUES ($1, $2::jsonb)', [event.type, JSON.stringify(event.data)]);
  },
};

/** One node's inventory, as bcd reports an HGX H100 (fakehw's shape). */
function sectionsOf(index: number, driver = '550.90.07'): Record<InventorySectionName, Uint8Array> {
  const id = index.toString(16).padStart(8, '0');
  const GiB = 1024n ** 3n;
  return {
    system: toBinary(SystemSectionSchema, create(SystemSectionSchema, { productUuid: `4c4c4544-0042-3510-8052-${id}0000`, serial: `SN-${id}` })),
    cpu: toBinary(
      CpuSectionSchema,
      create(CpuSectionSchema, {
        vendor: 'GenuineIntel',
        model: 'Intel(R) Xeon(R) Platinum 8480+',
        architecture: 'x86_64',
        sockets: 2,
        cores: 112,
        threads: 224,
        flags: ['amx_tile', 'avx512f'],
        numaNodes: [0, 1].map((n) => create(NumaNodeSchema, { id: n, cpus: n ? '56-111,168-223' : '0-55,112-167', memoryBytes: 1024n * GiB })),
      }),
    ),
    memory: toBinary(MemorySectionSchema, create(MemorySectionSchema, { totalBytes: 2048n * GiB })),
    nics: toBinary(
      NicsSectionSchema,
      create(NicsSectionSchema, { nics: [create(NicSchema, { name: 'eno1', mac: `3c:ec:ef:${id.slice(2, 4)}:${id.slice(4, 6)}:${id.slice(6, 8)}` })] }),
    ),
    gpus: toBinary(
      GpusSectionSchema,
      create(GpusSectionSchema, {
        driverVersion: driver,
        cudaDriverVersion: '12.4',
        gpus: Array.from({ length: 8 }, (_, g) =>
          create(GpuSchema, { index: g, uuid: `GPU-${id}-0000-4b3a-9e5d-00000000000${g}`, name: 'NVIDIA H100 80GB HBM3', vramBytes: 80n * GiB, numaNode: g < 4 ? 0 : 1 }),
        ),
      }),
    ),
    os: toBinary(OsSectionSchema, create(OsSectionSchema, { distro: 'ubuntu', kernel: '6.8.0', kvm: true })),
  } as Record<InventorySectionName, Uint8Array>;
}

async function seed(db: SqlExecutor, ids: string[]) {
  await db.query(`INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, $2, 'shared', 'bench', 1)`, [SITE, TENANT]);
  await db.query(
    `INSERT INTO pools (id, owner_tenant_id, site_id, class, gpu_model, sharing, agent, policy, version)
     VALUES ($1, $2, $3, 'metal-host', 'H100', 'exclusive', 'bcd', '{"expect":{"gpuCount":8}}', 1)`,
    [POOL, TENANT, SITE],
  );
  for (let i = 0; i < ids.length; i += 1_000) {
    const chunk = ids.slice(i, i + 1_000);
    await db.query(
      `INSERT INTO nodes (id, site_id, pool_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
         connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       SELECT v.id, $2, $3, $4, 'host', 'adopted', false, false, 'connected', 'platform', 1, 1, 1, 1, v.shard, 1
       FROM unnest($1::text[], $5::smallint[]) AS v(id, shard)`,
      [chunk, SITE, POOL, TENANT, chunk.map(shardOf)],
    );
  }
}

interface Step {
  step: string;
  perSecond: number;
  seconds: number;
  latencyMs?: { p50: number; p99: number; max: number };
  statementsPerNode: number;
  perStatement?: { sql: string; perNode: number; msPerNode: number }[];
}

describe('inventory ingestion', () => {
  it(`reports, pulls and applies ${nodes} nodes' inventories`, { timeout: 3 * 60 * 60_000 }, async () => {
    const adapter = postgresUrl ? 'postgres' : 'pglite';
    const raw: SqlExecutor = postgresUrl ? postgres({ url: postgresUrl }) : pglite();
    await raw.migrate();
    const run = Math.random().toString(36).slice(2, 8);
    const ids = Array.from({ length: nodes }, (_, i) => `node_inv_${run}_${i}`);
    await seed(raw, ids);
    const counted = instrumented(raw);
    const db = counted.db;
    let current = ids.map((_, i) => sectionsOf(i));
    const hashesOf = (sections: Record<string, Uint8Array>) =>
      Object.fromEntries(Object.entries(sections).map(([name, bytes]) => [name, sha256Hex(bytes)]));

    const measure = async (step: string, work: () => Promise<number[] | void>, count = nodes): Promise<Step> => {
      counted.take();
      counted.statements.clear();
      const started = performance.now();
      const latencies = (await work()) ?? [];
      const ms = performance.now() - started;
      const statements = counted.take();
      latencies.sort((a, b) => a - b);
      const result: Step = {
        step,
        perSecond: Math.round((count / ms) * 1_000),
        seconds: round(ms / 1_000, 1),
        ...(latencies.length
          ? { latencyMs: { p50: round(percentile(latencies, 50)), p99: round(percentile(latencies, 99)), max: round(latencies.at(-1) ?? 0) } }
          : {}),
        statementsPerNode: round(statements / count),
        ...(profile
          ? {
              perStatement: [...counted.statements]
                .sort((a, b) => b[1].ms - a[1].ms)
                .slice(0, 12)
                .map(([sql, { count: n, ms: total }]) => ({ sql, perNode: round(n / count), msPerNode: round(total / count, 3) })),
            }
          : {}),
      };
      console.log(JSON.stringify(result));
      return result;
    };

    // The gateway's batches: hash reports, then the sections they asked for.
    const report = () =>
      measure('report (batched hashes)', async () => {
        const asked: InventorySectionName[][] = [];
        for (let i = 0; i < nodes; i += batch) {
          const slice = ids.slice(i, i + batch);
          const answers = await db.transaction((tx) =>
            recordInventoryHashesMany(tx, work, slice.map((nodeId, j) => ({ nodeId, hashes: hashesOf(current[i + j]!), bootId: 'boot-1' }))),
          );
          for (const answer of answers) {
            if (answer instanceof Error) throw answer;
            asked.push(answer);
          }
        }
        pulls = asked;
      });
    let pulls: InventorySectionName[][] = [];
    const ingest = () =>
      measure('ingest (batched sections)', async () => {
        const entries = pulls.flatMap((names, i) =>
          names.map((name) => ({ nodeId: ids[i]!, section: { section: name, content: current[i]![name], sha256: sha256Hex(current[i]![name]) } })),
        );
        for (let i = 0; i < entries.length; i += batch) {
          const results = await db.transaction((tx) => ingestInventorySections(tx, work, entries.slice(i, i + batch)));
          const failed = results.find((r) => r !== undefined);
          if (failed) throw failed;
        }
      });
    const apply = (expectStatus: string) =>
      measure('apply (per node)', async () => {
        const latencies: number[] = [];
        for (const nodeId of ids) {
          const before = performance.now();
          const result = await applyInventory(db, nodeId, { events, work });
          latencies.push(performance.now() - before);
          if (result.status !== expectStatus) throw new Error(`${nodeId}: ${result.status}`);
        }
        return latencies;
      });

    const joinStorm = [await report(), await ingest(), await apply('applied')];
    expect(pulls.every((names) => names.length === 6)).toBe(true);
    const steady = [await report()];
    expect(pulls.every((names) => names.length === 0)).toBe(true);
    current = ids.map((_, i) => sectionsOf(i, '570.86.15'));
    const change = [await report(), await ingest(), await apply('applied')];
    expect(pulls.every((names) => names.length === 1 && names[0] === 'gpus')).toBe(true);

    const snapshots = (await raw.query<{ n: number }>('SELECT count(*)::int AS n FROM inventory_snapshots')).rows[0]!.n;
    const devices = (await raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM devices WHERE class = 'gpu'`)).rows[0]!.n;
    await raw.close();

    const need = nodes / reportEverySeconds;
    const result = {
      suite: 'inventory-ingest',
      date: new Date().toISOString(),
      commit: commit(),
      referenceHardware: process.env.BENCH_REFERENCE === '1',
      machine: { cpus: cpus().length, cpuModel: cpus()[0]?.model?.trim(), memoryBytes: totalmem() },
      node: process.version,
      adapter,
      config: { nodes, batch, gpusPerNode: 8, sections: 6 },
      joinStorm,
      steady,
      change,
      needs: {
        steadyReportsPerSecond: need,
        steadyHeadroom: round(steady[0]!.perSecond / need, 1),
        // Every node (re)joining at once (a gateway takeover re-Hellos them all; a fleet install).
        joinStormSeconds: round(joinStorm.reduce((sum, s) => sum + s.seconds, 0), 1),
      },
      rows: { snapshots: Number(snapshots), gpuDevices: Number(devices) },
    };
    const dir = new URL('../../bench/inventory-ingest/results/', import.meta.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL(`${result.date.replace(/[:.]/g, '-')}-${adapter}-${nodes}.json`, dir), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
    expect(Number(devices)).toBe(nodes * 8);
  });
});
