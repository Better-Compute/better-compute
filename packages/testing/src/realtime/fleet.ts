// The real-time fleet (PLAN.md §15 "Real-time harness", §16 v0.1 acceptance): the whole v0.1 spine on the wall
// clock. A real control plane (`betterCompute` with its workers started, JoinService on real PKI), a real gateway
// wired to it (its GatewayServices, report handlers, work queue and outbox, pokes through an in-process
// notifier), and FakeDaemons that Join over h2c with a sealed token bound to their CSR. `join()` times each node
// from its Join call to adopted (acceptance passed, NodeSpec generation applied); `place()` times reservations
// from placed to active (the assignment reached the daemon, which reported AllocationBound).

import { create } from '@bufbuild/protobuf';
import { ComputeError, systemClock, type Notifier, type SqlExecutor } from '@better-compute/core';
import {
  createGateway,
  serveGateway,
  type Gateway,
  type GatewayOptions,
  type ServedGateway,
} from '@better-compute/gateway';
import { createMetrics, type MetricsRegistry } from '@better-compute/observability';
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
import { pglite } from '@better-compute/postgres/pglite';
import { AgentRole, HardwareClaimsSchema, JoinRequestSchema } from '@better-compute/protocol';
import {
  betterCompute,
  gatewayReportHandlers,
  pkiJoinCrypto,
  type BetterCompute,
  type WorkerOptions,
} from '@better-compute/server';
import { FakeDaemon, type FakeDaemonOptions } from '../daemon/fake-daemon.js';
import { fakeHardware, type FakeHardwareVariant } from '../fake-hw.js';
import { fakeIam, type FakeIam } from '../fake-iam.js';
import { createRealtimeScheduler } from '../scheduler.js';
import { createH2cClient, TEST_NODE_HEADER, type H2cClient } from './h2c.js';
import { summarize, type LatencySummary } from './harness.js';

export interface RealtimeFleetOptions {
  /** Use this Postgres instead of PGlite (it must be empty or disposable: the fleet migrates it). */
  postgresUrl?: string;
  /** The fake board every node has (default `hgx-h100`, 8 GPUs). */
  variant?: FakeHardwareVariant;
  /** How often the fleet polls the database for state changes (default 10 ms). */
  pollMs?: number;
  /** The control plane's worker tuning (default `pollMs` 20 ms, so reconcilers pick keys up promptly). */
  worker?: WorkerOptions;
  gateway?: Partial<Omit<GatewayOptions, 'database' | 'services' | 'work' | 'events' | 'reports'>>;
  daemon?: Partial<Omit<FakeDaemonOptions, 'nodeId' | 'scheduler' | 'dial' | 'hardware'>>;
  /** Joins at once (default 32): a bound like a real fleet's staggered boot. */
  joinConcurrency?: number;
}

export interface JoinResult {
  nodes: string[];
  /** The Join RPC, relayed by the gateway to JoinService. */
  join: LatencySummary;
  /** Join call → a live session on the gateway. */
  connected: LatencySummary;
  /** Join call → `adopted` with its NodeSpec generation applied (`observed_generation = generation ≥ 1`). */
  adopted: LatencySummary;
  elapsedMs: number;
  /** Nodes not adopted within the timeout, with their state. */
  missing: { nodeId: string; state: string }[];
}

export interface PlaceResult {
  reservations: string[];
  /** `reservations.create` until it answers `placed`. */
  place: LatencySummary;
  /** Placed → `active` (bound on the node and reported AllocationBound). */
  active: LatencySummary;
  elapsedMs: number;
  /** Reservations not active within the timeout, with their state. */
  missing: { reservationId: string; state: string }[];
}

export interface RealtimeFleet {
  compute: BetterCompute;
  database: SqlExecutor;
  gateway: Gateway;
  served: ServedGateway;
  client: H2cClient;
  iam: FakeIam;
  metrics: MetricsRegistry;
  tenants: { root: { id: string; token: string }; acme: { id: string; token: string } };
  siteId: string;
  poolId: string;
  daemons: ReadonlyMap<string, FakeDaemon>;
  /** Joins `count` new nodes through the gateway and times them to adopted. */
  join(count: number, options?: { timeoutMs?: number }): Promise<JoinResult>;
  /**
   * Creates `count` reservations of `gpus` GPUs each (default: a whole node) for the acme tenant and times
   * them from placed to active.
   */
  place(
    count: number,
    options?: {
      gpus?: number;
      timeoutMs?: number;
      concurrency?: number;
      /** Paces the creates (a steady arrival rate) instead of issuing them as fast as `concurrency` allows. */
      ratePerSecond?: number;
    },
  ): Promise<PlaceResult>;
  close(): Promise<void>;
}

