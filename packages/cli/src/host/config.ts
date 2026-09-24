import type { SecureServerOptions } from 'node:http2';
import { ComputeError } from '@better-compute/core';
import type { AnyCompute, AnyComputeOptions } from '../config.js';
import type { HostRoute, HostUpgradeHandler } from './http.js';

// The named `host` export of `better-compute.config.ts`: what `serve` runs around the control plane that the
// default export describes. It is a factory of the built control plane, so routes and hooks close over the
// same instances the modules use (the events module's store for `/watch`, the exec-ticket issuer that both
// `tunnels.open` and the gateway need).
//
// ```ts
// export const host = defineHost(({ compute, env }) => ({
//   http: { routes: [{ path: '/watch', method: 'GET', handler: (r) => handleWatch(r, { … }) }] },
//   gateway: { region: 'eu-1', listen: { port: 8443 }, tls: { key, cert, ca: nodeCaRoots } },
// }));
// ```

/** The gateway role (§7): an mTLS listener for daemons, and optionally the internal control API. */
export interface HostGatewayConfig {
  /** The gateway's region, as in `sites.region`. */
  region: string;
  /** Default `0.0.0.0:8443`. */
  listen?: { host?: string; port?: number };
  /**
   * TLS of the daemon listener: `key`/`cert` from the gateway serving CA (`better-compute pki
   * issue-gateway`), `ca` = the node CA roots. Sessions authenticate by their SPIFFE certificate.
   */
  tls: SecureServerOptions;
  /**
   * The internal control API the api role dials (pokes, tunnels, revocations), over mTLS from the internal CA.
   * `url` is what this gateway advertises in its directory row.
   */
  internal?: { url: string; listen?: { host?: string; port?: number }; tls: SecureServerOptions };
  /**
   * Anything else `createGateway()` takes (credits, rates, revocations, extra report handlers). The host
   * fills `database`, `services`, `work`, `events`, `region` and the default `reports`
   * (`gatewayReportHandlers` + `xidStatusHandler`), and `tunnels` from `ComputeOptions.tunnels.issuer`.
   */
  options?: Record<string, unknown>;
}

export interface HostConfig {
  http?: {
    routes?: readonly HostRoute[];
    upgrade?: readonly HostUpgradeHandler[];
    /** Extra public fields of `/.well-known/better-compute`. */
    wellKnown?: Record<string, unknown>;
  };
  gateway?: HostGatewayConfig;
}

export interface HostContext {
  compute: AnyCompute;
  options: AnyComputeOptions;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export type HostExport = HostConfig | ((context: HostContext) => HostConfig | Promise<HostConfig>);

/** Declares the `host` export of `better-compute.config.ts` (an identity function for types). */
export function defineHost<T extends HostExport>(host: T): T {
  return host;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Resolves a `host` export (calling a factory) and checks its shape; `INVALID_CONFIG` otherwise. */
export async function resolveHost(exported: unknown, context: HostContext): Promise<HostConfig> {
  if (exported === undefined) return {};
  const value = typeof exported === 'function' ? await exported(context) : exported;
  if (!isRecord(value))
    throw new ComputeError(
      'INVALID_CONFIG',
      'The host export must be defineHost({ … }) or a factory',
    );
  const { http, gateway } = value as HostConfig;
  if (http !== undefined && !isRecord(http))
    throw new ComputeError('INVALID_CONFIG', 'host.http must be an object');
  if (gateway !== undefined) {
    if (!isRecord(gateway))
      throw new ComputeError('INVALID_CONFIG', 'host.gateway must be an object');
    if (typeof gateway.region !== 'string' || !gateway.region)
      throw new ComputeError('INVALID_CONFIG', 'host.gateway.region is required');
    if (!isRecord(gateway.tls) || !gateway.tls.key || !gateway.tls.cert || !gateway.tls.ca)
      throw new ComputeError(
        'INVALID_CONFIG',
        'host.gateway.tls needs key and cert (gateway serving CA) and ca (node CA roots): daemons connect over mTLS',
      );
    if (gateway.internal !== undefined) {
      if (!isRecord(gateway.internal) || typeof gateway.internal.url !== 'string')
        throw new ComputeError('INVALID_CONFIG', 'host.gateway.internal needs a url');
      if (!isRecord(gateway.internal.tls))
        throw new ComputeError(
          'INVALID_CONFIG',
          'host.gateway.internal.tls is required (internal CA, mutual TLS)',
        );
    }
  }
  return value as HostConfig;
}
