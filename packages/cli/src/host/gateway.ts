import { createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SecureServerOptions } from 'node:http2';
import { ComputeError } from '@better-compute/core';
import {
  gatewayCollector,
  meteredGatewayServices,
  standardMetrics,
  type MetricsRegistry,
  type SampledGateway,
} from '@better-compute/observability';
import { tunnelAuthorizer } from '@better-compute/iam';
import { builtinJobNames, commandOwner, gatewayReportHandlers } from '@better-compute/server';
import * as gatewayPackage from '@better-compute/gateway';
import {
  createRevocationFeed,
  createRevocationSet,
  type RevocationFeed,
  type RevocationSet,
} from '@better-compute/pki';
import type { AnyCompute, AnyComputeOptions } from '../config.js';
import type { HostGatewayConfig, HostTlsFiles } from './config.js';

// The gateway role of `serve` (PLAN.md §7, §8.1, §13): `createGateway` on the deployment's store and runtime
// ports, the report hooks every module needs (capacity's allocation transitions, inventory's XID health),
// tunnels when the deployment issues exec tickets, and the listeners: the daemon listener over mTLS, the WS
// fallback (v0.4) when configured, and the internal control API when configured.
//
// Sessions authenticate by their node certificate: `certificateAuthenticate` verifies the chain against the
// node CA, the SPIFFE trust domain, the serial (so `node_certs.allowed_kinds` applies and revoked serials are
// refused at open), the role and the expiry, and `revocations` pushes revocations to live sessions. The role
// fails closed: it refuses to start without a node CA and trust domain. @better-compute/gateway is loaded only
// when the role runs; its slice is typed structurally here.

interface GatewayLike {
  readonly id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  drain(options?: { reason?: string }): Promise<void>;
}
interface Served {
  port: number;
  close(graceMs?: number): Promise<void>;
  /** Swaps the listener's key/cert (and ca) for new handshakes. */
  setTls(material: { key?: unknown; cert?: unknown; ca?: unknown }): void;
}
/** The revocation set the gateway enforces and the revocation feed fills (pki's `RevocationSet`). */
export type RevocationSetLike = RevocationSet;
interface GatewayPackage {
  createGateway(options: Record<string, unknown>): GatewayLike;
  serveGateway(
    gateway: GatewayLike,
    options: { host?: string; port?: number; tls?: unknown; authenticate: unknown },
  ): Promise<Served>;
  serveGatewayWs(gateway: GatewayLike, options: Record<string, unknown>): Promise<Served>;
  serveInternal(
    gateway: GatewayLike,
    options: { host?: string; port?: number; tls?: unknown },
  ): Promise<Served>;
  certificateAuthenticate(options: {
    roots: readonly Uint8Array[];
    revocations?: RevocationSetLike;
    trustDomain?: string;
  }): unknown;
  xidStatusHandler: unknown;
  watchTlsFiles(
    files: { key: string; cert: string; ca?: string },
    apply: (material: { key: Buffer; cert: Buffer; ca?: Buffer }) => void,
    options?: { intervalMs?: number; onError?: (error: unknown) => void; onReload?: () => void },
  ): { close(): void };
}

export interface RunningGateway {
  id: string;
  /** The daemon listener's port. */
  port: number;
  internalPort?: number;
  wsPort?: number;
  /** Drains sessions (daemons reconnect elsewhere), closes the listeners, stops the gateway. */
  stop(): Promise<void>;
}

/** How the gateway authenticates daemons: node-CA trust anchors, the trust domain, revocations. */
export interface GatewayIdentity {
  roots: readonly Uint8Array[];
  trustDomain: string;
  revocations: RevocationSetLike;
}

/**
 * The gateway's session identity: `host.gateway.identity`, else the deployment's node CA
 * (`ComputeOptions.pki.nodeCa`, a local CA with its revocation set) and JoinService's trust domain.
 * Without a revocation set a fresh one is made: the role's revocation feed fills it from `node_certs`.
 * Throws `INVALID_CONFIG` without roots and a trust domain: the role never authenticates daemons by
 * name alone.
 */
