// The fleet simulator with the real control plane behind it (PLAN.md §15): `betterCompute` on the sim clock
// (compute_now() pinned to simulated time), the real gateway on manual jobs, and FakeDaemons that joined through
// JoinService with sealed tokens. The control plane's reconcilers and the gateway's jobs run on the simulator's
// ticks, so a run is deterministic up to the store. `controlPlaneFacts` reads what the invariant checkers need
// from compute's own tables: bookings (I1), billed allocations and usage windows (I8), command outcomes (I2) and
// connectivity transitions (I5).

import type { KeyObject } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import {
  ComputeError,
  defineAttestor,
  type ComputeModule,
  type IamPort,
  type SqlExecutor,
  type SqlTx,
} from '@better-compute/core';
import {
  attachFrameConn,
  createGateway,
  xidStatusHandler,
  type Gateway,
  type GatewayOptions,
  type StatusHandler,
} from '@better-compute/gateway';
import {
  createCsr,
  createNodeCa,
  createRevocationFeed,
  createRevocationSet,
  parseCertificate,
  createSigningKey,
  generateP256KeyPair,
  sealJoinToken,
  verifyJoinResponse,
} from '@better-compute/pki';
import { setSimClock, useSimClock } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { AgentRole, HardwareClaimsSchema, JoinRequestSchema } from '@better-compute/protocol';
import {
  betterCompute,
  gatewayReportHandlers,
  pkiJoinCrypto,
  type BetterCompute,
} from '@better-compute/server';
import { fakeHardware, type FakeHardware, type FakeHardwareVariant } from '../fake-hw.js';
import { fakeIam, type FakeIam } from '../fake-iam.js';
import {
  createFleetSim,
  type FleetDaemonOptions,
  type FleetSim,
  type FleetSimOptions,
} from './fleet-sim.js';
import type {
  BilledAllocation,
  BookingRow,
  ConnectivityFact,
  InvariantViolation,
  ServerOutcome,
  UsageWindow,
} from './invariants.js';
import type { GatewayFacts } from './port.js';

const hourMs = 3_600_000;
const terminal = ['succeeded', 'failed', 'rejected', 'expired', 'cancelled'];

export interface ControlPlaneFacts {
  /** Reads the store's current facts; `facts()` answers from the last refresh. */
  refresh(): Promise<void>;
  facts(): GatewayFacts;
}

const ms = (value: unknown): number | undefined =>
  value === null || value === undefined ? undefined : Number(value);

/**
 * Invariant facts from compute's tables. Usage windows are hour-aligned with `quantity = GPUs × fraction of the
 * hour`; each is clipped to its allocation's billed span `[bound_at, released_at or the booked end)` and its atoms
 * derived from the quantity, so a mis-metered window shows up as a fractional atom count that breaks I8's sum.
 */
