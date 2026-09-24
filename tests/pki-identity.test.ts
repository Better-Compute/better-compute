import { describe, expect, it } from 'vitest';
import { manualClock, type CertificateProfile } from '@better-compute/core';
import {
  agentIdentityFromChain,
  createPkiBundle,
  generateP256KeyPair,
  nodeSpiffeId,
  spkiSha256,
} from '@better-compute/pki';

const start = Date.UTC(2026, 8, 24, 12);
const profile = (role: string, trustDomain = 'compute.test'): CertificateProfile => ({
  usage: 'client',
  role: role as CertificateProfile['role'],
  ttlSeconds: 3600,
  uriSans: [nodeSpiffeId({ trustDomain, siteId: 'site_a', nodeId: 'node_b' })],
});

describe('agentIdentityFromChain', () => {
  it('reads node, site and node-tenant identities from a chain to the node CA', async () => {
    const clock = manualClock(start);
    const bundle = createPkiBundle({ trustDomain: 'compute.test', clock });
    const key = generateP256KeyPair().publicKey;
    const options = {
      roots: [bundle.nodeCa.certificate],
      now: clock.now(),
      revocations: bundle.revocations,
    };
    const node = await bundle.nodeCa.issue(key, profile('node'));
    expect(agentIdentityFromChain([node.certificate, ...node.chain], options)).toMatchObject({
      nodeId: 'node_b',
      siteId: 'site_a',
      trustDomain: 'compute.test',
      role: 'node',
      tenantControlled: false,
      serial: node.serial,
      spkiSha256: spkiSha256(key),
    });
    const tenant = await bundle.nodeCa.issue(key, profile('node-tenant'));
    expect(agentIdentityFromChain([tenant.certificate], options)).toMatchObject({
      role: 'node',
      certificateRole: 'node-tenant',
      tenantControlled: true,
    });
    const site = await bundle.nodeCa.issue(key, profile('site'));
    expect(agentIdentityFromChain([site.certificate], options).role).toBe('site');
    // Rooting at the offline root works too.
    expect(
      agentIdentityFromChain([node.certificate, ...node.chain], {
        ...options,
        roots: [bundle.rootCertificate],
      }).nodeId,
    ).toBe('node_b');
  });

  it('refuses revoked, serving, foreign and expired certificates', async () => {
    const clock = manualClock(start);
    const bundle = createPkiBundle({ trustDomain: 'compute.test', clock });
    const key = generateP256KeyPair().publicKey;
    const options = {
      roots: [bundle.nodeCa.certificate],
      now: clock.now(),
      revocations: bundle.revocations,
    };
    const reason = (fn: () => unknown) => {
      try {
        fn();
        return 'accepted';
      } catch (error) {
        return (error as { details?: { reason?: string } }).details?.reason;
      }
    };
    const node = await bundle.nodeCa.issue(key, profile('node'));
    await bundle.nodeCa.revoke(node.serial);
    expect(reason(() => agentIdentityFromChain([node.certificate], options))).toBe(
      'certificate revoked',
    );

    const gateway = await bundle.servingCa.issue(key, {
      usage: 'server',
      dnsSans: ['gw.test'],
      ttlSeconds: 3600,
    });
    expect(
      reason(() => agentIdentityFromChain([gateway.certificate, ...gateway.chain], options)),
    ).toMatch(/trusted root|clientAuth/);
    expect(
      reason(() =>
        agentIdentityFromChain([gateway.certificate, ...gateway.chain], {
          ...options,
          roots: [bundle.rootCertificate],
        }),
      ),
    ).toMatch(/clientAuth/);

    const other = createPkiBundle({ trustDomain: 'other.test', clock });
    const foreign = await other.nodeCa.issue(key, profile('node', 'other.test'));
    expect(reason(() => agentIdentityFromChain([foreign.certificate], options))).toMatch(
      /trusted root/,
    );
    expect(
      reason(() =>
        agentIdentityFromChain([foreign.certificate], {
          ...options,
          roots: [other.nodeCa.certificate],
          trustDomain: 'compute.test',
        }),
      ),
    ).toBe('foreign trust domain');

    const fresh = await bundle.nodeCa.issue(key, profile('node'));
    expect(
      reason(() =>
        agentIdentityFromChain([fresh.certificate], { ...options, now: start + 2 * 3_600_000 }),
      ),
    ).toMatch(/expired/);
  });
});
