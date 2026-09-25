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
