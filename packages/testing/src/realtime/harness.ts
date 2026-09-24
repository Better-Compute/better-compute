// The real-time harness (PLAN.md §15, §16 v0.1 acceptance): a real gateway served over cleartext HTTP/2, a
// real database (PGlite, or Postgres when `postgresUrl` is set), and N FakeDaemons on the wall clock, each on
// its own HTTP/2 connection. Scenarios time what the fleet sees end to end and report percentiles; the
// histograms also land in an observability registry for the benchmark reports.

import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { ComputeError, newId, shardOf, systemClock, type SqlExecutor } from '@better-compute/core';
import {
  createGateway,
  serveGateway,
  type Gateway,
  type GatewayOptions,
  type ServedGateway,
} from '@better-compute/gateway';
import { createMetrics, type Histogram, type MetricsRegistry } from '@better-compute/observability';
import { pglite } from '@better-compute/postgres/pglite';
import {
  CommandBodySchema,
  commandKinds,
  encodeMessage,
  packCommandPayload,
  type CommandKind,
  type CommandPayload,
} from '@better-compute/protocol';
import type { GatewayServices } from '@better-compute/server';
import { FakeDaemon, type FakeDaemonOptions } from '../daemon/fake-daemon.js';
import { createRealtimeScheduler } from '../scheduler.js';
import { createH2cClient, TEST_NODE_HEADER, type H2cClient } from './h2c.js';

export interface RealtimeHarnessOptions {
  /** FakeDaemons (default 50; the 1k run belongs to `pnpm bench:scale`). */
  nodes?: number;
  /** Use this Postgres instead of PGlite (it must be empty or disposable: the harness migrates it). */
  postgresUrl?: string;
  gateway?: Partial<Omit<GatewayOptions, 'database' | 'services'>>;
  /** The api's JoinService etc. (default: refuses Join/Renew; W5a's services replace it). */
  services?: GatewayServices;
  daemon?: Partial<Omit<FakeDaemonOptions, 'nodeId' | 'scheduler' | 'dial'>>;
  /** One HTTP/2 connection for every daemon (default: one each, like production). */
  sharedConnection?: boolean;
  /** How often scenarios poll the database for state changes (default 10 ms). */
  pollMs?: number;
}

export interface LatencySummary {
  count: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

export interface DispatchResult {
  /** Enqueue commit → the command leaves `pending`/`dispatched` (the daemon acknowledged it). */
  firstUpdate: LatencySummary;
  /** Enqueue commit → a terminal state. */
  terminal: LatencySummary;
  /** Commands not terminal within the timeout, or terminal but not `succeeded`. */
  failed: { id: string; state: string; reason?: string }[];
}

export interface RealtimeHarness {
  db: SqlExecutor;
  gateway: Gateway;
  served: ServedGateway;
  client: H2cClient;
  daemons: FakeDaemon[];
  metrics: MetricsRegistry;
  siteId: string;
  /** Starts every daemon and resolves once each has a live session on the gateway. */
  connectAll(timeoutMs?: number): Promise<{ elapsedMs: number }>;
  /** Enqueues `perNode` commands of `kind` on every node and times them to acknowledgement and completion. */
  dispatch(options?: {
    kind?: CommandKind;
    payload?: CommandPayload<CommandKind>;
    perNode?: number;
    timeoutMs?: number;
  }): Promise<DispatchResult>;
  /**
   * Steady load: `ratePerSecond` commands of `kind` (default inventory.refresh, 500 ms of fake work),
   * spread round-robin over the fleet in `tickMs` batches for `durationMs`, then drained. Times each from
   * its enqueue commit to acknowledgement and completion (the v0.4 "command p99 < 1.5 s" measure).
   */
  load(options?: {
    kind?: CommandKind;
    payload?: CommandPayload<CommandKind>;
    ratePerSecond?: number;
    durationMs?: number;
    tickMs?: number;
    drainMs?: number;
  }): Promise<LoadResult>;
  /**
   * A reconnect storm (PLAN.md §15 scale risk 3): drops the sessions of a `fraction` of the fleet at once
   * (`disconnect`: the network resets and the daemons redial with backoff; `crash`: the processes die and
   * start again, recovering their journals) and times each node until the gateway holds a new session.
   */
  storm(options?: {
    fraction?: number;
    mode?: 'disconnect' | 'crash';
    timeoutMs?: number;
  }): Promise<StormResult>;
  close(): Promise<void>;
}

export interface LoadResult extends DispatchResult {
  enqueued: number;
  offeredPerSecond: number;
  completedPerSecond: number;
}

export interface StormResult {
  nodes: number;
  /** Drop → a new session on the gateway, per node. */
  reconnect: LatencySummary;
  elapsedMs: number;
  /** Nodes without a new session within the timeout. */
  missing: string[];
}

const TENANT = 'tenant-root';
const terminalStates = new Set(['succeeded', 'failed', 'rejected', 'expired', 'cancelled']);

export function summarize(samples: readonly number[]): LatencySummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!
      : 0;
  return { count: sorted.length, p50: at(50), p90: at(90), p99: at(99), max: sorted.at(-1) ?? 0 };
}

