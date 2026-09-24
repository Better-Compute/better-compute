import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect, type ClientHttp2Session, type ClientHttp2Stream } from 'node:http2';
import { cpus, totalmem } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import { ComputeError, newId, shardOf, type SqlExecutor } from '@better-compute/core';
import {
  AGENT_GATEWAY_SERVICE,
  createGateway,
  frameMessage,
  GrpcCode,
  MessageDecoder,
  serveGateway,
} from '@better-compute/gateway';
import { postgres } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  AgentFrameSchema,
  AgentRole,
  CommandBodySchema,
  CommandState,
  decodeServerFrame,
  encodeAgentFrame,
  encodeMessage,
  Lane,
  unwrapCommand,
} from '@better-compute/protocol';

// The v0.1 gateway gate (PLAN.md §16, bench/REFERENCE.md "gateway-streams"): one Node gateway holds
// ≥5,000 sessions at 10 s heartbeats for 30 min with dispatch p99 <500 ms and RSS <2 GiB, or D20 (a
// Go gateway) is decided before v0.2. Simulated daemons speak the real gRPC protocol over HTTP/2;
// commands are enqueued at a steady rate and timed from enqueue commit to frame arrival.
//
//   BETTER_COMPUTE_POSTGRES_URL=postgres://… BENCH_GW_DURATION_MS=1800000 pnpm bench:scale   the gate
//   pnpm bench:scale                                                                      PGlite, indicative
//
// Knobs: BENCH_GW_SESSIONS (5000), BENCH_GW_DURATION_MS (60000 after the ramp), BENCH_GW_COMMANDS_PER_S (50,
// §8.6), BENCH_GW_STREAMS_PER_CONNECTION (100), BENCH_GW_HEARTBEAT_MS (10000), BENCH_GW_GATE=1 to fail
// the run when the gate is missed on Postgres. The load generator shares this process, so RSS and
// event-loop numbers include it: only a split run (REFERENCE.md) is a gate result.

const postgresUrl = process.env.BETTER_COMPUTE_POSTGRES_URL;
const sessions = Number(process.env.BENCH_GW_SESSIONS ?? 5_000);
const durationMs = Number(process.env.BENCH_GW_DURATION_MS ?? 60_000);
const commandsPerSecond = Number(process.env.BENCH_GW_COMMANDS_PER_S ?? 50);
const streamsPerConnection = Number(process.env.BENCH_GW_STREAMS_PER_CONNECTION ?? 100);
const heartbeatMs = Number(process.env.BENCH_GW_HEARTBEAT_MS ?? 10_000);
const TENANT = 'tenant-bench';
const SITE = 'site_bench';

