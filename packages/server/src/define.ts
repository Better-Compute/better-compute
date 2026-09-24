import type { ComputeModule, ComputePlugin } from '@better-compute/core';
import type { ComputeOptions } from './options.js';

/** What a configuration factory receives when the `better-compute` CLI (or your code) calls it. */
export interface ComputeConfigContext {
  /** The CLI command being run (`migrate`, `serve`, `dev`, …); absent when your server calls it. */
  command?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

/** Options computed on demand, so importing the config module opens no database. */
export type ComputeConfigFactory<
  M extends readonly ComputeModule[] = readonly ComputeModule[],
  P extends readonly ComputePlugin[] = readonly ComputePlugin[],
> = (context?: ComputeConfigContext) => ComputeOptions<M, P> | Promise<ComputeOptions<M, P>>;

/**
 * Types a deployment configuration for `better-compute.config.ts`: options, or a factory of them
 * that receives `{ command, env, cwd }` from the CLI. It returns its argument unchanged.
 *
 * ```ts
 * export default defineConfig(({ env = process.env } = {}) => ({
 *   database: postgres({ url: env.BETTER_COMPUTE_DATABASE_URL! }),
 *   secret: env.BETTER_COMPUTE_SECRET!,
 *   baseURL: 'https://compute.example.com',
 *   rootTenantId,
 *   iam: bridge.embedded(iam, { rootTenantId }),
 * }));
 * // In the server: const compute = betterCompute(await configOptions(config));
 * ```
 */
export function defineConfig<
  const M extends readonly ComputeModule[] = [],
  const P extends readonly ComputePlugin[] = [],
>(config: ComputeOptions<M, P>): ComputeOptions<M, P>;
export function defineConfig<
  const M extends readonly ComputeModule[] = [],
  const P extends readonly ComputePlugin[] = [],
>(factory: ComputeConfigFactory<M, P>): ComputeConfigFactory<M, P>;
export function defineConfig(config: unknown): unknown {
  return config;
}

/**
 * The options a `defineConfig` value stands for: a factory is called with `context` (default: this
 * process's environment and working directory); plain options are returned as they are.
 */
export async function configOptions<
  M extends readonly ComputeModule[],
  P extends readonly ComputePlugin[],
>(
  config: ComputeOptions<M, P> | ComputeConfigFactory<M, P>,
  context: ComputeConfigContext = { env: process.env, cwd: process.cwd() },
): Promise<ComputeOptions<M, P>> {
  return typeof config === 'function' ? config(context) : config;
}
