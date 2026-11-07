import { ComputeError } from '@better-compute/core';
import type { DoKindEnv } from '../kind.js';

// Ownership by name, for DigitalOcean objects that carry no tags (guardrails, Managed Agents): the name ends in
// `-bc<deployment hash>`, so this deployment finds what it made (a create whose answer was lost included) and tells
// its objects from another deployment's and from ones made by hand. Model access keys use a longer shape of their own
// (`-r<rotation>-bc<hash>`, inference-keys.ts).

const suffix = /^(.+)-bc([0-9a-f]{12})$/;

const deploymentHash = (env: DoKindEnv) =>
  env.deploymentTag.slice(env.deploymentTag.indexOf(':') + 1);

/** The name a new object of this deployment gets. */
export const ownedName = (env: DoKindEnv, name: string): string =>
  `${name}-bc${deploymentHash(env)}`;

/** `this` when the name says this deployment made it, `other` when another one did, else undefined. */
export function nameOwner(
  env: DoKindEnv,
  name: string | null | undefined,
): 'this' | 'other' | undefined {
  const match = suffix.exec(name ?? '');
  if (!match) return undefined;
  return match[2] === deploymentHash(env) ? 'this' : 'other';
}

/** Throws `INVALID_STATE` (`notManaged`) unless the name says this deployment made it. Nothing is sent then. */
export function assertNameOwned(
  env: DoKindEnv,
  name: string | null | undefined,
  what: string,
): void {
  if (nameOwner(env, name) !== 'this')
    throw new ComputeError(
      'INVALID_STATE',
      `${what} is not managed by this better-compute deployment; it is left alone`,
      undefined,
      { provider: 'digitalocean', reason: 'notManaged' },
    );
}
