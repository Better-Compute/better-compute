import type { Finding } from '@better-compute/core';
import type { AnyCompute, AnyComputeOptions } from '../config.js';
import type { HostConfig } from './config.js';
import { gatewayIdentity } from './gateway.js';
import { checkHostRoutes } from './http.js';
import { mountTunnels } from './tunnels.js';

/**
 * What `better-compute doctor` reports about the configuration's `host` export (only reads): whether the
 * gateway role can authenticate daemons, whether the api can reach gateways (pokes, tunnels, revocations),
 * and whether the host routes fit beside the API.
 */
export function hostFindings(
  compute: AnyCompute,
  options: AnyComputeOptions,
  host: HostConfig,
): Finding[] {
  const findings: Finding[] = [];
  const routes = host.http?.routes ?? [];
  try {
    checkHostRoutes(routes, compute.endpoint.basePath);
  } catch (error) {
    findings.push({
      check: 'host.routes',
      severity: 'error',
      message: (error as Error).message,
      fix: 'Give host.http.routes absolute paths outside the API base path and the built-ins',
    });
  }
  try {
    mountTunnels(compute, options, host.tunnels)?.close();
  } catch (error) {
    findings.push({
      check: 'host.tunnels',
      severity: 'error',
      message: (error as Error).message,
      fix: 'bridge.embedded(iam, { sessionReviewer }) (or remote authorizeSessions), or host.tunnels.authorize',
    });
  }
  const bridged = (options.modules ?? []).some((module) => module.name === 'iam');
  if (bridged && !host.iam)
    findings.push({
      check: 'host.iam',
      severity: 'warning',
      message:
        'The IAM bridge is registered but its events have no reactions: a revoked delegation or suspended agent keeps its tunnels until the next re-authorization (up to 60 s), and revoked sessions stay cached for up to 30 s',
      fix: 'Export host = defineHost({ iam: { bridge } }) with the bridge from createComputeIamBridge()',
    });
  // The bridge's embedded port always refreshes admitted rows (§12.4); a remote one only with `refresh`.
  if (bridged && typeof (options.iam as { refreshResource?: unknown }).refreshResource !== 'function')
    findings.push({
      check: 'iam.refresh',
      severity: 'warning',
      message:
        'Remote IAM without admission refresh: a reservation or change can be decided on a projection row up to the replica lag old',
      fix: "bridge.remote({ ..., refresh: { url: '<iam host>/compute/refresh', secret } }) and mount host.refreshHandler on the IAM hosts",
    });
  const gateway = host.gateway;
  if (!gateway) return findings;
  try {
    // Revocations always apply: the role's feed fills its set from node_certs.
    gatewayIdentity(options, gateway);
  } catch (error) {
    findings.push({
      check: 'host.gateway.identity',
      severity: 'error',
      message: (error as Error).message,
      fix: 'better-compute pki init, then pki: { nodeCa: bundle.nodeCa, join: pkiJoinCrypto({ … }) } in the configuration',
    });
  }
  if (gateway.internal && !gateway.internal.tls?.ca && !gateway.internal.tlsFiles?.ca)
    findings.push({
      check: 'host.gateway.internal.ca',
      severity: 'error',
      message:
        'The gateway control API has no client CA: it would accept client certificates from the public root store',
      fix: 'Set host.gateway.internal.tls.ca (or tlsFiles.ca) to the internal CA',
    });
  if (!gateway.internal)
    findings.push({
      check: 'host.gateway.internal',
      severity: 'warning',
      message:
        'The gateway serves no internal control API: api processes elsewhere cannot poke it, open tunnels or push revocations to it',
      fix: 'Set host.gateway.internal { url, tls } from the internal CA (fine for a single all-in-one process)',
    });
  else if (!options.notifier)
    findings.push({
      check: 'host.gateway.notifier',
      severity: 'warning',
      message:
        'No notifier: after an enqueue the api does not wake the owning gateway, so dispatch waits for its 1 s loop',
      fix: 'notifier: gatewayNotifier({ sql: database, tls }) from @better-compute/gateway',
    });
  const tunnels = (options as { tunnels?: unknown }).tunnels;
  if (tunnels && !gateway.internal)
    findings.push({
      check: 'host.gateway.tunnels',
      severity: 'error',
      message:
        'Tunnels are configured, but the gateway has no internal control API to open them on',
      fix: 'Set host.gateway.internal { url, tls }',
    });
  return findings;
}

/**
 * (Review 14 L6) Whether `host.mcp` is gated: a gated endpoint (`computeMcpEndpoint`) answers an unauthenticated
 * `tools/list` with 401 and its OAuth challenge. Any 2xx means the handler serves MCP without a credential, e.g. a bare
 * `createComputeMcp().handler`, or one with a fixed client that makes every caller act as one credential. Read-only:
 * the probe lists tools and nothing else, and gives up after 5 s.
 */
export async function mcpFindings(host: HostConfig): Promise<Finding[]> {
  const mcp = host.mcp;
  if (!mcp) return [];
  const path = mcp.path ?? '/mcp';
  const probe = new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  let status: number;
  try {
    const answer = await Promise.race([
      Promise.resolve(mcp.handler(probe)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000).unref?.()),
    ]);
    status = answer.status;
    await answer.body?.cancel().catch(() => undefined);
  } catch {
    return [];
  }
  if (status < 200 || status > 299) return [];
  return [
    {
      check: 'host.mcp.ungated',
      severity: 'error',
      message: `host.mcp answers MCP at ${path} without a credential (tools/list returned ${status}): agents reach compute through it without the gate`,
      fix: 'Mount computeMcpEndpoint({ compute, gate: createMcpGate({ …, confirmations: false }) }).handler, never a bare createComputeMcp() handler',
    },
  ];
}