const TRUST_DOMAIN = 'compute.realtime.test';
const secret = 'better-compute-realtime-fleet-secret-0123456789';
const baseURL = 'https://compute.realtime.test';
const tenants = {
  root: { id: 'tenant-root', token: 'biam_ses_rt_root' },
  acme: { id: 'tenant-acme', token: 'biam_ses_rt_acme' },
};

/** Runs `work` over `items` with at most `limit` in flight. */
async function bounded<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++]!);
    }),
  );
}

/** The core Notifier in process: `gw:<id>` pokes reach the gateway, other channels their subscribers. */
function inProcessNotifier(gateway: () => Gateway | undefined): Notifier {
  const listeners = new Map<string, Set<(message: string) => void>>();
  return {
    async publish(channel, message) {
      for (const listener of listeners.get(channel) ?? []) listener(message ?? '');
      const target = gateway();
      if (!target || !channel.startsWith('gw:')) return;
      try {
        const parsed = JSON.parse(message ?? '{}') as { nodeIds?: unknown };
        target.poke(Array.isArray(parsed.nodeIds) ? parsed.nodeIds.map(String) : undefined);
      } catch {
        target.poke();
      }
    },
    async subscribe(channel, onMessage) {
      const set = listeners.get(channel) ?? new Set();
      set.add(onMessage);
      listeners.set(channel, set);
      return async () => {
        set.delete(onMessage);
      };
    },
  };
}

