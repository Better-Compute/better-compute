import type {
  ComputeModule,
  Finding,
  ModuleContext,
  SqlExecutor,
  SqlTx,
} from '@better-compute/core';
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
  return findings;
}

/**
 * Checks a deployment for problems an operator should act on: the merged catalog and the §9.2
 * table, the schema and `btree_gist`, `compute_now()` against the database clock, and every
 * module's own `selfCheck`. It only reads.
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
