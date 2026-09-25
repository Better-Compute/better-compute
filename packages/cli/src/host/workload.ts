import type { AnyComputeOptions } from '../config.js';
import type { HostRoute } from './http.js';

// Workload identity (PLAN.md §12.2, v0.5): instances get short-lived OIDC tokens from their node's IMDS, minted by
// `ComputeOptions.workloadIdentity.issuer` (pki `createWorkloadIssuer`). Relying parties (better-iam's
// federation, cloud STS) fetch `<issuer>/.well-known/openid-configuration` and its `jwks_uri`, so the host serves
// both under the issuer URL's path. The issuer URL must reach this host (https on 443, per the issuer's contract).

interface PublishingIssuer {
  issuer: string;
  jwks(): { keys: JsonWebKey[] };
  discoveryDocument(): Record<string, unknown>;
}

function publishingIssuer(options: AnyComputeOptions): PublishingIssuer | undefined {
  const issuer = (options as { workloadIdentity?: { issuer?: Partial<PublishingIssuer> } }).workloadIdentity
    ?.issuer;
  return issuer &&
    typeof issuer.issuer === 'string' &&
    typeof issuer.jwks === 'function' &&
    typeof issuer.discoveryDocument === 'function'
    ? (issuer as PublishingIssuer)
    : undefined;
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      // Verifiers cache the keys; a rotation publishes the new key well before it signs (addKey, then promote).
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
    },
  });

/** `GET <issuer path>/.well-known/{openid-configuration,jwks.json}` when the deployment issues workload tokens. */
export function workloadRoutes(options: AnyComputeOptions): HostRoute[] {
  const issuer = publishingIssuer(options);
  if (!issuer) return [];
  const base = new URL(issuer.issuer).pathname.replace(/\/+$/, '');
  return [
    {
      path: `${base}/.well-known/openid-configuration`,
      method: ['GET', 'HEAD'],
      handler: () => json(issuer.discoveryDocument()),
    },
    {
      path: `${base}/.well-known/jwks.json`,
      method: ['GET', 'HEAD'],
      // Read on every request: a key added for rotation is visible at once.
      handler: () => json(issuer.jwks()),
    },
  ];
}
