import type { KeyObject } from 'node:crypto';
import { create, type MessageInitShape } from '@bufbuild/protobuf';
import type { NodeAttestor } from '@better-compute/core';
import {
  createCsr,
  generateP256KeyPair,
  openJoinResponse,
  sealJoinToken,
  sha256,
  type SignerTrust,
} from '@better-compute/pki';
import {
  AgentRole,
  HardwareClaimsSchema,
  JoinRequestSchema,
  type JoinRequest,
  type JoinResponse,
  type JoinResponseBody,
} from '@better-compute/protocol';

/**
 * The agent's Join loop, as bcd runs it (PLAN.md §3.3, two-round joins): one key and CSR for the
 * whole exchange; a `pending` deferral waits `retry_after_seconds` (on the caller's clock) and
 * re-sends the same request; a `challenge` asks the attestor to answer it and re-sends with the
 * answer in `attestation`. Every response is checked against the pinned signing key and the CSR
 * before anything in it is used; a deferral is never taken for a join.
 */
export interface AgentJoinOptions {
  /** Sends a JoinRequest over whatever transport the test uses (gateway h2c, JoinService direct). */
  send(request: JoinRequest): Promise<JoinResponse>;
  signer: SignerTrust;
  /** Waits (the sim scheduler in simulations). */
  wait(ms: number): Promise<void>;
  claims: MessageInitShape<typeof HardwareClaimsSchema>;
  role?: AgentRole;
  daemonVersion?: string;
  /** A sealed-token join: the token and the JoinService encryption key. */
  token?: { token: string; joinEncryptionKey: KeyObject; now?: () => number };
  /** The attestor that produces `attestation` (x509pop, cloud-iid, tpm, discovery, …). */
  attestor?: NodeAttestor;
  /** Reuse a key (x509pop proves the old one; the new cert certifies this one). */
  privateKey?: KeyObject;
  nodeCaRoots?: readonly Uint8Array[];
  now?: () => number;
  /** Maximum requests before giving up (default 20). */
  maxRounds?: number;
  /** Called on every deferral, for tests. */
  onDeferral?(deferral: { kind: 'pending' | 'challenge'; requestId?: string }): void;
}

export interface AgentJoinResult {
  body: JoinResponseBody;
  privateKey: KeyObject;
  csr: Uint8Array;
  rounds: number;
}

export async function runAgentJoin(options: AgentJoinOptions): Promise<AgentJoinResult> {
  const privateKey = options.privateKey ?? generateP256KeyPair().privateKey;
  const csr = createCsr(privateKey);
  const csrSha256 = sha256(csr);
  const maxRounds = options.maxRounds ?? 20;
  let challenge: Uint8Array | undefined;
  for (let round = 1; round <= maxRounds; round++) {
    const attestation = options.attestor
      ? (
          await options.attestor.produce({
            claims: {},
            // Attestors that bind to the request (x509pop, tpm) get sha256(csr).
            nonce: csrSha256,
            ...(challenge ? { challenge } : {}),
          })
        ).payload
      : undefined;
    const request = create(JoinRequestSchema, {
      csr,
      claims: create(HardwareClaimsSchema, options.claims),
      daemonVersion: options.daemonVersion ?? '0.2.0',
      role: options.role ?? AgentRole.NODE,
      ...(options.attestor ? { attestor: options.attestor.id } : {}),
      ...(attestation ? { attestation } : {}),
      ...(options.token
        ? {
            // Re-sealed every round: the seal's iat must stay fresh; the token itself is unchanged.
            sealedToken: new TextEncoder().encode(
              sealJoinToken(options.token.token, options.token.joinEncryptionKey, {
                csr,
                issuedAt: (options.token.now ?? options.now ?? Date.now)(),
              }),
            ),
          }
        : {}),
    });
    const opened = openJoinResponse(await options.send(request), {
      signer: options.signer,
      csr,
      ...(options.nodeCaRoots ? { nodeCaRoots: options.nodeCaRoots } : {}),
      now: (options.now ?? Date.now)(),
    });
    if (opened.kind === 'joined') return { body: opened.body, privateKey, csr, rounds: round };
    if (opened.kind === 'pending') {
      options.onDeferral?.({ kind: 'pending', requestId: opened.requestId });
      challenge = undefined;
      await options.wait(opened.retryAfterSeconds * 1000);
    } else {
      options.onDeferral?.({ kind: 'challenge' });
      if (!options.attestor || opened.attestor !== options.attestor.id)
        throw new Error(`Join challenge for attestor ${opened.attestor}, which this agent does not run`);
      challenge = opened.payload;
    }
  }
  throw new Error(`Join did not complete in ${maxRounds} rounds`);
}
