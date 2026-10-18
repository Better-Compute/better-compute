import { describe, expect, it } from 'vitest';
import {
  isComputeError,
  type ComputeModule,
  type ModuleContext,
  type SqlExecutor,
} from '@better-compute/core';
import { generateP256KeyPair, workloadIssuer } from '@better-compute/pki';
import { betterCompute } from '@better-compute/server';
import { fakeIam } from './support/fake-iam.js';
import { BASE_URL, options } from './support/server.js';

// The workload issuer's public surface (GCP WS1, keyless tenant accounts): Google's workload identity
// federation fetches `<issuer>/.well-known/openid-configuration` and then its `jwks_uri`, with no
// credentials. `pki.workloadIssuer` mounts both below `{basePath}/workload`, and modules mint through
// `context.pki.workload`.

const ISSUER = `${BASE_URL}/api/compute/workload`;

/** The GET routes touch no store: an executor that refuses everything proves it. */
const noStore = {
  dialect: 'postgres',
  kind: 'pglite',
  query: () => Promise.reject(new Error('no store in this test')),
  transaction: () => Promise.reject(new Error('no store in this test')),
  migrate: () => Promise.reject(new Error('no store in this test')),
  close: async () => {},
} as unknown as SqlExecutor;

function issuer(url = ISSUER) {
  return workloadIssuer({ issuer: url, signingKey: generateP256KeyPair().privateKey });
}

function server(
  workload: ReturnType<typeof issuer> | undefined,
  extra: { modules?: ComputeModule[]; basePath?: string } = {},
) {
  return betterCompute({
    ...options(noStore, fakeIam()),
    ...(extra.basePath ? { basePath: extra.basePath } : {}),
    ...(extra.modules ? { modules: extra.modules } : {}),
    ...(workload ? { pki: { workloadIssuer: workload } } : {}),
  });
}

async function get(compute: ReturnType<typeof server>, path: string, method = 'GET') {
  const response = await compute.handler(
    new Request(`${BASE_URL}/api/compute/${path}`, { method }),
  );
  const text = await response.text();
  return { status: response.status, headers: response.headers, json: JSON.parse(text) };
}

describe('the workload issuer routes', () => {
  it('serves discovery and JWKS without a store or credentials', async () => {
    const workload = issuer();
    const compute = server(workload);

    const discovery = await get(compute, 'workload/.well-known/openid-configuration');
    expect(discovery.status).toBe(200);
    expect(discovery.headers.get('cache-control')).toBe('public, max-age=300');
    expect(discovery.headers.get('x-content-type-options')).toBe('nosniff');
    expect(discovery.headers.get('referrer-policy')).toBe('no-referrer');
    expect(discovery.json).toEqual(workload.discovery());
    expect(discovery.json.issuer).toBe(ISSUER);
    expect(discovery.json.jwks_uri.endsWith('/workload/jwks.json')).toBe(true);

    const jwks = await get(compute, 'workload/jwks.json');
    expect(jwks.status).toBe(200);
    expect(jwks.headers.get('cache-control')).toBe('public, max-age=300');
    expect(jwks.headers.get('x-content-type-options')).toBe('nosniff');
    expect(jwks.json).toEqual(await workload.jwks());
    expect(jwks.json.keys).toHaveLength(1);
    expect(jwks.json.keys[0]).not.toHaveProperty('d');

    // Only GET reaches them; the discovery document's own jwks_uri is the one that is served.
    expect(new URL(discovery.json.jwks_uri).pathname).toBe('/api/compute/workload/jwks.json');
  });

  it('the well-known document names the issuer', async () => {
    const named = await get(server(issuer()), '.well-known/better-compute');
    expect(named.status).toBe(200);
    expect(named.json.workload).toEqual({ issuer: ISSUER });

    const unnamed = await get(server(undefined), '.well-known/better-compute');
    expect(unnamed.json).not.toHaveProperty('workload');
  });

  it('an issuer URL that is not under the API base path fails construction', () => {
    for (const url of [
      'https://compute.example.com/other/workload',
      `${BASE_URL}/api/compute`,
      `${BASE_URL}/workload`,
    ]) {
      let thrown: unknown;
      try {
        server(issuer(url));
      } catch (error) {
        thrown = error;
      }
      expect(isComputeError(thrown), url).toBe(true);
      expect(thrown).toMatchObject({
        code: 'INVALID_CONFIG',
        details: { reason: 'workloadIssuerUrl' },
      });
    }
  });

  it('an issuer that is not a workload issuer fails construction', () => {
    let thrown: unknown;
    try {
      betterCompute({
        ...options(noStore, fakeIam()),
        pki: { workloadIssuer: { issuer: ISSUER } as never },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('without an issuer both routes are 404', async () => {
    const compute = server(undefined);
    for (const path of ['workload/.well-known/openid-configuration', 'workload/jwks.json']) {
      const response = await get(compute, path);
      expect(response.status, path).toBe(404);
      expect(response.json.error.code).toBe('NOT_FOUND');
    }
  });

  it('other methods and neighbouring paths are not served', async () => {
    const compute = server(issuer());
    expect((await get(compute, 'workload/jwks.json', 'POST')).status).toBeGreaterThanOrEqual(400);
    expect((await get(compute, 'workload')).status).toBe(404);
    expect((await get(compute, 'workload/.well-known/jwks.json')).status).toBe(404);
  });

  it('modules read the issuer as context.pki.workload', () => {
    const workload = issuer();
    let seen: ModuleContext | undefined;
    const probe: ComputeModule = {
      name: 'probe',
      api(context) {
        seen = context;
        return {};
      },
    };
    server(workload, { modules: [probe] });
    expect(seen?.pki?.workload).toBe(workload);

    server(undefined, { modules: [probe] });
    expect(seen?.pki).toBeDefined();
    expect(seen?.pki?.workload).toBeUndefined();
  });

  it('a custom base path moves the routes and the check with it', async () => {
    const url = `${BASE_URL}/edge/compute/workload`;
    const compute = server(issuer(url), { basePath: '/edge/compute' });
    const response = await compute.handler(
      new Request(`${BASE_URL}/edge/compute/workload/jwks.json`),
    );
    expect(response.status).toBe(200);
  });
});
