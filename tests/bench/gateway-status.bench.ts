import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { ComputeError, shardOf, type SqlExecutor, type SqlTx } from '@better-compute/core';
import { createGateway, statusKey, xidStatusHandler } from '@better-compute/gateway';
import { postgres } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { ConditionStatus, SectionState, StatusReportSchema, type StatusReport } from '@better-compute/protocol';

// The gateway's status path at fleet size (bench/gateway-status/README.md): every bcd sends a full
// StatusReport after each converge pass, so at least once per 10-minute drift pass, and all at once
// when a spec reaches a whole pool or a gateway takes over. The gateway coalesces a session's
// reports and its `status` job applies them one transaction each (store.status: observed_generation,
// the node.status event, then the status handlers, here the production xidStatusHandler with bcd's
// node conditions and host pressure). Measured per pass over BENCH_STATUS_NODES nodes:
//
//   drift     the steady report (sections converged, pressure, no condition): nothing changes but the
//             gauges, so node.status is not published (statusKey); once more with every report
//             published, as before the key, for comparison
//   raise     every node raises RebootRequired + HostManagedExternally (a condition write per node)
//   clear     the same conditions clear again
//
// with reports/s and latency percentiles, SQL statements per report and, with BENCH_STATUS_PROFILE=1,
// time per statement. The need: nodes/600 reports/s steady; a fleet-wide burst drains in nodes/rate s.
//
//   pnpm bench:scale -- tests/bench/gateway-status.bench.ts                                   PGlite
//   BETTER_COMPUTE_POSTGRES_URL=postgres://… pnpm bench:scale -- tests/bench/gateway-status.bench.ts

const postgresUrl = process.env.BETTER_COMPUTE_POSTGRES_URL;
const nodes = Number(process.env.BENCH_STATUS_NODES ?? 10_000);
const profile = process.env.BENCH_STATUS_PROFILE === '1';
const TENANT = 'tenant-bench';
const SITE = 'site_bench';
const driftPassSeconds = 600;

const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0;

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

/** Counts (and with `profile` times) every statement the gateway runs, by its first 80 characters. */
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

