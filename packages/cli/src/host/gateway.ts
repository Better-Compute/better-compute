import { createPrivateKey, type KeyObject } from 'node:crypto';
import { ComputeError } from '@better-compute/core';
import { gatewayReportHandlers } from '@better-compute/server';
import type { AnyCompute, AnyComputeOptions } from '../config.js';
import { importOptional } from '../config.js';
import type { HostGatewayConfig } from './config.js';

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
}
/** pki's RevocationSet as the gateway uses it. */
export interface RevocationSetLike {
  has(serial: string): boolean;
  subscribe(listener: (entry: { serial: string; reason?: string }) => void): () => void;
}
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
  revocations?: RevocationSetLike;
}

/**
 * The gateway's session identity: `host.gateway.identity`, else the deployment's node CA
 * (`ComputeOptions.pki.nodeCa`, a local CA with its revocation set) and JoinService's trust domain.
 * Throws `INVALID_CONFIG` without both: the role never authenticates daemons by name alone.
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
  const revocations = explicit?.revocations ?? nodeCa?.revocations;
  if (!roots.length || !trustDomain)
    throw new ComputeError(
      'INVALID_CONFIG',
      'The gateway role authenticates daemons by their node certificate: configure pki.nodeCa and pki.join (from the PKI bundle), or host.gateway.identity { roots, trustDomain, revocations }',
    );
  return { roots, trustDomain, ...(revocations ? { revocations } : {}) };
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
export function gatewayOptions(
  pkg: Pick<GatewayPackage, 'xidStatusHandler'>,
  compute: AnyCompute,
  options: AnyComputeOptions,
  config: HostGatewayConfig,
  identity?: GatewayIdentity,
): Record<string, unknown> {
  const extra = config.options ?? {};
  const issuer = ticketIssuer(options);
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
          },
        }
      : {}),
    ...(config.internal ? { internalUrl: config.internal.url } : {}),
    ...(options.log ? { log: options.log } : {}),
    // Live sessions whose certificate is revoked get a RevocationNotice and are closed (§16: ≤ 5 s).
    ...(identity?.revocations ? { revocations: identity.revocations } : {}),
    ...extra,
    region: config.region,
    database: options.database,
    services: compute.gatewayServices,
    work: compute.context.work,
    events: compute.context.events,
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

/** Starts the gateway role; `stop()` drains it and closes its listeners. */
export async function startGateway(
  compute: AnyCompute,
  options: AnyComputeOptions,
  config: HostGatewayConfig,
  note: (message: string) => void,
): Promise<RunningGateway> {
  const identity = gatewayIdentity(options, config);
  const pkg = await importOptional<GatewayPackage>(
    '@better-compute/gateway',
    'better-compute serve --roles gateway',
  );
  const gateway = pkg.createGateway(gatewayOptions(pkg, compute, options, config, identity));
  await gateway.start();
  const listeners: Served[] = [];
  const stop = async () => {
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
      const internal = await pkg.serveInternal(gateway, {
        host: config.internal.listen?.host ?? '0.0.0.0',
        port: config.internal.listen?.port ?? 8444,
        tls: config.internal.tls,
      });
      listeners.push(internal);
      running.internalPort = internal.port;
      note(`Gateway control API on port ${internal.port} (${config.internal.url})`);
    }
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
  return running;
}
