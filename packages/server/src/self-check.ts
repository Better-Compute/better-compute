import type {
  ComputeModule,
  Finding,
  ModuleContext,
  SqlExecutor,
  SqlTx,
} from '@better-compute/core';
import { PROTOCOL_VERSION } from '@better-compute/protocol';
import type { Registry } from './registry.js';

/** What `selfCheck()` and `system.selfCheck` return. */
export interface SelfCheckReport {
  /** No `error` findings. */
  ok: boolean;
  findings: Finding[];
}

export interface SelfCheckInput {
  database: SqlExecutor;
  registry: Registry;
  modules: readonly ComputeModule[];
  context: ModuleContext;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function databaseFindings(tx: SqlTx, registry: Registry): Promise<Finding[]> {
  const findings: Finding[] = [];
  const [state] = (
    await tx.query<{ ledger: boolean; btree_gist: boolean; clock: boolean; sim_table: boolean }>(
      `SELECT to_regclass('compute_migrations') IS NOT NULL AS ledger,
              EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') AS btree_gist,
              to_regprocedure('compute_now()') IS NOT NULL AS clock,
              to_regclass('compute_sim_clock') IS NOT NULL AS sim_table`,
    )
  ).rows;
  if (!state?.ledger)
    findings.push({
      check: 'migrations',
      severity: 'error',
      message: 'The database has never been migrated',
      fix: 'Run compute.initialize() (or `better-compute migrate`) against this database',
    });
  else {
    const applied = new Set(
      (await tx.query<{ name: string }>('SELECT name FROM compute_migrations')).rows.map(
        (row) => row.name,
      ),
    );
    const missing = registry.migrations
      .map((migration) => migration.name)
      .filter((name) => !applied.has(name));
    if (![...applied].some((name) => name.startsWith('core/')))
      missing.unshift('the base schema (core/*)');
    if (missing.length)
      findings.push({
        check: 'migrations',
        severity: 'error',
        message: `Migrations not applied: ${missing.join(', ')}`,
        fix: 'Run compute.initialize() with this release and these modules',
        count: missing.length,
      });
  }
  if (!state?.btree_gist)
    findings.push({
      check: 'btree-gist',
      severity: 'error',
      message: 'The btree_gist extension is not installed; booking exclusion constraints need it',
      fix: 'CREATE EXTENSION btree_gist (the base migration does this where the role may)',
    });
  if (state?.clock) {
    const [clock] = (
      await tx.query<{ system: boolean; sim: boolean }>(
        state.sim_table
          ? `SELECT compute_now() = now() AS system, -- check-sql-now: allow
                    EXISTS (SELECT 1 FROM compute_sim_clock WHERE id = 1 AND ts = compute_now()) AS sim`
          : 'SELECT compute_now() = now() AS system, false AS sim -- check-sql-now: allow',
      )
    ).rows;
    if (clock && !clock.system)
      findings.push(
        clock.sim
          ? {
              check: 'clock',
              severity: 'info',
              message: 'compute_now() reads the sim clock (compute_sim_clock)',
              fix: 'Expected in tests and the simulator; restore the system clock in production',
            }
          : {
              check: 'clock',
              severity: 'error',
              message: 'compute_now() does not return the database clock',
              fix: 'Point compute_now() back at the database clock (restoreSystemClock from @better-compute/postgres)',
            },
      );
  }
  if (state?.ledger && !findings.some((finding) => finding.check === 'migrations'))
    findings.push(...(await operationsFindings(tx)));
  return findings;
}

/** The §14 operations checks the store can answer, in one statement; each finding is a warning. */
const operationsQuery = `SELECT
  (SELECT count(*) FROM work_queue w
    WHERE w.not_before < compute_now() - interval '5 minutes'
      AND (w.claimed_until IS NULL OR w.claimed_until < compute_now()))::int AS stuck_work,
  (SELECT count(*) FROM workers wk
    WHERE wk.heartbeat_at > compute_now() - interval '1 minute')::int AS live_workers,
  (SELECT count(*) FROM commands c
    WHERE c.state = 'pending' AND c.not_after < compute_now() - interval '2 minutes')::int AS sweeper_lag,
  (SELECT count(*) FROM usage_dead_letters d WHERE d.resolved_at IS NULL)::int AS usage_dead,
  (SELECT count(*) FROM usage_windows u
    WHERE u.recorded_at IS NULL AND u.voided_at IS NULL
      AND u.window_end < compute_now() - interval '2 hours')::int AS usage_backlog,
  (SELECT count(*) FROM gateways g
    WHERE g.heartbeat_at > compute_now() - interval '1 minute' AND NOT g.draining
      AND g.sessions >= g.max_streams * 0.8)::int AS gateways_full,
  (SELECT count(*) FROM nodes n JOIN node_sessions s ON s.node_id = n.id
    WHERE n.connectivity = 'connected'
      AND s.last_seen < compute_now() - interval '2 minutes')::int AS stale_heartbeats,
  (SELECT count(*) FROM nodes n JOIN node_sessions s ON s.node_id = n.id
    WHERE n.connectivity = 'connected' AND s.proto_max > 0 AND s.proto_max < $1)::int AS old_daemons,
  (SELECT count(*) FROM nodes n
    WHERE n.connectivity = 'connected' AND NOT EXISTS (
      SELECT 1 FROM node_certs k WHERE k.node_id = n.id AND k.revoked_at IS NULL
        AND k.not_after > compute_now() + interval '1 hour'))::int AS expiring_certs`;

interface OperationsRow {
  stuck_work: number;
  live_workers: number;
  sweeper_lag: number;
  usage_dead: number;
  usage_backlog: number;
  gateways_full: number;
  stale_heartbeats: number;
  old_daemons: number;
  expiring_certs: number;
}

async function operationsFindings(tx: SqlTx): Promise<Finding[]> {
  const [row] = (await tx.query<OperationsRow>(operationsQuery, [PROTOCOL_VERSION.min])).rows;
  if (!row) return [];
  const findings: Finding[] = [];
  const warn = (count: number, check: string, text: string, fix: string) => {
    if (count > 0) findings.push({ check, severity: 'warning', message: text, fix, count });
  };
  warn(
    row.stuck_work,
    'workers.queue',
    `${row.stuck_work} work items are more than 5 minutes overdue${row.live_workers === 0 ? ' and no worker is alive' : ''}`,
    'Start worker processes (start({ roles: ["controllers"] })) and check their lease renewals',
  );
  warn(
    row.sweeper_lag,
    'workers.sweeper',
    `${row.sweeper_lag} pending commands are past not_after and not yet expired`,
    'The CommandSweeper runs with the controllers role; check that a worker holds its lease',
  );
  warn(
    row.usage_dead,
    'usage.dead-letters',
    `${row.usage_dead} usage events are dead-lettered`,
    'Inspect usage_dead_letters; re-record them (a closed period needs a root invoice item)',
  );
  warn(
    row.usage_backlog,
    'usage.backlog',
    `${row.usage_backlog} closed usage windows are over 2 hours unrecorded`,
    "Check the IAM bridge's usage flush (worker role iam) before the billing period closes",
  );
  warn(
    row.gateways_full,
    'fleet.gateway-headroom',
    `${row.gateways_full} gateways hold at least 80% of their max streams`,
    'Add a gateway or raise max_streams',
  );
  warn(
    row.stale_heartbeats,
    'fleet.heartbeats',
    `${row.stale_heartbeats} connected nodes sent nothing for over 2 minutes`,
    'Check the gateways those nodes are on and the Liveness sweep',
  );
  warn(
    row.old_daemons,
    'fleet.daemon-skew',
    `${row.old_daemons} connected daemons speak a protocol older than ${PROTOCOL_VERSION.min}`,
    'Roll out a current bcd release (rollouts)',
  );
  warn(
    row.expiring_certs,
    'fleet.cert-expiry',
    `${row.expiring_certs} connected nodes have no certificate valid for another hour`,
    'Renewals are failing: check JoinService renew errors and the node CA',
  );
  return findings;
}

/**
 * Checks a deployment for problems an operator should act on: the merged catalog and the §9.2
 * table, the schema and `btree_gist`, `compute_now()` against the database clock, the §14
 * operations checks (queues, sweeper, usage, gateway headroom, heartbeats, daemon skew, cert
 * expiry), and every module's own `selfCheck`. It only reads.
 */
export function createSelfCheck(input: SelfCheckInput): () => Promise<SelfCheckReport> {
  return async function selfCheck() {
    const findings: Finding[] = input.registry.problems().map((problem) => ({
      check: `catalog.${problem.kind}`,
      severity: problem.kind === 'undeclared' ? 'warning' : 'error',
      message: problem.message,
      fix:
        problem.kind === 'uncatalogued'
          ? "Add the action to the module's or plugin's catalog"
          : problem.kind === 'mismatch'
            ? 'Declare the action, kind and resource PLAN.md §9.2 lists for the method'
            : 'Mount third-party methods as a plugin, or add the method to the §9.2 table',
    }));
    try {
      findings.push(
        ...(await input.database.transaction((tx) => databaseFindings(tx, input.registry), {
          readOnly: true,
        })),
      );
    } catch (error) {
      findings.push({
        check: 'database',
        severity: 'error',
        message: `The database check failed: ${message(error)}`,
        fix: 'Check the database connection and the role compute runs as',
      });
    }
    for (const module of input.modules) {
      if (!module.selfCheck) continue;
      try {
        findings.push(...(await module.selfCheck(input.context)));
      } catch (error) {
        findings.push({
          check: `module.${module.name}`,
          severity: 'error',
          message: `The selfCheck of module ${module.name} failed: ${message(error)}`,
          fix: `Fix the ${module.name} module's selfCheck or its configuration`,
        });
      }
    }
    return { ok: !findings.some((finding) => finding.severity === 'error'), findings };
  };
}
