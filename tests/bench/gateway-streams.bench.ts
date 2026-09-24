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
  type Gateway,
  type ServedGateway,
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
// commands are enqueued at a steady rate and timed from enqueue commit to frame arrival. Then the
// reconnect storm of §7.8: the gateway's transport dies, a fresh gateway takes over, and every
// daemon redials with jittered back-off; nothing may be lost or run twice.
//
//   BETTER_COMPUTE_POSTGRES_URL=postgres://… BENCH_GW_DURATION_MS=1800000 pnpm bench:scale   the gate
//   pnpm bench:scale                                                                      PGlite, indicative
//
// Knobs: BENCH_GW_SESSIONS (5000), BENCH_GW_DURATION_MS (60000 after the ramp), BENCH_GW_COMMANDS_PER_S (50,
// §8.6), BENCH_GW_STREAMS_PER_CONNECTION (100), BENCH_GW_HEARTBEAT_MS (10000), BENCH_GW_STORM (1; 0 skips
// the storm), BENCH_GW_GATE=1 to fail the run when the gate is missed on Postgres. The load generator
// shares this process, so RSS and event-loop numbers include it: only a split run is a gate result.

const postgresUrl = process.env.BETTER_COMPUTE_POSTGRES_URL;
const sessions = Number(process.env.BENCH_GW_SESSIONS ?? 5_000);
const durationMs = Number(process.env.BENCH_GW_DURATION_MS ?? 60_000);
const commandsPerSecond = Number(process.env.BENCH_GW_COMMANDS_PER_S ?? 50);
const streamsPerConnection = Number(process.env.BENCH_GW_STREAMS_PER_CONNECTION ?? 100);
const heartbeatMs = Number(process.env.BENCH_GW_HEARTBEAT_MS ?? 10_000);
const storm = process.env.BENCH_GW_STORM !== '0';
const TENANT = 'tenant-bench';
const SITE = 'site_bench';

const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: Math.round(percentile(sorted, 50)),
    p90: Math.round(percentile(sorted, 90)),
    p99: Math.round(percentile(sorted, 99)),
    max: Math.round(sorted.at(-1) ?? 0),
  };
};

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
    await db.query('INSERT INTO node_sessions (node_id, session_epoch) SELECT unnest($1::text[]), 0', [chunk]);
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

type AgentMsg = NonNullable<MessageInitShape<typeof AgentFrameSchema>['msg']>;

interface Hooks {
  /** The HTTP/2 connection to the current gateway for this daemon. */
  client(): ClientHttp2Session;
  /** A command frame arrived (first delivery or replay). */
  onCommand(id: string, replay: boolean): void;
  onEstablished(daemon: Daemon): void;
}

let stopping = false;
/** Why streams ended, for the result file. */
const closeReasons = new Map<string, number>();

/**
 * One simulated bcd. Like the real one it keeps a journal: a command is executed once, a replayed
 * command gets its stored result again, terminal results are kept until acked and sent in
 * `Hello.unacked_results`, and a lost session is redialed with full-jitter back-off.
 */
class Daemon {
  established = false;
  stream: ClientHttp2Stream | undefined;
  unexpectedCloses = 0;
  handshakeRetries = 0;
  reconnects = 0;
  readonly executed = new Map<string, number>();
  private readonly unacked = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private backoffMs = 1_000;

  constructor(
    readonly nodeId: string,
    private readonly hooks: Hooks,
  ) {}

