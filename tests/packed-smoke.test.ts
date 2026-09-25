import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// The packed smoke (PLAN.md §16 P0 exit: "packed smoke importing better-compute/{inventory,provision,metal,vps}";
// v0.1 gate "packed smoke"). What a tarball ships is decided by each manifest, so these checks run everywhere:
// every published package exports only compiled files that its sources produce, ships its README and LICENSE,
// and the umbrella exposes every subpath of umbrella.json. The install itself (`pnpm pack:all`, then
// scripts/packed-smoke.mjs: a fresh consumer installs the tarballs and imports the entry points) needs the
// artifacts and a registry for third-party peers; it runs with BETTER_COMPUTE_PACKED_SMOKE=1.

const root = join(import.meta.dirname, '..');
const run = promisify(execFile);

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  files?: string[];
  bin?: string | Record<string, string>;
  exports?: Record<string, string | { types?: string; import?: string }>;
}

const packages = readdirSync(join(root, 'packages'))
  .filter((name) => existsSync(join(root, 'packages', name, 'package.json')))
  .map((name) => ({
    name,
    dir: join(root, 'packages', name),
    manifest: JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8')) as Manifest,
  }))
  .filter(({ manifest }) => !manifest.private);

/** `./dist/x.js` or `./dist/x.d.ts` → `./src/x.ts`. */
const sourceOf = (file: string) => file.replace(/^\.\/dist\//, './src/').replace(/(\.d\.ts|\.js)$/, '.ts');

describe('packed packages', () => {
  it('lists every published package', () => {
    expect(packages.map(({ manifest }) => manifest.name)).toEqual(
      expect.arrayContaining(['better-compute', '@better-compute/core', '@better-compute/cli']),
    );
  });

  it.each(packages.map((entry) => [entry.manifest.name, entry] as const))(
    '%s ships dist, README and LICENSE, and exports only what its sources compile to',
    (_name, { dir, manifest }) => {
      expect(manifest.files ?? []).toEqual(expect.arrayContaining(['dist', 'README.md', 'LICENSE']));
      for (const file of ['README.md', 'LICENSE']) expect(existsSync(join(dir, file)), file).toBe(true);
      for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
        const conditions = typeof target === 'string' ? { import: target } : target;
        for (const condition of ['import', 'types'] as const) {
          const file = conditions[condition];
          expect(file, `${subpath} ${condition}`).toMatch(/^\.\/dist\/.+\.(js|d\.ts)$/);
          expect(existsSync(join(dir, sourceOf(file!))), `${subpath} ${condition}: ${sourceOf(file!)}`).toBe(true);
        }
      }
      const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
      for (const bin of bins) expect(existsSync(join(dir, sourceOf(bin))), bin).toBe(true);
    },
  );

  it('the umbrella exports every subpath of umbrella.json, including the four named ones (§4.4)', () => {
    const umbrella = JSON.parse(
      readFileSync(join(root, 'packages', 'better-compute', 'umbrella.json'), 'utf8'),
    ) as { subpaths: Record<string, string> };
    const manifest = packages.find(({ manifest }) => manifest.name === 'better-compute')!.manifest;
    for (const subpath of Object.keys(umbrella.subpaths))
      expect(manifest.exports, subpath).toHaveProperty([subpath]);
    for (const subpath of ['./inventory', './provision', './metal', './vps'])
      expect(umbrella.subpaths).toHaveProperty([subpath]);
    // The smoke script imports those four.
    const script = readFileSync(join(root, 'scripts', 'packed-smoke.mjs'), 'utf8');
    for (const subpath of ['inventory', 'provision', 'metal', 'vps'])
      expect(script).toContain(`'better-compute/${subpath}'`);
  });

  const artifacts = join(root, 'artifacts');
  it.runIf(process.env.BETTER_COMPUTE_PACKED_SMOKE === '1' && existsSync(artifacts))(
    'installs the tarballs in a fresh consumer and imports the entry points (scripts/packed-smoke.mjs)',
    async () => {
      const { stdout } = await run(process.execPath, [join(root, 'scripts', 'packed-smoke.mjs')], {
        cwd: root,
        maxBuffer: 64 * 1024 * 1024,
      });
      expect(stdout).toContain('Packed consumer install, imports and the better-compute bin passed.');
    },
    600_000,
  );
});
