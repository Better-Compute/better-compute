import { ComputeError, type SecretRef, type SecretResolveContext } from '@better-compute/core';

// local-sealed's tenant ids allow `.` and `:` (pki/src/secrets.ts). `.` is valid in Secrets
// Manager names, SSM parameter paths and S3 keys, so it is allowed here except as a whole `.`/`..`
// segment; `:` is not valid in SSM or Secrets Manager names, so such tenants cannot use these stores.
const segmentPattern = /^[A-Za-z0-9._-]{1,128}$/;
const segment = { source: segmentPattern.source, test: (value: string) => segmentPattern.test(value) && value !== '.' && value !== '..' };

/** A parsed `secret://<store>/<tenantId>/<id>` ref of one of this package's stores. */
export interface AwsSecretRef {
  tenantId: string;
  id: string;
}

/** Validates a tenant id or secret id as one path segment (no `/`, `.`, `..` or control characters). */
export function checkSegment(value: string, what: string): string {
  if (typeof value !== 'string' || !segment.test(value))
    throw new ComputeError('INVALID_INPUT', `${what} must match ${segment.source} and not be . or ..`);
  return value;
}

export function formatAwsSecretRef(store: string, tenantId: string, id: string): SecretRef {
  return `secret://${store}/${checkSegment(tenantId, 'tenant id')}/${checkSegment(id, 'secret id')}`;
}

/**
 * Parses and validates a ref of `store`, then checks the tenant: a context whose tenant is not the
 * ref's is `ACCESS_DENIED`. Both happen before any AWS call.
 */
export function parseAwsSecretRef(
  store: string,
  ref: string,
  context?: { tenantId: string } | SecretResolveContext,
): AwsSecretRef {
  const prefix = `secret://${store}/`;
  if (typeof ref !== 'string' || !ref.startsWith(prefix))
    throw new ComputeError('INVALID_INPUT', `this store serves ${prefix}<tenant>/<id> refs`);
  const parts = ref.slice(prefix.length).split('/');
  if (parts.length !== 2 || !segment.test(parts[0]!) || !segment.test(parts[1]!))
    throw new ComputeError('INVALID_INPUT', `a secret ref is ${prefix}<tenant>/<id>`);
  const parsed = { tenantId: parts[0]!, id: parts[1]! };
  if (context && context.tenantId !== parsed.tenantId)
    throw new ComputeError('ACCESS_DENIED', 'the secret belongs to another tenant');
  return parsed;
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Name prefixes: `/`-separated segments of `[A-Za-z0-9_.-]`, never `.` or `..`. */
export function checkNamePrefix(prefix: string, leadingSlash: boolean): string {
  const body = leadingSlash ? prefix.replace(/^\//, '') : prefix;
  const parts = body.split('/');
  if (
    (leadingSlash && !prefix.startsWith('/')) ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')
  )
    throw new ComputeError('INVALID_CONFIG', 'the secret name prefix is not a valid name path');
  return prefix;
}
