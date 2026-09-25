import { sign, verify, type KeyObject } from 'node:crypto';
import { timestampFromMs, timestampMs, type Timestamp } from '@bufbuild/protobuf/wkt';
import { ComputeError, type AgentRole } from '@better-compute/core';
import { renewPopSigningInput } from '@better-compute/protocol';
import { parseCsr, type ParsedCsr } from './csr.js';
import { base64url, sha256 } from './keys.js';
import type { RevocationSet } from './revocation.js';
import { parseNodeSpiffeId } from './spiffe.js';
import { verifyCertificateChain, type ParsedCertificate } from './x509.js';

/** `RenewRequest.client_time` is accepted within this distance of server time. */
export const renewPopWindowMs = 60_000;
/** A PoP is remembered this long, which outlasts the window on both sides. */
export const renewPopReplayTtlMs = 120_000;

/**
 * Remembers proofs already accepted. Keyed by the signed statement (CSR hash, node, client time),
 * not the signature bytes: an ECDSA signature has a second valid form `(r, n − s)`, so keying by
 * signature would let a relay replay a proof by flipping `s`.
 */
export interface ReplayCache {
  /** Records `key` until `expiresAt`; false when it is already present and unexpired. */
  add(key: string, expiresAt: number, now: number): boolean;
  readonly size: number;
}

/**
 * An in-memory replay cache bounded to `maxEntries` (default 100 000). Expired entries go first.
 * When it is still full of live entries, `whenFull: 'evict'` (default) drops the oldest live one,
 * which makes that key replayable until it expires; `'refuse'` fails closed instead: `add` answers
 * false (treated as a replay) until entries expire. Single-use credentials (exec tickets) refuse.
 */
export function createReplayCache(
  options: { maxEntries?: number; whenFull?: 'evict' | 'refuse' } = {},
): ReplayCache {
  const maxEntries = options.maxEntries ?? 100_000;
  const refuse = options.whenFull === 'refuse';
  const entries = new Map<string, number>();
  return {
    add(key, expiresAt, now) {
      const existing = entries.get(key);
      if (existing !== undefined && existing > now) return false;
      entries.delete(key);
      for (const [stored, expiry] of entries) {
        // Insertion order approximates expiry order; stop at the first live entry.
        if (expiry > now && (refuse || entries.size < maxEntries)) break;
        entries.delete(stored);
      }
      if (refuse && entries.size >= maxEntries) {
        // Purge every expired entry (not only a leading run) before refusing.
        for (const [stored, expiry] of entries) if (expiry <= now) entries.delete(stored);
        if (entries.size >= maxEntries) return false;
      }
      entries.set(key, expiresAt);
      return true;
    },
    get size() {
      return entries.size;
    },
  };
}

export interface RenewPopRequest {
  /** DER PKCS#10 for the next certificate. */
  csr: Uint8Array;
  /** The current certificate chain, leaf first. */
  chain: readonly Uint8Array[];
  clientTime: Timestamp | number;
  /** Raw `r ‖ s` by the current node key over `renew-pop` [sha256(csr), node_id, client_time]. */
  popSig: Uint8Array;
}

export interface VerifyRenewPopOptions {
  /** Server time (`compute_now()`), epoch milliseconds. */
  now: number;
  /** Node-CA certificates the current leaf must chain to. */
  nodeCaRoots: readonly Uint8Array[];
  replayCache: ReplayCache;
  revocations?: RevocationSet;
  /** When the session knows the node, the certificate must be that node's. */
  expectedNodeId?: string;
  windowMs?: number;
}

export interface RenewPopResult {
  nodeId: string;
  siteId: string;
  trustDomain: string;
  role: AgentRole | 'node-tenant';
  /** The current certificate. */
  current: ParsedCertificate;
  /** The verified request for the next certificate. */
  csr: ParsedCsr;
  /** Whether the next certificate keeps the current key. */
  sameKey: boolean;
}

