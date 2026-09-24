# @better-compute/pki

Machine PKI for better-compute (PLAN.md §3.3, §7.7, §13): the CAs that identify agents and gateways,
join tokens, the signed `JoinResponse`, and Renew proofs of possession. better-iam is the only
identity provider for people and agents; this package covers machines only.

**Status: v0.1 (W2), plus the v0.2 cryptography (secrets, signed intent, attested results) ready
for the server to wire.** Node.js only (it runs in `api`, `worker` and the CLI). No dependencies
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

## Bundles, CLI, agent side

- `createPkiBundle({ trustDomain })` creates the whole set. `exportPkiBundle(bundle, { secret })`
  and `importPkiBundle(text, { secret })` seal it with HKDF-SHA256 + AES-256-GCM, with the trust
  domain in the AAD. `readPkiPins(text)` reads only the public half. The CLI's `pki init`,
  `pki show` and `pki issue-gateway` are built on these.
- `agentIdentityFromChain(chainDer, { roots, now, revocations })` authenticates a gateway handshake.
  A `node-tenant` certificate runs as `node` with `tenantControlled: true`.
- `startAgentJoin`, `finishAgentJoin` and `prepareAgentRenew` are the agent half (for `FakeDaemon`
  and the simulator). `tests/pki-flow.test.ts` runs join → handshake → rotate → revoke end to end.

## v0.2: secrets, signed intent, attested results

- **Secrets.** `localSealedSecretStore({ sql, keys })` is core's `SecretStore` over
  `sealed_secrets`, and `sealedSecretsMigration` (`pki/0001_sealed_secrets`) creates that table.
  - Values are sealed with AES-256-GCM under HKDF keys, with the AAD binding ref and tenant.
  - `keys` may hold several ids. `reseal()` moves rows to the current key and reports rows it
    cannot open.
  - Refs are `secret://<tenant>/<id>`.
  - The broker runs `openSecretRequest(req, { nodeId, lookup, now, isBound })`: the node signature
    against `node_certs`, the `epk` point, then the binding. Refusals carry `details.refusal` for
    `SecretResponse.error`.
  - `sealSecretResponse` answers with a JWE to `epk`.
  - Agents use `createSecretRequest` and `openSecretResponse`.
