import { createHash } from 'node:crypto';
import type { SqlTx } from '@better-compute/core';
import { CommandState, commandUpdateSigningInput } from '@better-compute/protocol';
import type { AttestationVerifier } from './steps.js';

// Node-signed results (PLAN.md §6, §13, P14): a wipe or diagnostics result counts only when the node
// itself signed it. The gateway relays `CommandUpdate.node_sig` and stores it as received
// (`commands.result_sig_kid`, `result_sig`, core/0012). It is never trusted to judge it: the worker
// rebuilds the signing input from the stored row (command id, SUCCEEDED, sha256 of the stored result)
// and checks the signature against the node's certificates. A result the gateway altered, one with no
// signature, and one signed by another node's key all fail. So does every result when no check is
// configured (fail closed).

/**
 * The cryptographic check, supplied by the host: pki's `verifyNodeStatement(input, { kid, sig },
 * { nodeId, lookup: nodeCertsLookup(tx), now })`, answering false instead of throwing.
 */
export type NodeSignatureCheck = (
  tx: SqlTx,
  statement: { nodeId: string; input: Uint8Array; kid: string; sig: Uint8Array },
) => Promise<boolean>;

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
 * An `AttestationVerifier` that accepts a result only with a valid node signature over it.
 * Without `check`, nothing is attested.
 */
export function nodeSignedResults(check?: NodeSignatureCheck): AttestationVerifier {
  return async (tx, outcome) => {
    if (!check) return false;
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