/**
 * Verifies a `RenewRequest` end to end, as `api` does (a gateway only relays it): the current
 * chain to the node CA at `now`, the leaf not revoked, its SPIFFE identity, the new CSR's
 * self-signature, the proof by the *current* key, the ±60 s window and the replay cache (checked
 * last, so a rejected request never burns a cache slot). Throws `ACCESS_DENIED` with a reason.
 */
export function verifyRenewPop(
  request: RenewPopRequest,
  options: VerifyRenewPopOptions,
): RenewPopResult {
  const deny = (reason: string) =>
    new ComputeError('ACCESS_DENIED', 'Renew refused', undefined, { reason });
  const clientTimeMs =
    typeof request.clientTime === 'number' ? request.clientTime : timestampMs(request.clientTime);
  const clientTime =
    typeof request.clientTime === 'number'
      ? timestampFromMs(request.clientTime)
      : request.clientTime;
  if (!Number.isFinite(clientTimeMs)) throw deny('bad client time');
  const window = options.windowMs ?? renewPopWindowMs;
  if (Math.abs(clientTimeMs - options.now) > window) throw deny('client time outside the window');
  if (!(request.popSig instanceof Uint8Array) || request.popSig.length !== 64)
    throw deny('malformed proof');

  let path: ParsedCertificate[];
  try {
    path = verifyCertificateChain(request.chain, options.nodeCaRoots, {
      now: options.now,
      usage: 'client',
    });
  } catch (error) {
    throw deny(
      error instanceof ComputeError && typeof error.details?.reason === 'string'
        ? error.details.reason
        : 'bad chain',
    );
  }
  const leaf = path[0]!;
  if (options.revocations?.has(leaf.serial)) throw deny('certificate revoked');
  const identity = leaf.uriSans.length === 1 ? parseNodeSpiffeId(leaf.uriSans[0]!) : undefined;
  if (!identity) throw deny('certificate has no node identity');
  if (options.expectedNodeId !== undefined && identity.nodeId !== options.expectedNodeId)
    throw deny('certificate is for another node');
  const role = leaf.role;
  if (role !== 'node' && role !== 'site' && role !== 'ramdisk' && role !== 'node-tenant')
    throw deny('certificate has no agent role');

  let csr: ParsedCsr;
  try {
    csr = parseCsr(request.csr);
  } catch {
    throw deny('bad CSR');
  }
  const statement = renewPopSigningInput({
    csrSha256: csr.sha256,
    nodeId: identity.nodeId,
    clientTime,
  });
  if (!verifyStatement(leaf.publicKey, statement, request.popSig)) throw deny('bad proof');
  const replayKey = base64url(sha256(statement));
  if (!options.replayCache.add(replayKey, options.now + renewPopReplayTtlMs, options.now))
    throw deny('replayed proof');
  return {
    nodeId: identity.nodeId,
    siteId: identity.siteId,
    trustDomain: identity.trustDomain,
    role,
    current: leaf,
    csr,
    sameKey: csr.publicKey.equals(leaf.publicKey),
  };
}

/**
 * The agent side (Go in `bcd`; TS for `FakeDaemon`): signs `renew-pop` over
 * [sha256(csr), node_id, client_time] with the *current* node key.
 */
export function signRenewPop(input: {
  csr: Uint8Array;
  nodeId: string;
  clientTime: number;
  privateKey: KeyObject;
}): { popSig: Uint8Array; clientTime: Timestamp } {
  const clientTime = timestampFromMs(input.clientTime);
  const statement = renewPopSigningInput({
    csrSha256: sha256(input.csr),
    nodeId: input.nodeId,
    clientTime,
  });
  return { popSig: signStatement(input.privateKey, statement), clientTime };
}

// renewPopSigningInput already applies the purpose framing, so these sign and verify its bytes as is.
function signStatement(privateKey: KeyObject, statement: Uint8Array): Uint8Array {
  return new Uint8Array(sign('sha256', statement, { key: privateKey, dsaEncoding: 'ieee-p1363' }));
}

function verifyStatement(
  publicKey: KeyObject,
  statement: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    return verify('sha256', statement, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    return false;
  }
}
