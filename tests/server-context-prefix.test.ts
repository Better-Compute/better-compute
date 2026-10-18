import { afterEach, describe, expect, it } from 'vitest';
import { closeFixtures, computeFixture } from '@better-compute/testing';

// ModuleContext.typePrefix: modules that decide on compute resources themselves build IAM types
// from the deployment's prefix instead of guessing `compute-`.

afterEach(closeFixtures);

describe('ModuleContext.typePrefix', () => {
  it('carries the configured IAM type prefix (default compute-)', async () => {
    const fixture = await computeFixture();
    expect(fixture.compute.context.typePrefix).toBe('compute-');
  });
});

describe('ModuleContext.iam.rootTenantId', () => {
  // The fixture names the root only on betterCompute({ rootTenantId }); its fake IAM port does not.
  it.each(['throw', 'off'] as const)(
    'names the resolved root tenant (iamGuard %s)',
    async (iamGuard) => {
      const fixture = await computeFixture({ iamGuard });
      expect((fixture.iam as { rootTenantId?: string }).rootTenantId).toBeUndefined();
      expect(fixture.compute.context.iam.rootTenantId).toBe(fixture.tenants.root.id);
    },
  );
});
