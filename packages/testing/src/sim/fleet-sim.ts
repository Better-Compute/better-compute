import { createIdGenerator } from '@better-compute/core';
import {
  AgentRole,
  CommandState,
  unwrapCommand,
  unwrapDesiredState,
  type AgentFrame,
  type ServerFrame,
} from '@better-compute/protocol';
import { FakeDaemon, type FakeDaemonOptions } from '../daemon/fake-daemon.js';
import { EventLog, type LogValue } from '../event-log.js';
import { fakeHardware, type FakeHardware, type FakeHardwareVariant } from '../fake-hw.js';
import { createAgentLink, type AgentLink, type LinkEvent, type LinkFaults } from '../frame-conn.js';
import { createRng, type Rng } from '../rng.js';
import { createSimScheduler, type SimScheduler, type Timer } from '../scheduler.js';
import { FleetFacts } from './facts.js';
import { GatewayStub, type GatewayStubOptions } from './gateway-stub.js';
import {
  checkI1,
  checkI2,
  checkI3,
  checkI4,
  checkI5,
  checkI8,
  type InvariantViolation,
} from './invariants.js';
import type { GatewayContext, GatewayFacts, GatewayPort } from './port.js';

/** One simulated node. */
export interface FleetNodeOptions {
  /** Default: a `node_<ulid>` minted from the seed. */
  nodeId?: string;
  /** Default `hgx-h100`, seeded by the node id. */
  hardware?: FakeHardwareVariant | FakeHardware;
  role?: AgentRole;
  daemon?: FleetDaemonOptions;
}

/** FakeDaemon options the simulator does not own. */
export type FleetDaemonOptions = Partial<
  Omit<
    FakeDaemonOptions,
    'nodeId' | 'scheduler' | 'dial' | 'rng' | 'facts' | 'log' | 'hardware' | 'role'
  >
>;

/** Random faults, drawn every `everyMs` from the simulator's seeded RNG. Probabilities are per draw. */
export interface ChaosOptions {
  everyMs: number;
  /** Stop injecting after this long (default: until `quiesce()`). */
  forMs?: number;
  /** A random running daemon crashes and restarts after `restartAfterMs`. */
  crash?: number;
  restartAfterMs?: readonly [number, number];
  /** A random running node reboots (new boot_id). */
  reboot?: number;
  /** A random running daemon crashes, loses its journal and restarts. */
  journalLoss?: number;
  /** A random node's link is partitioned for `partitionMs` (the TCP connection may survive it). */
  partition?: number;
  partitionMs?: readonly [number, number];
  /** A random node is cut off the network for `isolateMs`: its link stalls and dials fail. */
  isolate?: number;
  isolateMs?: readonly [number, number];
  /** A random node's link goes half-open (the daemon end dies silently for the gateway). */
  halfOpen?: number;
  /** A random node's stream is reset. */
  reset?: number;
  /** A random node's link stalls in both directions for `stallMs`. */
  stall?: number;
  stallMs?: readonly [number, number];
  /** The gateway dies for `gatewayDownMs` (every session is reset). */
  gatewayKill?: number;
  gatewayDownMs?: readonly [number, number];
}

export interface FleetSimOptions {
  /** Everything random derives from it: the same seed gives the same event log. */
  seed: number | string;
  /** A node count (default 10) or one entry per node. */
  nodes?: number | readonly FleetNodeOptions[];
  /** Sim start time (default 2026-01-01T00:00:00Z). */
  start?: number;
  /** The gateway side (default: a `GatewayStub`). */
  gateway?: (context: GatewayContext) => GatewayPort;
  /** Options of the default stub. */
  stub?: Partial<Omit<GatewayStubOptions, 'scheduler' | 'log'>>;
  /** Faults of every daemon → gateway / gateway → daemon link. */
  up?: LinkFaults;
  down?: LinkFaults;
  /** Options for every daemon (per-node `daemon` options win). */
  daemon?: FleetDaemonOptions;
  /** Period of `GatewayPort.tick` (default 1 s). */
  tickMs?: number;
  /** Log every frame delivery, drop and duplicate (default true). */
  logFrames?: boolean;
  /** Daemons start at random times within this window (default 5 s). */
  startSpreadMs?: number;
  chaos?: ChaosOptions;
}

