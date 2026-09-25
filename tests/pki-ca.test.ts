import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { connect, createServer } from 'node:tls';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { manualClock, type CertificateProfile } from '@better-compute/core';
import {
  children,
  createCsr,
  createInternalCa,
  createNodeCa,
  createRootCa,
  createServingCa,
  decodeOid,
  der,
  fromPem,
  generateP256KeyPair,
  nodeSpiffeId,
  parseCertificate,
  parseCsr,
  parseDer,
  parseNodeSpiffeId,
  parseSpiffeId,
  privateKeyPem,
  roleExtensionOid,
  spkiPin,
  toPem,
  verifyCertificateChain,
} from '@better-compute/pki';

const start = Date.UTC(2026, 8, 24, 12);
const day = 86_400_000;
const node = (
  nodeId = 'node_01k5w0000000000000000000aa',
  siteId = 'site_fra1',
): CertificateProfile => ({
  usage: 'client',
  role: 'node',
  ttlSeconds: 86_400,
  uriSans: [nodeSpiffeId({ trustDomain: 'compute.test', siteId, nodeId })],
});

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

describe('DER', () => {
  it('encodes integers minimally and round-trips object identifiers', () => {
    expect(hex(der.integer(0))).toBe('020100');
    expect(hex(der.integer(127))).toBe('02017f');
    expect(hex(der.integer(128))).toBe('02020080');
    expect(hex(der.integer(Uint8Array.of(0, 0, 1)))).toBe('020101');
    expect(hex(der.oid('1.2.840.10045.4.3.2'))).toBe('06082a8648ce3d040302');
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 }),
        fc.integer({ min: 0, max: 39 }),
        fc.array(fc.bigInt({ min: 0n, max: 2n ** 130n }), { maxLength: 6 }),
        (first, second, rest) => {
          const dotted = [first, second, ...rest].join('.');
          expect(decodeOid(parseDer(der.oid(dotted)))).toBe(dotted);
        },
      ),
    );
  });

  it('uses UTCTime through 2049 and GeneralizedTime from 2050 (RFC 5280)', () => {
    expect(
      Buffer.from(der.time(Date.UTC(2049, 11, 31, 23, 59, 59)))
        .subarray(2)
        .toString(),
    ).toBe('491231235959Z');
    expect(der.time(Date.UTC(2049, 0, 1))[0]).toBe(0x17);
    expect(
      Buffer.from(der.time(Date.UTC(2050, 0, 1)))
        .subarray(2)
        .toString(),
    ).toBe('20500101000000Z');
    expect(der.time(Date.UTC(2050, 0, 1))[0]).toBe(0x18);
  });

  it('rejects non-minimal, indefinite, truncated and trailing encodings', () => {
    expect(() => parseDer(Uint8Array.of(0x04, 0x81, 0x01, 0xff))).toThrow(/non-minimal/);
    expect(() => parseDer(Uint8Array.of(0x30, 0x80, 0, 0))).toThrow(/indefinite/);
    expect(() => parseDer(Uint8Array.of(0x04, 0x05, 1))).toThrow(/truncated/);
    expect(() => parseDer(Uint8Array.of(0x05, 0x00, 0x00))).toThrow(/trailing/);
    expect(() => children(parseDer(Uint8Array.of(0x04, 0x00)))).toThrow(/not constructed/);
  });

  it('never throws anything but a ComputeError on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        try {
          parseCertificate(bytes);
        } catch (error) {
          expect((error as Error).name).toBe('ComputeError');
        }
        try {
          parseCsr(bytes);
        } catch (error) {
          expect((error as Error).name).toBe('ComputeError');
        }
      }),
    );
  });
});

