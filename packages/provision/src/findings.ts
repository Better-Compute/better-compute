import type { Finding, SqlExecutor } from '@better-compute/core';

// `doctor` findings for the workflow engine (PLAN.md §14 "workers: lease health, stuck queues").

/**
 * - `workflows-stuck`: active workflows whose in-flight step is past its deadline by more than
 *   `graceSeconds` (default 300). The engine fails an overdue step the next time it looks, so these
 *   mean nobody is running the `workflow` reconciler for their key.
 * - `workflows-failed`: workflows that failed in the last day (info, for the operator's queue).
 */
export async function provisionFindings(sql: SqlExecutor, options: { graceSeconds?: number } = {}): Promise<Finding[]> {
  const findings: Finding[] = [];
  const { rows: stuck } = await sql.query<{ n: string; oldest: string | null }>(
    `SELECT count(DISTINCT w.id)::text AS n, min(w.id) AS oldest
       FROM workflows w JOIN workflow_steps s ON s.workflow_id = w.id AND s.state IN ('running', 'waiting')
      WHERE w.state IN ('running', 'paused') AND s.deadline < compute_now() - make_interval(secs => $1)`,
    [options.graceSeconds ?? 300],
  );
  const stuckCount = Number(stuck[0]?.n ?? 0);
  if (stuckCount)
    findings.push({
      check: 'workflows-stuck',
      severity: 'warning',
      message: `${stuckCount} workflows have a step past its deadline (oldest ${stuck[0]!.oldest}): no worker is advancing them`,
      fix: 'Run a worker with the provision module (its `workflow` reconciler); check shard leases and the work queue',
      count: stuckCount,
    });
  const { rows: failed } = await sql.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM workflows WHERE state = 'failed' AND finished_at > compute_now() - interval '1 day'`,
  );
  const failedCount = Number(failed[0]?.n ?? 0);
  if (failedCount)
    findings.push({
      check: 'workflows-failed',
      severity: 'info',
      message: `${failedCount} workflows failed in the last day`,
      fix: 'Inspect them with workflows.list/get; retry with workflows.retry (fromStep) once the cause is fixed',
      count: failedCount,
    });
  return findings;
}
