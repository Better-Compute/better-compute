// The fleet simulator with the real control plane behind it (PLAN.md §15): `betterCompute` on the sim clock
// (compute_now() pinned to simulated time), the real gateway on manual jobs, and FakeDaemons that joined through
// JoinService with sealed tokens. The control plane's reconcilers and the gateway's jobs run on the simulator's
// ticks, so a run is deterministic up to the store. `controlPlaneFacts` reads what the invariant checkers need
// from compute's own tables: bookings (I1), billed allocations and usage windows (I8), command outcomes (I2) and
// connectivity transitions (I5).

import { create } from '@bufbuild/protobuf';
import type { IamPort, SqlExecutor } from '@better-compute/core';
import {
  attachFrameConn,
  createGateway,
  type Gateway,
  type GatewayOptions,
} from '@better-compute/gateway';
import {
  createCsr,
  createNodeCa,
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
import { createFleetSim, type FleetSim, type FleetSimOptions } from './fleet-sim.js';
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
        const end = row.ended ? (ms(row.released_ms) ?? ms(row.upper_ms)) : undefined;
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
  /** Gateway processes behind the simulator (default 1); dials are spread over the live ones. */
  gateways?: number;
  /** Extra gateway options (e.g. lease timings). */
  gateway?: Partial<
    Omit<
      GatewayOptions,
      'database' | 'services' | 'work' | 'events' | 'reports' | 'manual' | 'clock' | 'id'
    >
  >;
}

interface GatewaySlot {
  index: number;
  gateway?: Gateway;
  starting?: Promise<Gateway>;
  down: boolean;
  stalled: boolean;
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
  ])
    fake.allow({ token: tenants.acme.token, action });

  const nodeCa = createNodeCa({ clock, trustDomain });
  const signingKey = createSigningKey({ clock });
  const encryption = generateP256KeyPair();
  const compute = betterCompute({
    database,
    iam: options.iam ? options.iam(fake) : fake,
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
    const count = options.nodes ?? 4;
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
    await trace('join', async () => {
      for (let index = 0; index < count; index++) {
        const hardware = fakeHardware({
          seed: `${options.seed}-${index}`,
          ...(options.variant ? { variant: options.variant } : {}),
        });
        const csr = createCsr(generateP256KeyPair().privateKey);
        const sealed = sealJoinToken(minted.token!, encryption.publicKey, {
          csr,
          issuedAt: now(),
        });
        const response = await compute.gatewayServices.join(
          create(JoinRequestSchema, {
            sealedToken: new TextEncoder().encode(sealed),
            csr,
            claims: create(HardwareClaimsSchema, hardware.claims),
            daemonVersion: '0.1.0',
            role: AgentRole.NODE,
          }),
        );
        const { nodeId } = verifyJoinResponse(response, {
          signer: { publicKey: signingKey.publicKey },
          csr,
          nodeCaRoots: [nodeCa.certificate],
          now: now(),
        });
        nodes.push({ nodeId, hardware });
      }
    });

    // Gateway slots: each runs one real gateway process at a time. A dial goes to the next live, running slot;
    // `killGateway` crashes a slot's process (no disconnect writes, no lease release) and resets its links so the
    // daemons re-home; `stallGateway` stops a slot's jobs (a paused process) while its connections stay open.
    slots = Array.from({ length: Math.max(1, options.gateways ?? 1) }, (_, index) => ({
      index,
      down: false,
      stalled: false,
      generation: 0,
    }));
    const slotGateway = async (slot: GatewaySlot): Promise<Gateway> => {
      if (slot.gateway) return slot.gateway;
      slot.starting ??= (async () => {
        const created = createGateway({
          id: `gw_sim_${slot.index + 1}_${++slot.generation}`,
          region: 'sim',
          database,
          clock,
          manual: true,
          services: compute.gatewayServices,
          work: compute.context.work,
          events: compute.context.events,
          reports: gatewayReportHandlers,
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
    const facts = controlPlaneFacts(raw);
    const {
      nodes: _nodes,
      variant: _variant,
      iam: _iam,
      trace: _trace,
      gateways: _gateways,
      gateway: _gateway,
      ...fleetOptions
    } = options;
    sim = createFleetSim({
      ...fleetOptions,
      start,
      nodes: nodes.map(({ nodeId, hardware }) => ({ nodeId, hardware })),
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
          attachFrameConn(
            await slotGateway(slot),
            { nodeId: peer.nodeId, role: 'node' },
            conn as never,
          );
        },
        async tick() {
          await trace('gateway', async () => {
            for (const slot of slots) {
              if (slot.down || slot.stalled) continue;
              const current = await slotGateway(slot);
              for (const job of ['lease', 'dispatch', 'status', 'liveness', 'specs'] as const)
                await current.jobs[job].tick();
            }
          });
          await trace('reconcilers', async () => {
            for (const job of Object.values(compute.jobs)) await job.tick();
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
