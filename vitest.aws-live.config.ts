import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

/**
 * The AWS live suite (A12): real calls into a dedicated sandbox account, never in CI or the default
 * run. Each file skips unless BETTER_COMPUTE_AWS_LIVE=1, and then needs BETTER_COMPUTE_AWS_LIVE_ACCOUNT,
 * BETTER_COMPUTE_AWS_LIVE_BUDGET_USD and the sandbox credentials (tests/live/aws/README.md).
 *
 *   node node_modules/vitest/vitest.mjs run --config vitest.aws-live.config.ts
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['tests/live/aws/**/*.live.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 20 * 60_000,
    hookTimeout: 30 * 60_000,
    // One file at a time: each run's resources are counted against one budget.
    fileParallelism: false,
  },
});