export function controlPlaneFacts(database: Pick<SqlExecutor, 'query'>): ControlPlaneFacts {
  let current: GatewayFacts = {
    bookings: [],
    releases: [],
    allocations: [],
    usage: [],
    connectivity: [],
    outcomes: [],
  };
  return {
    facts: () => current,
    async refresh() {
      const bookings = await database.query<{
        allocation_id: string;
        device_id: string;
        node_id: string | null;
        start_ms: number;
        end_ms: number | null;
      }>(
        `SELECT b.allocation_id, b.device_id, a.node_id,
                extract(epoch FROM lower(b.during)) * 1000 AS start_ms,
                CASE WHEN upper_inf(b.during) THEN NULL ELSE extract(epoch FROM upper(b.during)) * 1000 END AS end_ms
           FROM device_bookings b LEFT JOIN allocations a ON a.id = b.allocation_id`,
      );
      const allocations = await database.query<{
        id: string;
        atoms: number;
        bound_ms: number | null;
        released_ms: number | null;
        upper_ms: number | null;
        ended: boolean;
      }>(
        `SELECT id, coalesce(array_length(atoms, 1), 0) AS atoms,
                extract(epoch FROM bound_at) * 1000 AS bound_ms,
                extract(epoch FROM released_at) * 1000 AS released_ms,
                CASE WHEN upper_inf(during) THEN NULL ELSE extract(epoch FROM upper(during)) * 1000 END AS upper_ms,
                (released_at IS NOT NULL OR (NOT upper_inf(during) AND upper(during) <= compute_now())) AS ended
           FROM allocations`,
      );
      const billed = new Map<string, BilledAllocation>();
      for (const row of allocations.rows) {
        const start = ms(row.bound_ms);
        if (start === undefined) continue;
        // Billing ends at the release or the booked end, whichever is first (a release processed after the booking
        // ended, e.g. during a worker outage, does not extend it).
        const released = ms(row.released_ms);
        const upper = ms(row.upper_ms);
        const end = row.ended
          ? released !== undefined && upper !== undefined
            ? Math.min(released, upper)
            : (released ?? upper)
          : undefined;
        billed.set(row.id, {
          allocationId: row.id,
          start,
          ...(end !== undefined ? { end: Math.max(start, end) } : {}),
          atoms: Number(row.atoms),
        });
      }
      const windows = await database.query<{
        idempotency_key: string;
        allocation_id: string;
        start_ms: number;
        end_ms: number;
        quantity: string | number;
      }>(
        `SELECT idempotency_key, allocation_id, quantity,
                extract(epoch FROM window_start) * 1000 AS start_ms,
                extract(epoch FROM window_end) * 1000 AS end_ms
           FROM usage_windows WHERE meter LIKE 'gpu.%'`,
      );
      const usage: UsageWindow[] = windows.rows.map((row) => {
        const allocation = billed.get(row.allocation_id);
        const start = Math.max(Number(row.start_ms), allocation?.start ?? Number(row.start_ms));
        const end = Math.min(Number(row.end_ms), allocation?.end ?? Number(row.end_ms));
        const span = end - start;
        const raw = span > 0 ? (Number(row.quantity) * hourMs) / span : 0;
        // Metering rounds quantities to 1e-6 units; within that rounding the window bills whole atoms, and
        // anything further off stays fractional so I8 reports it.
        const tolerance = span > 0 ? ((0.5e-6 * hourMs) / span) * 1.01 : 0;
        const whole = Math.round(raw);
        return {
          key: row.idempotency_key,
          allocationId: row.allocation_id,
          start,
          end,
          atoms: Math.abs(raw - whole) <= tolerance ? whole : raw,
        };
      });
      const outcomes = await database.query<{
        id: string;
        node_id: string;
        state: string;
        reason: string | null;
      }>('SELECT id, node_id, state, reason FROM commands WHERE state = ANY($1::text[])', [
        terminal,
      ]);
      const transitions = await database.query<{
        topic: string;
        node_id: string;
        time: string;
      }>(
        `SELECT topic, payload->'data'->>'nodeId' AS node_id, payload->>'time' AS time FROM outbox
          WHERE topic IN ('node.connected', 'node.disconnected', 'node.unreachable') ORDER BY txid, seq`,
      );
      current = {
        bookings: bookings.rows.map(
          (row): BookingRow => ({
            allocationId: row.allocation_id,
            deviceId: row.device_id,
            ...(row.node_id ? { nodeId: row.node_id } : {}),
            start: Number(row.start_ms),
            end: row.end_ms === null ? Infinity : Number(row.end_ms),
          }),
        ),
        releases: [],
        allocations: [...billed.values()],
        usage,
        connectivity: transitions.rows
          .filter((row) => row.node_id)
          .map(
            (row): ConnectivityFact => ({
              nodeId: row.node_id,
              at: Date.parse(row.time),
              state: row.topic.slice('node.'.length) as ConnectivityFact['state'],
            }),
          ),
        outcomes: outcomes.rows.map(
          (row): ServerOutcome => ({
            commandId: row.id,
            nodeId: row.node_id,
            state: row.state,
            ...(row.state === 'failed' && row.reason ? { errorCode: row.reason } : {}),
          }),
        ),
      };
    },
  };
}

