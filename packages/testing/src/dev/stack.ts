// The local development stack behind `better-compute dev --sim N` (PLAN.md §14 Topologies, "Dev"): a control
// plane with JoinService on local CAs, a real gateway on cleartext HTTP/2, and simulated machines (FakeDaemons)
// that join the way `bcd join` does: a sealed join token bound to their CSR, the `Join` RPC through the gateway,
// a signed JoinResponse checked against the pinned keys, then a `Session` stream. Acceptance, adoption,
// NodeSpec, reservations and liveness all run on the real runtime and gateway loops.
//
// Three pieces compose: `createDevJoinKeys()` and `devFleetNotifier()` go into the host's `betterCompute()`
// options; `attachDevFleet()` then adds the gateway and the daemons to that host's running control plane
// (`better-compute dev` does this with its own deployment). `createDevStack()` does all of it on PGlite for
// tests. Local development only: sessions authenticate by a header over h2c (no TLS), so attaching a fleet
// demands `insecureHeaderAuth: true`.

import type { KeyObject } from 'node:crypto';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
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
  gatewayTunnelRelay,
  serveGateway,
  serveInternal,
  xidStatusHandler,
  type Gateway,
  type GatewayOptions,
  type ServedGateway,
} from '@better-compute/gateway';
import {
  createExecTicketIssuer,
  createNodeCa,
  createRevocationFeed,
  createServingCa,
  createSigningKey,
  generateP256KeyPair,
  normalizeSerial,
  parseCertificate,
  privateKeyPem,
  publicJwk,
  toPem,
  type ExecTicketIssuer,
  type ReplayCache,
  type SignerTrust,
} from '@better-compute/pki';
import { retentionModule } from '@better-compute/postgres';
import { pglite } from '@better-compute/postgres/pglite';
import { type SignedTrustBundle, AgentRole, type JoinRequest, type TunnelFrame } from '@better-compute/protocol';
import {
  betterCompute,
  builtinJobNames,
  commandOwner,
  gatewayReportHandlers,
  pkiJoinCrypto,
  type BetterCompute,
  type ComputeOptions,
  type JoinCrypto,
  type WorkerOptions,
} from '@better-compute/server';
import { FakeDaemon, type FakeDaemonOptions } from '../daemon/fake-daemon.js';
import type { FakeKind } from '../daemon/kinds.js';
import { runAgentJoin } from '../daemon/join.js';
import type { FakeTunnelOptions, TunnelConn } from '../daemon/tunnels.js';
import type { CloseInfo, FrameHandler } from '../frame-conn.js';
import { fakeHardware, type FakeHardwareVariant } from '../fake-hw.js';
import { fakeIam } from '../fake-iam.js';
import {
  createH2cClient,
  isRetryable,
  TEST_NODE_HEADER,
  type GrpcStatus,
  type H2cClient,
} from '../realtime/h2c.js';
import { createRealtimeScheduler } from '../scheduler.js';

/** Local CAs and JoinService's keys: the dev equivalent of `better-compute pki init`. */
export interface DevJoinKeys {
  trustDomain: string;
  /** For `betterCompute({ pki: keys.pki })`. */
  pki: { nodeCa: ReturnType<typeof createNodeCa>; join: JoinCrypto };
  /** What a daemon pins: JoinService's encryption key (public JWK) and signing key, the node CA. */
  pins: {
    joinEncryptionJwk: JsonWebKey;
    joinSigningKey: JsonWebKey;
    nodeCaCertificate: Uint8Array;
  };
  /** What the agent half (`runAgentJoin`) needs: the pinned signer, the encryption key, the node CA. */
  agent: { signer: SignerTrust; joinEncryptionKey: KeyObject; nodeCaRoots: readonly Uint8Array[] };
}

export function createDevJoinKeys(options: { trustDomain?: string } = {}): DevJoinKeys {
  const trustDomain = options.trustDomain ?? 'compute.dev.local';
  const nodeCa = createNodeCa({ trustDomain });
  const signingKey = createSigningKey();
  const encryption = generateP256KeyPair();
  return {
    trustDomain,
    pki: {
      nodeCa,
      join: pkiJoinCrypto({
        trustDomain,
        nodeCa,
        signingKey,
        encryptionKey: encryption.privateKey,
      }),
    },
    pins: {
      joinEncryptionJwk: publicJwk(encryption.publicKey),
      joinSigningKey: publicJwk(signingKey.publicKey),
      nodeCaCertificate: nodeCa.certificate,
    },
    agent: {
      signer: { publicKey: signingKey.publicKey },
      joinEncryptionKey: encryption.publicKey,
      nodeCaRoots: [nodeCa.certificate],
    },
  };
}

