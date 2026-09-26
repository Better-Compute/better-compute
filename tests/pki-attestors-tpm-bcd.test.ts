import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isAttestationDeferral, manualClock, type AttestationContext, type SqlTx } from '@better-compute/core';
import { sha256, tpmAttestor } from '@better-compute/pki';

// The tpm attestor's wire contract with bcd (daemon/internal/tpm/testdata, scripts/daemon-tpm-fixture.mjs):
// bcd's Go TPM client answered the challenge tpmAttestor made for its evidence; tpmAttestor must admit
// that answer as it would a machine's. bcd's TestTSContract checks the other direction.

const dir = new URL('../daemon/internal/tpm/testdata/', import.meta.url);
const read = (name: string) => new Uint8Array(readFileSync(new URL(name, dir)));
const challenge = JSON.parse(new TextDecoder().decode(read('challenge.json'))) as {
  challengeKey: string;
  now: number;
  csrSha256: string;
  payload: string;
};
const bytes = (b64url: string) => new Uint8Array(Buffer.from(b64url, 'base64url'));
const evidence = read('evidence.json');
const answer = read('answer.json');
const ek = bytes((JSON.parse(new TextDecoder().decode(evidence)) as { ek: string }).ek);

// The sim's EK certificate chains to this manufacturer root (made with the fixture, ek-root.der).
const ekRoot = read('ek-root.der');

function attestor(reasons: string[], ekRoots: Uint8Array[] = [ekRoot]) {
  return tpmAttestor({
    challengeKey: bytes(challenge.challengeKey),
    ekRoots,
    resolve: async () => ({ tenantId: 'org_bcd', role: 'node', poolId: 'pool_tpm' }),
    onRefusal: (r) => void reasons.push(r.reason),
  });
}

const context = (csrSha256: Uint8Array, at = challenge.now): AttestationContext => ({
  tx: { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as SqlTx,
  clock: manualClock(at),
  claims: {},
  role: 'node',
  csrSha256,
});

describe('tpm attestor × bcd (Go)', () => {
  it("challenges bcd's round-1 evidence", async () => {
    const verdict = await attestor([]).verify({ attestor: 'tpm', payload: evidence }, context(bytes(challenge.csrSha256)));
    expect(isAttestationDeferral(verdict) && verdict.deferred).toBe('challenge');
  });

  it("admits bcd's answer: the activated credential and its quote over the challenged PCRs", async () => {
    const reasons: string[] = [];
    const verdict = await attestor(reasons).verify({ attestor: 'tpm', payload: answer }, context(bytes(challenge.csrSha256)));
    expect(reasons).toEqual([]);
    expect(verdict).toMatchObject({ tenantId: 'org_bcd', poolId: 'pool_tpm', bind: sha256(ek) });
  });

  it("verifies the EK certificate bcd read from the TPM's NV: another manufacturer's root is refused", async () => {
    expect((JSON.parse(new TextDecoder().decode(evidence)) as { ekCert?: string }).ekCert).toBeTruthy();
    const reasons: string[] = [];
    await expect(
      attestor(reasons, [read('ek-cert.der')]).verify({ attestor: 'tpm', payload: evidence }, context(bytes(challenge.csrSha256))),
    ).rejects.toThrow();
    expect(reasons).toEqual(['ek-certificate-chain']);
  });

  it('refuses the same answer for another CSR, or after the challenge expired', async () => {
    const other: string[] = [];
    await expect(
      attestor(other).verify({ attestor: 'tpm', payload: answer }, context(new Uint8Array(32).fill(1))),
    ).rejects.toThrow();
    expect(other).toEqual(['challenge-for-another-csr']);
    const late: string[] = [];
    await expect(
      attestor(late).verify({ attestor: 'tpm', payload: answer }, context(bytes(challenge.csrSha256), challenge.now + 6 * 60_000)),
    ).rejects.toThrow();
    expect(late).toEqual(['challenge-expired']);
  });
});
