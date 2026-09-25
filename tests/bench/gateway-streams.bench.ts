import { execFileSync, fork } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect, type ClientHttp2Session, type ClientHttp2Stream } from 'node:http2';
import { cpus, totalmem } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
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
import {
  createNodeCa,
  createServingCa,
  generateP256KeyPair,
  nodeSpiffeId,
  privateKeyPem,
  toPem,
} from '@better-compute/pki';
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
// the storm), BENCH_GW_TLS=1 (mTLS), BENCH_GW_SPLIT=1 (the gateway in its own process; needs built
// packages), BENCH_GW_GATE=1 to fail the run when the gate is missed on Postgres. Without SPLIT the load
// generator shares the gateway's process, so RSS and event-loop numbers include it.

const postgresUrl = process.env.BETTER_COMPUTE_POSTGRES_URL;
const sessions = Number(process.env.BENCH_GW_SESSIONS ?? 5_000);
const durationMs = Number(process.env.BENCH_GW_DURATION_MS ?? 60_000);
const commandsPerSecond = Number(process.env.BENCH_GW_COMMANDS_PER_S ?? 50);
// mTLS as in production (`BENCH_GW_TLS=1`): every daemon holds its own node certificate, so its own
// TLS connection (one stream each), and the gateway authenticates with `certificateAuthenticate`.
const tls = process.env.BENCH_GW_TLS === '1';
const streamsPerConnection = tls ? 1 : Number(process.env.BENCH_GW_STREAMS_PER_CONNECTION ?? 100);
const heartbeatMs = Number(process.env.BENCH_GW_HEARTBEAT_MS ?? 10_000);
// The gateway and its store in a child process (bench/gateway-streams/host.mjs, built packages), so
// the RSS and event-loop numbers exclude this load generator.
const split = process.env.BENCH_GW_SPLIT === '1';
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
  dialRetries = 0;
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
      if (!welcomed) {
        // Never a session (a refused dial, a full accept queue): redial with back-off, not a drop.
        this.dialRetries++;
        const delay = Math.random() * this.backoffMs;
        this.backoffMs = Math.min(30_000, this.backoffMs * 2);
        setTimeout(() => this.open(), delay);
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

const TRUST_DOMAIN = 'bench.local';
const SERVER_NAME = 'gw.bench.local';

/** The node CA, the gateway's serving certificate and one node certificate per daemon (PEM). */
interface BenchPki {
  nodeCa: Uint8Array;
  servingCaPem: string;
  serving: { key: string; cert: string };
  nodes: Map<string, { key: string; cert: string }>;
  issueMs: number;
}

async function benchPki(ids: readonly string[]): Promise<BenchPki> {
  const started = performance.now();
  const nodeCa = createNodeCa({ trustDomain: TRUST_DOMAIN });
  const servingCa = createServingCa();
  const servingKey = generateP256KeyPair();
  const serving = await servingCa.issue(servingKey.publicKey, {
    usage: 'server',
    dnsSans: [SERVER_NAME],
    ttlSeconds: 86_400,
  });
  const nodes = new Map<string, { key: string; cert: string }>();
  for (const nodeId of ids) {
    const pair = generateP256KeyPair();
    const issued = await nodeCa.issue(pair.publicKey, {
      usage: 'client',
      role: 'node',
      uriSans: [nodeSpiffeId({ trustDomain: TRUST_DOMAIN, siteId: SITE, nodeId })],
      ttlSeconds: 86_400,
    });
    nodes.set(nodeId, {
      key: privateKeyPem(pair.privateKey),
      cert: [issued.certificate, ...issued.chain].map((der) => toPem(der)).join(''),
    });
  }
  return {
    nodeCa: nodeCa.certificate,
    servingCaPem: toPem(servingCa.certificate),
    serving: {
      key: privateKeyPem(servingKey.privateKey),
      cert: [serving.certificate, ...serving.chain].map((der) => toPem(der)).join(''),
    },
    nodes,
    issueMs: Math.round(performance.now() - started),
  };
}

async function startGateway(db: SqlExecutor, pki?: BenchPki): Promise<{ gateway: Gateway; served: ServedGateway }> {
  const gateway = createGateway({
    region: 'bench',
    database: db,
    services,
    maxStreams: sessions + 100,
    heartbeatIntervalMs: heartbeatMs,
  });
  await gateway.start();
  const served = await serveGateway(
    gateway,
    pki
      ? {
          tls: { key: pki.serving.key, cert: pki.serving.cert, ca: toPem(pki.nodeCa), minVersion: 'TLSv1.3' },
          // The production authenticator: chain to the node CA, trust domain, role, serial.
          nodeRoots: [pki.nodeCa],
          trustDomain: TRUST_DOMAIN,
        }
      : {
          insecure: true,
          authenticate: (peer) => {
            const nodeId = peer.headers['x-bench-node'];
            return typeof nodeId === 'string' ? { nodeId, role: 'node' } : undefined;
          },
        },
  );
  return { gateway, served };
}

/** Epoch milliseconds, sub-millisecond, comparable across the bench's processes. */
const now = () => performance.timeOrigin + performance.now();

/**
 * The gateway side of a run: in this process, or in a child (`BENCH_GW_SPLIT=1`,
 * bench/gateway-streams/host.mjs) so that its RSS and event-loop delay are the gateway's alone.
 */
interface Host {
  port(): number;
  /** Enqueues one command and pokes; `t0` is the commit time (`now()`). */
  enqueue(nodeId: string, notAfterMs: number): Promise<{ commandId: string; t0: number }>;
  measure(on: boolean): Promise<void>;
  sessions(): Promise<number>;
  /** A fresh gateway on a new port; the old one keeps serving until `killOld`. */
  takeover(): Promise<void>;
  killOld(): Promise<void>;
  query<T>(sql: string): Promise<T[]>;
  stop(): Promise<{ rssMax: number; rssLast: number; heapMax: number; loopP99: number; loopMax: number }>;
}

async function inProcessHost(ids: string[], pki: BenchPki | undefined): Promise<Host> {
  const db: SqlExecutor = postgresUrl ? postgres({ url: postgresUrl }) : pglite();
  await db.migrate();
  await seed(db, ids);
  let current = await startGateway(db, pki);
  let old: typeof current | undefined;
  const loop = monitorEventLoopDelay({ resolution: 10 });
  const rss: number[] = [];
  const heap: number[] = [];
  let sampler: ReturnType<typeof setInterval> | undefined;
  return {
    port: () => current.served.port,
    async enqueue(nodeId, notAfterMs) {
      const commandId = await enqueue(db, nodeId, notAfterMs);
      const t0 = now();
      current.gateway.poke();
      return { commandId, t0 };
    },
    async measure(on) {
      if (on) {
        loop.enable();
        sampler = setInterval(() => {
          const memory = process.memoryUsage();
          rss.push(memory.rss);
          heap.push(memory.heapUsed);
        }, 1_000);
      } else {
        loop.disable();
        clearInterval(sampler);
      }
    },
    sessions: async () => current.gateway.sessions().length,
    async takeover() {
      old = current;
      current = await startGateway(db, pki);
    },
    async killOld() {
      await old!.served.close(0);
      await old!.gateway.stop();
    },
    query: async <T>(sql: string) => (await db.query<T & Record<string, unknown>>(sql)).rows as T[],
    async stop() {
      await current.gateway.stop();
      await current.served.close(500);
      await db.close();
      return {
        rssMax: Math.max(0, ...rss),
        rssLast: rss.at(-1) ?? 0,
        heapMax: Math.max(0, ...heap),
        loopP99: loop.percentile(99) / 1e6,
        loopMax: loop.max / 1e6,
      };
    },
  };
}

async function childHost(ids: string[], pki: BenchPki | undefined): Promise<Host> {
  const child = fork(fileURLToPath(new URL('../../bench/gateway-streams/host.mjs', import.meta.url)), [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    execArgv: ['--max-old-space-size=4096'],
  });
  type Reply = Record<string, any> & { type: string };
  const waiting = new Map<string, (reply: Reply) => void>();
  let nextId = 0;
  let failure: Error | undefined;
  child.on('message', (reply: Reply) => {
    if (reply.type === 'error') {
      failure = new Error(`gateway host: ${reply.message}`);
      for (const resolve of waiting.values()) resolve(reply);
      return;
    }
    const key = reply.id !== undefined ? `${reply.type}:${reply.id}` : reply.type;
    const resolve = waiting.get(key);
    if (resolve) {
      waiting.delete(key);
      resolve(reply);
    }
  });
  const ask = (message: Record<string, unknown>, replyType: string, withId = false): Promise<Reply> => {
    const id = withId ? String(nextId++) : undefined;
    return new Promise((resolve, reject) => {
      waiting.set(id !== undefined ? `${replyType}:${id}` : replyType, (reply) =>
        reply.type === 'error' || failure ? reject(failure ?? new Error(String(reply.message))) : resolve(reply),
      );
      child.send(id !== undefined ? { ...message, id } : message);
    });
  };
  await new Promise<void>((resolve) => waiting.set('loaded', () => resolve()));
  let port = (
    await ask(
      {
        type: 'start',
        sessions,
        heartbeatMs,
        ids,
        siteId: SITE,
        tenantId: TENANT,
        ...(postgresUrl ? { postgresUrl } : {}),
        ...(pki
          ? {
              tls: {
                key: pki.serving.key,
                cert: pki.serving.cert,
                caPem: toPem(pki.nodeCa),
                nodeCaDer: Buffer.from(pki.nodeCa).toString('base64'),
                trustDomain: TRUST_DOMAIN,
              },
            }
          : {}),
      },
      'ready',
    )
  ).port as number;
  return {
    port: () => port,
    async enqueue(nodeId, notAfterMs) {
      const reply = await ask({ type: 'enqueue', nodeId, notAfterMs }, 'enqueued', true);
      return { commandId: reply.commandId as string, t0: reply.t0 as number };
    },
    measure: async (on) => void child.send({ type: 'measure', on }),
    sessions: async () => (await ask({ type: 'sessions' }, 'sessions', true)).count as number,
    async takeover() {
      port = (await ask({ type: 'takeover' }, 'takeover-ready')).port as number;
    },
    killOld: async () => void (await ask({ type: 'kill-old' }, 'killed')),
    query: async <T>(sql: string) => (await ask({ type: 'query', sql }, 'rows', true)).rows as T[],
    async stop() {
      const reply = await ask({ type: 'stop' }, 'stopped');
      return {
        rssMax: reply.memory.rssMax,
        rssLast: reply.memory.rssLast,
        heapMax: reply.memory.heapMax,
        loopP99: reply.loop.p99,
        loopMax: reply.loop.max,
      };
    },
  };
}

describe('gateway-streams gate', () => {
  it(`holds ${sessions} sessions at ${heartbeatMs / 1000} s heartbeats, dispatches within budget and survives a reconnect storm`, async () => {
    const adapter = postgresUrl ? 'postgres' : 'pglite';
    const run = newId('req').slice(-8);
    const ids = Array.from({ length: sessions }, (_, i) => `node_bench_${run}_${i}`);
    const pki = tls ? await benchPki(ids) : undefined;
    const host = split ? await childHost(ids, pki) : await inProcessHost(ids, pki);

    const clients = new Map<string, ClientHttp2Session>();
    const clientFor = (index: number) => () => {
      const key = `${host.port()}:${Math.floor(index / streamsPerConnection)}`;
      let client = clients.get(key);
      if (!client || client.destroyed || client.closed) {
        const own = pki?.nodes.get(ids[index]!);
        client =
          pki && own
            ? connect(`https://127.0.0.1:${host.port()}`, {
                ca: pki.servingCaPem,
                key: own.key,
                cert: own.cert,
                servername: SERVER_NAME,
                minVersion: 'TLSv1.3',
              })
            : connect(`http://127.0.0.1:${host.port()}`);
        client.on('error', () => {});
        clients.set(key, client);
      }
      return client;
    };

    // Commit time per command; with a split host a command can reach its daemon before the enqueue
    // reply reaches this process, so early arrivals wait here for their commit time.
    const sentAt = new Map<string, number>();
    const arrivedAt = new Map<string, number>();
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
              latencies.push(now() - t0);
              sentAt.delete(commandId);
            } else if (!replay) arrivedAt.set(commandId, now());
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

    // Steady state: commands at a fixed rate; the gateway process samples memory and event-loop delay.
    await host.measure(true);
    let enqueued = 0;
    let enqueueErrors = 0;
    const drive = async (forMs: number) => {
      const until = performance.now() + forMs;
      const interval = 1_000 / commandsPerSecond;
      let next = performance.now();
      while (performance.now() < until) {
        const daemon = daemons[Math.floor(Math.random() * daemons.length)]!;
        void host.enqueue(daemon.nodeId, Date.now() + 10 * 60_000).then(
          ({ commandId, t0 }) => {
            const early = arrivedAt.get(commandId);
            if (early !== undefined) {
              latencies.push(early - t0);
              arrivedAt.delete(commandId);
            } else sentAt.set(commandId, t0);
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
    await host.measure(false);
    const steadyLatencies = [...latencies];
    const heldAfterSteady = await host.sessions();
    const steadyCloses = daemons.reduce((sum, daemon) => sum + daemon.unexpectedCloses, 0);

    // The storm: a fresh gateway comes up, the old one's transport dies with commands in flight.
    let stormResult: Record<string, unknown> | undefined;
    if (storm) {
      await host.takeover();
      const driving = drive(15_000);
      await sleep(1_000);
      stormStart = performance.now();
      await host.killOld();
      const stormDeadline = performance.now() + 180_000;
      while (back.length < sessions && performance.now() < stormDeadline) await sleep(250);
      await driving;
      // Settle: every command must end succeeded, delivered once to each daemon's journal.
      const settleDeadline = performance.now() + 30_000;
      let open = Infinity;
      while (open > 0 && performance.now() < settleDeadline) {
        await sleep(500);
        const rows = await host.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM commands WHERE state <> 'succeeded'`,
        );
        open = Number(rows[0]!.n);
      }
      const states = await host.query<{ state: string; n: number }>(
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

    stopping = true;
    for (const daemon of daemons) daemon.close();
    for (const client of clients.values()) client.destroy();
    const measured = await host.stop();
    const maxRss = measured.rssMax;
    const dispatch = stats(steadyLatencies);
    const result = {
      suite: 'gateway-streams',
      date: new Date().toISOString(),
      commit: commit(),
      referenceHardware: process.env.BENCH_REFERENCE === '1',
      machine: { cpus: cpus().length, cpuModel: cpus()[0]?.model?.trim(), memoryBytes: totalmem() },
      node: process.version,
      adapter,
      config: {
        sessions,
        durationMs,
        commandsPerSecond,
        streamsPerConnection,
        heartbeatMs,
        transport: tls ? 'mtls' : 'h2c',
        storm,
      },
      ...(pki ? { certificatesIssuedMs: pki.issueMs } : {}),
      // Split: memory and event-loop numbers are the gateway process's alone.
      loadGeneratorInProcess: !split,
      ramp: {
        established,
        ms: Math.round(rampMs || performance.now() - rampStart),
        handshakeRetries: daemons.reduce((sum, daemon) => sum + daemon.handshakeRetries, 0),
        dialRetries: daemons.reduce((sum, daemon) => sum + daemon.dialRetries, 0),
      },
      steady: {
        heldSessions: heldAfterSteady,
        unexpectedCloses: steadyCloses,
        enqueued,
        enqueueErrors,
        dispatched: steadyLatencies.length,
        dispatchMs: dispatch,
        rssMiB: { max: Math.round(maxRss / 2 ** 20), last: Math.round(measured.rssLast / 2 ** 20) },
        heapMiB: { max: Math.round(measured.heapMax / 2 ** 20) },
        eventLoopDelayMs: { p99: Math.round(measured.loopP99), max: Math.round(measured.loopMax) },
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
