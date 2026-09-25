import { afterEach, describe, expect, it } from 'vitest';
import { iamTenantReader } from '@better-compute/iam';
import { createEmbeddedTestIam, type EmbeddedTestIam } from '@better-compute/iam/testing';

// `iamTenantReader` (PLAN.md §12.8): the tenancy reaction's `readTenants` over an embedded better-iam. A deletion
// cascades into the descendants' own status in IAM; a suspension does not, so the reader derives each tenant's
// effective status from its ancestors.

let iam: EmbeddedTestIam | undefined;
afterEach(async () => {
  await iam?.close();
  iam = undefined;
});

describe('iamTenantReader', () => {
  it('reads a subtree with effective statuses', { timeout: 60_000 }, async () => {
    iam = await createEmbeddedTestIam({ now: () => Date.now() });
    const { root, acme } = iam;
    const child = await iam.iam.api.tenants.create(root.credential, {
      parentId: acme.tenantId,
      name: 'Acme child',
      type: 'project',
      ownerEmail: 'owner@acme-child.test',
    });
    const childId = child.tenant.id;
    const read = iamTenantReader(iam.iam as never, { credential: root.credential });
    const sorted = async (tenantId: string) =>
      (await read(tenantId)).sort((a, b) => a.tenantId.localeCompare(b.tenantId));
    const expected = (acmeStatus: string, childStatus: string) =>
      [
        { tenantId: acme.tenantId, status: acmeStatus },
        { tenantId: childId, status: childStatus },
      ].sort((a, b) => a.tenantId.localeCompare(b.tenantId));

    // The child's owner has not accepted yet: pending.
    expect(await sorted(acme.tenantId)).toEqual(expected('active', 'pending'));

    // Suspending acme suspends its child (IAM keeps the child's own status).
    await iam.iam.api.tenants.setStatus(root.credential, {
      tenantId: acme.tenantId,
      status: 'suspended',
    });
    expect(await sorted(acme.tenantId)).toEqual(expected('suspended', 'suspended'));
    expect(await read(childId)).toEqual([{ tenantId: childId, status: 'suspended' }]);

    await iam.iam.api.tenants.setStatus(root.credential, {
      tenantId: acme.tenantId,
      status: 'active',
    });
    expect(await sorted(acme.tenantId)).toEqual(expected('active', 'pending'));

    await iam.iam.api.tenants.setStatus(root.credential, { tenantId: childId, status: 'deleted' });
    expect(await sorted(acme.tenantId)).toEqual(expected('active', 'deleted'));

    // A tenant IAM does not know.
    expect(await read('tenant_unknown')).toEqual([
      { tenantId: 'tenant_unknown', status: 'missing' },
    ]);
    // A subtree larger than the limit is refused rather than truncated.
    const small = iamTenantReader(iam.iam as never, { credential: root.credential, maxTenants: 1 });
    await expect(small(acme.tenantId)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});