describe('SPIFFE IDs', () => {
  it('formats and parses node identities', () => {
    const uri = nodeSpiffeId({ trustDomain: 'compute.test', siteId: 'site_a', nodeId: 'node_b' });
    expect(uri).toBe('spiffe://compute.test/site/site_a/node/node_b');
    expect(parseNodeSpiffeId(uri)).toEqual({
      trustDomain: 'compute.test',
      siteId: 'site_a',
      nodeId: 'node_b',
    });
  });

  it('rejects what the standard forbids', () => {
    for (const bad of [
      'spiffe://Compute.test/x',
      'spiffe://compute.test/a//b',
      'spiffe://compute.test/a/../b',
      'spiffe://compute.test/a/',
      'spiffe://compute.test/a?b',
      'https://compute.test/a',
      'spiffe://',
    ])
      expect(() => parseSpiffeId(bad), bad).toThrow();
    expect(parseNodeSpiffeId('spiffe://compute.test/site/a/node/b/extra')).toBeUndefined();
    expect(parseNodeSpiffeId('spiffe://compute.test/site/a/host/b')).toBeUndefined();
  });
});

describe('CSRs', () => {
  it('round-trips and proves possession', () => {
    const { privateKey, publicKey } = generateP256KeyPair();
    const csr = parseCsr(createCsr(privateKey, { commonName: 'bcd' }));
    expect(csr.publicKey.equals(publicKey)).toBe(true);
    expect(csr.sha256).toHaveLength(32);
  });

  it('rejects a tampered request, a foreign key and a non-P-256 key', () => {
    const { privateKey } = generateP256KeyPair();
    const bytes = createCsr(privateKey);
    const tampered = bytes.slice();
    tampered[tampered.length - 5]! ^= 1;
    expect(() => parseCsr(tampered)).toThrow(/Invalid certificate request/);

    // A request whose info names one key but is signed by another.
    const other = generateP256KeyPair();
    const info = children(parseDer(bytes))[0]!;
    const forged = createCsr(other.privateKey);
    const [, algorithm, signature] = children(parseDer(forged));
    expect(() => parseCsr(der.sequence(info.bytes, algorithm!.bytes, signature!.bytes))).toThrow(
      /bad self-signature/,
    );

    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' });
    expect(() => createCsr(p384.privateKey)).toThrow(/P-256/);
  });
});

