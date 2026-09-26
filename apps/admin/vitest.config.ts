import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests for the admin's pure logic (data sources, view models). Run from the repo root:
//   node node_modules/vitest/vitest.mjs run --config apps/admin/vitest.config.ts
// Components are not rendered here; the dev server and the browser cover them.
export default defineConfig({
  test: {
    include: ['apps/admin/tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
  resolve: {
    alias: [{ find: /^@\//, replacement: `${fileURLToPath(new URL('./', import.meta.url))}` }],
  },
});
