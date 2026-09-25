import { afterEach, describe, expect, it } from 'vitest';
import type { Credential, SqlExecutor } from '@better-compute/core';
import { pglite } from '@better-compute/postgres/pglite';
import { betterCompute } from '@better-compute/server';
import { fakeIam } from './support/fake-iam.js';
import { ACME, BASE_URL, options } from './support/server.js';

// Review 14 L3: IAM sees the caller's address as the host verified it (`compute.handler(request,
// { peer })`, the Node transport's socket), never a forwarding header the client sent itself.

let db: SqlExecutor | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

describe('the caller address IAM sees', () => {
  it('comes from the host, not from x-forwarded-for', async () => {
    db = pglite();
    const iam = fakeIam({ callers: { tok: { tenantId: ACME } }, allow: [{}] });
    const seen: (string | undefined)[] = [];
    const authenticate = iam.authenticate.bind(iam);
    iam.authenticate = async (credential: Credential) => {
      seen.push(credential.sourceIp);
      return authenticate(credential);
    };
    const compute = betterCompute({ ...options(db, iam) } as never) as any;
    await compute.initialize();
    const request = () =>
      new Request(`${BASE_URL}/api/compute/system/whoami`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok',
          'content-type': 'application/json',
          'x-better-compute': '1',
          'x-forwarded-for': '6.6.6.6',
        },
        body: '{}',
      });
    expect((await compute.handler(request(), { peer: { address: '10.1.2.3' } })).status).toBe(200);
    expect((await compute.handler(request())).status).toBe(200);
    expect(seen).toEqual(['10.1.2.3', undefined]);
  });
});
