import { describe, expect, it } from 'vitest';
import { ComputeError, type CertificateProfile } from '@better-compute/core';
import {
  createCsr,
  createNodeCa,
  createRootCa,
  generateP256KeyPair,
  parseCertificate,
  verifyCertificateChain,
} from '@better-compute/pki';
import { acmPcaCertificateAuthority, colonSerial } from '@better-compute/aws';
import { AwsEmulator } from './support/aws-platform-emulator/index.js';
import { acmPcaFake } from './support/aws-platform-emulator/acmpca.js';

const caArn = 'arn:aws:acm-pca:us-east-1:111111111111:certificate-authority/12345678-1234-1234-1234-123456789012';
const nodeProfile: CertificateProfile = {
  uriSans: ['spiffe://bc.example/site/s1/node/node_1'],
  role: 'node',
  usage: 'client',
  ttlSeconds: 3600,
};

function pcaWorld(options: { issueWaitMs?: number } = {}) {
  const emu = new AwsEmulator();
  const root = createRootCa({ clock: emu.clock });
  const nodeCa = createNodeCa({ issuer: root, clock: emu.clock });
  const fake = acmPcaFake(emu, { arn: caArn, ca: nodeCa });
  const ca = acmPcaCertificateAuthority({
    region: 'us-east-1',
    credentials: emu.credentials,
    fetch: emu.fetch,
    endpoint: 'http://emu.local',
    clock: emu.clock,
    id: 'node',
    certificateAuthorityArn: caArn,
    ...options,
  });
  return { emu, root, nodeCa, fake, ca };
}

describe('ACM Private CA', () => {
  it('issues a node certificate the local verifier accepts', async () => {
    const { ca, emu, fake, root } = pcaWorld();
    const { privateKey } = generateP256KeyPair();
    const issued = await ca.sign(createCsr(privateKey), nodeProfile);
    const parsed = parseCertificate(issued.certificate);
    expect(parsed.role).toBe('node');
    expect(parsed.uriSans).toEqual(nodeProfile.uriSans);
    expect(parsed.extKeyUsage).toEqual(['1.3.6.1.5.5.7.3.2']);
    expect(issued.serial).toBe(parsed.serial);
    expect(issued.notAfter).toBe(parsed.notAfter);
    const authority = await ca.certificates();
    expect(authority).toHaveLength(2);
    const path = verifyCertificateChain([issued.certificate, authority[0]!], [authority.at(-1)!], {
      now: emu.clock.now(),
      usage: 'client',
    });
    expect(path).toHaveLength(3);
    expect(Buffer.compare(Buffer.from(authority.at(-1)!), Buffer.from(root.certificate))).toBe(0);
    const request = fake.issued[0]!;
    expect(request).toMatchObject({
      SigningAlgorithm: 'SHA256WITHECDSA',
      TemplateArn: 'arn:aws:acm-pca:::template/BlankEndEntityCertificate_APIPassthrough/V1',
      Validity: { Type: 'ABSOLUTE', Value: Math.floor(emu.clock.now() / 1000) + 3600 },
      ApiPassthrough: {
        Extensions: {
          SubjectAlternativeNames: [{ UniformResourceIdentifier: nodeProfile.uriSans![0] }],
          KeyUsage: { DigitalSignature: true },
          ExtendedKeyUsage: [{ ExtendedKeyUsageType: 'CLIENT_AUTH' }],
        },
      },
    });
    expect((request.ApiPassthrough as any).Subject.CustomAttributes).toContainEqual({ ObjectIdentifier: '2.5.4.11', Value: 'bc-role:node' });
    // The CA certificates are cached for an hour.
    await ca.certificates();
    expect(emu.calls('GetCertificateAuthorityCertificate')).toHaveLength(1);
  });

  it('the same CSR is idempotent', async () => {
    const { ca, emu } = pcaWorld();
    const csr = createCsr(generateP256KeyPair().privateKey);
    const first = await ca.sign(csr, nodeProfile);
    const second = await ca.sign(csr, nodeProfile);
    expect(second.serial).toBe(first.serial);
    const tokens = emu.calls('IssueCertificate').map((r) => JSON.parse(Buffer.from(r.body).toString()).IdempotencyToken);
    expect(tokens[0]).toHaveLength(36);
    expect(tokens[1]).toBe(tokens[0]);
  });

  it('waits for pending issuance, and past the wait is UNAVAILABLE', async () => {
    const { ca, fake } = pcaWorld({ issueWaitMs: 1000 });
    fake.pendingPolls = 2;
    await expect(ca.sign(createCsr(generateP256KeyPair().privateKey), nodeProfile)).resolves.toMatchObject({ serial: expect.any(String) });
    const slow = pcaWorld({ issueWaitMs: 300 });
    slow.fake.pendingPolls = 10;
    const error = (await slow.ca.sign(createCsr(generateP256KeyPair().privateKey), nodeProfile).catch((e: unknown) => e)) as ComputeError;
    expect(error).toBeInstanceOf(ComputeError);
    expect(error.code).toBe('UNAVAILABLE');
    expect(error.details?.reason).toBe('pca-pending');
  });

  it('revoke maps the serial format', async () => {
    const { ca, fake } = pcaWorld();
    await ca.revoke!('a1b2c3', 'keyCompromise');
    await ca.revoke!('0f', undefined);
    expect(fake.revoked).toEqual([
      { serial: 'a1:b2:c3', reason: 'KEY_COMPROMISE' },
      { serial: '0f', reason: 'UNSPECIFIED' },
    ]);
    expect(colonSerial('abc')).toBe('0a:bc');
    expect(() => colonSerial('')).toThrow(ComputeError);
  });

  it('refuses a bad CSR or ARN before calling AWS', async () => {
    const { ca, emu } = pcaWorld();
    await expect(ca.sign(new Uint8Array([1, 2, 3]), nodeProfile)).rejects.toBeInstanceOf(ComputeError);
    expect(emu.requests).toHaveLength(0);
    expect(() =>
      acmPcaCertificateAuthority({ region: 'us-east-1', credentials: emu.credentials, id: 'node', certificateAuthorityArn: 'arn:aws:acm-pca:us-east-1:1:x' }),
    ).toThrow(ComputeError);
  });
});