- **Signed intent.** `createCommandSigningAuthority()` is the root (in production, KMS or Vault
  transit). It issues `issueWorkerKey({ workerId })` keys that last ≤ 24 h and carry the
  command-signing EKU.
  - `signCommand`/`verifyCommand` and `signDesiredState`/`verifyDesiredState` check the chain to
    the `TrustBundle` roots, the EKU, purpose-bound ES256 and the node id. `required` comes from the
    daemon's kind table, and a signature that is present is always checked.
  - Root rotation: `addTrustRoot`, then switch once `trustVersionAcknowledged(version, acks,
fleetSize)`, then `removeTrustRoot`.
- **Attested results.** `verifyAttestedUpdate` (a `CommandUpdate.node_sig` over
  [command_id, uint32(state), sha256(result)]) and `verifyAttestedReport` (AllocationBound or
  AllocationReleased; the body must name the session's node) look the key up by `kid` in
  `node_certs` (`nodeCertsLookup(tx)`).
  - A revoked certificate is refused.
  - An expired certificate is accepted for 7 more days, for results journaled offline.
  - Agents sign with `signCommandUpdate` and `signAttestedReport`.

## v0.3: exec tickets and break-glass SSH

- **Exec tickets** (§7.6). `createExecTicketIssuer({ issuer })` issues ES256 JWTs with
  `typ: bc-exec+jwt`, `aud: node:<id>`, `sid`, `op` (`exec`, `console`, `ssh`, `tcp`), a single-use
  `jti`, and a lifetime of at most 60 s.
  - `jwksJson()` is `AccessSection.exec_ticket_jwks_json`. `rotate()` keeps the previous key listed.
  - The gateway and the daemon both run
    `verifyExecTicket(token, { jwks, nodeId, now, jtiCache: createReplayCache() })`, which checks
    `alg`, `typ`, key, audience, lifetime, op and replay.
- **SSH break-glass** (§13). `createSshCertificateAuthority({ algorithm: 'ed25519' | 'ecdsa-p256' })`
  issues OpenSSH cert-v01 user certificates.
  - `publicKey` is an `AccessSection.ssh_ca_public_keys` entry.
  - `issueUserCertificate({ publicKey, principals, keyId, validBefore })` refuses more than 1 h and
    empty principals. It grants `permit-pty` only unless told otherwise.
  - `parseSshCertificate` reads and verifies certificates, ssh-keygen's included. Tests round-trip
    both ways with OpenSSH's `ssh-keygen`.

## v0.4: audit primitives

`@better-compute/audit` owns the checkpoint table, the commit-order cursor and the hourly job. This
package supplies the cryptography and touches no database.

- `merkleLeafHash`, `merkleRoot`, `merkleInclusionProof` / `verifyMerkleInclusion` and
  `merkleConsistencyProof` / `verifyMerkleConsistency` implement RFC 6962, checked against the
  certificate-transparency reference roots.
- `canonicalJson` defines the bytes that get hashed and signed.
- `signCheckpoint(body, key)` / `verifyCheckpoint(signed, { pin })` handle purpose `audit-checkpoint`;
  the signed bytes must be canonical.
- The PKI bundle carries an `auditSigning` key, and `pki show` prints its `auditSigningKeyPin`.
  Bundles written before this still load.

## Offline release signing (§13 supply chain)

`release.ts` is a TUF-lite scheme: a signed manifest of one release's artifacts. It can grow into
real TUF roles later by bumping `spec`.

- **Keys.** `createReleaseSigningKey()` creates a key that stays offline. Installers and daemons know
  it only by its `sha256/…` pin.
- **Building the manifest.** `buildReleaseManifest({ product, version, sequence, signers, artifacts })`
  produces a body with these fields:
  - `type: 'bettercompute.release'` and `spec: 1`;
  - `product`, `version`, `issuedAt` and `expiresAt`;
  - a monotonic `sequence`, which is the rollback counter;
  - `keys: [{ kid, alg: 'ES256', spki }]`, the signers, cosigners included;
  - `artifacts: [{ name, platform?, sha256, size }]`, sorted by name. `platform` is `linux-amd64`,
    `linux-arm64` and so on, and `platformFromName` derives it from goreleaser names.
- **Signing.** `signReleaseManifest(manifestOrSigned, keys)` signs the canonical body bytes under
  purpose `release-manifest`. The result is
  `{ manifest: base64(body), signatures: [{ kid, sig }] }`. Pass an already signed manifest to
  cosign it.
- **Verifying.** `verifyReleaseManifest(signed, { pins, threshold }, { minSequence, product })`
  counts distinct pinned keys with a valid signature. `verifyReleaseArtifact(manifest, name, bytes)`
  then checks a download against the manifest.
- **CLI.** `release keygen|sign|cosign|verify`. `daemon install-script --release-manifest …
  --release-pins …` pins the verified per-architecture digests of the bare `linux-<arch>` binaries,
  so the script's `sha256sum -c` check follows from the release signature.

## v0.5 (optional): workload identity

- `createWorkloadIssuer({ issuer, defaultAudience })` issues ES256 OIDC tokens (`typ: JWT`, at most
  15 min) with `sub: t:<tenantId>:instance:<id>`, `tenant_id`, `instance_id` and a unique `jti`.
  - `discoveryDocument()` and `jwks()` are served on the public https:443 issuer host.
  - Rotation has three steps: `addKey()` publishes the new key, `promote(kid)` starts signing with
    it, and `retire(kid)` drops the old key, but only after its last token expired. A rotation
    therefore never invalidates an issued token (the U6 lesson).
- A tenant admin registers the issuer as an OIDC provider in better-iam and creates a
  `web-identity` trust (`StringLike token.sub "t:<tenant>:*"`). Instances then exchange tokens at
  `sts/assumeRoleWithWebIdentity`, which the tests do against a real better-iam.
- `createImdsTokenService({ issuer })` is the IMDSv2-style exchange:
  - `PUT /latest/api/token` returns a session token bound to the calling instance by an HMAC;
  - `GET /latest/identity-token` exchanges it for a workload token;
  - a session token from another instance, a forwarded request (`X-Forwarded-For`) and a `GET` for
    a session token are all refused.

## Go parity (for `bcd`, W1)

Everything `bcd` produces or checks must match this package byte for byte. Use only Go's standard
library: `crypto/ecdsa`, `crypto/ecdh`, `crypto/aes` + `crypto/cipher` (GCM), `crypto/sha256`,
`crypto/x509`. RFC 3394 AES key wrap is about 30 lines; no JOSE library is needed.

- **Signatures.** ES256 over `signingInput(purpose, parts)` from
  `packages/protocol/src/signing.ts`: `"bettercompute.v1/" ‖ purpose ‖ 0x00 ‖ (uint32_be(len) ‖
part)*`, SHA-256.
  - `Signature.sig` is raw `r ‖ s`, each left-padded to 32 bytes. Go's `ecdsa.Sign` returns
    `r, s` big.Ints, so pad them; never send ASN.1.
  - Node keys: `kid` = base64url (no padding) of SHA-256 over the SPKI DER.
  - Control-plane keys: `kid` = base64url of the certificate's subject key id, with the certificate
    in `Signature.chain[0]`.
- **Pins.** `sha256/` + standard base64 of SHA-256(SPKI DER), as `config.DecodePin` expects. To
  check a JoinResponse, take the key from `sig.chain[0]` and compare its SPKI hash with
  `join_signing_key_pin` before verifying.
- **Sealed join token.** A compact JWE whose protected header is exactly
  `{"typ":"bcjt+jwe","csr":<b64url sha256(CSR DER)>,"iat":<unix seconds>,"alg":"ECDH-ES+A256KW","enc":"A256GCM","epk":{"kty":"EC","crv":"P-256","x":…,"y":…}}`
  (member order is free: the AAD is the header bytes as sent).
  - KEK = Concat KDF: SHA-256(`00000001` ‖ Z ‖ len‖"ECDH-ES+A256KW" ‖ len‖"" ‖ len‖"" ‖
    `00000100`), with 32-bit big-endian lengths and Z the ECDH x-coordinate.
  - The CEK (32 random bytes) is wrapped with RFC 3394 under the default IV `A6A6A6A6A6A6A6A6`.
  - Payload: A256GCM with a 12-byte IV and the AAD = ASCII of the base64url protected header.
  - Plaintext: the token's UTF-8.
  - Load the key from `/etc/bcd/join-encryption.jwk`, else `/.well-known/better-compute`, and use
    it only if it matches `join_encryption_key_pin`.
- **JoinResponse check.** In order:
  1. the signature under the pinned key;
  2. `csr_sha256` equals SHA-256 of the CSR you sent;
  3. the leaf's public key equals your key;
  4. the leaf's one URI SAN is `spiffe://<trust_domain>/site/<site_id>/node/<node_id>`;
  5. the role extension matches `role`.
- **Certificates.** Agent certificates carry the role in non-critical extension
  `2.25.121396728463777788658791269357486937304.1.1` as a UTF8String. Worker command-signing
  certificates carry EKU `2.25.121396728463777788658791269357486937304.2.1`: in `x509.Verify`, pass
  `KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny}` and check `UnknownExtKeyUsage` yourself.
  Nothing we issue is critical except BasicConstraints and KeyUsage, which Go understands.
- **SecretResponse.** The JWE has `typ` `bcsecret+jwe` and carries `ref` and `rid` (request id) in
  the protected header. Check both before using the value; the recipient is the request's one-time
  `epk` (65-byte uncompressed point).
- **Renew.** `pop_sig` covers `renew-pop` [sha256(new CSR), node_id, int64_be(seconds) ‖
  int32_be(nanos)], signed with the current key. Renew at ~60% of the lifetime.
- **Release manifests (v0.4 self-update).**
  - **Signed bytes.** Base64-decode `manifest`; the result is the canonical JSON body. Each
    `signatures[i].sig` is base64url raw `r ‖ s` over `signingInput('release-manifest', [body])`.
  - **Trust.** Find each signature's key in the body's `keys` by `kid`. Parse the key's `spki` (DER
    SubjectPublicKeyInfo) and accept it only if SHA-256(SPKI) matches a configured pin. Count each
    pinned key at most once, and require `threshold` of them.
  - **Check order:**
    1. the manifest verifies (threshold, and a canonical, spec 1 body for product `bcd`);
    2. `sequence` ≥ the stored sequence (persist the new one only after installing);
    3. now < `expiresAt`;
    4. the downloaded artifact's size and SHA-256 match its entry for `linux-<arch>`.
  - Refuse the update on any failure, and keep running the current binary.

## Also here

- `sealJwe` / `openJwe`: compact JWE, `ECDH-ES+A256KW` + `A256GCM` only, typed by `typ`. It also
  serves `SecretResponse.jwe` (v0.2). Checked against the RFC 7518 Appendix C and RFC 3394 vectors.
- `createSigningKey`, `signPurpose`, `verifySignature`: ES256 (raw `r ‖ s`) over the
  `@better-compute/protocol` `signingInput` framing, so a signature never verifies for another
  purpose. `verifySignature` takes a public key or a pin.
- `verifyCertificateChain`, `parseCertificate`, `parseCsr`, `createCsr`, and the SPIFFE ID helpers.
- `createRevocationSet()`: the in-memory revocation view gateways consult on every handshake;
  `subscribe` fires once per new revocation.
