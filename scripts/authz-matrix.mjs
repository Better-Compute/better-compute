// Checks the server's method → action registry against PLAN.md §9.2 (core's `apiSurface`) and
// the merged IAM catalog, and prints the matrix.
//
//   node scripts/authz-matrix.mjs
//
// Reads the built packages: run `tsc -b packages/server` first. It builds a server with the
// built-in modules only (construction touches neither a store nor IAM) and fails when:
// - a registered method is undeclared: not in the §9.2 table and not a plugin's;
// - a registered method is uncatalogued: its action is missing from the merged IAM catalog;
// - a registered method disagrees with its §9.2 row on action, kind or resource;
// - a §9.2 row names an action the merged catalog lacks.
// P0 reports; v0.1 (W4) generates tests/generated/authz-matrix.test.ts with one test per row: the
// declared action and resource, cross-tenant denial, guardrail denial and list fail-closed.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './tooling.mjs';

const dist = (name) => join(root, 'packages', name, 'dist', 'index.js');
for (const name of ['core', 'server'])
  if (!existsSync(dist(name))) {
    console.error(`packages/${name}/dist is missing; run: pnpm exec tsc -b packages/server`);
    process.exit(1);
  }
const { apiSurface } = await import(pathToFileURL(dist('core')).href);
const { betterCompute } = await import(pathToFileURL(dist('server')).href);

const refuse = () => Promise.reject(new Error('authz-matrix never calls the store or IAM'));
const compute = betterCompute({
  database: {
    dialect: 'postgres',
    kind: 'pglite',
    query: refuse,
    transaction: refuse,
    migrate: refuse,
    close: refuse,
  },
  iam: {
    authenticate: refuse,
    require: refuse,
    authorize: refuse,
    authorizeMany: refuse,
    requestConfirmation: refuse,
    billingCheck: refuse,
    recordUsage: refuse,
    featureEnabled: refuse,
    capabilities: () => ({
      pluginResolver: false,
      eventDetail: false,
      evaluate: false,
      readOnlyDecisions: false,
    }),
  },
  secret: 'authz-matrix-placeholder-secret-0123456789',
  baseURL: 'http://localhost',
  rootTenantId: 'root',
});
const { registry } = compute;

const problems = registry.problems().map((problem) => `${problem.kind}: ${problem.message}`);
for (const row of apiSurface)
  if (row.action !== null && !registry.actions.has(row.action))
    problems.push(
      `uncatalogued row: ${row.group}.${row.method} names ${row.action}, missing from the catalog`,
    );

const target = (row) => {
  if (row.action === null) return 'public';
  const pairs = [{ action: row.action, resource: row.resource }, ...(row.alternatives ?? [])];
  const text = pairs.map(({ action, resource }) => `${action} @ compute-${resource}`).join(' | ');
  return row.list ? `${text} + items` : text;
};
const lines = apiSurface.map((row) => {
  const registered = registry.method(`${row.group}/${row.method}`) ? 'registered' : 'planned';
  return [registered, row.phase, row.kind, `${row.group}.${row.method}`, target(row)];
});
const plugins = registry.methods.filter((method) => method.plugin);
for (const method of plugins)
  lines.push(['registered', '-', method.kind, method.path, method.action ?? 'public']);
const widths = lines[0].map((_, column) => Math.max(...lines.map((line) => line[column].length)));
for (const line of lines)
  console.log(
    line
      .map((cell, column) => cell.padEnd(widths[column]))
      .join('  ')
      .trimEnd(),
  );

const registeredRows = apiSurface.filter((row) => registry.method(`${row.group}/${row.method}`));
const v01 = apiSurface.filter((row) => row.phase === 'v0.1');
console.log(
  `\n${registeredRows.length} of ${apiSurface.length} §9.2 methods registered (${v01.length} are v0.1); ` +
    `${plugins.length} plugin methods; ${registry.actions.size} catalog actions.`,
);
if (problems.length) {
  for (const problem of problems) console.error(problem);
  console.error(`${problems.length} authorization matrix problem(s); see PLAN.md §9.2 and §12.3.`);
  process.exitCode = 1;
} else console.log('Every registered method is declared and catalogued, and agrees with §9.2.');
