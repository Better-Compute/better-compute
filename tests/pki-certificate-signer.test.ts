import { sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ComputeError } from '@better-compute/core';
import {
  buildCertificate,
  buildCertificateWithSigner,
  distinguishedName,
  generateP256KeyPair,
  parseCertificate,
  verifyCertificateSignature,
  type CertificateTemplate,
} from '@better-compute/pki';

describe('buildCertificateWithSigner', () => {
  const issuer = generateP256KeyPair();
  const subject = generateP256KeyPair();
  const template: CertificateTemplate = {
    serial: new Uint8Array([1, 2, 3]),
    issuer: distinguishedName({ commonName: 'issuer' }),
    subject: distinguishedName({ organization: 'better-compute', commonName: 'leaf' }),
    notBefore: Date.UTC(2026, 0, 1),
    notAfter: Date.UTC(2026, 0, 2),
    publicKey: subject.publicKey,
    usage: ['client'],
    uriSans: ['spiffe://bc.example/site/s/node/n'],
    role: 'node',
  };

  it('buildCertificateWithSigner matches buildCertificate for the same key', async () => {
    const local = parseCertificate(buildCertificate(template, issuer.privateKey));
    const seen: Uint8Array[] = [];
    const remote = parseCertificate(
      await buildCertificateWithSigner(template, {
        algorithm: 'ecdsa-sha256',
        async sign(tbs) {
          seen.push(tbs);
          return new Uint8Array(sign('sha256', tbs, { key: issuer.privateKey, dsaEncoding: 'der' }));
        },
      }),
    );
    expect(Buffer.compare(Buffer.from(remote.tbs), Buffer.from(local.tbs))).toBe(0);
    expect(Buffer.compare(Buffer.from(seen[0]!), Buffer.from(local.tbs))).toBe(0);
    expect(verifyCertificateSignature(local, issuer.publicKey)).toBe(true);
    expect(verifyCertificateSignature(remote, issuer.publicKey)).toBe(true);
    expect(remote.role).toBe('node');
  });

  it('refuses a signer that returns no DER signature', async () => {
    await expect(
      buildCertificateWithSigner(template, { algorithm: 'ecdsa-sha256', sign: async () => new Uint8Array(64) }),
    ).rejects.toBeInstanceOf(ComputeError);
  });
});
