import { ComputeError, type ErrorCode, type ProviderResourceState } from '@better-compute/core';

// Shared pieces of the DOKS driver: ids, names, errors and the state shape.

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** DOKS cluster and node pool names: lowercase letters, digits and hyphens, at most 63. */
export const doksNamePattern = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const regionPattern = /^[a-z][a-z0-9]{1,15}$/;

export function fail(
  code: ErrorCode,
  message: string,
  reason: string,
  extra: Record<string, unknown> = {},
): ComputeError {
  return new ComputeError(code, message, undefined, {
    provider: 'digitalocean',
    reason,
    ...extra,
  });
}

export function invalid(message: string, reason: string): ComputeError {
  return fail('INVALID_INPUT', message, reason);
}

export function checkName(value: unknown, what: string): string {
  if (typeof value !== 'string' || !doksNamePattern.test(value))
    throw invalid(
      `${what} ${JSON.stringify(value)} is not a DOKS name (lowercase letters, digits and hyphens, at most 63)`,
      'name',
    );
  return value;
}

/** A region of the account (`config.regions`); anything else is INVALID_INPUT. */
export function checkRegion(value: unknown, regions: readonly string[]): string {
  if (typeof value !== 'string' || !regionPattern.test(value) || !regions.includes(value))
    throw invalid(
      `${JSON.stringify(value)} is not one of the account's DigitalOcean regions (${regions.join(', ')})`,
      'region',
    );
  return value;
}

/** A cluster's id is its DOKS uuid. */
export function parseClusterId(id: unknown): string {
  if (typeof id !== 'string' || !uuidPattern.test(id))
    throw invalid(`${JSON.stringify(id)} is not a DOKS cluster id (a uuid)`, 'clusterId');
  return id;
}

/** A node pool's id: `<cluster uuid>/<pool name>`. */
export function nodePoolId(cluster: string, name: string): string {
  return `${cluster}/${name}`;
}

export const resourceState = (
  id: string,
  value: ProviderResourceState['state'],
  extra: { message?: string; outputs?: Record<string, string> } = {},
): ProviderResourceState => ({
  id,
  state: value,
  ...(extra.outputs && Object.keys(extra.outputs).length ? { outputs: extra.outputs } : {}),
  ...(extra.message !== undefined ? { message: extra.message } : {}),
});

/** NOT_FOUND for a cluster that is not there (or not ours to touch). */
export function clusterNotFound(cluster: string): ComputeError {
  return fail('NOT_FOUND', `DOKS cluster ${cluster} does not exist`, 'clusterNotFound', {
    status: 404,
  });
}
