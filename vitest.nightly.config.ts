import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

/** The nightly simulation matrix (`pnpm sim:nightly`): same aliases as the test suite, run on demand only. */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['tests/nightly/**/*.nightly.ts'],
    testTimeout: 6 * 60 * 60_000,
    hookTimeout: 30 * 60_000,
    // Seeds run one after another: each is CPU-bound, and reports stay comparable.
    fileParallelism: false,
  },
});
