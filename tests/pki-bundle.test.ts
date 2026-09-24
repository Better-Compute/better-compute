import { describe, expect, it } from 'vitest';
import { manualClock } from '@better-compute/core';
import {
  createPkiBundle,
  exportPkiBundle,
  exportRootKey,
  generateP256KeyPair,
  importPkiBundle,
  nodeSpiffeId,
  parseCertificate,
  pkiPins,
  spkiPin,
  verifyCertificateChain,
} from '@better-compute/pki';

const secret = 'a-deployment-secret-of-at-least-32-chars!';
const start = Date.UTC(2026, 8, 24, 12);

describe('PKI bundles', () => {
  it('creates three CAs under one root and two JoinService keys, all distinct', async () => {
    const clock = manualClock(start);
    const bundle = createPkiBundle({ trustDomain: 'compute.test', clock });
    const pins = [
      spkiPin(bundle.root!.publicKey),
      spkiPin(bundle.nodeCa.publicKey),
      spkiPin(bundle.servingCa.publicKey),
      spkiPin(bundle.internalCa.publicKey),
      spkiPin(bundle.joinSigning.publicKey),
      spkiPin(bundle.joinEncryption.publicKey),
    ];
    expect(new Set(pins).size).toBe(6);
    for (const ca of [bundle.nodeCa, bundle.servingCa, bundle.internalCa])
      expect(parseCertificate(ca.certificate).authorityKeyId).toEqual(bundle.root!.subjectKeyId);
    const issued = await bundle.nodeCa.issue(generateP256KeyPair().publicKey, {
      usage: 'client',
      role: 'node',
      ttlSeconds: 3600,
      uriSans: [nodeSpiffeId({ trustDomain: 'compute.test', siteId: 's', nodeId: 'n' })],
    });
    expect(
      verifyCertificateChain([issued.certificate, ...issued.chain], [bundle.rootCertificate], {
        now: clock.now(),
        usage: 'client',
      }),
    ).toHaveLength(3);
    await expect(
      bundle.nodeCa.issue(generateP256KeyPair().publicKey, {
        usage: 'client',
        role: 'node',
        ttlSeconds: 3600,
        uriSans: [nodeSpiffeId({ trustDomain: 'other.test', siteId: 's', nodeId: 'n' })],
      }),
    ).rejects.toThrow(/trust domain/);
    expect(() => createPkiBundle({ trustDomain: 'Not A Domain' })).toThrow(/trust domain/);
  });

  it('publishes pins in bcd’s sha256/<base64> form', () => {
    const bundle = createPkiBundle({ trustDomain: 'compute.test' });
    const pins = pkiPins(bundle);
    for (const pin of [pins.servingCaSpkiPin, pins.joinSigningKeyPin, pins.joinEncryptionKeyPin])
      expect(pin).toMatch(/^sha256\/[A-Za-z0-9+/]{43}=$/);
    expect(pins.joinEncryptionJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(pins.joinEncryptionJwk).not.toHaveProperty('d');
  });

  it('round-trips sealed and plain, and refuses a wrong or short secret', () => {
    const bundle = createPkiBundle({ trustDomain: 'compute.test' });
    const sealed = exportPkiBundle(bundle, { secret });
    expect(sealed).not.toContain('PRIVATE KEY');
    const loaded = importPkiBundle(sealed, { secret });
    expect(pkiPins(loaded)).toEqual(pkiPins(bundle));
    expect(spkiPin(loaded.root!.publicKey)).toBe(spkiPin(bundle.root!.publicKey));
    expect(loaded.joinSigning.kid).toBe(bundle.joinSigning.kid);

    expect(() => importPkiBundle(sealed, { secret: `${secret}x` })).toThrow(/wrong secret/);
    expect(() => importPkiBundle(sealed)).toThrow(/sealed/);
    expect(() => exportPkiBundle(bundle, { secret: 'short' })).toThrow(/at least 32/);

    // The trust domain is authenticated: editing it breaks the seal.
    const edited = sealed.replace('"trustDomain": "compute.test"', '"trustDomain": "evil.test"');
    expect(() => importPkiBundle(edited, { secret })).toThrow(/wrong secret/);

    const plain = exportPkiBundle(bundle);
    expect(plain).toContain('PRIVATE KEY');
    expect(pkiPins(importPkiBundle(plain))).toEqual(pkiPins(bundle));
    expect(() => importPkiBundle('{}')).toThrow(/Not a better-compute PKI bundle/);
  });

  it('keeps the root offline: the bundle works without it, the root key reloads separately', async () => {
    const bundle = createPkiBundle({ trustDomain: 'compute.test' });
    const text = exportPkiBundle(bundle, { secret, omitRootKey: true });
    const online = importPkiBundle(text, { secret });
    expect(online.root).toBeUndefined();
    await expect(
      online.servingCa.issue(generateP256KeyPair().publicKey, {
        usage: 'server',
        dnsSans: ['gw.compute.test'],
        ttlSeconds: 86_400,
      }),
    ).resolves.toBeDefined();
    const rootKey = exportRootKey(bundle, { secret });
    expect(rootKey).not.toContain('PRIVATE KEY');
    const restored = importPkiBundle(text, { secret, rootKey });
    expect(spkiPin(restored.root!.publicKey)).toBe(spkiPin(bundle.root!.publicKey));
    expect(() => importPkiBundle(text, { secret: `${secret}!`, rootKey })).toThrow();
  });
});
