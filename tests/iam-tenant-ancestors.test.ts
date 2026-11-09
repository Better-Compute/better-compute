import { afterEach, describe, expect, it } from 'vitest';
import { iamTenantAncestors } from '@better-compute/iam';
import { createEmbeddedTestIam, type EmbeddedTestIam } from '@better-compute/iam/testing';

// `iamTenantAncestors` (U-02): `capacity({ tenantAncestors })` for `pools.offers`, the tenant's ancestors from
// better-iam, nearest first.

let iam: EmbeddedTestIam | undefined;
afterEach(async () => {
  await iam?.close();
  iam = undefined;
});

describe('iamTenantAncestors', () => {
  it('walks parentId up to the root, nearest first; an unknown tenant has none', async () => {
    iam = await createEmbeddedTestIam({ now: () => Date.now() });
    const { root, acme } = iam;
    const child = await iam.iam.api.tenants.create(root.credential, {
      parentId: acme.tenantId,
      name: 'Acme child',
      type: 'project',
      ownerEmail: 'owner@acme-child.test',
    });
    const ancestors = iamTenantAncestors(iam.iam as never, { credential: root.credential });
    const chain = await ancestors(child.tenant.id);
    expect(chain[0]).toBe(acme.tenantId);
    expect(chain.at(-1)).toBe(root.tenantId);
    expect(await ancestors(root.tenantId)).toEqual([]);
    expect(await ancestors('tenant-nobody')).toEqual([]);
    expect(
      await iamTenantAncestors(iam.iam as never, { credential: root.credential, maxDepth: 1 })(
        child.tenant.id,
      ),
    ).toEqual([acme.tenantId]);
  });
});
