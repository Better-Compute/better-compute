import { gatewayReportHandlers } from '@better-compute/server';
import type { AnyCompute, AnyComputeOptions } from '../config.js';
import { importOptional } from '../config.js';
import type { HostGatewayConfig } from './config.js';

// The gateway role of `serve` (PLAN.md §7, §8.1): `createGateway` on the deployment's store and runtime ports,
// the report hooks every module needs (capacity's allocation transitions, inventory's XID health), tunnels when
// the deployment issues exec tickets, the daemon listener over mTLS (sessions authenticate by their SPIFFE
// node certificate), and the internal control API when configured. @better-compute/gateway is loaded only
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
interface GatewayPackage {
  createGateway(options: Record<string, unknown>): GatewayLike;
  serveGateway(
    gateway: GatewayLike,
    options: { host?: string; port?: number; tls?: unknown },
  ): Promise<Served>;
  serveInternal(
    gateway: GatewayLike,
    options: { host?: string; port?: number; tls?: unknown },
  ): Promise<Served>;
  xidStatusHandler: unknown;
}

export interface RunningGateway {
  id: string;
  /** The daemon listener's port. */
  port: number;
  internalPort?: number;
  /** Drains sessions (daemons reconnect elsewhere), closes the listeners, stops the gateway. */
  stop(): Promise<void>;
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
    ...extra,
    region: config.region,
    database: options.database,
    services: compute.gatewayServices,
    work: compute.context.work,
    events: compute.context.events,
    reports: { ...gatewayReportHandlers, ...reports, status: statusHandlers },
  };
}

/** Starts the gateway role; `stop()` drains it and closes its listeners. */
export async function startGateway(
  compute: AnyCompute,
  options: AnyComputeOptions,
  config: HostGatewayConfig,
  note: (message: string) => void,
): Promise<RunningGateway> {
  const pkg = await importOptional<GatewayPackage>(
    '@better-compute/gateway',
    'better-compute serve --roles gateway',
  );
  const gateway = pkg.createGateway(gatewayOptions(pkg, compute, options, config));
  await gateway.start();
  let served: Served | undefined;
  let internal: Served | undefined;
  const stop = async () => {
    await gateway.drain({ reason: 'shutdown' }).catch(() => undefined);
    await served?.close(2_000).catch(() => undefined);
    await internal?.close().catch(() => undefined);
    await gateway.stop();
  };
  try {
    served = await pkg.serveGateway(gateway, {
      host: config.listen?.host ?? '0.0.0.0',
      port: config.listen?.port ?? 8443,
      tls: config.tls,
    });
    note(
      `Gateway ${gateway.id} (${config.region}) listening for daemons on port ${served.port} (mTLS)`,
    );
    if (config.internal) {
      internal = await pkg.serveInternal(gateway, {
        host: config.internal.listen?.host ?? '0.0.0.0',
        port: config.internal.listen?.port ?? 8444,
        tls: config.internal.tls,
      });
      note(`Gateway control API on port ${internal.port} (${config.internal.url})`);
    }
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
  return {
    id: gateway.id,
    port: served.port,
    ...(internal ? { internalPort: internal.port } : {}),
    stop,
  };
}