const refusingServices: GatewayServices = {
  join: async () => {
    throw new ComputeError('NOT_IMPLEMENTED', 'The harness has no JoinService until W5a');
  },
  renew: async () => {
    throw new ComputeError('NOT_IMPLEMENTED', 'The harness has no renewal until W5a');
  },
  secret: async () => {
    throw new ComputeError('NOT_IMPLEMENTED', 'The secret broker arrives in v0.2');
  },
};

async function openDatabase(postgresUrl: string | undefined): Promise<SqlExecutor> {
  if (!postgresUrl) return pglite();
  const { postgres } = await import('@better-compute/postgres');
  return postgres({ url: postgresUrl, max: 20 });
}

export async function createRealtimeHarness(
  options: RealtimeHarnessOptions = {},
): Promise<RealtimeHarness> {
  const count = options.nodes ?? 50;
  const pollMs = options.pollMs ?? 10;
  const db = await openDatabase(options.postgresUrl);
  await db.migrate();
  const siteId = newId('site');
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, $2, 'shared', 'rt-1', 1)`,
    [siteId, TENANT],
  );
  const nodeIds = Array.from({ length: count }, () => newId('node'));
  await db.transaction(async (tx) => {
    for (const id of nodeIds) {
      await tx.query(
        `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
           connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
         VALUES ($1, $2, $3, 'host', 'ready', false, false, 'disconnected', 'platform', 0, 0, 1, 1, $4, 1)`,
        [id, siteId, TENANT, shardOf(id)],
      );
      await tx.query('INSERT INTO node_sessions (node_id, session_epoch) VALUES ($1, 0)', [id]);
    }
  });

  const gateway = createGateway({
    region: 'rt-1',
    database: db,
    services: options.services ?? refusingServices,
    clock: systemClock,
    // A fleet of 1k handshakes at once must not trip the default 200/s bucket in a benchmark.
    handshakesPerSecond: Math.max(200, count * 2),
    maxStreams: Math.max(5_000, count * 2),
    ...options.gateway,
  });
  await gateway.start();
  const served = await serveGateway(gateway, {
    insecure: true,
    authenticate: (peer) => {
      const nodeId = peer.headers[TEST_NODE_HEADER];
      return typeof nodeId === 'string' && nodeId ? { nodeId, siteId } : undefined;
    },
  });
  const client = createH2cClient({
    url: `http://127.0.0.1:${served.port}`,
    ...(options.sharedConnection ? { shared: true } : {}),
  });

  const scheduler = createRealtimeScheduler({ onError: () => {} });
  const daemons = nodeIds.map(
    (nodeId) =>
      new FakeDaemon({
        backoff: { minMs: 50, maxMs: 2_000 },
        ...options.daemon,
        nodeId,
        scheduler,
        dial: () => client.session(nodeId),
      }),
  );

  const metrics = createMetrics();
  const histograms = {
    connect: metrics.histogram(
      'rt_connect_seconds',
      'Daemon start → live session',
      [],
      [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    ),
    ack: metrics.histogram(
      'rt_command_ack_seconds',
      'Enqueue → acknowledged',
      ['kind'],
      [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
    ),
    reconnect: metrics.histogram(
      'rt_reconnect_seconds',
      'Session drop → a new session',
      ['mode'],
      [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    ),
    done: metrics.histogram(
      'rt_command_done_seconds',
      'Enqueue → terminal',
      ['kind'],
      [0.5, 1, 1.5, 2, 2.5, 3, 5, 10],
    ),
  } satisfies Record<string, Histogram>;

  const waitFor = async (
    check: () => Promise<boolean> | boolean,
    timeoutMs: number,
    what: string,
  ) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await check()) return;
      if (Date.now() > deadline)
        throw new ComputeError('INTERNAL_ERROR', `Timed out waiting for ${what}`);
      await sleep(pollMs);
    }
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Enqueues one command per target (repeats allowed) in one transaction; all share its commit time. */
  const enqueue = async (
    targets: readonly string[],
    kind: CommandKind,
    given?: CommandPayload<CommandKind>,
  ): Promise<[string[], number]> => {
    const spec = commandKinds[kind];
    // The kind's payload with its defaults unless the caller brings one (diag.nvml: every visible GPU).
    const payload = packCommandPayload(kind, given ?? create(spec.payload as never));
    const ids: string[] = [];
    const notAfter = Date.now() + 3_600_000;
    await db.transaction(async (tx) => {
      for (const nodeId of targets) {
        const id = newId('cmd');
        const { rows } = await tx.query<{ seq: string }>(
          'UPDATE nodes SET next_cmd_seq = next_cmd_seq + 1 WHERE id = $1 RETURNING (next_cmd_seq - 1)::text AS seq',
          [nodeId],
        );
        const seq = Number(rows[0]!.seq);
        const body = encodeMessage(
          CommandBodySchema,
          create(CommandBodySchema, {
            id,
            nodeId,
            seq: BigInt(seq),
            kind,
            lane: spec.lane,
            notAfter: timestampFromMs(notAfter),
            retrySafe: spec.retrySafe,
            selfTerminating: spec.selfTerminating,
            idempotencyKey: id,
            payload,
          }),
        );
        await tx.query(
          `INSERT INTO commands (id, node_id, seq, kind, body, state, not_after, retry_safe, self_terminating,
             attested, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $1)`,
          [
            id,
            nodeId,
            seq,
            kind,
            Buffer.from(body),
            new Date(notAfter),
            spec.retrySafe,
            spec.selfTerminating,
            spec.attested,
          ],
        );
        ids.push(id);
      }
    });
    return [ids, Date.now()];
  };

  /** Follows commands from their enqueue commit to acknowledgement and a terminal state. */
  const track = (kind: CommandKind) => {
    const enqueuedAt = new Map<string, number>();
    const acked = new Map<string, number>();
    const done = new Map<string, { at: number; state: string; reason?: string }>();
    let lastDoneAt = 0;
    return {
      add(ids: string[], at: number) {
        for (const id of ids) enqueuedAt.set(id, at);
      },
      size: () => enqueuedAt.size,
      open: () => enqueuedAt.size - done.size,
      lastDoneAt: () => lastDoneAt,
      /** Reads the open commands' states once; returns how many are still open. */
      async poll(): Promise<number> {
        const open = [...enqueuedAt.keys()].filter((id) => !done.has(id));
        if (!open.length) return 0;
        const { rows } = await db.query<{ id: string; state: string; reason: string | null }>(
          'SELECT id, state, reason FROM commands WHERE id = ANY($1::text[])',
          [open],
        );
        const now = Date.now();
        for (const row of rows) {
          const since = (now - enqueuedAt.get(row.id)!) / 1000;
          if (!acked.has(row.id) && row.state !== 'pending' && row.state !== 'dispatched') {
            acked.set(row.id, now);
            histograms.ack.observe({ kind }, since);
          }
          if (terminalStates.has(row.state)) {
            done.set(row.id, {
              at: now,
              state: row.state,
              ...(row.reason ? { reason: row.reason } : {}),
            });
            histograms.done.observe({ kind }, since);
            lastDoneAt = now;
          }
        }
        return enqueuedAt.size - done.size;
      },
      result(): DispatchResult {
        return {
          firstUpdate: summarize([...acked].map(([id, at]) => at - enqueuedAt.get(id)!)),
          terminal: summarize([...done].map(([id, { at }]) => at - enqueuedAt.get(id)!)),
          failed: [...enqueuedAt.keys()]
            .filter((id) => done.get(id)?.state !== 'succeeded')
            .map((id) => {
              const finished = done.get(id);
              return {
                id,
                state: finished?.state ?? 'unfinished',
                ...(finished?.reason ? { reason: finished.reason } : {}),
              };
            }),
        };
      },
    };
  };

  return {
    db,
    gateway,
    served,
    client,
    daemons,
    metrics,
    siteId,
    async connectAll(timeoutMs = 30_000) {
      const started = Date.now();
      const pending = new Set<string>(nodeIds);
      for (const daemon of daemons) daemon.start();
      await waitFor(
        () => {
          for (const session of gateway.sessions())
            if (pending.delete(session.nodeId))
              histograms.connect.observe(undefined, (Date.now() - started) / 1000);
          return pending.size === 0;
        },
        timeoutMs,
        `${pending.size} daemons to connect`,
      );
      return { elapsedMs: Date.now() - started };
    },
    async dispatch(dispatchOptions = {}) {
      const kind = dispatchOptions.kind ?? 'diag.nvml';
      const targets = Array.from({ length: dispatchOptions.perNode ?? 1 }, () => nodeIds).flat();
      // Every command commits in one transaction, so each is timed from the same commit rather than from a
      // position in a long enqueue loop (1k sequential commits would add seconds to the early ones).
      const tracker = track(kind);
      tracker.add(...(await enqueue(targets, kind, dispatchOptions.payload)));
      gateway.poke(nodeIds);
      try {
        await waitFor(
          async () => (await tracker.poll()) === 0,
          dispatchOptions.timeoutMs ?? 60_000,
          `${kind} commands to finish`,
        );
      } catch {
        // Report what did not finish instead of throwing away the measurements.
      }
      return tracker.result();
    },
    async load(loadOptions = {}) {
      const kind = loadOptions.kind ?? 'inventory.refresh';
      const rate = loadOptions.ratePerSecond ?? 100;
      const durationMs = loadOptions.durationMs ?? 10_000;
      const tickMs = loadOptions.tickMs ?? 100;
      const tracker = track(kind);
      let cursor = 0;
      let owed = 0;
      let polling = true;
      // Poll alongside the offered load, so acknowledgements are timed while commands keep arriving.
      const poller = (async () => {
        while (polling) {
          await tracker.poll();
          await sleep(pollMs);
        }
      })();
      const started = Date.now();
      for (let tick = 1; Date.now() - started < durationMs; tick++) {
        owed += (rate * tickMs) / 1000;
        const count = Math.floor(owed);
        owed -= count;
        if (count > 0) {
          const targets = Array.from({ length: count }, () => nodeIds[cursor++ % nodeIds.length]!);
          tracker.add(...(await enqueue(targets, kind, loadOptions.payload)));
          gateway.poke([...new Set(targets)]);
        }
        await sleep(Math.max(0, started + tick * tickMs - Date.now()));
      }
      const offeredMs = Date.now() - started;
      try {
        await waitFor(
          () => tracker.open() === 0,
          loadOptions.drainMs ?? 60_000,
          `${kind} load to drain`,
        );
      } catch {
        // Report what did not finish.
      } finally {
        polling = false;
        await poller;
      }
      await tracker.poll();
      const result = tracker.result();
      return {
        ...result,
        enqueued: tracker.size(),
        offeredPerSecond: tracker.size() / (offeredMs / 1000),
        completedPerSecond: result.terminal.count / ((tracker.lastDoneAt() - started) / 1000 || 1),
      };
    },
    async storm(stormOptions = {}) {
      const mode = stormOptions.mode ?? 'disconnect';
      const fraction = Math.min(1, Math.max(0, stormOptions.fraction ?? 1));
      const chosen = daemons.slice(0, Math.max(1, Math.round(daemons.length * fraction)));
      const before = new Map(
        gateway.sessions().map((session) => [session.nodeId, session.sessionId]),
      );
      const pending = new Set(chosen.map((daemon) => daemon.nodeId));
      const samples: number[] = [];
      const started = Date.now();
      for (const daemon of chosen)
        if (mode === 'crash') {
          daemon.crash('storm');
          daemon.restart();
        } else daemon.disconnect('storm');
      try {
        await waitFor(
          () => {
            const now = Date.now();
            for (const session of gateway.sessions())
              if (pending.has(session.nodeId) && session.sessionId !== before.get(session.nodeId)) {
                pending.delete(session.nodeId);
                samples.push(now - started);
                histograms.reconnect.observe({ mode }, (now - started) / 1000);
              }
            return pending.size === 0;
          },
          stormOptions.timeoutMs ?? 60_000,
          `${pending.size} daemons to reconnect`,
        );
      } catch {
        // Report the stragglers instead of throwing away the measurements.
      }
      return {
        nodes: chosen.length,
        reconnect: summarize(samples),
        elapsedMs: Date.now() - started,
        missing: [...pending],
      };
    },
    async close() {
      for (const daemon of daemons) if (daemon.state !== 'stopped') daemon.crash('harness-close');
      await client.close();
      await served.close();
      await gateway.stop().catch(() => {});
      await db.close();
    },
  };
}