export interface ControlPlaneSimOptions
  extends Omit<FleetSimOptions, 'gateway' | 'nodes' | 'start' | 'stub'> {
  /** Nodes to join (default 4). */
  nodes?: number;
  variant?: FakeHardwareVariant;
  /** Sim start (default 2026-01-01T00:00:00Z). */
  start?: number;
  /** Wraps the fake IAM before compute gets it (e.g. `(iam) => spyIamPort(iam)`). */
  iam?: (fake: FakeIam) => IamPort;
  /**
   * Runs each part of the loop under a name (`join`, `fleet` for everything the simulator delivers,
   * `gateway` for the gateway's jobs, `reconcilers` for the control plane's, `api` for `api()` calls):
   * pass an IAM spy's `path` to attribute calls. Default: runs `fn` as is.
   */
  trace?: <T>(path: string, fn: () => T) => T;
  /**
   * The last `count` nodes join through a test attestor (`sim-restricted`) that admits them with these
   * `allowedKinds` (exact kinds or `prefix.*`): their certificates only allow those command kinds.
   */
  restricted?: { count: number; allowedKinds: readonly string[] };
  /** Modules the control plane runs besides the built-ins (their reconcilers tick with the others). */
  modules?: readonly ComputeModule[];
  /** Gateway processes behind the simulator (default 1); dials are spread over the live ones. */
  gateways?: number;
  /**
   * Passes each control-plane job may run per simulator tick while it keeps finding work (default 1: one batch per
   * job per tick). A real worker loops without sleeping while there is work (§8), so a queue of thousands drains
   * within a tick or two; raise this to model that (e.g. 10 ≈ one worker draining ten 32-key batches a second).
   */
  workerPasses?: number;
  /** Extra gateway options (e.g. lease timings). */
  gateway?: Partial<
    Omit<
      GatewayOptions,
      'database' | 'services' | 'work' | 'events' | 'reports' | 'manual' | 'clock' | 'id'
    >
  >;
  /**
   * More pools on the same site, each with its own nodes, which join after the main pool's (in order):
   * e.g. a `vps-host` pool whose daemons run a FakeHypervisor (`daemon: { instances: {} }`). `nodes`
   * stays the main pool's; `pools` lists these.
   */
  extraPools?: readonly ExtraPoolOptions[];
  /** Status report handlers run after the XID health handler, e.g. vps's `instanceStatusHandler()`. */
  statusHandlers?: readonly StatusHandler[];
}

export interface ExtraPoolOptions {
  class: string;
  /** Nodes to join into it (default 1). */
  count?: number;
  /** Options for its daemons, over the fleet's (`daemon`). */
  daemon?: FleetDaemonOptions;
  policy?: Record<string, unknown>;
  /** Anything else `pools.create` takes (e.g. `ownerQuota`). */
  create?: Record<string, unknown>;
  /** Runs once the pool exists, before its nodes join (flavors, IP pools). */
  setup?(pool: {
    poolId: string;
    siteId: string;
    compute: BetterCompute;
    database: SqlExecutor;
    /** The root administrator's credential and tenant, for API calls. */
    root: { token: string };
    rootTenantId: string;
  }): Promise<void>;
}

interface GatewaySlot {
  index: number;
  gateway?: Gateway;
  starting?: Promise<Gateway>;
  down: boolean;
  stalled: boolean;
  /** Partitioned from the database (its connections stay up to the daemons). */
  dbCut: boolean;
  generation: number;
}

