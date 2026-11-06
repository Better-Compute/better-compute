// ACM Private CA fake. It signs with a real pki local CA (so the certificates verify), turning the
// API-passthrough fields back into a CertificateProfile, and models pending issuance.
import type { CertificateProfile } from '@better-compute/core';
import { fromPem, toPem, type LocalCertificateAuthority } from '@better-compute/pki';
import { AwsEmulator, EmuError, jsonResponse } from './index.js';

export function acmPcaFake(emu: AwsEmulator, options: { arn: string; ca: LocalCertificateAuthority }) {
  const certificates = new Map<string, { pem: string; chainPem: string; pendingPolls: number }>();
  const byToken = new Map<string, string>();
  const state = {
    certificates,
    /** GetCertificate answers RequestInProgressException this many times per certificate. */
    pendingPolls: 0,
    issued: [] as Record<string, unknown>[],
    revoked: [] as { serial: string; reason: string }[],
  };
  let next = 1;
  emu.register('acm-pca', {
    protocol: 'json',
    async handle(request) {
      const body = JSON.parse(Buffer.from(request.body).toString('utf8')) as Record<string, any>;
      if (body.CertificateAuthorityArn !== options.arn) throw new EmuError('ResourceNotFoundException', 'no such CA');
      switch (request.operation) {
        case 'IssueCertificate': {
          const token = String(body.IdempotencyToken ?? '');
          const known = token ? byToken.get(token) : undefined;
          if (known) return jsonResponse({ CertificateArn: known });
          if (body.SigningAlgorithm !== 'SHA256WITHECDSA') throw new EmuError('InvalidArgsException', 'algorithm');
          if (!String(body.TemplateArn).endsWith(':template/BlankEndEntityCertificate_APIPassthrough/V1'))
            throw new EmuError('InvalidArgsException', 'template');
          const csr = fromPem(Buffer.from(String(body.Csr), 'base64').toString('utf8'), 'CERTIFICATE REQUEST')[0];
          if (!csr) throw new EmuError('MalformedCSRException', 'bad CSR');
          const pass = body.ApiPassthrough;
          const attrs = (pass?.Subject?.CustomAttributes ?? []) as { ObjectIdentifier: string; Value: string }[];
          const ou = attrs.find((a) => a.ObjectIdentifier === '2.5.4.11')?.Value;
          const sans = (pass?.Extensions?.SubjectAlternativeNames ?? []) as { DnsName?: string; UniformResourceIdentifier?: string }[];
          const eku = pass?.Extensions?.ExtendedKeyUsage?.[0]?.ExtendedKeyUsageType;
          const profile: CertificateProfile = {
            uriSans: sans.flatMap((s) => (s.UniformResourceIdentifier ? [s.UniformResourceIdentifier] : [])),
            dnsSans: sans.flatMap((s) => (s.DnsName ? [s.DnsName] : [])),
            usage: eku === 'SERVER_AUTH' ? 'server' : 'client',
            ttlSeconds: Number(body.Validity?.Value) - Math.floor(emu.clock.now() / 1000),
            ...(ou?.startsWith('bc-role:') ? { role: ou.slice('bc-role:'.length) as CertificateProfile['role'] } : {}),
          };
          if (body.Validity?.Type !== 'ABSOLUTE') throw new EmuError('InvalidArgsException', 'validity');
          const issued = await options.ca.sign(csr, profile);
          const arn = `${options.arn}/certificate/${String(next++).padStart(32, '0')}`;
          certificates.set(arn, {
            pem: toPem(issued.certificate),
            chainPem: issued.chain.map((c) => toPem(c)).join(''),
            pendingPolls: state.pendingPolls,
          });
          if (token) byToken.set(token, arn);
          state.issued.push(body);
          return jsonResponse({ CertificateArn: arn });
        }
        case 'GetCertificate': {
          const certificate = certificates.get(String(body.CertificateArn));
          if (!certificate) throw new EmuError('ResourceNotFoundException', 'no certificate');
          if (certificate.pendingPolls > 0) {
            certificate.pendingPolls--;
            throw new EmuError('RequestInProgressException', 'The request is still in progress');
          }
          return jsonResponse({ Certificate: certificate.pem, CertificateChain: certificate.chainPem });
        }
        case 'GetCertificateAuthorityCertificate': {
          const [own, ...rest] = options.ca.chain;
          return jsonResponse({ Certificate: toPem(own!), CertificateChain: rest.map((c) => toPem(c)).join('') });
        }
        case 'RevokeCertificate':
          state.revoked.push({ serial: String(body.CertificateSerial), reason: String(body.RevocationReason) });
          return jsonResponse({});
        default:
          throw new EmuError('InvalidRequestException', request.operation);
      }
    },
  });
  return state;
}
