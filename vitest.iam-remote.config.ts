import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

/**
 * The IAM-dependent suites again in remote IAM mode (PLAN.md §16 v0.4 "suites green in both IAM modes"):
 * `createEmbeddedTestIam` hands compute `bridge.remote(...)` over better-iam's HTTP API, with the admission
 * refresh, instead of `bridge.embedded(...)`. Same better-iam, plugin and resolver; only the port differs.
 *
 *   node node_modules/vitest/vitest.mjs run --config vitest.iam-remote.config.ts
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'tests/server-example-policies.test.ts',
      'tests/iam-resolver-timeout.test.ts',
      'tests/iam-bridge-confirmation.test.ts',
      'tests/iam-bridge-testing.test.ts',
      'tests/iam-bridge-streams.test.ts',
      'tests/mcp-e2e-confirmation.test.ts',
      'tests/cli-host-watch.test.ts',
      'tests/e2e/access.test.ts',
      'tests/e2e/spine.test.ts',
    ],
    env: { ...base.test?.env, BETTER_COMPUTE_IAM_MODE: 'remote' },
  },
});
