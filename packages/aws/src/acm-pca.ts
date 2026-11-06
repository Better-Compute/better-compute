import { createHash } from 'node:crypto';
import {
  ComputeError,
  systemClock,
  type CertificateAuthority,
  type CertificateProfile,
  type IssuedCertificate,
} from '@better-compute/core';
import { fromPem, parseCertificate, parseCsr, rolePrefix, toPem } from '@better-compute/pki';
import { transportFor, type AwsServiceOptions } from './common.js';
import { jsonClient } from './internal/transport.js';

export interface AcmPcaCertificateAuthorityOptions extends AwsServiceOptions {
  /** e.g. 'node' | 'serving' | 'internal' (one CA per job; no key does two jobs). */
  id: string;
  certificateAuthorityArn: string;
  /** In-call wait for GetCertificate (default 10_000; polled every 250 ms). */
  issueWaitMs?: number;
  /** Subject organization (default 'better-compute', as the local CAs). */
  organization?: string;
}

const pollMs = 250;
const caCacheMs = 3600_000;

const revocationReasons: Readonly<Record<string, string>> = {
  unspecified: 'UNSPECIFIED',
  keycompromise: 'KEY_COMPROMISE',
  key_compromise: 'KEY_COMPROMISE',
  cacompromise: 'CERTIFICATE_AUTHORITY_COMPROMISE',
  affiliationchanged: 'AFFILIATION_CHANGED',
  affiliation_changed: 'AFFILIATION_CHANGED',
  superseded: 'SUPERSEDED',
  cessationofoperation: 'CESSATION_OF_OPERATION',
  cessation_of_operation: 'CESSATION_OF_OPERATION',
  privilegewithdrawn: 'PRIVILEGE_WITHDRAWN',
  aacompromise: 'A_A_COMPROMISE',
};

/** `0a:1b:…` from lower-case hex (what RevokeCertificate wants). */
export function colonSerial(serial: string): string {
  const hex = serial.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length === 0 || hex.length > 40) throw new ComputeError('INVALID_INPUT', 'not a certificate serial');
  const even = hex.length % 2 ? `0${hex}` : hex;
  return even.match(/../g)!.join(':');
}