export function gatewayIdentity(
  options: AnyComputeOptions,
  config: HostGatewayConfig,
): GatewayIdentity {
  const nodeCa = options.pki?.nodeCa as
    | { certificate?: unknown; revocations?: RevocationSetLike }
    | undefined;
  const explicit = config.identity;
  const roots =
    explicit?.roots ?? (nodeCa?.certificate instanceof Uint8Array ? [nodeCa.certificate] : []);
  const trustDomain =
    explicit?.trustDomain ??
    (options.pki?.join as { trustDomain?: string } | undefined)?.trustDomain;
  if (!roots.length || !trustDomain)
    throw new ComputeError(
      'INVALID_CONFIG',
      'The gateway role authenticates daemons by their node certificate: configure pki.nodeCa and pki.join (from the PKI bundle), or host.gateway.identity { roots, trustDomain, revocations }',
    );
  const revocations =
    (explicit?.revocations as RevocationSetLike | undefined) ??
    nodeCa?.revocations ??
    createRevocationSet();
  return { roots, trustDomain, revocations };
}

/** The exec-ticket issuer the deployment gives `tunnels.open`, if any (`ComputeOptions.tunnels`, v0.3). */
function ticketIssuer(options: AnyComputeOptions): { jwksJson(): unknown } | undefined {
  const tunnels = (options as { tunnels?: { issuer?: { jwksJson?: unknown } } }).tunnels;
  const issuer = tunnels?.issuer;
  return issuer && typeof issuer.jwksJson === 'function'
    ? (issuer as { jwksJson(): unknown })
    : undefined;
}

/** The `createGateway()` options `serve` composes; exported for the composition audit. */
/**
 * The gateway's `commandOwner`: `<reconciler>:<key>:…` idempotency keys name the work item that waits on a command,
 * when that reconciler is registered here (never a built-in job, never `node`).
 */
export function settledCommandOwner(compute: AnyCompute): (key: string) => { kind: string; key: string } | undefined {
  const builtin = new Set<string>(builtinJobNames);
  return (key) => commandOwner(key, (kind) => Object.hasOwn(compute.jobs, kind) && !builtin.has(kind));
}

export function gatewayOptions(
  pkg: Pick<GatewayPackage, 'xidStatusHandler'>,
  compute: AnyCompute,
  options: AnyComputeOptions,
  config: HostGatewayConfig,
  identity?: GatewayIdentity,
  metrics?: MetricsRegistry,
  /** The signed trust bundle this process publishes (`compute.gatewayServices.trustBundle()`, resolved once). */
  trustBundle?: unknown,
): Record<string, unknown> {
  const extra = config.options ?? {};
  const issuer = ticketIssuer(options);
  // The gateway re-checks every open tunnel (every 60 s, and at once on reauthorizeTunnels after a session
  // revocation) with the same decision the api's tunnel handler uses: the ticket's action on its instance or
  // node, for the ticket's identity and session (IamPort.authorizeSession). A tunnel without a session fails
  // closed. Without authorizeSession the gateway leaves re-checks to the api side.
  const iam = (options.iam ?? {}) as Partial<Parameters<typeof tunnelAuthorizer>[0]>;
  const authorize =
    typeof iam.authorizeSession === 'function' && typeof iam.authorize === 'function'
      ? tunnelAuthorizer(iam as Parameters<typeof tunnelAuthorizer>[0], {
          // Decisions name resources as the deployment does (ComputeOptions.typePrefix).
          typePrefix: (options as { typePrefix?: string }).typePrefix ?? 'compute-',
        })
      : undefined;
  const reauthorize = authorize
    ? (info: {
        subject: string;
        nodeId: string;
        op: string;
        tenantId?: string;
        instanceId?: string;
        sessionId?: string;
        action?: string;
        sandboxId?: string;
      }) =>
        authorize({
          claims: {
            sub: info.subject,
            aud: `node:${info.nodeId}`,
            op: info.op,
            ...(info.sessionId ? { ses: info.sessionId } : {}),
            ...(info.tenantId ? { tnt: info.tenantId } : {}),
            ...(info.instanceId ? { inst: info.instanceId } : {}),
            ...(info.action ? { act: info.action } : {}),
            // sandboxes.exec tickets are re-decided as compute:sandboxes:exec on the sandbox (§3.7).
            ...(info.sandboxId ? { sbx: info.sandboxId } : {}),
          } as Parameters<typeof authorize>[0]['claims'],
        })
    : undefined;
  // Status handlers compose (the gateway runs each): XID health always, then the configuration's, such
  // as vps's `instanceStatusHandler({ events, log })` when it registers `vps()`.
  const { status, ...reports } = (extra.reports ?? {}) as Record<string, unknown>;
  const statusHandlers = [
    pkg.xidStatusHandler,
    ...(status === undefined ? [] : Array.isArray(status) ? status : [status]),
  ];
  return {
    ...(issuer
      ? {
          tunnels: {
            jwks: () => issuer.jwksJson(),
            issuer: compute.endpoint.origin,
            ...(reauthorize ? { reauthorize } : {}),
          },
        }
      : {}),
    ...(config.internal ? { internalUrl: config.internal.url } : {}),
    ...(options.log ? { log: options.log } : {}),
    // gateway_handshakes_total{outcome}: welcomed, upgrade-required, busy, refused, unavailable, error.
    ...(metrics
      ? {
          observe: {
            onHandshake: (outcome: string) =>
              standardMetrics(metrics).gatewayHandshakes.inc({ outcome }),
          },
        }
      : {}),
    // Live sessions whose certificate is revoked get a RevocationNotice and are closed (§16: ≤ 5 s).
    ...(identity ? { revocations: identity.revocations } : {}),
    // Welcome.trust: daemons that joined before a root rotation, an approver-set change or a new epoch learn it on
    // their next session (the bundle only changes with a restart of this process, so it is resolved once).
    ...(trustBundle ? { trustBundle: () => trustBundle } : {}),
    ...extra,
    region: config.region,
    database: options.database,
    // Join, Renew and Secret counted and timed when the host has a registry.
    services: metrics
      ? meteredGatewayServices(compute.gatewayServices, metrics)
      : compute.gatewayServices,
    work: compute.context.work,
    events: compute.context.events,
    // A settled command wakes its owner (`<reconciler>:<key>:…`) at once, as the command sweeper does for expired
    // and failed ones; without it the owner only notices at its periodic pass.
    commandOwner: settledCommandOwner(compute),
    reports: { ...gatewayReportHandlers, ...reports, status: statusHandlers },
  };
}

