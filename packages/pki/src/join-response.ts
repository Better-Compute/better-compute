import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { ComputeError, type AgentRole } from '@better-compute/core';
import {
  AgentRole as WireAgentRole,
  JoinResponseBodySchema,
  JoinResponseSchema,
  SignedTrustBundleSchema,
  TrustBundleSchema,
  type JoinResponse,
  type JoinResponseBody,
  type SignedTrustBundle,
  type TrustBundle,
} from '@better-compute/protocol';
import { parseCsr } from './csr.js';
import { sha256, timingSafeEqualBytes } from './keys.js';
import { parseNodeSpiffeId } from './spiffe.js';
import { verifySignature, type SignerTrust, type SigningKey } from './signing.js';
import { parseCertificate, verifyCertificateChain } from './x509.js';

const toWireRole: Readonly<Record<AgentRole, WireAgentRole>> = {
  node: WireAgentRole.NODE,
  site: WireAgentRole.SITE,
  ramdisk: WireAgentRole.RAMDISK,
};

export function wireAgentRole(role: AgentRole): WireAgentRole {
  const wire = toWireRole[role];
  if (wire === undefined) throw new ComputeError('INVALID_INPUT', `Unknown agent role ${role}`);
  return wire;
}

export function agentRoleFromWire(role: WireAgentRole): AgentRole | undefined {
  return (Object.keys(toWireRole) as AgentRole[]).find((key) => toWireRole[key] === role);
}

export interface TrustBundleInput {
  version: bigint | number;
  /** DER roots certifying worker command-signing keys (empty in v0.1). */
  commandSigningRoots?: readonly Uint8Array[];
}

export interface JoinResponseInput {
  nodeId: string;
  /** DER, leaf first. */
  certChain: readonly Uint8Array[];
  /** The join request's CSR (DER), or its SHA-256. */
  csr: Uint8Array | { sha256: Uint8Array };
  trustDomain: string;
  siteId: string;
  role: AgentRole;
  /** Server time at issue, epoch milliseconds. */
  issuedAt: number;
  trust?: TrustBundleInput;
}

function trustBundle(input: TrustBundleInput | undefined): TrustBundle {
  return create(TrustBundleSchema, {
    version: BigInt(input?.version ?? 0),
    commandSigningRoots: [...(input?.commandSigningRoots ?? [])],
  });
}

/**
 * Builds `JoinResponse{body, sig}`: the serialized `JoinResponseBody`, signed by the JoinService
 * signing key for purpose `join-response`. A gateway relaying it cannot alter the node id, chain or
 * trust bundle, and the body names the CSR it answers.
 */
export function signJoinResponse(input: JoinResponseInput, key: SigningKey): JoinResponse {
  const csrSha256 = input.csr instanceof Uint8Array ? sha256(input.csr) : input.csr.sha256;
  if (csrSha256.length !== 32)
    throw new ComputeError('INVALID_INPUT', 'csr sha256 must be 32 bytes');
  if (input.certChain.length === 0) throw new ComputeError('INVALID_INPUT', 'certChain is empty');
  const body = toBinary(
    JoinResponseBodySchema,
    create(JoinResponseBodySchema, {
      nodeId: input.nodeId,
      certChain: [...input.certChain],
      trust: trustBundle(input.trust),
      csrSha256,
      trustDomain: input.trustDomain,
      siteId: input.siteId,
      role: wireAgentRole(input.role),
      issuedAt: timestampFromMs(input.issuedAt),
    }),
  );
  return create(JoinResponseSchema, { body, sig: key.sign('join-response', [body]) });
}

export interface VerifyJoinResponseOptions {
  /** The pinned JoinService signing key (config `join_signing_key_pin`) or the key itself. */
  signer: SignerTrust;
  /** The CSR the agent sent; the response must answer it. */
  csr: Uint8Array;
  /** When given, the leaf must chain to one of these node-CA certificates at `now`. */
  nodeCaRoots?: readonly Uint8Array[];
  now?: number;
}

/**
 * The agent's check of a `JoinResponse` (bcd does this in Go; `FakeDaemon` and tests use this):
 * the signature under the pinned key, the CSR binding, the leaf's key equal to the CSR's, and the
 * leaf's SPIFFE ID equal to `node_id`, trust domain and site. Throws `ACCESS_DENIED`.
 */
