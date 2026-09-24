// The local development stack behind `better-compute dev` (PLAN.md §14 Topologies, "Dev"): one `all` process
// with a control plane on PGlite, JoinService on local CAs, a real gateway on cleartext HTTP/2, and simulated
// machines (FakeDaemons) that join the way `bcd join` does: a sealed join token bound to their CSR, the `Join`
// RPC through the gateway, a signed JoinResponse checked against the pinned keys, then a `Session` stream.
// Acceptance, adoption, NodeSpec, reservations and liveness all run on the real runtime and gateway loops.
// Local development only: sessions authenticate by a header over h2c (no TLS), and the secret is fixed.

import { create } from '@bufbuild/protobuf';
import {
  ComputeError,
  type ComputeModule,
  type Credential,
  type IamPort,
  type Logger,
  type Notifier,
  type SqlExecutor,
} from '@better-compute/core';
import {
  createGateway,
  serveGateway,
  type Gateway,
  type GatewayOptions,
  type ServedGateway,
} from '@better-compute/gateway';
import {
  createCsr,
  createNodeCa,
  createSigningKey,
  generateP256KeyPair,
  parseCertificate,
  publicJwk,
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
import { fakeIam } from '../fake-iam.js';
import {
  createH2cClient,
  isRetryable,
  TEST_NODE_HEADER,
  type GrpcStatus,
} from '../realtime/h2c.js';
import { createRealtimeScheduler } from '../scheduler.js';

/** The IAM the stack runs with: a port, its root tenant and a credential of a root administrator. */
export interface DevStackIam {
  port: IamPort;
  rootTenantId: string;
  root: Credential;
  /** Modules the IAM side needs registered in compute (the IAM bridge's `bridge.modules`). */
  modules?: readonly ComputeModule[];
}

export interface DevStackOptions {
  /** The store (default: PGlite in memory). The stack migrates it and closes it on `close()`. */
  database?: SqlExecutor;
  /**
   * Default: a fake IAM that authenticates `DEV_ROOT_TOKEN` as a root administrator (with MFA) and allows
   * every decision. `better-compute dev` passes embedded better-iam instead.
   */
  iam?: DevStackIam;
  /** Injected modules, as for `betterCompute()` (after the IAM bridge's). */
  modules?: readonly ComputeModule[];
  /** Default `http://127.0.0.1:3000`; only used for the cookie origin and endpoint discovery. */
  baseURL?: string;
  secret?: string;
  /** Region of the gateway and of the sites `createPool` makes (default `dev-1`). */
  region?: string;
  /** SPIFFE trust domain of node certificates (default `compute.dev.local`). */
  trustDomain?: string;
  /** Where the gateway listens (default 127.0.0.1, an ephemeral port). */
  gateway?: { host?: string; port?: number } & Partial<
    Omit<GatewayOptions, 'database' | 'services' | 'region' | 'work' | 'events' | 'reports'>
  >;
  /** Worker tuning (default: `pollMs` 100, so a local loop reacts at once). */
  worker?: WorkerOptions;
  log?: Logger;
  /** Options for every FakeDaemon (default reconnect backoff 100 ms → 5 s). */
  daemon?: Partial<Omit<FakeDaemonOptions, 'nodeId' | 'scheduler' | 'dial' | 'hardware'>>;
}

export interface DevPool {
  siteId: string;
  poolId: string;
}

export interface DevJoinOptions {
  poolId: string;
  /** Machines to join (default 1). */
  count?: number;
  /** Their hardware (default `hgx-h100`). */
  variant?: FakeHardwareVariant;
  /** Seeds serials, UUIDs and MACs; machine `i` gets `<seed>-<i>` (default: random per call). */
  seed?: string;
}

export interface DevStack {
  compute: BetterCompute<any, any>;
  database: SqlExecutor;
  gateway: Gateway;
  served: ServedGateway;
  /** `http://host:port` of the gateway (cleartext HTTP/2). */
  gatewayUrl: string;
  rootTenantId: string;
  /** A root administrator's credential. */
  root: Credential;
  /** What a daemon pins: JoinService's encryption key (public JWK) and signing key, the node CA. */
  pins: {
    joinEncryptionJwk: JsonWebKey;
    joinSigningKey: JsonWebKey;
    nodeCaCertificate: Uint8Array;
  };
  /** Running FakeDaemons by node id. */
  readonly daemons: ReadonlyMap<string, FakeDaemon>;
  /** A shared site in the stack's region and a `metal-host` pool on it, accepting nodes after `diag.nvml`. */
  createPool(options?: { gpuModel?: string; key?: string }): Promise<DevPool>;
  /**
   * Mints one join token for `count` machines, joins each through the gateway's `Join` RPC with a sealed
   * token and a fresh key, verifies the signed response, then starts its FakeDaemon. Resolves to the node ids.
   */
  join(options: DevJoinOptions): Promise<string[]>;
  /**
   * Resolves once every node is in `provisionState` (default `adopted`) and has applied a spec of generation
   * ≥ 1: the point where the placer considers it (a node adopted at generation 0 is not yet schedulable).
   */
  waitFor(
    nodeIds: readonly string[],
    options?: { provisionState?: string; timeoutMs?: number },
  ): Promise<void>;
  close(): Promise<void>;
}

/** The bearer token the default fake IAM accepts as a root administrator. */
export const DEV_ROOT_TOKEN = 'bc_dev_root';
const DEV_ROOT_TENANT = 'tenant-root';
const DEV_SECRET = 'better-compute-dev-stack-secret-not-for-production';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultIam(): DevStackIam {
  const port = fakeIam({
    callers: {
      [DEV_ROOT_TOKEN]: {
        identityId: 'identity-dev-root',
        identityKind: 'user',
        tenantId: DEV_ROOT_TENANT,
        sessionId: 'session-dev-root',
        sessionKind: 'user',
        mfa: true,
      },
    },
    allow: [{}],
  });
  return { port, rootTenantId: DEV_ROOT_TENANT, root: { token: DEV_ROOT_TOKEN } };
}

/**
 * Starts the development stack. Everything runs on the wall clock in this process; `close()` stops the
 * daemons, the gateway, the workers and the store, in that order.
 *
 * ```ts
 * const dev = await createDevStack();
 * const { poolId } = await dev.createPool();
 * const nodes = await dev.join({ poolId, count: 3 });
 * await dev.waitFor(nodes); // adopted, generation applied
 * ```
 */
export async function createDevStack(options: DevStackOptions = {}): Promise<DevStack> {
  const region = options.region ?? 'dev-1';
  const trustDomain = options.trustDomain ?? 'compute.dev.local';
  const iam = options.iam ?? defaultIam();
  const database = options.database ?? pglite();

  // Local CAs and JoinService's keys (the dev equivalent of `better-compute pki init`).
  const nodeCa = createNodeCa({ trustDomain });
  const signingKey = createSigningKey();
  const encryption = generateP256KeyPair();

  // The runtime pokes `gw:<id>` after enqueues and spec bumps; in one process that is a direct call.
  let gatewayRef: Gateway | undefined;
  const notifier: Notifier = {
    async publish(channel, message) {
      if (!gatewayRef || channel !== `gw:${gatewayRef.id}`) return;
      try {
        const { nodeIds } = JSON.parse(message ?? '{}') as { nodeIds?: string[] };
        gatewayRef.poke(Array.isArray(nodeIds) ? nodeIds : undefined);
      } catch {
        gatewayRef.poke();
      }
    },
    async subscribe() {
      return async () => {};
    },
  };

  const compute = betterCompute<readonly ComputeModule[], []>({
    database,
    iam: iam.port,
    rootTenantId: iam.rootTenantId,
    secret: options.secret ?? DEV_SECRET,
    baseURL: options.baseURL ?? 'http://127.0.0.1:3000',
    modules: [...(iam.modules ?? []), ...(options.modules ?? [])],
    pki: {
      nodeCa,
      join: pkiJoinCrypto({
        trustDomain,
        nodeCa,
        signingKey,
        encryptionKey: encryption.privateKey,
      }),
    },
    notifier,
    worker: { pollMs: 100, ...options.worker },
    ...(options.log ? { log: options.log } : {}),
  });

  const daemons = new Map<string, FakeDaemon>();
  /** Nodes that joined through this stack, and their site: the only identities the h2c hook accepts. */
  const joined = new Map<string, string>();
  const scheduler = createRealtimeScheduler({ onError: () => {} });
  let gateway: Gateway | undefined;
  let served: ServedGateway | undefined;
  let client: ReturnType<typeof createH2cClient> | undefined;
  let started = false;

  const close = async () => {
    for (const daemon of daemons.values())
      if (daemon.state !== 'stopped') daemon.crash('dev-stack-close');
    daemons.clear();
    await client?.close().catch(() => {});
    await served?.close(100).catch(() => {});
    await gateway?.stop().catch(() => {});
    if (started) await compute.stop().catch(() => {});
    await database.close();
  };

  try {
    await compute.initialize();
    await compute.start();
    started = true;
    const { host = '127.0.0.1', port = 0, ...gatewayOptions } = options.gateway ?? {};
    gateway = createGateway({
      region,
      database,
      services: compute.gatewayServices,
      work: compute.context.work,
      events: compute.context.events,
      reports: gatewayReportHandlers,
      dispatchIntervalMs: 250,
      specSweepMs: 1_000,
      ...gatewayOptions,
    });
    await gateway.start();
    gatewayRef = gateway;
    served = await serveGateway(gateway, {
      host,
      port,
      insecure: true,
      authenticate: (peer) => {
        const nodeId = peer.headers[TEST_NODE_HEADER];
        if (typeof nodeId !== 'string') return undefined;
        const siteId = joined.get(nodeId);
        return siteId ? { nodeId, siteId } : undefined;
      },
    });
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  const listenHost = options.gateway?.host ?? '127.0.0.1';
  const dialHost = ['0.0.0.0', '::'].includes(listenHost) ? '127.0.0.1' : listenHost;
  const gatewayUrl = `http://${dialHost.includes(':') ? `[${dialHost}]` : dialHost}:${served.port}`;
  client = createH2cClient({ url: gatewayUrl });
  const h2c = client;
  const readyGateway = gateway;
  const readyServed = served;
  const api = compute.api as any;
  const tenantId = iam.rootTenantId;

  const joinOne = async (token: string, hardware: ReturnType<typeof fakeHardware>) => {
    const key = generateP256KeyPair().privateKey;
    const csr = createCsr(key);
    const request = () =>
      create(JoinRequestSchema, {
        sealedToken: new TextEncoder().encode(
          sealJoinToken(token, encryption.publicKey, { csr, issuedAt: Date.now() }),
        ),
        csr,
        claims: create(HardwareClaimsSchema, hardware.claims),
        daemonVersion: '0.1.0-dev',
        role: AgentRole.NODE,
      });
    // A join storm may meet the handshake bucket: retry with jitter, like bcd.
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await h2c.join(request());
        const body = verifyJoinResponse(response, {
          signer: { publicKey: signingKey.publicKey },
          csr,
          nodeCaRoots: [nodeCa.certificate],
          now: Date.now(),
        });
        const spiffe = parseCertificate(body.certChain[0]!).uriSans[0] ?? '';
        const siteId = /\/site\/([^/]+)\/node\//.exec(spiffe)?.[1];
        if (!siteId)
          throw new ComputeError(
            'INTERNAL_ERROR',
            `Join issued a certificate without a site: ${spiffe}`,
          );
        return { nodeId: body.nodeId, siteId };
      } catch (error) {
        if (attempt < 20 && isRetryable(error as GrpcStatus)) {
          await sleep(50 + Math.random() * 200 * (attempt + 1));
          continue;
        }
        const status = error as Partial<GrpcStatus>;
        if (typeof status.code === 'number' && !(error instanceof Error))
          throw new ComputeError(
            'INTERNAL_ERROR',
            `Join failed (grpc ${status.code}): ${status.message}`,
          );
        throw error;
      }
    }
  };

  return {
    compute,
    database,
    gateway: readyGateway,
    served: readyServed,
    gatewayUrl,
    rootTenantId: tenantId,
    root: iam.root,
    pins: {
      joinEncryptionJwk: publicJwk(encryption.publicKey),
      joinSigningKey: publicJwk(signingKey.publicKey),
      nodeCaCertificate: nodeCa.certificate,
    },
    daemons,
    async createPool(poolOptions = {}) {
      const key = poolOptions.key ?? 'dev';
      const site = await api.sites.create(iam.root, {
        tenantId,
        kind: 'shared',
        region,
        idempotencyKey: `dev-site-${key}`,
      });
      const pool = await api.pools.create(iam.root, {
        tenantId,
        siteId: site.id,
        class: 'metal-host',
        ...(poolOptions.gpuModel === undefined
          ? { gpuModel: 'H100' }
          : poolOptions.gpuModel
            ? { gpuModel: poolOptions.gpuModel }
            : {}),
        policy: { acceptance: [{ kind: 'diag.nvml' }] },
        idempotencyKey: `dev-pool-${key}`,
      });
      return { siteId: site.id, poolId: pool.id };
    },
    async join(joinOptions) {
      const count = joinOptions.count ?? 1;
      if (!Number.isSafeInteger(count) || count < 1 || count > 10_000)
        throw new ComputeError('INVALID_INPUT', 'count must be a whole number from 1 to 10000');
      const variant = joinOptions.variant ?? 'hgx-h100';
      const seed = joinOptions.seed ?? Math.random().toString(36).slice(2, 10);
      const minted = await api.joinTokens.create(iam.root, {
        tenantId,
        poolId: joinOptions.poolId,
        ttlSeconds: 3600,
        maxUses: count,
        idempotencyKey: `dev-join-${seed}-${count}`,
      });
      const ids: string[] = [];
      for (let index = 0; index < count; index++) {
        const hardware = fakeHardware({ seed: `${seed}-${index}`, variant });
        const { nodeId, siteId } = await joinOne(minted.token, hardware);
        joined.set(nodeId, siteId);
        const daemon = new FakeDaemon({
          backoff: { minMs: 100, maxMs: 5_000 },
          ...options.daemon,
          nodeId,
          hardware,
          scheduler,
          dial: () => h2c.session(nodeId),
        });
        daemons.set(nodeId, daemon);
        daemon.start();
        ids.push(nodeId);
      }
      return ids;
    },
    async waitFor(nodeIds, waitOptions = {}) {
      const want = waitOptions.provisionState ?? 'adopted';
      const deadline = Date.now() + (waitOptions.timeoutMs ?? 30_000);
      for (;;) {
        const { rows } = await database.query<{ id: string; provision_state: string }>(
          `SELECT id, provision_state FROM nodes
            WHERE id = ANY($1) AND provision_state = $2
              AND observed_generation >= generation AND observed_generation >= 1`,
          [[...nodeIds], want],
        );
        if (rows.length === new Set(nodeIds).size) return;
        if (Date.now() > deadline) {
          const done = new Set(rows.map((row) => row.id));
          throw new ComputeError(
            'INVALID_STATE',
            `Timed out waiting for ${want}: ${nodeIds.filter((id) => !done.has(id)).join(', ')}`,
          );
        }
        await sleep(50);
      }
    },
    close,
  };
}