/** DER certificates of a PEM bundle, in order. */
function pemCertificates(pem: unknown): Uint8Array[] {
  const text = Buffer.isBuffer(pem) ? pem.toString('utf8') : String(pem ?? '');
  return [...text.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map(
    (match) => new Uint8Array(Buffer.from(match[1]!.replace(/\s+/g, ''), 'base64')),
  );
}

/** `tls` with the key/cert/ca that `files` names read over it (the files win). */
export function tlsWithFiles<T extends SecureServerOptions>(tls: T, files: HostTlsFiles | undefined): T {
  if (!files) return tls;
  return {
    ...tls,
    key: readFileSync(files.key),
    cert: readFileSync(files.cert),
    ...(files.ca ? { ca: readFileSync(files.ca) } : {}),
  };
}

/** Starts the gateway role; `stop()` drains it and closes its listeners. */
export async function startGateway(
  compute: AnyCompute,
  options: AnyComputeOptions,
  given: HostGatewayConfig,
  note: (message: string) => void,
  metrics?: MetricsRegistry,
): Promise<RunningGateway> {
  // Certificates from files: read now, and re-read when renewed (below).
  const config: HostGatewayConfig = {
    ...given,
    tls: tlsWithFiles(given.tls, given.tlsFiles),
    ...(given.internal
      ? { internal: { ...given.internal, tls: tlsWithFiles(given.internal.tls, given.internal.tlsFiles) } }
      : {}),
  };
  const identity = gatewayIdentity(options, config);
  const pkg = gatewayPackage as unknown as GatewayPackage;
  // The signed trust bundle (its version settled against the deployment's record first).
  const services = compute.gatewayServices as { trustBundle?: () => Promise<unknown> };
  const trustBundle = await services.trustBundle?.().catch((error: unknown) => {
    note(`Trust bundle: not relayed in Welcome (${error instanceof Error ? error.message : String(error)})`);
    return undefined;
  });
  const gateway = pkg.createGateway(
    gatewayOptions(pkg, compute, options, config, identity, metrics, trustBundle),
  );
  await gateway.start();
  // Revocations reach this gateway within about a second (§16: a revoked node is out within 5 s):
  // the feed polls node_certs.revoked_at into the set the gateway enforces and subscribes to.
  const feed: RevocationFeed = createRevocationFeed({
    sql: options.database,
    revocations: identity.revocations,
    onError: (error) => {
      if (feed.consecutiveFailures === 1 || feed.consecutiveFailures % 60 === 0)
        note(
          `Revocation feed: polling node_certs failed ${feed.consecutiveFailures} time(s): ${error instanceof Error ? error.message : String(error)}`,
        );
    },
  });
  feed.start();
  // Sessions by role, stream headroom, draining, lease held, in-flight commands: sampled at scrape.
  if (metrics)
    gatewayCollector(metrics, () => [gateway as unknown as SampledGateway], {
      // Also the standard gateway_sessions{role}.
      metrics: standardMetrics(metrics),
    });
  const listeners: Served[] = [];
  const watches: { close(): void }[] = [];
  const stop = async () => {
    for (const watch of watches.splice(0)) watch.close();
    feed.stop();
    await gateway.drain({ reason: 'shutdown' }).catch(() => undefined);
    for (const listener of listeners.splice(0).reverse())
      await listener.close(2_000).catch(() => undefined);
    await gateway.stop();
  };
  const running: RunningGateway = { id: gateway.id, port: 0, stop };
  try {
    const served = await pkg.serveGateway(gateway, {
      host: config.listen?.host ?? '0.0.0.0',
      port: config.listen?.port ?? 8443,
      tls: config.tls,
      authenticate: pkg.certificateAuthenticate(identity),
    });
    listeners.push(served);
    running.port = served.port;
    note(
      `Gateway ${gateway.id} (${config.region}) listening for daemons on port ${served.port} (mTLS)`,
    );
    if (config.ws) {
      const key: KeyObject = createPrivateKey(config.tls.key as string | Buffer);
      const chain = pemCertificates(config.tls.cert);
      const ws = await pkg.serveGatewayWs(gateway, {
        host: config.ws.listen?.host ?? '0.0.0.0',
        port: config.ws.listen?.port ?? 443,
        tls: { key: config.tls.key, cert: config.tls.cert },
        roots: identity.roots,
        audiences: [config.ws.publicHost],
        serving: { key, chain },
        trustDomain: identity.trustDomain,
        ...(identity.revocations ? { revocations: identity.revocations } : {}),
      });
      listeners.push(ws);
      running.wsPort = ws.port;
      note(`Gateway WS fallback on port ${ws.port} (wss://${config.ws.publicHost}/v1/session)`);
    }
    if (config.internal) {
      // Never the public root store: clients of the control API are internal-CA certificates only.
      if (!config.internal.tls.ca)
        throw new ComputeError(
          'INVALID_CONFIG',
          'host.gateway.internal needs ca (the internal CA) in tls or tlsFiles',
        );
      const internal = await pkg.serveInternal(gateway, {
        host: config.internal.listen?.host ?? '0.0.0.0',
        port: config.internal.listen?.port ?? 8444,
        tls: config.internal.tls,
      });
      listeners.push(internal);
      running.internalPort = internal.port;
      note(`Gateway control API on port ${internal.port} (${config.internal.url})`);
      const files = given.internal?.tlsFiles;
      if (files)
        watches.push(
          pkg.watchTlsFiles(files, (material) => internal.setTls(material), {
            intervalMs: files.intervalMs ?? 60_000,
            onError: (error) => note(`Gateway control API certificate not reloaded: ${String(error)}`),
            onReload: () => note('Gateway control API certificate reloaded'),
          }),
        );
    }
    // A renewed serving certificate reaches new handshakes on the daemon listener and the WS fallback.
    const files = given.tlsFiles;
    if (files) {
      const served = listeners.slice(0, config.ws ? 2 : 1);
      watches.push(
        pkg.watchTlsFiles(
          files,
          (material) => {
            for (const listener of served) listener.setTls(material);
          },
          {
            intervalMs: files.intervalMs ?? 60_000,
            onError: (error) => note(`Gateway serving certificate not reloaded: ${String(error)}`),
            onReload: () => note('Gateway serving certificate reloaded'),
          },
        ),
      );
    }
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
  return running;
}
