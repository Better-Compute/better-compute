import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import { ComputeError, newId, shardOf, type SqlExecutor } from '@better-compute/core';
import { attachFrameConn, createGateway, type Gateway } from '@better-compute/gateway';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  CommandBodySchema,
  commandKinds,
  encodeMessage,
  packCommandPayload,
  type CommandKind,
  type CommandPayload,
} from '@better-compute/protocol';
import {
  assertInvariants,
  createFleetSim,
  fakeGpuReset,
  type ConnectivityFact,
  type FleetSim,
  type FleetSimOptions,
  type GatewayContext,
  type GatewayPort,
  type ServerOutcome,
} from '@better-compute/testing';

// The deterministic fleet simulator (PLAN.md §15) against the REAL gateway core on PGlite: the
// testing kit's FakeDaemons (journals, crashes, reboots, journal loss) over faulty links, served by
// createGateway through attachFrameConn, with compute_now() pinned to simulated time. It checks the
// §16 v0.1 exit properties the gateway owns: gateway kill mid-command → no duplicate execution;
// journal loss → failed, not replayed; reboot completes on rejoin; I2 and I5 hold under chaos.

const MIN = 60_000;
const TENANT = 'tenant-sim';
const SITE = 'site_sim';
const terminal = ['succeeded', 'failed', 'rejected', 'expired', 'cancelled'];

/** Every statement first moves compute_now() to the scheduler's time (never backwards). */
function pinned(db: SqlExecutor, now: () => number): SqlExecutor {
  let last = -1;
  const sync = async () => {
    const time = now();
    if (time > last) {
      last = time;
      await setSimClock(db, time);
    }
  };
  return {
    dialect: db.dialect,
    kind: db.kind,
    async query(text, params) {
      await sync();
      return db.query(text, params);
    },
    async transaction(fn, options) {
      await sync();
      return db.transaction(fn, options);
    },
    migrate: (extra) => db.migrate(extra),
    close: () => db.close(),
  } as SqlExecutor;
}

interface RealGateway extends GatewayPort {
  db: SqlExecutor;
  readonly gateway: Gateway | undefined;
  enqueue<K extends CommandKind>(nodeId: string, kind: K, payload?: Partial<CommandPayload<K>>): Promise<string>;
  command(id: string): Promise<{ state: string; reason: string | null }>;
  /** Pulls outcomes and connectivity from the store so `facts()` can answer synchronously. */
  refresh(): Promise<void>;
  gateways: number;
}