async function seed(db: SqlExecutor, ids: string[]) {
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, $2, 'shared', 'bench', 1) ON CONFLICT (id) DO NOTHING`,
    [SITE, TENANT],
  );
  for (let i = 0; i < ids.length; i += 1_000) {
    const chunk = ids.slice(i, i + 1_000);
    await db.query(
      `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
         connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       SELECT v.id, $2, $3, 'host', 'adopted', false, false, 'connected', 'platform', 5, 0, 1, 1, v.shard, 1
       FROM unnest($1::text[], $4::smallint[]) AS v(id, shard)`,
      [chunk, SITE, TENANT, chunk.map(shardOf)],
    );
  }
}

/** bcd's report after a converge pass (spec.go): every section converged, host pressure, `conditions`. */
function report(generation: number, conditions: string[], cpu: number): StatusReport {
  const sections = ['devices', 'access', 'instances', 'telemetry', 'host', 'daemon'];
  return create(StatusReportSchema, {
    observedGeneration: BigInt(generation),
    appliedGeneration: BigInt(generation),
    appliedSpecHash: new Uint8Array(32).fill(7),
    sections: sections.map((section) =>
      section === 'host' && conditions.includes('HostManagedExternally')
        ? {
            section,
            generation: BigInt(generation),
            state: SectionState.UNSUPPORTED,
            reason: 'HostManagedExternally',
            message: 'the host is managed outside bcd',
          }
        : { section, generation: BigInt(generation), state: SectionState.CONVERGED },
    ),
    // The gauges move on every pass.
    pressure: { cpuSomeAvg10: cpu, memorySomeAvg10: 0.2, ioSomeAvg10: 0.8, stealPct: 0 },
    volumeStorage: { totalBytes: 4n << 40n, availableBytes: (3n << 40n) - BigInt(Math.round(cpu * 1e6)) },
    conditions: conditions
      .filter((type) => type !== 'HostManagedExternally')
      .map((type) => ({ type, status: ConditionStatus.TRUE, reason: type, message: `${type} (bench)` })),
  });
}

describe('gateway status path', () => {
  it(`applies ${nodes} nodes' status reports per drift pass`, { timeout: 60 * 60_000 }, async () => {
    const adapter = postgresUrl ? 'postgres' : 'pglite';
    const raw: SqlExecutor = postgresUrl ? postgres({ url: postgresUrl }) : pglite();
    await raw.migrate();
    const run = Math.random().toString(36).slice(2, 8);
    const ids = Array.from({ length: nodes }, (_, i) => `node_status_${run}_${i}`);
    const seedStart = performance.now();
    await seed(raw, ids);
    const seedMs = Math.round(performance.now() - seedStart);
    const counted = instrumented(raw);
    const gateway = createGateway({
      region: 'bench',
      database: counted.db,
      manual: true,
      services: {
        join: () => Promise.reject(new ComputeError('NOT_IMPLEMENTED', 'bench')),
        renew: () => Promise.reject(new ComputeError('NOT_IMPLEMENTED', 'bench')),
        secret: () => Promise.reject(new ComputeError('NOT_IMPLEMENTED', 'bench')),
      },
      reports: { status: [xidStatusHandler] },
    });

    // One pass: every node's report, applied in turn as the status job does, each node on one session:
    // node.status is published when the report's statusKey differs from the session's last one
    // (`publishAll`: every report, as before the key).
    const published = new Map<string, string>();
    let cpu = 1;
    const pass = async (name: string, generation: number, conditions: string[], publishAll = false) => {
      counted.take();
      counted.statements.clear();
      const body = report(generation, conditions, (cpu += 0.1));
      const latencies: number[] = [];
      const started = performance.now();
      for (const nodeId of ids) {
        const before = performance.now();
        const key = statusKey(body);
        await gateway.store.status(nodeId, TENANT, body, { publish: publishAll || key !== published.get(nodeId) });
        published.set(nodeId, key);
        latencies.push(performance.now() - before);
      }
      const ms = performance.now() - started;
      const statements = counted.take();
      latencies.sort((a, b) => a - b);
      const result = {
        pass: name,
        reportsPerSecond: Math.round((nodes / ms) * 1_000),
        passSeconds: Math.round(ms / 100) / 10,
        latencyMs: {
          p50: Number(percentile(latencies, 50).toFixed(2)),
          p99: Number(percentile(latencies, 99).toFixed(2)),
          max: Number((latencies.at(-1) ?? 0).toFixed(2)),
        },
        statementsPerReport: Number((statements / nodes).toFixed(2)),
        ...(profile
          ? {
              perStatement: [...counted.statements]
                .sort((a, b) => b[1].ms - a[1].ms)
                .slice(0, 12)
                .map(([sql, { count, ms: total }]) => ({
                  sql,
                  perReport: Number((count / nodes).toFixed(2)),
                  msPerReport: Number((total / nodes).toFixed(3)),
                })),
            }
          : {}),
      };
      console.log(JSON.stringify(result));
      return result;
    };

    // Warm-up at generation 1 (first pressure and observed_generation writes), then the three passes.
    const warm = await pass('warm-up', 1, []);
    const driftPublishAll = await pass('drift, every report published', 1, [], true);
    const drift = await pass('drift', 1, []);
    const raise = await pass('raise', 2, ['RebootRequired', 'HostManagedExternally']);
    const clear = await pass('clear', 2, []);
    const outbox = (
      await raw.query<{ n: number; bytes: number }>(
        `SELECT count(*)::int AS n, coalesce(sum(pg_column_size(payload)), 0)::bigint AS bytes FROM outbox WHERE topic = 'node.status'`,
      )
    ).rows[0]!;
    const conditions = (
      await raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM node_conditions WHERE type IN ('RebootRequired', 'HostManagedExternally')`)
    ).rows[0]!;
    await raw.close();

    const need = nodes / driftPassSeconds;
    const result = {
      suite: 'gateway-status',
      date: new Date().toISOString(),
      commit: commit(),
      referenceHardware: process.env.BENCH_REFERENCE === '1',
      machine: { cpus: cpus().length, cpuModel: cpus()[0]?.model?.trim(), memoryBytes: totalmem() },
      node: process.version,
      adapter,
      config: { nodes, driftPassSeconds, handlers: ['xidStatusHandler'] },
      seedMs,
      passes: [warm, driftPublishAll, drift, raise, clear],
      steady: {
        neededReportsPerSecond: Number(need.toFixed(1)),
        headroom: Number((drift.reportsPerSecond / need).toFixed(1)),
        // A spec reaching every node, or a gateway takeover: the whole fleet reports at once.
        fleetBurstDrainSeconds: Math.round(nodes / drift.reportsPerSecond),
      },
      outbox: { nodeStatusEvents: Number(outbox.n), bytesPerEvent: Math.round(Number(outbox.bytes) / Math.max(1, Number(outbox.n))) },
      conditionRows: Number(conditions.n),
    };
    const dir = new URL('../../bench/gateway-status/results/', import.meta.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL(`${result.date.replace(/[:.]/g, '-')}-${adapter}-${nodes}.json`, dir), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));

    // warm-up, drift with every report published, raise and clear: the keyed drift pass published nothing.
    expect(Number(outbox.n)).toBe(nodes * 4);
    expect(Number(conditions.n)).toBe(nodes * 2);
  });
});
