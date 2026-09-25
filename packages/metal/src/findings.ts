import type { Finding, SqlExecutor } from '@better-compute/core';
import { workflowStates } from './profiles.js';

// `doctor` findings for bare metal (PLAN.md §14 "fleet").

/**
 * - `metal-failed`: machines in `failed` with maintenance on, waiting for an operator (`recover`
 *   or `retire`), with their failure codes.
 * - `metal-stalled`: machines in a workflow-driven state for more than `graceSeconds` (default 600)
 *   without an active workflow: nobody runs the `metal` reconciler for them.
 */
export async function metalFindings(sql: SqlExecutor, options: { graceSeconds?: number } = {}): Promise<Finding[]> {
  const findings: Finding[] = [];
  const { rows: failed } = await sql.query<{ n: string; codes: string[] | null }>(
    `SELECT count(*)::text AS n, array_agg(DISTINCT coalesce(m.last_error->>'code', 'unknown')) AS codes
       FROM metal_nodes m JOIN nodes n ON n.id = m.node_id
      WHERE n.provision_state = 'failed' AND n.maintenance AND n.deleted_at IS NULL`,
  );
  const failedCount = Number(failed[0]?.n ?? 0);
  if (failedCount)
    findings.push({
      check: 'metal-failed',
      severity: 'warning',
      message: `${failedCount} bare-metal machines failed and wait in maintenance (${(failed[0]!.codes ?? []).sort().join(', ')})`,
      fix: 'Read metal_nodes.last_error (metal.get), fix the cause, then metal.recover, or metal.retire the machine',
      count: failedCount,
    });
  const { rows: stalled } = await sql.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM metal_nodes m JOIN nodes n ON n.id = m.node_id
      WHERE n.provision_state = ANY($1::text[]) AND n.deleted_at IS NULL
        AND m.updated_at < compute_now() - make_interval(secs => $2)
        AND NOT EXISTS (SELECT 1 FROM workflows w WHERE w.id = m.workflow_id AND w.state IN ('pending', 'running', 'paused'))
        -- A rescued machine rests in rescue once its rescue workflow succeeded.
        AND NOT (n.provision_state = 'rescue'
                 AND COALESCE((SELECT w.state FROM workflows w WHERE w.id = m.workflow_id), 'succeeded') = 'succeeded')`,
    [[...workflowStates], options.graceSeconds ?? 600],
  );
  const stalledCount = Number(stalled[0]?.n ?? 0);
  if (stalledCount)
    findings.push({
      check: 'metal-stalled',
      severity: 'warning',
      message: `${stalledCount} bare-metal machines sit in a workflow-driven state without an active workflow`,
      fix: 'Run a worker with metal() and the provision module; the metal reconciler starts or settles their workflows',
      count: stalledCount,
    });
  return findings;
}
