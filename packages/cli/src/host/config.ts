import type { SecureServerOptions } from 'node:http2';
import { ComputeError } from '@better-compute/core';
import type { MetricsRegistry } from '@better-compute/observability';
import type { RevocationSet } from '@better-compute/pki';
import type { AnyCompute, AnyComputeOptions } from '../config.js';
import type { HostRoute, HostUpgradeHandler } from './http.js';
import type { HostIamConfig } from './iam.js';
import type { HostTunnelsConfig } from './tunnels.js';

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
   * How daemons authenticate (default: the deployment's `pki.nodeCa`, its revocation set, and
   * `pki.join.trustDomain`). The role refuses to start without roots and a trust domain.
   */
  identity?: {
    /** DER node-CA certificates that anchor node certificates. */
    roots?: readonly Uint8Array[];
    trustDomain?: string;
    /**
     * Revoked serials: refused at session open, and pushed to live sessions (≤ 5 s). The role's
     * revocation feed adds every `node_certs` revocation to it. Default: the node CA's, else a new set.
     */
    revocations?: RevocationSet;
  };
  /**
   * The WebSocket fallback (v0.4) for networks whose TLS-inspecting proxy strips client certificates:
   * `wss://<publicHost>/v1/session`, identity proven in-band, served with the same key and chain as `tls`.
   */
  ws?: { publicHost: string; listen?: { host?: string; port?: number } };
  /**
   * Anything else `createGateway()` takes (credits, rates, revocations, extra report handlers). The host
   * fills `database`, `services`, `work`, `events`, `region` and the default `reports`
   * (`gatewayReportHandlers`, and `status: [xidStatusHandler, ...reports.status]`: add vps's
   * `instanceStatusHandler({ events, log })` there when you register `vps()`), and `tunnels` from
   * `ComputeOptions.tunnels.issuer`.
   */
  options?: Record<string, unknown>;
}

/**
 * Prometheus metrics of the process (@better-compute/observability): one registry for everything the
 * configuration meters (`meteredIamPort`, `eventCounter`, …). `serve` adds the gateway role's own
 * (`meteredGatewayServices`, `gatewayCollector`) and, with `bearerToken`, serves `GET /metrics`.
 */
export interface HostMetricsConfig {
  /** `createMetrics()` from @better-compute/observability. */
  registry: MetricsRegistry;
  /** At least 16 characters; scrapers send `Authorization: Bearer <token>`. Without it, no route. */
  bearerToken?: string;
  /** Default `/metrics`. */
  path?: string;
}

/** `host.mcp`: a gated MCP endpoint's handler and where to mount it. */
export interface HostMcpConfig {
  /** Default `/mcp`. */
  path?: string;
  /** `computeMcpEndpoint(...).handler`: answers MCP and the gate's metadata and challenges. */
  handler(request: Request): Promise<Response> | Response;
}

/** The host routes of `host.mcp`: the endpoint and its protected-resource metadata. */
export function mcpRoutes(mcp: HostMcpConfig | undefined): HostRoute[] {
  if (!mcp) return [];
  const path = mcp.path ?? '/mcp';
  const handler = (request: Request) => mcp.handler(request);
  return [
    { path, method: ['POST', 'GET', 'DELETE'], handler },
    { path: `/.well-known/oauth-protected-resource${path}`, method: 'GET', handler },
  ];
}

export interface HostConfig {
  metrics?: HostMetricsConfig;
  /**
   * Interactive tunnels on the api role, mounted when the deployment sets `tunnels: { issuer }`:
   * the re-authorizer (default `tunnelAuthorizer(iam)`) and the TLS to gateways' control APIs.
   */
  tunnels?: HostTunnelsConfig;
  /**
   * The IAM bridge whose inbox the worker roles drain, so IAM events reach compute: a revoked delegation
   * or suspended agent closes its tunnels on every gateway (within the inbox's 2 s poll), and revocations
   * drop this process's IAM caches. The gateway clients use `tunnels.control` TLS.
   */
  iam?: HostIamConfig;
  /**
   * The MCP endpoint for AI agents (PLAN.md §9.3): `computeMcpEndpoint({ compute, gate, delegations })` from
   * @better-compute/mcp, better-iam's gate in front. Mounted at `path` (default `/mcp`, POST/GET/DELETE) and at
   * its RFC 9728 metadata path `/.well-known/oauth-protected-resource{path}`.
   */
  mcp?: HostMcpConfig;
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
  const { http, gateway, metrics, iam, mcp } = value as HostConfig;
  if (
    mcp !== undefined &&
    (!isRecord(mcp) ||
      typeof mcp.handler !== 'function' ||
      (mcp.path !== undefined && (typeof mcp.path !== 'string' || !/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(mcp.path))))
  )
    throw new ComputeError(
      'INVALID_CONFIG',
      'host.mcp needs a handler (computeMcpEndpoint(...).handler from @better-compute/mcp) and an absolute path',
    );
  if (http !== undefined && !isRecord(http))
    throw new ComputeError('INVALID_CONFIG', 'host.http must be an object');
  if (
    iam !== undefined &&
    (!isRecord(iam) || !isRecord(iam.bridge) || typeof iam.bridge.setHandlers !== 'function')
  )
    throw new ComputeError(
      'INVALID_CONFIG',
      'host.iam needs the IAM bridge: { bridge } from createComputeIamBridge() (@better-compute/iam)',
    );
  if (metrics !== undefined) {
    if (!isRecord(metrics) || !isRecord(metrics.registry))
      throw new ComputeError(
        'INVALID_CONFIG',
        'host.metrics needs a registry (createMetrics() from @better-compute/observability)',
      );
    if (
      metrics.bearerToken !== undefined &&
      (typeof metrics.bearerToken !== 'string' || metrics.bearerToken.length < 16)
    )
      throw new ComputeError(
        'INVALID_CONFIG',
        'host.metrics.bearerToken must be at least 16 characters',
      );
  }
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
    if (
      gateway.ws !== undefined &&
      (!isRecord(gateway.ws) || typeof gateway.ws.publicHost !== 'string' || !gateway.ws.publicHost)
    )
      throw new ComputeError(
        'INVALID_CONFIG',
        'host.gateway.ws needs publicHost, the name daemons dial (the proof audience)',
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
