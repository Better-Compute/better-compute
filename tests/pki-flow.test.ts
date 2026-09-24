import { describe, expect, it } from 'vitest';
import { manualClock } from '@better-compute/core';
import {
  agentIdentityFromChain,
  createPkiBundle,
  createReplayCache,
  finishAgentJoin,
  issueJoinToken,
  nodeSpiffeId,
  openSealedToken,
  pkiPins,
  prepareAgentRenew,
  signJoinResponse,
  startAgentJoin,
  verifyJoinToken,
  verifyRenewPop,
} from '@better-compute/pki';

// PLAN.md §3.3 and §7.7 end to end with both halves in TypeScript: the agent (as bcd does it) and
// JoinService, with only the pins an install script writes on the agent side.

describe('join and renew', () => {
  it('joins with a sealed token, authenticates, and renews with a rotated key', async () => {
    const clock = manualClock(Date.UTC(2026, 8, 24, 12));
    const pki = createPkiBundle({ trustDomain: 'compute.test', clock });
    const pins = pkiPins(pki);
    const issued = issueJoinToken();
    const row = {
      id: issued.id,
      tenantId: 'org_acme',
      role: 'node' as const,
      poolId: 'pool_h100',
      secretHash: issued.secretHash,
      usesLeft: 1,
      allowReclaim: false,
      expiresAt: clock.now() + 3_600_000,
    };

    // Agent: what the install script gave it is the token, the JWK and the three pins.
    const start = startAgentJoin({
      token: issued.token,
      joinEncryptionKey: pins.joinEncryptionJwk,
      joinEncryptionKeyPin: pins.joinEncryptionKeyPin,
      now: clock.now(),
    });

    // JoinService.
    const { token } = openSealedToken(start.sealedToken, pki.joinEncryption.privateKey, {
      csr: start.csr,
      now: clock.now(),
      maxAgeMs: 300_000,
    });
    const verdict = verifyJoinToken(token, row, { now: clock.now(), role: 'node', claims: {} });
    expect(verdict.ok).toBe(true);
    const nodeId = 'node_01k5w0000000000000000000aa';
    const cert = await pki.nodeCa.sign(start.csr, {
      usage: 'client',
      role: 'node',
      ttlSeconds: 86_400,
      uriSans: [nodeSpiffeId({ trustDomain: pki.trustDomain, siteId: 'site_fra1', nodeId })],
    });
    const chain = [cert.certificate, ...cert.chain];
    const response = signJoinResponse(
      {
        nodeId,
        certChain: chain,
        csr: start.csr,
        trustDomain: pki.trustDomain,
        siteId: 'site_fra1',
        role: 'node',
        issuedAt: clock.now(),
      },
      pki.joinSigning,
    );

    // Agent: accepts only a response signed by the pinned key for its own CSR.
    const body = finishAgentJoin(response, {
      signer: { pin: pins.joinSigningKeyPin },
      csr: start.csr,
    });
    expect(body.nodeId).toBe(nodeId);

    // Gateway: the handshake identity.
    const identity = agentIdentityFromChain(body.certChain, {
      roots: [pki.nodeCa.certificate],
      now: clock.now(),
      revocations: pki.revocations,
    });
    expect(identity).toMatchObject({ nodeId, siteId: 'site_fra1', role: 'node' });

    // ~60% into the lifetime the agent renews with a new key; api verifies the proof.
    clock.advance(0.6 * 86_400_000);
    const renew = prepareAgentRenew({
      nodeId,
      currentKey: start.privateKey,
      chain: body.certChain,
      now: clock.now(),
      rotate: true,
    });
    const verified = verifyRenewPop(renew.request, {
      now: clock.now(),
      nodeCaRoots: [pki.nodeCa.certificate],
      replayCache: createReplayCache(),
      revocations: pki.revocations,
    });
    expect(verified).toMatchObject({ nodeId, sameKey: false });
    const next = await pki.nodeCa.sign(renew.request.csr, {
      usage: 'client',
      role: 'node',
      ttlSeconds: 86_400,
      uriSans: [
        nodeSpiffeId({
          trustDomain: pki.trustDomain,
          siteId: verified.siteId,
          nodeId: verified.nodeId,
        }),
      ],
    });
    // Rotation done: the old certificate is revoked and no longer authenticates.
    await pki.nodeCa.revoke(identity.serial, 'superseded');
    expect(() =>
      agentIdentityFromChain(body.certChain, {
        roots: [pki.nodeCa.certificate],
        now: clock.now(),
        revocations: pki.revocations,
      }),
    ).toThrow();
    expect(
      agentIdentityFromChain([next.certificate], {
        roots: [pki.nodeCa.certificate],
        now: clock.now(),
        revocations: pki.revocations,
      }).nodeId,
    ).toBe(nodeId);
  });

  it('refuses to seal a token to a join encryption key that misses its pin', () => {
    const pki = createPkiBundle({ trustDomain: 'compute.test' });
    const other = createPkiBundle({ trustDomain: 'compute.test' });
    const { token } = issueJoinToken();
    expect(() =>
      startAgentJoin({
        token,
        joinEncryptionKey: pkiPins(other).joinEncryptionJwk,
        joinEncryptionKeyPin: pkiPins(pki).joinEncryptionKeyPin,
      }),
    ).toThrow(/pin/);
  });
});
