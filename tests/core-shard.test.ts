import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { SHARD_COUNT, shardOf } from '@better-compute/core';

describe('shardOf', () => {
  it('is FNV-1a 32 over UTF-8, modulo 256', () => {
    // FNV-1a("") = 0x811c9dc5, FNV-1a("a") = 0xe40c292c (published test vectors).
    expect(shardOf('')).toBe(0x811c9dc5 % 256);
    expect(shardOf('a')).toBe(0xe40c292c % 256);
    // UTF-8, not UTF-16 code units.
    expect(shardOf('é')).not.toBe(shardOf('é'.normalize('NFD')));
  });

  it('always lands in [0, SHARD_COUNT)', () => {
    fc.assert(
      fc.property(fc.string(), (key) => {
        const shard = shardOf(key);
        return Number.isInteger(shard) && shard >= 0 && shard < SHARD_COUNT;
      }),
    );
  });
});
