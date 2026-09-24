// Enforces the package dependency rules of PLAN.md §4.3. `pnpm lint:repo` runs it.
//
//   node scripts/check-deps.mjs
//
// It fails when:
// 1. server depends on (any dependency field of its package.json) or imports (anywhere in
//    packages/server/src) provision, metal, vps, gateway, iam, postgres, provider-*, driver-*, or the
//    `better-compute` umbrella, which re-exports all of them. inventory and capacity are the built-in
//    modules server may import (the one exception to P10).
// 2. core's root entry imports a Node.js built-in (`node:*`, or a bare name such as `fs`):
//    packages/core/src/index.ts and every core file it reaches through relative imports, except
//    conformance.ts, must stay browser-safe.
// 3. a package's workspace dependencies (`workspace:` entries in dependencies and devDependencies)
//    differ from its tsconfig.json references. Optional peers are loaded with import() and need none.
// 4. any package imports or depends on a `@better-compute/provider-*` package other than itself.
//    Applications install providers directly; examples/ and tests/ are not checked.
//
// Imports are read with scripts/source-scan.mjs, so comments and strings never count; type-only
// imports do. Packages that do not exist yet are absent: the rules about them hold trivially.
import { existsSync, realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importSpecifiers, packageName, sourceFiles } from './source-scan.mjs';

/**
 * @typedef {object} WorkspacePackage
 * @property {string} dir  Repo-relative POSIX directory, for example `packages/server`.
 * @property {Record<string, any>} manifest  The parsed package.json.
 * @property {{ references?: { path: string }[] } | undefined} tsconfig  The parsed tsconfig.json.
 * @property {Record<string, string>} sources  Package-relative POSIX path (`src/index.ts`) → source text.
 */

/** @typedef {{ rule: 'server-boundary' | 'core-browser-safe' | 'references' | 'providers', message: string }} Violation */

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/** Packages server must never depend on or import (§4.2, §4.3). */
export function serverMayNotUse(name) {
  return (
    name === 'better-compute' ||
    /^@better-compute\/(?:provision|metal|vps|gateway|iam|postgres|provider-.+|driver-.+)$/.test(
      name,
    )
  );
}

const isProvider = (name) => /^@better-compute\/provider-.+$/.test(name);

/** Whether a specifier names a Node.js built-in module. */
export function isNodeBuiltin(specifier) {
  return (
    specifier.startsWith('node:') ||
    builtinModules.includes(specifier) ||
    builtinModules.includes(specifier.split('/')[0])
  );
}

/** Every package a package's manifest names, with the field that names it. */
function manifestDependencies(pkg) {
  return dependencyFields.flatMap((field) =>
    Object.keys(pkg.manifest[field] ?? {}).map((name) => ({ name, field })),
  );
}

/** Every specifier a package's sources import, with the file that imports it. */
function sourceImports(pkg) {
  return Object.entries(pkg.sources).flatMap(([file, source]) =>
    importSpecifiers(source).map((specifier) => ({ specifier, file: `${pkg.dir}/${file}` })),
  );
}

/** Resolves a relative import between package source files (NodeNext `.js` → `.ts`). */
function resolveRelative(sources, from, specifier) {
  const base = posix.join(posix.dirname(from), specifier);
  const stem = base.replace(/\.(?:[mc]?js|jsx|[mc]?ts|tsx)$/, '');
  return [
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.mts`,
    `${stem}.cts`,
    `${stem}.d.ts`,
    base,
    `${base}/index.ts`,
  ].find((candidate) => Object.hasOwn(sources, candidate));
}

function checkServer(packages, violations) {
  const server = packages.find((pkg) => pkg.manifest.name === '@better-compute/server');
  if (!server) return;
  for (const { name, field } of manifestDependencies(server))
    if (serverMayNotUse(name))
      violations.push({
        rule: 'server-boundary',
        message: `${server.dir}/package.json ${field} names ${name}; server never depends on injected modules, gateway, iam, postgres, providers or drivers`,
      });
  for (const { specifier, file } of sourceImports(server)) {
    const name = packageName(specifier);
    if (name && serverMayNotUse(name))
      violations.push({
        rule: 'server-boundary',
        message: `${file} imports ${specifier}; server receives modules, the store and the IAM port as options instead`,
      });
  }
}

function checkCore(packages, violations) {
  const core = packages.find((pkg) => pkg.manifest.name === '@better-compute/core');
  if (!core || !Object.hasOwn(core.sources, 'src/index.ts')) return;
  const seen = new Set();
  const queue = ['src/index.ts'];
  while (queue.length > 0) {
    const file = /** @type {string} */ (queue.shift());
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of importSpecifiers(core.sources[file])) {
      if (isNodeBuiltin(specifier))
        violations.push({
          rule: 'core-browser-safe',
          message: `${core.dir}/${file} imports ${specifier}; @better-compute/core's root entry must stay browser-safe (only ./conformance may use Node.js)`,
        });
      else if (specifier.startsWith('.')) {
        const target = resolveRelative(core.sources, file, specifier);
        if (target && target !== 'src/conformance.ts') queue.push(target);
      }
    }
  }
}

