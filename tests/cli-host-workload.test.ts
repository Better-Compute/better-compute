import { describe, expect, it } from 'vitest';
import { checkHostRoutes, workloadRoutes } from '@better-compute/cli';
import { createWorkloadIssuer } from '@better-compute/pki';

// Workload identity's public documents (PLAN.md §12.2): `serve` publishes the issuer's OIDC discovery document and
// JWKS under the issuer URL's path, so relying parties can verify instance tokens.

describe('workloadRoutes', () => {
  it('serves the discovery document and the JWKS under the issuer path', async () => {
    const issuer = createWorkloadIssuer({
      issuer: 'https://compute.example.com/workload',
      defaultAudience: 'https://iam.example.com',
    });
    const routes = workloadRoutes({ workloadIdentity: { issuer } } as never);
    expect(routes.map((route) => route.path)).toEqual([
      '/workload/.well-known/openid-configuration',
      '/workload/.well-known/jwks.json',
    ]);
    // They fit beside the API and the built-ins.
    expect(() => checkHostRoutes(routes, '/api/compute')).not.toThrow();
    const discovery = await (await routes[0]!.handler(new Request('https://x/'))).json();
    expect(discovery).toMatchObject({
      issuer: 'https://compute.example.com/workload',
      jwks_uri: 'https://compute.example.com/workload/.well-known/jwks.json',
    });
    const jwks = (await (await routes[1]!.handler(new Request('https://x/'))).json()) as {
      keys: { kty: string; d?: string }[];
    };
    expect(jwks.keys.length).toBeGreaterThan(0);
    expect(jwks.keys.every((key) => key.kty === 'EC' && key.d === undefined)).toBe(true);
    // A key added for rotation is published at once.
    issuer.addKey();
    const rotated = (await (await routes[1]!.handler(new Request('https://x/'))).json()) as { keys: unknown[] };
    expect(rotated.keys.length).toBe(jwks.keys.length + 1);
  });

  it('serves nothing without a publishing issuer', () => {
    expect(workloadRoutes({} as never)).toEqual([]);
    expect(workloadRoutes({ workloadIdentity: { issuer: { issuer: 'https://x', issue() {} } } } as never)).toEqual([]);
    const root = createWorkloadIssuer({ issuer: 'https://compute.example.com', defaultAudience: 'a' });
    expect(workloadRoutes({ workloadIdentity: { issuer: root } } as never).map((route) => route.path)).toEqual([
      '/.well-known/openid-configuration',
      '/.well-known/jwks.json',
    ]);
  });
});
