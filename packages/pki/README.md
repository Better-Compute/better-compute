# @better-compute/pki

Machine PKI for better-compute (PLAN.md §3.3, §7.7, §13): the CAs that identify agents and gateways,
join tokens, the signed `JoinResponse`, and Renew proofs of possession. better-iam is the only
identity provider for people and agents; this package covers machines only.

**Status: v0.1 (W2).** Node.js only (it runs in `api`, `worker` and the CLI). No dependencies
beyond `node:crypto`, `@better-compute/core`, `@better-compute/protocol` and `@bufbuild/protobuf`:
a minimal DER layer builds and parses the X.509 certificates and PKCS#10 requests. Everything is
ECDSA P-256 with SHA-256.

## Keys: no key does two jobs

| Key                        | Factory                                  | Signs                                                                                        | Pinned by                           |
| -------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------- |
| offline root               | `createRootCa()`                         | subordinate CAs only                                                                         | —                                   |
| per-region node CA         | `createNodeCa({ issuer?, trustDomain })` | agent client certs: one SPIFFE URI SAN, role extension, `clientAuth`, ≤ 24 h (ramdisk ≤ 2 h) | gateways (trust anchor)             |
| gateway serving CA         | `createServingCa()`                      | gateway server certs: DNS SANs, `serverAuth`, ≤ 30 days                                      | daemons (`serving_ca_spki_pin`)     |
| internal CA                | `createInternalCa()`                     | api ↔ gateway ↔ worker mTLS, ≤ 7 days                                                      | control plane                       |
| JoinService signing key    | `createSigningKey()`                     | `JoinResponse`, `SignedTrustBundle`                                                          | daemons (`join_signing_key_pin`)    |
| JoinService encryption key | `generateP256KeyPair()`                  | — (sealed join tokens are encrypted to it)                                                   | daemons (`join_encryption_key_pin`) |

Each `LocalCertificateAuthority` implements core's `CertificateAuthority` (`sign(csr, profile)`) and
adds `issue(publicKey, profile)`, `revoke`, `verify(chain)` and `export()`. Issued certificates never
copy the CSR's subject: names come only from the profile. Pins use `bcd`'s form,
`spkiPin(key)` → `sha256/<base64 of SHA-256(SPKI)>`.

The role travels in a non-critical extension, `roleExtensionOid`
(`2.25.121396728463777788658791269357486937304.1.1`, a UUID arc that needs no registration), as a
UTF8String: `node`, `site`, `ramdisk`, `node-tenant`, `gateway`, `internal`.

## Joining (§3.3)

```ts
import {
  createNodeCa,
  createSigningKey,
  generateP256KeyPair,
  issueJoinToken,
  joinTokenAttestor,
  openSealedToken,
  signJoinResponse,
  claimsFromWire,
  nodeSpiffeId,
} from 'better-compute/pki';

// joinTokens.create: show `token` once, store `secretHash` in join_tokens.secret_hash.
const { id, token, secretHash } = issueJoinToken();

// JoinService, inside one transaction:
const { token: plain } = openSealedToken(request.sealedToken, joinEncryption.privateKey, {
  csr: request.csr,
});
const admitted = await joinTokenAttestor().verify(
  { attestor: 'join-token', payload: new TextEncoder().encode(plain) },
  { tx, clock, claims: claimsFromWire(request.claims), role: 'node' },
); // locks the row, checks it at compute_now(), uses_left - 1
// hardware_key: from @better-compute/inventory, never computed twice.
const issued = await nodeCa.sign(request.csr, {
  usage: 'client',
  role: 'node',
  ttlSeconds: 86_400,
  uriSans: [nodeSpiffeId({ trustDomain, siteId, nodeId })],
});
const response = signJoinResponse(
  {
    nodeId,
    certChain: [issued.certificate, ...issued.chain],
    csr: request.csr,
    trustDomain,
    siteId,
    role: 'node',
    issuedAt: clock.now(),
    trust: { version: 1 },
  },
  joinSigningKey,
);
```

**Sealed tokens are bound to the CSR.** `sealJoinToken(token, key, { csr })` puts
`csr: base64url(sha256(csr))` and `iat` in the JWE's protected header, which the AEAD authenticates.
A gateway relaying the `JoinRequest` cannot read the token, and it cannot replay the sealed blob
with its own CSR either: `openSealedToken` refuses a seal made for another CSR. The Go daemon must
set the same header members (`typ: "bcjt+jwe"`, `csr`, `iat`).

`verifyJoinToken(token, row, { now, role, claims })` is the pure check behind the attestor. It
returns `{ ok: false, reason }` with `malformed`, `unknown`, `secret-mismatch`, `revoked`,
`expired`, `exhausted`, `role-mismatch` or `expect-mismatch`. The reason is for audit only: the agent
always gets the same `ACCESS_DENIED`.

`matchesExpect` compares a token's `expect` binding with the claims after format normalization
(case, MAC separators, the `GPU-` prefix; `serial` may match the product, board or chassis serial).
**`hardware_key` is not computed here**: it belongs to `@better-compute/inventory`, so JoinService
and the Inventory controller always derive the same key. `claimsFromWire` maps `JoinRequest.claims`
to core's claims shape.

## Renew (§7.7)

`verifyRenewPop(request, { now, nodeCaRoots, replayCache, revocations })` is what `api` runs; the
gateway only relays. It checks the current chain to the node CA, revocation, the SPIFFE identity,
the new CSR, the proof by the **current** key over `renew-pop` [sha256(csr), node_id, client_time],
the ±60 s window, and a 120 s replay cache. The cache is keyed by the signed statement, not the
signature bytes, so the second valid ECDSA form `(r, n − s)` cannot be replayed. Agents sign with
`signRenewPop`.

## Also here

- `sealJwe` / `openJwe`: compact JWE, `ECDH-ES+A256KW` + `A256GCM` only, typed by `typ`. It also
  serves `SecretResponse.jwe` (v0.2). Checked against the RFC 7518 Appendix C and RFC 3394 vectors.
- `createSigningKey`, `signPurpose`, `verifySignature`: ES256 (raw `r ‖ s`) over the
  `@better-compute/protocol` `signingInput` framing, so a signature never verifies for another
  purpose. `verifySignature` takes a public key or a pin.
- `verifyCertificateChain`, `parseCertificate`, `parseCsr`, `createCsr`, and the SPIFFE ID helpers.
- `createRevocationSet()`: the in-memory revocation view gateways consult on every handshake;
  `subscribe` fires once per new revocation.
