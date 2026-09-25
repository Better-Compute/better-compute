import { createHash } from 'node:crypto';
import {
  ComputeError,
  type CapacityPort,
  type ComputeModule,
  type DesiredState,
  type Finding,
  type InventoryPort,
  type Lease,
  type ModuleContext,
  type Reconciler,
  type RegistryView,
  type SqlTx,
  type WorkQueue,
} from '@better-compute/core';
import { createCapacityPort } from '@better-compute/capacity';
import { latestInventory } from '@better-compute/inventory';
import type { ResolvedOptions, WorkerRole } from '../options.js';
import type { Registry } from '../registry.js';
import { readAuthzRow, authzWriter, type StoredAuthzRow } from './authz.js';
import { createClockMonitor, isAnchoredClock, type ClockMonitor } from './clock.js';
import {
  builtinCommandKinds,
  createCommandQueue,
  gatewayPokes,
  sweepCommandsOnce,
  type GatewayPokes,
} from './commands.js';
import {
  createLocalEvents,
  createSinkDispatch,
  eventPublisher,
  type EventSubscriptions,
} from './events.js';
import { createLeases, type TableLeases } from './leases.js';
import {
  collectReconcilers,
  createReconcilerRunner,
  fencedExecutor,
  type ReconcilerRunner,
} from './reconcilers.js';
import { workQueue } from './work-queue.js';
import {
  createMembership,
  createSingletonLease,
  renewLeases,
  type Membership,
  type SingletonLease,
} from './workers.js';

export { anchoredClock, clockSkewThresholdMs, isAnchoredClock } from './clock.js';
export type { AnchoredClock } from './clock.js';
export { builtinCommandKinds, commandOwner, pokeMessage } from './commands.js';
export type { GatewayPokes } from './commands.js';
export { eventPattern } from './events.js';
export type { EventHandler, EventSubscriptions } from './events.js';
export { leaseNames } from './leases.js';
export { assignShards, shardOwner } from './workers.js';

// The worker runtime behind `ModuleContext` and `compute.start()/stop()/jobs` (PLAN.md §8). The
// ports (leases, work queue, desired state, commands, events, authz) are plain SQL in the caller's
// transaction. Jobs run the same passes whether a test steps them with `jobs.<name>.tick()` or
// `start()` runs them on timers: reconcilers by name, `command-sweeper` (controllers),
// `outbox-dispatch` (sinks), `iam:<name>` (iam) and `event-subscribers` (every started process).

/** One deterministic pass of a background job; returns how many items it processed. */
export interface Job {
  tick(): Promise<number>;
}

/** Job names the runtime reserves; reconcilers cannot take them. */
export const builtinJobNames = ['command-sweeper', 'outbox-dispatch', 'event-subscribers'] as const;

/** The ports of `ModuleContext` the runtime provides. */
export type RuntimePorts = Pick<
  ModuleContext,
  'leases' | 'work' | 'desired' | 'commands' | 'events' | 'authz' | 'capacity' | 'inventory'
>;

