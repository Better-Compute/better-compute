import type { AgentRole } from '@better-compute/protocol';
import type { EventLog } from '../event-log.js';
import type { ServerConn } from '../frame-conn.js';
import type { Rng } from '../rng.js';
import type { Scheduler } from '../scheduler.js';
import type {
  BilledAllocation,
  BookingRow,
  ConnectivityFact,
  ReleaseFact,
  ServerOutcome,
  UsageWindow,
} from './invariants.js';

/** What the TLS layer established about a daemon before the first frame (from the certificate). */
export interface GatewayPeer {
  nodeId: string;
  role: AgentRole;
}

/**
 * The "gateway side" of the fleet simulator: whatever serves agent/v1 Session streams. The
 * in-memory `GatewayStub` implements it today; the transport-agnostic gateway session core of
 * `@better-compute/gateway` plugs in through the same shape (an adapter that hands each
 * `ServerConn` to a session and forwards ticks), with the real control plane behind it.
 *
 * Every call runs inside a scheduler task and may return a promise, which the simulator awaits
 * before anything else happens, so an async (DB-backed) implementation stays deterministic as long
 * as it uses the context's scheduler for its timers and never the wall clock.
 */
export interface GatewayPort {
  /** A daemon opened a Session stream. The first frame on `conn` will be its Hello. */
  accept(conn: ServerConn, peer: GatewayPeer): void | Promise<void>;
  /** Called every `tickMs` of sim time: liveness sweeps, dispatch, reconcilers, sweepers. */
  tick?(now: number): void | Promise<void>;
  /** The gateway process dies: every session is gone (the simulator also resets the links). */
  kill?(reason: string): void | Promise<void>;
  /** Facts for the invariant checkers, when the port can provide them. */
  facts?(): GatewayFacts;
}

/** The control-plane side facts the invariant checkers need. */
export interface GatewayFacts {
  /** I1: booking rows (device × allocation × during). */
  bookings: BookingRow[];
  /** I5: why allocations were released, and connectivity transitions. */
  releases: ReleaseFact[];
  connectivity: ConnectivityFact[];
  /** I8: allocations as billing sees them, and the usage windows flushed. */
  allocations: BilledAllocation[];
  usage: UsageWindow[];
  /** I2: terminal command states. */
  outcomes: ServerOutcome[];
}

/** What the simulator hands a gateway factory. */
export interface GatewayContext {
  scheduler: Scheduler;
  rng: Rng;
  log: EventLog;
}
