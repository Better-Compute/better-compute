import { describe, expect, it } from 'vitest';
import { zoneRegion } from '@better-compute/vps';

// The default zone-to-region rule vps uses when a provider gives none of its own.

describe('zoneRegion', () => {
  it('maps a zone to its region across the naming schemes it knows', () => {
    const cases: [string, string][] = [
      // Compute Engine: the name without its last segment.
      ['us-central1-a', 'us-central1'],
      ['europe-west4-b', 'europe-west4'],
      ['northamerica-northeast1-c', 'northamerica-northeast1'],
      // An AI zone has a longer suffix: it used to come back unchanged, as its own region.
      ['us-south1-ai1b', 'us-south1'],
      ['us-central1-ai1a', 'us-central1'],
      // AWS: a zone letter, and Local Zones.
      ['us-east-1a', 'us-east-1'],
      ['eu-central-1c', 'eu-central-1'],
      ['us-west-2-lax-1a', 'us-west-2'],
      ['us-gov-west-1b', 'us-gov-west-1'],
      // Any other name that ends in a zone letter loses it (what the rule always did).
      ['dev-1-a', 'dev-1'],
      ['lab-b', 'lab'],
      // Already a region, or nothing it knows: unchanged.
      ['us-central1', 'us-central1'],
      ['fsn1', 'fsn1'],
      ['nyc3', 'nyc3'],
      ['not-a-zone', 'not-a-zone'],
    ];
    for (const [zone, region] of cases) expect(zoneRegion(zone), zone).toBe(region);
  });
});
