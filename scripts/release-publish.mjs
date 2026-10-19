// Publishes a release to npm: ONLY the packages on the release allowlist below, one at a time, in
// dependency order, with the pinned pnpm (RELEASING.md).
//
//   node scripts/release-publish.mjs --dry-run      the whole run, but `pnpm publish --dry-run`
//   node scripts/release-publish.mjs                publishes (needs a clean checkout)
//   node scripts/release-publish.mjs --check        validates the allowlist against packages/* (no build)
//   node scripts/release-publish.mjs --list         prints the allowlist in publish order, one per line
//
// Options:
//   --tag <dist-tag>   npm dist-tag; default `latest`, or `next` for a prerelease version (X.Y.Z-rc.N)
//   --provenance       npm provenance (needs an OIDC identity, e.g. GitHub Actions with id-token: write)
//   --skip-build       publish the dist/ already built (ci.yml runs `pnpm pack:all` first); otherwise
//                      scripts/pack.mjs rebuilds every package from a clean dist/ before publishing
//   --no-registry      do not ask the registry which versions exist (offline dry runs); without it a
//                      package whose version is already on npm is skipped, so a rerun finishes a
//                      partial release
//   --allow-dirty      publish from a checkout with uncommitted changes (never for a real release)
//
// Never `pnpm publish -r`: it publishes every workspace package, including the ones below that are not
// ready (aws-core, provider-digitalocean). A new packages/* package must be added to either
// `releaseAllowlist` or `notReleased`; until then --check (tests/scripts-release-publish.test.ts) and
// every publish fail.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPnpm } from './tooling.mjs';

/**
 * The packages a release publishes: every package of 0.2.1 plus `@better-compute/gcp-common` (new in
 * 0.3, a dependency of provider-gcp). Publish order is computed from the dependencies, not this order.
 */
export const releaseAllowlist = Object.freeze([
  '@better-compute/audit',
  'better-compute',
  '@better-compute/capacity',
  '@better-compute/cli',
  '@better-compute/client',
  '@better-compute/console-kit',
  '@better-compute/core',
  '@better-compute/driver-sdk',
  '@better-compute/events',
  '@better-compute/fleet',
  '@better-compute/gateway',
  '@better-compute/gcp-common',
  '@better-compute/iam',
  '@better-compute/inventory',
  '@better-compute/mcp',
  '@better-compute/metal',
  '@better-compute/observability',
  '@better-compute/pki',
  '@better-compute/postgres',
  '@better-compute/protocol',
  '@better-compute/provider-gcp',
  '@better-compute/provider-hetzner',
  '@better-compute/provider-kubernetes',
  '@better-compute/provider-proxmox',
  '@better-compute/provision',
  '@better-compute/rollout',
  '@better-compute/server',
  '@better-compute/testing',
  '@better-compute/vps',
]);

/** Workspace packages a release deliberately leaves out, with the reason. */
export const notReleased = Object.freeze({
  '@better-compute/aws-core': 'not ready: only the unreleased AWS provider uses it',
  '@better-compute/provider-digitalocean':
    'not ready: the DigitalOcean program is still in progress',
});

const internalFields = ['dependencies', 'peerDependencies', 'optionalDependencies'];

