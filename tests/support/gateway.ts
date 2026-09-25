import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import {
  ComputeError,
  manualClock,
  newId,
  shardOf,
  type ManualClock,
  type SqlExecutor,
} from '@better-compute/core';
import { createGateway, type Gateway, type GatewayOptions, type GrpcError } from '@better-compute/gateway';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import {
  AgentFrameSchema,
  AgentRole,
  CommandBodySchema,
  CommandUpdateSchema,
  commandKinds,
  encodeMessage,
  Lane,
  PROTOCOL_VERSION,
  unwrapCommand,
  type AgentFrame,
  type CommandKind,
  type ServerFrame,
} from '@better-compute/protocol';
import type { GatewayServices } from '@better-compute/server';

// A gateway on PGlite with the sim clock: compute_now() and the gateway's Clock move together, so
// leases, not_before and not_after expire in simulated time. Daemons are frame recorders.

export const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);
export const TENANT = 'tenant-root';
export const SITE = 'site_01jz0000000000000000000000';

/** Frames a daemon received, and how its stream ended. */
export class FakeStream {
  readonly frames: ServerFrame[] = [];
  closed: { error?: GrpcError } | undefined;

  send(frame: ServerFrame) {
    if (this.closed) throw new Error('send after close');
    this.frames.push(frame);
  }
  close(error?: GrpcError) {
    this.closed ??= { error };
  }

  /** Every frame of one kind, in order. */
  of<K extends NonNullable<ServerFrame['msg']['case']>>(kind: K) {
    return this.frames
      .filter((frame) => frame.msg.case === kind)
      .map((frame) => frame.msg.value as Extract<ServerFrame['msg'], { case: K }>['value']);
  }
  /** Command ids sent, in order. */
  commandIds(): string[] {
    return this.of('command').map((command) => unwrapCommand(command).id);
  }
  clear() {
    this.frames.length = 0;
  }
}

export type AgentFrameInit = NonNullable<MessageInitShape<typeof AgentFrameSchema>['msg']>;

export function agentFrame(msg: AgentFrameInit): AgentFrame {
  return create(AgentFrameSchema, { msg });
}

export interface HelloOverrides {
  bootId?: string;
  journalId?: string;
  role?: AgentRole;
  protoMin?: number;
  protoMax?: number;
  appliedGeneration?: bigint;
  runningCommandIds?: string[];
  unackedResults?: MessageInitShape<typeof CommandUpdateSchema>[];
  inventoryHashes?: Record<string, Uint8Array>;
  trustVersion?: bigint;
  capabilities?: string[];
}

export function helloFrame(nodeId: string, overrides: HelloOverrides = {}): AgentFrame {
  return agentFrame({
    case: 'hello',
    value: {
      nodeId,
      bootId: overrides.bootId ?? 'boot-1',
      journalId: overrides.journalId ?? 'journal-1',
      role: overrides.role ?? AgentRole.NODE,
      daemonVersion: '0.1.0',
      protoMin: overrides.protoMin ?? PROTOCOL_VERSION.min,
      protoMax: overrides.protoMax ?? PROTOCOL_VERSION.max,
      appliedGeneration: overrides.appliedGeneration ?? 0n,
      runningCommandIds: overrides.runningCommandIds ?? [],
      unackedResults: overrides.unackedResults ?? [],
      inventoryHashes: overrides.inventoryHashes ?? {},
      trustVersion: overrides.trustVersion ?? 0n,
      capabilities: overrides.capabilities ?? [],
    },
  });
}

/** Records every forwarded call; `secret` answers with the configured function. */
export function fakeServices(overrides: Partial<GatewayServices> = {}) {
  const calls: { method: string; request: unknown }[] = [];
  const services: GatewayServices = {
    async join(request) {
      calls.push({ method: 'join', request });
      if (overrides.join) return overrides.join(request);
      throw new ComputeError('NOT_IMPLEMENTED', 'JoinService arrives in v0.1');
    },
    async renew(request) {
      calls.push({ method: 'renew', request });
      if (overrides.renew) return overrides.renew(request);
      throw new ComputeError('NOT_IMPLEMENTED', 'Renewal arrives in v0.1');
    },
    async secret(request) {
      calls.push({ method: 'secret', request });
      if (overrides.secret) return overrides.secret(request);
      throw new ComputeError('NOT_IMPLEMENTED', 'The secret broker arrives in v0.2');
    },
  };
  return { services, calls };
}

export interface CommandOptions {
  kind?: CommandKind;
  lane?: Lane;
  retrySafe?: boolean;
  selfTerminating?: boolean;
  notAfterMs?: number;
}

