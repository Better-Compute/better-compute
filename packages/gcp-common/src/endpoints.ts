import { ComputeError } from '@better-compute/core';

// Google Cloud hosts its APIs in a "universe": googleapis.com for the public cloud, another domain
// for a Trusted Partner Cloud or other sovereign deployment. The universe is host configuration:
// it comes from the options the host passes, never from a tenant's credentials (a key's own
// universe_domain is checked against it, and never selects it).

/** The public cloud's universe. */
export const defaultUniverse = 'googleapis.com';

const servicePattern = /^[a-z][a-z0-9-]*$/;
const universePattern = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function endpointError(message: string): ComputeError {
  return new ComputeError('INVALID_CONFIG', message, undefined, {
    provider: 'gcp',
    reason: 'endpoint',
  });
}

/**
 * Validates a universe domain and returns it (`undefined` is the default universe). A host that
 * passes a malformed one gets INVALID_CONFIG rather than a silently different endpoint.
 */
export function resolveUniverse(universeDomain?: string): string {
  if (universeDomain === undefined) return defaultUniverse;
  if (typeof universeDomain !== 'string' || !universePattern.test(universeDomain))
    throw endpointError(
      `The universe domain ${JSON.stringify(universeDomain)} is not a domain name (for example ${defaultUniverse})`,
    );
  return universeDomain;
}

/**
 * `https://<service>.<universe>`. INVALID_CONFIG (reason `endpoint`) unless `service` is a bare
 * service name (`/^[a-z][a-z0-9-]*$/`) and the universe a dotted lowercase domain.
 */
export function googleEndpoint(service: string, options: { universeDomain?: string } = {}): string {
  const universe = resolveUniverse(options.universeDomain);
  if (typeof service !== 'string' || !servicePattern.test(service))
    throw endpointError(`The Google service name ${JSON.stringify(service)} is not a service name`);
  return `https://${service}.${universe}`;
}

/** The OAuth token endpoint: `https://oauth2.googleapis.com/token`, or `https://oauth2.<universe>/token`. */
export function tokenEndpoint(universeDomain?: string): string {
  return `${googleEndpoint('oauth2', { universeDomain })}/token`;
}
