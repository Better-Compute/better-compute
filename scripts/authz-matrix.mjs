// Checks the server's method → action registry against PLAN.md §9.2 (core's `apiSurface`) and
// the merged IAM catalog, prints the matrix, and generates tests/generated/authz-matrix.test.ts.
//
//   node scripts/authz-matrix.mjs           writes the generated test
//   node scripts/authz-matrix.mjs --check   fails when the generated test is out of date
//
// Reads the built packages: run `tsc -b packages/server` first. It builds a server with the
// built-in modules only (construction touches neither a store nor IAM) and fails when:
// - a registered method is undeclared: not in the §9.2 table and not a plugin's;
// - a registered method is uncatalogued: its action is missing from the merged IAM catalog;
// - a registered method disagrees with its §9.2 row on action, kind or resource;
// - a §9.2 row names an action the merged catalog lacks;
// - a registered v0.1 method has no sample input in tests/support/authz-samples.ts.
// The generated test has one test per registered v0.1 row (tests/support/authz-matrix.ts runs
// it): the declared action and resource are what IAM is asked, a cross-tenant caller is refused
// before any decision or database access, and list-recipe methods fail closed.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import prettier from 'prettier';
import { root } from './tooling.mjs';

const check = process.argv.includes('--check');
const output = join(root, 'tests', 'generated', 'authz-matrix.test.ts');
const samplesFile = join(root, 'tests', 'support', 'authz-samples.ts');

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

const targetsOf = (row) =>
  row.action === null
    ? []
    : [{ action: row.action, resource: row.resource }, ...(row.alternatives ?? [])];
const target = (row) => {
  if (row.action === null) return 'public';
  const text = targetsOf(row)
    .map(({ action, resource }) => `${action} @ compute-${resource}`)
    .join(' | ');
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

// The generated matrix: every registered v0.1 row, each with a sample input.
const covered = apiSurface.filter(
  (row) => row.phase === 'v0.1' && registry.method(`${row.group}/${row.method}`),
);
const samples = new Set(
  [...(await readFile(samplesFile, 'utf8')).matchAll(/^\s*'([A-Za-z]+\.[A-Za-z]+)':/gm)].map(
    (match) => match[1],
  ),
);
for (const row of covered)
  if (!samples.has(`${row.group}.${row.method}`))
    problems.push(
      `unsampled: ${row.group}.${row.method} is registered but has no input in tests/support/authz-samples.ts`,
    );

const rowSource = (row) =>
  `  ${JSON.stringify({
    group: row.group,
    method: row.method,
    kind: row.kind,
    action: row.action,
    targets: targetsOf(row),
    list: row.list === true,
  })},`;
const source = [
  '// Generated by scripts/authz-matrix.mjs from PLAN.md §9.2 (core `apiSurface`) and the method',
  '// registry of @better-compute/server: one test per registered v0.1 method. Do not edit by hand;',
  '// run `node scripts/authz-matrix.mjs` after registering methods (samples: tests/support/authz-samples.ts).',
  "import { describe } from 'vitest';",
  "import { authzMatrix, type MatrixRow } from '../support/authz-matrix.js';",
  '',
  'const rows: MatrixRow[] = [',
  ...covered.map(rowSource),
  '];',
  '',
  "describe('authorization matrix (PLAN.md §9.2, v0.1)', () => authzMatrix(rows));",
  '',
].join('\n');
const config = (await prettier.resolveConfig(output)) ?? {};
const test = await prettier.format(source, { ...config, parser: 'typescript' });

const registeredRows = apiSurface.filter((row) => registry.method(`${row.group}/${row.method}`));
const v01 = apiSurface.filter((row) => row.phase === 'v0.1');
console.log(
  `\n${registeredRows.length} of ${apiSurface.length} §9.2 methods registered (${v01.length} are v0.1, ` +
    `${covered.length} of them registered); ${plugins.length} plugin methods; ${registry.actions.size} catalog actions.`,
);

if (check) {
  const current = existsSync(output) ? await readFile(output, 'utf8') : '';
  if (current.replace(/\r\n/g, '\n') !== test) {
    problems.push(
      'tests/generated/authz-matrix.test.ts is out of date; run: node scripts/authz-matrix.mjs',
    );
  } else console.log('tests/generated/authz-matrix.test.ts is up to date.');
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, test);
  console.log(`Wrote tests/generated/authz-matrix.test.ts (${covered.length} rows).`);
}

if (problems.length) {
  for (const problem of problems) console.error(problem);
  console.error(`${problems.length} authorization matrix problem(s); see PLAN.md §9.2 and §12.3.`);
  process.exitCode = 1;
} else
  console.log('Every registered method is declared, catalogued and sampled, and agrees with §9.2.');