  open(): void {
    if (stopping) return;
    const stream = this.hooks.client().request({
      ':method': 'POST',
      ':path': `/${AGENT_GATEWAY_SERVICE}/Session`,
      'content-type': 'application/grpc',
      te: 'trailers',
      'x-bench-node': this.nodeId,
    });
    this.stream = stream;
    let welcomed = false;
    const decoder = new MessageDecoder();
    stream.on('data', (chunk: Buffer) => {
      for (const bytes of decoder.push(chunk)) {
        const frame = decodeServerFrame(bytes);
        const msg = frame.msg;
        if (msg.case === 'welcome') {
          welcomed = true;
          this.established = true;
          this.backoffMs = 1_000;
          this.hooks.onEstablished(this);
          setTimeout(() => {
            if (this.stream === stream)
              this.timer = setInterval(() => this.send({ case: 'heartbeat', value: {} }), heartbeatMs);
          }, Math.random() * heartbeatMs);
        } else if (msg.case === 'command') {
          const id = unwrapCommand(msg.value).id;
          const replay = this.executed.has(id);
          this.hooks.onCommand(id, replay);
          // The journal dedupes: run once, answer every delivery.
          if (!replay) this.executed.set(id, 1);
          this.unacked.add(id);
          this.send({ case: 'update', value: { commandId: id, state: CommandState.SUCCEEDED, bootId: 'b' } });
        } else if (msg.case === 'ack') {
          for (const id of msg.value.commandIds) this.unacked.delete(id);
        }
      }
    });
    let ended = false;
    const lost = (resourceExhausted: boolean, why: string) => {
      if (ended) return;
      ended = true;
      closeReasons.set(why, (closeReasons.get(why) ?? 0) + 1);
      clearInterval(this.timer);
      if (this.stream !== stream || stopping) return;
      this.established = false;
      if (resourceExhausted && !welcomed) {
        // The handshake bucket said no: retry with jitter, as bcd does.
        this.handshakeRetries++;
        setTimeout(() => this.open(), 200 + Math.random() * 1_000);
        return;
      }
      this.unexpectedCloses++;
      this.reconnects++;
      // Full jitter, doubling to 30 s.
      const delay = Math.random() * this.backoffMs;
      this.backoffMs = Math.min(30_000, this.backoffMs * 2);
      setTimeout(() => this.open(), delay);
    };
    const settle = (headers: Record<string, unknown>) => {
      const status = headers['grpc-status'];
      if (status !== undefined)
        lost(
          Number(status) === GrpcCode.RESOURCE_EXHAUSTED,
          `grpc ${status}: ${decodeURIComponent(String(headers['grpc-message'] ?? ''))}`,
        );
    };
    stream.once('response', settle);
    stream.once('trailers', settle);
    stream.on('error', (error: Error & { code?: string }) => lost(false, `error ${error.code ?? error.message}`));
    stream.on('close', () => lost(false, `close ${stream.rstCode}`));
    this.send({
      case: 'hello',
      value: {
        nodeId: this.nodeId,
        bootId: 'boot-bench',
        journalId: 'journal-bench',
        role: AgentRole.NODE,
        protoMin: 1,
        protoMax: 1,
        unackedResults: [...this.unacked].map((commandId) => ({
          commandId,
          state: CommandState.SUCCEEDED,
          bootId: 'b',
        })),
      },
    });
  }

  send(msg: AgentMsg) {
    if (this.stream && !this.stream.destroyed)
      this.stream.write(frameMessage(encodeAgentFrame(create(AgentFrameSchema, { msg }))));
  }

  close(): void {
    clearInterval(this.timer);
    this.stream?.close();
  }
}

const services = {
  join: () => Promise.reject(new ComputeError('NOT_IMPLEMENTED', 'bench')),
  renew: () => Promise.reject(new ComputeError('NOT_IMPLEMENTED', 'bench')),
  secret: () => Promise.reject(new ComputeError('NOT_IMPLEMENTED', 'bench')),
};