/** A deterministic fleet: N FakeDaemons, links with faults, a gateway port, and fact collection. */
export interface FleetSim {
  readonly seed: string;
  readonly scheduler: SimScheduler;
  /** The simulator's own stream; `rng.fork(label)` for workloads. */
  readonly rng: Rng;
  readonly log: EventLog;
  readonly facts: FleetFacts;
  readonly gateway: GatewayPort;
  /** The default gateway, when no `gateway` factory was given. */
  readonly stub: GatewayStub | undefined;
  readonly daemons: readonly FakeDaemon[];
  readonly nodeIds: readonly string[];
  daemon(nodeId: string): FakeDaemon;
  /** The node's current link. */
  link(nodeId: string): AgentLink | undefined;
  /** Starts every daemon (spread over `startSpreadMs`) and the gateway ticks. */
  start(): Promise<void>;
  /** Advances sim time by `ms`, running everything due in order. */
  run(ms: number): Promise<void>;
  /** Runs `fn` every `ms` of sim time (a workload); returns a function that stops it. */
  every(ms: number, fn: (now: number) => void | Promise<void>): () => void;
  crash(nodeId: string, restartAfterMs?: number): void;
  reboot(nodeId: string, options?: { durationMs?: number; loseJournal?: boolean }): void;
  /** Crash, lose the journal, restart after `restartAfterMs` (default 5 s). */
  loseJournal(nodeId: string, restartAfterMs?: number): void;
  /** Partitions the node's current link (a redial gets a healthy link). */
  partition(nodeId: string, ms?: number): void;
  /** Cuts the node off the network: its link is partitioned and dials fail, for `ms` or until `heal`. */
  isolate(nodeId: string, ms?: number): void;
  /** Heals a node's (or every) link and ends its isolation. */
  heal(nodeId?: string): void;
  halfOpen(nodeId: string, dead?: 'agent' | 'gateway'): void;
  resetLink(nodeId: string): void;
  stall(nodeId: string, direction: 'up' | 'down' | 'both', ms: number): void;
  /** The gateway dies: every session is reset and dials fail for `downMs`. */
  killGateway(downMs: number): void;
  /** Stops chaos, heals every link, brings the gateway back and restarts stopped daemons. */
  quiesce(): void;
  /** The gateway's facts, when it provides them. */
  gatewayFacts(): GatewayFacts | undefined;
  /** I1, I2, I5 and I8 over everything collected so far. */
  invariants(options?: { flushedUpTo?: number }): InvariantViolation[];
  /** SHA-256 of the event log. */
  digest(): string;
}

const describeServer = (frame: ServerFrame): Record<string, LogValue> => {
  const msg = frame.msg;
  switch (msg.case) {
    case 'welcome':
      return { msg: 'welcome', epoch: msg.value.epoch, acked: msg.value.ackedEventSeq };
    case 'command': {
      const body = unwrapCommand(msg.value);
      return { msg: 'command', id: body.id, kind: body.kind, attempt: msg.value.attempt };
    }
    case 'desired': {
      const body = unwrapDesiredState(msg.value);
      return { msg: 'desired', generation: body.generation, spec: body.spec.case ?? null };
    }
    case 'ack':
      return { msg: 'ack', seq: msg.value.eventSeq, ids: msg.value.commandIds };
    case 'cancel':
      return { msg: 'cancel', id: msg.value.commandId };
    default:
      return { msg: msg.case ?? 'empty' };
  }
};

const describeAgent = (frame: AgentFrame): Record<string, LogValue> => {
  const msg = frame.msg;
  switch (msg.case) {
    case 'hello':
      return {
        msg: 'hello',
        journal: msg.value.journalId,
        boot: msg.value.bootId.slice(0, 8),
        applied: msg.value.appliedGeneration,
        unacked: msg.value.unackedResults.map((u) => `${u.commandId}:${CommandState[u.state]}`),
        running: msg.value.runningCommandIds,
      };
    case 'update':
      return {
        msg: 'update',
        id: msg.value.commandId,
        state: CommandState[msg.value.state],
        reject: msg.value.rejectReason,
      };
    case 'events':
      return { msg: 'events', seqs: msg.value.events.map((e) => e.seq) };
    case 'status':
      return { msg: 'status', observed: msg.value.observedGeneration };
    case 'inventory':
      return { msg: 'inventory', section: msg.value.section };
    case 'specRequest':
      return { msg: 'spec-request', have: msg.value.haveGeneration, reason: msg.value.reason };
    case 'heartbeat':
      return { msg: 'heartbeat' };
    default:
      return { msg: msg.case ?? 'empty' };
  }
};

