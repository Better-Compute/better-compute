import { describe, expect, it } from 'vitest';
import { runConformance } from '@better-compute/core/conformance';
import {
  providerResourcesConformanceCases,
  type ProviderResourcesConformanceSubject,
} from '@better-compute/cloud-resources';
import { fakeResourcesCloud, fakeResourcesProvider } from './support/fake-resources.js';

// The ProviderResources contract's conformance cases against the in-memory fake (the DigitalOcean emulator runs
// the same cases in provider-digitalocean-resources.test.ts).

function subject(): ProviderResourcesConformanceSubject {
  const cloud = fakeResourcesCloud();
  const unmanaged = cloud.seed({
    kind: 'fake.database',
    name: 'by-hand',
    spec: { region: 'nyc3', engine: 'pg', version: '16', size: 'small', nodes: 1 },
    owner: 'none',
  });
  return {
    provider: fakeResourcesProvider(cloud),
    config: {},
    kind: 'fake.database',
    spec: { region: 'nyc3', engine: 'pg', version: '16', size: 'small' },
    updatedSpec: { region: 'nyc3', engine: 'pg', version: '16', size: 'medium' },
    replaceSpec: { region: 'ams3', engine: 'pg', version: '16', size: 'small' },
    unmanaged: unmanaged.id,
  };
}

describe('ProviderResources conformance (fake provider)', () => {
  for (const test of providerResourcesConformanceCases())
    it(test.name, async () => {
      await test.run(subject());
    });

  it('a provider without resources fails the cases instead of passing them', async () => {
    const { noResourcesProvider } = await import('./support/fake-resources.js');
    const report = await runConformance(providerResourcesConformanceCases(), () => ({
      ...subject(),
      provider: noResourcesProvider,
    }));
    expect(report.passed).toEqual([]);
    expect(report.failed.length).toBe(providerResourcesConformanceCases().length);
  });
});
