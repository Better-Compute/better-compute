// The production-shaped example: every module on PostgreSQL, one configuration for every process role.
//   better-compute migrate
//   better-compute serve --roles api --port 3000
//   better-compute serve --roles controllers,scheduler,sinks,iam --no-migrate
//   better-compute serve --roles gateway --no-migrate
import { defineConfig } from '@better-compute/server';
import { exampleHost, exampleOptions } from '../shared/compose.ts';

export default defineConfig(({ env, cwd } = {}) =>
  exampleOptions({
    ...(env ? { env } : {}),
    ...(cwd ? { cwd } : {}),
    // pglite: URLs are refused here, except in the repository's smoke test (EXAMPLES_ALLOW_PGLITE).
    requirePostgres: !(env ?? process.env).EXAMPLES_ALLOW_PGLITE,
  }),
);

export const host = exampleHost;
