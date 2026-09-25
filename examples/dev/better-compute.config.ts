// The development example: every module on PGlite, run with `better-compute dev --sim 8`.
import { defineConfig } from '@better-compute/server';
import { exampleHost, exampleOptions } from '../shared/compose.ts';

export default defineConfig(({ env, cwd } = {}) =>
  exampleOptions({ ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) }),
);

export const host = exampleHost;
