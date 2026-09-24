import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { flatName, generateUmbrella, planUmbrella } from '../scripts/umbrella.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

const manifest = {
  name: 'better-compute',
  version: '0.1.0',
  description: 'Umbrella.',
  type: 'module',
  license: 'Apache-2.0',
  files: ['dist'],
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' }, './old': 'x' },
  sideEffects: false,
  scripts: { build: 'tsc -b' },
  dependencies: { '@better-compute/old': 'workspace:*', left: '1.0.0' },
  funding: 'https://example.test/fund',
};
const tsconfig = {
  extends: '../../tsconfig.base.json',
  compilerOptions: { rootDir: 'src', outDir: 'dist' },
  include: ['src/**/*.ts'],
  references: [{ path: '../old' }],
};
const config = {
  subpaths: {
    './core': '@better-compute/core',
    './postgres': '@better-compute/postgres',
    './pglite': '@better-compute/postgres/pglite',
    './iam/plugin': '@better-compute/iam/plugin',
  },
  bin: { 'better-compute': '@better-compute/cli' },
  optionalPeers: { '@electric-sql/pglite': '^0.5.8', '@better-iam/server': '^0.1.0' },
};

describe('flatName', () => {
  it('drops ./ and flattens nested subpaths', () => {
    expect(flatName('./metal')).toBe('metal');
    expect(flatName('./iam/plugin')).toBe('iam-plugin');
    expect(flatName('./a/b/c')).toBe('a-b-c');
  });
});