async function startGateway(db: SqlExecutor): Promise<{ gateway: Gateway; served: ServedGateway }> {
  const gateway = createGateway({
    region: 'bench',
    database: db,
    services,
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
  return { gateway, served };
}

describe('gateway-streams gate', () => {
  it(`holds ${sessions} sessions at ${heartbeatMs / 1000} s heartbeats, dispatches within budget and survives a reconnect storm`, async () => {
    const adapter = postgresUrl ? 'postgres' : 'pglite';
    const db: SqlExecutor = postgresUrl ? postgres({ url: postgresUrl }) : pglite();
    await db.migrate();
    const run = newId('req').slice(-8);
    const ids = Array.from({ length: sessions }, (_, i) => `node_bench_${run}_${i}`);
    await seed(db, ids);

    let current = await startGateway(db);
    const retired: { gateway: Gateway; served: ServedGateway }[] = [];
    const clients = new Map<string, ClientHttp2Session>();
    const clientFor = (index: number) => () => {
      const key = `${current.served.port}:${Math.floor(index / streamsPerConnection)}`;
      let client = clients.get(key);
      if (!client || client.destroyed || client.closed) {
        client = connect(`http://127.0.0.1:${current.served.port}`);
        client.on('error', () => {});
        clients.set(key, client);
      }
      return client;
    };

    const sentAt = new Map<string, number>();
    const latencies: number[] = [];
    let replays = 0;
    let established = 0;
    let rampMs = 0;
    let stormStart = 0;
    const back: number[] = [];
    const rampStart = performance.now();
    const daemons = ids.map(
      (nodeId, index) =>
        new Daemon(nodeId, {
          client: clientFor(index),
          onCommand(commandId, replay) {
            if (replay) replays++;
            const t0 = sentAt.get(commandId);
            if (t0 !== undefined) {
              latencies.push(performance.now() - t0);
              sentAt.delete(commandId);
            }
          },
          onEstablished() {
            if (stormStart) back.push(performance.now() - stormStart);
            else if (++established === sessions) rampMs = performance.now() - rampStart;
          },
        }),
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
    const drive = async (forMs: number) => {
      const until = performance.now() + forMs;
      const interval = 1_000 / commandsPerSecond;
      let next = performance.now();
      while (performance.now() < until) {
        const daemon = daemons[Math.floor(Math.random() * daemons.length)]!;
        void enqueue(db, daemon.nodeId, Date.now() + 10 * 60_000).then(
          (id) => {
            sentAt.set(id, performance.now());
            current.gateway.poke();
            enqueued++;
          },
          () => enqueueErrors++,
        );
        next += interval;
        await sleep(Math.max(0, next - performance.now()));
      }
    };
    await drive(durationMs);
    await sleep(2_000);
    clearInterval(sampler);
    loop.disable();
    const steadyLatencies = [...latencies];
    const heldAfterSteady = current.gateway.sessions().length;
    const steadyCloses = daemons.reduce((sum, daemon) => sum + daemon.unexpectedCloses, 0);

    // The storm: a fresh gateway comes up, the old one's transport dies with commands in flight.
    let stormResult: Record<string, unknown> | undefined;
    if (storm) {
      const old = current;
      current = await startGateway(db);
      const driving = drive(15_000);
      await sleep(1_000);
      stormStart = performance.now();
      await old.served.close(0);
      await old.gateway.stop();
      retired.push(old);
      const stormDeadline = performance.now() + 180_000;
      while (back.length < sessions && performance.now() < stormDeadline) await sleep(250);
      await driving;
      // Settle: every command must end succeeded, delivered once to each daemon's journal.
      const settleDeadline = performance.now() + 30_000;
      let open = Infinity;
      while (open > 0 && performance.now() < settleDeadline) {
        await sleep(500);
        const { rows } = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM commands WHERE state <> 'succeeded'`,
        );
        open = Number(rows[0]!.n);
      }
      const { rows: states } = await db.query<{ state: string; n: number }>(
        'SELECT state, count(*)::int AS n FROM commands GROUP BY state ORDER BY state',
      );
      const backSorted = [...back].sort((a, b) => a - b);
      stormResult = {
        reconnected: back.length,
        backMs: {
          p50: Math.round(percentile(backSorted, 50)),
          p99: Math.round(percentile(backSorted, 99)),
          all: Math.round(backSorted.at(-1) ?? 0),
        },
        replayedDeliveries: replays,
        commandStates: Object.fromEntries(states.map((row) => [row.state, Number(row.n)])),
        notSucceeded: open,
      };
    }

    const maxRss = Math.max(...rss);
    const dispatch = stats(steadyLatencies);
    const result = {
      suite: 'gateway-streams',
      date: new Date().toISOString(),
      commit: commit(),
      referenceHardware: process.env.BENCH_REFERENCE === '1',
      machine: { cpus: cpus().length, cpuModel: cpus()[0]?.model?.trim(), memoryBytes: totalmem() },
      node: process.version,
      adapter,
      config: { sessions, durationMs, commandsPerSecond, streamsPerConnection, heartbeatMs, transport: 'h2c', storm },
      loadGeneratorInProcess: true,
      ramp: {
        established,
        ms: Math.round(rampMs || performance.now() - rampStart),
        handshakeRetries: daemons.reduce((sum, daemon) => sum + daemon.handshakeRetries, 0),
      },
      steady: {
        heldSessions: heldAfterSteady,
        unexpectedCloses: steadyCloses,
        enqueued,
        enqueueErrors,
        dispatched: steadyLatencies.length,
        dispatchMs: dispatch,
        rssMiB: { max: Math.round(maxRss / 2 ** 20), last: Math.round((rss.at(-1) ?? 0) / 2 ** 20) },
        heapMiB: { max: Math.round(Math.max(...heap) / 2 ** 20) },
        eventLoopDelayMs: { p99: Math.round(loop.percentile(99) / 1e6), max: Math.round(loop.max / 1e6) },
      },
      storm: stormResult,
      closeReasons: Object.fromEntries([...closeReasons].sort((a, b) => b[1] - a[1])),
      gate: {
        sessions: heldAfterSteady >= 5_000 && steadyCloses === 0,
        dispatchP99: dispatch.p99 < 500,
        rss: maxRss < 2 * 2 ** 30,
        durationAtLeast30Min: durationMs >= 30 * 60_000,
        met: false,
      },
    };
    result.gate.met =
      result.gate.sessions && result.gate.dispatchP99 && result.gate.rss && result.gate.durationAtLeast30Min;

    stopping = true;
    for (const daemon of daemons) daemon.close();
    for (const client of clients.values()) client.destroy();
    await current.gateway.stop();
    await current.served.close(500);
    await db.close();

    const dir = new URL('../../bench/gateway-streams/results/', import.meta.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      new URL(`${result.date.replace(/[:.]/g, '-')}-${adapter}.json`, dir),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    console.log(JSON.stringify(result, null, 2));

    expect(established).toBe(sessions);
    expect(steadyCloses).toBe(0);
    if (stormResult) {
      expect(stormResult.reconnected).toBe(sessions);
      expect(stormResult.notSucceeded).toBe(0);
    }
    if (adapter === 'postgres' && process.env.BENCH_GW_GATE === '1') expect(result.gate.met).toBe(true);
  });
});
