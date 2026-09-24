import { describe, expect, it } from 'vitest';
import { checkDeps, isNodeBuiltin, serverMayNotUse } from '../scripts/check-deps.mjs';
import { importSpecifiers, packageName, stringChunks } from '../scripts/source-scan.mjs';

interface FakePackage {
  dir: string;
  manifest: Record<string, unknown>;
  tsconfig?: { references?: { path: string }[] };
  sources: Record<string, string>;
}

/** A package whose tsconfig references mirror its `workspace:*` dependencies. */
function pkg(
  name: string,
  options: {
    deps?: string[];
    manifest?: Record<string, unknown>;
    references?: string[];
    sources?: Record<string, string>;
  } = {},
): FakePackage {
  const folder = name.replace(/^@better-compute\//, '');
  const deps = options.deps ?? [];
  return {
    dir: `packages/${folder}`,
    manifest: {
      name,
      dependencies: Object.fromEntries(deps.map((dep) => [dep, 'workspace:*'])),
      ...options.manifest,
    },
    tsconfig: {
      references: (
        options.references ?? deps.map((dep) => dep.replace(/^@better-compute\//, ''))
      ).map((folder) => ({ path: `../${folder}` })),
    },
    sources: options.sources ?? { 'src/index.ts': 'export {};\n' },
  };
}

const base = () => [
  pkg('@better-compute/core'),
  pkg('@better-compute/protocol'),
  pkg('@better-compute/inventory', { deps: ['@better-compute/core', '@better-compute/protocol'] }),
  pkg('@better-compute/provision', { deps: ['@better-compute/core'] }),
  pkg('@better-compute/metal', { deps: ['@better-compute/core', '@better-compute/provision'] }),
  pkg('@better-compute/postgres', { deps: ['@better-compute/core'] }),
];
const rules = (packages: FakePackage[]) => checkDeps(packages).map((violation) => violation.rule);

describe('importSpecifiers', () => {
  it('reads static, re-export, side-effect, dynamic, type and require specifiers', () => {
    const source = `#!/usr/bin/env node
import { a, type B } from './a.js';
import type { C } from "@better-compute/core";
import * as ns from '@better-compute/metal/drivers';
import './side-effect.js';
export * from '@better-compute/inventory';
export { d as from } from './d.js';
export type { E } from './e.js';
const lazy = await import('@better-compute/testing');
const late = await import(\`@better-compute/postgres/pglite\`, { with: {} });
type T = import('node:http').Server;
const legacy = require('otplib');
`;
    expect(importSpecifiers(source)).toEqual([
      './a.js',
      '@better-compute/core',
      '@better-compute/metal/drivers',
      './side-effect.js',
      '@better-compute/inventory',
      './d.js',
      './e.js',
      '@better-compute/testing',
      '@better-compute/postgres/pglite',
      'node:http',
      'otplib',
    ]);
  });

  it('ignores comments, strings, property access and computed imports', () => {
    const source = `/**
 * import { metal } from 'better-compute/metal';
 */
// import { vps } from '@better-compute/vps';
const text = "import { x } from '@better-compute/iam'";
const template = \`export * from '@better-compute/gateway';\`;
const url = import.meta.url;
const list = Array.from('abc');
const pattern = /['"]from '@better-compute\\/provider-x'/;
const name = '@better-compute/postgres';
await import(name);
const obj = { from: 'nowhere', import: 'nothing' };
`;
    expect(importSpecifiers(source)).toEqual([]);
  });

  it('keeps code inside template substitutions and ignores the template text', () => {
    const source = "const s = `a ${await import('./inner.js')} from 'not-a-module'`;\n";
    expect(importSpecifiers(source)).toEqual(['./inner.js']);
    expect(stringChunks(source).map((chunk) => chunk.text)).toEqual([
      'a ',
      './inner.js',
      " from 'not-a-module'",
    ]);
  });

  it('tells regular expressions from division', () => {
    const source = `const half = total / 2 / count;
const quote = /'/g;
import { z } from './after-regex.js';
`;
    expect(importSpecifiers(source)).toEqual(['./after-regex.js']);
  });
});

describe('package classification', () => {
  it('names the package of a specifier', () => {
    expect(packageName('@better-compute/postgres/pglite')).toBe('@better-compute/postgres');
    expect(packageName('better-compute/metal')).toBe('better-compute');
    expect(packageName('kysely')).toBe('kysely');
    expect(packageName('./local.js')).toBeUndefined();
    expect(packageName('node:fs')).toBeUndefined();
    expect(packageName('#internal')).toBeUndefined();
  });

  it('knows what server may not use', () => {
    for (const name of [
      '@better-compute/provision',
      '@better-compute/metal',
      '@better-compute/vps',
      '@better-compute/gateway',
      '@better-compute/iam',
      '@better-compute/postgres',
      '@better-compute/provider-hetzner',
      '@better-compute/driver-sdk',
      'better-compute',
    ])
      expect(serverMayNotUse(name), name).toBe(true);
    for (const name of [
      '@better-compute/core',
      '@better-compute/protocol',
      '@better-compute/inventory',
      '@better-compute/capacity',
      '@better-compute/pki',
      'kysely',
    ])
      expect(serverMayNotUse(name), name).toBe(false);
  });

  it('recognizes Node.js built-ins with and without the node: prefix', () => {
    expect(isNodeBuiltin('node:crypto')).toBe(true);
    expect(isNodeBuiltin('node:test')).toBe(true);
    expect(isNodeBuiltin('fs')).toBe(true);
    expect(isNodeBuiltin('fs/promises')).toBe(true);
    expect(isNodeBuiltin('@better-compute/core')).toBe(false);
    expect(isNodeBuiltin('./fs.js')).toBe(false);
  });
});

describe('checkDeps', () => {
  it('accepts a workspace that follows the rules', () => {
    const server = pkg('@better-compute/server', {
      deps: ['@better-compute/core', '@better-compute/inventory'],
      sources: {
        'src/index.ts': `import { inventoryModule } from '@better-compute/inventory';
/** Hosts pass modules in: import { metal } from 'better-compute/metal'. */
export { inventoryModule };
`,
      },
    });
    expect(checkDeps([...base(), server])).toEqual([]);
  });

  it('holds trivially for packages that do not exist yet', () => {
    expect(checkDeps([])).toEqual([]);
    expect(checkDeps([pkg('@better-compute/client', { deps: [] })])).toEqual([]);
  });

  it('rejects server manifests that name injected modules, outer packages or drivers', () => {
    const server = pkg('@better-compute/server', {
      deps: ['@better-compute/core', '@better-compute/postgres'],
      manifest: {
        peerDependencies: { '@better-compute/driver-sdk': '^0.1.0' },
        devDependencies: { '@better-compute/provider-hetzner': '^0.1.0' },
      },
    });
    const violations = checkDeps([...base(), server]).filter((v) => v.rule === 'server-boundary');
    expect(violations.map((v) => v.message)).toEqual([
      expect.stringContaining('dependencies names @better-compute/postgres'),
      expect.stringContaining('devDependencies names @better-compute/provider-hetzner'),
      expect.stringContaining('peerDependencies names @better-compute/driver-sdk'),
    ]);
  });

  it('rejects server imports of injected modules, including type-only, dynamic and umbrella imports', () => {
    const server = pkg('@better-compute/server', {
      deps: ['@better-compute/core'],
      sources: {
        'src/index.ts': 'export {};\n',
        'src/modules.ts': "import type { MetalOptions } from '@better-compute/metal';\n",
        'src/api/vps.ts': "const vps = await import('@better-compute/vps');\n",
        'src/store.ts': "export { pglite } from '@better-compute/postgres/pglite';\n",
        'src/umbrella.ts': "import { metal } from 'better-compute/metal';\n",
      },
    });
    const messages = checkDeps([...base(), server])
      .filter((v) => v.rule === 'server-boundary')
      .map((v) => v.message);
    expect(messages).toHaveLength(4);
    expect(messages.join('\n')).toContain(
      'packages/server/src/modules.ts imports @better-compute/metal',
    );
    expect(messages.join('\n')).toContain(
      'packages/server/src/api/vps.ts imports @better-compute/vps',
    );
    expect(messages.join('\n')).toContain('imports @better-compute/postgres/pglite');
    expect(messages.join('\n')).toContain('imports better-compute/metal');
  });

  it('follows core root-entry imports and flags Node.js built-ins', () => {
    const core = pkg('@better-compute/core', {
      sources: {
        'src/index.ts': "export * from './ids.js';\nexport type { Clock } from './clock.js';\n",
        'src/ids.ts': "import { randomUUID } from 'node:crypto';\nexport const id = randomUUID;\n",
        'src/clock.ts': "import './deep/time.js';\nexport interface Clock {}\n",
        'src/deep/time.ts': "import { setTimeout } from 'timers/promises';\n",
        'src/unreachable.ts': "import { readFile } from 'node:fs/promises';\n",
        'src/conformance.ts': "import { strict } from 'node:assert';\n",
      },
    });
    const messages = checkDeps([core]).map((v) => v.message);
    expect(messages).toEqual([
      expect.stringContaining('packages/core/src/ids.ts imports node:crypto'),
      expect.stringContaining('packages/core/src/deep/time.ts imports timers/promises'),
    ]);
  });

  it('does not walk into conformance.ts from the root entry', () => {
    const core = pkg('@better-compute/core', {
      sources: {
        'src/index.ts': "export type { Case } from './conformance.js';\n",
        'src/conformance.ts': "import { strict } from 'node:assert';\nexport interface Case {}\n",
      },
    });
    expect(checkDeps([core])).toEqual([]);
  });

  it('requires workspace dependencies and tsconfig references to match both ways', () => {
    const missingReference = pkg('@better-compute/inventory', {
      deps: ['@better-compute/core', '@better-compute/protocol'],
      references: ['core'],
    });
    const extraReference = pkg('@better-compute/client', {
      deps: ['@better-compute/core'],
      references: ['core', 'protocol'],
    });
    const unknown = pkg('@better-compute/cli', {
      deps: ['@better-compute/core', '@better-compute/nope'],
      references: ['core', 'ghost'],
    });
    const devOnly = pkg('@better-compute/testing', {
      manifest: { devDependencies: { '@better-compute/core': 'workspace:*' } },
      references: [],
    });
    const messages = checkDeps([
      pkg('@better-compute/core'),
      pkg('@better-compute/protocol'),
      missingReference,
      extraReference,
      unknown,
      devOnly,
    ]).map((v) => `${v.rule}: ${v.message}`);
    expect(messages).toEqual([
      expect.stringMatching(
        /^references: packages\/inventory depends on @better-compute\/protocol but .*\.\.\/protocol$/,
      ),
      expect.stringMatching(
        /^references: packages\/client\/tsconfig.json references \.\.\/protocol but/,
      ),
      expect.stringMatching(
        /^references: packages\/cli\/package.json dependencies names @better-compute\/nope/,
      ),
      expect.stringMatching(
        /^references: packages\/cli\/tsconfig.json references \.\.\/ghost, which is not/,
      ),
      expect.stringMatching(/^references: packages\/testing depends on @better-compute\/core/),
    ]);
  });

  it('ignores non-workspace dependencies and workspace peers for references', () => {
    const cli = pkg('@better-compute/cli', {
      deps: ['@better-compute/core'],
      manifest: {
        dependencies: { '@better-compute/core': 'workspace:*', kysely: '^0.28.8' },
        peerDependencies: { '@better-compute/testing': 'workspace:*' },
      },
    });
    expect(checkDeps([pkg('@better-compute/core'), pkg('@better-compute/testing'), cli])).toEqual(
      [],
    );
  });

  it('rejects any package that imports or depends on a provider', () => {
    const vps = pkg('@better-compute/vps', {
      deps: ['@better-compute/core'],
      manifest: { optionalDependencies: { '@better-compute/provider-proxmox': '^0.1.0' } },
      sources: {
        'src/index.ts': "import { hetzner } from '@better-compute/provider-hetzner/cloud';\n",
      },
    });
    const provider = pkg('@better-compute/provider-hetzner', {
      deps: ['@better-compute/core'],
      sources: { 'src/cloud.ts': "export * from '@better-compute/provider-hetzner/robot';\n" },
    });
    const violations = checkDeps([pkg('@better-compute/core'), vps, provider]);
    expect(violations.map((v) => v.rule)).toEqual(['providers', 'providers']);
    expect(violations.map((v) => v.message).join('\n')).toContain(
      'optionalDependencies names @better-compute/provider-proxmox',
    );
    expect(violations.map((v) => v.message).join('\n')).toContain(
      'packages/vps/src/index.ts imports @better-compute/provider-hetzner/cloud',
    );
  });

  it('reports each rule independently', () => {
    const packages = [
      pkg('@better-compute/core', { sources: { 'src/index.ts': "import 'node:fs';\n" } }),
      pkg('@better-compute/server', {
        deps: ['@better-compute/core'],
        references: ['core', 'metal'],
        sources: { 'src/index.ts': "import '@better-compute/metal';\n" },
      }),
      pkg('@better-compute/metal', { deps: ['@better-compute/core'] }),
    ];
    expect(rules(packages).sort()).toEqual(['core-browser-safe', 'references', 'server-boundary']);
  });
});
