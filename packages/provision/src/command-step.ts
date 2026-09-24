import { ComputeError, type Json, type ProfileDocument, type SqlTx, type StepContext } from '@better-compute/core';
import { stepNotReady } from './engine.js';

// Control-plane steps that drive agents: a step that needs data only the control plane has (a
// BMC address, a resolved image, a join token) builds the command itself, sends it and waits for
// it. The step re-runs until the command settles; every run finds the same command by its
// idempotency key, so a crash or a re-run never sends it twice.

/** How often a waiting command step looks again. */
export const commandStepPollMs = 2_000;

export interface AwaitCommandOptions {
  /** The agent that runs it: the target node, or a site agent (`siteAgentFor`). */
  nodeId: string;
  kind: string;
  payload: Json;
  /** Distinguishes several commands of one step (`boot`, `power`, …). */
  key?: string;
  /** How long the command may live; defaults to the step's remaining time. */
  timeoutMs?: number;
}

export interface CommandOutcome {
  commandId: string;
  /** The raw result the agent reported (`CommandUpdate.result`), if any. */
  result: Uint8Array | null;
  /** The result was node-signed and verified on ingest (`commands.attested`). */
  attested: boolean;
}

/** The idempotency key of one command of a step attempt: `wf:<id>:<step>#<attempt>[:<key>]`. */
export function stepCommandKey(context: Pick<StepContext, 'idempotencyKey' | 'attempt'>, key?: string): string {
  return `${context.idempotencyKey}#${context.attempt}${key ? `:${key}` : ''}`;
}

/**
 * Sends a command once per step attempt and returns its outcome once it succeeded. Until then it
 * throws `stepNotReady`, so the engine runs the step again later; a command that failed, was
 * rejected, expired or was cancelled throws `DRIVER_ERROR` with its reason.
 */
export async function awaitCommand(context: StepContext, options: AwaitCommandOptions): Promise<CommandOutcome> {
  const key = stepCommandKey(context, options.key);
  const outcome = await context.sql.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string; state: string; reason: string | null; result: Uint8Array | null; attested: boolean }>(
      'SELECT id, state, reason, result, attested FROM commands WHERE node_id = $1 AND idempotency_key = $2',
      [options.nodeId, key],
    );
    const existing = rows[0];
    if (existing) return existing;
    const now = await tx.query<{ now: Date }>('SELECT compute_now() AS now');
    await context.commands.enqueue(tx, {
      nodeId: options.nodeId,
      kind: options.kind,
      payload: options.payload,
      idempotencyKey: key,
      notAfter: now.rows[0]!.now.getTime() + (options.timeoutMs ?? 10 * 60_000),
    });
    return undefined;
  });
  if (!outcome || ['pending', 'dispatched', 'acked', 'running'].includes(outcome.state)) throw stepNotReady(commandStepPollMs);
  if (outcome.state === 'succeeded')
    return { commandId: outcome.id, result: outcome.result ? new Uint8Array(outcome.result) : null, attested: outcome.attested };
  throw new ComputeError('DRIVER_ERROR', `${options.kind} ${outcome.state}${outcome.reason ? `: ${outcome.reason}` : ''}`, undefined, {
    commandId: outcome.id,
    state: outcome.state,
  });
}

/** The profile document a workflow was started with, and its tenant and node. */
export async function workflowProfile(
  tx: SqlTx,
  workflowId: string,
): Promise<{ tenantId: string; nodeId?: string; profile: ProfileDocument } | undefined> {
  const { rows } = await tx.query<{ tenant_id: string; node_id: string | null; profile_document: ProfileDocument | null }>(
    'SELECT tenant_id, node_id, profile_document FROM workflows WHERE id = $1',
    [workflowId],
  );
  const row = rows[0];
  if (!row?.profile_document) return undefined;
  return { tenantId: row.tenant_id, ...(row.node_id ? { nodeId: row.node_id } : {}), profile: row.profile_document };
}