export interface Runtime {
  readonly workerId: string;
  /** The ports every module context carries, built around the registry view. */
  ports(registry: RegistryView): RuntimePorts;
  /** Registers the reconcilers of `modules` and builds the jobs (throws `INVALID_CONFIG`). */
  bind(input: {
    context: ModuleContext;
    registry: Registry;
    modules: readonly ComputeModule[];
  }): void;
  readonly jobs: Readonly<Record<string, Job>>;
  readonly events: EventSubscriptions;
  /** After migrations: anchors the default clock and starts the in-process event cursor. */
  initialize(): Promise<void>;
  /** Runs the loops of `roles` (and the in-process event tail) on timers; idempotent per role. */
  start(roles: readonly WorkerRole[]): Promise<void>;
  /** Stops every loop, waits for running passes, releases leases and leaves the worker table. */
  stop(): Promise<void>;
  /** Runtime findings for selfCheck (ClockSkew). */
  findings(): Finding[];
  /** The authz projection row by primary key (`compute.authz.get`). */
  authzRow(type: string, id: string, tenantId: string): Promise<StoredAuthzRow | undefined>;
  /** After-commit gateway pokes (`gw:<gatewayId>`, `{nodeIds}`): new commands, new node specs. */
  readonly pokes: GatewayPokes;
  readonly monitor: ClockMonitor;
  readonly leases: TableLeases;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Waits `ms`, or less when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** A sink id as a lease-name segment: kept when it is lease-safe, else its sha256 prefix. */
function leaseSafe(id: string): string {
  return /^[A-Za-z0-9._@-]{1,100}$/.test(id) ? id : `h-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
}

/** The worker roles that run reconcilers, each with its own shard membership. */
const shardedRoles = ['controllers', 'scheduler'] as const;
type ShardedRole = (typeof shardedRoles)[number];

/** `scheduler` for placers (`Reconciler.role`), which scale apart from the controllers; else `controllers`. */
function reconcilerRole(reconciler: Reconciler): ShardedRole {
  return reconciler.role === 'scheduler' ? 'scheduler' : 'controllers';
}

export function createRuntime(options: ResolvedOptions): Runtime {
  const { database, clock, log, worker: settings } = options;
  const workerId = settings.id;
  const monitor = createClockMonitor(clock, log);
  const leases = createLeases(database, monitor);
  const membershipSettings = {
    workerId,
    shardLeaseTtlMs: settings.leaseTtlMs,
    renewMs: settings.renewMs,
    liveWorkerMs: settings.liveWorkerMs,
  };
  // One rendezvous membership per role that runs sharded reconcilers (§8.1): the controllers', and
  // the scheduler's (placers), so each role spreads the 256 shards over its own processes.
  const membership: Membership = createMembership(database, leases, clock, membershipSettings);
  const schedulerMembership: Membership = createMembership(database, leases, clock, {
    ...membershipSettings,
    group: 'scheduler',
  });
  const memberships: Record<ShardedRole, Membership> = {
    controllers: membership,
    scheduler: schedulerMembership,
  };
  const singletons: SingletonLease[] = [];
  const singleton = (job: string) => {
    const lease = createSingletonLease(
      leases,
      clock,
      job,
      workerId,
      settings.leaseTtlMs,
      settings.renewMs,
    );
    singletons.push(lease);
    return lease;
  };
  const localEvents = createLocalEvents(database, log, settings.batchSize * 4);
  const sinkDispatch = createSinkDispatch(
    database,
    options.eventSinks,
    log,
    settings.batchSize * 4,
    () => clock.now(),
  );

  const work: WorkQueue = workQueue;
  const desired: DesiredState = Object.freeze({
    invalidate: (tx: SqlTx, nodeId: string) => work.enqueue(tx, 'nodespec', nodeId),
  } satisfies DesiredState);
  // The built-in modules back these (P10's one exception): quota + the inline placer, and the
  // latest stored snapshot.
  const capacity: CapacityPort =
    options.ports.capacity ?? createCapacityPort({ clock }, options.capacity);
  const inventory: InventoryPort = options.ports.inventory ?? {
    get: (nodeId) => latestInventory(database, nodeId),
  };
  const pokes = gatewayPokes(options.notifier, options.afterCommit);

  let bound:
    | {
        context: ModuleContext;
        registry: Registry;
        modules: readonly ComputeModule[];
        runners: Map<string, ReconcilerRunner>;
      }
    | undefined;
  const jobs: Record<string, Job> = {};
  let stopController = new AbortController();
  const running = new Map<string, Promise<void>>();
  const loopRoles = new Set<WorkerRole>();
  /** Which worker role runs each reconciler (§8.1). */
  const runnerRoles = new Map<string, ShardedRole>();
  /** Roles that run a sharded reconciler, so hold a shard membership. */
  const membershipRoles = new Set<ShardedRole>();
  let eventsLoop = false;

  const requireBound = () => {
    if (!bound) throw new ComputeError('INVALID_STATE', 'The runtime has no modules bound yet');
    return bound;
  };

  // --- Singleton jobs ---------------------------------------------------------------------------

  const sweeperLease = singleton('command-sweeper');
  async function sweep(): Promise<number> {
    const { registry, runners } = requireBound();
    const lease = await sweeperLease.ensure();
    if (!lease) return 0;
    const registered = new Set(registry.commandKinds.map((spec) => spec.kind));
    const kinds = [
      ...registry.commandKinds,
      ...builtinCommandKinds.filter((spec) => !registered.has(spec.kind)),
    ];
    const swept = await fenced(lease).transaction((tx) =>
      sweepCommandsOnce(tx, {
        kinds,
        batchSize: settings.batchSize * 16,
        work,
        events: eventPublisher,
        registered: (kind) => runners.has(kind),
      }),
    );
    return swept.length;
  }

  // One lease per sink (§8.4): `singleton:outbox-dispatch:<sink>`, so the sinks spread over the
  // `sinks` workers and a slow one never holds the others back.
  const sinkLeases = new Map(
    options.eventSinks.map((sink) => [sink.id, singleton(`outbox-dispatch:${leaseSafe(sink.id)}`)] as const),
  );
  async function dispatchSink(sinkId: string): Promise<number> {
    const lease = await sinkLeases.get(sinkId)?.ensure();
    if (!lease) return 0;
    // A new epoch means this process just took the lease: it resumes from the stored cursor.
    return sinkDispatch.dispatchSink(sinkId, lease.epoch);
  }
  async function dispatchOutbox(): Promise<number> {
    let delivered = 0;
    for (const sinkId of sinkLeases.keys()) delivered += await dispatchSink(sinkId);
    return delivered;
  }

  const fenced = (lease: Lease) => fencedExecutor(database, leases, lease, options.inTransaction);

  function iamJob(job: ResolvedOptions['iamJobs'][number]): Job {
    const lease = singleton(`iam:${job.name}`);
    return {
      async tick() {
        if (!(await lease.ensure())) return 0;
        await job.run();
        return 1;
      },
    };
  }

  // --- Loops ------------------------------------------------------------------------------------

  function loop(name: string, pass: () => Promise<number>, idleMs: number): void {
    if (running.has(name)) return;
    const signal = stopController.signal;
    const done = (async () => {
      while (!signal.aborted) {
        let worked = 0;
        try {
          worked = await pass();
        } catch (error) {
          log.error(`The ${name} job failed`, { job: name, error: message(error) });
        }
        if (signal.aborted) break;
        await sleep(worked > 0 ? 0 : idleMs, signal);
      }
    })();
    running.set(name, done);
  }

  return {
    workerId,
    monitor,
    leases,
    pokes,
    jobs,
    events: {
      subscribe: (pattern, handler) => localEvents.subscribe(pattern, handler),
    },

    ports(registry) {
      return Object.freeze({
        leases,
        work,
        desired,
        commands: createCommandQueue({
          registry,
          ...(options.notifier ? { notifier: options.notifier } : {}),
          afterCommit: options.afterCommit,
          // Signed intent (v0.2): every command signed by this worker's key (`pki.commandSigning`).
          ...(options.commandSigner ? { signer: options.commandSigner } : {}),
        }),
        events: eventPublisher,
        authz: authzWriter,
        capacity,
        inventory,
      });
    },

    bind(input) {
      if (bound) throw new ComputeError('INVALID_STATE', 'The runtime is already bound');
      const reserved = new Set<string>(builtinJobNames);
      const collected = collectReconcilers(input.modules, reserved);
      const runners = new Map<string, ReconcilerRunner>();
      for (const { reconciler, periodic } of collected) {
        const role = reconcilerRole(reconciler);
        runnerRoles.set(reconciler.name, role);
        if (reconciler.shardBy !== 'none') membershipRoles.add(role);
        const runner = createReconcilerRunner({
          reconciler,
          periodic,
          database,
          leases,
          inTransaction: options.inTransaction,
          clock,
          log,
          context: () => input.context,
          membership: memberships[role],
          singleton: singleton(reconciler.name),
          settings: {
            batchSize: settings.batchSize,
            claimTtlMs: settings.claimTtlMs,
            syncAgainMs: settings.syncAgainMs,
            maxBackoffMs: settings.maxBackoffMs,
            resyncMs: settings.resyncMs,
          },
          get signal() {
            return stopController.signal;
          },
        });
        runners.set(reconciler.name, runner);
        jobs[reconciler.name] = Object.freeze({ tick: () => runner.tick(1) });
      }
      jobs['command-sweeper'] = Object.freeze({ tick: sweep });
      jobs['outbox-dispatch'] = Object.freeze({ tick: dispatchOutbox });
      jobs['event-subscribers'] = Object.freeze({ tick: () => localEvents.tick() });
      for (const job of options.iamJobs) jobs[`iam:${job.name}`] = Object.freeze(iamJob(job));
      Object.freeze(jobs);
      bound = { ...input, runners };
    },

    async initialize() {
      if (isAnchoredClock(clock)) await monitor.sample(database);
    },

    async start(roles) {
      const { runners } = requireBound();
      if (stopController.signal.aborted) stopController = new AbortController();
      const poll = settings.pollMs;
      for (const role of roles) {
        if (loopRoles.has(role)) continue;
        loopRoles.add(role);
        if (role === 'controllers' || role === 'scheduler') {
          for (const [name, runner] of runners)
            if (runnerRoles.get(name) === role) loop(name, () => runner.tick(settings.concurrency), poll);
          if (role === 'controllers') loop('command-sweeper', sweep, settings.sweepMs);
        } else if (role === 'sinks') {
          for (const sinkId of sinkLeases.keys())
            loop(`outbox-dispatch:${sinkId}`, () => dispatchSink(sinkId), poll);
        } else if (role === 'iam') {
          for (const job of options.iamJobs) {
            const tick = jobs[`iam:${job.name}`]!.tick;
            loop(`iam:${job.name}`, async () => (await tick(), 0), job.everyMs);
          }
        }
      }
      if (!eventsLoop) {
        eventsLoop = true;
        loop('event-subscribers', () => localEvents.tick(), Math.min(poll, 250));
        // Renewals on their own timer: a long reconcile batch never delays them. Each pass is free
        // unless something is due; then shards and every due singleton go in one statement each.
        loop(
          'lease-renewal',
          async () => {
            // Only roles with sharded reconcilers of their own join a membership: with no placer
            // registered, a scheduler role holds no `scheduler/shard:<n>` leases at all.
            const shards = shardedRoles
              .filter((role) => loopRoles.has(role) && membershipRoles.has(role))
              .map((role) => memberships[role]);
            await renewLeases(shards, leases, singletons, workerId, settings.leaseTtlMs);
            return 0;
          },
          Math.max(50, Math.min(1_000, Math.floor(settings.renewMs / 5))),
        );
      }
    },

    async stop() {
      stopController.abort();
      const loops = [...running.values()];
      running.clear();
      loopRoles.clear();
      eventsLoop = false;
      await Promise.allSettled(loops);
      const releases: Promise<void>[] = singletons.map((lease) => lease.release());
      releases.push(membership.leave(), schedulerMembership.leave());
      for (const result of await Promise.allSettled(releases))
        if (result.status === 'rejected')
          log.warn('Releasing a lease on stop failed', { error: message(result.reason) });
      // Jobs stepped after stop() (tests) run again; a later start() starts fresh loops.
      stopController = new AbortController();
    },

    findings: () => monitor.findings(),

    authzRow: (type, id, tenantId) =>
      readAuthzRow(database, options.typePrefix, type, id, tenantId),
  };
}
