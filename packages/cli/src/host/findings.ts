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