/** A GatewayPort backed by createGateway on PGlite, stepped by the simulator's ticks. */
async function realGatewayPort(context: GatewayContext): Promise<RealGateway> {
  const raw = pglite();
  await raw.migrate();
  await useSimClock(raw, context.scheduler.now());
  const db = pinned(raw, () => context.scheduler.now());
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, $2, 'shared', 'sim', 1)`,
    [SITE, TENANT],
  );
  const clock = { now: () => context.scheduler.now() };
  const known = new Set<string>();
  let current: Gateway | undefined;
  let starting: Promise<Gateway> | undefined;
  let generation = 0;
  let outcomes: ServerOutcome[] = [];
  const connectivity: ConnectivityFact[] = [];
  let outboxCursor = 0;

  const gatewayNow = async (): Promise<Gateway> => {
    if (current) return current;
    starting ??= (async () => {
      const gateway = createGateway({
        id: `gw_sim_${++generation}`,
        region: 'sim',
        database: db,
        clock,
        manual: true,
        maxStreams: 10_000,
        services: {
          join: () => Promise.reject(new ComputeError('NOT_IMPLEMENTED', 'sim')),
          renew: () => Promise.reject(new ComputeError('NOT_IMPLEMENTED', 'sim')),
          secret: () => Promise.reject(new ComputeError('NOT_IMPLEMENTED', 'sim')),
        },
      });
      await gateway.start();
      current = gateway;
      starting = undefined;
      return gateway;
    })();
    return starting;
  };

  /** What JoinService would have created before the node's first dial. */
  const ensureNode = async (nodeId: string) => {
    if (known.has(nodeId)) return;
    known.add(nodeId);
    await db.query(
      `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
         connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
       VALUES ($1, $2, $3, 'host', 'ready', false, false, 'disconnected', 'platform', 0, 0, 1, 1, $4, 1)
       ON CONFLICT (id) DO NOTHING`,
      [nodeId, SITE, TENANT, shardOf(nodeId)],
    );
    await db.query(
      'INSERT INTO node_sessions (node_id, session_epoch) VALUES ($1, 0) ON CONFLICT (node_id) DO NOTHING',
      [nodeId],
    );
  };
  const port: RealGateway = {
    db,
    gateways: 0,
    get gateway() {
      return current;
    },
    async accept(conn, peer) {
      await ensureNode(peer.nodeId);
      const role = peer.role === 1 ? 'node' : peer.role === 2 ? 'site' : 'ramdisk';
      attachFrameConn(await gatewayNow(), { nodeId: peer.nodeId, role }, conn);
    },
    async tick() {
      const gateway = await gatewayNow();
      await gateway.jobs.lease.tick();
      await gateway.jobs.dispatch.tick();
      await gateway.jobs.status.tick();
      await gateway.jobs.liveness.tick();
      await gateway.jobs.specs.tick();
    },
    kill() {
      // Process death: no disconnect writes, no lease release; a fresh gateway takes the next dial.
      current?.crash();
      current = undefined;
      port.gateways++;
    },
    facts: () => ({ bookings: [], releases: [], allocations: [], usage: [], connectivity, outcomes }),
    async refresh() {
      const { rows } = await db.query<{ id: string; node_id: string; state: string; reason: string | null }>(
        'SELECT id, node_id, state, reason FROM commands WHERE state = ANY($1::text[]) ORDER BY id',
        [terminal],
      );
      outcomes = rows.map((row) => ({
        commandId: row.id,
        nodeId: row.node_id,
        state: row.state,
        ...(row.state === 'failed' && row.reason ? { errorCode: row.reason } : {}),
      }));
      const events = await db.query<{ seq: number; topic: string; payload: { data: { nodeId: string }; time: string } }>(
        `SELECT seq, topic, payload FROM outbox WHERE seq > $1 AND topic IN ('node.connected', 'node.disconnected')
         ORDER BY seq`,
        [outboxCursor],
      );
      for (const row of events.rows) {
        outboxCursor = Math.max(outboxCursor, Number(row.seq));
        connectivity.push({
          nodeId: row.payload.data.nodeId,
          at: Date.parse(row.payload.time),
          state: row.topic === 'node.connected' ? 'connected' : 'disconnected',
        });
      }
    },
    async enqueue(nodeId, kind, payload = {}) {
      await ensureNode(nodeId);
      const spec = commandKinds[kind];
      const id = newId('cmd');
      const notAfter = context.scheduler.now() + 10 * MIN;
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
            kind,
            payload: packCommandPayload(kind, create(spec.payload, payload as never) as never),
            lane: spec.lane,
            notAfter: timestampFromMs(notAfter),
            retrySafe: spec.retrySafe,
            selfTerminating: spec.selfTerminating,
            attested: spec.attested,
            idempotencyKey: id,
          }),
        );
        await tx.query(
          `INSERT INTO commands (id, node_id, seq, kind, body, state, not_after, retry_safe, self_terminating,
             attested, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $1)`,
          [id, nodeId, seq, kind, Buffer.from(body), new Date(notAfter), spec.retrySafe, spec.selfTerminating, spec.attested],
        );
      });
      return id;
    },
    async command(id) {
      const { rows } = await db.query<{ state: string; reason: string | null }>(
        'SELECT state, reason FROM commands WHERE id = $1',
        [id],
      );
      return rows[0]!;
    },
  };
  return port;
}

/** Builds a sim whose gateway is the real one; the port is created lazily by the factory. */
async function realSim(options: Omit<FleetSimOptions, 'gateway'>): Promise<{ sim: FleetSim; port: RealGateway }> {
  let port: RealGateway | undefined;
  let ready: Promise<RealGateway> | undefined;
  const sim = createFleetSim({
    ...options,
    gateway: (context) => {
      ready = realGatewayPort(context).then((created) => (port = created));
      // The simulator awaits every port call, so each one waits for the store to exist first.
      const later =
        <A extends unknown[]>(fn: (p: RealGateway, ...args: A) => unknown) =>
        async (...args: A) =>
          fn(await ready!, ...args);
      return {
        accept: later((p, conn, peer) => p.accept(conn as never, peer as never)),
        tick: later((p, now) => p.tick!(now as number)),
        kill: later((p, reason) => p.kill!(reason as string)),
        facts: () => port?.facts?.() ?? { bookings: [], releases: [], allocations: [], usage: [], connectivity: [], outcomes: [] },
      };
    },
  });
  await sim.start();
  return { sim, port: (await ready!)! };
}

const chaotic = (seed: string, nodes: number): Omit<FleetSimOptions, 'gateway'> => ({
  seed,
  nodes,
  daemon: { kinds: { 'gpu.reset': fakeGpuReset } },
  up: { latencyMs: 5, jitterMs: 20, drop: 0.0005, dropMode: 'reset', duplicate: 0.01 },
  down: { latencyMs: 5, jitterMs: 20, drop: 0.0005, dropMode: 'reset', duplicate: 0.01, reorder: 0.002 },
  chaos: {
    everyMs: 5_000,
    crash: 0.3,
    reboot: 0.1,
    journalLoss: 0.05,
    partition: 0.3,
    isolate: 0.1,
    halfOpen: 0.1,
    reset: 0.2,
    stall: 0.2,
    gatewayKill: 0.02,
  },
});

describe('fleet sim against the real gateway', () => {
  it(
    '40 daemons under drops, partitions, crashes, reboots, journal loss and gateway kills keep I2 and I5',
    async () => {
      const { sim, port } = await realSim(chaotic('real-gw-40', 40));
      const rng = sim.rng.fork('workload');
      const stop = sim.every(2_000, async () => {
        for (let i = 0; i < 2; i++) {
          const nodeId = rng.pick(sim.nodeIds);
          const draw = rng.next();
          if (draw < 0.5) await port.enqueue(nodeId, 'diag.nvml');
          else if (draw < 0.7) await port.enqueue(nodeId, 'inventory.refresh');
          else if (draw < 0.95) {
            const gpu = sim.daemon(nodeId).hardware.gpuUuids[0];
            if (gpu) await port.enqueue(nodeId, 'gpu.reset', { gpuUuids: [gpu] });
          } else await port.enqueue(nodeId, 'node.reboot', { reason: 'workload', delayMs: 500 });
        }
      });
      await sim.run(8 * MIN);
      stop();
      sim.quiesce();
      await sim.run(12 * MIN);
      await port.refresh();

      assertInvariants(sim.invariants({ flushedUpTo: sim.scheduler.now() }));

      const log = (event: string) => sim.log.find(event, 'sim').length;
      expect(log('crash')).toBeGreaterThan(3);
      expect(log('journal-loss') + log('reboot')).toBeGreaterThan(0);
      const { rows } = await port.db.query<{ state: string; n: number }>(
        'SELECT state, count(*)::int AS n FROM commands GROUP BY state',
      );
      const states = Object.fromEntries(rows.map((row) => [row.state, Number(row.n)]));
      expect(Object.keys(states).every((state) => terminal.includes(state))).toBe(true);
      expect(states.succeeded).toBeGreaterThan(100);
      // Every daemon is back and connected to the live gateway.
      for (const daemon of sim.daemons) expect(daemon.welcomed).toBe(true);
      const { rows: sessions } = await port.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM node_sessions WHERE gateway_id = $1 AND disconnected_at IS NULL`,
        [port.gateway!.id],
      );
      expect(Number(sessions[0]!.n)).toBe(sim.daemons.length);
    },
    10 * MIN,
  );
});

