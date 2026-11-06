import { ComputeError, systemClock, type Clock } from '@better-compute/core';
import type { CredentialSource } from './credentials.js';
import { endpointFor } from './endpoints.js';
import { presignUrl } from './sigv4.js';

// The bearer token Amazon EKS's authenticator takes on a cluster's Kubernetes API: a presigned STS
// GetCallerIdentity URL whose signature covers the `x-k8s-aws-id` header naming the cluster, so a
// token minted for one cluster is refused by every other. EKS resolves the URL's identity to the
// principal's access entry. The token is a credential: it is never logged or put in an error.

/** How long a token's presigned URL is valid (EKS accepts a token for at most 15 minutes). */
export const eksTokenTtlSeconds = 60;
/** Tokens are `k8s-aws-v1.<base64url of the URL>`. */
export const eksTokenPrefix = 'k8s-aws-v1.';

/** An EKS cluster name: a letter or digit, then letters, digits, `-` and `_`, at most 100. */
export const eksClusterNamePattern = /^[0-9A-Za-z][A-Za-z0-9_-]{0,99}$/;

export interface EksTokenOptions {
  cluster: string;
  credentials: CredentialSource;
  region: string;
  signal?: AbortSignal;
  clock?: Clock;
  /** Host option only (VPC endpoints, tests): the STS endpoint to presign for. */
  stsEndpoint?: string;
}

/** `k8s-aws-v1.<base64url>`: a presigned STS `GetCallerIdentity` with the cluster header. */
export async function eksToken(options: EksTokenOptions): Promise<string> {
  if (typeof options.cluster !== 'string' || !eksClusterNamePattern.test(options.cluster))
    throw new ComputeError('INVALID_INPUT', 'not an EKS cluster name', undefined, {
      provider: 'aws',
      reason: 'cluster',
    });
  const endpoint = endpointFor('sts', options.region, {
    ...(options.stsEndpoint !== undefined ? { override: options.stsEndpoint } : {}),
  });
  const clock = options.clock ?? systemClock;
  const credentials = await options.credentials.credentials({
    signal: options.signal ?? new AbortController().signal,
    clock,
  });
  const url = new URL(endpoint.toString());
  url.pathname = '/';
  url.search = '?Action=GetCallerIdentity&Version=2011-06-15';
  const presigned = presignUrl({
    method: 'GET',
    url,
    headers: { 'x-k8s-aws-id': options.cluster },
    service: 'sts',
    region: options.region,
    credentials,
    now: clock.now(),
    expiresInSeconds: eksTokenTtlSeconds,
    // STS checks the empty-payload hash on a presigned GET (UNSIGNED-PAYLOAD is S3's).
    unsignedPayload: false,
  });
  return `${eksTokenPrefix}${Buffer.from(presigned, 'utf8').toString('base64url')}`;
}
