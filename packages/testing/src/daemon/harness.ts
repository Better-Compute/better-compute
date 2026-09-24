import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import {
  CommandBodySchema,
  DesiredStateBodySchema,
  Lane,
  ServerFrameSchema,
  commandKinds,
  isCommandKind,
  packCommandPayload,
  wrapCommand,
  wrapDesiredState,
  type AgentFrame,
  type CommandBody,
  type CommandKind,
  type CommandPayload,
  type CommandUpdate,
  type Hello,
  type NodeSpecSchema,
  type WelcomeSchema,
} from '@better-compute/protocol';
import { createAgentLink, type AgentLink, type LinkFaults, type ServerConn } from '../frame-conn.js';
import { createRng } from '../rng.js';
import { createSimScheduler, type SimScheduler } from '../scheduler.js';
import { FakeDaemon, type FakeDaemonOptions } from './fake-daemon.js';

type AgentMsg = AgentFrame['msg'];
type AgentCase = NonNullable<AgentMsg['case']>;
/** The value of an AgentFrame of one kind. */
export type AgentFrameValue<K extends AgentCase> = Extract<AgentMsg, { case: K }>['value'];

/**
 * The gateway end of one link, scripted by a test: it records every AgentFrame and sends whatever
 * the test asks for. With `autoWelcome`, it answers each Hello with a Welcome.
 */
export class ScriptedServer {
  /** Every frame received, in order. */
  readonly frames: AgentFrame[] = [];

  constructor(
    readonly link: AgentLink,
    private readonly onHello?: (hello: Hello, server: ScriptedServer) => void,
  ) {
    link.server.onFrame((frame) => {
      this.frames.push(frame);
      if (frame.msg.case === 'hello') this.onHello?.(frame.msg.value, this);
    });
  }

  get conn(): ServerConn {
    return this.link.server;
  }

  /** Received frames of one kind, in order. */
  of<K extends AgentCase>(kind: K): AgentFrameValue<K>[] {
    return this.frames.filter((f) => f.msg.case === kind).map((f) => f.msg.value as AgentFrameValue<K>);
  }

  /** CommandUpdates received, optionally for one command. */
  updates(commandId?: string): CommandUpdate[] {
    return this.of('update').filter((u) => commandId === undefined || u.commandId === commandId);
  }

  /** Forgets the frames received so far. */
  clear(): void {
    this.frames.length = 0;
  }

  send(msg: MessageInitShape<typeof ServerFrameSchema>['msg']): boolean {
    return this.link.server.send(create(ServerFrameSchema, { msg }));
  }

  welcome(init: MessageInitShape<typeof WelcomeSchema> = {}): boolean {
    return this.send({ case: 'welcome', value: init });
  }

  command(body: CommandBody, attempt = 1): boolean {
    return this.send({ case: 'command', value: wrapCommand(body, { attempt }) });
  }

  desired(body: MessageInitShape<typeof DesiredStateBodySchema>): boolean {
    return this.send({ case: 'desired', value: wrapDesiredState(create(DesiredStateBodySchema, body)) });
  }

  ack(init: { journalId?: string; eventSeq?: number; commandIds?: string[] }): boolean {
    return this.send({
      case: 'ack',
      value: { journalId: init.journalId ?? '', eventSeq: BigInt(init.eventSeq ?? 0), commandIds: init.commandIds ?? [] },
    });
  }

  cancel(commandId: string, reason = ''): boolean {
    return this.send({ case: 'cancel', value: { commandId, reason } });
  }
}

export interface DaemonHarnessOptions extends Partial<Omit<FakeDaemonOptions, 'scheduler' | 'dial'>> {
  /** Seeds the daemon's ids and the links' faults (default "harness"). */
  seed?: string;
  /** Scheduler start (default 2026-01-01T00:00:00Z). */
  start?: number;
  /**
   * Answer every Hello with a Welcome (default true): epoch +1 per session, default credits and
   * liveness, server time = scheduler time, and `ackedEventSeq` = the highest seq the harness acked
   * for that journal. A function returns extra Welcome fields.
   */
  autoWelcome?: boolean | ((hello: Hello) => MessageInitShape<typeof WelcomeSchema>);
  /** Faults of every link the daemon dials. */
  up?: LinkFaults;
  down?: LinkFaults;
  /** Start the daemon right away (default true). */
  autoStart?: boolean;
}

/** A FakeDaemon wired to scripted servers over in-memory links, on a sim scheduler. */
export interface DaemonHarness {
  readonly scheduler: SimScheduler;
  readonly daemon: FakeDaemon;
  /** The server end of the most recent link. */
  readonly server: ScriptedServer;
  /** Every server end, one per dial. */
  readonly servers: readonly ScriptedServer[];
  /** While false, dialing fails (the gateway is unreachable). */
  reachable: boolean;
  /** Advances the scheduler by `ms` (0 runs what is due now). */
  advance(ms?: number): Promise<void>;
  /**
   * A CommandBody for this node: a fresh `cmd_…` id, the next seq, the kind's lane and flags from
   * `commandKinds`, `not_after` 5 minutes ahead; `overrides` win.
   */
  commandBody<K extends CommandKind>(
    kind: K,
    payload?: MessageInitShape<(typeof commandKinds)[K]['payload']>,
    overrides?: MessageInitShape<typeof CommandBodySchema>,
  ): CommandBody;
  /** A CommandBody for an arbitrary kind (no payload), with the given flags. */
  rawCommandBody(kind: string, overrides?: MessageInitShape<typeof CommandBodySchema>): CommandBody;
  /** `commandBody` + send on the current server. */
  sendCommand<K extends CommandKind>(
    kind: K,
    payload?: MessageInitShape<(typeof commandKinds)[K]['payload']>,
    overrides?: MessageInitShape<typeof CommandBodySchema>,
  ): CommandBody;
  /** Sends a full spec (or a patch against `base`) at `generation`. */
  sendSpec(
    generation: number,
    spec: MessageInitShape<typeof NodeSpecSchema>,
    options?: { patchOf?: number; specHash?: Uint8Array },
  ): void;
}