export interface ControlPlaneSim {
  sim: FleetSim;
  compute: BetterCompute;
  /** The store without the sim-clock pin, for assertions. */
  database: SqlExecutor;
  fakeIam: FakeIam;
  tenants: { root: { id: string; token: string }; acme: { id: string; token: string } };
  siteId: string;
  poolId: string;
  nodes: readonly { nodeId: string; hardware: FakeHardware }[];
  /** The `extraPools`, in order, with the nodes that joined each. */
  pools: readonly { poolId: string; class: string; nodeIds: readonly string[] }[];
  /** The first gateway slot's current process. */
  readonly gateway: Gateway | undefined;
  /** Every slot's current process (undefined while down, or before its first dial). */
  readonly gateways: readonly (Gateway | undefined)[];
  /** The slot whose gateway holds the node's session right now. */
  homeOf(nodeId: string): number | undefined;
  /** Crashes slot `index` (no disconnect writes, no lease release), keeps it down and resets its daemons' links; returns the nodes it served. */
  killGateway(index: number): string[];
  /** Lets a killed slot take dials again (a fresh process). */
  reviveGateway(index: number): void;
  /** Pauses (or resumes) slot `index`'s jobs while its connections stay open: a stalled process. */
  stallGateway(index: number, stalled: boolean): void;
  /** Stops (or restarts) the control plane's reconcilers and sweepers: every worker process down. */
  pauseWorkers(paused: boolean): void;
  /**
   * Makes the database unreachable from every process (a failover), or brings it back: new statements and those
   * of transactions in flight fail with a connection error until then. Loops that fail meanwhile are counted in
   * `outageErrors` instead of failing the run, as a real process's timers would log and retry.
   */
  failDatabase(down: boolean): void;
  /** Partitions slot `index`'s gateway from the database only (its daemon connections stay up), or heals it. */
  cutGatewayDatabase(index: number, cut: boolean): void;
  /** Loop runs that failed on a simulated database outage (`failDatabase`, `cutGatewayDatabase`). */
  readonly outageErrors: number;
  /** The serial of the node certificate it joined with. */
  serialOf(nodeId: string): string | undefined;
  /**
   * Revokes the node's certificates through the operator API (`nodes.revokeIdentity`): the gateways learn it on the
   * next tick, close its session and refuse its dials.
   */
  revokeNode(nodeId: string, reason?: string): Promise<void>;
  facts: ControlPlaneFacts;
  /** Runs an operator or tenant call (traced as `api`). */
  api<T>(fn: () => Promise<T>): Promise<T>;
  /** Advances simulated time (traced as `fleet`). */
  run(ms: number): Promise<void>;
  /** Refreshes the store facts and checks I1, I2, I5 and I8. */
  invariants(options?: { flushedUpTo?: number }): Promise<InvariantViolation[]>;
  close(): Promise<void>;
}

