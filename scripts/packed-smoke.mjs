// Installs the packed packages the way an application would, then imports them (`pnpm test:packed`,
// after `pnpm pack:all`).
//
// A fresh consumer in work/packed-XXXX depends on every artifacts/ tarball and on every optional peer
// the packages declare, installed from the registry at the declared range (@better-iam/* included).
// Its pnpm-workspace.yaml overrides every better-compute package to its tarball and takes `allowBuilds`
// from scripts/tooling.mjs.
// smoke.mjs imports the umbrella's entry points, and `better-compute --help` runs through the installed bin.
// The consumer directory is deleted afterwards (only ever inside work/).
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { allowBuilds, root, runPnpm } from './tooling.mjs';

/** Entry points the smoke imports: the four named subpaths (§4.4) plus the everyday ones. */
const entryPoints = [
  'better-compute',
  'better-compute/inventory',
  'better-compute/provision',
  'better-compute/metal',
  'better-compute/vps',
  'better-compute/pglite',
  'better-compute/client',
];
const fileSpec = (path) => `file:${resolve(path).replaceAll('\\', '/')}`;
/** pnpm pack's file name: `@better-compute/core@0.1.0` → `better-compute-core-0.1.0.tgz`. */
const tarballOf = (name, version) => `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;

const manifests = [];
for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
  const path = join(root, 'packages', entry.name, 'package.json');
  if (entry.isDirectory() && existsSync(path))
    manifests.push(JSON.parse(await readFile(path, 'utf8')));
}
const missing = manifests
  .map((manifest) => tarballOf(manifest.name, manifest.version))
  .filter((file) => !existsSync(join(root, 'artifacts', file)));
if (missing.length > 0) throw new Error(`Run pack:all first; missing ${missing.join(', ')}`);

const dependencies = {};
const overrides = {};
for (const manifest of manifests) {
  dependencies[manifest.name] = fileSpec(
    join(root, 'artifacts', tarballOf(manifest.name, manifest.version)),
  );
  overrides[manifest.name] = dependencies[manifest.name];
}
for (const manifest of manifests)
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {}))
    if (!Object.hasOwn(dependencies, name)) dependencies[name] = range;

// Canonical paths: a Windows 8.3 short name (C:\Users\SEANFI~1) in the consumer's cwd makes Node load
// the bin under two URLs and fail with ERR_REQUIRE_CYCLE_MODULE.
await mkdir(join(root, 'work'), { recursive: true });
const workRoot = realpathSync.native(join(root, 'work'));
const directory = realpathSync.native(await mkdtemp(join(workRoot, 'packed-')));
const yamlEntries = (record) =>
  Object.entries(record).map(
    ([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`,
  );
await writeFile(
  join(directory, 'package.json'),
  JSON.stringify({ private: true, type: 'module', dependencies }, null, 2) + '\n',
);
await writeFile(
  join(directory, 'pnpm-workspace.yaml'),
  ['allowBuilds:', ...yamlEntries(allowBuilds), 'overrides:', ...yamlEntries(overrides), ''].join(
    '\n',
  ),
);
await writeFile(
  join(directory, 'smoke.mjs'),
  `const entryPoints = ${JSON.stringify(entryPoints)};
const failures = [];
const loaded = {};
for (const specifier of entryPoints) {
  try {
    loaded[specifier] = await import(specifier);
  } catch (error) {
    failures.push(\`\${specifier}: \${error?.message ?? error}\`);
  }
}
if (loaded['better-compute'] && typeof loaded['better-compute'].ComputeError !== 'function')
  failures.push('better-compute: ComputeError is not exported');
if (failures.length > 0) throw new Error('Packed entry points failed:\\n' + failures.join('\\n'));
console.log(\`Packed consumer imported \${entryPoints.length} better-compute entry points.\`);
`,
);

try {
  runPnpm(['install', '--ignore-scripts=false'], { cwd: directory });
  const smoke = spawnSync(process.execPath, ['smoke.mjs'], {
    cwd: directory,
    stdio: 'inherit',
    shell: false,
  });
  if (smoke.error) throw smoke.error;
  if (smoke.status !== 0) throw new Error('Packed consumer smoke.mjs failed');
  runPnpm(['exec', 'better-compute', '--help'], { cwd: directory });
  console.log('Packed consumer install, imports and the better-compute bin passed.');
} finally {
  if (!resolve(directory).startsWith(resolve(workRoot) + sep))
    throw new Error('Refusing cleanup outside the work directory');
  await rm(directory, { recursive: true, force: true });
}