export function verifyJoinResponse(
  response: JoinResponse,
  options: VerifyJoinResponseOptions,
): JoinResponseBody {
  const deny = (reason: string) =>
    new ComputeError('ACCESS_DENIED', 'Join response rejected', undefined, { reason });
  if (!verifySignature('join-response', [response.body], response.sig, options.signer))
    throw deny('bad signature');
  let body: JoinResponseBody;
  try {
    body = fromBinary(JoinResponseBodySchema, response.body);
  } catch {
    throw deny('unreadable body');
  }
  const csr = parseCsr(options.csr);
  if (!timingSafeEqualBytes(body.csrSha256, csr.sha256)) throw deny('response is for another CSR');
  // A deferral is never a join: read it with `openJoinResponse`.
  if (body.deferral?.kind.case !== undefined) throw deny('response is a deferral');
  const leafDer = body.certChain[0];
  if (!leafDer) throw deny('empty certificate chain');
  const leaf = parseCertificate(leafDer);
  if (!leaf.publicKey.equals(csr.publicKey)) throw deny('certificate is for another key');
  const spiffe = leaf.uriSans.length === 1 ? parseNodeSpiffeId(leaf.uriSans[0]!) : undefined;
  if (
    !spiffe ||
    spiffe.nodeId !== body.nodeId ||
    spiffe.trustDomain !== body.trustDomain ||
    spiffe.siteId !== body.siteId
  )
    throw deny('certificate identity does not match the response');
  if (leaf.role !== agentRoleFromWire(body.role)) throw deny('certificate role mismatch');
  if (options.nodeCaRoots)
    verifyCertificateChain(body.certChain, options.nodeCaRoots, {
      now: options.now ?? Date.now(),
      usage: 'client',
    });
  return body;
}

/** What a verified `JoinResponse` says: a certificate, or a signed, CSR-bound deferral. */
export type OpenedJoinResponse =
  | { kind: 'joined'; body: JoinResponseBody }
  | { kind: 'pending'; requestId: string; retryAfterSeconds: number }
  | { kind: 'challenge'; attestor: string; payload: Uint8Array; notAfter?: number };

/**
 * The agent's check of a `JoinResponse` that may be a two-round deferral (§3.3): the signature
 * and CSR binding first, then either the full `verifyJoinResponse` checks or the deferral. A
 * deferral carries no identity; the agent retries `Join` with the SAME CSR (after
 * `retryAfterSeconds`, or answering the challenge in `attestation`). Throws `ACCESS_DENIED`.
 */
export function openJoinResponse(
  response: JoinResponse,
  options: VerifyJoinResponseOptions,
): OpenedJoinResponse {
  const deny = (reason: string) =>
    new ComputeError('ACCESS_DENIED', 'Join response rejected', undefined, { reason });
  if (!verifySignature('join-response', [response.body], response.sig, options.signer))
    throw deny('bad signature');
  let body: JoinResponseBody;
  try {
    body = fromBinary(JoinResponseBodySchema, response.body);
  } catch {
    throw deny('unreadable body');
  }
  if (!timingSafeEqualBytes(body.csrSha256, parseCsr(options.csr).sha256))
    throw deny('response is for another CSR');
  const deferral = body.deferral?.kind;
  if (deferral?.case === undefined)
    return { kind: 'joined', body: verifyJoinResponse(response, options) };
  if (body.nodeId || body.certChain.length > 0) throw deny('a deferral carries no identity');
  if (deferral.case === 'pending')
    return {
      kind: 'pending',
      requestId: deferral.value.requestId,
      retryAfterSeconds: deferral.value.retryAfterSeconds || 30,
    };
  const notAfter = deferral.value.notAfter;
  return {
    kind: 'challenge',
    attestor: deferral.value.attestor,
    payload: deferral.value.payload,
    ...(notAfter
      ? { notAfter: Number(notAfter.seconds) * 1000 + Math.floor(notAfter.nanos / 1e6) }
      : {}),
  };
}

/** A `TrustBundle` signed by the JoinService key (purpose `trust-bundle`), sent in `Welcome`. */
export function signTrustBundle(input: TrustBundleInput, key: SigningKey): SignedTrustBundle {
  const body = toBinary(TrustBundleSchema, trustBundle(input));
  return create(SignedTrustBundleSchema, { body, signature: key.sign('trust-bundle', [body]) });
}

/**
 * Verifies a `SignedTrustBundle`; with `currentVersion`, also refuses a bundle that is not newer.
 * Throws `ACCESS_DENIED`.
 */
export function verifyTrustBundle(
  bundle: SignedTrustBundle,
  signer: SignerTrust,
  currentVersion?: bigint,
): TrustBundle {
  const deny = (reason: string) =>
    new ComputeError('ACCESS_DENIED', 'Trust bundle rejected', undefined, { reason });
  if (!verifySignature('trust-bundle', [bundle.body], bundle.signature, signer))
    throw deny('bad signature');
  let parsed: TrustBundle;
  try {
    parsed = fromBinary(TrustBundleSchema, bundle.body);
  } catch {
    throw deny('unreadable body');
  }
  if (currentVersion !== undefined && parsed.version <= currentVersion) throw deny('not newer');
  return parsed;
}
