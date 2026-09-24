import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createPkiBundle,
  createReplayCache,
  execTicketIssuer,
  exportPkiBundle,
  formatSshPublicKey,
  importPkiBundle,
  parseSshCertificate,
  pkiPins,
  readPkiPins,
  verifyExecTicket,
} from '@better-compute/pki';

// The v0.3 access keys in the PKI bundle (PLAN.md §7.6, §13): the exec ticket key and the SSH CA
// survive export/import, so api replicas, restarts and the gateway agree on the JWKS `kid` and on
// the CA every node pins.

const SECRET = 'better-compute-bundle-access-secret-0123456789';

describe('access keys in the PKI bundle', () => {
  it('round-trips the exec ticket key and SSH CA, sealed', () => {
    const bundle = createPkiBundle({ trustDomain: 'compute.test' });
    const restored = importPkiBundle(exportPkiBundle(bundle, { secret: SECRET }), {
      secret: SECRET,
    });
    // Two issuers from the same key (two replicas) publish the same kid and accept each other's tickets.
    const a = execTicketIssuer(bundle, { issuer: 'https://compute.test' });
    const b = execTicketIssuer(restored, { issuer: 'https://compute.test' });
    expect(JSON.parse(b.jwksJson())).toEqual(JSON.parse(a.jwksJson()));
    const ticket = a.issue({ nodeId: 'node_x', sid: 'tun_1', op: 'exec', subject: 'usr_a' });
    expect(
      verifyExecTicket(ticket.token, {
        jwks: b.jwksJson(),
        nodeId: 'node_x',
        now: Date.now(),
        jtiCache: createReplayCache(),
      }).sid,
    ).toBe('tun_1');
    expect(pkiPins(restored).execTicketKeyId).toBe(JSON.parse(a.jwksJson()).keys[0].kid);

    expect(restored.sshCa!.publicKey).toBe(bundle.sshCa!.publicKey);
    const user = formatSshPublicKey(generateKeyPairSync('ed25519').publicKey);
    const cert = parseSshCertificate(
      restored.sshCa!.issueUserCertificate({
        publicKey: user,
        principals: ['root'],
        keyId: 'test',
        validBefore: Date.now() + 60_000,
      }).certificate,
    );
    expect(cert.signatureValid).toBe(true);
    expect(formatSshPublicKey(cert.signatureKey)).toBe(
      bundle.sshCa!.publicKey.split(' ').slice(0, 2).join(' '),
    );
  });

  it('shows the kid and the SSH CA in the public pins, and loads older bundles without them', () => {
    const bundle = createPkiBundle({ trustDomain: 'compute.test' });
    const text = exportPkiBundle(bundle);
    const pins = readPkiPins(text);
    expect(pins.execTicketKeyId).toBe(pkiPins(bundle).execTicketKeyId);
    expect(pins.sshCaPublicKey).toBe(bundle.sshCa!.publicKey);

    const legacy = JSON.parse(text);
    delete legacy.execTicketPublicKey;
    delete legacy.sshCaPublicKey;
    delete legacy.keys.execTickets;
    delete legacy.keys.sshCa;
    const old = importPkiBundle(JSON.stringify(legacy));
    expect(old.execTicketKey).toBeUndefined();
    expect(old.sshCa).toBeUndefined();
    expect(() => execTicketIssuer(old, { issuer: 'x' })).toThrow(/no exec ticket key/);
    expect(readPkiPins(JSON.stringify(legacy)).sshCaPublicKey).toBeUndefined();
  });

  it('refuses a bundle whose access keys do not match their public halves', () => {
    const one = JSON.parse(exportPkiBundle(createPkiBundle({ trustDomain: 'compute.test' })));
    const two = JSON.parse(exportPkiBundle(createPkiBundle({ trustDomain: 'compute.test' })));
    expect(() =>
      importPkiBundle(
        JSON.stringify({ ...one, keys: { ...one.keys, execTickets: two.keys.execTickets } }),
      ),
    ).toThrow(/exec ticket key does not match/);
    expect(() =>
      importPkiBundle(JSON.stringify({ ...one, keys: { ...one.keys, sshCa: two.keys.sshCa } })),
    ).toThrow(/SSH CA key does not match/);
  });
});