function checkReferences(packages, violations) {
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const byDir = new Map(packages.map((pkg) => [pkg.dir, pkg]));
  for (const pkg of packages) {
    const expected = new Set();
    for (const field of ['dependencies', 'devDependencies'])
      for (const [name, range] of Object.entries(pkg.manifest[field] ?? {})) {
        if (typeof range !== 'string' || !range.startsWith('workspace:')) continue;
        const target = byName.get(name);
        if (target) expected.add(target.dir);
        else
          violations.push({
            rule: 'references',
            message: `${pkg.dir}/package.json ${field} names ${name}@${range}, which is not a package in packages/`,
          });
      }
    const actual = new Set();
    for (const reference of pkg.tsconfig?.references ?? []) {
      const path = posix.normalize(
        posix.join(pkg.dir, String(reference.path).replaceAll('\\', '/')),
      );
      const dir = path.endsWith('.json') ? posix.dirname(path) : path;
      if (byDir.has(dir)) actual.add(dir);
      else
        violations.push({
          rule: 'references',
          message: `${pkg.dir}/tsconfig.json references ${reference.path}, which is not a package in packages/`,
        });
    }
    for (const dir of expected)
      if (!actual.has(dir))
        violations.push({
          rule: 'references',
          message: `${pkg.dir} depends on ${byDir.get(dir)?.manifest.name} but tsconfig.json does not reference ../${posix.basename(dir)}`,
        });
    for (const dir of actual)
      if (!expected.has(dir))
        violations.push({
          rule: 'references',
          message: `${pkg.dir}/tsconfig.json references ../${posix.basename(dir)} but package.json has no workspace dependency on ${byDir.get(dir)?.manifest.name}`,
        });
  }
}

function checkProviders(packages, violations) {
  for (const pkg of packages) {
    const self = pkg.manifest.name;
    for (const { name, field } of manifestDependencies(pkg))
      if (isProvider(name) && name !== self)
        violations.push({
          rule: 'providers',
          message: `${pkg.dir}/package.json ${field} names ${name}; providers are installed by applications, never depended on`,
        });
    for (const { specifier, file } of sourceImports(pkg)) {
      const name = packageName(specifier);
      if (name && isProvider(name) && name !== self)
        violations.push({
          rule: 'providers',
          message: `${file} imports ${specifier}; nothing in packages/ imports a provider`,
        });
    }
  }
}

/**
 * Checks the §4.3 rules over a workspace model. Pure: tests pass in-memory packages.
 * @param {WorkspacePackage[]} packages
 * @returns {Violation[]}
 */
export function checkDeps(packages) {
  /** @type {Violation[]} */
  const violations = [];
  checkServer(packages, violations);
  checkCore(packages, violations);
  checkReferences(packages, violations);
  checkProviders(packages, violations);
  return violations;
}

/**
 * Reads every `packages/*` directory that has a package.json.
 * @param {string} root  The repository root.
 * @returns {Promise<WorkspacePackage[]>}
 */
export async function loadWorkspace(root) {
  const packages = [];
  const entries = await readdir(join(root, 'packages'), { withFileTypes: true });
  for (const entry of entries
    .filter((item) => item.isDirectory())
    .sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const dir = `packages/${entry.name}`;
    const manifestPath = join(root, dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const tsconfigPath = join(root, dir, 'tsconfig.json');
    /** @type {Record<string, string>} */
    const sources = {};
    for (const file of await sourceFiles(join(root, dir, 'src')))
      sources[`src/${file}`] = await readFile(join(root, dir, 'src', file), 'utf8');
    packages.push({
      dir,
      manifest: JSON.parse(await readFile(manifestPath, 'utf8')),
      tsconfig: existsSync(tsconfigPath)
        ? JSON.parse(await readFile(tsconfigPath, 'utf8'))
        : undefined,
      sources,
    });
  }
  return packages;
}

/** True when run as `node scripts/check-deps.mjs`, false when a test imports it. */
function invokedDirectly() {
  const normal = (path) => (process.platform === 'win32' ? path.toLowerCase() : path);
  try {
    return normal(realpathSync(process.argv[1] ?? '')) === normal(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const packages = await loadWorkspace(fileURLToPath(new URL('..', import.meta.url)));
  const violations = checkDeps(packages);
  for (const violation of violations)
    console.error(`check-deps [${violation.rule}] ${violation.message}`);
  if (violations.length > 0) {
    console.error(`${violations.length} dependency rule violation(s); see PLAN.md §4.3.`);
    process.exitCode = 1;
  } else console.log(`Dependency rules hold for ${packages.length} packages.`);
}
