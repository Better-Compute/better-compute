import { createHash } from 'node:crypto';
import type { SqlTx } from '@better-compute/core';
import { nodeCertsLookup, verifyNodeStatement } from '@better-compute/pki';
import { CommandState, commandUpdateSigningInput, type Signature } from '@better-compute/protocol';
import type { AttestationVerifier } from './steps.js';

// Node-signed results (PLAN.md §6, §13, P14): a wipe or diagnostics result counts only when the node
// itself signed it. The gateway relays `CommandUpdate.node_sig` and stores it as received
// (`commands.result_sig_kid`, `result_sig`, core/0012). It is never trusted to judge it: the worker
// rebuilds the signing input from the stored row (command id, SUCCEEDED, sha256 of the stored result)
// and checks the signature against the node's certificates (pki). A result the gateway altered, one
// with no signature, and one signed by another node's key or a revoked certificate all fail.

/** The cryptographic check of a node statement; false (never a throw) when it does not hold. */
export type NodeSignatureCheck = (
  tx: SqlTx,
  statement: { nodeId: string; input: Uint8Array; kid: string; sig: Uint8Array },
) => Promise<boolean>;

/**
 * The default check: pki's `verifyNodeStatement` over `node_certs` (the key the kid names, of that
 * node, not revoked, within validity plus pki's offline grace). `now` defaults to the system clock.
 */
export function pkiNodeSignatureCheck(options: { now?: () => number } = {}): NodeSignatureCheck {
  return async (tx, statement) => {
    const signature = { $typeName: 'bettercompute.common.v1.Signature', kid: statement.kid, sig: statement.sig } as Signature;
    try {
      await verifyNodeStatement(statement.input, signature, {
        nodeId: statement.nodeId,
        lookup: nodeCertsLookup(tx),
        now: options.now?.() ?? Date.now(),
      });
      return true;
    } catch {
      return false;
    }
  };
}

interface SignedRow {
  node_id: string;
  state: string;
  result: Uint8Array | null;
  result_sig_kid: string | null;
  result_sig: Uint8Array | null;
}

/** The signing input of a succeeded command's stored result, as the daemon signed it. */
export function resultSigningInput(commandId: string, result: Uint8Array | null): Uint8Array {
  return commandUpdateSigningInput({
    commandId,
    state: CommandState.SUCCEEDED,
    resultSha256: new Uint8Array(createHash('sha256').update(result ?? new Uint8Array(0)).digest()),
  });
}

/**
 * An `AttestationVerifier` that accepts a result only with a valid node signature over it; metal's
 * default, with `pkiNodeSignatureCheck()`.
 */
export function nodeSignedResults(check: NodeSignatureCheck = pkiNodeSignatureCheck()): AttestationVerifier {
  return async (tx, outcome) => {
    const { rows } = await tx.query<SignedRow>(
      'SELECT node_id, state, result, result_sig_kid, result_sig FROM commands WHERE id = $1',
      [outcome.commandId],
    );
    const row = rows[0];
    if (!row || row.state !== 'succeeded' || !row.result_sig_kid || !row.result_sig) return false;
    const stored = row.result === null ? null : new Uint8Array(row.result);
    // What the step decodes must be exactly what was signed.
    const decoded = outcome.result ?? null;
    if ((stored === null) !== (decoded === null) || (stored && decoded && Buffer.compare(Buffer.from(stored), Buffer.from(decoded)) !== 0))
      return false;
    try {
      return await check(tx, {
        nodeId: row.node_id,
        input: resultSigningInput(outcome.commandId, stored),
        kid: row.result_sig_kid,
        sig: new Uint8Array(row.result_sig),
      });
    } catch {
      return false;
    }
  };
}
