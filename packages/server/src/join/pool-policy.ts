import { ComputeError, type PoolPolicyValidator } from '@better-compute/core';

/**
 * `pools.create`/`pools.update` refuse a `policy.joinAttestors` that names an attestor JoinService does not run
 * (`join-token` and the registered attestors): such a pool could admit no machine, or one by a typo.
 */
export function joinAttestorsValidator(known: ReadonlySet<string>): PoolPolicyValidator {
  return Object.freeze({
    extension: 'pool-policy' as const,
    id: 'server.join-attestors',
    async validate(policy: Readonly<Record<string, unknown>>) {
      const listed = policy.joinAttestors;
      if (listed === undefined) return;
      if (
        !Array.isArray(listed) ||
        listed.length === 0 ||
        listed.length > 16 ||
        !listed.every((id) => typeof id === 'string')
      )
        throw new ComputeError('INVALID_INPUT', 'policy.joinAttestors must list 1 to 16 attestor ids');
      for (const id of listed as string[])
        if (!known.has(id))
          throw new ComputeError(
            'INVALID_INPUT',
            `policy.joinAttestors: ${JSON.stringify(id)} is not an attestor this control plane runs (${[...known].sort().join(', ')})`,
          );
    },
  });
}
