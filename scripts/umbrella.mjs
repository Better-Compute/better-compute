// Generates the umbrella package `better-compute` from packages/better-compute/umbrella.json
// (PLAN.md §4.4).
//
//   node scripts/umbrella.mjs          write the generated files (`pnpm umbrella`)
//   node scripts/umbrella.mjs --check  fail if a generated file differs (`pnpm lint:repo`)
//
// umbrella.json holds `subpaths` (subpath → specifier it re-exports), `bin` (one command → the
// package whose `runBinary()` it runs) and `optionalPeers` (name → range). From them it generates:
// - package.json `bin`, `exports`, `dependencies` (every re-exported package as `workspace:*`),
//   `peerDependencies` and `peerDependenciesMeta` (all optional); every other field is kept;
// - tsconfig.json `references`, one per dependency;
// - src/<flat>.ts per subpath: `export * from '<specifier>';`. The flat name is the subpath without
//   './' and with '/' → '-' ('./iam/plugin' → src/iam-plugin.ts, dist/iam-plugin.js);
// - src/cli-bin.ts for the bin.
// src/index.ts (curated by hand) and README.md are never touched. Any other src/*.ts is stale:
// --check reports it and a write deletes it.
import { existsSync, realpathSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Key order of the umbrella's package.json. Keys not listed keep their order after these. */
const manifestOrder = [
  'name',
  'version',
  'description',
  'type',
  'license',
  'author',
  'homepage',
  'repository',
  'bugs',
  'keywords',
  'publishConfig',
  'engines',
  'files',
  'bin',
  'main',
  'types',
  'exports',
  'sideEffects',
  'scripts',
  'dependencies',
  'peerDependencies',
  'peerDependenciesMeta',
];
const handWritten = new Set(['src/index.ts']);
const subpathPattern = /^\.\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;
const specifierPattern = /^@better-compute\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;

/** `./iam/plugin` → `iam-plugin`. */
export function flatName(subpath) {
  return subpath.slice(2).replaceAll('/', '-');
}

/** `@better-compute/postgres/pglite` → `@better-compute/postgres`. */
const packageOf = (specifier) => specifier.split('/').slice(0, 2).join('/');
const json = (value) => JSON.stringify(value, null, 2) + '\n';

function validate(config) {
  const subpaths = Object.entries(config.subpaths ?? {});
  if (subpaths.length === 0)
    throw new Error('umbrella.json: `subpaths` must name at least one subpath');
  const flat = new Map();
  for (const [subpath, specifier] of subpaths) {
    if (!subpathPattern.test(subpath))
      throw new Error(`umbrella.json: subpath ${subpath} must look like ./name or ./name/sub`);
    if (typeof specifier !== 'string' || !specifierPattern.test(specifier))
      throw new Error(`umbrella.json: ${subpath} must re-export a @better-compute/* specifier`);
    const name = flatName(subpath);
    if (name === 'index' || name === 'cli-bin')
      throw new Error(`umbrella.json: subpath ${subpath} would overwrite src/${name}.ts`);
    if (flat.has(name))
      throw new Error(
        `umbrella.json: ${subpath} and ${flat.get(name)} both flatten to src/${name}.ts`,
      );
    flat.set(name, subpath);
  }
  const bins = Object.entries(config.bin ?? {});
  if (bins.length !== 1) throw new Error('umbrella.json: `bin` must name exactly one command');
  if (typeof bins[0][1] !== 'string' || !specifierPattern.test(bins[0][1]))
    throw new Error(`umbrella.json: bin ${bins[0][0]} must name a @better-compute/* package`);
  for (const [name, range] of Object.entries(config.optionalPeers ?? {}))
    if (typeof range !== 'string')
      throw new Error(`umbrella.json: optional peer ${name} needs a range`);
}

/**
 * Computes every generated umbrella file. Pure: tests pass the inputs in.
 * @param {{ subpaths: Record<string, string>, bin: Record<string, string>, optionalPeers?: Record<string, string> }} config  umbrella.json
 * @param {Record<string, any>} manifest  The current package.json; fields that are not generated are kept.
 * @param {Record<string, any>} tsconfig  The current tsconfig.json; fields other than `references` are kept.
 * @param {(name: string) => string | undefined} [directoryOf]  The packages/ directory of a workspace
 *   package; `undefined` for an unknown package. Defaults to the unscoped name.
 * @returns {Record<string, string>}  Package-relative path → file content.
 */
export function generateUmbrella(
  config,
  manifest,
  tsconfig,
  directoryOf = (name) => name.split('/')[1],
) {
  validate(config);
  const subpaths = Object.entries(config.subpaths);
  const [[command, binSpecifier]] = Object.entries(config.bin);
  const entry = (name) => ({ types: `./dist/${name}.d.ts`, import: `./dist/${name}.js` });

  const names = [
    ...new Set([...subpaths.map(([, specifier]) => specifier), binSpecifier].map(packageOf)),
  ].sort();
  const references = names.map((name) => {
    const directory = directoryOf(name);
    if (!directory) throw new Error(`umbrella.json: ${name} is not a package in packages/`);
    return { path: `../${directory}` };
  });
  const peers = Object.keys(config.optionalPeers ?? {}).sort();

  /** @type {Record<string, any>} */
  const generated = {
    bin: { [command]: './dist/cli-bin.js' },
    exports: Object.fromEntries([
      ['.', entry('index')],
      ...subpaths.map(([subpath]) => [subpath, entry(flatName(subpath))]),
    ]),
    dependencies: Object.fromEntries(names.map((name) => [name, 'workspace:*'])),
  };
  if (peers.length > 0) {
    generated.peerDependencies = Object.fromEntries(
      peers.map((name) => [name, config.optionalPeers?.[name]]),
    );
    generated.peerDependenciesMeta = Object.fromEntries(
      peers.map((name) => [name, { optional: true }]),
    );
  }
  const merged = { ...manifest, ...generated };
  if (peers.length === 0) {
    delete merged.peerDependencies;
    delete merged.peerDependenciesMeta;
  }
  /** @type {Record<string, any>} */
  const ordered = {};
  for (const key of manifestOrder) if (Object.hasOwn(merged, key)) ordered[key] = merged[key];
  for (const key of Object.keys(merged))
    if (!Object.hasOwn(ordered, key)) ordered[key] = merged[key];

  /** @type {Record<string, string>} */
  const files = {
    'package.json': json(ordered),
    'tsconfig.json': json({ ...tsconfig, references }),
  };
  for (const [subpath, specifier] of subpaths)
    files[`src/${flatName(subpath)}.ts`] = `export * from '${specifier}';\n`;
  files['src/cli-bin.ts'] =
    `#!/usr/bin/env node\nimport { runBinary } from '${binSpecifier}';\nrunBinary();\n`;
  return files;
}

/**
 * Reads the umbrella and the workspace, and compares the generated files with what is on disk.
 * @param {string} root  The repository root.
 * @returns {Promise<{ directory: string, files: Record<string, string>, changed: string[], stale: string[] }>}
 */
export async function planUmbrella(root) {
  const directory = join(root, 'packages', 'better-compute');
  const read = async (path) => JSON.parse(await readFile(join(directory, path), 'utf8'));
  const directories = new Map();
  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    const manifestPath = join(root, 'packages', entry.name, 'package.json');
    if (entry.isDirectory() && existsSync(manifestPath))
      directories.set(JSON.parse(await readFile(manifestPath, 'utf8')).name, entry.name);
  }
  const files = generateUmbrella(
    await read('umbrella.json'),
    await read('package.json'),
    await read('tsconfig.json'),
    (name) => directories.get(name),
  );
  const changed = [];
  for (const [path, content] of Object.entries(files)) {
    const current = existsSync(join(directory, path))
      ? await readFile(join(directory, path), 'utf8')
      : undefined;
    if (current?.replaceAll('\r\n', '\n') !== content) changed.push(path);
  }
  const stale = (await readdir(join(directory, 'src'), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => `src/${entry.name}`)
    .filter((path) => !handWritten.has(path) && !Object.hasOwn(files, path));
  return { directory, files, changed, stale };
}

/** True when run as `node scripts/umbrella.mjs`, false when a test imports it. */
function invokedDirectly() {
  const normal = (path) => (process.platform === 'win32' ? path.toLowerCase() : path);
  try {
    return normal(realpathSync(process.argv[1] ?? '')) === normal(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const { directory, files, changed, stale } = await planUmbrella(
    fileURLToPath(new URL('..', import.meta.url)),
  );
  const where = (path) => `packages/better-compute/${path}`;
  if (process.argv.includes('--check')) {
    for (const path of changed) console.error(`umbrella: ${where(path)} is out of date`);
    for (const path of stale)
      console.error(`umbrella: ${where(path)} is not generated from umbrella.json`);
    if (changed.length + stale.length > 0) {
      console.error(
        'The umbrella drifted from umbrella.json; run `pnpm umbrella` and commit the result.',
      );
      process.exitCode = 1;
    } else console.log('The umbrella matches umbrella.json.');
  } else {
    for (const path of changed) await writeFile(join(directory, path), files[path]);
    for (const path of stale) await rm(join(directory, path));
    const touched = [
      ...changed.map((path) => `wrote ${where(path)}`),
      ...stale.map((path) => `deleted ${where(path)}`),
    ];
    console.log(
      touched.length > 0 ? touched.join('\n') : 'The umbrella already matches umbrella.json.',
    );
  }
}
