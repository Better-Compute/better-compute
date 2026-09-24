import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/** Tests run against source: every package specifier (and subpath) maps to its `src` file. */
const src = (path: string) => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));
const scoped: Record<string, string> = {
  '@better-compute/core/conformance': 'core/src/conformance.ts',
  '@better-compute/core': 'core/src/index.ts',
  '@better-compute/protocol': 'protocol/src/index.ts',
  '@better-compute/inventory': 'inventory/src/index.ts',
  '@better-compute/capacity': 'capacity/src/index.ts',
  '@better-compute/provision': 'provision/src/index.ts',
  '@better-compute/metal': 'metal/src/index.ts',
  '@better-compute/vps': 'vps/src/index.ts',
  '@better-compute/provider-hetzner': 'provider-hetzner/src/index.ts',
  '@better-compute/provider-proxmox': 'provider-proxmox/src/index.ts',
  '@better-compute/pki': 'pki/src/index.ts',
  '@better-compute/iam/plugin': 'iam/src/plugin.ts',
  '@better-compute/iam/testing': 'iam/src/testing.ts',
  '@better-compute/iam': 'iam/src/index.ts',
  '@better-compute/events': 'events/src/index.ts',
  '@better-compute/audit': 'audit/src/index.ts',
  '@better-compute/fleet': 'fleet/src/index.ts',
  '@better-compute/observability': 'observability/src/index.ts',
  'better-compute/iam/plugin': 'better-compute/src/iam-plugin.ts',
  'better-compute/iam/testing': 'better-compute/src/iam-testing.ts',
  '@better-compute/postgres/pglite': 'postgres/src/pglite.ts',
  '@better-compute/postgres/conformance': 'postgres/src/conformance.ts',
  '@better-compute/postgres': 'postgres/src/index.ts',
  '@better-compute/server': 'server/src/index.ts',
  '@better-compute/gateway': 'gateway/src/index.ts',
  '@better-compute/client': 'client/src/index.ts',
  '@better-compute/mcp': 'mcp/src/index.ts',
  '@better-compute/cli': 'cli/src/index.ts',
  '@better-compute/testing': 'testing/src/index.ts',
};
const umbrella = [
  'core',
  'protocol',
  'inventory',
  'capacity',
  'provision',
  'metal',
  'vps',
  'iam',
  'events',
  'fleet',
  'audit',
  'observability',
  'server',
  'gateway',
  'pki',
  'postgres',
  'pglite',
  'client',
  'cli',
  'mcp',
  'testing',
];
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
  resolve: {
    // Anchored regexes: a bare specifier never captures its own subpaths, so order does not matter.
    alias: [
      ...Object.entries(scoped).map(([find, path]) => ({
        find: new RegExp(`^${escape(find)}$`),
        replacement: src(path),
      })),
      ...umbrella.map((name) => ({
        find: new RegExp(`^better-compute/${escape(name)}$`),
        replacement: src(`better-compute/src/${name}.ts`),
      })),
      { find: /^better-compute$/, replacement: src('better-compute/src/index.ts') },
    ],
  },
});
