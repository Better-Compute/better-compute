import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { notReleased, planRelease, releaseAllowlist } from '../scripts/release-publish.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'scripts', 'release-publish.mjs');

/** Every package of the 0.2.1 release, the base of the 0.3 allowlist. */
const released021 = [
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
];

describe('the release allowlist', () => {
  it('is exactly the 0.2.1 packages plus gcp-common', () => {
    expect([...releaseAllowlist].sort()).toEqual(
      [...released021, '@better-compute/gcp-common'].sort(),
    );
  });

  it('leaves out aws-core and provider-digitalocean', () => {
    expect(releaseAllowlist).not.toContain('@better-compute/aws-core');
    expect(releaseAllowlist).not.toContain('@better-compute/provider-digitalocean');
    expect(Object.keys(notReleased).sort()).toEqual([
      '@better-compute/aws-core',
      '@better-compute/provider-digitalocean',
    ]);
  });

  it('matches the workspace: one version, every dependency released, dependencies first', async () => {
    const plan = await planRelease(root);
    expect(plan.errors).toEqual([]);
    const order = plan.packages.map((pkg) => pkg.name);
    expect([...order].sort()).toEqual([...releaseAllowlist].sort());
    for (const pkg of plan.packages)
      for (const dependency of pkg.workspaceDependencies) {
        expect(releaseAllowlist).toContain(dependency);
        expect(order.indexOf(dependency)).toBeLessThan(order.indexOf(pkg.name));
      }
    expect(order.indexOf('@better-compute/gcp-common')).toBeLessThan(
      order.indexOf('@better-compute/provider-gcp'),
    );
    expect(plan.skipped.map((entry) => entry.name).sort()).toEqual(Object.keys(notReleased).sort());
  });

  it('--list prints the publish order and --check passes', () => {
    const list = spawnSync(process.execPath, [script, '--list'], { encoding: 'utf8' });
    expect(list.status).toBe(0);
    const names = list.stdout.trim().split(/\r?\n/);
    expect([...names].sort()).toEqual([...releaseAllowlist].sort());
    const check = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('consistent');
  });

  it('refuses unknown options', () => {
    const result = spawnSync(process.execPath, [script, '-r', '--recursive'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
  });
});

describe('planRelease on a synthetic workspace', () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  const workspace = (manifests: Record<string, object>) => {
    directory = mkdtempSync(join(tmpdir(), 'bc-release-plan-'));
    for (const [folder, manifest] of Object.entries(manifests)) {
      mkdirSync(join(directory, 'packages', folder), { recursive: true });
      writeFileSync(join(directory, 'packages', folder, 'package.json'), JSON.stringify(manifest));
    }
    return directory;
  };

  it('refuses a new package that is neither allowlisted nor excluded', async () => {
    const dir = workspace({
      core: { name: '@x/core', version: '1.0.0' },
      fresh: { name: '@x/fresh', version: '1.0.0' },
    });
    const plan = await planRelease(dir, { allowlist: ['@x/core'], excluded: {} });
    expect(plan.errors.join('\n')).toMatch(
      /@x\/fresh .*neither on the release allowlist nor in notReleased/,
    );
  });

  it('refuses a released package that depends on an unreleased one', async () => {
    const dir = workspace({
      core: { name: '@x/core', version: '1.0.0' },
      aws: { name: '@x/aws', version: '1.0.0' },
      app: { name: '@x/app', version: '1.0.0', dependencies: { '@x/aws': 'workspace:*' } },
    });
    const plan = await planRelease(dir, {
      allowlist: ['@x/core', '@x/app'],
      excluded: { '@x/aws': 'not ready' },
    });
    expect(plan.errors.join('\n')).toMatch(/@x\/app depends on @x\/aws/);
  });

  it('refuses mixed versions, private or missing allowlisted packages and overlaps', async () => {
    const dir = workspace({
      core: { name: '@x/core', version: '1.0.0' },
      next: { name: '@x/next', version: '1.1.0' },
      hidden: { name: '@x/hidden', version: '1.0.0', private: true },
    });
    const plan = await planRelease(dir, {
      allowlist: ['@x/core', '@x/next', '@x/hidden', '@x/gone'],
      excluded: { '@x/core': 'both' },
    });
    const text = plan.errors.join('\n');
    expect(text).toMatch(/disagree on the version/);
    expect(text).toMatch(/@x\/hidden is on the release allowlist but is private/);
    expect(text).toMatch(/@x\/gone is on the release allowlist but is not a packages/);
    expect(text).toMatch(/@x\/core is both on the release allowlist and in notReleased/);
  });

  it('orders dependencies first and skips private packages', async () => {
    const dir = workspace({
      a: { name: '@x/a', version: '1.0.0', dependencies: { '@x/b': 'workspace:*' } },
      b: { name: '@x/b', version: '1.0.0', peerDependencies: { '@x/c': 'workspace:^' } },
      c: { name: '@x/c', version: '1.0.0' },
      p: { name: '@x/p', version: '1.0.0', private: true },
    });
    const plan = await planRelease(dir, { allowlist: ['@x/a', '@x/b', '@x/c'], excluded: {} });
    expect(plan.errors).toEqual([]);
    expect(plan.packages.map((pkg) => pkg.name)).toEqual(['@x/c', '@x/b', '@x/a']);
    expect(plan.skipped).toEqual([{ name: '@x/p', reason: 'private' }]);
  });
});