/** Every statement first moves compute_now() to the simulated time (never backwards). */
function pinned(db: SqlExecutor, now: () => number): SqlExecutor {
  let last = -1;
  const sync = async () => {
    const time = now();
    if (time > last) {
      try {
        await setSimClock(db, time);
        last = time;
      } catch (error) {
        // Before `useSimClock` (compute.initialize() starting its modules): nothing to move yet.
        if ((error as { code?: unknown }).code !== 'INVALID_STATE') throw error;
      }
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

const outageMessage = 'sim: database unreachable';

/** The error a statement gets during a simulated outage (shaped like a refused Postgres connection). */
function outageError(): Error {
  return Object.assign(new Error(outageMessage), { code: 'ECONNREFUSED', simOutage: true });
}

/** Whether `error` (or a cause it wraps) comes from a simulated outage. */
function isOutage(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 8; depth++) {
    if ((current as { simOutage?: unknown }).simOutage === true) return true;
    if (String((current as { message?: unknown }).message ?? current).includes(outageMessage))
      return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** `db` as seen from a process that may lose it: every statement first checks `down()`. */
function faulty(db: SqlExecutor, down: () => boolean): SqlExecutor {
  const check = () => {
    if (down()) throw outageError();
  };
  const wrapTx = (tx: SqlTx): SqlTx =>
    new Proxy(tx, {
      get(target, property, receiver) {
        if (property === 'query')
          return async (text: string, params?: readonly unknown[]) => {
            check();
            return target.query(text, params);
          };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  return {
    dialect: db.dialect,
    kind: db.kind,
    async query(text, params) {
      check();
      return db.query(text, params);
    },
    async transaction(fn, options) {
      check();
      return db.transaction((tx) => fn(wrapTx(tx)), options);
    },
    migrate: (extra) => db.migrate(extra),
    close: () => db.close(),
  } as SqlExecutor;
}

const trustDomain = 'compute.sim.test';
const tenants = {
  root: { id: 'tenant-root', token: 'biam_ses_sim_root' },
  acme: { id: 'tenant-acme', token: 'biam_ses_sim_acme' },
};

/**
 * The real control plane and gateway under the fleet simulator. The deployment is set up through the API (a
 * site, an H100 pool with diag.nvml acceptance offered to acme), `nodes` machines join through JoinService,
 * and the simulator starts; `run(ms)` then advances everything together.
 */
export async function createControlPlaneSim(
  options: ControlPlaneSimOptions,
): Promise<ControlPlaneSim> {
  const start = options.start ?? Date.UTC(2026, 0, 1);
  const trace = options.trace ?? (<T>(_path: string, fn: () => T) => fn());
  let sim: FleetSim | undefined;
  const now = () => sim?.scheduler.now() ?? start;
  const clock = { now };
  const raw = pglite();
  const database = pinned(raw, now);
  let databaseDown = false;
  let outageErrors = 0;
  // What the control plane's processes see: the pinned store, which a simulated failover takes away.
  const reachable = faulty(database, () => databaseDown);
  /** Runs a loop; a failure caused by a simulated outage is counted (a real timer logs and retries). */
  const survive = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      if (!isOutage(error)) throw error;
      outageErrors++;
    }
  };

  const fake = fakeIam({
    callers: Object.fromEntries(
      Object.entries(tenants).map(([name, tenant]) => [
        tenant.token,
        {
          identityId: `identity-${name}`,
          identityKind: 'user' as const,
          tenantId: tenant.id,
          sessionId: `session-${name}`,
          sessionKind: 'user' as const,
          mfa: name === 'root',
        },
      ]),
    ),
  });
  fake.allow({ token: tenants.root.token });
  for (const action of [
    'compute:pools:read',
    'compute:reservations:create',
    'compute:reservations:read',
    'compute:reservations:release',
    // Instances in a vps-host `extraPools` entry.
    'compute:instances:create',
    'compute:instances:read',
    'compute:instances:delete',
  ])
    fake.allow({ token: tenants.acme.token, action });

  const nodeCa = createNodeCa({ clock, trustDomain });
  const signingKey = createSigningKey({ clock });
  const encryption = generateP256KeyPair();
  let restrictedPool: string | undefined;
  const restrictedAttestor = defineAttestor({
    id: 'sim-restricted',
    version: '1.0.0',
    roles: ['node'],
    async verify() {
      if (!restrictedPool || !options.restricted)
        throw new ComputeError('ACCESS_DENIED', 'Join refused');
      return {
        tenantId: tenants.root.id,
        role: 'node',
        poolId: restrictedPool,
        trust: 'platform',
        allowedKinds: [...options.restricted.allowedKinds],
      };
    },
  });
  const compute = betterCompute({
    database: reachable,
    iam: options.iam ? options.iam(fake) : fake,
    attestors: [restrictedAttestor],
    ...(options.modules ? { modules: [...options.modules] } : {}),
    secret: 'better-compute-control-plane-sim-secret-0123456789',
    baseURL: 'https://compute.sim.test',
    rootTenantId: tenants.root.id,
    clock,
    pki: {
      join: pkiJoinCrypto({
        trustDomain,
        nodeCa,
        signingKey,
        encryptionKey: encryption.privateKey,
      }),
    },
  });
  let slots: GatewaySlot[] = [];
  const close = async () => {
    for (const slot of slots) await slot.gateway?.stop().catch(() => {});
    await compute.stop().catch(() => {});
    await raw.close();
  };
  try {
    await compute.initialize();
    await useSimClock(raw, start);

    const api = <T>(fn: () => Promise<T>) => trace('api', fn);
    const root = { token: tenants.root.token };
    const site = await api(() =>
      compute.api.sites.create(root, {
        tenantId: tenants.root.id,
        kind: 'shared',
        region: 'sim',
        idempotencyKey: 'sim-site',
      }),
    );
    const pool = await api(() =>
      compute.api.pools.create(root, {
        tenantId: tenants.root.id,
        siteId: site.id,
        class: 'metal-host',
        gpuModel: 'H100',
        policy: { acceptance: [{ kind: 'diag.nvml' }] },
        idempotencyKey: 'sim-pool',
      } as never),
    );
    await api(() =>
      compute.api.pools.offer(root, {
        tenantId: tenants.root.id,
        poolId: pool.id,
        toTenantId: tenants.acme.id,
        quota: { gpu: 1_000_000 },
      } as never),
    );
    restrictedPool = pool.id;
    const count = options.nodes ?? 4;
    const restrictedFrom = count - Math.min(count, options.restricted?.count ?? 0);
    const minted = await api(() =>
      compute.api.joinTokens.create(root, {
        tenantId: tenants.root.id,
        poolId: pool.id,
        maxUses: count,
        ttlSeconds: 3600,
        idempotencyKey: 'sim-token',
      }),
    );

    const nodes: { nodeId: string; hardware: FakeHardware }[] = [];
    const serials = new Map<string, string>();
    const nodeKeys = new Map<string, KeyObject>();
    const joinOne = async (token: string, hardware: FakeHardware, attestor?: string): Promise<string> => {
      const { privateKey } = generateP256KeyPair();
      const csr = createCsr(privateKey);
      const sealed = sealJoinToken(token, encryption.publicKey, {
        csr,
        issuedAt: now(),
      });
      const response = await compute.gatewayServices.join(
        create(JoinRequestSchema, {
          sealedToken: new TextEncoder().encode(sealed),
          csr,
          ...(attestor ? { attestor } : {}),
          claims: create(HardwareClaimsSchema, hardware.claims),
          daemonVersion: '0.1.0',
          role: AgentRole.NODE,
        }),
      );
      const { nodeId, certChain } = verifyJoinResponse(response, {
        signer: { publicKey: signingKey.publicKey },
        csr,
        nodeCaRoots: [nodeCa.certificate],
        now: now(),
      });
      serials.set(nodeId, parseCertificate(certChain[0]!).serial);
      nodeKeys.set(nodeId, privateKey);
      return nodeId;
    };
    await trace('join', async () => {
      for (let index = 0; index < count; index++) {
        const hardware = fakeHardware({
          seed: `${options.seed}-${index}`,
          ...(options.variant ? { variant: options.variant } : {}),
        });
        const nodeId = await joinOne(minted.token!, hardware, index >= restrictedFrom ? 'sim-restricted' : undefined);
        nodes.push({ nodeId, hardware });
      }
    });

    // More pools on the site, each with its own join token and nodes (after the main pool's).
    const pools: { poolId: string; class: string; nodeIds: string[] }[] = [];
    const extraNodes: { nodeId: string; hardware: FakeHardware; daemon?: FleetDaemonOptions }[] = [];
    for (const [poolIndex, extra] of (options.extraPools ?? []).entries()) {
      const created = await api(() =>
        compute.api.pools.create(root, {
          tenantId: tenants.root.id,
          siteId: site.id,
          class: extra.class,
          policy: extra.policy ?? {},
          ...extra.create,
          idempotencyKey: `sim-pool-${poolIndex + 1}`,
        } as never),
      );
      await extra.setup?.({
        poolId: created.id,
        siteId: site.id,
        compute: compute as unknown as BetterCompute,
        database: raw,
        root,
        rootTenantId: tenants.root.id,
      });
      const extraCount = extra.count ?? 1;
      const token = await api(() =>
        compute.api.joinTokens.create(root, {
          tenantId: tenants.root.id,
          poolId: created.id,
          maxUses: extraCount,
          ttlSeconds: 3600,
          idempotencyKey: `sim-token-${poolIndex + 1}`,
        }),
      );
      const nodeIds: string[] = [];
      await trace('join', async () => {
        for (let index = 0; index < extraCount; index++) {
          const hardware = fakeHardware({ seed: `${options.seed}-pool${poolIndex + 1}-${index}` });
          const nodeId = await joinOne(token.token!, hardware);
          nodeIds.push(nodeId);
          extraNodes.push({ nodeId, hardware, ...(extra.daemon ? { daemon: extra.daemon } : {}) });
        }
      });
      pools.push({ poolId: created.id, class: extra.class, nodeIds });
    }

    // Gateway slots: each runs one real gateway process at a time. A dial goes to the next live, running slot;
    // `killGateway` crashes a slot's process (no disconnect writes, no lease release) and resets its links so the
    // daemons re-home; `stallGateway` stops a slot's jobs (a paused process) while its connections stay open.
    slots = Array.from({ length: Math.max(1, options.gateways ?? 1) }, (_, index) => ({
      index,
      down: false,
      stalled: false,
      dbCut: false,
      generation: 0,
    }));
    const slotGateway = async (slot: GatewaySlot): Promise<Gateway> => {
      if (slot.gateway) return slot.gateway;
      slot.starting ??= (async () => {
        const created = createGateway({
          id: `gw_sim_${slot.index + 1}_${++slot.generation}`,
          region: 'sim',
          database: faulty(database, () => databaseDown || slot.dbCut),
          clock,
          manual: true,
          services: compute.gatewayServices,
          work: compute.context.work,
          events: compute.context.events,
          // As `serve` composes them: node XIDs feed §10.1 health (conditions, NoSchedule, the health reconciler).
          reports: {
            ...gatewayReportHandlers,
            status: options.statusHandlers?.length ? [xidStatusHandler, ...options.statusHandlers] : xidStatusHandler,
          },
          revocations,
          ...options.gateway,
        });
        await created.start();
        slot.gateway = created;
        slot.starting = undefined;
        return created;
      })();
      return slot.starting;
    };
    let cursor = 0;
    let workersDown = false;
    // Revoked certificates reach every gateway through one set, fed from node_certs on each tick (sim time).
    const revocations = createRevocationSet();
    const revocationFeed = createRevocationFeed({ sql: reachable, revocations, clock });
    const facts = controlPlaneFacts(raw);
    const {
      nodes: _nodes,
      variant: _variant,
      iam: _iam,
      trace: _trace,
      gateways: _gateways,
      restricted: _restricted,
      modules: _modules,
      gateway: _gateway,
      workerPasses: _workerPasses,
      extraPools: _extraPools,
      statusHandlers: _statusHandlers,
      ...fleetOptions
    } = options;
    const workerPasses = Math.max(1, options.workerPasses ?? 1);
    sim = createFleetSim({
      ...fleetOptions,
      start,
      nodes: [
        ...nodes.map(({ nodeId, hardware }) => ({ nodeId, hardware })),
        // Extra pools' daemons hold the key they joined with: a VPS host signs its SecretRequests (user data).
        ...extraNodes.map(({ nodeId, hardware, daemon }) => ({
          nodeId,
          hardware,
          daemon: { ...fleetOptions.daemon, ...daemon, nodeKey: nodeKeys.get(nodeId)! },
        })),
      ],
      logFrames: options.logFrames ?? false,
      gateway: () => ({
        async accept(conn, peer) {
          const live = slots.filter((slot) => !slot.down && !slot.stalled);
          if (!live.length) {
            // Nothing to serve it: the dial is refused and the daemon backs off.
            (conn as unknown as { close(reason?: string): void }).close('no gateway');
            return;
          }
          const slot = live[cursor++ % live.length]!;
          // The certificate serial the node joined with: revocations close and refuse it.
          const serial = serials.get(peer.nodeId);
          attachFrameConn(
            await slotGateway(slot),
            { nodeId: peer.nodeId, role: 'node', ...(serial ? { serial } : {}) },
            conn as never,
          );
        },
        async tick() {
          await revocationFeed.poll().catch(() => 0);
          await trace('gateway', async () => {
            for (const slot of slots) {
              if (slot.down || slot.stalled) continue;
              const current = await slotGateway(slot);
              for (const job of ['lease', 'dispatch', 'status', 'liveness', 'specs'] as const)
                await survive(() => current.jobs[job].tick());
            }
          });
          // A dead worker runs nothing: its keys wait in the work queue until one runs again.
          if (!workersDown)
            await trace('reconcilers', async () => {
              for (const job of Object.values(compute.jobs))
                for (let pass = 0; pass < workerPasses; pass++) {
                  let worked = 0;
                  await survive(async () => {
                    worked = await job.tick();
                  });
                  if (!(worked > 0)) break;
                }
            });
        },
        kill() {
          // The simulator's gateway kill takes down every process; fresh ones take the next dials.
          for (const slot of slots) {
            slot.gateway?.crash();
            slot.gateway = undefined;
          }
        },
        facts: () => facts.facts(),
      }),
    });
    // A zombie may still list a session its node has left: the node's home is the newest epoch's gateway.
    const homeOf = (nodeId: string): number | undefined => {
      let best: { index: number; epoch: number } | undefined;
      for (const slot of slots)
        for (const session of slot.gateway?.sessions() ?? [])
          if (session.nodeId === nodeId && (!best || session.epoch > best.epoch))
            best = { index: slot.index, epoch: session.epoch };
      return best?.index;
    };
    await trace('fleet', () => sim!.start());

    return {
      sim,
      compute: compute as unknown as BetterCompute,
      database: raw,
      fakeIam: fake,
      tenants,
      siteId: site.id,
      poolId: pool.id,
      nodes,
      pools,
      get gateway() {
        return slots[0]!.gateway;
      },
      get gateways() {
        return slots.map((slot) => slot.gateway);
      },
      homeOf,
      killGateway(index) {
        const slot = slots[index]!;
        const homed = slot.gateway?.sessions().map((session) => session.nodeId) ?? [];
        slot.gateway?.crash();
        slot.gateway = undefined;
        slot.down = true;
        for (const nodeId of homed) sim!.resetLink(nodeId);
        return homed;
      },
      reviveGateway(index) {
        slots[index]!.down = false;
      },
      stallGateway(index, stalled) {
        slots[index]!.stalled = stalled;
      },
      pauseWorkers(paused) {
        workersDown = paused;
      },
      failDatabase(down) {
        databaseDown = down;
      },
      cutGatewayDatabase(index, cut) {
        slots[index]!.dbCut = cut;
      },
      get outageErrors() {
        return outageErrors;
      },
      serialOf: (nodeId) => serials.get(nodeId),
      async revokeNode(nodeId, reason = 'sim revocation') {
        await api(() =>
          compute.api.nodes.revokeIdentity(root, {
            tenantId: tenants.root.id,
            nodeId,
            reason,
          } as never),
        );
      },
      facts,
      api,
      run: (ms) => trace('fleet', () => sim!.run(ms)),
      async invariants(invariantOptions) {
        await facts.refresh();
        return sim!.invariants(invariantOptions);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