export async function createRealtimeFleet(
  options: RealtimeFleetOptions = {},
): Promise<RealtimeFleet> {
  const pollMs = options.pollMs ?? 10;
  const database: SqlExecutor = options.postgresUrl
    ? (await import('@better-compute/postgres')).postgres({ url: options.postgresUrl, max: 20 })
    : pglite();
  const iam = fakeIam({
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
  iam.allow({ token: tenants.root.token });
  for (const action of [
    'compute:pools:read',
    'compute:reservations:create',
    'compute:reservations:read',
  ])
    iam.allow({ token: tenants.acme.token, action });

  const nodeCa = createNodeCa({ clock: systemClock, trustDomain: TRUST_DOMAIN });
  const signingKey = createSigningKey({ clock: systemClock });
  const encryption = generateP256KeyPair();
  let gateway: Gateway | undefined;
  // Revoked certificates close live sessions within ~1 s (pki's feed polls node_certs.revoked_at).
  const revocations = createRevocationSet();
  const serials = new Map<string, string>();
  const compute = betterCompute({
    database,
    iam,
    secret,
    baseURL,
    rootTenantId: tenants.root.id,
    clock: systemClock,
    pki: {
      join: pkiJoinCrypto({
        trustDomain: TRUST_DOMAIN,
        nodeCa,
        signingKey,
        encryptionKey: encryption.privateKey,
      }),
    },
    notifier: inProcessNotifier(() => gateway),
    worker: { pollMs: 20, ...options.worker },
  });
  await compute.initialize();

  gateway = createGateway({
    region: 'rt-1',
    database,
    clock: systemClock,
    services: compute.gatewayServices,
    work: compute.context.work,
    events: compute.context.events,
    reports: gatewayReportHandlers,
    revocations,
    handshakesPerSecond: 2_000,
    maxStreams: 10_000,
    ...options.gateway,
  });
  await gateway.start();
  await compute.start();
  const revocationFeed = createRevocationFeed({ sql: database, revocations });
  revocationFeed.start();

  // The deployment an operator sets up: a site, an H100 pool with diag.nvml acceptance offered to acme,
  // and one join token for the whole fleet.
  const root = { token: tenants.root.token };
  const site = await compute.api.sites.create(root, {
    tenantId: tenants.root.id,
    kind: 'shared',
    region: 'rt-1',
    idempotencyKey: 'rt-site',
  });
  const pool = await compute.api.pools.create(root, {
    tenantId: tenants.root.id,
    siteId: site.id,
    class: 'metal-host',
    gpuModel: 'H100',
    policy: { acceptance: [{ kind: 'diag.nvml' }] },
    idempotencyKey: 'rt-pool',
  } as never);
  await compute.api.pools.offer(root, {
    tenantId: tenants.root.id,
    poolId: pool.id,
    toTenantId: tenants.acme.id,
    quota: { gpu: 1_000_000 },
  } as never);

  const served = await serveGateway(gateway, {
    insecure: true,
    authenticate: (peer) => {
      const nodeId = peer.headers[TEST_NODE_HEADER];
      if (typeof nodeId !== 'string' || !nodeId) return undefined;
      const serial = serials.get(nodeId);
      return { nodeId, siteId: site.id, ...(serial ? { serial } : {}) };
    },
  });
  const client = createH2cClient({ url: `http://127.0.0.1:${served.port}` });
  const scheduler = createRealtimeScheduler({ onError: () => {} });
  const daemons = new Map<string, FakeDaemon>();
  const metrics = createMetrics();
  const histograms = {
    join: metrics.histogram(
      'rt_join_seconds',
      'Join RPC',
      [],
      [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    ),
    adopted: metrics.histogram(
      'rt_adopted_seconds',
      'Join → adopted',
      [],
      [0.5, 1, 2, 5, 10, 20, 30, 60],
    ),
    active: metrics.histogram(
      'rt_place_to_active_seconds',
      'Placed → active',
      [],
      [0.1, 0.25, 0.5, 1, 1.5, 2, 5, 10],
    ),
  };
  let seed = 0;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (check: () => Promise<boolean>, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) return false;
      await sleep(pollMs);
    }
    return true;
  };

  return {
    compute: compute as unknown as BetterCompute,
    database,
    gateway,
    served,
    client,
    iam,
    metrics,
    tenants,
    siteId: site.id,
    poolId: pool.id,
    daemons,
    async join(count, joinOptions = {}) {
      const timeoutMs = joinOptions.timeoutMs ?? 120_000;
      const minted = await compute.api.joinTokens.create(root, {
        tenantId: tenants.root.id,
        poolId: pool.id,
        maxUses: count,
        ttlSeconds: 3600,
        idempotencyKey: `rt-token-${seed}`,
      });
      const started = Date.now();
      const calledAt = new Map<string, number>();
      const joinMs: number[] = [];
      const joined: string[] = [];
      const indexes = Array.from({ length: count }, () => seed++);
      await bounded(indexes, options.joinConcurrency ?? 32, async (index) => {
        const hardware = fakeHardware({
          seed: `rt-${index}`,
          ...(options.variant ? { variant: options.variant } : {}),
        });
        const key = generateP256KeyPair().privateKey;
        const csr = createCsr(key);
        const sealed = sealJoinToken(minted.token!, encryption.publicKey, {
          csr,
          issuedAt: Date.now(),
        });
        const at = Date.now();
        const response = await client.join(
          create(JoinRequestSchema, {
            sealedToken: new TextEncoder().encode(sealed),
            csr,
            claims: create(HardwareClaimsSchema, hardware.claims),
            daemonVersion: '0.1.0',
            role: AgentRole.NODE,
          }),
        );
        joinMs.push(Date.now() - at);
        histograms.join.observe(undefined, (Date.now() - at) / 1000);
        const { nodeId, certChain } = verifyJoinResponse(response, {
          signer: { publicKey: signingKey.publicKey },
          csr,
          nodeCaRoots: [nodeCa.certificate],
          now: Date.now(),
        });
        calledAt.set(nodeId, at);
        serials.set(nodeId, parseCertificate(certChain[0]!).serial);
        joined.push(nodeId);
        const daemon = new FakeDaemon({
          backoff: { minMs: 50, maxMs: 2_000 },
          ...options.daemon,
          nodeId,
          scheduler,
          hardware,
          dial: () => client.session(nodeId),
        });
        daemons.set(nodeId, daemon);
        daemon.start();
      });

      const connected = new Map<string, number>();
      const adopted = new Map<string, number>();
      const states = new Map<string, string>();
      await until(async () => {
        const now = Date.now();
        for (const session of gateway!.sessions())
          if (calledAt.has(session.nodeId) && !connected.has(session.nodeId))
            connected.set(session.nodeId, now);
        const open = joined.filter((id) => !adopted.has(id));
        const { rows } = await database.query<{
          id: string;
          provision_state: string;
          generation: number;
          observed_generation: number;
        }>(
          'SELECT id, provision_state, generation, observed_generation FROM nodes WHERE id = ANY($1::text[])',
          [open],
        );
        for (const row of rows) {
          states.set(
            row.id,
            `${row.provision_state} g${row.generation}/o${row.observed_generation}`,
          );
          if (
            row.provision_state === 'adopted' &&
            Number(row.generation) >= 1 &&
            Number(row.observed_generation) >= Number(row.generation)
          ) {
            adopted.set(row.id, now);
            histograms.adopted.observe(undefined, (now - calledAt.get(row.id)!) / 1000);
          }
        }
        return adopted.size === joined.length;
      }, timeoutMs);
      const since = (times: Map<string, number>) =>
        [...times].map(([id, at]) => at - calledAt.get(id)!);
      return {
        nodes: joined,
        join: summarize(joinMs),
        connected: summarize(since(connected)),
        adopted: summarize(since(adopted)),
        elapsedMs: Date.now() - started,
        missing: joined
          .filter((id) => !adopted.has(id))
          .map((nodeId) => ({ nodeId, state: states.get(nodeId) ?? 'unknown' })),
      };
    },
    async place(count, placeOptions = {}) {
      const gpus =
        placeOptions.gpus ??
        fakeHardware(options.variant ? { variant: options.variant } : {}).gpuUuids.length;
      const acme = { token: tenants.acme.token };
      const started = Date.now();
      const placedAt = new Map<string, number>();
      const placeMs: number[] = [];
      const indexes = Array.from({ length: count }, () => seed++);
      const rate = placeOptions.ratePerSecond;
      const active = new Map<string, number>();
      const states = new Map<string, string>();
      // Poll while the creates are still arriving, so early reservations are timed when they turn active.
      const check = async () => {
        const open = [...placedAt.keys()].filter((id) => !active.has(id));
        if (!open.length) return;
        const { rows } = await database.query<{ id: string; state: string }>(
          'SELECT id, state FROM reservations WHERE id = ANY($1::text[])',
          [open],
        );
        const now = Date.now();
        for (const row of rows) {
          states.set(row.id, row.state);
          if (row.state === 'active') {
            active.set(row.id, now);
            histograms.active.observe(undefined, (now - placedAt.get(row.id)!) / 1000);
          }
        }
      };
      let creating = true;
      const poller = (async () => {
        while (creating) {
          await check();
          await sleep(pollMs);
        }
      })();
      try {
        await bounded(indexes, placeOptions.concurrency ?? 8, async (index) => {
          // Paced: each create waits for its slot in the arrival schedule.
          if (rate)
            await sleep(Math.max(0, started + ((index - indexes[0]!) * 1000) / rate - Date.now()));
          const at = Date.now();
          const reservation = await compute.api.reservations.create(acme, {
            tenantId: tenants.acme.id,
            poolId: pool.id,
            devices: [{ class: 'gpu', count: gpus }],
            duration: '1h',
            idempotencyKey: `rt-reservation-${index}`,
          } as never);
          placeMs.push(Date.now() - at);
          if (reservation.state === 'placed' || reservation.state === 'active')
            placedAt.set(reservation.id, Date.now());
          else
            throw new ComputeError(
              'CAPACITY_UNAVAILABLE',
              `Reservation ${reservation.id} is ${reservation.state}`,
            );
        });
      } finally {
        creating = false;
        await poller;
      }
      const ids = [...placedAt.keys()];
      await until(async () => {
        await check();
        return active.size === ids.length;
      }, placeOptions.timeoutMs ?? 60_000);
      return {
        reservations: ids,
        place: summarize(placeMs),
        active: summarize([...active].map(([id, at]) => at - placedAt.get(id)!)),
        elapsedMs: Date.now() - started,
        missing: ids
          .filter((id) => !active.has(id))
          .map((reservationId) => ({
            reservationId,
            state: states.get(reservationId) ?? 'unknown',
          })),
      };
    },
    async close() {
      revocationFeed.stop();
      for (const daemon of daemons.values())
        if (daemon.state !== 'stopped') daemon.crash('fleet-close');
      await client.close();
      await served.close();
      await compute.stop().catch(() => {});
      await gateway!.stop().catch(() => {});
      await database.close();
    },
  };
}
