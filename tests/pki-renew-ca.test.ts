import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { manualClock } from '@better-compute/core';
import { createCli, type CliIO } from '@better-compute/cli';
import {
  createPkiBundle,
  exportPkiBundle,
  generateP256KeyPair,
  importPkiBundle,
  pkiPins,
  renewBundleCa,
  verifyCertificateChain,
} from '@better-compute/pki';

// Renewing a subordinate CA's certificate under the root, keeping its key (the CAs live a year): what the CA issued
// stays valid, pins do not move, and an offline root stays offline.

const day = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

describe('renewing a CA certificate', () => {
  it('keeps issued certificates and pins valid across the renewal, in both directions', async () => {
    const clock = manualClock(T0);
    const bundle = createPkiBundle({ trustDomain: 'compute.test', clock });
    const issue = async (ca: typeof bundle.servingCa) =>
      (
        await ca.issue(generateP256KeyPair().publicKey, {
          usage: 'server',
          dnsSans: ['gw.compute.test'],
          role: 'gateway',
          ttlSeconds: 30 * 86_400,
        })
      ).certificate;
    const oldCa = bundle.servingCa.certificate;
    clock.advance(330 * day);
    // Issued shortly before the renewal (30-day leaves).
    const before = await issue(bundle.servingCa);
    clock.advance(10 * day); // 25 days before the CA expires
    const renewed = renewBundleCa(bundle, 'serving', { clock });
    expect(renewed.servingCa.notAfter).toBeGreaterThan(bundle.servingCa.notAfter);
    expect(pkiPins(renewed).servingCaSpkiPin).toBe(pkiPins(bundle).servingCaSpkiPin);
    const after = await issue(renewed.servingCa);
    const now = clock.now();
    // A certificate issued before verifies against the renewed CA, and one issued after against the old CA
    // certificate (same subject and key), so processes can pick the bundle up in any order.
    expect(() => verifyCertificateChain([before], [renewed.servingCa.certificate], { now })).not.toThrow();
    expect(() => verifyCertificateChain([after], [oldCa], { now })).not.toThrow();
    // The renewed CA still chains to the root.
    expect(() =>
      verifyCertificateChain([after, renewed.servingCa.certificate], [renewed.rootCertificate], { now }),
    ).not.toThrow();
    // Node CA: renewed with its trust domain, it still issues node identities.
    const node = renewBundleCa(bundle, 'node', { clock });
    expect(node.nodeCa.notAfter).toBeGreaterThan(bundle.nodeCa.notAfter);
    const nodeLeaf = await node.nodeCa.issue(generateP256KeyPair().publicKey, {
      usage: 'client',
      uriSans: ['spiffe://compute.test/site/site_fra1/node/node_01k5w0000000000000000000aa'],
      role: 'node',
      ttlSeconds: 3600,
    });
    expect(() => node.nodeCa.verify([nodeLeaf.certificate], { usage: 'client' })).not.toThrow();
  });

  it('needs the root key', () => {
    const bundle = createPkiBundle({ trustDomain: 'compute.test' });
    const text = exportPkiBundle(bundle, { omitRootKey: true });
    expect(() => renewBundleCa(importPkiBundle(text), 'internal')).toThrow(/root key/);
  });

  it('renews through the CLI with an offline root, which never lands in the bundle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bc-renew-'));
    const out: string[] = [];
    const io: CliIO = { out: (line) => out.push(line), err() {}, cwd, env: {} };
    const run = async (argv: string[]) => {
      out.length = 0;
      await createCli().run(argv, io);
      return JSON.parse(out.join('\n'));
    };
    const initial = await run([
      'pki', 'init', '--trust-domain', 'compute.test', '--plaintext', '--offline-root', 'root.key',
    ]);
    const renewed = await run(['pki', 'renew-ca', '--ca', 'serving', '--root-key', 'root.key', '--days', '400']);
    expect(renewed).toMatchObject({ ca: 'serving', servingCaSpkiPin: initial.servingCaSpkiPin });
    const stored = JSON.parse(await readFile(join(cwd, '.better-compute', 'pki.json'), 'utf8'));
    expect(stored.keys.root).toBeUndefined();
    // Without the root key: refused.
    await expect(createCli().run(['pki', 'renew-ca', '--ca', 'node'], io)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });
});
