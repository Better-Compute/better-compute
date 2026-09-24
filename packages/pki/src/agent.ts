import { createPublicKey, KeyObject, type JsonWebKey } from 'node:crypto';
import type { Timestamp } from '@bufbuild/protobuf/wkt';
import type { JoinResponse, JoinResponseBody } from '@better-compute/protocol';
import { createCsr } from './csr.js';
import { verifyJoinResponse } from './join-response.js';
import { sealJoinToken } from './join-token.js';
import { generateP256KeyPair, matchesPin, toPublicKey, type PublicKeyInput } from './keys.js';
import { signRenewPop, type RenewPopRequest } from './pop.js';
import type { SignerTrust } from './signing.js';

/**
 * The agent side of joining and renewing (PLAN.md §3.3, §7.7), as `bcd` does it in Go: a fresh P-256
 * key, a CSR, the token sealed to the pinned JoinService key and bound to that CSR, the response
 * checked against the pinned signing key, and Renew proofs by the current key. `FakeDaemon`, the
 * fleet simulator and tests use it, so their joins exercise the same checks as real agents.
 */

export interface AgentJoinStart {
  /** The agent's new node key; keep it (bcd keeps it in the TPM or a 0600 file). */
  privateKey: KeyObject;
  /** `JoinRequest.csr` (DER). */
  csr: Uint8Array;
  /** `JoinRequest.sealed_token` (UTF-8 compact JWE). */
  sealedToken: Uint8Array;
}

export interface StartJoinOptions {
  /** `bcjt_<id>.<secret>`, from BCD_JOIN_TOKEN or stdin. */
  token: string;
  /** The JoinService encryption key (/etc/bcd/join-encryption.jwk). */
  joinEncryptionKey: PublicKeyInput | JsonWebKey;
  /** config.toml `join_encryption_key_pin`: the key must match it before anything is sealed. */
  joinEncryptionKeyPin?: string;
  /** Epoch milliseconds for the seal's `iat` (default now). */
  now?: number;
  /** Reuse a key instead of generating one (a reclaim with the same key). */
  privateKey?: KeyObject;
}

/** Prepares a `JoinRequest`: key, CSR and CSR-bound sealed token. Throws if the key misses its pin. */
export function startAgentJoin(options: StartJoinOptions): AgentJoinStart {
  const key = options.joinEncryptionKey;
  const encryptionKey = isJwk(key)
    ? createPublicKey({
        key: { kty: key.kty, crv: key.crv, x: key.x, y: key.y } as JsonWebKey,
        format: 'jwk',
      })
    : toPublicKey(key);
  if (
    options.joinEncryptionKeyPin !== undefined &&
    !matchesPin(encryptionKey, options.joinEncryptionKeyPin)
  )
    throw new Error('The join encryption key does not match join_encryption_key_pin');
  const privateKey = options.privateKey ?? generateP256KeyPair().privateKey;
  const csr = createCsr(privateKey);
  const sealed = sealJoinToken(options.token, encryptionKey, {
    csr,
    ...(options.now !== undefined ? { issuedAt: options.now } : {}),
  });
  return { privateKey, csr, sealedToken: new TextEncoder().encode(sealed) };
}

export interface FinishJoinOptions {
  /** config.toml `join_signing_key_pin`, or the key itself. */
  signer: SignerTrust;
  csr: Uint8Array;
  /** When known (sim, tests), the leaf must also chain to these node-CA certificates. */
  nodeCaRoots?: readonly Uint8Array[];
  now?: number;
}

/** Checks a `JoinResponse` as bcd must before using the certificate. Throws `ACCESS_DENIED`. */
export function finishAgentJoin(
  response: JoinResponse,
  options: FinishJoinOptions,
): JoinResponseBody {
  return verifyJoinResponse(response, {
    signer: options.signer,
    csr: options.csr,
    ...(options.nodeCaRoots ? { nodeCaRoots: options.nodeCaRoots } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

export interface AgentRenew {
  /** The `RenewRequest` fields: csr, chain, client_time, pop_sig. */
  request: RenewPopRequest & { clientTime: Timestamp };
  /** The key the next certificate certifies (the current one unless `rotate`). */
  privateKey: KeyObject;
}

/**
 * Prepares a `RenewRequest` at ~60% of the certificate's lifetime: a CSR (for a new key when
 * `rotate`), signed as proof of possession by the CURRENT key.
 */
export function prepareAgentRenew(options: {
  nodeId: string;
  currentKey: KeyObject;
  /** The current chain, leaf first. */
  chain: readonly Uint8Array[];
  now: number;
  rotate?: boolean;
}): AgentRenew {
  const privateKey = options.rotate ? generateP256KeyPair().privateKey : options.currentKey;
  const csr = createCsr(privateKey);
  const pop = signRenewPop({
    csr,
    nodeId: options.nodeId,
    clientTime: options.now,
    privateKey: options.currentKey,
  });
  return {
    request: { csr, chain: [...options.chain], clientTime: pop.clientTime, popSig: pop.popSig },
    privateKey,
  };
}

function isJwk(value: unknown): value is JsonWebKey {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kty' in value &&
    !(value instanceof Uint8Array) &&
    !(value instanceof KeyObject)
  );
}
