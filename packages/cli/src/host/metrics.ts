import { databaseCollector, standardMetrics } from '@better-compute/observability';
import { fromPem, parseCertificate } from '@better-compute/pki';
import type { AnyCompute, AnyComputeOptions } from '../config.js';
import type { HostConfig } from './config.js';

// The database-side series of PLAN.md §14 for a process that runs worker roles: queue and outbox backlogs, command
// ages per lane, node-certificate expiries and the host's own certificates (`cert_expiry_seconds{kind}`), polled
// every 15 s into the host's registry (`host.metrics`). standardMetrics() on the same registry returns the families
// the host already defined, so nothing is registered twice.

/** `{ kind, notAfter }` of the certificates this deployment and host hold (node CA, command-signing root, serving). */
export function hostCertificates(
  options: AnyComputeOptions,
  host: HostConfig,
): { kind: string; notAfter: number }[] {
  const found: { kind: string; notAfter: number }[] = [];
  const add = (kind: string, der: Uint8Array | undefined) => {
    if (!der) return;
    try {
      found.push({ kind, notAfter: parseCertificate(der).notAfter });
    } catch {
      // Not a certificate we can read: nothing to watch.
    }
  };
  const pki = options.pki as
    | { nodeCa?: { certificate?: Uint8Array }; commandSigning?: { certificate?: Uint8Array } }
    | undefined;
  add('node-ca', pki?.nodeCa?.certificate);
  add('command-signing', pki?.commandSigning?.certificate);
  const cert = host.gateway?.tls.cert;
  if (cert !== undefined) {
    const pem = Array.isArray(cert) ? cert.map(String).join('\n') : String(cert);
    try {
      add('serving', fromPem(pem)[0]);
    } catch {
      // A DER or unreadable serving certificate: skipped.
    }
  }
  return found;
}

/** Starts the collector when the host has a registry; `stop()` ends it. */
export function startHostMetrics(
  compute: AnyCompute,
  options: AnyComputeOptions,
  host: HostConfig,
): { stop(): void } | undefined {
  const registry = host.metrics?.registry;
  if (!registry) return undefined;
  const certificates = hostCertificates(options, host);
  const collector = databaseCollector(standardMetrics(registry), {
    sql: compute.context.sql,
    laneOf: (kind) => compute.context.registry.commandKind(kind)?.lane,
    certificates: () => certificates,
  });
  // A first reading now, not 15 s after start (a failure is only a missing reading).
  void collector.refresh().catch(() => undefined);
  collector.start();
  return { stop: () => collector.stop() };
}