/** Every packages/* manifest: name, version, private, directory and its workspace dependencies. */
export async function readWorkspacePackages(root) {
  const packages = [];
  const entries = (await readdir(join(root, 'packages'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const entry of entries) {
    const path = join(root, 'packages', entry, 'package.json');
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    const workspaceDependencies = new Set();
    for (const field of internalFields)
      for (const [name, range] of Object.entries(manifest[field] ?? {}))
        if (String(range).startsWith('workspace:')) workspaceDependencies.add(name);
    packages.push({
      name: manifest.name,
      version: manifest.version,
      private: manifest.private === true,
      directory: join(root, 'packages', entry),
      workspaceDependencies: [...workspaceDependencies].sort(),
    });
  }
  return packages;
}

/**
 * The release plan: the allowlisted packages in publish order (every package after its workspace
 * dependencies), the packages left out and why, and every reason the release must not go ahead.
 */
export async function planRelease(
  root,
  { allowlist = releaseAllowlist, excluded = notReleased } = {},
) {
  const workspace = await readWorkspacePackages(root);
  const byName = new Map(workspace.map((pkg) => [pkg.name, pkg]));
  const allowed = new Set(allowlist);
  const errors = [];

  if (allowed.size !== allowlist.length) errors.push('the release allowlist names a package twice');
  for (const name of allowlist) {
    const pkg = byName.get(name);
    if (!pkg) errors.push(`${name} is on the release allowlist but is not a packages/* package`);
    else if (pkg.private) errors.push(`${name} is on the release allowlist but is private`);
    if (Object.hasOwn(excluded, name))
      errors.push(`${name} is both on the release allowlist and in notReleased`);
  }
  const skipped = [];
  for (const pkg of workspace) {
    if (allowed.has(pkg.name)) continue;
    if (Object.hasOwn(excluded, pkg.name))
      skipped.push({ name: pkg.name, reason: excluded[pkg.name] });
    else if (pkg.private) skipped.push({ name: pkg.name, reason: 'private' });
    else
      errors.push(
        `${pkg.name} (${pkg.directory}) is neither on the release allowlist nor in notReleased: decide whether 0.x releases it (scripts/release-publish.mjs)`,
      );
  }

  const released = allowlist.map((name) => byName.get(name)).filter(Boolean);
  const versions = new Set(released.map((pkg) => pkg.version));
  if (versions.size > 1)
    errors.push(
      `the released packages disagree on the version (${[...versions].join(', ')}); run node scripts/release-version.mjs X.Y.Z`,
    );
  for (const pkg of released)
    for (const dependency of pkg.workspaceDependencies)
      if (!allowed.has(dependency))
        errors.push(
          `${pkg.name} depends on ${dependency}, which the release does not publish, so it would not install from npm`,
        );

  // Dependency order; ties keep the allowlist order. A cycle (none today) is reported, not looped on.
  const order = [];
  const state = new Map();
  const visit = (pkg, path) => {
    if (state.get(pkg.name) === 'done') return;
    if (state.get(pkg.name) === 'visiting') {
      errors.push(`workspace dependency cycle: ${[...path, pkg.name].join(' -> ')}`);
      return;
    }
    state.set(pkg.name, 'visiting');
    for (const dependency of pkg.workspaceDependencies) {
      const target = byName.get(dependency);
      if (target && allowed.has(dependency)) visit(target, [...path, pkg.name]);
    }
    state.set(pkg.name, 'done');
    order.push(pkg);
  };
  for (const pkg of released) visit(pkg, []);

  return { version: released[0]?.version ?? null, packages: order, skipped, errors };
}

/** True when the registry already has `name@version`; null when the registry could not be asked. */
async function onRegistry(name, version) {
  const registry = (process.env.npm_config_registry || 'https://registry.npmjs.org/').replace(
    /\/?$/,
    '/',
  );
  const url = `${registry}${name.replace('/', '%2F')}/${encodeURIComponent(version)}`;
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

export async function main(argv, root) {
  const known = new Set([
    '--dry-run',
    '--check',
    '--list',
    '--tag',
    '--provenance',
    '--skip-build',
    '--no-registry',
    '--allow-dirty',
  ]);
  for (const [index, arg] of argv.entries())
    if (arg.startsWith('--') && !known.has(arg)) throw new Error(`unknown option ${arg}`);
    else if (!arg.startsWith('--') && argv[index - 1] !== '--tag')
      throw new Error(`unexpected argument ${arg}`);

  const plan = await planRelease(root);
  if (plan.errors.length) {
    for (const error of plan.errors) console.error(`release: ${error}`);
    return 1;
  }
  if (argv.includes('--list')) {
    for (const pkg of plan.packages) console.log(pkg.name);
    return 0;
  }
  const summary = `${plan.packages.length} packages at ${plan.version}; left out: ${
    plan.skipped.map((entry) => `${entry.name} (${entry.reason})`).join(', ') || 'none'
  }`;
  if (argv.includes('--check')) {
    console.log(`The release allowlist is consistent: ${summary}.`);
    return 0;
  }

  const dryRun = argv.includes('--dry-run');
  const tag = option(argv, '--tag') ?? (plan.version.includes('-') ? 'next' : 'latest');
  console.log(`${dryRun ? 'Dry run: ' : ''}release ${summary}. dist-tag ${tag}.`);

  if (!dryRun && !argv.includes('--allow-dirty')) {
    const status = git(root, ['status', '--porcelain']);
    if (status === null) {
      console.error('release: git status failed; publish from a git checkout');
      return 1;
    }
    if (status !== '') {
      console.error('release: the checkout has uncommitted changes; publish from a clean checkout');
      return 1;
    }
  }
  const head = git(root, ['rev-parse', 'HEAD']);
  if (head) console.log(`Commit ${head}.`);

  if (!argv.includes('--skip-build')) {
    const build = spawnSync(process.execPath, [join(root, 'scripts', 'pack.mjs')], {
      cwd: root,
      stdio: 'inherit',
      shell: false,
    });
    if (build.error) throw build.error;
    if (build.status !== 0) return build.status ?? 1;
  }
  const unbuilt = plan.packages.filter((pkg) => !existsSync(join(pkg.directory, 'dist')));
  if (unbuilt.length) {
    console.error(
      `release: no dist/ in ${unbuilt.map((pkg) => pkg.name).join(', ')}; run pnpm pack:all or drop --skip-build`,
    );
    return 1;
  }

  const publish = [];
  for (const pkg of plan.packages) {
    if (argv.includes('--no-registry')) {
      publish.push(pkg);
      continue;
    }
    const found = await onRegistry(pkg.name, pkg.version);
    if (found === true) console.log(`${pkg.name}@${pkg.version} is already on npm; skipped.`);
    else if (found === false) publish.push(pkg);
    else if (dryRun) {
      console.warn(
        `release: could not ask the registry about ${pkg.name} (${found.error}); assuming unpublished`,
      );
      publish.push(pkg);
    } else {
      console.error(`release: could not ask the registry about ${pkg.name} (${found.error})`);
      return 1;
    }
  }

  const flags = ['--access', 'public', '--no-git-checks', '--tag', tag];
  if (argv.includes('--provenance')) flags.push('--provenance');
  if (dryRun) flags.push('--dry-run');
  for (const pkg of publish) {
    console.log(`${dryRun ? '[dry run] ' : ''}pnpm publish ${pkg.name}@${pkg.version}`);
    runPnpm(['publish', ...flags], { cwd: pkg.directory });
  }
  console.log(
    `${dryRun ? 'Dry run finished' : 'Published'}: ${publish.length} of ${plan.packages.length} packages${
      dryRun ? '; nothing was published' : ''
    }.`,
  );
  return 0;
}

/** True when run as `node scripts/release-publish.mjs`, false when a test imports it. */
function invokedDirectly() {
  const normal = (path) => (process.platform === 'win32' ? path.toLowerCase() : path);
  try {
    return normal(realpathSync(process.argv[1] ?? '')) === normal(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    process.exitCode = await main(
      process.argv.slice(2),
      fileURLToPath(new URL('..', import.meta.url)),
    );
  } catch (error) {
    console.error(`release: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
