import { ComputeError } from '@better-compute/core';
import { gatewayTunnelRelay, type ControlClientOptions } from '@better-compute/gateway';
import { tunnelAuthorizer } from '@better-compute/iam';
import {
  handleTunnel,
  type HandleTunnelOptions,
  type RelayedTunnel,
  type TunnelRelay,
} from '@better-compute/server';
import type { AnyCompute, AnyComputeOptions } from '../config.js';
import type { HostUpgradeHandler } from './http.js';

// Interactive tunnels on the api role (PLAN.md §7.6): `GET {basePath}/tunnels/{ticket}` upgrades to a
// WebSocket, `handleTunnel` verifies the exec ticket, and the relay opens the tunnel on the gateway that
// holds the node's session through that gateway's internal control API (`gateways.internal_url`, mutual
// TLS from the internal CA). While open, the caller is re-authorized every 60 s by the ticket's identity.

/** `host.tunnels`: how the api relays tunnels and re-authorizes their callers. */
export interface HostTunnelsConfig {
  /**
   * Re-checks the caller (default: `tunnelAuthorizer(options.iam)` from @better-compute/iam, which
   * re-decides the ticket's own action on its instance or node and fails closed).
   */
  authorize?: HandleTunnelOptions['authorize'];
  /** Client TLS for the gateways' internal control APIs: key/cert and `ca` from the internal CA. */
  control?: Pick<ControlClientOptions, 'tls' | 'timeoutMs'>;
  reauthorizeMs?: number;
  maxDurationMs?: number;
  /** Called when a tunnel ends, for audit. */
  onClose?: HandleTunnelOptions['onClose'];
}

/** The tunnel mount of a host: its upgrade handler, and `close()` for the control clients it opened. */
export interface TunnelMount {
  upgrade: HostUpgradeHandler;
  close(): void;
}

/** The deployment's exec-ticket issuer (`ComputeOptions.tunnels.issuer`), if it serves tunnels. */
function issuerOf(options: AnyComputeOptions): HandleTunnelOptions['issuer'] | undefined {
  const tunnels = (options as { tunnels?: { issuer?: HandleTunnelOptions['issuer'] } }).tunnels;
  return tunnels?.issuer;
}

/**
 * The upgrade handler for `{basePath}/tunnels/{ticket}` when the deployment configures
 * `tunnels: { issuer }`, else undefined. Throws `INVALID_CONFIG` when no re-authorizer can be made.
 */
export function mountTunnels(
  compute: AnyCompute,
  options: AnyComputeOptions,
  config: HostTunnelsConfig = {},
): TunnelMount | undefined {
  const issuer = issuerOf(options);
  if (!issuer) return undefined;
  const iam = options.iam as Partial<Parameters<typeof tunnelAuthorizer>[0]>;
  const authorize =
    config.authorize ??
    (typeof iam.authorizeSession === 'function' && typeof iam.authorize === 'function'
      ? tunnelAuthorizer(iam as Parameters<typeof tunnelAuthorizer>[0])
      : undefined);
  if (!authorize)
    throw new ComputeError(
      'INVALID_CONFIG',
      'Tunnels need a re-authorizer: an IamPort with authorizeSession (the IAM bridge), or host.tunnels.authorize',
    );

  // The gateway package's relay: the node's gateway by `gateways.internal_url`, clients cached.
  const relay = gatewayTunnelRelay({
    sql: compute.context.sql,
    ...(config.control?.tls ? { tls: config.control.tls } : {}),
    ...(config.control?.timeoutMs === undefined ? {} : { timeoutMs: config.control.timeoutMs }),
  });
  const handlerOptions: HandleTunnelOptions = {
    sql: compute.context.sql as HandleTunnelOptions['sql'],
    issuer,
    // Tickets must come from this deployment's issuer (the public base URL).
    issuerName: compute.endpoint.origin,
    relay: relay as unknown as TunnelRelay,
    authorize,
    basePath: compute.endpoint.basePath,
    ...(config.reauthorizeMs === undefined ? {} : { reauthorizeMs: config.reauthorizeMs }),
    ...(config.maxDurationMs === undefined ? {} : { maxDurationMs: config.maxDurationMs }),
    ...(config.onClose ? { onClose: config.onClose } : {}),
  };
  return {
    upgrade: (req, socket, head) => handleTunnel(req, socket, head, handlerOptions),
    close: () => relay.close(),
  };
}
