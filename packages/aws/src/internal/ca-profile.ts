// The local CAs' per-job profile rules (pki/src/ca.ts), shared by the KMS-key CA and the ACM
// Private CA adapter so that "no key does two jobs" holds before any AWS call, whatever the
// PCA's own template and policy allow. Not exported from the package.
import { ComputeError, type CertificateProfile } from '@better-compute/core';
import { agentCertificateRoles, isNodeKeyStatement, parseNodeSpiffeId } from '@better-compute/pki';

export type CaKind = 'node' | 'serving' | 'internal';

export const caKinds: readonly CaKind[] = ['node', 'serving', 'internal'];

const day = 24 * 3600;
/** The local CAs' leaf lifetime caps: node 1 d, serving 30 d, internal 7 d. */
export const kindMaxTtlSeconds: Readonly<Record<CaKind, number>> = { node: day, serving: 30 * day, internal: 7 * day };

const dnsPattern = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The kind, or INVALID_CONFIG. */
export function checkCaKind(kind: unknown): CaKind {
  if (!(caKinds as readonly unknown[]).includes(kind))
    throw new ComputeError('INVALID_CONFIG', `a CA kind is one of ${caKinds.join(', ')}`);
  return kind as CaKind;
}

/** The kind's cap, lowered (never raised) by `maxTtlSeconds`. */
export function caMaxTtl(kind: CaKind, maxTtlSeconds?: number): number {
  if (maxTtlSeconds !== undefined && (!Number.isInteger(maxTtlSeconds) || maxTtlSeconds <= 0))
    throw new ComputeError('INVALID_CONFIG', 'maxTtlSeconds must be a positive integer');
  return Math.min(maxTtlSeconds ?? Number.POSITIVE_INFINITY, kindMaxTtlSeconds[kind]);
}

/**
 * Checks `profile` against the job's rules and returns the subject CN and role the local CAs use:
 * node = client only, one SPIFFE node URI SAN (then only `urn:bc:` statements), no DNS SANs, an
 * agent role, at most 1 d; serving = server with DNS SANs only, role gateway; internal = any SAN,
 * role internal or gateway. Throws INVALID_INPUT.
 */
export function checkCaProfile(
  kind: CaKind,
  maxTtl: number,
  profile: CertificateProfile,
): { commonName: string; role?: string } {
  const uriSans = profile.uriSans ?? [];
  const dnsSans = profile.dnsSans ?? [];
  const invalid = (message: string) => new ComputeError('INVALID_INPUT', message);
  if (!Number.isInteger(profile.ttlSeconds) || profile.ttlSeconds <= 0) throw invalid('ttlSeconds must be a positive integer');
  if (profile.ttlSeconds > maxTtl) throw invalid(`${kind} certificates live at most ${maxTtl} s`);
  if (profile.usage !== 'client' && profile.usage !== 'server') throw invalid('usage is client or server');
  for (const name of dnsSans) if (typeof name !== 'string' || name.length > 253 || !dnsPattern.test(name)) throw invalid('invalid DNS SAN');
  for (const uri of uriSans) if (typeof uri !== 'string' || !/^[a-z][a-z0-9+.-]*:[\x21-\x7e]+$/.test(uri)) throw invalid('invalid URI SAN');
  const role = profile.role;
  switch (kind) {
    case 'node': {
      if (profile.usage !== 'client') throw invalid('A node CA issues client certificates only');
      if (dnsSans.length || uriSans.length === 0 || uriSans.length > 4 || !uriSans.slice(1).every(isNodeKeyStatement))
        throw invalid('A node certificate has exactly one SPIFFE URI SAN (then only urn:bc: statements) and no DNS SANs');
      const spiffe = parseNodeSpiffeId(uriSans[0]!);
      if (!spiffe) throw invalid('The URI SAN must be spiffe://<td>/site/<site>/node/<node>');
      if (!role || !(agentCertificateRoles as readonly string[]).includes(role))
        throw invalid(`A node certificate's role is one of ${agentCertificateRoles.join(', ')}`);
      return { commonName: spiffe.nodeId, role };
    }
    case 'serving':
      if (profile.usage !== 'server') throw invalid('A serving CA issues server certificates only');
      if (dnsSans.length === 0 || uriSans.length) throw invalid('A serving certificate has DNS SANs and no URI SANs');
      if (role !== undefined && role !== 'gateway') throw invalid("A serving certificate's role is gateway");
      return { commonName: dnsSans[0]!, ...(role ? { role } : {}) };
    case 'internal': {
      if (dnsSans.length + uriSans.length === 0) throw invalid('An internal certificate needs a SAN');
      if (role !== undefined && role !== 'internal' && role !== 'gateway')
        throw invalid("An internal certificate's role is internal or gateway");
      const commonName = dnsSans[0] ?? uriSans[0]!.split('/').filter(Boolean).pop() ?? 'internal';
      return { commonName: commonName.slice(0, 64), ...(role ? { role } : {}) };
    }
  }
}