describe('protocol scenarios against the real gateway (§15)', () => {
  async function small(options: Partial<FleetSimOptions> = {}) {
    const { sim, port } = await realSim({
      seed: 'real-scenario',
      nodes: 3,
      startSpreadMs: 0,
      daemon: { kinds: { 'gpu.reset': fakeGpuReset } },
      ...options,
    });
    await sim.run(2_000);
    const nodeId = sim.nodeIds[0]!;
    return { sim, port, nodeId, daemon: sim.daemon(nodeId) };
  }

  it('gateway kill mid-command: a fresh gateway, a new epoch, the result arrives once, nothing runs twice', async () => {
    const { sim, port, nodeId, daemon } = await small();
    const id = await port.enqueue(nodeId, 'diag.nvml');
    await sim.run(1_500);
    const before = await port.db.query<{ session_epoch: number }>(
      'SELECT session_epoch FROM node_sessions WHERE node_id = $1',
      [nodeId],
    );
    sim.killGateway(10_000);
    await sim.run(60_000);
    expect((await port.command(id)).state).toBe('succeeded');
    const after = await port.db.query<{ session_epoch: number; gateway_id: string }>(
      'SELECT session_epoch, gateway_id FROM node_sessions WHERE node_id = $1',
      [nodeId],
    );
    expect(Number(after.rows[0]!.session_epoch)).toBeGreaterThan(Number(before.rows[0]!.session_epoch));
    expect(after.rows[0]!.gateway_id).toBe(port.gateway!.id);
    expect(daemon.executions.get(id)).toBe(1);
    await port.refresh();
    assertInvariants(sim.invariants());
  });

  it('journal loss: in-flight non-retry-safe commands fail journal-lost and are never replayed', async () => {
    const { sim, port, nodeId, daemon } = await small({
      daemon: { kinds: { 'gpu.reset': fakeGpuReset }, workers: { 1: 1 } },
    });
    const [g0, g1] = daemon.hardware.gpuUuids;
    const running = await port.enqueue(nodeId, 'gpu.reset', { gpuUuids: [g0!] });
    const queued = await port.enqueue(nodeId, 'gpu.reset', { gpuUuids: [g1!] });
    const retrySafe = await port.enqueue(nodeId, 'diag.nvml');
    await sim.run(1_500);
    sim.loseJournal(nodeId, 5_000);
    await sim.run(30_000);
    expect(await port.command(running)).toMatchObject({ state: 'failed', reason: 'journal-lost' });
    expect(await port.command(queued)).toMatchObject({ state: 'failed', reason: 'journal-lost' });
    expect((await port.command(retrySafe)).state).toBe('succeeded');
    expect(daemon.executions.get(running)).toBe(1);
    expect(daemon.executions.get(queued)).toBeUndefined();
    expect(daemon.executions.get(retrySafe)).toBe(1);
    await port.refresh();
    assertInvariants(sim.invariants());
  });

  it('node.reboot completes on rejoin as succeeded(rebooted) and is never replayed', async () => {
    const { sim, port, nodeId, daemon } = await small({ daemon: { rebootDurationMs: 20_000 } });
    const boot = daemon.bootId;
    const id = await port.enqueue(nodeId, 'node.reboot', { delayMs: 1_000 });
    await sim.run(45_000);
    expect(await port.command(id)).toMatchObject({ state: 'succeeded', reason: 'rebooted' });
    expect(daemon.bootId).not.toBe(boot);
    expect(daemon.executions.get(id)).toBe(1);
    await port.refresh();
    assertInvariants(sim.invariants());
  });

  it('daemon killed between side effect and ack: the result comes from the journal, not a re-run', async () => {
    const { sim, port, nodeId, daemon } = await small();
    const id = await port.enqueue(nodeId, 'diag.nvml');
    sim.link(nodeId)!.control.intercept('a->b', (frame) => {
      const msg = (frame as { msg: { case?: string; value?: { state?: number } } }).msg;
      return msg.case === 'update' && msg.value?.state === 5 ? 'drop' : undefined;
    });
    // Dispatch runs on the 1 s tick and diag.nvml takes 2 s: wait until the side effect is done (its
    // SUCCEEDED dropped on the wire) so the crash lands between side effect and ack, not mid-run.
    await sim.run(6_000);
    expect(sim.log.find('command.done').some((entry) => JSON.stringify(entry).includes(id))).toBe(true);
    expect((await port.command(id)).state).toBe('running');
    sim.crash(nodeId, 3_000);
    await sim.run(15_000);
    expect((await port.command(id)).state).toBe('succeeded');
    expect(daemon.executions.get(id)).toBe(1);
  });
});