const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function seed(db: SqlExecutor, ids: string[]): Promise<void> {
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, $2, 'shared', 'bench', 1)
     ON CONFLICT (id) DO NOTHING`,
    [SITE, TENANT],
  );
  for (let i = 0; i < ids.length; i += 1_000) {
    const chunk = ids.slice(i, i + 1_000);
    await db.query(
      `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
         connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       SELECT v.id, $2, $3, 'host', 'ready', false, false, 'disconnected', 'platform', 0, 0, 1, 1, v.shard, 1
       FROM unnest($1::text[], $4::smallint[]) AS v(id, shard)`,
      [chunk, SITE, TENANT, chunk.map(shardOf)],
    );
    await db.query(
      'INSERT INTO node_sessions (node_id, session_epoch) SELECT unnest($1::text[]), 0',
      [chunk],
    );
  }
}

async function enqueue(db: SqlExecutor, nodeId: string, notAfterMs: number): Promise<string> {
  const id = newId('cmd');
  await db.transaction(async (tx) => {
    const { rows } = await tx.query<{ seq: number }>(
      'UPDATE nodes SET next_cmd_seq = next_cmd_seq + 1 WHERE id = $1 RETURNING next_cmd_seq - 1 AS seq',
      [nodeId],
    );
    const seq = Number(rows[0]!.seq);
    const body = encodeMessage(
      CommandBodySchema,
      create(CommandBodySchema, {
        id,
        nodeId,
        seq: BigInt(seq),
        kind: 'diag.nvml',
        lane: Lane.CONTROL,
        notAfter: timestampFromMs(notAfterMs),
        retrySafe: true,
        idempotencyKey: id,
      }),
    );
    await tx.query(
      `INSERT INTO commands (id, node_id, seq, kind, body, state, not_after, retry_safe, self_terminating,
         attested, idempotency_key)
       VALUES ($1, $2, $3, 'diag.nvml', $4, 'pending', $5, true, false, true, $1)`,
      [id, nodeId, seq, Buffer.from(body), new Date(notAfterMs)],
    );
  });
  return id;
}

/** One simulated bcd: Hello, heartbeats, and an immediate SUCCEEDED for every command. */
class Daemon {
  established = false;
  stream: ClientHttp2Stream | undefined;
  closedUnexpectedly = false;
  retries = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly nodeId: string,
    private readonly client: () => ClientHttp2Session,
    private readonly onCommand: (id: string) => void,
    private readonly onEstablished: () => void,
  ) {}

  open(): void {
    const stream = this.client().request({
      ':method': 'POST',
      ':path': `/${AGENT_GATEWAY_SERVICE}/Session`,
      'content-type': 'application/grpc',
      te: 'trailers',
      'x-bench-node': this.nodeId,
    });
    this.stream = stream;
    const decoder = new MessageDecoder();
    stream.on('data', (chunk: Buffer) => {
      for (const bytes of decoder.push(chunk)) {
        const frame = decodeServerFrame(bytes);
        if (frame.msg.case === 'welcome') {
          this.established = true;
          this.onEstablished();
          // Jittered like the daemon's, so heartbeats spread across the period.
          setTimeout(() => {
            this.timer = setInterval(() => this.send({ case: 'heartbeat', value: {} }), heartbeatMs);
          }, Math.random() * heartbeatMs);
        } else if (frame.msg.case === 'command') {
          const id = unwrapCommand(frame.msg.value).id;
          this.onCommand(id);
          this.send({ case: 'update', value: { commandId: id, state: CommandState.SUCCEEDED, bootId: 'b' } });
        }
      }
    });
    const settle = (headers: Record<string, unknown>) => {
      const status = headers['grpc-status'];
      if (status === undefined) return;
      clearInterval(this.timer);
      if (Number(status) === GrpcCode.RESOURCE_EXHAUSTED && !this.established) {
        // The handshake bucket said no: retry with jitter, as bcd does.
        this.retries++;
        setTimeout(() => this.open(), 200 + Math.random() * 1_000);
      } else if (!stopping) this.closedUnexpectedly = true;
    };
    stream.once('response', settle);
    stream.once('trailers', settle);
    stream.on('error', () => {
      if (!stopping) this.closedUnexpectedly = true;
    });
    this.send({
      case: 'hello',
      value: {
        nodeId: this.nodeId,
        bootId: 'boot-bench',
        journalId: 'journal-bench',
        role: AgentRole.NODE,
        protoMin: 1,
        protoMax: 1,
      },
    });
  }

  send(msg: NonNullable<MessageInitShape<typeof AgentFrameSchema>['msg']>) {
    if (this.stream && !this.stream.destroyed)
      this.stream.write(frameMessage(encodeAgentFrame(create(AgentFrameSchema, { msg }))));
  }

  close(): void {
    clearInterval(this.timer);
    this.stream?.close();
  }
}

let stopping = false;

describe('gateway-streams gate', () => {
  it(`holds ${sessions} sessions at ${heartbeatMs / 1000} s heartbeats and dispatches within budget`, async () => {
    const adapter = postgresUrl ? 'postgres' : 'pglite';
    const db: SqlExecutor = postgresUrl ? postgres({ url: postgresUrl }) : pglite();
    await db.migrate();
    const run = newId('req').slice(-8);
    const ids = Array.from({ length: sessions }, (_, i) => `node_bench_${run}_${i}`);
    await seed(db, ids);

    const gateway = createGateway({
      region: 'bench',
      database: db,
      services: {
        join: () => Promise.reject(new ComputeError('NOT_IMPLEMENTED', 'bench')),
        renew: () => Promise.reject(new ComputeError('NOT_IMPLEMENTED', 'bench')),
        secret: () => Promise.reject(new ComputeError('NOT_IMPLEMENTED', 'bench')),
      },
      maxStreams: sessions + 100,
      heartbeatIntervalMs: heartbeatMs,
    });
    await gateway.start();
    const served = await serveGateway(gateway, {
      insecure: true,
      authenticate: (peer) => {
        const nodeId = peer.headers['x-bench-node'];
        return typeof nodeId === 'string' ? { nodeId, role: 'node' } : undefined;
      },
    });

    const clients: ClientHttp2Session[] = [];
    const clientFor = (index: number) => () => {
      const slot = Math.floor(index / streamsPerConnection);
      let client = clients[slot];
      if (!client || client.destroyed) {
        client = connect(`http://127.0.0.1:${served.port}`);
        client.on('error', () => {});
        clients[slot] = client;
      }
      return client;
    };

    const sentAt = new Map<string, number>();
    const latencies: number[] = [];
    let established = 0;
    const rampStart = performance.now();
    let rampMs = 0;
    const daemons = ids.map(
      (nodeId, index) =>
        new Daemon(
          nodeId,
          clientFor(index),
          (commandId) => {
            const t0 = sentAt.get(commandId);
            if (t0 !== undefined) {
              latencies.push(performance.now() - t0);
              sentAt.delete(commandId);
            }
          },
          () => {
            established++;
            if (established === sessions) rampMs = performance.now() - rampStart;
          },
        ),
    );
    for (const daemon of daemons) daemon.open();
    const rampDeadline = performance.now() + Math.max(120_000, sessions * 20);
    while (established < sessions && performance.now() < rampDeadline) await sleep(250);

    // Steady state: commands at a fixed rate, memory and event-loop delay sampled.
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const rss: number[] = [];
    const heap: number[] = [];
    const sampler = setInterval(() => {
      const memory = process.memoryUsage();
      rss.push(memory.rss);
      heap.push(memory.heapUsed);
    }, 1_000);
    let enqueued = 0;
    let enqueueErrors = 0;
    const until = performance.now() + durationMs;
    const interval = 1_000 / commandsPerSecond;
    let next = performance.now();
    while (performance.now() < until) {
      const daemon = daemons[Math.floor(Math.random() * daemons.length)]!;
      if (daemon.established)
        void enqueue(db, daemon.nodeId, Date.now() + 60_000).then(
          (id) => {
            sentAt.set(id, performance.now());
            gateway.poke();
            enqueued++;
          },
          () => enqueueErrors++,
        );
      next += interval;
      await sleep(Math.max(0, next - performance.now()));
    }
    await sleep(2_000); // let the last commands land
    clearInterval(sampler);
    loop.disable();

    const sorted = [...latencies].sort((a, b) => a - b);
    const drops = daemons.filter((daemon) => daemon.closedUnexpectedly).length;
    const held = gateway.sessions().length;
    const maxRss = Math.max(...rss);
    const result = {
      suite: 'gateway-streams',
      date: new Date().toISOString(),
      commit: commit(),
      referenceHardware: process.env.BENCH_REFERENCE === '1',
      machine: { cpus: cpus().length, cpuModel: cpus()[0]?.model, memoryBytes: totalmem() },
      node: process.version,
      adapter,
      config: { sessions, durationMs, commandsPerSecond, streamsPerConnection, heartbeatMs, transport: 'h2c' },
      loadGeneratorInProcess: true,
      ramp: {
        established,
        ms: Math.round(rampMs || performance.now() - rampStart),
        handshakeRetries: daemons.reduce((sum, daemon) => sum + daemon.retries, 0),
      },
      steady: {
        heldSessions: held,
        unexpectedCloses: drops,
        enqueued,
        enqueueErrors,
        dispatched: latencies.length,
        undelivered: sentAt.size,
        dispatchMs: {
          p50: Math.round(percentile(sorted, 50)),
          p90: Math.round(percentile(sorted, 90)),
          p99: Math.round(percentile(sorted, 99)),
          max: Math.round(sorted.at(-1) ?? 0),
        },
        rssMiB: { max: Math.round(maxRss / 2 ** 20), last: Math.round((rss.at(-1) ?? 0) / 2 ** 20) },
        heapMiB: { max: Math.round(Math.max(...heap) / 2 ** 20) },
        eventLoopDelayMs: { p99: Math.round(loop.percentile(99) / 1e6), max: Math.round(loop.max / 1e6) },
      },
      gate: {
        sessions: held >= 5_000 && drops === 0,
        dispatchP99: percentile(sorted, 99) < 500,
        rss: maxRss < 2 * 2 ** 30,
        durationAtLeast30Min: durationMs >= 30 * 60_000,
        met: false,
      },
    };
    result.gate.met =
      result.gate.sessions && result.gate.dispatchP99 && result.gate.rss && result.gate.durationAtLeast30Min;

    stopping = true;
    for (const daemon of daemons) daemon.close();
    for (const client of clients) client?.close();
    await gateway.stop();
    await served.close(500);
    await db.close();

    const dir = new URL('../../bench/gateway-streams/results/', import.meta.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      new URL(`${result.date.replace(/[:.]/g, '-')}-${adapter}.json`, dir),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    console.log(JSON.stringify(result, null, 2));

    expect(established).toBe(sessions);
    expect(drops).toBe(0);
    if (adapter === 'postgres' && process.env.BENCH_GW_GATE === '1') expect(result.gate.met).toBe(true);
  });
});