/**
 * Creates a deterministic fleet simulator (PLAN.md §15 "TS deterministic"): N FakeDaemons on fake
 * hardware, one in-memory link per session with seeded faults, and a pluggable gateway port (the
 * `GatewayStub` by default). Everything runs on one `SimScheduler`; nothing reads the wall clock or
 * `Math.random`, so the same seed always produces the same event log (`digest()`).
 */
export function createFleetSim(options: FleetSimOptions): FleetSim {
  const seed = String(options.seed);
  const scheduler = createSimScheduler(options.start === undefined ? {} : { start: options.start });
  const rng = createRng(seed);
  const log = new EventLog(scheduler);
  const facts = new FleetFacts();
  const idRng = rng.fork('ids');
  const newId = createIdGenerator({
    now: () => scheduler.now(),
    random: (bytes) => idRng.fill(bytes),
  });
  const context: GatewayContext = { scheduler, rng: rng.fork('gateway'), log };
  const stub = options.gateway ? undefined : new GatewayStub({ scheduler, log, ...options.stub });
  const gateway: GatewayPort = options.gateway ? options.gateway(context) : stub!;
  const logFrames = options.logFrames ?? true;

  const specs: FleetNodeOptions[] =
    typeof options.nodes === 'number' || options.nodes === undefined
      ? Array.from({ length: options.nodes ?? 10 }, () => ({}))
      : [...options.nodes];
  const links = new Map<string, AgentLink>();
  const linkCounts = new Map<string, number>();
  const byId = new Map<string, FakeDaemon>();
  const pending = new Set<Timer>();
  const isolated = new Set<string>();
  let gatewayDown = false;
  let chaosStopped = false;

  const observe = (nodeId: string) => (event: LinkEvent) => {
    const source = `link:${nodeId}`;
    switch (event.type) {
      case 'deliver':
      case 'drop':
      case 'duplicate':
      case 'reorder': {
        if (event.type === 'deliver') {
          const now = scheduler.now();
          if (event.dir === 'a->b') {
            // I4's ground truth: the gateway side received a frame from this node now.
            facts.heardFrom(nodeId, now);
            const msg = (event.frame as AgentFrame).msg;
            // I3: what the node reported converged.
            if (msg.case === 'status')
              facts.observedGeneration(nodeId, Number(msg.value.observedGeneration), now);
          } else {
            const msg = (event.frame as ServerFrame).msg;
            if (msg.case === 'desired')
              facts.specDelivered(nodeId, Number(unwrapDesiredState(msg.value).generation), now);
          }
        }
        if (!logFrames) return;
        const up = event.dir === 'a->b';
        const detail = up
          ? describeAgent(event.frame as AgentFrame)
          : describeServer(event.frame as ServerFrame);
        log.add(
          source,
          event.type === 'deliver' ? (up ? 'up' : 'down') : `${up ? 'up' : 'down'}.${event.type}`,
          detail,
        );
        return;
      }
      case 'close':
        log.add(source, 'close', {
          side: event.side === 'a' ? 'agent' : 'gateway',
          reason: event.info.reason,
          by: event.info.by,
        });
        return;
      case 'fault':
        log.add(source, `fault.${event.fault}`, { detail: event.detail ?? null });
        return;
    }
  };

  const daemons = specs.map((spec, index) => {
    const nodeId = spec.nodeId ?? newId('node');
    const hardware =
      typeof spec.hardware === 'object'
        ? spec.hardware
        : fakeHardware({ seed: `${seed}/${nodeId}`, variant: spec.hardware ?? 'hgx-h100' });
    const role = spec.role ?? AgentRole.NODE;
    const daemon = new FakeDaemon({
      ...options.daemon,
      ...spec.daemon,
      nodeId,
      role,
      hardware,
      scheduler,
      rng: rng.fork(`daemon/${index}`),
      facts,
      log,
      dial: () => {
        if (gatewayDown || isolated.has(nodeId)) return undefined;
        const count = (linkCounts.get(nodeId) ?? 0) + 1;
        linkCounts.set(nodeId, count);
        const link = createAgentLink({
          scheduler,
          rng: rng.fork(`link/${nodeId}/${count}`),
          id: `${nodeId}#${count}`,
          ...(options.up ? { up: options.up } : {}),
          ...(options.down ? { down: options.down } : {}),
          observe: observe(nodeId),
        });
        links.set(nodeId, link);
        log.add('sim', 'dial', { node: nodeId, link: count });
        // The gateway accepts the stream in its own task, so an async port stays in order.
        scheduler.after(0, () => gateway.accept(link.server, { nodeId, role }));
        return link.agent;
      },
    });
    byId.set(nodeId, daemon);
    return daemon;
  });

  const later = (ms: number, fn: () => void): void => {
    const timer = scheduler.after(ms, () => {
      pending.delete(timer);
      fn();
    });
    pending.add(timer);
  };
  const restartLater = (daemon: FakeDaemon, ms: number) =>
    later(ms, () => {
      if (daemon.state === 'stopped') daemon.start();
    });

  const sim: FleetSim = {
    seed,
    scheduler,
    rng,
    log,
    facts,
    gateway,
    stub,
    daemons,
    nodeIds: daemons.map((d) => d.nodeId),
    daemon(nodeId) {
      const daemon = byId.get(nodeId);
      if (!daemon) throw new Error(`no simulated node ${nodeId}`);
      return daemon;
    },
    link: (nodeId) => links.get(nodeId),
    async start() {
      const spread = options.startSpreadMs ?? 5_000;
      for (const daemon of daemons) later(spread > 0 ? rng.int(spread) : 0, () => daemon.start());
      if (gateway.tick) sim.every(options.tickMs ?? 1_000, (now) => gateway.tick!(now));
      if (options.chaos) chaos(options.chaos);
      log.add('sim', 'start', { nodes: daemons.length, seed });
      await scheduler.flush();
    },
    async run(ms) {
      await scheduler.advance(ms);
    },
    every(ms, fn) {
      let stopped = false;
      const tick = async () => {
        if (stopped) return;
        scheduler.after(ms, tick);
        await fn(scheduler.now());
      };
      scheduler.after(ms, tick);
      return () => {
        stopped = true;
      };
    },
    crash(nodeId, restartAfterMs) {
      const daemon = sim.daemon(nodeId);
      log.add('sim', 'crash', { node: nodeId });
      daemon.crash('sim crash');
      if (restartAfterMs !== undefined) restartLater(daemon, restartAfterMs);
    },
    reboot(nodeId, rebootOptions = {}) {
      log.add('sim', 'reboot', { node: nodeId, loseJournal: rebootOptions.loseJournal === true });
      sim.daemon(nodeId).reboot(rebootOptions);
    },
    loseJournal(nodeId, restartAfterMs = 5_000) {
      const daemon = sim.daemon(nodeId);
      log.add('sim', 'journal-loss', { node: nodeId });
      daemon.crash('sim journal loss');
      daemon.loseJournal();
      restartLater(daemon, restartAfterMs);
    },
    partition(nodeId, ms) {
      links.get(nodeId)?.control.partition(ms);
    },
    isolate(nodeId, ms) {
      log.add('sim', 'isolate', { node: nodeId, ms: ms ?? null });
      isolated.add(nodeId);
      links.get(nodeId)?.control.partition();
      if (ms !== undefined) later(ms, () => sim.heal(nodeId));
    },
    heal(nodeId) {
      const nodes = nodeId !== undefined ? [nodeId] : [...new Set([...links.keys(), ...isolated])];
      for (const id of nodes) {
        if (isolated.delete(id)) log.add('sim', 'isolate.end', { node: id });
        links.get(id)?.control.heal();
      }
    },
    halfOpen(nodeId, dead = 'agent') {
      links.get(nodeId)?.control.halfOpen(dead === 'agent' ? 'a' : 'b');
    },
    resetLink(nodeId) {
      links.get(nodeId)?.control.reset('sim reset');
    },
    stall(nodeId, direction, ms) {
      links
        .get(nodeId)
        ?.control.stall(direction === 'up' ? 'a->b' : direction === 'down' ? 'b->a' : 'both', ms);
    },
    killGateway(downMs) {
      log.add('sim', 'gateway.kill', { downMs });
      gatewayDown = true;
      void gateway.kill?.('gateway killed');
      for (const link of links.values()) link.server.abort('gateway killed');
      later(downMs, () => {
        gatewayDown = false;
        log.add('sim', 'gateway.up');
      });
    },
    quiesce() {
      chaosStopped = true;
      gatewayDown = false;
      sim.heal();
      for (const daemon of daemons) if (daemon.state === 'stopped') daemon.start();
      log.add('sim', 'quiesce');
    },
    gatewayFacts: () => gateway.facts?.(),
    invariants(invariantOptions = {}) {
      const g = gateway.facts?.();
      const violations = [
        ...checkI1({ ...(g ? { bookings: g.bookings } : {}), bindings: facts.bindings }),
        ...checkI2({
          executions: facts.executions,
          journalLosses: facts.journalLosses,
          ...(g ? { outcomes: g.outcomes } : {}),
        }),
      ];
      violations.push(
        ...checkI3({
          specsDelivered: facts.specsDelivered,
          observed: facts.observed,
          heard: facts.heard,
          until: scheduler.now(),
        }),
      );
      if (g) {
        violations.push(...checkI4({ connectivity: g.connectivity, heard: facts.heard }));
        violations.push(...checkI5({ releases: g.releases, connectivity: g.connectivity }));
        violations.push(
          ...checkI8({
            allocations: g.allocations,
            usage: g.usage,
            ...(invariantOptions.flushedUpTo === undefined
              ? {}
              : { flushedUpTo: invariantOptions.flushedUpTo }),
          }),
        );
      }
      return violations;
    },
    digest: () => log.digest(),
  };

  function chaos(chaosOptions: ChaosOptions): void {
    const until =
      chaosOptions.forMs === undefined ? Infinity : scheduler.now() + chaosOptions.forMs;
    const chaosRng = rng.fork('chaos');
    const running = () => daemons.filter((d) => d.state === 'running');
    const connected = () => daemons.filter((d) => d.connected && links.get(d.nodeId));
    const stop = sim.every(chaosOptions.everyMs, (now) => {
      if (chaosStopped || now > until) {
        stop();
        return;
      }
      const pick = <T>(items: T[]): T | undefined =>
        items.length === 0 ? undefined : chaosRng.pick(items);
      if (chaosRng.chance(chaosOptions.crash ?? 0)) {
        const daemon = pick(running());
        if (daemon)
          sim.crash(daemon.nodeId, drawIn(chaosRng, chaosOptions.restartAfterMs, [1_000, 30_000]));
      }
      if (chaosRng.chance(chaosOptions.reboot ?? 0)) {
        const daemon = pick(running());
        if (daemon)
          sim.reboot(daemon.nodeId, {
            durationMs: drawIn(chaosRng, chaosOptions.restartAfterMs, [10_000, 60_000]),
          });
      }
      if (chaosRng.chance(chaosOptions.journalLoss ?? 0)) {
        const daemon = pick(running());
        if (daemon)
          sim.loseJournal(
            daemon.nodeId,
            drawIn(chaosRng, chaosOptions.restartAfterMs, [1_000, 30_000]),
          );
      }
      if (chaosRng.chance(chaosOptions.partition ?? 0)) {
        const daemon = pick(connected());
        if (daemon)
          sim.partition(daemon.nodeId, drawIn(chaosRng, chaosOptions.partitionMs, [5_000, 90_000]));
      }
      if (chaosRng.chance(chaosOptions.isolate ?? 0)) {
        const daemon = pick(daemons.filter((d) => !isolated.has(d.nodeId)));
        if (daemon)
          sim.isolate(
            daemon.nodeId,
            drawIn(chaosRng, chaosOptions.isolateMs, [30_000, 5 * 60_000]),
          );
      }
      if (chaosRng.chance(chaosOptions.halfOpen ?? 0)) {
        const daemon = pick(connected());
        if (daemon) sim.halfOpen(daemon.nodeId, chaosRng.chance(0.5) ? 'agent' : 'gateway');
      }
      if (chaosRng.chance(chaosOptions.reset ?? 0)) {
        const daemon = pick(connected());
        if (daemon) sim.resetLink(daemon.nodeId);
      }
      if (chaosRng.chance(chaosOptions.stall ?? 0)) {
        const daemon = pick(connected());
        if (daemon)
          sim.stall(daemon.nodeId, 'both', drawIn(chaosRng, chaosOptions.stallMs, [500, 10_000]));
      }
      if (!gatewayDown && chaosRng.chance(chaosOptions.gatewayKill ?? 0))
        sim.killGateway(drawIn(chaosRng, chaosOptions.gatewayDownMs, [2_000, 30_000]));
    });
  }
  return sim;
}

function drawIn(
  rng: Rng,
  range: readonly [number, number] | undefined,
  fallback: readonly [number, number],
): number {
  const [min, max] = range ?? fallback;
  return rng.range(min, max);
}