describe('local CAs', () => {
  it('issues node certificates that Node.js X509Certificate reads and verifies', async () => {
    const clock = manualClock(start);
    const ca = createNodeCa({ clock, trustDomain: 'compute.test' });
    const { privateKey } = generateP256KeyPair();
    const issued = await ca.sign(createCsr(privateKey, { commonName: 'ignored' }), node());
    const x509 = new X509Certificate(Buffer.from(issued.certificate));
    expect(x509.verify(new X509Certificate(Buffer.from(ca.certificate)).publicKey)).toBe(true);
    expect(x509.checkIssued(new X509Certificate(Buffer.from(ca.certificate)))).toBe(true);
    expect(x509.subjectAltName).toBe(
      'URI:spiffe://compute.test/site/site_fra1/node/node_01k5w0000000000000000000aa',
    );
    expect(x509.subject).not.toContain('ignored');
    expect(x509.ca).toBe(false);
    expect(x509.keyUsage).toEqual(['1.3.6.1.5.5.7.3.2']);
    expect(x509.serialNumber.toLowerCase().replace(/^0+/, '')).toBe(issued.serial);
    expect(issued.notAfter - issued.notBefore).toBe(day + 60_000);

    const parsed = parseCertificate(issued.certificate);
    // The role rides in the subject (OU=bc-role:node); no private-arc OID anywhere, which Go cannot parse.
    expect(parsed.role).toBe('node');
    expect(x509.subject).toContain('OU=bc-role:node');
    expect(parsed.extensions.has(roleExtensionOid)).toBe(false);
    for (const oid of [...parsed.extensions.keys(), ...parsed.extKeyUsage])
      expect(oid.startsWith('2.25.')).toBe(false);
    expect(parsed.authorityKeyId).toEqual(ca.subjectKeyId);
    expect(ca.verify([issued.certificate, ...issued.chain], { usage: 'client' })[0]!.serial).toBe(
      issued.serial,
    );
  });

  it('enforces each kind’s issuance policy', async () => {
    const nodeCa = createNodeCa({ trustDomain: 'compute.test' });
    const servingCa = createServingCa();
    const internalCa = createInternalCa();
    const root = createRootCa();
    const key = generateP256KeyPair().publicKey;
    const refusals: [typeof nodeCa, CertificateProfile, RegExp][] = [
      [nodeCa, { ...node(), usage: 'server' }, /client certificates only/],
      [nodeCa, { ...node(), ttlSeconds: 86_401 }, /at most 86400/],
      [nodeCa, { ...node(), role: 'ramdisk', ttlSeconds: 7201 }, /Ramdisk/],
      [nodeCa, { ...node(), role: 'gateway' }, /role is one of/],
      [nodeCa, { ...node(), uriSans: ['spiffe://other.test/site/a/node/b'] }, /trust domain/],
      [nodeCa, { ...node(), uriSans: ['spiffe://compute.test/node/b'] }, /spiffe:\/\/<td>/],
      [nodeCa, { ...node(), dnsSans: ['a.test'] }, /exactly one SPIFFE/],
      [
        servingCa,
        { usage: 'client', dnsSans: ['gw.test'], ttlSeconds: 60 },
        /server certificates only/,
      ],
      [
        servingCa,
        { usage: 'server', uriSans: ['spiffe://compute.test/gw'], ttlSeconds: 60 },
        /DNS SANs/,
      ],
      [servingCa, { usage: 'server', dnsSans: ['gw..test'], ttlSeconds: 60 }, /Invalid DNS SAN/],
      [servingCa, { usage: 'server', dnsSans: ['gw.test'], ttlSeconds: 31 * 86_400 }, /at most/],
      [internalCa, { usage: 'server', ttlSeconds: 60 }, /needs a SAN/],
      [root, { usage: 'server', dnsSans: ['gw.test'], ttlSeconds: 60 }, /signs only subordinate/],
    ];
    for (const [ca, profile, message] of refusals)
      await expect(ca.issue(key, profile), `${ca.kind} ${JSON.stringify(profile)}`).rejects.toThrow(
        message,
      );
    await expect(
      nodeCa.issue(key, { ...node(), role: 'ramdisk', ttlSeconds: 7200 }),
    ).resolves.toBeDefined();
    await expect(
      internalCa.issue(key, {
        usage: 'client',
        uriSans: ['spiffe://compute.test/worker/w1'],
        role: 'internal',
        ttlSeconds: 3600,
      }),
    ).resolves.toBeDefined();
  });

  it('chains a subordinate CA to an offline root and caps lifetimes at the issuer’s', async () => {
    const clock = manualClock(start);
    const root = createRootCa({ clock, validitySeconds: 400 * 86_400 });
    const regional = createNodeCa({ clock, issuer: root });
    expect(regional.notAfter).toBeLessThanOrEqual(root.notAfter);
    expect(parseCertificate(regional.certificate).pathLength).toBe(0);
    const issued = await regional.issue(generateP256KeyPair().publicKey, node());
    expect(issued.chain).toHaveLength(2);
    const path = verifyCertificateChain([issued.certificate, ...issued.chain], [root.certificate], {
      now: clock.now(),
      usage: 'client',
    });
    expect(path.map((cert) => cert.isCa)).toEqual([false, true, true]);
    expect(() => createNodeCa({ issuer: regional as never })).toThrow(/Only a root/);

    clock.set(regional.notAfter - 3_600_000);
    const late = await regional.issue(generateP256KeyPair().publicKey, node());
    expect(late.notAfter).toBe(regional.notAfter);
  });

  it('refuses expired, not-yet-valid, revoked, foreign and tampered certificates', async () => {
    const clock = manualClock(start);
    const ca = createNodeCa({ clock });
    const issued = await ca.issue(generateP256KeyPair().publicKey, node());
    const chain = [issued.certificate];
    expect(() => ca.verify(chain, { now: start + day + 1000 })).toThrow(
      /Certificate chain rejected/,
    );
    try {
      ca.verify(chain, { now: start + day + 1000 });
    } catch (error) {
      expect((error as { details: { reason: string } }).details.reason).toMatch(/expired/);
    }
    expect(() => ca.verify(chain, { now: start - 120_000 })).toThrow();
    expect(() => ca.verify(chain, { usage: 'server' })).toThrow();

    const other = createNodeCa({ clock });
    expect(() => other.verify(chain)).toThrow();

    const tampered = issued.certificate.slice();
    tampered[tampered.length - 80]! ^= 1;
    expect(() => ca.verify([tampered])).toThrow();

    await ca.revoke(issued.serial.toUpperCase(), 'compromised');
    expect(ca.isRevoked(issued.serial)).toBe(true);
    expect(() => ca.verify(chain)).toThrow();
  });

  it('exports and reloads a CA that keeps issuing under the same identity', async () => {
    const ca = createServingCa({ id: 'serving' });
    const exported = ca.export();
    const reloaded = createServingCa({
      id: 'serving',
      existing: {
        privateKey: exported.privateKeyPem,
        certificates: fromPem(exported.certificatesPem),
      },
    });
    expect(spkiPin(reloaded.publicKey)).toBe(spkiPin(ca.publicKey));
    const issued = await reloaded.issue(generateP256KeyPair().publicKey, {
      usage: 'server',
      dnsSans: ['gw.fra1.compute.test'],
      role: 'gateway',
      ttlSeconds: 30 * 86_400,
    });
    expect(() => ca.verify([issued.certificate], { usage: 'server' })).not.toThrow();
    expect(() =>
      createServingCa({
        existing: {
          privateKey: privateKeyPem(generateP256KeyPair().privateKey),
          certificates: [ca.certificate],
        },
      }),
    ).toThrow(/does not match/);
  });

  it('completes a mutual TLS handshake: serving cert pinned by the agent, node cert checked by the gateway', async () => {
    const servingCa = createServingCa();
    const nodeCa = createNodeCa();
    const gatewayKey = generateP256KeyPair();
    const agentKey = generateP256KeyPair();
    const gatewayCert = await servingCa.issue(gatewayKey.publicKey, {
      usage: 'server',
      dnsSans: ['gw.compute.test'],
      ttlSeconds: 86_400,
    });
    const agentCert = await nodeCa.sign(createCsr(agentKey.privateKey), node());

    const server = createServer({
      key: privateKeyPem(gatewayKey.privateKey),
      cert: toPem(gatewayCert.certificate),
      ca: toPem(nodeCa.certificate),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
    });
    const peers: string[] = [];
    server.on('secureConnection', (socket) => {
      const peer = socket.getPeerX509Certificate();
      peers.push(peer?.subjectAltName ?? '');
      // The gateway's own checks on top of TLS: role and SPIFFE identity from our parser.
      const parsed = parseCertificate(new Uint8Array(peer!.raw));
      peers.push(parsed.role ?? '');
      socket.end('ok');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    try {
      const socket = connect({
        host: '127.0.0.1',
        port,
        servername: 'gw.compute.test',
        ca: toPem(servingCa.certificate),
        key: privateKeyPem(agentKey.privateKey),
        cert: toPem(agentCert.certificate),
        checkServerIdentity: () => undefined,
      });
      await once(socket, 'secureConnect');
      expect(socket.authorized).toBe(true);
      expect(
        spkiPin(
          socket.getPeerX509Certificate()!.issuerCertificate?.publicKey ?? servingCa.publicKey,
        ),
      ).toBe(spkiPin(servingCa.publicKey));
      const [data] = await once(socket, 'data');
      expect(String(data)).toBe('ok');
      socket.destroy();
      expect(peers).toEqual([
        'URI:spiffe://compute.test/site/site_fra1/node/node_01k5w0000000000000000000aa',
        'node',
      ]);
    } finally {
      server.close();
    }
  });

  it('gives CA certificates CA key usage and a subject key id', () => {
    const ca = createInternalCa();
    const cert = parseCertificate(ca.certificate);
    expect(cert.isCa).toBe(true);
    expect(cert.keyUsage).toEqual([0, 5, 6]);
    const extensions = children(
      parseDer(children(children(parseDer(ca.certificate))[0]!).at(-1)!.value),
    );
    expect(extensions.map((ext) => decodeOid(children(ext)[0]!))).toContain('2.5.29.14');
  });
});
