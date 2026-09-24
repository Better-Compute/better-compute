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
  close(): Promise<void>;
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
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
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
      const perNode = dispatchOptions.perNode ?? 1;
      const spec = commandKinds[kind];
      // The kind's payload with its defaults unless the caller brings one (diag.nvml: every visible GPU).
      const payload = packCommandPayload(
        kind,
        dispatchOptions.payload ?? create(spec.payload as never),
      );
      // Every command commits in one transaction, so each is timed from the same commit rather than from a
      // position in a long enqueue loop (1k sequential commits would add seconds to the early ones).
      const ids: string[] = [];
      const notAfter = Date.now() + 3_600_000;
      await db.transaction(async (tx) => {
        for (let round = 0; round < perNode; round++)
          for (const nodeId of nodeIds) {
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
      const committedAt = Date.now();
      const enqueuedAt = new Map(ids.map((id) => [id, committedAt]));
      gateway.poke(nodeIds);

      const acked = new Map<string, number>();
      const done = new Map<string, { at: number; state: string; reason?: string }>();
      try {
        await waitFor(
          async () => {
            const open = ids.filter((id) => !done.has(id));
            const { rows } = await db.query<{ id: string; state: string; reason: string | null }>(
              'SELECT id, state, reason FROM commands WHERE id = ANY($1::text[])',
              [open],
            );
            const now = Date.now();
            for (const row of rows) {
              if (!acked.has(row.id) && row.state !== 'pending' && row.state !== 'dispatched') {
                acked.set(row.id, now);
                histograms.ack.observe({ kind }, (now - enqueuedAt.get(row.id)!) / 1000);
              }
              if (terminalStates.has(row.state)) {
                done.set(row.id, {
                  at: now,
                  state: row.state,
                  ...(row.reason ? { reason: row.reason } : {}),
                });
                histograms.done.observe({ kind }, (now - enqueuedAt.get(row.id)!) / 1000);
              }
            }
            return done.size === ids.length;
          },
          dispatchOptions.timeoutMs ?? 60_000,
          `${kind} commands to finish`,
        );
      } catch {
        // Report what did not finish instead of throwing away the measurements.
      }
      return {
        firstUpdate: summarize([...acked].map(([id, at]) => at - enqueuedAt.get(id)!)),
        terminal: summarize([...done].map(([id, { at }]) => at - enqueuedAt.get(id)!)),
        failed: ids
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
    async close() {
      for (const daemon of daemons) if (daemon.state !== 'stopped') daemon.crash('harness-close');
      await client.close();
      await served.close();
      await gateway.stop().catch(() => {});
      await db.close();
    },
  };
}