describe('generateUmbrella', () => {
  const files = generateUmbrella(config, manifest, tsconfig);
  const generated = JSON.parse(files['package.json']);

  it('writes one re-export per subpath and the bin entry', () => {
    expect(Object.keys(files).sort()).toEqual([
      'package.json',
      'src/cli-bin.ts',
      'src/core.ts',
      'src/iam-plugin.ts',
      'src/pglite.ts',
      'src/postgres.ts',
      'tsconfig.json',
    ]);
    expect(files['src/pglite.ts']).toBe("export * from '@better-compute/postgres/pglite';\n");
    expect(files['src/iam-plugin.ts']).toBe("export * from '@better-compute/iam/plugin';\n");
    expect(files['src/cli-bin.ts']).toBe(
      "#!/usr/bin/env node\nimport { runBinary } from '@better-compute/cli';\nrunBinary();\n",
    );
  });

  it('generates exports in subpath order after the root entry', () => {
    expect(generated.exports).toEqual({
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './core': { types: './dist/core.d.ts', import: './dist/core.js' },
      './postgres': { types: './dist/postgres.d.ts', import: './dist/postgres.js' },
      './pglite': { types: './dist/pglite.d.ts', import: './dist/pglite.js' },
      './iam/plugin': { types: './dist/iam-plugin.d.ts', import: './dist/iam-plugin.js' },
    });
    expect(Object.keys(generated.exports)).toEqual([
      '.',
      './core',
      './postgres',
      './pglite',
      './iam/plugin',
    ]);
    expect(generated.bin).toEqual({ 'better-compute': './dist/cli-bin.js' });
  });

  it('owns dependencies: every re-exported package once, sorted, as workspace:*', () => {
    expect(generated.dependencies).toEqual({
      '@better-compute/cli': 'workspace:*',
      '@better-compute/core': 'workspace:*',
      '@better-compute/iam': 'workspace:*',
      '@better-compute/postgres': 'workspace:*',
    });
    expect(Object.keys(generated.dependencies)).toEqual([
      '@better-compute/cli',
      '@better-compute/core',
      '@better-compute/iam',
      '@better-compute/postgres',
    ]);
    expect(JSON.parse(files['tsconfig.json']).references).toEqual([
      { path: '../cli' },
      { path: '../core' },
      { path: '../iam' },
      { path: '../postgres' },
    ]);
  });

  it('declares optional peers, sorted', () => {
    expect(generated.peerDependencies).toEqual({
      '@better-iam/server': '^0.1.0',
      '@electric-sql/pglite': '^0.5.8',
    });
    expect(Object.keys(generated.peerDependencies)).toEqual([
      '@better-iam/server',
      '@electric-sql/pglite',
    ]);
    expect(generated.peerDependenciesMeta).toEqual({
      '@better-iam/server': { optional: true },
      '@electric-sql/pglite': { optional: true },
    });
  });

  it('keeps other fields and orders keys like the published manifest', () => {
    expect(Object.keys(generated)).toEqual([
      'name',
      'version',
      'description',
      'type',
      'license',
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
      'funding',
    ]);
    expect(generated.funding).toBe(manifest.funding);
    const generatedTsconfig = JSON.parse(files['tsconfig.json']);
    expect(Object.keys(generatedTsconfig)).toEqual([
      'extends',
      'compilerOptions',
      'include',
      'references',
    ]);
    expect(files['package.json'].endsWith('}\n')).toBe(true);
    expect(files['package.json']).toBe(JSON.stringify(generated, null, 2) + '\n');
  });

  it('drops the peer fields when there are no optional peers', () => {
    const withPeers = {
      ...manifest,
      peerDependencies: { a: '1' },
      peerDependenciesMeta: { a: { optional: true } },
    };
    const result = JSON.parse(
      generateUmbrella({ ...config, optionalPeers: {} }, withPeers, tsconfig)['package.json'],
    );
    expect(result).not.toHaveProperty('peerDependencies');
    expect(result).not.toHaveProperty('peerDependenciesMeta');
  });

  it('maps packages to their workspace directories', () => {
    const result = generateUmbrella(config, manifest, tsconfig, (name) =>
      name === '@better-compute/iam' ? 'iam-bridge' : name.split('/')[1],
    );
    expect(JSON.parse(result['tsconfig.json']).references).toContainEqual({
      path: '../iam-bridge',
    });
    expect(() => generateUmbrella(config, manifest, tsconfig, () => undefined)).toThrow(
      /is not a package in packages/,
    );
  });

  it('rejects configurations it cannot generate', () => {
    const attempt = (override: Record<string, unknown>) => () =>
      generateUmbrella({ ...config, ...override } as typeof config, manifest, tsconfig);
    expect(attempt({ subpaths: {} })).toThrow(/at least one subpath/);
    expect(attempt({ subpaths: { metal: '@better-compute/metal' } })).toThrow(/must look like/);
    expect(attempt({ subpaths: { './Metal/': '@better-compute/metal' } })).toThrow(
      /must look like/,
    );
    expect(attempt({ subpaths: { './metal': 'better-compute-metal' } })).toThrow(/@better-compute/);
    expect(attempt({ subpaths: { './index': '@better-compute/core' } })).toThrow(
      /overwrite src\/index.ts/,
    );
    expect(attempt({ subpaths: { './cli-bin': '@better-compute/cli' } })).toThrow(
      /overwrite src\/cli-bin.ts/,
    );
    expect(
      attempt({
        subpaths: {
          './iam/plugin': '@better-compute/iam/plugin',
          './iam-plugin': '@better-compute/iam',
        },
      }),
    ).toThrow(/both flatten to src\/iam-plugin.ts/);
    expect(attempt({ bin: {} })).toThrow(/exactly one command/);
    expect(attempt({ bin: { a: '@better-compute/cli', b: '@better-compute/cli' } })).toThrow(
      /exactly one/,
    );
  });
});

describe('the committed umbrella', () => {
  it('matches umbrella.json with no drift and no stale files', async () => {
    const plan = await planUmbrella(root);
    expect(plan.changed).toEqual([]);
    expect(plan.stale).toEqual([]);
  });

  it('exposes the four named subpaths of PLAN.md §4.4', async () => {
    const plan = await planUmbrella(root);
    const exports = JSON.parse(plan.files['package.json']).exports;
    for (const subpath of ['./inventory', './provision', './metal', './vps'])
      expect(exports).toHaveProperty([subpath]);
  });
});
