import { describe, expect, it } from 'vitest';
import { mergeNodeSpecs } from '@better-compute/server';

// NodeSpec contributions (§3.3, §11.5): sections merge across modules, and `site` merges field by
// field so SiteBoot's `boot` and provision's pre-warmed `cacheImages` both survive.

describe('mergeNodeSpecs', () => {
  it('merges the site section field by field, in registration order', () => {
    const image = {
      url: 'https://images.test/u.qcow2',
      sha256: 'ab'.repeat(32),
      format: 'qcow2' as const,
    };
    const merged = mergeNodeSpecs([
      { site: { boot: { active: true, epoch: 3 } } },
      { site: { cacheImages: [image] } },
    ]);
    expect(merged.site).toEqual({ boot: { active: true, epoch: 3 }, cacheImages: [image] });
    // The last contribution of a field wins.
    expect(
      mergeNodeSpecs([
        { site: { cacheImages: [image] } },
        { site: { boot: { active: false, epoch: 1 } } },
        { site: { boot: { active: true, epoch: 2 } } },
      ]).site,
    ).toEqual({ boot: { active: true, epoch: 2 }, cacheImages: [image] });
    expect(mergeNodeSpecs([{}]).site).toBeUndefined();
  });
});