/**
 * The runtime publishes `gw:<id>` after enqueues and spec bumps; in one process that is a direct `poke` of the
 * attached gateway. Pass it as `betterCompute({ notifier })`; `attachDevFleet` attaches its gateway.
 */
export interface DevFleetNotifier extends Notifier {
  attach(gateway: Gateway | undefined): void;
}

export function devFleetNotifier(): DevFleetNotifier {
  let gateway: Gateway | undefined;
  return {
    attach(next) {
      gateway = next;
    },
    async publish(channel, message) {
      if (!gateway || channel !== `gw:${gateway.id}`) return;
      try {
        const { nodeIds } = JSON.parse(message ?? '{}') as { nodeIds?: unknown };
        gateway.poke(
          Array.isArray(nodeIds) && nodeIds.every((id) => typeof id === 'string')
            ? nodeIds
            : undefined,
        );
      } catch {
        gateway.poke();
      }
    },
    async subscribe() {
      return async () => {};
    },
  };
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

export interface DevSiteJoinOptions {
  siteId: string;
  /** Site agents to join (default 1; a site token admits at most 16). */
  count?: number;
  /** Kinds these agents run besides the defaults (BMC and boot work). */
  kinds?: Record<string, FakeKind | null>;
  /** Seeds their machines' identifiers (default: random per call). */
  seed?: string;
}

export interface DevFleetOptions {
  /** A control plane built with `keys.pki` and `notifier`, initialized and started by the host. */
  compute: BetterCompute<any, any>;
  database: SqlExecutor;
  keys: DevJoinKeys;
  notifier?: DevFleetNotifier;
  /** A root administrator's credential in `rootTenantId` (creates sites, pools and join tokens). */
  root: Credential;
  rootTenantId: string;
  /**
   * Sessions authenticate by the `x-bc-test-node` header over cleartext HTTP/2 (only node ids that joined
   * through this fleet). Never for a reachable deployment; required so it cannot be switched on by accident.
   */
  insecureHeaderAuth: true;
  /** Region of the gateway and of the sites `createPool` makes (default `dev-1`). */
  region?: string;
  /** Where the gateway listens (default 127.0.0.1, an ephemeral port) and its tuning. */
  gateway?: { host?: string; port?: number } & Partial<
    Omit<GatewayOptions, 'database' | 'services' | 'region' | 'work' | 'events' | 'reports'>
  >;
  /**
   * More gateway report hooks, over the server's `gatewayReportHandlers`. `status` handlers run after the
   * XID health handler (as `serve` composes them), e.g. vps's `instanceStatusHandler({ events })`.
   */
  reports?: Partial<NonNullable<GatewayOptions['reports']>>;
  /** Options for every FakeDaemon (default reconnect backoff 100 ms → 5 s). */
  daemon?: Partial<Omit<FakeDaemonOptions, 'nodeId' | 'scheduler' | 'dial' | 'hardware' | 'tunnels'>> & {
    /** What runs in each tunnel (default `echoShell`); the fleet dials the Tunnel streams. */
    tunnels?: Omit<FakeTunnelOptions, 'dial'>;
  };
  /**
   * Interactive tunnels (§7.6): the control plane's exec-ticket issuer (`ComputeOptions.tunnels.issuer`).
   * The gateway verifies its tickets and serves its control API on loopback h2c (for the api's relay);
   * every FakeDaemon answers OpenTunnel with its echo shell (or `daemon.tunnels.program`). `jtiCache` is the gateway's single-use record of
   * tickets (default: its own in-memory cache); a fresh one per test plays a failover gateway that never saw
   * a ticket, which only the daemon's own check can then refuse.
   */
  tunnels?: { issuer: ExecTicketIssuer; issuerName?: string; jtiCache?: ReplayCache };
  /**
   * Also admit nodes that joined through the gateway's `Join` RPC on their own (a real `bcd` in an
   * integration test), not only this fleet's FakeDaemons: every 250 ms the fleet reads each node's
   * current certificate (this identity generation, not revoked, not expired) from `node_certs` and
   * accepts its `x-bc-test-node` header with that certificate's site, serial and role. Default off.
   */
  admitExternalJoins?: boolean;
  /**
   * A second listener for daemons outside this process (a real `bcd`), authenticated as in production:
   * HTTP/2 over mTLS with a serving certificate from a dev serving CA (`servingCaCertificate`, what the
   * daemon pins) and client certificates checked against the dev node CA (chain, revocation, trust
   * domain, role, serial). Binding a non-loopback host is safe here, unlike the h2c header listener.
   * The certificate names `dnsNames` (default `localhost`, `gw.dev.local`); a daemon dialing an IP
   * sets its TLS server name to one of them.
   */
  externalTls?: {
    host?: string;
    port?: number;
    dnsNames?: readonly string[];
    /** The serving CA its certificate comes from (default: a new dev one); the stack passes the one it publishes. */
    servingCa?: ReturnType<typeof createServingCa>;
  };
}

export interface DevFleet {
  /** `https://host:port` of the mTLS listener, with `externalTls`. */
  readonly externalGatewayUrl: string | undefined;
  /** The dev serving CA (DER) the mTLS listener's certificate chains to, with `externalTls`. */
  readonly servingCaCertificate: Uint8Array | undefined;
  /**
   * Admits a node that joined on its own right now, from its current `node_certs` row (what the
   * `admitExternalJoins` poller does every 250 ms). Resolves false when it holds no current certificate.
   */
  admit(nodeId: string): Promise<boolean>;
  /** The api's relay to this fleet's gateway (`handleTunnel`'s `relay`), when tunnels are on. */
  readonly tunnelRelay: ReturnType<typeof gatewayTunnelRelay> | undefined;
  gateway: Gateway;
  served: ServedGateway;
  /** `http://host:port` of the gateway (cleartext HTTP/2). */
  gatewayUrl: string;
  pins: DevJoinKeys['pins'];
  /** Running FakeDaemons by node id. */
  readonly daemons: ReadonlyMap<string, FakeDaemon>;
  /**
   * A shared site in the fleet's region and a `metal-host` pool on it, accepting nodes after `diag.nvml`.
   * With `expectGpuCount`, acceptance checks that many GPUs (`policy.expect.gpuCount`); without it, a
   * machine passes with whatever GPUs it reports.
   */
  createPool(options?: {
    gpuModel?: string | null;
    key?: string;
    expectGpuCount?: number;
  }): Promise<DevPool>;
  /**
   * Mints one join token for `count` machines, joins each through the gateway's `Join` RPC with a sealed
   * token and a fresh key, verifies the signed response, then starts its FakeDaemon. Resolves to the node ids.
   */
  join(options: DevJoinOptions): Promise<string[]>;
  /**
   * Enrolls site agents (`bcd site`, PLAN.md §3.3 step 0): mints a role-`site` token with
   * `siteTokens.create`, joins each agent through the Join RPC, then starts its FakeDaemon (role site)
   * with `kinds` added (a site's BMC and boot work, e.g. metal's). Resolves to the node ids.
   */
  joinSite(options: DevSiteJoinOptions): Promise<string[]>;
  /**
   * Resolves once every node is in `provisionState` (default `adopted`) and has applied a spec of generation
   * ≥ 1: the point where the placer considers it (a node adopted at generation 0 is not yet schedulable).
   */
  waitFor(
    nodeIds: readonly string[],
    options?: { provisionState?: string; timeoutMs?: number },
  ): Promise<void>;
  /** Stops the daemons and the gateway; the host stops its control plane. */
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A free loopback port (the gateway must know its control API's URL before it starts). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * The daemon end of a Tunnel stream, in process: the frames `gateway.acceptTunnel` would get from the
 * gRPC `Tunnel` rpc (http2.ts `tunnel()`), without the h2 hop.
 */
function gatewayTunnelConn(
  gateway: Gateway,
  peer: { nodeId: string; siteId: string; serial: string },
  id: string,
): TunnelConn {
  const inbox: TunnelFrame[] = [];
  const closeHandlers: ((info: CloseInfo) => void | Promise<void>)[] = [];
  let handler: FrameHandler<TunnelFrame> | undefined;
  let closeInfo: CloseInfo | undefined;
  const deliver = () => {
    while (handler && inbox.length) void handler(inbox.shift()!);
  };
  const finish = (info: CloseInfo) => {
    if (closeInfo) return;
    closeInfo = info;
    for (const onClose of closeHandlers) void Promise.resolve(onClose(info)).catch(() => {});
  };
  const handle = gateway.acceptTunnel(peer, {
    send(frame) {
      if (closeInfo) return false;
      inbox.push(frame);
      queueMicrotask(deliver);
      return true;
    },
    onDrain: (callback) => queueMicrotask(callback),
    pause() {},
    resume() {},
    close: (error) =>
      finish({
        reason: error ? `grpc-${error.code}: ${error.message}` : 'closed',
        by: 'remote',
        ...(error?.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      }),
  });
  return {
    id,
    get closed() {
      return closeInfo !== undefined;
    },
    get closeInfo() {
      return closeInfo;
    },
    send(frame) {
      if (closeInfo) return false;
      handle.receive(frame);
      return true;
    },
    onFrame(next) {
      handler = next;
      deliver();
    },
    onClose(next) {
      closeHandlers.push(next);
      if (closeInfo) void Promise.resolve(next(closeInfo)).catch(() => {});
    },
    close(reason = 'closed') {
      if (closeInfo) return;
      handle.end(reason);
      finish({ reason, by: 'local' });
    },
    abort(reason = 'aborted') {
      if (closeInfo) return;
      handle.end(reason);
      finish({ reason, by: 'local' });
    },
    ping: (_timeoutMs, onResult) => onResult(!closeInfo),
  };
}

/** The server's report hooks plus `extra`; status handlers compose after XID health, as in `serve`. */
function reportHandlers(
  extra: DevFleetOptions['reports'] = {},
): NonNullable<GatewayOptions['reports']> {
  const { status, ...rest } = extra;
  return {
    ...gatewayReportHandlers,
    ...rest,
    status: [xidStatusHandler, ...(status === undefined ? [] : Array.isArray(status) ? status : [status])],
  } as NonNullable<GatewayOptions['reports']>;
}

/** Adds a gateway on h2c and simulated machines to a running control plane. */
export async function attachDevFleet(options: DevFleetOptions): Promise<DevFleet> {
  if (options.insecureHeaderAuth !== true)
    throw new ComputeError(
      'INVALID_CONFIG',
      'attachDevFleet() authenticates sessions by a header over cleartext HTTP/2; pass insecureHeaderAuth: true (local development only)',
    );
  const { compute, database, keys, root, rootTenantId: tenantId } = options;
  const region = options.region ?? 'dev-1';
  const api = compute.api as any;
  const daemons = new Map<string, FakeDaemon>();
  /**
   * Nodes that joined through this fleet, with their site and certificate serial: the only identities the
   * h2c hook accepts. The serial is what revocations match (as the mTLS listener's certificate would give).
   */
  const joined = new Map<string, { siteId: string; serial: string }>();
  /** Nodes that joined on their own, admitted from `node_certs` (`admit`, `admitExternalJoins`). */
  const external = new Map<
    string,
    { siteId: string; serial: string; role: 'node' | 'site' | 'ramdisk'; notAfter: number; tenantControlled?: true }
  >();
  /** Reads current certificates (one per node: the latest) of `nodeIds`, or of every node not in `joined`. */
  const readExternal = async (nodeIds?: readonly string[]) => {
    const { rows } = await database.query<{
      node_id: string;
      serial: string;
      role: string;
      not_after: Date | string;
      site_id: string;
    }>(
      `SELECT DISTINCT ON (c.node_id) c.node_id, c.serial, c.role, c.not_after, n.site_id
         FROM node_certs c JOIN nodes n ON n.id = c.node_id
        WHERE c.revoked_at IS NULL AND c.not_after > compute_now() AND c.identity_gen = n.identity_gen
          AND ($1::text[] IS NULL OR c.node_id = ANY($1::text[]))
        ORDER BY c.node_id, c.not_after DESC`,
      [nodeIds ? [...nodeIds] : null],
    );
    const seen = new Set<string>();
    for (const row of rows) {
      if (joined.has(row.node_id)) continue;
      seen.add(row.node_id);
      const tenant = row.role === 'node-tenant';
      external.set(row.node_id, {
        siteId: row.site_id,
        serial: normalizeSerial(row.serial),
        role: tenant ? 'node' : (row.role as 'node' | 'site' | 'ramdisk'),
        notAfter: new Date(row.not_after).getTime(),
        ...(tenant ? { tenantControlled: true as const } : {}),
      });
    }
    // A node whose certificates were all revoked or superseded drops out.
    for (const nodeId of nodeIds ?? [...external.keys()]) if (!seen.has(nodeId)) external.delete(nodeId);
    return seen;
  };
  let externalTimer: ReturnType<typeof setInterval> | undefined;
  let externalServed: ServedGateway | undefined;
  let servingCaCertificate: Uint8Array | undefined;
  const scheduler = createRealtimeScheduler({ onError: () => {} });
  // Revocations reach the gateway as in production: the feed polls node_certs.revoked_at into the set
  // the gateway enforces (the node CA's).
  const revocations = keys.pki.nodeCa.revocations;
  const feed = createRevocationFeed({ sql: database, revocations, intervalMs: 250 });
  let gateway: Gateway | undefined;
  let served: ServedGateway | undefined;
  let internal: Awaited<ReturnType<typeof serveInternal>> | undefined;
  let tunnelRelay: ReturnType<typeof gatewayTunnelRelay> | undefined;
  let client: H2cClient | undefined;

  const close = async () => {
    if (externalTimer) clearInterval(externalTimer);
    feed.stop();
    tunnelRelay?.close();
    await internal?.close().catch(() => {});
    for (const daemon of daemons.values())
      if (daemon.state !== 'stopped') daemon.crash('dev-fleet-close');
    daemons.clear();
    await client?.close().catch(() => {});
    await externalServed?.close(100).catch(() => {});
    await served?.close(100).catch(() => {});
    await gateway?.stop().catch(() => {});
    options.notifier?.attach(undefined);
  };

  const { host = '127.0.0.1', port = 0, ...gatewayOptions } = options.gateway ?? {};
  // Header authentication admits whoever names a node: never beyond this machine for outside joins.
  if (options.admitExternalJoins && !['127.0.0.1', '::1', 'localhost'].includes(host))
    throw new ComputeError(
      'INVALID_CONFIG',
      'admitExternalJoins needs the h2c gateway on loopback (anyone reaching it could claim any node id); use externalTls for other hosts',
    );
  // The gateway advertises its control API in its directory row at start, so its port is chosen first.
  const internalPort = options.tunnels ? await freePort() : undefined;
  const tunnelIssuer = options.tunnels?.issuer;
  const { tunnels: tunnelProgram, ...daemonOptions } = options.daemon ?? {};
  // Welcome.trust, as `serve` relays it: the signed bundle of this control plane (when it signs intent).
  const services = compute.gatewayServices as { trustBundle?: () => Promise<SignedTrustBundle | undefined> };
  const signedTrust = await services.trustBundle?.().catch(() => undefined);
  try {
    gateway = createGateway({
      ...(signedTrust ? { trustBundle: () => signedTrust } : {}),
      ...(tunnelIssuer
        ? {
            internalUrl: `http://127.0.0.1:${internalPort}`,
            tunnels: {
              jwks: () => tunnelIssuer.jwksJson(),
              ...(options.tunnels?.issuerName ? { issuer: options.tunnels.issuerName } : {}),
              ...(options.tunnels?.jtiCache ? { jtiCache: options.tunnels.jtiCache } : {}),
            },
          }
        : {}),
      region,
      database,
      services: compute.gatewayServices,
      work: compute.context.work,
      events: compute.context.events,
      // A settled command wakes the reconciler waiting on it (`<reconciler>:<key>:…`), as `serve` hosts do.
      commandOwner: (key: string) =>
        commandOwner(
          key,
          (kind) => Object.hasOwn(compute.jobs, kind) && !(builtinJobNames as readonly string[]).includes(kind),
        ),
      reports: reportHandlers(options.reports),
      dispatchIntervalMs: 250,
      specSweepMs: 1_000,
      revocations,
      ...gatewayOptions,
    });
    await gateway.start();
    feed.start();
    options.notifier?.attach(gateway);
    served = await serveGateway(gateway, {
      host,
      port,
      insecure: true,
      authenticate: (peer) => {
        const nodeId = peer.headers[TEST_NODE_HEADER];
        if (typeof nodeId !== 'string') return undefined;
        const identity = joined.get(nodeId);
        if (identity) {
          if (revocations.has(identity.serial)) return undefined;
          return { nodeId, siteId: identity.siteId, serial: identity.serial };
        }
        // A node that joined on its own: as its certificate would identify it over mTLS.
        const outside = external.get(nodeId);
        if (!outside || revocations.has(outside.serial) || outside.notAfter <= Date.now()) return undefined;
        return { nodeId, ...outside };
      },
    });
    if (options.externalTls) {
      const servingCa = options.externalTls.servingCa ?? createServingCa();
      const servingKey = generateP256KeyPair();
      const issued = await servingCa.issue(servingKey.publicKey, {
        usage: 'server',
        dnsSans: [...(options.externalTls.dnsNames ?? ['localhost', 'gw.dev.local'])],
        ttlSeconds: 30 * 86_400,
      });
      servingCaCertificate = servingCa.certificate;
      externalServed = await serveGateway(gateway, {
        host: options.externalTls.host ?? '127.0.0.1',
        port: options.externalTls.port ?? 0,
        tls: {
          key: privateKeyPem(servingKey.privateKey),
          cert: [issued.certificate, ...issued.chain].map((der) => toPem(der)).join(''),
          ca: toPem(keys.pki.nodeCa.certificate),
          minVersion: 'TLSv1.3',
        },
        // The production authenticator: chain to the node CA, revocations, trust domain, role, serial.
        nodeRoots: [keys.pki.nodeCa.certificate],
        revocations,
        trustDomain: keys.trustDomain,
      });
    }
    if (options.admitExternalJoins) {
      await readExternal();
      externalTimer = setInterval(() => void readExternal().catch(() => {}), 250);
      externalTimer.unref?.();
    }
    if (tunnelIssuer) {
      internal = await serveInternal(gateway, {
        insecure: true,
        host: '127.0.0.1',
        port: internalPort!,
      });
      tunnelRelay = gatewayTunnelRelay({ sql: compute.context.sql });
    }
  } catch (error) {
    await close();
    throw error;
  }
  const dialHost = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host;
  const gatewayUrl = `http://${dialHost.includes(':') ? `[${dialHost}]` : dialHost}:${served.port}`;
  client = createH2cClient({ url: gatewayUrl });
  const h2c = client;

  /** The unary Join; a join storm may meet the handshake bucket, so it retries with jitter, like bcd. */
  const send = async (request: JoinRequest) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await h2c.join(request);
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

  // The agent's Join loop (deferrals included), with a sealed-token join.
  const joinOne = async (
    token: string,
    hardware: ReturnType<typeof fakeHardware>,
    role: AgentRole = AgentRole.NODE,
  ) => {
    const { body, privateKey } = await runAgentJoin({
      send,
      role,
      signer: keys.agent.signer,
      nodeCaRoots: keys.agent.nodeCaRoots,
      wait: async (ms) => {
        await sleep(ms);
      },
      claims: hardware.claims,
      daemonVersion: '0.1.0-dev',
      token: { token, joinEncryptionKey: keys.agent.joinEncryptionKey },
    });
    const leaf = parseCertificate(body.certChain[0]!);
    const spiffe = leaf.uriSans[0] ?? '';
    const siteId = /\/site\/([^/]+)\/node\//.exec(spiffe)?.[1];
    if (!siteId)
      throw new ComputeError(
        'INTERNAL_ERROR',
        `Join issued a certificate without a site: ${spiffe}`,
      );
    return { nodeId: body.nodeId, siteId, serial: normalizeSerial(leaf.serial), privateKey };
  };

  /** A daemon's tunnel dial: its Tunnel stream, in process, into the gateway it holds a session on. */
  const tunnelsFor = (nodeId: string): Pick<FakeDaemonOptions, 'tunnels'> => {
    if (!tunnelIssuer) return {};
    const ready = gateway!;
    return {
      tunnels: {
        // `daemon.tunnels.program` (and its jti cache) stay; the dial is always the fleet's.
        ...tunnelProgram,
        dial: (tunnelId) => {
          const identity = joined.get(nodeId);
          if (!identity || revocations.has(identity.serial)) return undefined;
          return gatewayTunnelConn(ready, { nodeId, ...identity }, `tunnel-${tunnelId}`);
        },
      },
    };
  };

  return {
    gateway,
    served,
    gatewayUrl,
    tunnelRelay,
    pins: keys.pins,
    daemons,
    servingCaCertificate,
    externalGatewayUrl: externalServed
      ? `https://${(() => {
          const bind = options.externalTls?.host ?? '127.0.0.1';
          const name = ['0.0.0.0', '::'].includes(bind) ? '127.0.0.1' : bind;
          return name.includes(':') ? `[${name}]` : name;
        })()}:${externalServed.port}`
      : undefined,
    async admit(nodeId) {
      return (await readExternal([nodeId])).has(nodeId);
    },
    async createPool(poolOptions = {}) {
      const key = poolOptions.key ?? 'dev';
      const gpuModel = poolOptions.gpuModel === undefined ? 'H100' : poolOptions.gpuModel;
      const site = await api.sites.create(root, {
        tenantId,
        kind: 'shared',
        region,
        idempotencyKey: `dev-site-${key}`,
      });
      const pool = await api.pools.create(root, {
        tenantId,
        siteId: site.id,
        class: 'metal-host',
        ...(gpuModel ? { gpuModel } : {}),
        policy: {
          acceptance: [{ kind: 'diag.nvml' }],
          ...(poolOptions.expectGpuCount === undefined
            ? {}
            : { expect: { gpuCount: poolOptions.expectGpuCount } }),
        },
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
      const minted = await api.joinTokens.create(root, {
        tenantId,
        poolId: joinOptions.poolId,
        ttlSeconds: 3600,
        maxUses: count,
        idempotencyKey: `dev-join-${seed}-${count}`,
      });
      const ids: string[] = [];
      for (let index = 0; index < count; index++) {
        const hardware = fakeHardware({ seed: `${seed}-${index}`, variant });
        const { nodeId, siteId, serial, privateKey } = await joinOne(minted.token, hardware);
        joined.set(nodeId, { siteId, serial });
        const daemon = new FakeDaemon({
          backoff: { minMs: 100, maxMs: 5_000 },
          ...daemonOptions,
          nodeId,
          hardware,
          // The key its certificate certifies: attested results (wipes, diagnostics) are node-signed.
          nodeKey: privateKey,
          scheduler,
          dial: () => h2c.session(nodeId),
          ...tunnelsFor(nodeId),
        });
        daemons.set(nodeId, daemon);
        daemon.start();
        ids.push(nodeId);
      }
      return ids;
    },
    async joinSite(siteOptions) {
      const count = siteOptions.count ?? 1;
      if (!Number.isSafeInteger(count) || count < 1 || count > 16)
        throw new ComputeError('INVALID_INPUT', 'count must be a whole number from 1 to 16');
      const seed = siteOptions.seed ?? Math.random().toString(36).slice(2, 10);
      const minted = await api.siteTokens.create(root, {
        tenantId,
        siteId: siteOptions.siteId,
        ttlSeconds: 3600,
        maxUses: count,
        idempotencyKey: `dev-site-agents-${seed}-${count}`,
      });
      const ids: string[] = [];
      for (let index = 0; index < count; index++) {
        const hardware = fakeHardware({ seed: `site-${seed}-${index}` });
        const { nodeId, siteId, serial, privateKey } = await joinOne(
          minted.token,
          hardware,
          AgentRole.SITE,
        );
        joined.set(nodeId, { siteId, serial });
        const daemon = new FakeDaemon({
          backoff: { minMs: 100, maxMs: 5_000 },
          ...daemonOptions,
          nodeId,
          role: AgentRole.SITE,
          hardware,
          ...(siteOptions.kinds
            ? { kinds: { ...options.daemon?.kinds, ...siteOptions.kinds } }
            : {}),
          nodeKey: privateKey,
          scheduler,
          dial: () => h2c.session(nodeId),
          ...tunnelsFor(nodeId),
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
        const { rows } = await database.query<{ id: string }>(
          `SELECT id FROM nodes
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

/** The IAM a dev stack runs with: a port, its root tenant and a credential of a root administrator. */
export interface DevStackIam {
  port: IamPort;
  rootTenantId: string;
  root: Credential;
  /** Modules the IAM side needs registered in compute (the IAM bridge's `bridge.modules`). */
  modules?: readonly ComputeModule[];
}

export interface DevStackOptions
  extends Pick<DevFleetOptions, 'region' | 'gateway' | 'daemon' | 'reports' | 'admitExternalJoins' | 'externalTls'> {
  /** The store (default: PGlite in memory). The stack migrates it and closes it on `close()`. */
  database?: SqlExecutor;
  /** Default: a fake IAM that authenticates `DEV_ROOT_TOKEN` as a root administrator and allows everything. */
  iam?: DevStackIam;
  /** Injected modules, as for `betterCompute()` (after the IAM bridge's). */
  modules?: readonly ComputeModule[];
  /** Default `http://127.0.0.1:3000`; only used for the cookie origin and endpoint discovery. */
  baseURL?: string;
  secret?: string;
  /** SPIFFE trust domain of node certificates (default `compute.dev.local`). */
  trustDomain?: string;
  /** Worker tuning (default: `pollMs` 100, so a local loop reacts at once). */
  worker?: WorkerOptions;
  log?: Logger;
  /** The gateway's exec-ticket replay cache (`DevFleetOptions.tunnels.jtiCache`). */
  tunnels?: { jtiCache?: ReplayCache };
  /** Capacity options, as for `betterCompute()` (e.g. `attestedBindings`). */
  capacity?: ComputeOptions<readonly ComputeModule[], []>['capacity'];
  /** Workload identity (v0.5), as for `betterCompute()`: VPS hosts' IMDS get instance tokens. */
  workloadIdentity?: ComputeOptions<readonly ComputeModule[], []>['workloadIdentity'];
}

export interface DevStack extends DevFleet {
  compute: BetterCompute<any, any>;
  database: SqlExecutor;
  rootTenantId: string;
  /** A root administrator's credential. */
  root: Credential;
  /** The exec-ticket issuer tunnel tickets come from: a host mounting `handleTunnel` verifies them with it. */
  tunnelIssuer: ExecTicketIssuer;
  /** Stops the fleet, the workers and the store, in that order. */
  close(): Promise<void>;
}

/** The bearer token the default fake IAM accepts as a root administrator. */
export const DEV_ROOT_TOKEN = 'bc_dev_root';
const DEV_ROOT_TENANT = 'tenant-root';
const DEV_SECRET = 'better-compute-dev-stack-secret-not-for-production';

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
 * A control plane on PGlite with a dev fleet attached, on the wall clock in this process.
 *
 * ```ts
 * const dev = await createDevStack();
 * const { poolId } = await dev.createPool();
 * const nodes = await dev.join({ poolId, count: 3 });
 * await dev.waitFor(nodes); // adopted, generation ≥ 1 applied
 * ```
 */
export async function createDevStack(options: DevStackOptions = {}): Promise<DevStack> {
  const iam = options.iam ?? defaultIam();
  const database = options.database ?? pglite();
  const keys = createDevJoinKeys(options.trustDomain ? { trustDomain: options.trustDomain } : {});
  const notifier = devFleetNotifier();
  const baseURL = options.baseURL ?? 'http://127.0.0.1:3000';
  // Tunnels on: the api issues exec tickets, the gateway and the daemons verify them.
  const issuerName = new URL(baseURL).origin;
  const tunnels = {
    issuer: createExecTicketIssuer({ issuer: issuerName }),
    issuerName,
    ...(options.tunnels?.jtiCache ? { jtiCache: options.tunnels.jtiCache } : {}),
  };
  // The mTLS listener for outside daemons, known before the control plane starts: its port and serving CA are
  // published in /.well-known/better-compute, so a real `bcd join --server` configures itself against the stack.
  const external = options.externalTls
    ? {
        ...options.externalTls,
        servingCa: options.externalTls.servingCa ?? createServingCa(),
        port: options.externalTls.port || (await freePort()),
      }
    : undefined;
  const externalHost = external?.host && external.host !== '0.0.0.0' ? external.host : '127.0.0.1';
  const compute = betterCompute<readonly ComputeModule[], []>({
    database,
    iam: iam.port,
    rootTenantId: iam.rootTenantId,
    secret: options.secret ?? DEV_SECRET,
    baseURL,
    // The store's housekeeping (outbox and authz changes behind cursors, spent attestations, expired joins).
    modules: [...(iam.modules ?? []), ...(options.modules ?? []), retentionModule()],
    pki: { ...keys.pki, ...(external ? { servingCa: external.servingCa } : {}) },
    ...(external
      ? {
          gateway: {
            url: `https://${externalHost}:${external.port}`,
            serverName: (external.dnsNames ?? ['localhost'])[0]!,
          },
        }
      : {}),
    tunnels: { issuer: tunnels.issuer },
    notifier,
    worker: { pollMs: 100, ...options.worker },
    ...(options.log ? { log: options.log } : {}),
    ...(options.capacity ? { capacity: options.capacity } : {}),
    ...(options.workloadIdentity ? { workloadIdentity: options.workloadIdentity } : {}),
  });
  let started = false;
  let fleet: DevFleet | undefined;
  const close = async () => {
    await fleet?.close();
    if (started) await compute.stop().catch(() => {});
    await database.close();
  };
  try {
    await compute.initialize();
    await compute.start();
    started = true;
    fleet = await attachDevFleet({
      compute,
      database,
      keys,
      notifier,
      root: iam.root,
      rootTenantId: iam.rootTenantId,
      insecureHeaderAuth: true,
      tunnels,
      ...(options.region ? { region: options.region } : {}),
      ...(options.gateway ? { gateway: options.gateway } : {}),
      ...(options.daemon ? { daemon: options.daemon } : {}),
      ...(options.reports ? { reports: options.reports } : {}),
      ...(options.admitExternalJoins ? { admitExternalJoins: true } : {}),
      ...(external ? { externalTls: external } : {}),
    });
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  return {
    ...fleet,
    compute,
    database,
    rootTenantId: iam.rootTenantId,
    root: iam.root,
    tunnelIssuer: tunnels.issuer,
    close,
  };
}
