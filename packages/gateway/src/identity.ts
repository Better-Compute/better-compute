import type { DetailedPeerCertificate } from 'node:tls';
import { systemClock, type Clock } from '@better-compute/core';
import { agentIdentityFromChain, type RevocationSet } from '@better-compute/pki';
import type { PeerIdentity } from './gateway.js';
import type { Authenticate } from './http2.js';

export interface CertificateAuthenticateOptions {
  /** DER trust anchors of the node client CA (§13). */
  roots: readonly Uint8Array[];
  /** Revoked serials are refused at the handshake; the gateway also closes live sessions. */
  revocations?: RevocationSet;
  /** Only this SPIFFE trust domain is accepted when set. */
  trustDomain?: string;
  clock?: Clock;
}

/** The peer chain as node:tls exposes it, leaf first, without the self-signed anchor loop. */
export function peerChain(certificate: DetailedPeerCertificate): Uint8Array[] {
  const chain: Uint8Array[] = [];
  const seen = new Set<string>();
  let current: DetailedPeerCertificate | undefined = certificate;
  while (current?.raw && chain.length < 8) {
    const key = current.fingerprint256 ?? current.raw.toString('base64');
    if (seen.has(key)) break;
    seen.add(key);
    chain.push(new Uint8Array(current.raw));
    if (current.issuerCertificate === current) break;
    current = current.issuerCertificate;
  }
  return chain;
}

/**
 * The production `authenticate` hook (§7.2, §13), over pki's `agentIdentityFromChain`: the chain
 * verifies to the node CA with `clientAuth`, the leaf is not revoked, and the node id comes only
 * from its single SPIFFE URI SAN. Anything else is `UNAUTHENTICATED`.
 */
export function certificateAuthenticate(options: CertificateAuthenticateOptions): Authenticate {
  const clock = options.clock ?? systemClock;
  return (peer) => {
    if (!peer.certificate) return undefined;
    try {
      const identity = agentIdentityFromChain(peerChain(peer.certificate), {
        roots: options.roots,
        now: clock.now(),
        revocations: options.revocations,
        trustDomain: options.trustDomain,
      });
      const result: PeerIdentity = {
        nodeId: identity.nodeId,
        siteId: identity.siteId,
        role: identity.role,
        serial: identity.serial,
        notAfter: identity.notAfter,
      };
      if (identity.tenantControlled) result.tenantControlled = true;
      return result;
    } catch {
      return undefined;
    }
  };
}
