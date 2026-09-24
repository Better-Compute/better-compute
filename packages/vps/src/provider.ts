import { ComputeError, type ProviderDefinition, type ProviderInput } from '@better-compute/core';

const providerKeys = ['id', 'version', 'provides', 'config', 'capabilities', 'create'];
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const kinds = ['metal', 'vps'];

function isStandardSchema(value: unknown): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  const props = (value as { '~standard'?: { version?: unknown; validate?: unknown } })['~standard'];
  return props?.version === 1 && typeof props.validate === 'function';
}

/**
 * Declares an external capacity provider (§3.6, §5.4), such as `hetzner-cloud`. The definition is
 * code; each provider account is data validated by `config` and turned into a client by
 * `create(config, context)`. Shapes are checked up front (`INVALID_CONFIG`); the definition is
 * returned frozen with `extension: 'provider'`. `providerConformance` (v0.3) checks the client.
 *
 * ```ts
 * export const acmeCloud = defineProvider({ id: 'acme-cloud', version: '1.0.0', provides: ['vps'],
 *   config: manifest({ token: field.secret() }), create: (config, context) => acmeClient(config) });
 * ```
 */
export function defineProvider<C>(provider: ProviderInput<C>): ProviderDefinition<C> {
  const candidate = provider as unknown as Record<string, unknown>;
  const subject =
    typeof candidate?.id === 'string' ? `Provider ${candidate.id.slice(0, 64)}` : 'Provider';
  const fail = (path: string, message: string): never => {
    throw new ComputeError(
      'INVALID_CONFIG',
      `${subject}: ${path ? `${path} ` : ''}${message}`,
      undefined,
      { path },
    );
  };
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))
    fail('', 'must be an object');
  for (const key of Object.keys(candidate))
    if (!providerKeys.includes(key)) fail(key, 'is not a known field');
  if (typeof candidate.id !== 'string' || !idPattern.test(candidate.id))
    fail('id', 'must be lower-case letters, digits and hyphens, starting with a letter');
  if (typeof candidate.version !== 'string' || !versionPattern.test(candidate.version))
    fail('version', 'must be a version string such as 1.0.0');
  const provides = candidate.provides;
  if (
    !Array.isArray(provides) ||
    provides.length === 0 ||
    new Set(provides).size !== provides.length ||
    !provides.every((kind) => kinds.includes(kind))
  )
    fail('provides', "must list 'metal', 'vps' or both, once each");
  if (!isStandardSchema(candidate.config))
    fail('config', 'must be a manifest or another Standard Schema');
  const capabilities = candidate.capabilities;
  if (
    capabilities !== undefined &&
    !(
      Array.isArray(capabilities) &&
      capabilities.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 64)
    )
  )
    fail('capabilities', 'must be a list of non-empty strings');
  if (typeof candidate.create !== 'function') fail('create', 'must be a function');
  return Object.freeze({ ...provider, extension: 'provider' as const });
}