/** Builds a harness around one FakeDaemon (see `DaemonHarness`). */
export function createDaemonHarness(options: DaemonHarnessOptions = {}): DaemonHarness {
  const { seed = 'harness', start, autoWelcome = true, up, down, autoStart = true, ...daemonOptions } = options;
  const scheduler = createSimScheduler(start === undefined ? {} : { start });
  const rng = createRng(seed);
  const servers: ScriptedServer[] = [];
  const acked = new Map<string, number>();
  let epoch = 0;
  let seq = 0;
  let ids = 0;
  const nodeId = daemonOptions.nodeId ?? 'node_test';

  const onHello = (hello: Hello, server: ScriptedServer) => {
    if (autoWelcome === false) return;
    const extra = typeof autoWelcome === 'function' ? autoWelcome(hello) : {};
    server.welcome({
      epoch: BigInt(++epoch),
      sessionId: `ses_${epoch}`,
      gatewayId: 'gw-harness',
      protocolVersion: 1,
      heartbeatIntervalMs: 10_000,
      leaseTtlMs: 40_000,
      credits: [
        { lane: Lane.CONTROL, credits: 8 },
        { lane: Lane.PROVISION, credits: 4 },
        { lane: Lane.BULK, credits: 2 },
      ],
      ackedEventSeq: BigInt(acked.get(hello.journalId) ?? 0),
      serverTime: timestampFromMs(scheduler.now()),
      ...extra,
    });
  };

  const harness: DaemonHarness = {
    scheduler,
    daemon: undefined as unknown as FakeDaemon,
    get server() {
      const last = servers[servers.length - 1];
      if (!last) throw new Error('the daemon has not dialed yet');
      return last;
    },
    servers,
    reachable: true,
    async advance(ms = 0) {
      await scheduler.advance(ms);
    },
    commandBody(kind, payload, overrides = {}) {
      const spec = commandKinds[kind];
      const packed = isCommandKind(kind)
        ? packCommandPayload(kind, create(spec.payload as never, (payload ?? {}) as never) as CommandPayload<typeof kind>)
        : undefined;
      return create(CommandBodySchema, {
        id: `cmd_${String(++ids).padStart(4, '0')}`,
        nodeId,
        seq: BigInt(++seq),
        kind,
        payload: packed,
        lane: spec.lane,
        notAfter: timestampFromMs(scheduler.now() + 5 * 60_000),
        retrySafe: spec.retrySafe,
        selfTerminating: spec.selfTerminating,
        attested: spec.attested,
        ...overrides,
      });
    },
    rawCommandBody(kind, overrides = {}) {
      return create(CommandBodySchema, {
        id: `cmd_${String(++ids).padStart(4, '0')}`,
        nodeId,
        seq: BigInt(++seq),
        kind,
        lane: Lane.CONTROL,
        notAfter: timestampFromMs(scheduler.now() + 5 * 60_000),
        ...overrides,
      });
    },
    sendCommand(kind, payload, overrides) {
      const body = harness.commandBody(kind, payload, overrides);
      harness.server.command(body);
      return body;
    },
    sendSpec(generation, spec, sendOptions = {}) {
      const patch = sendOptions.patchOf !== undefined;
      harness.server.desired({
        nodeId,
        generation: BigInt(generation),
        baseGeneration: BigInt(sendOptions.patchOf ?? 0),
        specHash: sendOptions.specHash ?? new Uint8Array([generation & 0xff]),
        spec: patch ? { case: 'patch', value: spec } : { case: 'full', value: spec },
      });
    },
  };

  const daemon = new FakeDaemon({
    nodeId,
    rng: rng.fork('daemon'),
    ...daemonOptions,
    scheduler,
    dial: () => {
      if (!harness.reachable) return undefined;
      const link = createAgentLink({
        scheduler,
        rng: rng.fork(`link-${servers.length}`),
        id: `link-${servers.length}`,
        ...(up ? { up } : {}),
        ...(down ? { down } : {}),
      });
      const server = new ScriptedServer(link, onHello);
      // Remember what the test acks, so the next Welcome carries the cumulative ack.
      const send = server.send.bind(server);
      server.send = (msg) => {
        if (msg?.case === 'ack' && msg.value.journalId) {
          const value = Number(msg.value.eventSeq ?? 0);
          acked.set(msg.value.journalId, Math.max(acked.get(msg.value.journalId) ?? 0, value));
        }
        return send(msg);
      };
      servers.push(server);
      return link.agent;
    },
  });
  (harness as { daemon: FakeDaemon }).daemon = daemon;
  if (autoStart) daemon.start();
  return harness;
}
