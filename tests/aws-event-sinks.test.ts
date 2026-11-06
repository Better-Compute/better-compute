import { describe, expect, it } from 'vitest';
import { chunkBy } from '@better-compute/aws';

describe('chunkBy', () => {
  it('chunkBy respects count and byte limits and keeps order', () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    expect(chunkBy(items, { maxCount: 3, maxBytes: 100, size: () => 1 })).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(chunkBy(items, { maxCount: 10, maxBytes: 10, size: (n) => n })).toEqual([[1, 2, 3, 4], [5], [6], [7]]);
  });

  it('an item over maxBytes is its own chunk', () => {
    expect(chunkBy([1, 50, 2], { maxCount: 10, maxBytes: 10, size: (n) => n })).toEqual([[1], [50], [2]]);
    expect(chunkBy([], { maxCount: 10, maxBytes: 10, size: () => 1 })).toEqual([]);
  });
});