export interface GatewayFixture {
  db: SqlExecutor;
  clock: ManualClock;
  gateway: Gateway;
  services: ReturnType<typeof fakeServices>;
  /** Moves the gateway clock and compute_now() together. */
  advance(ms: number): Promise<void>;
  addNode(options?: { tenantId?: string }): Promise<string>;
  enqueue(nodeId: string, options?: CommandOptions): Promise<string>;
  /** Opens a stream and sends Hello; returns the recorder and the handle. */
  connect(
    nodeId: string,
    overrides?: HelloOverrides,
    target?: Gateway,
  ): Promise<{ stream: FakeStream; handle: ReturnType<Gateway['open']> }>;
  command(id: string): Promise<Record<string, unknown>>;
  session(nodeId: string): Promise<Record<string, unknown>>;
  outbox(topic?: string): Promise<{ topic: string; payload: Record<string, any> }[]>;
  /** Another gateway on the same database and clock. */
  another(options?: Partial<GatewayOptions>): Promise<Gateway>;
  close(): Promise<void>;
}

export async function gatewayFixture(options: Partial<GatewayOptions> = {}): Promise<GatewayFixture> {
  const db = pglite();
  await db.migrate();
  await useSimClock(db, T0);
  const clock = manualClock(T0);
  await db.query(
    `INSERT INTO sites (id, owner_tenant_id, kind, region, version) VALUES ($1, $2, 'shared', 'eu-1', 1)`,
    [SITE, TENANT],
  );
  const services = fakeServices();
  const gateways: Gateway[] = [];
  const build = async (extra: Partial<GatewayOptions>) => {
    const gateway = createGateway({
      region: 'eu-1',
      database: db,
      services: services.services,
      clock,
      manual: true,
      random: () => 0.5,
      ...options,
      ...extra,
    });
    await gateway.start();
    gateways.push(gateway);
    return gateway;
  };
  const gateway = await build({});

  const fixture: GatewayFixture = {
    db,
    clock,
    gateway,
    services,
    async advance(ms) {
      clock.advance(ms);
      await setSimClock(db, clock.now());
    },
    async addNode(nodeOptions = {}) {
      const id = newId('node');
      await db.query(
        `INSERT INTO nodes (id, site_id, owner_tenant_id, role, provision_state, maintenance, cordoned,
           connectivity, trust, generation, observed_generation, next_cmd_seq, identity_gen, shard, version)
         VALUES ($1, $2, $3, 'host', 'ready', false, false, 'disconnected', 'platform', 0, 0, 1, 1, $4, 1)`,
        [id, SITE, nodeOptions.tenantId ?? TENANT, shardOf(id)],
      );
      await db.query('INSERT INTO node_sessions (node_id, session_epoch) VALUES ($1, 0)', [id]);
      return id;
    },
    async enqueue(nodeId, commandOptions = {}) {
      const kind = commandOptions.kind ?? 'diag.nvml';
      const spec = commandKinds[kind];
      const id = newId('cmd');
      const notAfter = clock.now() + (commandOptions.notAfterMs ?? 3_600_000);
      return db.transaction(async (tx) => {
        const { rows } = await tx.query<{ seq: number }>(
          'UPDATE nodes SET next_cmd_seq = next_cmd_seq + 1 WHERE id = $1 RETURNING next_cmd_seq - 1 AS seq',
          [nodeId],
        );
        const seq = Number(rows[0]!.seq);
        const retrySafe = commandOptions.retrySafe ?? spec.retrySafe;
        const selfTerminating = commandOptions.selfTerminating ?? spec.selfTerminating;
        const body = encodeMessage(
          CommandBodySchema,
          create(CommandBodySchema, {
            id,
            nodeId,
            seq: BigInt(seq),
            kind,
            lane: commandOptions.lane ?? spec.lane,
            notAfter: timestampFromMs(notAfter),
            retrySafe,
            selfTerminating,
            idempotencyKey: id,
          }),
        );
        await tx.query(
          `INSERT INTO commands (id, node_id, seq, kind, body, state, not_after, retry_safe, self_terminating,
             attested, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $1)`,
          [id, nodeId, seq, kind, Buffer.from(body), new Date(notAfter), retrySafe, selfTerminating, spec.attested],
        );
        return id;
      });
    },
    async connect(nodeId, overrides = {}, target = gateway) {
      const stream = new FakeStream();
      const handle = target.open({ nodeId, role: 'node' }, stream);
      await handle.receive(helloFrame(nodeId, overrides));
      return { stream, handle };
    },
    async command(id) {
      const { rows } = await db.query('SELECT * FROM commands WHERE id = $1', [id]);
      return rows[0]!;
    },
    async session(nodeId) {
      const { rows } = await db.query('SELECT * FROM node_sessions WHERE node_id = $1', [nodeId]);
      return rows[0]!;
    },
    async outbox(topic) {
      const { rows } = await db.query<{ topic: string; payload: Record<string, any> }>(
        topic
          ? 'SELECT topic, payload FROM outbox WHERE topic = $1 ORDER BY seq'
          : 'SELECT topic, payload FROM outbox ORDER BY seq',
        topic ? [topic] : [],
      );
      return rows;
    },
    another: (extra = {}) => build(extra),
    async close() {
      for (const each of gateways) await each.stop().catch(() => {});
      await db.close();
    },
  };
  return fixture;
}