function pemList(text: string | undefined): Uint8Array[] {
  return text ? fromPem(text) : [];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * AWS Private CA as a `CertificateAuthority`. Certificates are issued from the API-passthrough
 * blank end-entity template, so the subject (O, the `bc-role:` OU, CN), SANs and EKU follow the
 * profile exactly as the local CAs build them, and the CA's own policy still applies.
 */
export function acmPcaCertificateAuthority(options: AcmPcaCertificateAuthorityOptions): CertificateAuthority {
  const arn = /^arn:(aws|aws-cn|aws-us-gov):acm-pca:([a-z0-9-]+):(\d{12}):certificate-authority\/[0-9a-f-]{36}$/.exec(
    options.certificateAuthorityArn,
  );
  if (!arn) throw new ComputeError('INVALID_CONFIG', 'not an ACM Private CA ARN');
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(options.id)) throw new ComputeError('INVALID_CONFIG', 'a CA id is [a-z][a-z0-9-]*');
  const partition = arn[1]!;
  const caArn = options.certificateAuthorityArn;
  const waitMs = options.issueWaitMs ?? 10_000;
  const clock = options.clock ?? systemClock;
  const organization = options.organization ?? 'better-compute';
  const client = jsonClient(transportFor(options), { hostPrefix: 'acm-pca', jsonVersion: '1.1', targetPrefix: 'ACMPrivateCA' });
  let cached: { at: number; certificates: Uint8Array[] } | undefined;

  function passthrough(profile: CertificateProfile) {
    const uriSans = profile.uriSans ?? [];
    const dnsSans = profile.dnsSans ?? [];
    if (uriSans.length + dnsSans.length === 0) throw new ComputeError('INVALID_INPUT', 'a certificate needs a SAN');
    if (profile.usage !== 'client' && profile.usage !== 'server')
      throw new ComputeError('INVALID_INPUT', 'usage is client or server');
    const commonName = (dnsSans[0] ?? uriSans[0]!.split('/').filter(Boolean).pop() ?? 'better-compute').slice(0, 64);
    const role = profile.role;
    if (role !== undefined && !/^[a-z][a-z0-9-]{0,31}$/.test(role)) throw new ComputeError('INVALID_INPUT', 'not a role');
    return {
      Subject: {
        // CustomAttributes keep the local CAs' RDN order: O, then OU=bc-role:<role>, then CN.
        CustomAttributes: [
          { ObjectIdentifier: '2.5.4.10', Value: organization },
          ...(role ? [{ ObjectIdentifier: '2.5.4.11', Value: `${rolePrefix}${role}` }] : []),
          { ObjectIdentifier: '2.5.4.3', Value: commonName },
        ],
      },
      Extensions: {
        SubjectAlternativeNames: [
          ...dnsSans.map((name) => ({ DnsName: name })),
          ...uriSans.map((uri) => ({ UniformResourceIdentifier: uri })),
        ],
        KeyUsage: { DigitalSignature: true },
        ExtendedKeyUsage: [{ ExtendedKeyUsageType: profile.usage === 'server' ? 'SERVER_AUTH' : 'CLIENT_AUTH' }],
      },
    };
  }

  async function fetchIssued(certificateArn: string): Promise<{ Certificate?: string; CertificateChain?: string }> {
    const attempts = Math.max(1, Math.ceil(waitMs / pollMs));
    for (let attempt = 1; ; attempt++) {
      try {
        return await client.call('GetCertificate', { CertificateAuthorityArn: caArn, CertificateArn: certificateArn });
      } catch (error) {
        const pending = error instanceof ComputeError && error.details?.code === 'RequestInProgressException';
        if (!pending) throw error;
        if (attempt >= attempts)
          throw new ComputeError('UNAVAILABLE', 'ACM Private CA has not issued the certificate yet', undefined, {
            reason: 'pca-pending',
            retryAfterMs: 1000,
          });
        await sleep(pollMs);
      }
    }
  }

  return {
    id: options.id,

    async certificates() {
      if (cached && clock.now() - cached.at < caCacheMs) return cached.certificates.map((item) => item.slice());
      const result = await client.call<{ Certificate?: string; CertificateChain?: string }>(
        'GetCertificateAuthorityCertificate',
        { CertificateAuthorityArn: caArn },
      );
      const certificates = [...pemList(result.Certificate), ...pemList(result.CertificateChain)];
      if (certificates.length === 0) throw new ComputeError('INVALID_STATE', 'the private CA has no certificate yet');
      cached = { at: clock.now(), certificates };
      return certificates.map((item) => item.slice());
    },

    async sign(csr, profile): Promise<IssuedCertificate> {
      parseCsr(csr); // P-256 and a valid self-signature, before anything is sent
      if (!Number.isInteger(profile.ttlSeconds) || profile.ttlSeconds <= 0)
        throw new ComputeError('INVALID_INPUT', 'ttlSeconds must be a positive integer');
      const notAfter = Math.floor(clock.now() / 1000) + profile.ttlSeconds;
      const issued = await client.call<{ CertificateArn?: string }>('IssueCertificate', {
        CertificateAuthorityArn: caArn,
        Csr: Buffer.from(toPem(csr, 'CERTIFICATE REQUEST'), 'utf8').toString('base64'),
        SigningAlgorithm: 'SHA256WITHECDSA',
        TemplateArn: `arn:${partition}:acm-pca:::template/BlankEndEntityCertificate_APIPassthrough/V1`,
        Validity: { Type: 'ABSOLUTE', Value: notAfter },
        ApiPassthrough: passthrough(profile),
        // Same request, same certificate (a retried sign does not issue twice).
        IdempotencyToken: createHash('sha256').update(csr).update(JSON.stringify(profile)).digest('hex').slice(0, 36),
      });
      if (!issued.CertificateArn) throw new ComputeError('PROVIDER_ERROR', 'IssueCertificate returned no certificate ARN');
      const result = await fetchIssued(issued.CertificateArn);
      const [certificate] = pemList(result.Certificate);
      if (!certificate) throw new ComputeError('PROVIDER_ERROR', 'GetCertificate returned no certificate');
      const parsed = parseCertificate(certificate);
      return {
        serial: parsed.serial,
        certificate,
        chain: pemList(result.CertificateChain),
        notBefore: parsed.notBefore,
        notAfter: parsed.notAfter,
      };
    },

    async revoke(serial, reason) {
      await client.call('RevokeCertificate', {
        CertificateAuthorityArn: caArn,
        CertificateSerial: colonSerial(serial),
        RevocationReason: (reason && revocationReasons[reason.toLowerCase().replace(/[\s-]/g, '')]) ?? 'UNSPECIFIED',
      });
    },
  };
}
