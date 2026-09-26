import { ComputeError, type AgentRole } from '@better-compute/core';
import type { AgentCertificateRole } from './ca.js';
import { spkiSha256 } from './keys.js';
import type { RevocationSet } from './revocation.js';
import { nodeSpiffeIdOf } from './spiffe.js';
import { verifyCertificateChain, type ParsedCertificate } from './x509.js';

/** Who an agent certificate says the peer is. `nodeId` comes from the SAN only (PLAN.md §13). */
export interface AgentIdentity {
  nodeId: string;
  siteId: string;
  trustDomain: string;
  /** The session role: `node-tenant` certificates run as `node`. */
  role: AgentRole;
  /** The role the certificate carries. */
  certificateRole: AgentCertificateRole;
  /**
   * A `node-tenant` certificate (a dedicated-root lease, v0.5): telemetry and `leave` only; never
   * secrets, specs with platform intent or signed destructive commands (§13).
   */
  tenantControlled: boolean;
  serial: string;
  notAfter: number;
  /** `node_certs.spki_sha256`. */
  spkiSha256: Uint8Array;
  leaf: ParsedCertificate;
}

export interface AgentIdentityOptions {
  /** Node-CA certificates (DER) the chain must reach. */
  roots: readonly Uint8Array[];
  /** Epoch milliseconds. */
  now: number;
  revocations?: RevocationSet;
  /** When set, the SPIFFE trust domain must equal it. */
  trustDomain?: string;
}

const certificateRoles: ReadonlySet<string> = new Set(['node', 'site', 'ramdisk', 'node-tenant']);

/**
 * Authenticates an agent from its TLS chain (DER, leaf first, as node:tls hands it over): chain to
 * the node CA with `clientAuth`, not revoked, a single node SPIFFE ID, a known role. The gateway runs
 * this on every handshake and then requires `Hello.node_id === identity.nodeId`. Throws
 * `ACCESS_DENIED` with a `reason` detail.
 */
export function agentIdentityFromChain(
  chain: readonly Uint8Array[],
  options: AgentIdentityOptions,
): AgentIdentity {
  const deny = (reason: string) =>
    new ComputeError('ACCESS_DENIED', 'Agent certificate rejected', undefined, { reason });
  let path: ParsedCertificate[];
  try {
    path = verifyCertificateChain(chain, options.roots, { now: options.now, usage: 'client' });
  } catch (error) {
    throw deny(
      error instanceof ComputeError && typeof error.details?.reason === 'string'
        ? error.details.reason
        : 'bad chain',
    );
  }
  const leaf = path[0]!;
  if (options.revocations?.has(leaf.serial)) throw deny('certificate revoked');
  const spiffe = nodeSpiffeIdOf(leaf.uriSans);
  if (!spiffe || leaf.dnsSans.length) throw deny('certificate has no single node identity');
  if (options.trustDomain !== undefined && spiffe.trustDomain !== options.trustDomain)
    throw deny('foreign trust domain');
  if (!leaf.role || !certificateRoles.has(leaf.role)) throw deny('certificate has no agent role');
  const certificateRole = leaf.role as AgentCertificateRole;
  return {
    nodeId: spiffe.nodeId,
    siteId: spiffe.siteId,
    trustDomain: spiffe.trustDomain,
    role: certificateRole === 'node-tenant' ? 'node' : certificateRole,
    certificateRole,
    tenantControlled: certificateRole === 'node-tenant',
    serial: leaf.serial,
    notAfter: leaf.notAfter,
    spkiSha256: spkiSha256(leaf.subjectPublicKeyInfo),
    leaf,
  };
}
