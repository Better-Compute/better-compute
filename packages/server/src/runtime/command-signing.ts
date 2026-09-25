import { toBinary } from '@bufbuild/protobuf';
import { ComputeError, systemClock, type Clock } from '@better-compute/core';
import {
  signTrustBundle,
  type CommandSigningAuthority,
  type SigningKey,
  type WorkerSigningKey,
} from '@better-compute/pki';
import { SignatureSchema, type SignedTrustBundle } from '@better-compute/protocol';

// Signed intent (PLAN.md §6 "Checks before accepting", §13; v0.2): every command the queue
// writes carries a worker signature (purpose `command`, parts [Command.body]) so a gateway can
// neither forge nor alter one (P14). Daemons require it for the kinds their own table marks
// destructive, and check it whenever present. Worker keys are certified by the command-signing
// root for at most 24 h and replaced well before they expire.

export interface CommandSigner {
  /** `commands.signature`: an encoded `Signature` over the encoded CommandBody. */
  sign(body: Uint8Array): Uint8Array;
  /** The root certificates daemons must trust (TrustBundle.command_signing_roots). */
  readonly roots: readonly Uint8Array[];
}

export interface CommandSignerOptions {
  /** The command-signing root (pki `createCommandSigningAuthority`; KMS-backed in production). */
  authority: Pick<CommandSigningAuthority, 'certificate' | 'issueWorkerKey'>;
  /** This process's id in the worker certificate's subject. */
  workerId: string;
  clock?: Clock;
  /** Worker key lifetime (default and maximum 24 h). */
  keyTtlSeconds?: number;
  /** Replace the key once this fraction of its lifetime has passed (default 0.6). */
  renewAt?: number;
  /**
   * Roots still trusted during a rotation (§13: add the new root first, switch after every daemon
   * acknowledged it, then drop the old). Listed after the authority's own root.
   */
  additionalRoots?: readonly Uint8Array[];
}

export function createCommandSigner(options: CommandSignerOptions): CommandSigner {
  const clock = options.clock ?? systemClock;
  const ttl = Math.min(options.keyTtlSeconds ?? 86_400, 86_400);
  const renewAt = options.renewAt ?? 0.6;
  let key: WorkerSigningKey | undefined;
  let issuedAt = 0;
  const current = (): SigningKey => {
    const now = clock.now();
    if (!key || now - issuedAt >= (key.notAfter - issuedAt) * renewAt || now >= key.notAfter) {
      key = options.authority.issueWorkerKey({ workerId: options.workerId, ttlSeconds: ttl });
      issuedAt = now;
      if (key.notAfter <= now)
        throw new ComputeError('INVALID_STATE', 'The command-signing root has expired');
    }
    return key;
  };
  return {
    sign(body) {
      return toBinary(SignatureSchema, current().sign('command', [body]));
    },
    roots: [options.authority.certificate, ...(options.additionalRoots ?? [])],
  };
}

/**
 * The trust bundle daemons get in `JoinResponse.trust` (unsigned: the whole response is signed) and
 * in `Welcome.trust` (signed here with the JoinService signing key, purpose `trust-bundle`, so a
 * gateway can relay it but not alter it). Bump `version` on every change of the roots.
 */
export function commandTrustBundle(
  signer: Pick<CommandSigner, 'roots'>,
  version: bigint,
  joinSigningKey?: SigningKey,
): { version: bigint; commandSigningRoots: Uint8Array[]; signed?: SignedTrustBundle } {
  const bundle = { version, commandSigningRoots: [...signer.roots] };
  return joinSigningKey ? { ...bundle, signed: signTrustBundle(bundle, joinSigningKey) } : bundle;
}
